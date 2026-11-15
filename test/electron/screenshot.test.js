'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shotName, screenshotDir, screenshotDepth, DEFAULT_DEPTH, focusWindow, putOnClipboard, takeScreenshot } = require('../../electron/screenshot');

const PNG = Buffer.from('fake-png-bytes');
const PICTURE = { bytes: new Uint8Array(PNG), mime: 'image/png', width: 10, height: 10 };

/** A fake of the package (core + adapter-electron): records what is asked of it. The picture itself is the package's business, and is
 * tested there; what is tested here is what this app does around it. */
function fakeCapture({ pickFails = null } = {}) {
  const calls = [];
  const options = [];
  const cdp = {
    attach: async () => { calls.push('attach'); },
    detach: async () => { calls.push('detach'); },
    send: async method => { calls.push(method); return {}; },
  };
  const failure = code => Object.assign(new Error(`failed: ${code}`), { code });
  return {
    calls,
    options,
    adapter: {
      createElectronCdp: () => cdp,
      runCapture: async (_webContents, kind, o) => { calls.push(`run:${kind}`); options.push(o); return PICTURE; },
    },
    core: {
      pickNode: async (_cdp, o) => { calls.push('pick'); options.push(o); if (pickFails) throw failure(pickFails); return 7; },
      captureNode: async (_cdp, target, o) => { calls.push(`node:${target}`); options.push(o); return PICTURE; },
    },
  };
}

/** A fake page: the script calls the freeze goes through. */
function fakePage({ frozen = false } = {}) {
  const scripts = [];
  return {
    scripts,
    executeJavaScript: async code => { scripts.push(code); return code.includes('isFrozen') ? frozen : undefined; },
  };
}
const freezes = page => page.scripts.filter(c => c.includes('setFrozen'));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omm-shot-'));

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

test('the depth is the default unless OMM_SCREENSHOT_DEPTH gives a whole number of 0 or more', () => {
  assert.equal(screenshotDepth({}), DEFAULT_DEPTH);
  assert.equal(screenshotDepth({ OMM_SCREENSHOT_DEPTH: '0' }), 0);
  assert.equal(screenshotDepth({ OMM_SCREENSHOT_DEPTH: '5' }), 5);
  for (const bad of ['', 'x', '-1', '1.5']) assert.equal(screenshotDepth({ OMM_SCREENSHOT_DEPTH: bad }), DEFAULT_DEPTH, `"${bad}"`);
});

test('takeScreenshot saves the picture under the folder, as a PNG at the depth asked for', async () => {
  const dir = tempDir();
  try {
    const capture = fakeCapture();
    const { file, png } = await takeScreenshot(fakePage(), 'viewport', { dir: path.join(dir, 'screenshots'), label: 'main', now: new Date(2026, 10, 15, 1, 2, 3), depth: 2, capture });
    assert.equal(path.basename(file), '20261115-010203-main-viewport.png');
    assert.deepEqual(fs.readFileSync(file), PNG);
    assert.deepEqual(png, PNG);
    assert.deepEqual(capture.calls, ['run:viewport']);
    assert.equal(capture.options[0].depth, 2);
    assert.equal(capture.options[0].format, 'png');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('takeScreenshot element: the user chooses, then that node is taken, and the debugger is let go', async () => {
  const dir = tempDir();
  try {
    const capture = fakeCapture();
    await takeScreenshot(fakePage(), 'element', { dir, label: 'main', pickTimeoutMs: 5000, capture });
    const sequence = capture.calls.filter(c => c !== 'Runtime.evaluate');
    assert.deepEqual(sequence, ['attach', 'pick', 'node:7', 'detach']);
    assert.equal(capture.options[0].pickTimeoutMs, 5000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('takeScreenshot element: a cancel is the package\'s CANCELED, leaves no file, lets the debugger go and resumes the updates', async () => {
  const dir = tempDir();
  try {
    const capture = fakeCapture({ pickFails: 'CANCELED' });
    const page = fakePage();
    await assert.rejects(takeScreenshot(page, 'element', { dir, label: 'main', capture }), e => e.code === 'CANCELED');
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.deepEqual(capture.calls, ['attach', 'pick', 'detach']);
    assert.deepEqual(freezes(page), ['window.__omm?.setFrozen(true, true)', 'window.__omm?.setFrozen(false)']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('takeScreenshot full: the live updates are paused while the picture is made and resumed after, unless they were paused already', async () => {
  const dir = tempDir();
  try {
    const page = fakePage();
    await takeScreenshot(page, 'full', { dir, label: 'main', capture: fakeCapture() });
    assert.deepEqual(freezes(page), ['window.__omm?.setFrozen(true, true)', 'window.__omm?.setFrozen(false)']);
    const paused = fakePage({ frozen: true });
    await takeScreenshot(paused, 'full', { dir, label: 'main', capture: fakeCapture() });
    assert.deepEqual(freezes(paused), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('takeScreenshot full: the updates are resumed also when the picture fails', async () => {
  const dir = tempDir();
  try {
    const capture = fakeCapture();
    capture.adapter.runCapture = async () => { throw Object.assign(new Error('too tall'), { code: 'TOO_LARGE' }); };
    const page = fakePage();
    await assert.rejects(takeScreenshot(page, 'full', { dir, label: 'main', capture }), e => e.code === 'TOO_LARGE');
    assert.deepEqual(freezes(page), ['window.__omm?.setFrozen(true, true)', 'window.__omm?.setFrozen(false)']);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('takeScreenshot refuses a kind it does not know', async () => {
  await assert.rejects(takeScreenshot(fakePage(), 'nope', { dir: os.tmpdir(), label: 'main', capture: fakeCapture() }), /unknown screenshot kind/);
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
  const dir = tempDir();
  try {
    const order = [];
    const feedback = { picking: async () => { order.push('picking'); }, clear: async () => { order.push('clear'); } };
    const capture = fakeCapture();
    const tracked = {
      adapter: { ...capture.adapter, runCapture: async (...a) => { order.push('picture'); return capture.adapter.runCapture(...a); } },
      core: {
        pickNode: async (...a) => { order.push('pick'); return capture.core.pickNode(...a); },
        captureNode: async (...a) => { order.push('picture'); return capture.core.captureNode(...a); },
      },
    };

    await takeScreenshot(fakePage(), 'element', { dir, label: 'main', feedback, capture: tracked });
    assert.deepEqual(order, ['picking', 'pick', 'clear', 'picture']);

    order.length = 0;
    await takeScreenshot(fakePage(), 'full', { dir, label: 'main', feedback, capture: tracked });
    assert.deepEqual(order, ['clear', 'picture']);

    order.length = 0;
    await takeScreenshot(fakePage(), 'viewport', { dir, label: 'main', feedback, capture: tracked });
    assert.deepEqual(order, ['clear', 'picture']);
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
