// Smoke test of the developer screenshots in a real Electron (needs the electron binary; no app window is shown):
//   yarn test:electron:smoke
// The pages have the app's shape: a header and a footer that stay and a main view that scrolls inside, with a log box that scrolls
// inside the main view. What the unit tests cannot say is checked here: the sizes of the pictures and the state the page is left in.
import { app, BrowserWindow, nativeImage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fitPicture, JPEG_QUALITY, takeScreenshot } from '../../../electron/screenshot.js';
import { startDevServer } from '../../../electron/dev/listener.js';
import { unthrottled } from '../../../electron/dev/monitor.js';
import { parseUiRequest, runUiAction } from '../../../electron/dev/ui.js';
import { overlay } from '../../../electron/overlay.js';

const failures = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
  if (!ok) failures.push(name);
};
const size = file => { const b = fs.readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

async function open(page) {
  const w = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { backgroundThrottling: false } });
  await w.loadFile(path.join(import.meta.dirname, page));
  await new Promise(r => setTimeout(r, 300));
  return w;
}
const js = (w, code) => w.webContents.executeJavaScript(code);
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omm-smoke-'));
  try {
    // a main view with more in it than fits: header + footer + all of main in one picture, and the page as it was afterwards
    const tall = await open('tall.html');
    const [vw, vh, dpr] = await js(tall, '[innerWidth, innerHeight, devicePixelRatio]');
    const mainHeight = 5 * (300 + 24 + 12) + 32; // five cards (content + padding + margin) and the padding of main
    const fullCss = 48 + mainHeight + 32;
    await js(tall, 'document.querySelector("main").scrollTop = 400');
    const viewport = await takeScreenshot(tall.webContents, 'viewport', { dir, label: 'tall' });
    check('tall: viewport picture is the window', size(viewport.file), [vw * dpr, vh * dpr]);
    const full = await takeScreenshot(tall.webContents, 'full', { dir, label: 'tall' });
    check('tall: full picture is header + main + footer', size(full.file), [vw * dpr, fullCss * dpr]);
    check('tall: the window is the size it was', await js(tall, '[innerWidth, innerHeight]'), [vw, vh]);
    check('tall: the scroll position is back', await js(tall, 'document.querySelector("main").scrollTop'), 400);
    check('tall: the log box is not taken for the page', await js(tall, 'document.querySelector("#log").scrollTop > 0'), true);

    // an element cut off at the top by the scroll, chosen as a person does it (the pointer moves over it, a click chooses): its whole border box
    const spot = await js(tall, `(() => { const m = document.querySelector("main"), t = document.querySelector("#target"); t.scrollIntoView(); m.scrollTop += 30;
      const mr = m.getBoundingClientRect(), tr = t.getBoundingClientRect(); return [Math.round(tr.x + 5), Math.round(mr.top + 5), tr.top < mr.top]; })()`);
    check('tall: the element starts above the visible part of the main view', spot[2], true);
    const ui = overlay(tall.webContents);
    const noteText = () => js(tall, 'document.getElementById("omm-shot-overlay")?.textContent ?? null');
    const picking = takeScreenshot(tall.webContents, 'element', { dir, label: 'target', feedback: { picking: () => ui.picking('Click the element'), clear: ui.clear } });
    await sleep(500); // inspect mode is on
    check('tall: a note on the page asks for the element while it is being chosen', await noteText(), 'Click the element');
    tall.webContents.sendInputEvent({ type: 'mouseMove', x: spot[0], y: spot[1] });
    await sleep(200);
    tall.webContents.sendInputEvent({ type: 'mouseDown', x: spot[0], y: spot[1], button: 'left', clickCount: 1 });
    tall.webContents.sendInputEvent({ type: 'mouseUp', x: spot[0], y: spot[1], button: 'left', clickCount: 1 });
    const el = await picking;
    check('tall: element picture is the whole element that was clicked', size(el.file), [420 * dpr, 140 * dpr]);
    // the middle of the element is its own colour (#4a6): the highlight that shows while choosing is not in the picture
    const bitmap = nativeImage.createFromPath(el.file);
    const { width: iw, height: ih } = bitmap.getSize();
    const at = (Math.floor(ih / 2) * iw + Math.floor(iw / 2)) * 4;
    const [blue, green, red] = bitmap.toBitmap().subarray(at, at + 3);
    check('tall: no highlight in the picture (the middle is the element\'s own colour)', [red, green, blue], [68, 170, 102]);
    check('tall: the note is gone once the element is chosen', await noteText(), null);
    check('tall: the click did not reach the page (inspect mode took it)', await js(tall, 'window.__clicked === true'), false);

    // Escape cancels the choosing and leaves no picture
    const before = fs.readdirSync(dir).length;
    const canceled = takeScreenshot(tall.webContents, 'element', { dir, label: 'canceled' }).then(() => 'picture', e => e.code);
    await sleep(500);
    tall.webContents.sendInputEvent({ type: 'mouseMove', x: 60, y: 120 });
    await sleep(100);
    tall.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    tall.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    check('tall: Escape cancels the choosing', await canceled, 'CANCELED');
    check('tall: a cancel saves nothing', fs.readdirSync(dir).length, before);
    check('tall: and the page is not left in inspect mode (a picture can be taken at once)', size((await takeScreenshot(tall.webContents, 'viewport', { dir, label: 'after-cancel' })).file), [vw * dpr, vh * dpr]);

    // after a picture the page shows a flash and a note; when the next picture is taken none of it is in the picture
    await ui.done('Saved: x.png');
    check('tall: a note on the page tells that the picture was saved', await noteText(), 'Saved: x.png');
    const header = (file, x, y) => { const img = nativeImage.createFromPath(file); const { width } = img.getSize(); const at = (y * width + x) * 4; const [b, g, r] = img.toBitmap().subarray(at, at + 3); return [r, g, b]; };
    const again = await takeScreenshot(tall.webContents, 'viewport', { dir, label: 'after-note', feedback: { clear: ui.clear } });
    check('tall: neither the flash nor the note is in the next picture (the header is its own colour)', header(again.file, Math.floor(vw * dpr / 2), 24 * dpr), [51, 51, 51]);
    check('tall: and the page has none of it left', await noteText(), null);

    // what an MCP client asks for, through the listener (the element is named by a selector, the picture comes back scaled down, the file is whole)
    const listener = await startDevServer({
      capture: async ({ kind, selector, depth, maxSide, quality }) => {
        // as dev/handlers.js takes it: reduced = scale 1 and JPEG 85, full = the screen's scale and PNG; nothing is saved
        const taking = quality === 'full' ? { format: 'png', useDeviceScale: true } : { format: 'jpeg', quality: JPEG_QUALITY, useDeviceScale: false };
        const shot = await unthrottled(tall.webContents, () => takeScreenshot(tall.webContents, kind, { selector, depth, feedback: { clear: ui.clear }, save: false, ...taking }));
        const fit = fitPicture(shot.png, maxSide, nativeImage, taking);
        return { png: fit.png, mime: shot.mime, width: fit.width, height: fit.height, fullWidth: shot.width, fullHeight: shot.height };
      },
    });
    try {
      const ask = async body => (await fetch(`${listener.url}/capture`, { method: 'POST', headers: { Authorization: `Bearer ${listener.token}` }, body: JSON.stringify(body) })).json();
      const element = await ask({ kind: 'element', selector: '#target', max_side: 4096, quality: 'full' });
      check('mcp: full quality, an element named by a selector is the same picture as the one that was clicked', [element.ok, element.full_width, element.full_height], [true, 420 * dpr, 140 * dpr]);
      check('mcp: full quality is a PNG', [element.mime, Buffer.from(element.data, 'base64').subarray(1, 4).toString()], ['image/png', 'PNG']);
      const reduced = await ask({ kind: 'element', selector: '#target', max_side: 4096 });
      const jpegBytes = Buffer.from(reduced.data, 'base64');
      check('mcp: reduced (the default) is a JPEG at scale 1 (CSS pixels)', [reduced.mime, jpegBytes[0], jpegBytes[1], reduced.full_width, reduced.full_height], ['image/jpeg', 0xff, 0xd8, 420, 140]);
      check('mcp: and it is smaller than the same picture at full quality', jpegBytes.length < Buffer.from(element.data, 'base64').length, true);
      const small = await ask({ kind: 'full', max_side: 500 });
      check('mcp: a long picture is scaled down to the longer side asked for, still a JPEG', [small.ok, Math.max(small.width, small.height), small.mime, Buffer.from(small.data, 'base64')[0]], [true, 500, 'image/jpeg', 0xff]);
      check('mcp: nothing was saved on disk for it', 'file' in small, false);
      await ui.done('Saved: earlier.png'); // a note on the page, as after every picture
      const next = await ask({ kind: 'element', selector: 'header' });
      check('mcp: a note an earlier picture left is not in the next one, and is gone from the page', [next.ok, await noteText()], [true, null]);
      const missing = await ask({ kind: 'element', selector: '#nothing-here' });
      check('mcp: an element that is not there is an error with its code', [missing.ok, missing.code], [false, 'NO_ELEMENT']);
    } finally { await listener.close(); }

    // what an MCP client does on the screen, in a real page: found, clicked, typed into, keys, scrolled, set
    const uiPage = await open('ui.html');
    const ui2 = body => runUiAction(uiPage.webContents, parseUiRequest(body), { settleMs: 80 });
    const found = await ui2({ action: 'find', selector: 'button', text: 'Click' });
    check('ui: find gives the matches with their state', [found.count, found.elements[0].tag, found.elements[0].visible, found.elements[0].disabled], [1, 'button', true, false]);
    await ui2({ action: 'click', selector: '#count' });
    check('ui: a click is a mouse click on the element (the page counted it, and its text changed)', [await js(uiPage, 'window.clicks'), await js(uiPage, '#count'.length && 'document.getElementById("count").textContent')], [1, 'Clicked 1']);
    check('ui: a disabled button is not clicked', await ui2({ action: 'click', selector: '#off' }).then(() => 'clicked', e => e.code), 'NOT_CLICKABLE');
    check('ui: an inert element (under a dialog) is not clicked', await ui2({ action: 'click', selector: '#blocked' }).then(() => 'clicked', e => e.code), 'NOT_CLICKABLE');
    check('ui: no match is an error that says so', await ui2({ action: 'click', selector: '#nothing' }).then(() => 'clicked', e => e.code), 'NO_ELEMENT');
    await ui2({ action: 'type', selector: '#name', text: 'new', clear: true });
    check('ui: typing replaces what was in the field, and the page saw the input', [await js(uiPage, 'document.getElementById("name").value'), await js(uiPage, 'window.typed')], ['new', 'new']);
    await ui2({ action: 'key', key: 'Enter' });
    check('ui: a key press reaches the focused element', await js(uiPage, 'window.lastKey'), 'Enter');
    await ui2({ action: 'set_value', selector: '#mode', value: 'Beta' });
    check('ui: a select is set by its option text, and the page was told', [await js(uiPage, 'document.getElementById("mode").value'), await js(uiPage, 'window.mode')], ['b', 'b']);
    const scrolled = await ui2({ action: 'scroll', selector: '#log', delta_y: 100 });
    check('ui: a box is scrolled', [scrolled.to[1], await js(uiPage, 'document.getElementById("log").scrollTop')], [100, 100]);
    await ui2({ action: 'click', selector: '#far' });
    check('ui: an element out of view is scrolled into view and clicked', await js(uiPage, 'window.far === true'), true);
    const secret = await ui2({ action: 'find', selector: '#secret' });
    check('ui: the value of a password field is not given', secret.elements[0].value, undefined);
    const text = await ui2({ action: 'text', selector: '#log', max_chars: 5 });
    check('ui: the text of a part of the page, cut at the length asked for', [text.text.length, text.cut], [5, true]);

    // a monitor window: the body scrolls under a header, inside a <main> that has no box of its own (display: contents) but has overflow
    const mon = await open('monitor.html');
    const [mw, mh, mdpr] = await js(mon, '[innerWidth, innerHeight, devicePixelRatio]');
    const monFull = await takeScreenshot(mon.webContents, 'full', { dir, label: 'monitor' });
    check('monitor: full picture is header + the whole body', size(monFull.file), [mw * mdpr, (48 + 6 * (300 + 24 + 12) + 16) * mdpr]);
    check('monitor: the window is the size it was', await js(mon, '[innerWidth, innerHeight]'), [mw, mh]);

    // a main view that fits: nothing is out of sight, so the picture is the window, not taller because of the log box inside it
    const fits = await open('fits.html');
    const [fw, fh, fdpr] = await js(fits, '[innerWidth, innerHeight, devicePixelRatio]');
    const shot = await takeScreenshot(fits.webContents, 'full', { dir, label: 'fits' });
    check('fits: full picture is the window (the log box inside does not make it taller)', size(shot.file), [fw * fdpr, fh * fdpr]);
    check('fits: the window is the size it was', await js(fits, '[innerWidth, innerHeight]'), [fw, fh]);
  } catch (e) {
    console.log(`FAIL ${e.stack || e.message}`);
    failures.push('exception');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  app.exit(failures.length ? 1 : 0);
});
