'use strict';
// Developer screenshots (developer mode only; see the right-click menu in main.js): the page as it is on screen, the whole main view
// with header and footer, or one element, saved as PNG files in <data folder>/screenshots.
//
// The page is a fixed-height column (header and footer stay, only the body scrolls inside), so the usual "full page" of the DevTools
// protocol (captureBeyondViewport without a clip) would show just what is on screen. The whole view is made by letting the viewport grow
// to the height the page needs for a moment, taking one picture, and putting the viewport back: one frame, no stitching.
// The element picture first lets the user choose the element like DevTools' inspect mode does (the page highlights what the pointer is over,
// a click chooses, Escape cancels: Overlay.setInspectMode), then follows what DevTools does for "Capture node screenshot" (box model of the
// node, the scroll position, a clip for Page.captureScreenshot), and first scrolls the element into view, which DevTools does not.
//
// Everything that talks to the page goes through `send(method, params)` (the debugger's sendCommand), so that the order of the
// commands can be tested with a fake one (test/electron).

const fs = require('node:fs');
const path = require('node:path');

// The largest picture, in device pixels along one side, that the capture is expected to produce. This is a guess that has not been
// measured (a GPU texture is commonly limited to 16384); a page that needs more is refused with a message instead of failing inside the capture.
const MAX_SIDE_PIXELS = 16384;
// How long to wait for the page to draw after the viewport changed (a hidden window draws nothing, which must not hang the capture).
const SETTLE_MS = 1500;
// How long the user has to choose an element before the choosing is given up.
const PICK_TIMEOUT_MS = 60000;
// The colours DevTools highlights an element with while it is being chosen.
const HIGHLIGHT = {
  showInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
};

// The page's own scrolling element: the biggest one that is not inside another (the main view, or the body of a monitor window), whether
// or not it has anything out of sight. A scrolling box inside it (a log, a request list) must not be taken for it: its hidden lines are not
// hidden page, and would make the picture taller than the page. An element without a box of its own (display: contents, like the <main>
// that wraps a monitor window) scrolls nothing, whatever its overflow says, and does not count as something to be inside of.
const FIND_SCROLLER = `() => {
  const scrolls = el => { const oy = getComputedStyle(el).overflowY; return oy === 'auto' || oy === 'scroll'; };
  let best = null;
  for (const el of document.querySelectorAll('body *')) {
    if (!scrolls(el) || el.clientHeight === 0) continue;
    let inside = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (scrolls(p) && p.clientHeight > 0) { inside = true; break; }
    if (!inside && (!best || el.clientHeight > best.clientHeight)) best = el;
  }
  return best;
}`;
// How much of it is out of sight, and the size of the window.
const MEASURE = `(() => {
  const best = (${FIND_SCROLLER})();
  return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, hidden: best ? Math.max(0, best.scrollHeight - best.clientHeight) : 0 };
})()`;
// Where it is scrolled to: the viewport grows, the element has nothing left to scroll, and its position would be lost.
const SAVE_SCROLL = `(() => { const el = (${FIND_SCROLLER})(); window.__ommShotScroll = el ? { el, top: el.scrollTop } : null; })()`;
const RESTORE_SCROLL = `(() => { const s = window.__ommShotScroll; if (s && s.el.isConnected) s.el.scrollTop = s.top; window.__ommShotScroll = null; })()`;

const SETTLE = 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))';

const pad = n => String(n).padStart(2, '0');

/** "20261115-120301-main-full.png": when, which window, which kind. */
function shotName(label, kind, now = new Date()) {
  const when = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const who = String(label || 'window').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'window';
  return `${when}-${who}-${kind}.png`;
}

/** <data folder>/screenshots, or the folder OMM_SCREENSHOT_DIR names. */
function screenshotDir(dataDir, env = process.env) {
  const own = env.OMM_SCREENSHOT_DIR;
  return own && path.isAbsolute(own) ? own : path.join(dataDir, 'screenshots');
}

/** The clip (in page coordinates, whole pixels that cover the element) for Page.captureScreenshot, as DevTools makes it:
 * the border quad of the box model is relative to the viewport, so the scroll position of the page is added. */
function elementClip(model, metrics) {
  const q = model.border;
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  const view = metrics.cssVisualViewport || {};
  const zoom = view.zoom ?? 1;
  const left = (view.pageX ?? 0) + Math.min(...xs), top = (view.pageY ?? 0) + Math.min(...ys);
  const right = (view.pageX ?? 0) + Math.max(...xs), bottom = (view.pageY ?? 0) + Math.max(...ys);
  const x = Math.floor(left * zoom), y = Math.floor(top * zoom);
  const width = Math.ceil(right * zoom) - x, height = Math.ceil(bottom * zoom) - y;
  if (!(width > 0 && height > 0)) throw new Error('the element has no size on screen');
  return { x, y, width, height, scale: 1 };
}

function checkSize(height, dpr) {
  if (height * dpr > MAX_SIDE_PIXELS) {
    throw new Error(`the page is too tall for one picture (${Math.round(height)} px at scale ${dpr}, the limit is about ${MAX_SIDE_PIXELS} device pixels); use the element screenshot`);
  }
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);

async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluation failed');
  return r.result.value;
}

async function picture(send, extra = {}) {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, ...extra });
  return Buffer.from(r.data, 'base64');
}

const settle = send => withTimeout(evaluate(send, SETTLE).catch(() => {}), SETTLE_MS);

/** The main view with header and footer in one picture (see the top of this file). */
async function captureFull(send) {
  const first = await evaluate(send, MEASURE);
  if (!(first.hidden > 1)) return picture(send); // nothing is out of sight (a pixel is rounding): the screen is the whole page
  let height = first.height + first.hidden;
  checkSize(height, first.dpr);
  await evaluate(send, SAVE_SCROLL);
  try {
    await send('Emulation.setDeviceMetricsOverride', { width: first.width, height, deviceScaleFactor: 0, mobile: false });
    await settle(send);
    const again = await evaluate(send, MEASURE); // the layout can change with the new height: once more
    if (again.hidden > 0) {
      height += again.hidden;
      checkSize(height, first.dpr);
      await send('Emulation.setDeviceMetricsOverride', { width: first.width, height, deviceScaleFactor: 0, mobile: false });
      await settle(send);
    }
    return await picture(send);
  } finally {
    await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await settle(send); // the page has its old size again: now the scroll position can be put back
    await evaluate(send, RESTORE_SCROLL).catch(() => {});
  }
}

/** Lets the user choose an element on the page, as DevTools' inspect mode does: resolves with the node's backendNodeId on a click,
 * rejects when Escape is pressed (`canceled`), when the debugger is detached, or when nothing is chosen in time.
 * `listen(handler)` calls handler(method, params) for the debugger's events and returns a function that stops listening. */
async function pickNode(send, listen, { timeoutMs = PICK_TIMEOUT_MS } = {}) {
  await send('DOM.enable');
  await send('Overlay.enable');
  let stop = () => {};
  let timer;
  const chosen = new Promise((resolve, reject) => {
    stop = listen((method, params) => {
      if (method === 'Overlay.inspectNodeRequested') resolve(params.backendNodeId);
      else if (method === 'Overlay.inspectModeCanceled') reject(new Error('canceled'));
      else if (method === 'detach') reject(new Error('the debugger was detached (was the developer tools window opened?)'));
    });
    timer = setTimeout(() => reject(new Error('no element was chosen in time')), timeoutMs);
  });
  chosen.catch(() => {}); // (a failure to start choosing is reported by the await below, not as an unhandled rejection)
  try {
    await send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: HIGHLIGHT });
    return await chosen;
  } finally {
    clearTimeout(timer);
    stop();
    // the highlight must be gone before the picture is taken
    await send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }).catch(() => {});
    await send('Overlay.hideHighlight').catch(() => {});
    await send('Overlay.disable').catch(() => {});
  }
}

/** The element (a backendNodeId), like DevTools' "Capture node screenshot". */
async function captureNode(send, backendNodeId) {
  await send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {}); // an element out of sight is not drawn
  const { model } = await send('DOM.getBoxModel', { backendNodeId });
  const metrics = await send('Page.getLayoutMetrics');
  return picture(send, { captureBeyondViewport: true, clip: elementClip(model, metrics) });
}

/** The element the user chooses on the page. `onChosen` runs once it is chosen, before the picture (the note that asked for it is taken away). */
async function captureElement(send, listen, { timeoutMs, onChosen } = {}) {
  const backendNodeId = await pickNode(send, listen, { timeoutMs });
  if (onChosen) await onChosen();
  await settle(send); // the highlight is gone from the page
  return captureNode(send, backendNodeId);
}

/** Runs `job(send, listen)` with the debugger attached (and detached again, unless somebody else attached it).
 * `listen(handler)` hands the debugger's events (and 'detach') to handler(method, params) and returns a function that stops it. */
async function withDebugger(webContents, job) {
  const dbg = webContents.debugger;
  const mine = !dbg.isAttached();
  try {
    if (mine) dbg.attach('1.3');
  } catch (e) {
    throw new Error(`cannot attach the debugger (is the developer tools window open? ${e.message})`);
  }
  const listen = handler => {
    const onMessage = (_event, method, params) => handler(method, params);
    const onDetach = () => handler('detach', {});
    dbg.on('message', onMessage);
    dbg.on('detach', onDetach);
    return () => { dbg.removeListener('message', onMessage); dbg.removeListener('detach', onDetach); };
  };
  try {
    return await job((method, params) => dbg.sendCommand(method, params), listen);
  } finally {
    if (mine) { try { dbg.detach(); } catch { /* already gone */ } }
  }
}

/** Puts the picture on the clipboard as an image. Electron 44 has the web-like clipboard (write of ClipboardItem objects);
 * the older clipboard.writeImage is gone. `electron` is the module (or a stand-in in tests). */
async function putOnClipboard({ clipboard, ClipboardItem }, png) {
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
}

/** Brings the window to the front and gives it (and its page) the keyboard focus, whatever it was doing: minimized, hidden, behind another
 * window or another application. Choosing an element needs it: a window that is not active takes the first click for its activation, and the page
 * would get no hover. `electronApp` is `app` (macOS has to be made the active application as well). */
async function focusWindow(win, { electronApp, platform = process.platform, waitMs = 150 } = {}) {
  if (win.isDestroyed()) throw new Error('the window is gone');
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  if (platform === 'darwin' && electronApp) electronApp.focus({ steal: true });
  win.focus();
  win.webContents.focus();
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs)); // the window becomes the active one a moment later
}

/** Runs `job` with the page's live updates held back (so that what is chosen or photographed stays as it is), unless they were held already. */
async function stillPage(webContents, job) {
  const wasFrozen = await webContents.executeJavaScript('window.__omm?.isFrozen() === true').catch(() => true);
  if (!wasFrozen) await webContents.executeJavaScript('window.__omm?.setFrozen(true, true)').catch(() => {}); // quiet: the footer must not say "paused" in the picture
  try {
    return await job();
  } finally {
    if (!wasFrozen) await webContents.executeJavaScript('window.__omm?.setFrozen(false)').catch(() => {});
  }
}

/** Takes the picture and saves it. kind: 'viewport' | 'full' | 'element' (the user chooses the element on the page). Resolves { file, png }.
 * `pickTimeoutMs`: how long the choosing of an element may take.
 * `feedback` (optional, see overlay.js): `picking()` is called while an element is being chosen, and `clear()` before every picture, so that
 * what the page shows to the user is never in the picture. */
async function takeScreenshot(webContents, kind, { dir, label, now = new Date(), pickTimeoutMs, feedback }) {
  let png;
  if (kind === 'viewport') {
    if (feedback) await feedback.clear();
    png = (await webContents.capturePage()).toPNG();
  } else if (kind === 'full') {
    png = await stillPage(webContents, async () => {
      if (feedback) await feedback.clear();
      return withDebugger(webContents, captureFull);
    });
  } else if (kind === 'element') {
    png = await stillPage(webContents, () => withDebugger(webContents, async (send, listen) => {
      if (feedback) await feedback.picking();
      return captureElement(send, listen, { timeoutMs: pickTimeoutMs, onChosen: () => feedback && feedback.clear() });
    }));
  } else {
    throw new Error(`unknown screenshot kind: ${kind}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, shotName(label, kind, now));
  fs.writeFileSync(file, png);
  return { file, png };
}

module.exports = { shotName, screenshotDir, elementClip, captureFull, pickNode, captureNode, captureElement, focusWindow, putOnClipboard, takeScreenshot, MEASURE, MAX_SIDE_PIXELS };
