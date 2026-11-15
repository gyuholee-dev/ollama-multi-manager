'use strict';
// What the developer screenshots show on the page itself: a note while an element is being chosen, a flash and a note when a picture
// is taken (or has failed or was cancelled). The elements are laid over the page by the shell (no part of the app's own UI), do not take
// pointer events (so that the choosing of an element goes through them: inspect mode does not pick them either), and are taken away
// before a picture is made, so that they are never in it.

const ID = 'omm-shot-overlay';
const FLASH_ATTR = 'data-omm-shot-flash';
const SETTLE_MS = 1500;

// the colours of the note: what is asked (blue), what worked (green), what did not (red)
const COLORS = { info: '#1d4ed8', ok: '#15803d', error: '#b91c1c' };

const json = JSON.stringify;

/** The note at the top centre of the page. It goes away by itself after `ms` (0: it stays until it is cleared). */
function noteScript(text, kind = 'info', ms = 0) {
  return `(() => {
    let el = document.getElementById(${json(ID)});
    if (!el) { el = document.createElement('div'); el.id = ${json(ID)}; document.body.append(el); }
    const token = String(Math.random());
    el.dataset.token = token;
    el.textContent = ${json(String(text))};
    el.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);max-width:80vw;padding:8px 16px;border-radius:999px;'
      + 'font:13px/1.3 system-ui,sans-serif;color:#fff;background:${COLORS[kind] || COLORS.info};box-shadow:0 2px 14px rgba(0,0,0,.5);'
      + 'z-index:2147483647;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    if (${Number(ms) > 0}) setTimeout(() => { const cur = document.getElementById(${json(ID)}); if (cur && cur.dataset.token === token) cur.remove(); }, ${Number(ms) || 0});
  })()`;
}

/** A white flash over the whole page that fades out, like a camera. */
function flashScript() {
  return `(() => {
    const f = document.createElement('div');
    f.setAttribute(${json(FLASH_ATTR)}, '');
    f.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:.85;pointer-events:none;z-index:2147483646';
    document.body.append(f);
    f.animate([{ opacity: .85 }, { opacity: 0 }], { duration: 350, easing: 'ease-out' }).onfinish = () => f.remove();
  })()`;
}

/** Takes the note and the flash away and waits until the page has drawn without them. */
function clearScript() {
  return `new Promise(resolve => {
    document.getElementById(${json(ID)})?.remove();
    document.querySelectorAll('[${FLASH_ATTR}]').forEach(el => el.remove());
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  })`;
}

/** The feedback of one window: { picking(), clear(), done(text), canceled(text), failed(text) }. Showing it never fails the screenshot. */
function overlay(webContents, { settleMs = SETTLE_MS } = {}) {
  const run = code => webContents.executeJavaScript(code).catch(() => {});
  return {
    /** While the user is choosing an element. */
    picking: text => run(noteScript(text, 'info')),
    /** Before a picture: nothing of this is on the page when it is taken (a hidden window draws nothing, so the wait has a limit). */
    clear: () => Promise.race([run(clearScript()), new Promise(resolve => setTimeout(resolve, settleMs))]),
    /** A picture was taken: the flash and a note. */
    done: text => run(`${flashScript()}; ${noteScript(text, 'ok', 4000)}`),
    canceled: text => run(noteScript(text, 'info', 2000)),
    failed: text => run(noteScript(text, 'error', 6000)),
  };
}

module.exports = { overlay, noteScript, flashScript, clearScript, ID };
