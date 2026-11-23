import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, seedState, startBackendEvents } from '../../electron/backend-events.js';

const quiet = { debug: () => {} };

test('the first picture: servers up, stopped or failed, and the instances', () => {
  const s = seedState({ external_monitoring: { active: true, error: null }, mcp: { active: false, error: 'Port 9101 is already in use' } }, [{ id: 1, status: { state: 'running' } }, { id: 2, status: { state: 'stopped' } }]);
  assert.deepEqual(s, {
    servers: { web: { state: 'started', urls: [], error: null }, mcp: { state: 'failed', urls: [], error: 'Port 9101 is already in use' } },
    instances: { 1: { state: 'running' }, 2: { state: 'stopped' } },
  });
  assert.deepEqual(seedState({}, undefined), { servers: {}, instances: {} });
});

test('a server event changes the picture and is told in words', () => {
  const state = { servers: {}, instances: {} };
  const r = applyEvent(state, { type: 'server', name: 'mcp', state: 'started', urls: ['http://127.0.0.1:9101/mcp', 'http://192.168.0.24:9101/mcp'], error: null });
  assert.equal(r.changed, true);
  assert.equal(r.line, 'Backend event: server mcp started http://127.0.0.1:9101/mcp and http://192.168.0.24:9101/mcp');
  assert.deepEqual(state.servers.mcp.state, 'started');
  assert.equal(applyEvent(state, { type: 'server', name: 'mcp', state: 'failed', urls: [], error: 'Port in use' }).line, 'Backend event: server mcp failed: Port in use');
});

test('an instance event says something only when its state changes', () => {
  const state = { servers: {}, instances: {} };
  assert.equal(applyEvent(state, { type: 'instance', id: 3, status: { state: 'starting' } }).line, 'Backend event: instance 3 starting');
  assert.deepEqual(applyEvent(state, { type: 'instance', id: 3, status: { state: 'starting' } }), { changed: false, line: null });
  assert.equal(applyEvent(state, { type: 'instance', id: 3, status: { state: 'running' } }).changed, true);
});

test('the events the main process does not follow change nothing', () => {
  const state = { servers: {}, instances: {} };
  for (const msg of [{ type: 'metrics', data: {} }, { type: 'log', instance: 1, msg: 'x' }, null, {}, { type: 'server' }]) assert.deepEqual(applyEvent(state, msg), { changed: false, line: null });
  assert.deepEqual(state, { servers: {}, instances: {} });
});

// a WebSocket that is driven by the test
function fakeSockets() {
  const made = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.closed = false; made.push(this); }
    close() { this.closed = true; this.onclose?.(); }
  }
  return { FakeSocket, made };
}

test('connects with the token, seeds the picture, follows the events, tells the listeners, and connects again when the connection is lost', async () => {
  const { FakeSocket, made } = fakeSockets();
  const lines = [];
  const api = async (_m, route) => (route === '/info' ? { external_monitoring: { active: true }, mcp: { active: true } } : [{ id: 1, status: { state: 'running' } }]);
  const events = startBackendEvents({ url: 'http://127.0.0.1:5000', token: 'a b', api, log: { debug: l => lines.push(l) }, WebSocketImpl: FakeSocket, retryMs: 10 });
  assert.equal(made[0].url, 'ws://127.0.0.1:5000/ws?token=a%20b');
  const heard = [];
  events.on(change => heard.push(change.type));
  made[0].onopen();
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(events.state().servers.web.state, 'started');
  made[0].onmessage({ data: JSON.stringify({ type: 'server', name: 'mcp', state: 'stopped', urls: [], error: null }) });
  made[0].onmessage({ data: 'not json' });
  assert.equal(events.state().servers.mcp.state, 'stopped');
  assert.ok(lines.includes('Backend event: server mcp stopped'));
  assert.deepEqual(heard, ['seed', 'server']);
  made[0].onclose(); // lost
  await new Promise(r => setTimeout(r, 40));
  assert.equal(made.length >= 2, true);
  events.stop();
  const count = made.length;
  made.at(-1).onclose?.();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(made.length, count); // stopped: no more connecting
});

test('an event that came while the first picture was asked for is not overwritten by it', async () => {
  const { FakeSocket, made } = fakeSockets();
  const releases = [];
  const api = (_m, route) => new Promise(resolve => { releases.push(() => resolve(route === '/info' ? { mcp: { active: true } } : [])); });
  const events = startBackendEvents({ url: 'http://x', token: 't', api, log: quiet, WebSocketImpl: FakeSocket });
  made[0].onopen();
  made[0].onmessage({ data: JSON.stringify({ type: 'server', name: 'mcp', state: 'stopped', urls: [], error: null }) });
  releases.forEach(r => r());
  await new Promise(r => setTimeout(r, 20));
  assert.equal(events.state().servers.mcp.state, 'stopped'); // the picture said started, the newer event said stopped
  events.stop();
});
