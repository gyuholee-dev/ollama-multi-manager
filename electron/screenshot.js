'use strict';
// Developer screenshots (developer mode only; see the right-click menu in main.js): the page as it is on screen, the whole main view
// with header and footer, or one element, saved as PNG files in <data folder>/screenshots.
//
// The taking of the picture is not done here: it is the job of the cdp-screenshot-extension package (its `core` for what is done through the
// DevTools protocol, its `adapter-electron` for talking to webContents.debugger). Both are ES modules, so they are loaded with a dynamic
// import() the first time a picture is taken. This file keeps what is the app's own: which window, the focus, holding the live updates
// still, the note on the page, the file and the clipboard.

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE = 'cdp-screenshot-extension';
// How deep below the page's <body> (or below the chosen element) a scrolling box is unfolded; see the package's `depth` option (<body> is 0,
// its children 1 ...). 5 reaches the main view (#root, .views, .views__track, .view, <main>) and so does what the pictures were before the
// package: the main view unfolds, and the boxes inside it (the log, the request lists: 10 below <body> for the log) stay as they are.
const DEFAULT_DEPTH = 5;
// How long the page gets to draw once the note about choosing an element is taken away.
const SETTLE_MS = 1500;
const SETTLE = 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))';

let loading = null;
/** The package's core and Electron adapter (loaded once; a failure is not kept, so that installing the package is enough to try again). */
function loadCapture() {
  loading ??= Promise.all([import(`${PACKAGE}/core`), import(`${PACKAGE}/adapter-electron`)])
    .then(([core, adapter]) => ({ core, adapter }))
    .catch(e => { loading = null; throw new Error(`the screenshot module (${PACKAGE}) cannot be loaded: ${e.message}`); });
  return loading;
}

/** The depth the unfolding goes to: OMM_SCREENSHOT_DEPTH (a whole number, 0 or more) or the default. */
function screenshotDepth(env = process.env) {
  const n = Number(env.OMM_SCREENSHOT_DEPTH);
  return env.OMM_SCREENSHOT_DEPTH !== undefined && env.OMM_SCREENSHOT_DEPTH !== '' && Number.isInteger(n) && n >= 0 ? n : DEFAULT_DEPTH;
}

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

const withTimeout = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))]);

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

/** The element the user chooses on the page, then its picture. The note that asks for the choosing is taken away once the element is chosen
 * (`feedback.clear`), and the page gets a moment to draw without it, so that it is never in the picture. */
async function captureChosenElement(webContents, capture, options, feedback) {
  const { core, adapter } = capture;
  const cdp = adapter.createElectronCdp(webContents);
  await cdp.attach();
  try {
    if (feedback) await feedback.picking();
    const chosen = await core.pickNode(cdp, options);
    if (feedback) await feedback.clear();
    await withTimeout(cdp.send('Runtime.evaluate', { expression: SETTLE, awaitPromise: true }).catch(() => {}), SETTLE_MS);
    return await core.captureNode(cdp, chosen, options);
  } finally {
    await cdp.detach();
  }
}

/** Takes the picture and saves it. kind: 'viewport' | 'full' | 'element' (the user chooses the element on the page). Resolves { file, png }.
 * `pickTimeoutMs`: how long the choosing of an element may take. `depth`: see screenshotDepth.
 * `feedback` (optional, see overlay.js): `picking()` is called while an element is being chosen, and `clear()` before every picture, so that
 * what the page shows to the user is never in the picture.
 * `capture` (optional): the package's { core, adapter }, for a test that has no package to load.
 * A failure is an Error with the package's `code` (CANCELED when the user pressed Escape, TOO_LARGE ...). */
async function takeScreenshot(webContents, kind, { dir, label, now = new Date(), pickTimeoutMs, depth = screenshotDepth(), feedback, capture }) {
  if (!['viewport', 'full', 'element'].includes(kind)) throw new Error(`unknown screenshot kind: ${kind}`);
  const loaded = capture || await loadCapture();
  const options = { depth, format: 'png', pickTimeoutMs };
  let picture;
  if (kind === 'viewport') {
    if (feedback) await feedback.clear();
    picture = await loaded.adapter.runCapture(webContents, 'viewport', options);
  } else if (kind === 'full') {
    picture = await stillPage(webContents, async () => {
      if (feedback) await feedback.clear();
      return loaded.adapter.runCapture(webContents, 'full', options);
    });
  } else {
    picture = await stillPage(webContents, () => captureChosenElement(webContents, loaded, options, feedback));
  }
  const png = Buffer.from(picture.bytes);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, shotName(label, kind, now));
  fs.writeFileSync(file, png);
  return { file, png };
}

// The package's messages are English and for developers (they go to the log). What the page shows is written here, by the error's code.
const FAILURE_TEXT = {
  ko: {
    TOO_LARGE: e => `이미지가 너무 큽니다${e.details?.maxSide ? ` (한 변 최대 ${e.details.maxSide}px)` : ''}`,
    NO_ELEMENT: () => '선택한 엘리먼트를 찾을 수 없습니다',
    TIMEOUT: e => `엘리먼트를 고르지 않아 취소되었습니다${e.details?.pickTimeoutMs ? ` (${Math.round(e.details.pickTimeoutMs / 1000)}초)` : ''}`,
    DETACHED: () => '촬영 중 디버거 연결이 끊어졌습니다',
    NOT_ATTACHABLE: () => '다른 디버거(개발자 도구 등)가 붙어 있어 촬영할 수 없습니다',
    INVALID_OPTION: () => '촬영 옵션이 올바르지 않습니다',
    CDP_ERROR: () => '화면을 캡처하는 중 오류가 났습니다',
  },
  en: {
    TOO_LARGE: e => `The image is too large${e.details?.maxSide ? ` (at most ${e.details.maxSide}px on a side)` : ''}`,
    NO_ELEMENT: () => 'The chosen element was not found',
    TIMEOUT: e => `No element was chosen in time${e.details?.pickTimeoutMs ? ` (${Math.round(e.details.pickTimeoutMs / 1000)} s)` : ''}`,
    DETACHED: () => 'The debugger was detached during the capture',
    NOT_ATTACHABLE: () => 'Another debugger (such as the developer tools) is attached, so the page cannot be captured',
    INVALID_OPTION: () => 'The capture options are not valid',
    CDP_ERROR: () => 'The capture failed inside the page',
  },
};

/** The text for the page of a failed screenshot: by the error's code and the language ('ko' or else English); an error without a known
 * code (the app's own, such as "the window is gone") shows its message. */
function failureText(error, language = 'en') {
  const texts = FAILURE_TEXT[language] || FAILURE_TEXT.en;
  return texts[error?.code]?.(error) ?? error?.message ?? String(error);
}

module.exports = { failureText, shotName, screenshotDir, screenshotDepth, focusWindow, putOnClipboard, takeScreenshot, DEFAULT_DEPTH };
