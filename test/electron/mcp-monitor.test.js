import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMonitor, waitForContent } from '../../electron/mcp-monitor.js';
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
