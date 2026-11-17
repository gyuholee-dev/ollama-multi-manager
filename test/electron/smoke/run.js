// Smoke test of the developer screenshots in a real Electron (needs the electron binary; no app window is shown):
//   yarn test:electron:smoke
// The pages have the app's shape: a header and a footer that stay and a main view that scrolls inside, with a log box that scrolls
// inside the main view. What the unit tests cannot say is checked here: the sizes of the pictures and the state the page is left in.
import { app, BrowserWindow, nativeImage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { takeScreenshot } from '../../../electron/screenshot.js';
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
