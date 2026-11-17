import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { overlay, noteScript, flashScript, clearScript, ID } from '../../electron/overlay.js';

test('the scripts laid over the page are valid scripts, whatever text they carry', () => {
  const nasty = 'it\'s "quoted"\n</script> ${x} `tick` \\ back';
  for (const kind of ['info', 'ok', 'error', 'unknown']) assert.doesNotThrow(() => new vm.Script(noteScript(nasty, kind, 4000)), kind);
  assert.doesNotThrow(() => new vm.Script(noteScript('plain')));
  assert.doesNotThrow(() => new vm.Script(flashScript()));
  assert.doesNotThrow(() => new vm.Script(clearScript()));
});

test('the note does not take the pointer, and sits above everything', () => {
  const script = noteScript('hello', 'info');
  assert.ok(script.includes('pointer-events:none'));
  assert.ok(script.includes('z-index:2147483647'));
  assert.ok(flashScript().includes('pointer-events:none'));
  assert.ok(script.includes(ID));
});

test('the note goes away by itself only when it was given a time, and only if it is still the same note', () => {
  assert.ok(noteScript('x', 'ok', 4000).includes('if (true) setTimeout'));
  assert.ok(noteScript('x', 'info').includes('if (false) setTimeout'));
  assert.ok(noteScript('x', 'ok', 4000).includes('cur.dataset.token === token'), 'an old note must not take a newer one away');
});

/** A fake page that records the scripts it is asked to run. */
function fakeWebContents(behaviour = () => true) {
  const scripts = [];
  return { scripts, executeJavaScript: code => { scripts.push(code); return Promise.resolve().then(() => behaviour(code)); } };
}

test('done shows a flash and a green note; failed a red one; canceled a blue one', async () => {
  const wc = fakeWebContents();
  const ui = overlay(wc);
  await ui.done('Saved: a.png');
  assert.equal(wc.scripts.length, 1);
  assert.ok(wc.scripts[0].includes('animate') && wc.scripts[0].includes('#15803d') && wc.scripts[0].includes('Saved: a.png'));
  await ui.failed('no');
  assert.ok(wc.scripts[1].includes('#b91c1c'));
  await ui.canceled('stop');
  assert.ok(wc.scripts[2].includes('#1d4ed8'));
});

test('showing the feedback never fails a screenshot, and clear does not wait for a page that does not draw', async () => {
  const broken = fakeWebContents(() => { throw new Error('page is gone'); });
  const ui = overlay(broken, { settleMs: 20 });
  await ui.picking('choose');
  await ui.done('x');
  await ui.clear();
  const hidden = { executeJavaScript: () => new Promise(() => {}) }; // a hidden window never draws a frame
  const started = Date.now();
  await overlay(hidden, { settleMs: 30 }).clear();
  assert.ok(Date.now() - started < 1000);
});
