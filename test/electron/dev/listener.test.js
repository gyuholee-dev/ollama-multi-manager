import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_SIDE, DevRequestError, parseCaptureRequest, startDevServer } from '../../../electron/dev/listener.js';

const PNG = Buffer.from('fake-png-bytes');

async function serve(capture, state) {
  const server = await startDevServer({ capture, ...(state ? { state } : {}) });
  const call = (body, { token = server.token, path = '/capture', method = 'POST', raw } = {}) => fetch(server.url + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: method === 'POST' ? (raw ?? JSON.stringify(body)) : undefined,
  });
  return { server, call };
}

// ---- what a request may ask for

test('a request is checked: only a known kind, a selector for an element, and numbers within their limits', () => {
  assert.deepEqual(parseCaptureRequest({}), { kind: 'viewport', selector: undefined, instanceId: undefined, openMonitor: false, depth: undefined, maxSide: DEFAULT_MAX_SIDE, quality: 'reduced' });
  assert.deepEqual(parseCaptureRequest({ kind: 'element', selector: '  #logs ', instance_id: 3, open_monitor: true, depth: 5, max_side: 800, quality: 'full' }),
    { kind: 'element', selector: '#logs', instanceId: 3, openMonitor: true, depth: 5, maxSide: 800, quality: 'full' });
  for (const bad of [null, [], 'x', { kind: 'video' }, { kind: 'element' }, { kind: 'element', selector: '   ' }, { selector: 5 }, { selector: 'a'.repeat(501) },
    { open_monitor: 'yes', instance_id: 1 }, { open_monitor: true }, { instance_id: 0 }, { instance_id: 1.5 }, { instance_id: '2' }, { depth: -1 }, { depth: 31 }, { max_side: 100 }, { max_side: 5000 }, { max_side: 'big' }, { quality: 'ultra' }, { quality: 1 }]) {
    assert.throws(() => parseCaptureRequest(bad), e => e instanceof DevRequestError && e.code === 'INVALID_REQUEST' && e.status === 400, JSON.stringify(bad));
  }
});

// ---- the listener

test('the picture is taken for a request with the token, and comes back as base64, in the form it was taken (nothing is said of a file)', async () => {
  const seen = [];
  const { server, call } = await serve(async request => { seen.push(request); return { png: PNG, mime: 'image/jpeg', width: 10, height: 20, fullWidth: 100, fullHeight: 200 }; });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await call({ kind: 'full', max_side: 512 });
    assert.equal(r.status, 200);
    const body = await r.json();
    const { data, ...rest } = body;
    assert.deepEqual(rest, { ok: true, mime: 'image/jpeg', width: 10, height: 20, full_width: 100, full_height: 200 });
    assert.equal(Buffer.from(data, 'base64').toString(), 'fake-png-bytes');
    assert.deepEqual(seen, [{ kind: 'full', selector: undefined, instanceId: undefined, openMonitor: false, depth: undefined, maxSide: 512, quality: 'reduced' }]);
  } finally { await server.close(); }
});

test('a request without the right token, to another path or method, is refused before anything is photographed', async () => {
  let taken = 0;
  const { server, call } = await serve(async () => { taken++; return { png: PNG }; });
  try {
    assert.equal((await call({}, { token: '' })).status, 401);
    assert.equal((await call({}, { token: 'nope' })).status, 401);
    assert.equal((await call({}, { path: '/other' })).status, 404);
    assert.equal((await call(undefined, { method: 'GET' })).status, 404);
    assert.equal(taken, 0);
  } finally { await server.close(); }
});

test('an invalid request is a 400 the caller can read, a missing window a 404, and any other failure a 500 with its code', async () => {
  const failures = [new DevRequestError('NO_WINDOW', 'The main window is not open', 404), Object.assign(new Error('boom'), { code: 'TOO_LARGE' }), new Error('plain')];
  const { server, call } = await serve(async () => { throw failures.shift(); });
  try {
    const invalid = await call({ kind: 'video' });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'INVALID_REQUEST');
    assert.equal((await call('not json', { raw: 'not json' })).status, 400);
    const gone = await call({});
    assert.deepEqual([gone.status, (await gone.json()).code], [404, 'NO_WINDOW']);
    const big = await call({});
    assert.deepEqual([big.status, (await big.json()).code], [500, 'TOO_LARGE']);
    const plain = await call({});
    assert.deepEqual([plain.status, (await plain.json()).code], [500, 'FAILED']);
  } finally { await server.close(); }
});

test('a request body that is too large is refused', async () => {
  const { server, call } = await serve(async () => ({ png: PNG }));
  try {
    const r = await call(undefined, { raw: JSON.stringify({ selector: 'a'.repeat(20000) }) });
    assert.equal(r.status, 413);
  } finally { await server.close(); }
});

test('the state of the app is given to a request that has the token, and to no other', async () => {
  const { server } = await serve(async () => ({ png: PNG }), async () => ({ developer_mode: true, main_window: { hidden: true }, monitors: [] }));
  try {
    const ask = (token) => fetch(`${server.url}/state`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    assert.equal((await ask('')).status, 401);
    assert.equal((await ask('nope')).status, 401);
    const r = await ask(server.token);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, developer_mode: true, main_window: { hidden: true }, monitors: [] });
    assert.equal((await fetch(`${server.url}/state`, { method: 'POST', headers: { Authorization: `Bearer ${server.token}` }, body: '{}' })).status, 404); // only a GET reads it
  } finally { await server.close(); }
});
