// Developer mode only: the listener the backend calls when an MCP client asks for a screenshot (the MCP server lives in the backend, the pictures are taken
// here, in Electron). It is not part of the app's own API and has none of its rights:
//  * it listens on the loopback address only, on a port the system picks, and takes one request: POST /capture;
//  * every request carries a token made for this run (handed to the backend through its environment, as the app's own API token is), a wrong or
//    missing one is refused;
//  * a request is only data (what to photograph); the taking of the picture is `capture`, which main.js passes in.
// The backend decides whether a client may ask at all (the "screenshots for MCP" switch, off by default, and loopback-only MCP).

import crypto from 'node:crypto';
import http from 'node:http';

const KINDS = ['viewport', 'full', 'element'];
const MAX_BODY = 8 * 1024;
export const DEFAULT_MAX_SIDE = 1568; // the longer side of what is handed to a client: larger pictures are scaled down by the model's side anyway
export const MIN_MAX_SIDE = 256;
export const MAX_MAX_SIDE = 4096;
const MAX_SELECTOR = 500;
const MAX_DEPTH = 30;

/** A request that cannot be served as it is asked. `code` goes back to the caller. */
export class ShotRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const whole = (value, low, high) => typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high;

/** What a request body asks for, checked: { kind, selector, instanceId, openMonitor, depth, maxSide }. Anything else is a ShotRequestError. */
export function parseShotRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ShotRequestError('INVALID_REQUEST', 'The request must be a JSON object');
  const { kind = 'viewport', selector, instance_id: instanceId, open_monitor: openMonitor = false, depth, max_side: maxSide = DEFAULT_MAX_SIDE } = body;
  if (!KINDS.includes(kind)) throw new ShotRequestError('INVALID_REQUEST', `kind must be one of ${KINDS.join(', ')}`);
  if (selector != null && (typeof selector !== 'string' || !selector.trim() || selector.length > MAX_SELECTOR)) {
    throw new ShotRequestError('INVALID_REQUEST', `selector must be a CSS selector of at most ${MAX_SELECTOR} characters`);
  }
  if (kind === 'element' && !selector) throw new ShotRequestError('INVALID_REQUEST', 'kind "element" needs a selector: nobody can click the element');
  if (instanceId != null && !whole(instanceId, 1, 2 ** 31 - 1)) throw new ShotRequestError('INVALID_REQUEST', 'instance_id must be a whole number of 1 or more');
  if (typeof openMonitor !== 'boolean') throw new ShotRequestError('INVALID_REQUEST', 'open_monitor must be true or false');
  if (openMonitor && instanceId == null) throw new ShotRequestError('INVALID_REQUEST', 'open_monitor needs an instance_id: it opens the monitor of that instance');
  if (depth != null && !whole(depth, 0, MAX_DEPTH)) throw new ShotRequestError('INVALID_REQUEST', `depth must be a whole number from 0 to ${MAX_DEPTH}`);
  if (!whole(maxSide, MIN_MAX_SIDE, MAX_MAX_SIDE)) throw new ShotRequestError('INVALID_REQUEST', `max_side must be a whole number from ${MIN_MAX_SIDE} to ${MAX_MAX_SIDE}`);
  return { kind, selector: selector ? selector.trim() : undefined, instanceId: instanceId ?? undefined, openMonitor, depth: depth ?? undefined, maxSide };
}

function sameToken(given, expected) {
  const a = Buffer.from(String(given)), b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, refused = false;
    const chunks = [];
    req.on('data', chunk => {
      if (refused) return; // what follows is let go by, not kept
      size += chunk.length;
      if (size > MAX_BODY) { refused = true; chunks.length = 0; reject(new ShotRequestError('INVALID_REQUEST', 'The request is too large', 413)); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Starts the listener. `capture(request)` resolves { file, png, width, height, fullWidth, fullHeight } (see main.js) or throws (an error with `code`).
 * Resolves { url, token, close }. */
export async function startShotServer({ capture, log = () => {}, token = crypto.randomBytes(24).toString('hex') }) {
  const reply = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
    res.end(text);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), token)) return reply(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Invalid or missing token' });
      if (req.method !== 'POST' || req.url !== '/capture') return reply(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Not found' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (e) {
        if (e instanceof ShotRequestError) throw e;
        throw new ShotRequestError('INVALID_REQUEST', 'The request is not valid JSON');
      }
      const picture = await capture(parseShotRequest(body));
      reply(res, 200, {
        ok: true, mime: 'image/png', file: picture.file, width: picture.width, height: picture.height,
        full_width: picture.fullWidth, full_height: picture.fullHeight, data: picture.png.toString('base64'),
      });
    } catch (e) {
      if (!(e instanceof ShotRequestError)) log(`MCP screenshot failed: ${e.code ?? ''} ${e.message}`);
      if (!res.headersSent) reply(res, e instanceof ShotRequestError ? e.status : 500, { ok: false, code: e.code || 'FAILED', message: e.message });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
