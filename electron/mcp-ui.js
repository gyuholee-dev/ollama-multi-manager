// Developer mode only: what an MCP client may do on the screen of the app, besides looking at it: find elements, click, type, press a key, scroll, set
// a value, read the text. The listener of mcp-shot.js hands the request here (POST /ui); the backend decides whether a client may ask at all (the MCP token,
// the "control" switch, developer mode).
//
// What is done is what a person at the screen does, and as they do it: a click is a mouse click on the centre of the element (so a disabled button, or a
// page that is inert under a dialog, is not clicked), text is typed into the focused field, a key is pressed. Nothing here reaches into the app's code.

import { ShotRequestError } from './mcp-shot.js';

export const UI_ACTIONS = ['find', 'click', 'type', 'key', 'scroll', 'set_value', 'text'];
const MAX_SELECTOR = 500;
const MAX_TEXT = 2000;
const MAX_VALUE = 2000;
const MAX_LIMIT = 100;
const MAX_CHARS = 20000;
const KEY = /^[A-Za-z0-9+\-=,./;'\[\]\\` ]{1,20}$|^(Escape|Enter|Tab|Backspace|Delete|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|F[1-9]|F1[0-2])$/;
const MODIFIERS = ['shift', 'control', 'alt', 'meta'];
/** Actions that need a window that is shown: the input of a window that is hidden does not arrive. */
export const NEEDS_SHOWN = new Set(['click', 'type', 'key']);

const isString = (v, max) => typeof v === 'string' && v.length <= max;
const whole = (v, low, high) => typeof v === 'number' && Number.isInteger(v) && v >= low && v <= high;
const bad = message => new ShotRequestError('INVALID_REQUEST', message);

/** A request body checked: { action, selector, text, index, limit, value, key, modifiers, dx, dy, clear, double, maxChars, instanceId }. */
export function parseUiRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The request must be a JSON object');
  const { action, selector, text, index = 0, limit = 20, value, key, modifiers = [], delta_x: dx = 0, delta_y: dy = 0, clear = false, double = false,
    max_chars: maxChars = 4000, instance_id: instanceId } = body;
  if (!UI_ACTIONS.includes(action)) throw bad(`action must be one of ${UI_ACTIONS.join(', ')}`);
  if (selector != null && (!isString(selector, MAX_SELECTOR) || !selector.trim())) throw bad(`selector must be a CSS selector of at most ${MAX_SELECTOR} characters`);
  if (text != null && !isString(text, MAX_TEXT)) throw bad(`text must be a string of at most ${MAX_TEXT} characters`);
  if (!whole(index, 0, 1000)) throw bad('index must be a whole number from 0 to 1000');
  if (!whole(limit, 1, MAX_LIMIT)) throw bad(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
  if (!whole(maxChars, 1, MAX_CHARS)) throw bad(`max_chars must be a whole number from 1 to ${MAX_CHARS}`);
  if (instanceId != null && !whole(instanceId, 1, 2 ** 31 - 1)) throw bad('instance_id must be a whole number of 1 or more');
  if (typeof clear !== 'boolean' || typeof double !== 'boolean') throw bad('clear and double must be true or false');
  if (!Array.isArray(modifiers) || modifiers.length > 4 || modifiers.some(m => !MODIFIERS.includes(m))) throw bad(`modifiers must be a list of ${MODIFIERS.join(', ')}`);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 100000 || Math.abs(dy) > 100000) throw bad('delta_x and delta_y must be numbers');
  const request = { action, selector: selector?.trim(), text, index, limit, modifiers, dx, dy, clear, double, maxChars, instanceId: instanceId ?? undefined };
  if (action === 'click' && !request.selector) throw bad('click needs a selector');
  if (action === 'set_value') {
    if (!request.selector) throw bad('set_value needs a selector');
    if (!isString(value, MAX_VALUE)) throw bad(`value must be a string of at most ${MAX_VALUE} characters`);
    request.value = value;
  }
  if (action === 'type') {
    if (!isString(body.text, MAX_TEXT) || !body.text) throw bad('type needs text');
  }
  if (action === 'key') {
    if (typeof key !== 'string' || !KEY.test(key)) throw bad('key must be a key name such as Enter, Escape, Tab, ArrowDown, or one character');
    request.key = key;
  }
  return request;
}

// ---- what runs in the page (arguments go in as JSON, never as code)

const HELPERS = `
  const norm = s => String(s ?? '').replace(/\\s+/g, ' ').trim();
  const labelOf = e => norm(e.getAttribute('aria-label') || e.innerText || e.title || e.placeholder || (e.type === 'password' ? '' : e.value) || '');
  const describe = (e, i) => {
    const r = e.getBoundingClientRect();
    const visible = e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const out = { index: i, tag: e.tagName.toLowerCase(), visible, inert: !!e.closest('[inert]'), disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true',
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } };
    if (e.id) out.id = e.id;
    if (e.className && typeof e.className === 'string') out.class = e.className.slice(0, 80);
    const txt = norm(e.innerText || e.textContent || '');
    if (txt) out.text = txt.slice(0, 100);
    const lab = norm(e.getAttribute('aria-label') || e.title || e.placeholder || '');
    if (lab) out.label = lab.slice(0, 100);
    if (e.type) out.type = e.type;
    if (e.type === 'checkbox' || e.type === 'radio') out.checked = e.checked;
    else if (e.value !== undefined && e.type !== 'password' && typeof e.value === 'string' && 'value' in e && e.tagName !== 'BUTTON') out.value = e.value.slice(0, 100);
    return out;
  };
  const matches = (sel, text) => {
    const all = [...document.querySelectorAll(sel)];
    return text ? all.filter(e => norm(e.innerText || e.textContent || '').includes(text) || labelOf(e).includes(text)) : all;
  };`;

const arg = v => JSON.stringify(v ?? null);

export const scripts = {
  find: ({ selector, text, limit }) => `(() => { ${HELPERS}
    let list; try { list = matches(${arg(selector)}, ${arg(text)}); } catch (e) { return { error: 'bad selector: ' + e.message }; }
    return { count: list.length, elements: list.slice(0, ${limit}).map((e, i) => describe(e, i)) }; })()`,
  locate: ({ selector, text, index }) => `(() => { ${HELPERS}
    let list; try { list = matches(${arg(selector)}, ${arg(text)}); } catch (e) { return { error: 'bad selector: ' + e.message }; }
    const e = list[${index}];
    if (!e) return { error: list.length ? 'index ' + ${index} + ' is out of range: ' + list.length + ' element(s) match' : 'no element matches' };
    e.scrollIntoView({ block: 'center', inline: 'center' });
    const r = e.getBoundingClientRect();
    return { info: describe(e, ${index}), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), count: list.length }; })()`,
  focus: ({ selector, text, index, clear }) => `(() => { ${HELPERS}
    let list; try { list = matches(${arg(selector)}, ${arg(text)}); } catch (e) { return { error: 'bad selector: ' + e.message }; }
    const e = list[${index}];
    if (!e) return { error: 'no element matches' };
    e.scrollIntoView({ block: 'center', inline: 'center' }); e.focus();
    if (${clear ? 'true' : 'false'} && typeof e.select === 'function') e.select();
    return { info: describe(e, ${index}), focused: document.activeElement === e }; })()`,
  setValue: ({ selector, text, index, value }) => `(() => { ${HELPERS}
    let list; try { list = matches(${arg(selector)}, ${arg(text)}); } catch (e) { return { error: 'bad selector: ' + e.message }; }
    const e = list[${index}];
    if (!e) return { error: 'no element matches' };
    if (e.disabled) return { error: 'the element is disabled' };
    const value = ${arg(value)};
    if (e.tagName === 'SELECT') {
      const option = [...e.options].find(o => o.value === value) || [...e.options].find(o => norm(o.textContent) === value);
      if (!option) return { error: 'the list has no option "' + value + '" (' + [...e.options].map(o => o.value).slice(0, 20).join(', ') + ')' };
      e.value = option.value;
    } else if ('value' in e) {
      const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, value); // (the setter React does not wrap, so that its own onChange sees the change)
    } else return { error: 'the element has no value to set (a ' + e.tagName.toLowerCase() + ')' };
    e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
    return { info: describe(e, ${index}) }; })()`,
  scroll: ({ selector, text, index, dx, dy }) => `(() => { ${HELPERS}
    if (${arg(selector)} === null) { window.scrollBy({ left: ${dx}, top: ${dy} }); return { scrolled: 'window' }; }
    let list; try { list = matches(${arg(selector)}, ${arg(text)}); } catch (e) { return { error: 'bad selector: ' + e.message }; }
    const e = list[${index}];
    if (!e) return { error: 'no element matches' };
    const before = [e.scrollLeft, e.scrollTop];
    e.scrollBy({ left: ${dx}, top: ${dy} });
    return { scrolled: describe(e, ${index}), from: before, to: [e.scrollLeft, e.scrollTop], scrollHeight: e.scrollHeight, clientHeight: e.clientHeight }; })()`,
  text: ({ selector, maxChars }) => `(() => { ${HELPERS}
    let root = document.body;
    if (${arg(selector)} !== null) { try { root = document.querySelector(${arg(selector)}); } catch (e) { return { error: 'bad selector: ' + e.message }; } }
    if (!root) return { error: 'no element matches' };
    const text = (root.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
    return { length: text.length, text: text.slice(0, ${maxChars}), cut: text.length > ${maxChars} }; })()`,
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = (result, code = 'NO_ELEMENT') => { if (result?.error) throw new ShotRequestError(code, result.error, 404); return result; };

/** Does one action on the page of `webContents`. Resolves what a client should hear back (JSON). `settleMs`: how long the page gets to react after an input. */
export async function runUiAction(webContents, request, { settleMs = 250 } = {}) {
  const run = code => webContents.executeJavaScript(code);
  const input = (event) => webContents.sendInputEvent(event);
  const base = { selector: request.selector, text: request.text, index: request.index };
  switch (request.action) {
    case 'find':
      return fail(await run(scripts.find({ ...request })));
    case 'text':
      return fail(await run(scripts.text({ selector: request.selector ?? null, maxChars: request.maxChars })));
    case 'set_value': {
      const r = fail(await run(scripts.setValue({ ...base, value: request.value })), 'CANNOT_SET');
      await sleep(settleMs);
      return r;
    }
    case 'scroll': {
      const r = fail(await run(scripts.scroll({ ...base, selector: request.selector ?? null, dx: request.dx, dy: request.dy })));
      await sleep(settleMs);
      return r;
    }
    case 'click': {
      const where = fail(await run(scripts.locate(base)));
      const { info } = where;
      if (!info.visible) throw new ShotRequestError('NOT_CLICKABLE', 'the element is not visible', 409);
      if (info.disabled) throw new ShotRequestError('NOT_CLICKABLE', 'the element is disabled', 409);
      if (info.inert) throw new ShotRequestError('NOT_CLICKABLE', 'the element is inert (something is open over it: a dialog, a page)', 409);
      await sleep(60); // the page scrolled the element into view: let it settle
      const at = await run(scripts.locate(base)); // (where it is now)
      const { x, y } = fail(at);
      input({ type: 'mouseMove', x, y });
      await sleep(40);
      const clicks = request.double ? 2 : 1;
      for (let n = 1; n <= clicks; n++) {
        input({ type: 'mouseDown', x, y, button: 'left', clickCount: n, modifiers: request.modifiers });
        input({ type: 'mouseUp', x, y, button: 'left', clickCount: n, modifiers: request.modifiers });
      }
      await sleep(settleMs);
      return { clicked: info, at: { x, y }, matches: where.count };
    }
    case 'type': {
      let focused = null;
      // (for `type` the `text` is what is typed, not a filter for the field)
      if (request.selector) focused = fail(await run(scripts.focus({ selector: request.selector, text: null, index: request.index, clear: request.clear })));
      else if (request.clear) await run('document.activeElement?.select?.()');
      webContents.insertText(request.text);
      await sleep(settleMs);
      return { typed: request.text.length, into: focused?.info ?? null, focused: focused ? focused.focused : null };
    }
    case 'key': {
      const keyCode = request.key === 'Space' ? ' ' : request.key;
      input({ type: 'keyDown', keyCode, modifiers: request.modifiers });
      if (keyCode.length === 1) input({ type: 'char', keyCode, modifiers: request.modifiers });
      input({ type: 'keyUp', keyCode, modifiers: request.modifiers });
      await sleep(settleMs);
      return { pressed: request.key, modifiers: request.modifiers };
    }
    default:
      throw bad(`unknown action ${request.action}`);
  }
}
