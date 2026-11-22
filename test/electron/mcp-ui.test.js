import test from 'node:test';
import assert from 'node:assert/strict';
import { ShotRequestError, startShotServer } from '../../electron/mcp-shot.js';
import { NEEDS_SHOWN, parseUiRequest, runUiAction, scripts } from '../../electron/mcp-ui.js';

// a page that answers the scripts in order, and records what is sent to it as input
function fakePage(answers) {
  const calls = { scripts: [], input: [], typed: [] };
  return {
    calls,
    executeJavaScript: async code => { calls.scripts.push(code); const next = answers.shift(); return typeof next === 'function' ? next(code) : next; },
    sendInputEvent: event => calls.input.push(event),
    insertText: text => calls.typed.push(text),
  };
}
const element = (over = {}) => ({ index: 0, tag: 'button', visible: true, inert: false, disabled: false, rect: { x: 10, y: 20, width: 100, height: 30 }, text: 'Monitor', ...over });
const at = (info, x = 60, y = 35) => ({ info, x, y, count: 1 });
const quick = { settleMs: 0 };

// ---- what a request may ask for

test('a request is checked: a known action, a selector where one is needed, limits on every size', () => {
  assert.equal(parseUiRequest({ action: 'find', selector: 'button' }).limit, 20);
  assert.deepEqual(parseUiRequest({ action: 'click', selector: ' .card button ', text: 'Monitor', index: 1, double: true, modifiers: ['shift'], instance_id: 3 }),
    { action: 'click', selector: '.card button', text: 'Monitor', index: 1, limit: 20, modifiers: ['shift'], dx: 0, dy: 0, clear: false, double: true, maxChars: 4000, instanceId: 3 });
  assert.equal(parseUiRequest({ action: 'key', key: 'Enter' }).key, 'Enter');
  assert.equal(parseUiRequest({ action: 'key', key: 'a', modifiers: ['meta'] }).key, 'a');
  assert.equal(parseUiRequest({ action: 'text' }).selector, undefined); // the whole page
  for (const bad of [null, [], { action: 'fly' }, { action: 'click' }, { action: 'click', selector: '   ' }, { action: 'click', selector: 'a'.repeat(501) },
    { action: 'find', selector: 'a', limit: 0 }, { action: 'find', selector: 'a', limit: 101 }, { action: 'click', selector: 'a', index: -1 },
    { action: 'type' }, { action: 'type', text: '' }, { action: 'type', text: 'x'.repeat(2001) }, { action: 'set_value', selector: 'a' }, { action: 'set_value', value: 'v' },
    { action: 'key' }, { action: 'key', key: 'Escape Escape Escape Escape' }, { action: 'key', key: '<script>' }, { action: 'key', key: 'a', modifiers: ['super'] },
    { action: 'scroll', delta_y: 'down' }, { action: 'scroll', delta_y: 1e9 }, { action: 'text', max_chars: 20001 }, { action: 'click', selector: 'a', double: 'yes' }]) {
    assert.throws(() => parseUiRequest(bad), e => e instanceof ShotRequestError && e.code === 'INVALID_REQUEST', JSON.stringify(bad));
  }
});

test('the arguments go into the page as data, never as code', () => {
  const evil = `"); alert(1); ("`;
  const code = scripts.locate({ selector: evil, text: evil, index: 0 });
  assert.ok(code.includes(JSON.stringify(evil)), 'the quote is escaped inside a JSON string');
  assert.doesNotThrow(() => new Function(`return ${code}`)); // still a single well-formed expression
});

// ---- the actions

test('find: what the page says about the matches', async () => {
  const page = fakePage([{ count: 2, elements: [element(), element({ index: 1, text: 'Details' })] }]);
  const r = await runUiAction(page, parseUiRequest({ action: 'find', selector: 'button', limit: 5 }), quick);
  assert.equal(r.count, 2);
  assert.equal(r.elements[1].text, 'Details');
  assert.equal(page.calls.input.length, 0); // looking does no input
});

test('click: the element is found, scrolled into view and found again where it is now, then clicked at its centre with the mouse', async () => {
  const info = element();
  const page = fakePage([at(info), at(info, 70, 40)]);
  const r = await runUiAction(page, parseUiRequest({ action: 'click', selector: 'button', text: 'Monitor' }), quick);
  assert.deepEqual(page.calls.input.map(e => e.type), ['mouseMove', 'mouseDown', 'mouseUp']);
  assert.deepEqual([page.calls.input[1].x, page.calls.input[1].y, page.calls.input[1].button, page.calls.input[1].clickCount], [70, 40, 'left', 1]); // the second place
  assert.deepEqual(r.at, { x: 70, y: 40 });
  assert.equal(r.clicked.text, 'Monitor');
});

test('click: a double click, and the keys held, go with the mouse events', async () => {
  const page = fakePage([at(element()), at(element())]);
  await runUiAction(page, parseUiRequest({ action: 'click', selector: 'b', double: true, modifiers: ['shift'] }), quick);
  assert.deepEqual(page.calls.input.map(e => e.type), ['mouseMove', 'mouseDown', 'mouseUp', 'mouseDown', 'mouseUp']);
  assert.deepEqual(page.calls.input.slice(1).map(e => e.clickCount), [1, 1, 2, 2]);
  assert.deepEqual(page.calls.input[1].modifiers, ['shift']);
});

test('click: nothing is clicked that a person could not click, and the error says why', async () => {
  for (const [over, why] of [[{ disabled: true }, /disabled/], [{ visible: false }, /not visible/], [{ inert: true }, /inert/]]) {
    const page = fakePage([at(element(over))]);
    await assert.rejects(runUiAction(page, parseUiRequest({ action: 'click', selector: 'button' }), quick), e => e.code === 'NOT_CLICKABLE' && e.status === 409 && why.test(e.message));
    assert.equal(page.calls.input.length, 0);
  }
  const none = fakePage([{ error: 'no element matches' }]);
  await assert.rejects(runUiAction(none, parseUiRequest({ action: 'click', selector: '#nothing' }), quick), e => e.code === 'NO_ELEMENT' && e.status === 404);
});

test('type: the field is focused first (selected when it is to be replaced), then the text is typed into it', async () => {
  const page = fakePage([{ info: element({ tag: 'input' }), focused: true }]);
  const r = await runUiAction(page, parseUiRequest({ action: 'type', selector: 'input', text: 'qwen', clear: true }), quick);
  assert.deepEqual(page.calls.typed, ['qwen']);
  assert.match(page.calls.scripts[0], /e\.select\(\)/);
  assert.ok(!page.calls.scripts[0].includes('"qwen"'), 'the typed text is not used to filter the fields');
  assert.deepEqual([r.typed, r.focused], [4, true]);
  const bare = fakePage([undefined]);
  await runUiAction(bare, parseUiRequest({ action: 'type', text: 'x' }), quick); // no selector: into what has the focus
  assert.deepEqual(bare.calls.typed, ['x']);
  assert.equal(bare.calls.scripts.length, 0);
});

test('key: a key goes down and up, a character also types, and the modifiers come along', async () => {
  const page = fakePage([]);
  await runUiAction(page, parseUiRequest({ action: 'key', key: 'Escape' }), quick);
  assert.deepEqual(page.calls.input.map(e => e.type), ['keyDown', 'keyUp']);
  const chars = fakePage([]);
  await runUiAction(chars, parseUiRequest({ action: 'key', key: 'a', modifiers: ['meta'] }), quick);
  assert.deepEqual(chars.calls.input.map(e => e.type), ['keyDown', 'char', 'keyUp']);
  assert.deepEqual(chars.calls.input[0].modifiers, ['meta']);
});

test('set_value, scroll and text: the page does them, a missing element is an error', async () => {
  const set = fakePage([{ info: element({ tag: 'input', value: '9200' }) }]);
  assert.equal((await runUiAction(set, parseUiRequest({ action: 'set_value', selector: '#p', value: '9200' }), quick)).info.value, '9200');
  const refused = fakePage([{ error: 'the element is disabled' }]);
  await assert.rejects(runUiAction(refused, parseUiRequest({ action: 'set_value', selector: '#p', value: '1' }), quick), e => e.code === 'CANNOT_SET');
  const scroll = fakePage([{ scrolled: element(), from: [0, 0], to: [0, 300], scrollHeight: 2000, clientHeight: 600 }]);
  assert.deepEqual((await runUiAction(scroll, parseUiRequest({ action: 'scroll', selector: '.log', delta_y: 300 }), quick)).to, [0, 300]);
  const text = fakePage([{ length: 5, text: 'Hello', cut: false }]);
  assert.equal((await runUiAction(text, parseUiRequest({ action: 'text', selector: 'main' }), quick)).text, 'Hello');
  const lost = fakePage([{ error: 'no element matches' }]);
  await assert.rejects(runUiAction(lost, parseUiRequest({ action: 'text', selector: '#none' }), quick), e => e.code === 'NO_ELEMENT');
});

test('only the actions that need input need a window that is shown', () => {
  assert.deepEqual([...NEEDS_SHOWN].sort(), ['click', 'key', 'type']);
});

// ---- the route

test('POST /ui: with the token, to the function that does it; without it, or where there is no such function, it is refused', async () => {
  const seen = [];
  const withUi = await startShotServer({ capture: async () => ({ png: Buffer.alloc(1) }), ui: async body => { seen.push(body); return { clicked: true }; } });
  const without = await startShotServer({ capture: async () => ({ png: Buffer.alloc(1) }) });
  try {
    const post = (server, token) => fetch(`${server.url}/ui`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify({ action: 'click', selector: 'b' }) });
    assert.equal((await post(withUi, '')).status, 401);
    const ok = await post(withUi, withUi.token);
    assert.deepEqual([ok.status, await ok.json()], [200, { ok: true, clicked: true }]);
    assert.deepEqual(seen, [{ action: 'click', selector: 'b' }]);
    assert.equal((await post(without, without.token)).status, 404); // no listener for the screen
  } finally { await withUi.close(); await without.close(); }
});
