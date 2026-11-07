'use strict';
// Thin client for the backend: REST helpers and one auto-reconnecting WebSocket.
// The page is served by the backend itself, so requests are same-origin. Electron passes the session
// token in the URL fragment (#token=...), which is read once and then removed from the address bar.
// For development against a separately started backend, open the page with ?api=http://127.0.0.1:8765
const API = (() => {
  let token = '';
  const m = location.hash.match(/token=([^&]+)/);
  if (m) {
    token = decodeURIComponent(m[1]);
    history.replaceState(null, '', location.pathname + location.search);
  }
  const base = new URLSearchParams(location.search).get('api') || location.origin;

  class ApiError extends Error {
    constructor(status, message, code) { super(message); this.status = status; this.code = code; }
  }

  const messageOf = (data, fallback) => {
    if (data?.error?.message) return data.error.message;
    const d = data?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return d.map(x => `${(x.loc || []).slice(1).join('.')}: ${x.msg}`).join('\n');
    return fallback;
  };

  async function req(method, path, body) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let r;
    try {
      r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new ApiError(0, e.message || 'Network error', 'network');
    }
    if (r.status === 204) return null;
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(r.status, messageOf(data, r.statusText), data?.error?.code);
    return data;
  }

  function connect(onMessage, onStatus) {
    let ws, timer, stopped = false;
    const open = () => {
      const url = base.replace(/^http/, 'ws') + '/ws' + (token ? '?token=' + encodeURIComponent(token) : '');
      ws = new WebSocket(url);
      ws.onopen = () => onStatus(true);
      ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch { /* ignore malformed frames */ } };
      ws.onclose = () => { onStatus(false); if (!stopped) timer = setTimeout(open, 2000); };
      ws.onerror = () => ws.close();
    };
    open();
    return () => { stopped = true; clearTimeout(timer); ws?.close(); };
  }

  return {
    get: p => req('GET', p),
    post: (p, b) => req('POST', p, b ?? {}),
    put: (p, b) => req('PUT', p, b),
    patch: (p, b) => req('PATCH', p, b),
    del: p => req('DELETE', p),
    connect,
    ApiError,
  };
})();
