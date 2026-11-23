// Developer mode: which page an MCP screenshot of "the monitor of instance N" is taken of, and opening it when the client asks for that.
//
// The monitor is a window of its own today. It is meant to become a side panel in the main window as well (and to be taken out of it into a window
// again), so nothing here knows what it is made of: the caller passes `find` (the monitor if it is open), `open` (opens it) and `ready` (waits for it
// to show its content), and gets back `target`, what the picture is taken of. When the monitor can live in the main window, `find` and `open` are what
// change (the target would be the main window with the panel's element as scope); the request, the tool and this function stay as they are.

import { DevRequestError } from './listener.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (promise, ms, fallback) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(fallback), ms))]);

/** Waits until the page of `window` has loaded and drawn something (some text on it), then a moment more for what loads in after it. Throws when it
 * does not within `timeoutMs`, or when the window is closed meanwhile. A page that does not answer at all (a window that is not shown can have its page
 * held back by the system) does not hold this up either: every question to the page is given only `askMs`. */
export async function waitForContent(window, { timeoutMs = 10000, settleMs = 400, pollMs = 150, askMs = 1500 } = {}) {
  const end = Date.now() + timeoutMs;
  let unanswered = 0;
  while (Date.now() < end) {
    if (window.isDestroyed()) throw new Error('the window was closed');
    const ask = window.webContents.executeJavaScript("document.readyState === 'complete' && (document.body.innerText || '').trim().length > 40").catch(() => false);
    const drawn = await within(ask, Math.min(askMs, Math.max(end - Date.now(), 1)), 'no answer');
    if (drawn === 'no answer') unanswered++;
    else if (drawn) { await sleep(settleMs); return; }
    await sleep(pollMs);
  }
  throw new Error(unanswered ? 'the page did not answer in time' : 'it did not load in time');
}

/** What a window is like, for a client that asks: shown or hidden (in the tray, minimized, never shown), and in focus. `hidden` is the one that counts:
 * the system holds back the page of a hidden window, and a picture that has to change the size of the page (the whole page, an element) cannot be made. */
export function windowState(window) {
  if (!window || window.isDestroyed()) return null;
  const visible = window.isVisible(), minimized = window.isMinimized();
  return { visible, minimized, focused: window.isFocused(), hidden: !visible || minimized };
}

/** The error for a picture that cannot be taken of a hidden window, or null. Only the picture of what is on screen (`viewport`) can be taken of it: the
 * others change the size of the page first (checked on Windows and macOS: such a request is not answered, and leaves the debugger of the window taken).
 * `what` names the window in the message. */
export function hiddenWindowError(kind, state, what) {
  if (!state || !state.hidden || kind === 'viewport') return null;
  const where = state.minimized ? 'minimized' : 'hidden (in the tray or not shown)';
  return new DevRequestError('WINDOW_HIDDEN',
    `${what} is ${where}, so only kind "viewport" can be taken of it; for "${kind}" the window has to be shown first (get_app_state tells which windows are shown)`, 409);
}

/** Runs `job` with the page not held back for being in the background, and puts the setting back (to the default, on) afterwards. A page that is
 * hidden (the window in the tray, minimized, or never shown) is otherwise slowed or stopped by the system, and then a picture of it does not come. It is
 * switched off only for the time of the picture, so that a window kept hidden for long does not keep drawing at full speed. */
export async function unthrottled(webContents, job) {
  webContents.setBackgroundThrottling(false);
  try {
    return await job();
  } finally {
    try { webContents.setBackgroundThrottling(true); } catch { /* the window is gone */ }
  }
}

/** Resolves { target, release, opened }: the monitor of the instance, found open, or (with `allowOpen`) opened for this picture. `release()` puts back what the
 * picture changed: it closes a monitor that was opened for it, and leaves one that was open before. Throws a DevRequestError (code NO_WINDOW) when
 * there is none and it may not or cannot be opened.
 *   find(instanceId)  -> the open monitor, or null
 *   open(instanceId)  -> opens it without taking the user's focus (a promise); null when it cannot be (no such instance); `release` closes it
 *   ready(opened)     -> a promise that resolves once the monitor shows its content */
export async function resolveMonitor(instanceId, { find, open, ready, allowOpen = false }) {
  const found = find(instanceId);
  if (found) return { target: found, release: async () => {}, opened: false };
  if (!allowOpen) {
    throw new DevRequestError('NO_WINDOW', `The monitor of instance ${instanceId} is not open (open_monitor opens it for the picture)`, 404);
  }
  const opened = await open(instanceId);
  if (!opened) throw new DevRequestError('NO_WINDOW', `The monitor of instance ${instanceId} cannot be opened: there is no such instance`, 404);
  const release = async () => { try { await opened.release(); } catch { /* it is gone already */ } };
  try {
    await ready(opened.target);
  } catch (e) {
    await release();
    throw new DevRequestError('NO_WINDOW', `The monitor of instance ${instanceId} did not show its content: ${e.message}`, 504);
  }
  return { target: opened.target, release, opened: true };
}
