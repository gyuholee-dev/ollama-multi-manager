// Desktop shell: starts the backend, shows the UI the backend serves, and applies the settings that only
// the shell can apply (tray, launch at login, native theme).
//
// Lifetime policy: the app's running state is the instances' running state. Quitting the app stops the
// backend, which saves each instance's state and stops them; the next launch brings them back.
// "Minimize to tray" is how to keep instances running with the window closed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, nativeTheme, screen, session, shell } = electron;
import { Backend } from './backend-launcher.js';
import { AppTray } from './tray.js';
import { startMockupServer } from './dev-mockup.js';
import { overlay } from './overlay.js';
import { failureText, fitPicture, focusWindow, putOnClipboard, screenshotDir, takeScreenshot } from './screenshot.js';
import { ShotRequestError, startShotServer } from './mcp-shot.js';
import { resolveMonitor, waitForContent } from './mcp-monitor.js';

const log = (...a) => console.log(new Date().toISOString(), '[shell]', ...a);

// Developer mode: OMM_DEV=1 (or true/yes/on). Works for `yarn start` and for a packaged app alike.
const DEV = /^(1|true|yes|on)$/i.test(process.env.OMM_DEV || '');
// OMM_MOCKUP=1: also serves the design mockup (frontend/mockup) on this PC, independent of developer mode.
const MOCKUP = /^(1|true|yes|on)$/i.test(process.env.OMM_MOCKUP || '');
const MENU_LABEL = {
  ko: { copy: '복사', reload: '새로고침', freeze: '화면 갱신 중지', resume: '화면 갱신 재개', inspect: '검사', captureMenu: 'CDP Screenshot', shot: '화면 캡처', fullShot: '전체 캡처', elementShot: '요소 캡처',
         pickNote: '캡처할 요소를 클릭하세요 (Esc: 취소)', savedNote: '캡처 저장됨', canceledNote: '캡처 취소됨', failedNote: '캡처 실패' },
  en: { copy: 'Copy', reload: 'Reload', freeze: 'Pause updates', resume: 'Resume updates', inspect: 'Inspect', captureMenu: 'CDP Screenshot', shot: 'Screen capture', fullShot: 'Full capture', elementShot: 'Element capture',
         pickNote: 'Click the element to capture (Esc cancels)', savedNote: 'Capture saved', canceledNote: 'Capture canceled', failedNote: 'Capture failed' },
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null, backend = null, tray = null, settings = {}, quitting = false, mockup = null, shotServer = null;
  const monitors = new Map(); // instance id -> its monitor window (one per instance)

  // macOS: no system title bar. With macOS 27.2 a window dragged by the system title bar from one display to another
  // is repositioned wrongly (the system loses the start of the move, "Window move completed without beginning"),
  // while a window dragged by a drag region of the page moves correctly. The page draws the header, which is the
  // drag region, and leaves room for the traffic-light buttons. OMM_NATIVE_TITLEBAR=1 brings the system one back.
  // The width a window gets when it is made for the first time (the height: see firstBounds; later ones remember what the user chose, except the monitor window's width).
  const MAIN_SIZE = { width: 960 };
  const MONITOR_SIZE = { width: 480 };
  const MAX_FIRST_HEIGHT = 1200; // the most a window is high at first, whatever the screen

  /**
   * The place and size of a window that has none saved: its width, and the height of the work area (the screen without taskbar, dock or menu bar)
   * of the display it opens on, at most MAX_FIRST_HEIGHT, at the top of that area and centred across it (`shift` px to the right of the centre).
   * `near` is a point on the display: the centre of the main window, or the pointer.
   */
  function firstBounds(width, near, shift = 0) {
    const a = screen.getDisplayNearestPoint(near || screen.getCursorScreenPoint()).workArea;
    return { width, height: Math.min(a.height, MAX_FIRST_HEIGHT), x: Math.round(a.x + (a.width - width) / 2) + shift, y: a.y };
  }

  // The height of the page's header row (and of the title row of a dialog or page), in px: the one number the system's window buttons
  // follow. Windows: the three buttons are this high. macOS: the traffic lights are centred in it. The page takes it as --header-h.
  const HEADER_HEIGHT = 44;
  // macOS 26 (Darwin 25) and later draw the traffic lights 14px high, earlier ones 16px
  const LIGHTS_HEIGHT = process.platform === 'darwin' && Number(os.release().split('.')[0]) >= 25 ? 14 : 16;
  const NATIVE_TITLEBAR = /^(1|true|yes|on)$/i.test(process.env.OMM_NATIVE_TITLEBAR || '');
  const CUSTOM_TITLEBAR = process.platform === 'darwin' && !NATIVE_TITLEBAR;
  // Windows: the same look. The page's header is the title bar and the system draws only its three buttons (minimize, maximize, close)
  // over the right end of it; their colours follow the theme (setTitleBarOverlay below). The menu bar is dropped.
  const OVERLAY_TITLEBAR = process.platform === 'win32' && !NATIVE_TITLEBAR;
  const overlayColors = () => {
    const dark = nativeTheme.shouldUseDarkColors;
    return { color: dark ? '#1c1c1c' : '#ebebeb', symbolColor: dark ? '#eeeeee' : '#222222', height: HEADER_HEIGHT }; // (the header's colours and its row; the line under it stays)
  };
  const titleBar = () => {
    if (CUSTOM_TITLEBAR) return { titleBarStyle: 'hidden', trafficLightPosition: { x: 18, y: Math.floor((HEADER_HEIGHT - LIGHTS_HEIGHT) / 2) } };
    if (OVERLAY_TITLEBAR) return { titleBarStyle: 'hidden', titleBarOverlay: overlayColors() };
    return {};
  };
  const webPrefs = () => ({
    preload: path.join(import.meta.dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
    additionalArguments: [`--omm-header-height=${HEADER_HEIGHT}`, ...(CUSTOM_TITLEBAR ? ['--omm-custom-titlebar'] : []), ...(OVERLAY_TITLEBAR ? ['--omm-titlebar-overlay'] : [])],
  });
  if (OVERLAY_TITLEBAR) {
    nativeTheme.on('updated', () => {
      for (const w of [win, ...monitors.values()]) if (w && !w.isDestroyed()) w.setTitleBarOverlay(overlayColors());
    });
  }
  const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

  // ---- window state
  // OMM_NO_WINDOW_STATE=1: windows neither remember nor restore their place and size (to tell whether that is behind a
  // problem with moving windows between displays).
  const NO_STATE = /^(1|true|yes|on)$/i.test(process.env.OMM_NO_WINDOW_STATE || '');

  /**
   * Calls `save` when the user has finished moving or resizing the window. It must not run on every step of a drag:
   * asking the window for its geometry and writing a file while macOS is still tracking the mouse makes moving a
   * window between displays stutter and misbehave. macOS and Windows tell when a gesture ends ('moved', 'resized');
   * Linux only has the continuous events, so there a short pause stands for the end.
   */
  function trackBounds(w, save) {
    if (NO_STATE) return;
    let timer = null;
    const soon = () => { clearTimeout(timer); timer = setTimeout(() => { if (!w.isDestroyed()) save(); }, 600); };
    if (process.platform === 'linux') { w.on('move', soon); w.on('resize', soon); }
    else { w.on('moved', soon); w.on('resized', soon); }
    w.on('maximize', soon); w.on('unmaximize', soon);
    w.on('close', () => clearTimeout(timer));
  }

  // OMM_DEBUG_WINDOW=1: prints what the window reports while it is moved (for finding out why a window lands in the
  // wrong place after being dragged to another display).
  const DEBUG_WINDOW = /^(1|true|yes|on)$/i.test(process.env.OMM_DEBUG_WINDOW || '');
  function debugWindow(w, label) {
    if (!DEBUG_WINDOW) return;
    let intended = null, moves = 0;
    w.on('will-move', (_e, b) => { intended = b; });
    w.on('move', () => { moves++; });
    w.on('moved', () => {
      const b = w.getBounds(), d = screen.getDisplayMatching(b);
      const jump = intended ? `jump ${b.x - intended.x},${b.y - intended.y} from the last will-move target` : 'no will-move reported';
      log(`[window ${label}] moved to ${b.x},${b.y} ${b.width}x${b.height} on display ${d.id} (scale ${d.scaleFactor}); ${moves} move events; ${jump}`);
      intended = null; moves = 0;
    });
    w.on('maximize', () => log(`[window ${label}] maximize -> ${JSON.stringify(w.getBounds())}`));
    w.on('unmaximize', () => log(`[window ${label}] unmaximize -> ${JSON.stringify(w.getBounds())}`));
  }

  // true when the window's title bar area is still on some display (a display may have been unplugged since)
  const onScreen = s => Number.isFinite(s?.x) && Number.isFinite(s?.y) && screen.getAllDisplays().some(d => {
    const b = d.workArea;
    return s.x < b.x + b.width - 40 && s.x + s.width > b.x + 40 && s.y < b.y + b.height - 40 && s.y + 40 > b.y;
  });
  function loadState() {
    if (NO_STATE) return {};
    try {
      const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
      return { ...s, ...(onScreen(s) ? {} : { x: undefined, y: undefined }) };
    } catch { return {}; }
  }
  function saveState() {
    if (NO_STATE || !win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    fs.writeFile(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }), () => { /* not critical */ });
  }
  function saveStateNow() { // while the window closes: the process may end right after
    if (NO_STATE || !win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    try { fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch { /* not critical */ }
  }

  // The monitor windows remember their place and size, per instance. A window of an instance that has none yet opens
  // where the last monitor window was (shifted a little so it does not hide that one).
  const monitorStateFile = () => path.join(app.getPath('userData'), 'monitor-window-state.json');
  const readMonitorState = () => { try { return JSON.parse(fs.readFileSync(monitorStateFile(), 'utf8')); } catch { return {}; } };
  function saveMonitorState(id, w, sync = false) {
    if (NO_STATE || w.isDestroyed()) return;
    const st = readMonitorState();
    const b = { ...w.getNormalBounds(), maximized: w.isMaximized() };
    st.byId = { ...st.byId, [id]: b };
    st.last = b;
    if (!sync) { fs.writeFile(monitorStateFile(), JSON.stringify(st), e => { if (e) log('Could not save the monitor window state:', e.message); }); return; }
    try { fs.writeFileSync(monitorStateFile(), JSON.stringify(st)); } catch (e) { log('Could not save the monitor window state:', e.message); }
  }
  function monitorBounds(id) {
    if (NO_STATE) return null;
    const st = readMonitorState();
    if (onScreen(st.byId?.[id])) return st.byId[id];
    if (onScreen(st.last)) {
      const shift = 28 * monitors.size; // the windows already open
      const moved = { ...st.last, x: st.last.x + shift, y: st.last.y + shift, maximized: false };
      return onScreen(moved) ? moved : { ...st.last, maximized: false };
    }
    return null;
  }

  // ---- settings only the shell can apply
  function applySettings(s) {
    settings = s;
    nativeTheme.themeSource = ['light', 'dark'].includes(s.theme) ? s.theme : 'system';
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!s.launch_at_login });
    else if (s.launch_at_login) log('Launch at login is only registered by packaged builds');
    if (s.minimize_to_tray && !tray) {
      tray = new AppTray({ onOpen: showWindow, onQuit: () => app.quit(), lang: s.language || app.getLocale() });
      log('Tray enabled');
    } else if (!s.minimize_to_tray && tray) {
      tray.destroy(); tray = null;
      log('Tray disabled');
    }
    tray?.setLang(s.language || app.getLocale());
  }
  async function refreshSettings() {
    try { applySettings(await backend.api('GET', '/settings')); } catch (e) { log('Could not read settings:', e.message); }
  }

  // ---- window
  function showWindow() {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    monitors.forEach(w => { if (!w.isVisible()) w.show(); });
  }

  // Is the text selected in the page inside an area the page marks as copyable (data-copy-area: the logs)? Both ends of the selection must be.
  const IN_COPY_AREA = `(() => {
    const s = getSelection();
    const inside = (n) => !!(n && (n.nodeType === 1 ? n : n.parentElement)?.closest('[data-copy-area]'));
    return !!s && s.rangeCount > 0 && inside(s.anchorNode) && inside(s.focusNode);
  })()`;

  // Developer mode: a screenshot of a window as PNG under <data folder>/screenshots (see screenshot.js), also put on the clipboard.
  // The page shows what is going on (overlay.js: a note while an element is chosen, a flash and a note when it is done); the result is also
  // told in the console and in the page's footer, with the whole path.
  async function shoot(w, kind, label) {
    const lang = String(settings.language || app.getLocale()).slice(0, 2);
    const l = MENU_LABEL[lang] || MENU_LABEL.en;
    const ui = overlay(w.webContents);
    const tell = text => {
      log(text);
      if (!w.isDestroyed()) w.webContents.executeJavaScript(`window.__omm?.status(${JSON.stringify(text)})`).catch(() => {});
    };
    try {
      await focusWindow(w, { electronApp: app }); // always: the window may be behind others or not active, which spoils the choosing of an element
      const { file, png } = await takeScreenshot(w.webContents, kind, {
        dir: screenshotDir(app.getPath('userData')), label, feedback: { picking: () => ui.picking(l.pickNote), clear: ui.clear },
      });
      let note = '';
      try {
        await putOnClipboard(electron, png);
      } catch (e) {
        note = ` (not put on the clipboard: ${e.message})`; // the file is saved all the same
      }
      tell(`Capture (${kind}) saved: ${file}${note}`);
      await ui.done(`${l.savedNote}: ${path.basename(file)}`);
    } catch (e) {
      // Hiding the window (to the tray, say) or closing it while a picture is taken is a cancel, as the package regards it: it ends with DETACHED.
      const windowGone = e.code === 'DETACHED' && (w.isDestroyed() || !w.isVisible());
      if (e.code === 'CANCELED' || windowGone) {
        tell(`Capture (${kind}) canceled`);
        if (!w.isDestroyed()) await ui.canceled(l.canceledNote); // (a closed window has no page to tell)
      } else {
        tell(`Capture (${kind}) failed: ${e.message}`);
        await ui.failed(`${l.failedNote}: ${failureText(e, lang)}`);
      }
    }
  }

  // Developer mode: a screenshot an MCP client asked for (the MCP server in the backend calls the listener of mcp-shot.js). The window is the main one, or the monitor
  // window of an instance; the element is named by a selector (nobody can click it); the picture handed back is scaled to at most `maxSide` on its longer
  // side, the whole one is saved as a file. The page says that it was taken, as it does for the developer's own screenshots.
  async function mcpCapture({ kind, selector, instanceId, openMonitor: openIfClosed, depth, maxSide }) {
    // Which page: the main window, or the monitor of an instance (found open, or opened just for this picture and closed again after it). The monitor
    // is looked up through resolveMonitor and not by `monitors.get`, so that it can become a side panel later without this function knowing.
    let release = async () => {};
    let w = win;
    if (instanceId) {
      ({ target: w, release } = await resolveMonitor(instanceId, {
        allowOpen: openIfClosed,
        find: id => { const m = monitors.get(id); return m && !m.isDestroyed() ? m : null; },
        open: async id => {
          try { await backend.api('GET', `/instances/${id}`); } catch { return null; } // no such instance: nothing to open
          const opened = openMonitor(id, { transient: true });
          return opened && { target: opened, release: async () => { if (!opened.isDestroyed()) opened.destroy(); } };
        },
        ready: waitForContent,
      }));
    }
    try {
      if (!w || w.isDestroyed()) throw new ShotRequestError('NO_WINDOW', 'The main window is not open', 404);
      const l = MENU_LABEL[String(settings.language || app.getLocale()).slice(0, 2)] || MENU_LABEL.en;
      const ui = overlay(w.webContents);
      const shot = await takeScreenshot(w.webContents, kind, {
        dir: screenshotDir(app.getPath('userData')), label: instanceId ? `monitor-${instanceId}` : 'main', selector, depth, feedback: { clear: ui.clear },
      }).catch(async e => { if (!w.isDestroyed()) await ui.failed(`${l.failedNote}: ${failureText(e, 'en')}`); throw e; });
      const fit = fitPicture(shot.png, maxSide, nativeImage);
      log(`Capture (${kind}) for an MCP client saved: ${shot.file}`);
      if (!w.isDestroyed()) await ui.done(`${l.savedNote} (MCP): ${path.basename(shot.file)}`);
      return { file: shot.file, png: fit.png, width: fit.width, height: fit.height, fullWidth: shot.width, fullHeight: shot.height };
    } finally {
      await release();
    }
  }

  // The page may only ever be the backend's own UI; everything else opens in the system browser.
  // Right-click on text selected in a log area offers "Copy" (an Electron window has no menu of its own); in developer mode
  // the menu also offers reload, pausing the page's live updates, and inspect.
  function guard(w, label = 'main') {
    debugWindow(w, label);
    const isOwn = u => { try { return new URL(u).origin === backend.url; } catch { return false; } };
    const external = u => { if (/^https?:\/\//i.test(u)) shell.openExternal(u); };
    const keepOwn = (e, u) => { if (!isOwn(u)) { e.preventDefault(); external(u); } };
    w.webContents.on('will-navigate', keepOwn);
    w.webContents.on('will-redirect', keepOwn); // a redirect must not take the window away either
    w.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    w.webContents.on('context-menu', async (_e, p) => {
      const l = MENU_LABEL[String(settings.language || app.getLocale()).slice(0, 2)] || MENU_LABEL.en;
      const items = [];
      if (p.selectionText && p.editFlags.canCopy && await w.webContents.executeJavaScript(IN_COPY_AREA).catch(() => false)) {
        items.push({ label: l.copy, role: 'copy' });
      }
      if (DEV) {
        const frozen = await w.webContents.executeJavaScript('window.__omm?.isFrozen() === true').catch(() => false);
        if (items.length) items.push({ type: 'separator' });
        // the captures (a submenu, like the browser extension's) first; reload, freeze and inspect always last
        items.push(
          {
            label: l.captureMenu,
            submenu: [
              { label: l.shot, click: () => shoot(w, 'viewport', label) },
              { label: l.fullShot, click: () => shoot(w, 'full', label) },
              { label: l.elementShot, click: () => shoot(w, 'element', label) },
            ],
          },
          { type: 'separator' },
          { label: l.reload, click: () => w.webContents.reload() },
          { label: frozen ? l.resume : l.freeze, click: () => w.webContents.executeJavaScript(`window.__omm?.setFrozen(${!frozen})`) },
          { label: l.inspect, click: () => w.webContents.inspectElement(p.x, p.y) },
        );
      }
      if (items.length) Menu.buildFromTemplate(items).popup({ window: w });
    });
  }

  // One monitor window per instance: a second request for the same instance brings the first to the front.
  // `transient`: a monitor opened only for a screenshot an MCP client asked for: it is not shown, does not take the user's focus, does not remember its
  // place, and is destroyed once the picture is taken (see mcpCapture). Returns the window (an open one is brought forward, unless it is transient).
  function openMonitor(id, { transient = false } = {}) {
    if (!backend || !Number.isInteger(id) || id < 1) return null;
    const open = monitors.get(id);
    if (open && !open.isDestroyed()) {
      if (!transient) {
        if (open.isMinimized()) open.restore();
        open.show(); open.focus();
      }
      return open;
    }
    const saved = monitorBounds(id);
    // none saved: as high as the display of the main window allows (the windows already open sit a little to the right of each other)
    const main = win && !win.isDestroyed() ? win.getBounds() : null;
    const first = saved?.height ? null : firstBounds(MONITOR_SIZE.width, main && { x: main.x + Math.round(main.width / 2), y: main.y + Math.round(main.height / 2) }, 28 * monitors.size);
    const w = new BrowserWindow({
      // the width is fixed (only the height changes); the window is neither maximized nor made full screen, which would widen it
      width: MONITOR_SIZE.width, minWidth: MONITOR_SIZE.width, maxWidth: MONITOR_SIZE.width, maximizable: false, fullscreenable: false,
      height: saved?.height || first.height, x: saved?.x ?? first?.x, y: saved?.y ?? first?.y, minHeight: 360, show: false, title: 'Ollama Multi Manager',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1c' : '#ebebeb', ...titleBar(),
      webPreferences: webPrefs(),
    });
    monitors.set(id, w);
    if (!transient) {
      w.once('ready-to-show', () => w.show());
      trackBounds(w, () => saveMonitorState(id, w));
      w.on('close', () => saveMonitorState(id, w, true));
    }
    w.loadURL(`${backend.url}/#token=${backend.token}&monitor=${id}`);
    guard(w, `monitor ${id}`);
    w.on('closed', () => { if (monitors.get(id) === w) monitors.delete(id); });
    return w;
  }
  const closeMonitors = () => { monitors.forEach(w => { if (!w.isDestroyed()) w.close(); }); monitors.clear(); };

  function createWindow() {
    const st = loadState();
    const first = st.width && st.height ? null : firstBounds(MAIN_SIZE.width); // nothing saved: the display under the pointer
    win = new BrowserWindow({
      width: st.width || first.width, height: st.height || first.height, x: st.x ?? first?.x, y: st.y ?? first?.y, minWidth: 480, minHeight: 480,
      show: false, title: 'Ollama Multi Manager', backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1c' : '#ebebeb', ...titleBar(),
      webPreferences: webPrefs(),
    });
    win.once('ready-to-show', () => { win.show(); if (st.maximized) win.maximize(); }); // maximized only once it is on screen
    win.loadURL(`${backend.url}/#token=${backend.token}`);

    guard(win);

    trackBounds(win, saveState);
    win.on('close', e => {
      saveStateNow();
      if (!quitting && settings.minimize_to_tray && tray) { e.preventDefault(); win.hide(); monitors.forEach(w => w.hide()); }
    });
    win.on('closed', () => { win = null; closeMonitors(); });
  }

  // ---- IPC
  // Only the backend's own UI may talk to the shell: a frame that came from anywhere else is ignored.
  const fromUi = e => { try { return new URL(e.senderFrame.url).origin === backend.url; } catch { return false; } };
  // where the picker opens: the path now in the field (or the nearest folder above it that exists), else the home directory
  const startPath = current => {
    let p = String(current || '').trim();
    if (p.startsWith('~')) p = path.join(app.getPath('home'), p.slice(1));
    while (p && path.isAbsolute(p) && !fs.existsSync(p)) {
      const up = path.dirname(p);
      if (up === p) { p = ''; break; }
      p = up;
    }
    return p && path.isAbsolute(p) ? p : app.getPath('home');
  };
  ipcMain.handle('pick-path', async (e, kind, current) => {
    if (!fromUi(e)) return null;
    const r = await dialog.showOpenDialog(win, {
      defaultPath: startPath(current),
      properties: kind === 'dir' ? ['openDirectory', 'createDirectory'] : ['openFile'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.on('settings-changed', e => { if (fromUi(e)) refreshSettings(); });
  ipcMain.on('open-monitor', (e, id) => { if (fromUi(e)) openMonitor(Number(id)); });

  // ---- lifecycle
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => app.quit());
  app.on('web-contents-created', (_e, wc) => wc.on('will-attach-webview', e => e.preventDefault()));

  app.on('before-quit', e => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    mockup?.close();
    shotServer?.close();
    log('Quitting: stopping the backend (this stops the instances)');
    backend.stop().catch(err => log('Backend stop failed:', err.message)).finally(() => app.quit());
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', e => e.preventDefault()); // no <webview>: it would be a second page with its own rights
  });

  app.whenReady().then(async () => {
    if (OVERLAY_TITLEBAR) Menu.setApplicationMenu(null);
    if (DEV) {
      try { shotServer = await startShotServer({ capture: mcpCapture, log }); } catch (e) { log('The screenshot listener for MCP did not start:', e.message); }
    }
    backend = new Backend({
      dataDir: app.getPath('userData'), isPackaged: app.isPackaged, log,
      env: shotServer ? { OMM_SHOT_URL: shotServer.url, OMM_SHOT_TOKEN: shotServer.token } : {},
    });
    backend.onCrash = (code, sig) => {
      if (quitting) return;
      dialog.showErrorBox('Ollama Multi Manager', `The backend stopped unexpectedly (code ${code}, signal ${sig}).\n\n${backend.tailLog()}`);
      quitting = true;
      app.quit();
    };
    try {
      await backend.start();
    } catch (e) {
      log('Backend start failed:', e.message);
      dialog.showErrorBox('Ollama Multi Manager', e.message);
      quitting = true;
      app.exit(1);
      return;
    }
    log(`Backend ready on ${backend.url}`);
    // The app uses no camera, microphone, location, notifications or the like: every permission request is refused,
    // except copying text to the clipboard (the address and key buttons).
    const allowed = permission => permission === 'clipboard-sanitized-write';
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed(permission));
    if (DEV) {
      log('Developer mode is on (OMM_DEV)');
    }
    if (MOCKUP) mockup = await startMockupServer({ dir: path.join(import.meta.dirname, '..', 'frontend', 'mockup'), log });
    await refreshSettings();
    createWindow();
  });
}
