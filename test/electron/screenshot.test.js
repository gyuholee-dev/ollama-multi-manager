'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shotName, screenshotDir, elementClip, captureFull, pickNode, captureNode, captureElement, focusWindow, putOnClipboard, takeScreenshot, MEASURE } = require('../../electron/screenshot');

const PNG = Buffer.from('fake-png-bytes');
const B64 = PNG.toString('base64');

/** A fake debugger: records every command; `answers` can give a function per method. */
function fakeSend(answers = {}) {
  const calls = [];
  const send = async (method, params) => {
    calls.push({ method, params });
    const answer = answers[method];
    if (typeof answer === 'function') return answer(params, calls);
    if (answer !== undefined) return answer;
    if (method === 'Page.captureScreenshot') return { data: B64 };
    return {};
  };
  send.calls = calls;
  send.methods = () => calls.map(c => c.method);
  return send;
}

const measure = (hidden, extra = {}) => ({ result: { value: { width: 960, height: 700, dpr: 2, hidden, ...extra } } });
/** Runtime.evaluate: the page's measurements for MEASURE (one answer per call), true for the settle expression. */
function evaluator(...measures) {
  let n = 0;
  return params => (params.expression === MEASURE ? measures[Math.min(n++, measures.length - 1)] : { result: { value: true } });
}

test('a file name says when, which window and which kind', () => {
  assert.equal(shotName('main', 'full', new Date(2026, 10, 15, 12, 3, 1)), '20261115-120301-main-full.png');
  assert.equal(shotName('monitor 3', 'element', new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405-monitor-3-element.png');
  assert.equal(shotName('', 'viewport', new Date(2026, 0, 1, 0, 0, 0)), '20260101-000000-window-viewport.png');
  assert.ok(!shotName('../../etc', 'full').includes('/'), 'a window label cannot walk out of the folder');
});

test('the folder is <data folder>/screenshots unless OMM_SCREENSHOT_DIR names an absolute one', () => {
  assert.equal(screenshotDir('/data', {}), path.join('/data', 'screenshots'));
  assert.equal(screenshotDir('/data', { OMM_SCREENSHOT_DIR: path.resolve('/shots') }), path.resolve('/shots'));
  assert.equal(screenshotDir('/data', { OMM_SCREENSHOT_DIR: 'relative/dir' }), path.join('/data', 'screenshots'));
});

test('the clip is the border box plus the scroll position, in whole pixels that cover the element', () => {
  const model = { border: [10.4, 20.6, 110.2, 20.6, 110.2, 70.1, 10.4, 70.1] };
  const clip = elementClip(model, { cssVisualViewport: { pageX: 5, pageY: 100, zoom: 1 } });
  assert.deepEqual(clip, { x: 15, y: 120, width: 101, height: 51, scale: 1 }); // 15.4 .. 115.2 and 120.6 .. 170.1: the edge pixels are in
  assert.equal(clip.x + clip.width >= 5 + 110.2, true);
  assert.equal(clip.y + clip.height >= 100 + 70.1, true);
  assert.deepEqual(elementClip({ border: [0, 0, 10, 0, 10, 10, 0, 10] }, { cssVisualViewport: { pageX: 0, pageY: 0, zoom: 2 } }), { x: 0, y: 0, width: 20, height: 20, scale: 1 });
  assert.deepEqual(elementClip({ border: [0, 0, 10, 0, 10, 10, 0, 10] }, {}), { x: 0, y: 0, width: 10, height: 10, scale: 1 }); // no metrics: no scroll
});

test('a rotated element is cut out by its bounding box, and an element without size is refused', () => {
  const rotated = { border: [50, 0, 100, 50, 50, 100, 0, 50] };
  assert.deepEqual(elementClip(rotated, {}), { x: 0, y: 0, width: 100, height: 100, scale: 1 });
  assert.throws(() => elementClip({ border: [5, 5, 5, 5, 5, 5, 5, 5] }, {}), /no size/);
});

test('full: when nothing is out of sight the screen is the page, and the viewport is not touched', async () => {
  const send = fakeSend({ 'Runtime.evaluate': evaluator(measure(0)) });
  const png = await captureFull(send);
  assert.deepEqual(png, PNG);
  assert.deepEqual(send.methods(), ['Runtime.evaluate', 'Page.captureScreenshot']);
});

test('full: the viewport grows by what is out of sight, one picture is taken, and the viewport goes back', async () => {
  const send = fakeSend({ 'Runtime.evaluate': evaluator(measure(1300), measure(0)) });
  const png = await captureFull(send);
  assert.deepEqual(png, PNG);
  assert.deepEqual(send.methods(), [
    'Runtime.evaluate', // measure
    'Runtime.evaluate', // remember where the page is scrolled to
    'Emulation.setDeviceMetricsOverride',
    'Runtime.evaluate', // wait for the page to draw
    'Runtime.evaluate', // measure again
    'Page.captureScreenshot',
    'Emulation.clearDeviceMetricsOverride',
    'Runtime.evaluate', // wait for the old size to be drawn
    'Runtime.evaluate', // scroll back
  ]);
  const scripts = send.calls.filter(c => c.method === 'Runtime.evaluate').map(c => c.params.expression);
  assert.ok(scripts[1].includes('__ommShotScroll = el ?'), 'the second script saves the scroll position');
  assert.ok(scripts.at(-1).includes('s.el.scrollTop = s.top'), 'the last script puts it back');
  const override = send.calls[2].params;
  assert.equal(override.width, 960);
  assert.equal(override.height, 700 + 1300);
  assert.equal(override.deviceScaleFactor, 0, 'the scale of the screen is kept');
  assert.equal(send.calls[5].params.captureBeyondViewport, undefined);
  assert.equal(send.calls[5].params.fromSurface, true);
});

test('full: when the layout asks for more room after growing, it grows once more', async () => {
  const send = fakeSend({ 'Runtime.evaluate': evaluator(measure(1000), measure(200), measure(0)) });
  await captureFull(send);
  const overrides = send.calls.filter(c => c.method === 'Emulation.setDeviceMetricsOverride');
  assert.deepEqual(overrides.map(c => c.params.height), [1700, 1900]);
  assert.ok(send.methods().includes('Emulation.clearDeviceMetricsOverride'));
});

test('full: a page that is too tall is refused before anything is changed', async () => {
  const send = fakeSend({ 'Runtime.evaluate': evaluator(measure(9000, { dpr: 2 })) });
  await assert.rejects(captureFull(send), /too tall/);
  assert.ok(!send.methods().includes('Emulation.setDeviceMetricsOverride'));
});

test('full: the viewport goes back also when the picture fails', async () => {
  const send = fakeSend({
    'Runtime.evaluate': evaluator(measure(500), measure(0)),
    'Page.captureScreenshot': () => { throw new Error('capture failed'); },
  });
  await assert.rejects(captureFull(send), /capture failed/);
  const methods = send.methods();
  assert.ok(methods.includes('Emulation.clearDeviceMetricsOverride'));
  const scripts = send.calls.filter(c => c.method === 'Runtime.evaluate').map(c => c.params.expression);
  assert.ok(scripts.at(-1).includes('s.el.scrollTop = s.top'), 'the scroll position is put back also then');
});

/** A fake event source: `fire(method, params)` calls the handlers that listen. */
function fakeEvents() {
  const handlers = new Set();
  return {
    listen: handler => { handlers.add(handler); return () => handlers.delete(handler); },
    fire: (method, params = {}) => handlers.forEach(h => h(method, params)),
    count: () => handlers.size,
  };
}

test('choosing: the page is put in inspect mode, a click gives the node, and the highlight is taken away', async () => {
  const events = fakeEvents();
  const send = fakeSend({ 'Overlay.setInspectMode': params => { if (params.mode === 'searchForNode') setImmediate(() => events.fire('Overlay.inspectNodeRequested', { backendNodeId: 7 })); } });
  const id = await pickNode(send, events.listen);
  assert.equal(id, 7);
  assert.deepEqual(send.methods(), ['DOM.enable', 'Overlay.enable', 'Overlay.setInspectMode', 'Overlay.setInspectMode', 'Overlay.hideHighlight', 'Overlay.disable']);
  assert.equal(send.calls[2].params.mode, 'searchForNode');
  assert.equal(send.calls[2].params.highlightConfig.showInfo, true);
  assert.equal(send.calls[3].params.mode, 'none');
  assert.equal(events.count(), 0, 'it stops listening');
});

test('choosing: Escape cancels, and the page is put back all the same', async () => {
  const events = fakeEvents();
  const send = fakeSend({ 'Overlay.setInspectMode': params => { if (params.mode === 'searchForNode') setImmediate(() => events.fire('Overlay.inspectModeCanceled')); } });
  await assert.rejects(pickNode(send, events.listen), /canceled/);
  assert.deepEqual(send.methods().slice(-3), ['Overlay.setInspectMode', 'Overlay.hideHighlight', 'Overlay.disable']);
  assert.equal(events.count(), 0);
});

test('choosing: a detached debugger and a choosing that takes too long end it with a message', async () => {
  const events = fakeEvents();
  const detached = fakeSend({ 'Overlay.setInspectMode': params => { if (params.mode === 'searchForNode') setImmediate(() => events.fire('detach')); } });
  await assert.rejects(pickNode(detached, events.listen), /detached/);
  const send = fakeSend();
  await assert.rejects(pickNode(send, fakeEvents().listen, { timeoutMs: 20 }), /in time/);
  assert.equal(send.methods().at(-1), 'Overlay.disable', 'the page is put back after the time ran out too');
});

test('choosing: a failure to start is an error, not an unhandled rejection', async () => {
  const send = fakeSend({ 'Overlay.enable': () => { throw new Error('no overlay'); } });
  await assert.rejects(pickNode(send, fakeEvents().listen), /no overlay/);
});

test('element: scrolls the node into view, reads its box and cuts it out', async () => {
  const send = fakeSend({
    'DOM.getBoxModel': { model: { border: [10, 20, 110, 20, 110, 70, 10, 70] } },
    'Page.getLayoutMetrics': { cssVisualViewport: { pageX: 0, pageY: 0, zoom: 1 } },
  });
  const png = await captureNode(send, 42);
  assert.deepEqual(png, PNG);
  assert.deepEqual(send.methods(), ['DOM.scrollIntoViewIfNeeded', 'DOM.getBoxModel', 'Page.getLayoutMetrics', 'Page.captureScreenshot']);
  assert.deepEqual(send.calls[0].params, { backendNodeId: 42 });
  assert.deepEqual(send.calls[3].params.clip, { x: 10, y: 20, width: 100, height: 50, scale: 1 });
  assert.equal(send.calls[3].params.captureBeyondViewport, true);
});

test('element: the user chooses it, the highlight goes, and then the picture is taken', async () => {
  const events = fakeEvents();
  const send = fakeSend({
    'Overlay.setInspectMode': params => { if (params.mode === 'searchForNode') setImmediate(() => events.fire('Overlay.inspectNodeRequested', { backendNodeId: 9 })); },
    'Runtime.evaluate': { result: { value: true } },
    'DOM.getBoxModel': { model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } },
    'Page.getLayoutMetrics': {},
  });
  const png = await captureElement(send, events.listen);
  assert.deepEqual(png, PNG);
  const methods = send.methods();
  assert.ok(methods.indexOf('Overlay.hideHighlight') < methods.indexOf('Page.captureScreenshot'), 'no highlight in the picture');
  assert.equal(send.calls[methods.indexOf('DOM.scrollIntoViewIfNeeded')].params.backendNodeId, 9);
});

/** A fake page: capturePage, the debugger, and the script calls the freeze goes through. */
function fakePage({ attached = false, attachFails = false, frozen = false, send = fakeSend(), events = fakeEvents() } = {}) {
  const log = { attach: 0, detach: 0, scripts: [] };
  const handlers = new Map(); // 'message' / 'detach' listeners, as an EventEmitter keeps them
  return {
    log,
    events,
    capturePage: async () => ({ toPNG: () => PNG }),
    executeJavaScript: async code => {
      log.scripts.push(code);
      return code.includes('isFrozen') ? frozen : undefined;
    },
    debugger: {
      isAttached: () => attached,
      attach: () => { if (attachFails) throw new Error('Another debugger is already attached'); log.attach++; },
      detach: () => { log.detach++; },
      sendCommand: (method, params) => send(method, params),
      on: (name, handler) => { handlers.set(`${name}:${handler}`, [name, handler]); if (name === 'message') events.listen((method, params) => handler({}, method, params)); },
      removeListener: () => {},
    },
  };
}

test('takeScreenshot saves the picture under the folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omm-shot-'));
  try {
    const { file, png } = await takeScreenshot(fakePage(), 'viewport', { dir: path.join(dir, 'screenshots'), label: 'main', now: new Date(2026, 10, 15, 1, 2, 3) });
    assert.equal(path.basename(file), '20261115-010203-main-viewport.png');
    assert.deepEqual(fs.readFileSync(file), PNG);
    assert.deepEqual(png, PNG);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('takeScreenshot: the debugger is detached after the picture, but not when somebody else attached it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omm-shot-'));
  const make = options => {
    const events = fakeEvents();
    const send = fakeSend({
      'Overlay.setInspectMode': params => { if (params.mode === 'searchForNode') setImmediate(() => events.fire('Overlay.inspectNodeRequested', { backendNodeId: 1 })); },
      'Runtime.evaluate': { result: { value: true } },
      'DOM.getBoxModel': { model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } },
      'Page.getLayoutMetrics': {},
    });
    return fakePage({ send, events, ...options });
  };
  try {
    const mine = make();
    await takeScreenshot(mine, 'element', { dir, label: 'main' });
    assert.deepEqual([mine.log.attach, mine.log.detach], [1, 1]);
    const theirs = make({ attached: true });
    await takeScreenshot(theirs, 'element', { dir, label: 'main' });
    assert.deepEqual([theirs.log.attach, theirs.log.detach], [0, 0]);
    const refused = make({ attachFails: true });
    await assert.rejects(takeScreenshot(refused, 'element', { dir, label: 'main' }), /cannot attach the debugger/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('takeScreenshot element: the page is held still while the element is chosen, and a cancel leaves no file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omm-shot-'));
  try {
    const events = fakeEvents();
    const send = fakeSend({ 'Overlay.setInspectMode': params => { if (params.mode === 'searchForNode') setImmediate(() => events.fire('Overlay.inspectModeCanceled')); } });
    const page = fakePage({ send, events });
    await assert.rejects(takeScreenshot(page, 'element', { dir, label: 'main' }), /canceled/);
    assert.deepEqual(page.log.scripts.filter(c => c.includes('setFrozen')), ['window.__omm?.setFrozen(true, true)', 'window.__omm?.setFrozen(false)']);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(page.log.detach, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('takeScreenshot full: the live updates are paused while the viewport changes and resumed after, unless they were paused already', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omm-shot-'));
  try {
    const page = fakePage({ send: fakeSend({ 'Runtime.evaluate': evaluator(measure(0)) }) });
    await takeScreenshot(page, 'full', { dir, label: 'main' });
    const freezes = page.log.scripts.filter(s => s.includes('setFrozen'));
    assert.deepEqual(freezes, ['window.__omm?.setFrozen(true, true)', 'window.__omm?.setFrozen(false)']);
    const paused = fakePage({ frozen: true, send: fakeSend({ 'Runtime.evaluate': evaluator(measure(0)) }) });
    await takeScreenshot(paused, 'full', { dir, label: 'main' });
    assert.deepEqual(paused.log.scripts.filter(s => s.includes('setFrozen')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('takeScreenshot refuses a kind it does not know', async () => {
  await assert.rejects(takeScreenshot(fakePage(), 'nope', { dir: os.tmpdir(), label: 'main' }), /unknown screenshot kind/);
});

test('the picture goes on the clipboard as one image/png item (the web-like clipboard of Electron 44)', async () => {
  const written = [];
  class FakeItem {
    constructor(items) { this.items = items; }
  }
  await putOnClipboard({ clipboard: { write: async list => { written.push(...list); } }, ClipboardItem: FakeItem }, PNG);
  assert.equal(written.length, 1);
  assert.deepEqual(Object.keys(written[0].items), ['image/png']);
  const blob = written[0].items['image/png'];
  assert.equal(blob.type, 'image/png');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), PNG);
});

test('feedback: the note asks while an element is chosen and is cleared before every picture', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omm-shot-'));
  try {
    const order = [];
    const feedback = { picking: async () => { order.push('picking'); }, clear: async () => { order.push('clear'); } };
    const events = fakeEvents();
    const base = fakeSend({
      'Overlay.setInspectMode': params => { if (params.mode === 'searchForNode') setImmediate(() => events.fire('Overlay.inspectNodeRequested', { backendNodeId: 3 })); },
      'Runtime.evaluate': params => ({ result: { value: params.expression === MEASURE ? { width: 960, height: 700, dpr: 2, hidden: 0 } : true } }),
      'DOM.getBoxModel': { model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } },
      'Page.getLayoutMetrics': {},
    });
    const send = async (method, params) => { order.push(method); return base(method, params); };
    const page = fakePage({ send, events });

    await takeScreenshot(page, 'element', { dir, label: 'main', feedback });
    assert.ok(order.indexOf('picking') < order.indexOf('Overlay.setInspectMode'), 'asked before inspect mode starts');
    assert.ok(order.indexOf('clear') > order.indexOf('Overlay.hideHighlight'), 'cleared once the element is chosen');
    assert.ok(order.indexOf('clear') < order.indexOf('Page.captureScreenshot'), 'and before the picture');

    order.length = 0;
    await takeScreenshot(page, 'full', { dir, label: 'main', feedback });
    assert.equal(order[0], 'clear', 'full: cleared first');
    assert.ok(!order.includes('picking'));

    order.length = 0;
    await takeScreenshot(page, 'viewport', { dir, label: 'main', feedback });
    assert.deepEqual(order, ['clear']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A fake window that records what is done to it. */
function fakeWindow({ minimized = false, visible = true, destroyed = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    isVisible: () => visible,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    webContents: { focus: () => calls.push('page focus') },
  };
}

test('focus: a window that is behind gets the focus, and its page too', async () => {
  const win = fakeWindow();
  await focusWindow(win, { platform: 'win32', waitMs: 0 });
  assert.deepEqual(win.calls, ['focus', 'page focus']);
});

test('focus: a minimized or hidden window is brought back first', async () => {
  const minimized = fakeWindow({ minimized: true });
  await focusWindow(minimized, { platform: 'linux', waitMs: 0 });
  assert.deepEqual(minimized.calls, ['restore', 'focus', 'page focus']);
  const hidden = fakeWindow({ visible: false });
  await focusWindow(hidden, { platform: 'linux', waitMs: 0 });
  assert.deepEqual(hidden.calls, ['show', 'focus', 'page focus']);
});

test('focus: on macOS the application itself is made the active one', async () => {
  const order = [];
  const win = fakeWindow();
  win.focus = () => order.push('window focus');
  await focusWindow(win, { platform: 'darwin', electronApp: { focus: options => order.push(`app focus ${JSON.stringify(options)}`) }, waitMs: 0 });
  assert.deepEqual(order, ['app focus {"steal":true}', 'window focus']);
  const other = [];
  await focusWindow(fakeWindow(), { platform: 'win32', electronApp: { focus: () => other.push('app focus') }, waitMs: 0 });
  assert.deepEqual(other, [], 'only macOS needs it');
});

test('focus: a window that is gone is an error, and the focus waits a moment for the window to become the active one', async () => {
  await assert.rejects(focusWindow(fakeWindow({ destroyed: true }), { waitMs: 0 }), /gone/);
  const started = Date.now();
  await focusWindow(fakeWindow(), { platform: 'win32', waitMs: 60 });
  assert.ok(Date.now() - started >= 50);
});
