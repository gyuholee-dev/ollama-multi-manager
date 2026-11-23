// What the backend tells the main process: its events on /ws (the same ones the page gets), kept as a picture of the backend's state:
//   servers    { web, mcp }       each { state: 'started' | 'stopped' | 'failed', urls, error }   (events "server", see backend/app/services/events.py)
//   instances  { <id>: { state } }                                                              (events "instance")
// The picture is seeded from GET /info and GET /instances when the connection is made, then kept by the events; the main process can look at it (state()) and listen (on()).
// Logging: the process that makes an event logs it in words (the backend: "[backend] MCP server served at ..."), the ones that receive it log it at debug level, in the file
// only: the terminal does not say a thing twice.

const WS_RETRY_MS = 2000;

/** The state from what the backend says now (GET /info and GET /instances). A server that is up has no addresses here (only its events tell them). */
export function seedState(info, instances) {
  const server = s => (s ? { state: s.active ? 'started' : s.error ? 'failed' : 'stopped', urls: [], error: s.error || null } : undefined);
  return {
    servers: Object.fromEntries(Object.entries({ web: server(info?.external_monitoring), mcp: server(info?.mcp) }).filter(([, v]) => v)),
    instances: Object.fromEntries((instances || []).map(i => [i.id, { state: i.status?.state }])),
  };
}

/** What an event does to the state: resolves { changed, line } (`line` says it in words for the log, null when the event is not one the main process follows or changes nothing). */
export function applyEvent(state, msg) {
  if (msg?.type === 'server' && msg.name && msg.state) {
    const was = state.servers[msg.name];
    state.servers[msg.name] = { state: msg.state, urls: Array.isArray(msg.urls) ? msg.urls : [], error: msg.error || null };
    const where = state.servers[msg.name].urls.length ? ` ${state.servers[msg.name].urls.join(' and ')}` : '';
    return { changed: was?.state !== msg.state || (msg.urls || []).join() !== (was?.urls || []).join(), line: `Backend event: server ${msg.name} ${msg.state}${where}${msg.error ? `: ${msg.error}` : ''}` };
  }
  if (msg?.type === 'instance' && Number.isInteger(msg.id)) {
    const next = msg.status?.state;
    const was = state.instances[msg.id]?.state;
    if (next) state.instances[msg.id] = { state: next };
    return { changed: !!next && was !== next, line: next && was !== next ? `Backend event: instance ${msg.id} ${next}` : null };
  }
  return { changed: false, line: null };
}

/** Connects to the backend's /ws (and again when it is lost, until stop()). `api(method, route)` asks the backend over HTTP (for the first picture), `log` is the logger
 * (its debug level is used), `WebSocketImpl` is the WebSocket class (the global one). Resolves { state, on, stop }. */
export function startBackendEvents({ url, token, api, log, WebSocketImpl = globalThis.WebSocket, retryMs = WS_RETRY_MS }) {
  const state = { servers: {}, instances: {} };
  const listeners = new Set();
  let socket = null, timer = null, stopped = false;
  const emit = (change) => { for (const fn of listeners) { try { fn(change, snapshot()); } catch { /* a listener's failure is its own */ } } };
  const snapshot = () => JSON.parse(JSON.stringify(state));

  const seed = async () => {
    try {
      const [info, instances] = await Promise.all([api('GET', '/info'), api('GET', '/instances')]);
      const first = seedState(info, instances);
      state.servers = { ...first.servers, ...state.servers }; // an event that came while the picture was asked for is newer
      state.instances = { ...first.instances, ...state.instances };
      log.debug(`Backend state: ${Object.entries(state.servers).map(([n, s]) => `${n} ${s.state}`).join(', ') || 'no servers'}; ${Object.keys(state.instances).length} instances`);
      emit({ type: 'seed' });
    } catch (e) { log.debug('Could not ask the backend for its state:', e.message); }
  };

  const connect = () => {
    if (stopped || !WebSocketImpl) return;
    const wsUrl = `${url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
    try { socket = new WebSocketImpl(wsUrl); } catch (e) { log.debug('Could not listen to the backend:', e.message); timer = setTimeout(connect, retryMs); return; }
    socket.onopen = () => { log.debug('Listening to the events of the backend'); void seed(); };
    socket.onmessage = event => {
      let msg;
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
      const { changed, line } = applyEvent(state, msg);
      if (line && changed) log.debug(line);
      if (changed) emit(msg);
    };
    socket.onerror = () => { /* onclose follows */ };
    socket.onclose = () => { socket = null; if (!stopped) timer = setTimeout(connect, retryMs); };
  };
  connect();

  return {
    state: snapshot,
    on: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    stop: () => { stopped = true; clearTimeout(timer); try { socket?.close(); } catch { /* gone */ } },
  };
}
