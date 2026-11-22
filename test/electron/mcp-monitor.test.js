import test from 'node:test';
import assert from 'node:assert/strict';
import { hiddenWindowError, resolveMonitor, unthrottled, waitForContent, windowState } from '../../electron/mcp-monitor.js';
import { ShotRequestError } from '../../electron/mcp-shot.js';

const fakeWindow = (texts = []) => ({
  destroyed: false,
  isDestroyed() { return this.destroyed; },
  webContents: { executeJavaScript: async () => { const next = texts.shift(); return next === undefined ? true : next; } },
});

function parts({ open = null, found = null, ready } = {}) {
  const log = [];
  return {
    log,
    find: id => { log.push(`find ${id}`); return found; },
    open: async id => { log.push(`open ${id}`); return open && { target: open, release: async () => log.push('release') }; },
    ready: ready || (async target => { log.push(`ready ${target === open}`); }),
  };
}

test('an open monitor is used as it is and is left open', async () => {
  const mon = fakeWindow();
  const p = parts({ found: mon });
  const r = await resolveMonitor(4, { ...p, allowOpen: true });
  assert.equal(r.target, mon);
  await r.release();
  assert.deepEqual(p.log, ['find 4']); // nothing opened, nothing closed
});

test('a monitor that is not open is an error that says how to get one, unless opening it was asked for', async () => {
  const p = parts();
  await assert.rejects(resolveMonitor(4, { ...p }), e => e instanceof ShotRequestError && e.code === 'NO_WINDOW' && e.status === 404 && /open_monitor/.test(e.message));
  assert.deepEqual(p.log, ['find 4']); // nothing was opened for a request that did not ask for it
});

test('with opening asked for, the monitor is opened, waited for, and closed again by release', async () => {
  const mon = fakeWindow();
  const p = parts({ open: mon });
  const r = await resolveMonitor(4, { ...p, allowOpen: true });
  assert.equal(r.target, mon);
  assert.deepEqual(p.log, ['find 4', 'open 4', 'ready true']);
  await r.release();
  assert.deepEqual(p.log.slice(3), ['release']);
});

test('an instance that cannot be opened, and a monitor that does not show its content, are errors, and what was opened is closed', async () => {
  await assert.rejects(resolveMonitor(9, { ...parts({ open: null }), allowOpen: true }), e => e.code === 'NO_WINDOW' && /no such instance/.test(e.message));
  const mon = fakeWindow();
  const p = parts({ open: mon, ready: async () => { throw new Error('it did not load in time'); } });
  await assert.rejects(resolveMonitor(4, { ...p, allowOpen: true }), e => e.code === 'NO_WINDOW' && e.status === 504 && /did not show/.test(e.message));
  assert.deepEqual(p.log, ['find 4', 'open 4', 'release']);
});

test('waiting for the content: until the page has drawn text, and an error when it never does or the window is closed', async () => {
  await waitForContent(fakeWindow([false, false, true]), { settleMs: 0, pollMs: 1 });
  await assert.rejects(waitForContent(fakeWindow(Array(100).fill(false)), { timeoutMs: 30, settleMs: 0, pollMs: 5 }), /did not load in time/);
  const closed = fakeWindow();
  closed.destroyed = true;
  await assert.rejects(waitForContent(closed, { settleMs: 0, pollMs: 1 }), /closed/);
});

test('waiting for the content: a page that never answers does not hold it up, and the error says so', async () => {
  const silent = { isDestroyed: () => false, webContents: { executeJavaScript: () => new Promise(() => {}) } }; // never resolves
  const began = Date.now();
  await assert.rejects(waitForContent(silent, { timeoutMs: 120, askMs: 30, settleMs: 0, pollMs: 5 }), /did not answer in time/);
  assert.ok(Date.now() - began < 1000, 'it ended at its own limit, not when the page answered');
});

test('the page is not held back for the time of the job, and is let be held back again after it, also when the job fails', async () => {
  const calls = [];
  const wc = { setBackgroundThrottling: on => calls.push(`throttling ${on}`) };
  assert.equal(await unthrottled(wc, async () => { calls.push('job'); return 7; }), 7);
  assert.deepEqual(calls, ['throttling false', 'job', 'throttling true']);
  calls.length = 0;
  await assert.rejects(unthrottled(wc, async () => { throw new Error('no picture'); }), /no picture/);
  assert.deepEqual(calls, ['throttling false', 'throttling true']);
  const gone = { setBackgroundThrottling: on => { if (on) throw new Error('Object has been destroyed'); } };
  assert.equal(await unthrottled(gone, async () => 'done'), 'done'); // a window destroyed meanwhile does not turn the result into an error
});

test('the state of a window: shown, hidden or minimized, in focus; nothing for a window that is gone', () => {
  const win = (over = {}) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => false, ...over });
  assert.deepEqual(windowState(win()), { visible: true, minimized: false, focused: false, hidden: false });
  assert.equal(windowState(win({ isVisible: () => false })).hidden, true); // in the tray
  assert.equal(windowState(win({ isMinimized: () => true })).hidden, true);
  assert.equal(windowState(win({ isFocused: () => true })).focused, true);
  assert.equal(windowState(win({ isDestroyed: () => true })), null);
  assert.equal(windowState(null), null);
});

test('a hidden window can only be photographed as it is on screen: the other kinds are refused at once, with a message that says what to do', () => {
  const hidden = { visible: false, minimized: false, focused: false, hidden: true };
  const shown = { visible: true, minimized: false, focused: true, hidden: false };
  assert.equal(hiddenWindowError('viewport', hidden, 'The main window'), null);
  assert.equal(hiddenWindowError('full', shown, 'The main window'), null);
  assert.equal(hiddenWindowError('element', null, 'The main window'), null);
  for (const kind of ['full', 'element']) {
    const e = hiddenWindowError(kind, hidden, 'The main window');
    assert.ok(e instanceof ShotRequestError);
    assert.deepEqual([e.code, e.status], ['WINDOW_HIDDEN', 409]);
    assert.match(e.message, new RegExp(`The main window is hidden.*only kind "viewport".*"${kind}".*get_app_state`));
  }
  assert.match(hiddenWindowError('full', { ...hidden, minimized: true }, 'The monitor of instance 3').message, /monitor of instance 3 is minimized/);
});

test('a monitor found open is not marked as opened for the picture, one that was opened for it is', async () => {
  const mon = fakeWindow();
  assert.equal((await resolveMonitor(4, { ...parts({ found: mon }), allowOpen: true })).opened, false);
  assert.equal((await resolveMonitor(4, { ...parts({ open: mon }), allowOpen: true })).opened, true);
});
