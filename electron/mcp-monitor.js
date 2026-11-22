// Developer mode: which page an MCP screenshot of "the monitor of instance N" is taken of, and opening it when the client asks for that.
//
// The monitor is a window of its own today. It is meant to become a side panel in the main window as well (and to be taken out of it into a window
// again), so nothing here knows what it is made of: the caller passes `find` (the monitor if it is open), `open` (opens it) and `ready` (waits for it
// to show its content), and gets back `target`, what the picture is taken of. When the monitor can live in the main window, `find` and `open` are what
// change (the target would be the main window with the panel's element as scope); the request, the tool and this function stay as they are.

import { ShotRequestError } from './mcp-shot.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Waits until the page of `window` has loaded and drawn something (some text on it), then a moment more for what loads in after it. Throws when it
 * does not within `timeoutMs`, or when the window is closed meanwhile. */
export async function waitForContent(window, { timeoutMs = 10000, settleMs = 400, pollMs = 150 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (window.isDestroyed()) throw new Error('the window was closed');
    const drawn = await window.webContents.executeJavaScript("document.readyState === 'complete' && (document.body.innerText || '').trim().length > 40").catch(() => false);
    if (drawn) { await sleep(settleMs); return; }
    await sleep(pollMs);
  }
  throw new Error('it did not load in time');
}

/** Resolves { target, release }: the monitor of the instance, found open, or (with `allowOpen`) opened for this picture. `release()` puts back what the
 * picture changed: it closes a monitor that was opened for it, and leaves one that was open before. Throws a ShotRequestError (code NO_WINDOW) when
 * there is none and it may not or cannot be opened.
 *   find(instanceId)  -> the open monitor, or null
 *   open(instanceId)  -> opens it without taking the user's focus (a promise); null when it cannot be (no such instance); `release` closes it
 *   ready(opened)     -> a promise that resolves once the monitor shows its content */
export async function resolveMonitor(instanceId, { find, open, ready, allowOpen = false }) {
  const found = find(instanceId);
  if (found) return { target: found, release: async () => {} };
  if (!allowOpen) {
    throw new ShotRequestError('NO_WINDOW', `The monitor of instance ${instanceId} is not open (open_monitor opens it for the picture)`, 404);
  }
  const opened = await open(instanceId);
  if (!opened) throw new ShotRequestError('NO_WINDOW', `The monitor of instance ${instanceId} cannot be opened: there is no such instance`, 404);
  const release = async () => { try { await opened.release(); } catch { /* it is gone already */ } };
  try {
    await ready(opened.target);
  } catch (e) {
    await release();
    throw new ShotRequestError('NO_WINDOW', `The monitor of instance ${instanceId} did not show its content: ${e.message}`, 504);
  }
  return { target: opened.target, release };
}
