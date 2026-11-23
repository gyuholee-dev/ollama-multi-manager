// What the developer's tools of the MCP server do in Electron (developer mode only): a screenshot, an action on the screen, the state of the windows. The
// listener (listener.js) calls these; they are made here from what main.js has (its windows and monitors), so that main.js only wires them in and the
// developer's side of the app stays in electron/dev/.

import { overlay } from '../overlay.js';
import { failureText, fitPicture, JPEG_QUALITY, takeScreenshot } from '../screenshot.js';
import { DevRequestError } from './listener.js';
import { hiddenWindowError, resolveMonitor, unthrottled, waitForContent, windowState } from './monitor.js';
import { NEEDS_SHOWN, parseUiRequest, runUiAction } from './ui.js';

/** { capture, ui, state } for startDevServer. `deps`: getWin() (the main window), monitors (Map of instance id to monitor window), getPanelInstance() (the
 * instance shown in the panel of the main window), backend, openMonitor(id, opts), menuLabel() (the texts of the page's notes), nativeImage, log, developerMode. */
export function createDevHandlers({ getWin, monitors, getPanelInstance, backend, openMonitor, menuLabel, nativeImage, log, developerMode }) {
  // Developer mode: a screenshot an MCP client asked for (the MCP server in the backend calls the listener, listener.js). The window is the main one, or the monitor
  // window of an instance; the element is named by a selector (nobody can click it); the picture handed back is scaled to at most `maxSide` on its longer
  // side, nothing is saved. The page says that it was taken, as it does for the developer's own screenshots.
  async function capture({ kind, selector, instanceId, openMonitor: openIfClosed, depth, maxSide, quality }) {
    // for a model to look at: scale 1 and JPEG 85 (a fraction of the size), unless full quality is asked for: the screen's scale and PNG
    const taking = quality === 'full' ? { format: 'png', useDeviceScale: true } : { format: 'jpeg', quality: JPEG_QUALITY, useDeviceScale: false };
    // Which page: the main window, or the monitor of an instance (found open, or opened just for this picture and closed again after it). The monitor
    // is looked up through resolveMonitor and not by `monitors.get`, so that it can become a side panel later without this function knowing.
    let release = async () => {};
    let w = getWin();
    let opened = false;
    let scope = null; // the part of the window that is the monitor, when it is shown in the panel of the main window
    const began = Date.now();
    const lap = () => `${Date.now() - began} ms`;
    if (instanceId) {
      ({ target: w, release, opened } = await resolveMonitor(instanceId, {
        allowOpen: openIfClosed,
        // a monitor window, else the panel of the main window (when it shows that instance): the picture is then of the panel's part of the main window
        find: id => {
          const m = monitors.get(id);
          if (m && !m.isDestroyed()) return m;
          return getPanelInstance() === id && getWin() && !getWin().isDestroyed() ? { panelOf: getWin() } : null;
        },
        open: async id => {
          try { await backend.api('GET', `/instances/${id}`); } catch { return null; } // no such instance: nothing to open
          const opened = openMonitor(id, { transient: true });
          return opened && { target: opened, release: async () => { if (!opened.isDestroyed()) opened.destroy(); } };
        },
        ready: waitForContent,
      }));
    }
    if (w?.panelOf) { scope = '.mpanel'; w = w.panelOf; }
    if (instanceId) log(`MCP screenshot: the monitor of instance ${instanceId} is ready after ${lap()}${scope ? ' (in the panel)' : ''}`);
    // In the panel the picture is of the panel (it opens out as a whole: "viewport" and "full" give the same), or of an element inside it: always an element picture.
    const photo = scope ? 'element' : kind;
    const photoSelector = scope ? (selector ? `${scope} ${selector}` : scope) : selector;
    try {
      if (!w || w.isDestroyed()) throw new DevRequestError('NO_WINDOW', 'The main window is not open', 404);
      // a window that is not shown (in the tray, minimized) cannot be photographed in every way: say so at once, not after the wait for an answer that does not come
      // (a monitor opened just for this picture is never shown, by design, and is not held to this)
      const hidden = opened ? null : hiddenWindowError(photo, windowState(w), instanceId ? `The monitor of instance ${instanceId}` : 'The main window');
      if (hidden) throw hidden;
      const l = menuLabel();
      const ui = overlay(w.webContents);
      // nobody is at the screen when a client asks: the window may be in the tray or minimized, where the system holds its page back
      return await unthrottled(w.webContents, async () => {
        const shot = await takeScreenshot(w.webContents, photo, {
          selector: photoSelector, depth, feedback: { clear: ui.clear }, save: false, ...taking,
        }).catch(async e => { if (!w.isDestroyed()) await ui.failed(`${l.failedNote}: ${failureText(e, 'en')}`); throw e; });
        const fit = fitPicture(shot.png, maxSide, nativeImage, taking);
        log(`Capture (${kind}, ${quality}) for an MCP client taken after ${lap()}: ${shot.width}x${shot.height}px, ${shot.png.length} bytes, not saved`);
        if (!w.isDestroyed()) await ui.done(l.takenNote);
        return { png: fit.png, mime: shot.mime, width: fit.width, height: fit.height, fullWidth: shot.width, fullHeight: shot.height };
      });
    } finally {
      await release();
    }
  }

  // What an MCP client does on the screen (find, click, type ...: ui.js): of the main window (the monitor panel is a part of it), or of a monitor window that is open.
  async function uiAction(body) {
    const request = parseUiRequest(body);
    let w = getWin();
    if (request.instanceId) {
      w = monitors.get(request.instanceId);
      if (!w || w.isDestroyed()) {
        throw new DevRequestError('NO_WINDOW', `The monitor window of instance ${request.instanceId} is not open (a monitor shown in the panel is part of the main window: leave out instance_id)`, 404);
      }
    }
    if (!w || w.isDestroyed()) throw new DevRequestError('NO_WINDOW', 'The main window is not open', 404);
    if (NEEDS_SHOWN.has(request.action) && windowState(w)?.hidden) {
      throw new DevRequestError('WINDOW_HIDDEN', `The window is hidden (in the tray or minimized), so "${request.action}" cannot be done on it: the input of a window that is not shown does not arrive`, 409);
    }
    log(`MCP ui: ${request.action}${request.selector ? ` ${request.selector}` : ''}`);
    return unthrottled(w.webContents, () => runUiAction(w.webContents, request));
  }

  // What an MCP client may ask about the app before it asks for a picture: which windows there are and whether they are shown (see monitor.js).
  const state = () => ({
    developer_mode: developerMode,
    main_window: windowState(getWin()),
    monitor_panel: getPanelInstance() == null ? null : { instance_id: getPanelInstance() },
    monitors: [...monitors.entries()].filter(([, m]) => !m.isDestroyed()).map(([id, m]) => ({ instance_id: id, ...windowState(m) })),
  });

  return { capture, ui: uiAction, state };
}
