import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, initClient, messageOf, socketUrl } from './client';

function stubBrowser(hash = '', search = '', origin = 'http://127.0.0.1:8765') {
  const store = new Map<string, string>();
  const replaceState = vi.fn();
  vi.stubGlobal('location', { hash, search, origin, pathname: '/' });
  vi.stubGlobal('history', { replaceState });
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  return { store, replaceState };
}

const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('messageOf', () => {
  it('prefers the app error, then FastAPI details, then the fallback', () => {
    expect(messageOf({ error: { message: 'Port 11435 is already in use' } }, 'x')).toBe('Port 11435 is already in use');
    expect(messageOf({ detail: 'Not found' }, 'x')).toBe('Not found');
    expect(messageOf({ detail: [{ loc: ['body', 'options', 'api_key'], msg: 'too short' }] }, 'x')).toBe('options.api_key: too short');
    expect(messageOf(null, 'Bad Gateway')).toBe('Bad Gateway');
  });
});

describe('token', () => {
  it('reads the token from the address, removes it from there and remembers it for a reload', () => {
    const { store, replaceState } = stubBrowser('#token=abc%20123');
    initClient();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(store.get('omm-token')).toBe('abc 123');
    expect(socketUrl()).toBe('ws://127.0.0.1:8765/ws?token=abc%20123');
  });

  it('uses the remembered token when the address has none, and none at all for a guest', () => {
    const { store } = stubBrowser();
    store.set('omm-token', 'kept');
    initClient();
    expect(socketUrl()).toContain('token=kept');
    store.clear();
    initClient();
    expect(socketUrl()).toBe('ws://127.0.0.1:8765/ws');
  });

  it('can point at a separately started backend with ?api=', () => {
    stubBrowser('', '?api=http://10.0.0.5:9000');
    initClient();
    expect(socketUrl()).toBe('ws://10.0.0.5:9000/ws');
  });
});

describe('requests', () => {
  beforeEach(() => {
    const { store } = stubBrowser();
    store.set('omm-token', 'tok');
    initClient();
  });

  it('sends the token and a JSON body, and parses the answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ok: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.post('/instances', { name: 'a' })).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8765/instances');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init.body).toBe('{"name":"a"}');
  });

  it('turns an error response into an ApiError with the backend\'s message and code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(409, { error: { code: 'port_in_use', message: 'Port 11435 is already in use' } })));
    const error = await api.post('/instances/1/start').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'port_in_use', message: 'Port 11435 is already in use' });
  });

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api.get('/info')).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('returns null for 204 No Content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    expect(await api.del('/instances/1')).toBeNull();
  });
});
