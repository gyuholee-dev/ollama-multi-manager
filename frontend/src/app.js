'use strict';
// UI logic. State comes from the backend (REST for commands, WebSocket for live updates);
// nothing here is mock data, except the one fake download card shown in developer mode (?dev=1, set by OMM_DEV).

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEV = new URLSearchParams(location.search).get('dev') === '1';
const GiB = 2 ** 30;
const gb = b => (b || 0) / GiB;

// ---------------------------------------------------------------- settings <-> backend keys
const detectLang = () => {
  for (const l of navigator.languages || [navigator.language]) {
    const b = String(l || '').toLowerCase().split('-')[0];
    if (window.LOCALES[b]) return b;
  }
  return 'en';
};
const KEYMAP = {
  lang: 'language', theme: 'theme', login: 'launch_at_login', tray: 'minimize_to_tray', interval: 'refresh_interval_seconds',
  extMon: 'external_monitoring_enabled', monPort: 'external_monitoring_port', exe: 'ollama_executable_path', modelsPath: 'default_models_path',
};
const DEF = { lang: '', theme: 'system', login: false, tray: false, interval: 3, extMon: true, monPort: 9100, exe: '', modelsPath: '' };
const cfgFromApi = s => ({
  lang: s.language || detectLang(), theme: s.theme, login: s.launch_at_login, tray: s.minimize_to_tray,
  interval: s.refresh_interval_seconds, extMon: s.external_monitoring_enabled, monPort: s.external_monitoring_port,
  exe: s.ollama_executable_path || '', modelsPath: s.default_models_path || '',
});
const cfgToApi = (k, v) => (k === 'exe' || k === 'modelsPath') ? (String(v).trim() || null) : v;

// ---------------------------------------------------------------- state
const S = {
  cfg: { ...DEF, lang: detectLang() }, saved: { ...DEF, lang: detectLang() },
  raw: [],        // GET /instances
  snap: null,     // latest metrics snapshot
  info: null,     // GET /info
  logs: [],       // {ts, src, m, level}
  pulls: {},      // task id -> pull task
  modelList: [], detail: null,
  connected: false,
};
const cfg = () => S.cfg;
const t = (k, p) => String(LOCALES[S.cfg.lang]?.[k] ?? LOCALES.en[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => p?.[x] ?? '');
const mi = n => `<span class="material-icons">${n}</span>`;

const SI = { running: 'circle', stopped: 'radio_button_unchecked', starting: 'more_horiz', stopping: 'more_horiz', unreachable: 'warning', crashed: 'error_outline' };
const stL = s => mi(SI[s]) + t('state.' + s);
const SORD = ['running', 'starting', 'stopping', 'stopped', 'crashed', 'unreachable'];

// Instances as the UI wants them: the stored record plus what the latest snapshot says about it.
function view() {
  return S.raw.map(i => {
    const m = S.snap?.instances?.[i.id], o = i.options;
    let state = i.status.state;
    if (state === 'running' && m && !m.responsive) state = 'unreachable';
    return {
      id: i.id, name: i.name, port: i.port, state, pid: i.status.pid, startedAt: (i.status.started_at || 0) * 1000,
      ctx: o.context_length, keep: o.keep_alive_min, maxLoaded: o.max_loaded_models, parallel: o.num_parallel,
      gpu: o.gpu, flash: o.flash_attention, kvq: o.kv_cache_type, listen: o.listen, key: o.api_key, auto: o.auto_start, idle: o.idle_stop_min,
      loaded: (m?.models || []).map(x => ({ name: x.name, gb: gb(x.size_vram || x.size), exp: x.expires_at })),
      metrics: m,
    };
  });
}
const byId = id => view().find(i => i.id == id);
const ext = () => S.snap?.external ? {
  name: t('ext.name'), port: S.snap.external.port, keep: 5,
  loaded: S.snap.external.models.map(x => ({ name: x.name, gb: gb(x.size_vram || x.size), exp: x.expires_at })),
} : null;
const devices = () => S.snap?.gpu?.devices || [];

// ---------------------------------------------------------------- logs
const hms = ts => new Date(ts).toLocaleTimeString('en-GB');
const lf = { v: 'all' };
const nameOf = id => id === 0 ? 'app' : (S.raw.find(i => i.id === id)?.name ?? 'instance-' + id);
function addLog(e) {
  S.logs.push(e);
  if (S.logs.length > 500) S.logs.shift();
  if (S.frozen) return;
  $('status').textContent = `[${hms(e.ts)}] ${e.m}`;
  renderLogs();
}
const log = m => addLog({ ts: Date.now(), src: 'app', m, level: 'info' });      // UI-side messages
const fromBackendLog = e => addLog({ ts: e.ts * 1000, src: nameOf(e.instance), m: e.msg, level: e.level });

function setHtml(el, html) { if (el._h !== html) { el._h = html; el.innerHTML = html; } }
function renderLogs() {
  const srcs = ['app', ...new Set(S.logs.map(e => e.src).filter(x => x !== 'app'))], box = $('logs');
  if (lf.v !== 'all' && !srcs.includes(lf.v)) lf.v = 'all';
  setHtml($('ltabs'), ['all', ...srcs].map(x => `<button class="small${x === lf.v ? ' on' : ''}" onclick="setLf(this.dataset.s)" data-s="${esc(x)}">${x === 'all' ? t('log.all') : x === 'app' ? t('log.app') : esc(x)}</button>`).join(''));
  const end = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
  const text = S.logs.filter(e => lf.v === 'all' || e.src === lf.v).map(e => `[${hms(e.ts)}] ${lf.v === 'all' ? `[${e.src}] ` : ''}${e.m}`).join('\n');
  if (box._t !== text) { box._t = text; box.textContent = text; if (end) box.scrollTop = box.scrollHeight; }
}
const setLf = v => { lf.v = v; renderLogs(); $('logs').scrollTop = $('logs').scrollHeight; };

// ---------------------------------------------------------------- popups
const POPI = { info: 'info', warn: 'warning', error: 'error', confirm: 'help_outline', danger: 'delete_outline' };
// Resolves true (ok), 'alt' (the optional middle button) or false (cancel / closed).
function popup({ kind = 'info', title, msg, ok = t('pop.ok'), cancel, alt }) {
  return new Promise(r0 => {
    const pop = $('pop');
    let done = false;
    const res = v => { if (!done) { done = true; r0(v); } }, end = v => { res(v); pop.close(); };
    pop.dataset.k = kind;
    pop.innerHTML = `<div class="pb"><div class="pi">${mi(POPI[kind])}</div><div class="pt"><h3></h3><p></p></div></div><div class="btns">${cancel ? '<button type="button" id="pc"></button>' : ''}${alt ? '<button type="button" id="pa"></button>' : ''}<button type="button" id="po" class="primary${kind === 'danger' ? ' danger' : ''}"></button></div>`;
    pop.querySelector('h3').textContent = title;
    pop.querySelector('p').textContent = msg;
    $('po').textContent = ok;
    if (cancel) { $('pc').textContent = cancel; $('pc').onclick = () => end(false); }
    if (alt) { $('pa').textContent = alt; $('pa').onclick = () => end('alt'); }
    $('po').onclick = () => end(true);
    pop.addEventListener('close', () => { if (!pop.open) res(false); }, { once: true });
    if (pop.open) pop.close();
    pop.showModal();
    $('po').focus();
  });
}
const notify = (kind, title, msg) => popup({ kind, title, msg });
const ask = (title, msg, ok = t('pop.cont'), danger = false) => popup({ kind: danger ? 'danger' : 'confirm', title, msg, ok, cancel: t('btn.cancel') });
const fail = e => { log(`Error: ${e.message}`); return notify('error', t('err.title'), e.status === 0 ? t('conn.lost') : e.message); };

// ---------------------------------------------------------------- formatting
const fmtCtx = c => c / 1024 + 'K';
const KEEP = [1, 5, 15, 30, 60, 180, 360, 720, 1440, -1];
const fmtN = n => n + t('u.cnt');
const fmtKeep = m => m < 0 ? t('keep.unlimited') : m >= 1440 ? t('keep.day', { n: m / 1440 }) : m >= 60 ? t('keep.hour', { n: m / 60 }) : t('keep.min', { n: m });
const fmtUp = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t('sec.n', { n: s });
  const m = Math.floor(s / 60);
  return m < 60 ? m + t('up.m') : Math.floor(m / 60) + t('up.h') + ' ' + (m % 60) + t('up.m');
};
const expAt = (exp, keep) => keep < 0 || !exp ? t('exp.none') : t('exp.at', { t: new Date(exp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) });
const loadedBox = (x, keep) => `<div class="model" style="display:flex;justify-content:space-between;gap:8px"><span title="${esc(x.name)}">${esc(x.name)}</span><span class="sub">${expAt(x.exp, keep)}</span></div>`;
const portLine = (port, ctx, ld = []) => `<div class="sub">${t('card.line', { port, ctx: ctx ? fmtCtx(ctx) : '-', gb: +ld.reduce((a, x) => a + x.gb, 0).toFixed(1) })}</div>`;
const gpuName = g => g === 'auto' ? t('gpu.auto') : g === 'cpu' ? 'CPU' : t('gpu.n', { g, name: devices()[g]?.name ?? '?' });

// ---------------------------------------------------------------- summary & monitor
const sumOn = new Set(['ins', 'usage', 'perf']), SUMS = ['ins', 'usage', 'perf', 'status'];
const togSum = k => { sumOn.has(k) ? sumOn.delete(k) : sumOn.add(k); renderSum(); };
const monOn = new Set(['CPU', 'RAM', 'GPU', 'VRAM']), monAvail = () => devices().length ? ['CPU', 'RAM', 'GPU', 'VRAM'] : ['CPU', 'RAM'];
const togMon = k => { monOn.has(k) ? monOn.delete(k) : monOn.add(k); render(); };
const color = n => `hsl(${n * 70 + 210} 60% 55%)`;

function vramByGpu() {
  const insts = view();
  return devices().map(d => {
    const parts = [];
    insts.forEach((i, n) => {
      const m = i.metrics;
      if (!m) return;
      let b = 0;
      if (m.vram_source === 'nvml') b = m.vram_by_gpu?.[d.index] || 0;
      else if (m.vram_source === 'estimated' && i.gpu !== 'cpu' && (i.gpu === d.index || (i.gpu === 'auto' && d.index === 0))) b = m.vram_bytes || 0;
      if (b > 0) parts.push({ name: i.name, v: gb(b), col: color(n) });
    });
    const used = gb(d.mem_used), total = gb(d.mem_total);
    return { d, parts, used, total, pct: total ? Math.round(used / total * 100) : 0 };
  });
}
const cell = (k, v, u = '', c = '') => `<div><div class="sub">${k}</div><b${c ? ` style="color:var(${c})"` : ''}>${v}${u ? `<small>${u}</small>` : ''}</b></div>`;
const sbox = (k, cs) => !sumOn.has(k) ? '' : `<div class="sb"><b>${t('sum.' + k)}</b><div class="sc">${cs.join('')}</div></div>`;

// Request numbers measured by the instances' proxies, added up over every running instance (last 5 minutes).
function perfAll() {
  const ps = Object.values(S.snap?.instances || {}).map(i => i.perf).filter(Boolean);
  if (!ps.length) return null;
  const sum = k => ps.reduce((a, p) => a + (p[k] || 0), 0), n = sum('requests'), evalS = sum('eval_seconds');
  const lat = ps.filter(p => p.latency_avg != null).reduce((a, p) => a + p.latency_avg * p.requests, 0);
  return { processing: sum('processing'), queued: sum('queued'), latency: n && lat ? lat / n : null, speed: evalS > 0 ? sum('tokens') / evalS : null, errors: sum('errors'), requests: n };
}

function renderSum() {
  setHtml($('utabs'), SUMS.map(k => `<button class="small${sumOn.has(k) ? ' on' : ''}" onclick="togSum('${k}')">${t('sum.' + k)}</button>`).join(''));
  const list = view(), e = ext(), c = s => list.filter(i => i.state === s).length;
  const bad = c('crashed') + c('unreachable'), V = vramByGpu(), pct = V.length ? Math.max(...V.map(g => g.pct)) : null;
  const sys = S.snap?.system, memPct = sys ? Math.round(sys.mem_used / sys.mem_total * 100) : null;
  const models = list.reduce((n, i) => n + i.loaded.length, 0) + (e ? e.loaded.length : 0);
  const warn = bad + (pct > 85 ? 1 : 0), errs = S.logs.filter(x => x.level === 'warn').length;
  const ex = S.info?.external_monitoring;
  setHtml($('sum'), [
    sbox('ins', [cell(t('c.total'), list.length + (e ? 1 : 0)), cell(t('c.running'), c('running') + (e ? 1 : 0)), cell(t('c.stopped'), c('stopped')), cell(t('c.unreach'), bad)]),
    sbox('usage', [pct === null ? '' : cell('VRAM', pct, '%', pct > 85 ? '--warn' : ''), cell(t('c.mem'), memPct ?? '-', memPct === null ? '' : '%'), cell(t('c.models'), models, t('u.cnt'))]),
    sbox('perf', (() => {
      const p = perfAll();
      return [
        cell(t('c.reqs'), p ? p.processing : '-', p ? ` ${t('u.case')} · ${t('c.queued')} ${p.queued}` : ''),
        cell(t('c.latency'), p?.latency != null ? p.latency.toFixed(1) : '-', p?.latency != null ? ' s' : ''),
        cell(t('c.speed'), p?.speed != null ? Math.round(p.speed) : '-', p?.speed != null ? ' tok/s' : ''),
        cell(t('c.fail'), p ? p.errors : '-', p ? ` ${t('u.case')}${p.requests ? ` · ${Math.round(p.errors / p.requests * 100)}%` : ''}` : '', p?.errors ? '--err' : ''),
      ];
    })()),
    sbox('status', [cell(t('c.warn'), warn ? warn : t('c.ok'), warn ? t('u.case') : '', warn ? '--warn' : '--ok'), cell(t('c.errs'), errs, t('u.case')),
      cell(t('c.mon'), ex?.active ? t('c.on') : t('c.off'), ex?.active ? ` :${ex.port}` : ''), cell(t('c.updated'), S.snap ? hms(S.snap.ts * 1000).slice(0, 5) : '-')]),
  ].join('') || `<div class="sub" style="grid-column:1/-1">${t('sum.empty')}</div>`);
}

// Empty segments are left out: the bar's 1px gap would otherwise show as a notch before the first real segment.
const bar = ps => `<div class="bar">${ps.filter(p => p[1] > 0).map(p => `<i title="${esc(p[0])}" style="width:${p[1]}%;background:${p[2]}"></i>`).join('')}</div>`;
const leg = ps => `<div class="leg">${ps.map(p => `<span><s style="background:${p[2]}"></s>${esc(p[0])} ${p[3]}</span>`).join('')}</div>`;

function renderMon() {
  const avail = monAvail();
  setHtml($('mtabs'), avail.map(k => `<button class="small${monOn.has(k) ? ' on' : ''}" onclick="togMon('${k}')">${k}</button>`).join(''));
  const sys = S.snap?.system, insts = Object.values(S.snap?.instances || {});
  if (!sys) { setHtml($('mon'), `<div class="sub" style="grid-column:1/-1">${t('sum.empty')}</div>`); return; }
  const S_ = t('mon.system'), O = t('mon.other'), on = k => avail.includes(k) && monOn.has(k);
  const mb = (k, v, body, w = '') => on(k) ? `<div class="sb"><div class="top" style="margin:0"><b>${k}</b><span class="sub"${w}>${v}</span></div>${body}</div>` : '';
  const cores = sys.cpu_count || 1, cpuTotal = Math.round(sys.cpu_percent);
  const cpuOllama = Math.min(cpuTotal, Math.round(insts.reduce((a, m) => a + m.cpu_percent, 0) / cores)), cpuOther = cpuTotal - cpuOllama;
  const ramOllama = gb(insts.reduce((a, m) => a + m.rss, 0)), ramUsed = gb(sys.mem_used), ramTotal = gb(sys.mem_total), ramOther = Math.max(0, ramUsed - ramOllama);
  const V = vramByGpu(), vUsed = V.reduce((a, g) => a + g.used, 0), vTotal = V.reduce((a, g) => a + g.total, 0), vMax = V.length ? Math.max(...V.map(g => g.pct)) : 0;
  const cpuSeg = [['Ollama', cpuOllama, 'var(--accent)', cpuOllama + '%'], [O, cpuOther, 'var(--sub)', cpuOther + '%']];
  const ramSeg = [[S_, ramOther / ramTotal * 100, 'var(--sub)', ramOther.toFixed(1) + ' GB'], ['Ollama', ramOllama / ramTotal * 100, 'var(--accent)', ramOllama.toFixed(1) + ' GB']];
  const gpuRows = devices().map((d, n) => {
    const u = d.util_percent ?? 0, extra = [d.util_percent != null ? d.util_percent + '%' : null, d.temperature_c != null ? d.temperature_c + '°C' : null].filter(Boolean).join(' · ');
    return `<div class="top" style="margin:${n ? 14 : 8}px 0 0"><span>${esc(gpuName(n))}</span><span class="sub">${extra}</span></div>${bar([[d.name, u, 'var(--accent)']])}`;
  }).join('');
  const vramRows = V.map((g, n) => {
    const ps = [[S_, Math.max(0, g.used - g.parts.reduce((a, p) => a + p.v, 0)) / g.total * 100, 'var(--sub)', Math.max(0, g.used - g.parts.reduce((a, p) => a + p.v, 0)).toFixed(1) + ' GB'],
      ...g.parts.map(p => [p.name, p.v / g.total * 100, p.col, p.v.toFixed(1) + ' GB'])];
    return `<div class="top" style="margin:${n ? 14 : 8}px 0 0"><span>${esc(gpuName(n))}</span><span class="sub"${g.pct > 85 ? ' style="color:var(--warn)"' : ''}>${g.used.toFixed(1)} / ${g.total.toFixed(1)} GB (${g.pct}%)</span></div>` + bar(ps) + leg(ps);
  }).join('');
  setHtml($('mon'), [
    mb('CPU', t('mon.cpu', { pct: cpuTotal, n: cores }), bar(cpuSeg) + leg(cpuSeg)),
    mb('RAM', `${ramUsed.toFixed(1)} / ${ramTotal.toFixed(0)} GB (${Math.round(ramUsed / ramTotal * 100)}%)`, bar(ramSeg) + leg(ramSeg)),
    mb('GPU', t('mon.gpus', { n: devices().length }), gpuRows),
    mb('VRAM', `${vUsed.toFixed(1)} / ${vTotal.toFixed(0)} GB (${vTotal ? Math.round(vUsed / vTotal * 100) : 0}%)`, vramRows, vMax > 85 ? ' style="color:var(--warn)"' : ''),
  ].join('') || `<div class="sub" style="grid-column:1/-1">${t('sum.empty')}</div>`);
}

// ---------------------------------------------------------------- instance cards
const so = { k: 'name', d: 1 }, SO = [['name', 'f.name'], ['port', 'f.port'], ['state', 'f.state']];
const nameCmp = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
const sorted = () => view().sort((a, b) => so.d * (so.k === 'state' ? SORD.indexOf(a.state) - SORD.indexOf(b.state) : so.k === 'port' ? a.port - b.port : nameCmp(a, b)) || nameCmp(a, b));
const setSort = k => { if (so.k === k) so.d = -so.d; else { so.k = k; so.d = 1; } render(); };

function btns(i) {
  const idle = i.state === 'stopped' || i.state === 'crashed', busy = i.state === 'starting' || i.state === 'stopping';
  return (idle ? `<button class="small" onclick="setState(${i.id},'running')">${t('btn.start')}</button>`
    : `<button class="small" onclick="setState(${i.id},'stopped')" ${busy ? 'disabled' : ''}>${t('btn.stop')}</button>`)
    + `<button class="small" onclick="show(${i.id})" ${busy ? 'disabled' : ''}>${t('btn.details')}</button>`
    + `<button class="small del" onclick="del(${i.id})" ${idle ? '' : `disabled title="${t('del.disabled')}"`}>${t('btn.delete')}</button>`;
}

function renderCards() {
  setHtml($('stabs'), SO.map(([k, x]) => `<button class="small${so.k === k ? ' on' : ''}" onclick="setSort('${k}')">${t(x)}${so.k === k ? mi(so.d > 0 ? 'arrow_upward' : 'arrow_downward') : ''}</button>`).join(''));
  const e = ext();
  setHtml($('grid'), sorted().map(i => `<div class="card"><div class="top"><b>${esc(i.name)}</b><span class="badge ${i.state}">${stL(i.state)}</span></div>
  ${portLine(i.port, i.ctx, i.loaded)}${i.auto ? `<div class="sub">${t('card.auto')}</div>` : ''}
  ${i.loaded.length ? i.loaded.map(x => loadedBox(x, i.keep)).join('') : `<div class="model" style="color:var(--sub)">${t('card.none')}</div>`}<div class="btns">${btns(i)}</div></div>`).join('')
    + (e ? `<div class="card ext"><div class="top"><b>${esc(e.name)}</b><span class="badge">${mi('lock')}${t('ext.managed')}</span></div>${portLine(e.port, 0, e.loaded)}${e.loaded.length ? e.loaded.map(x => loadedBox(x, e.keep)).join('') : `<div class="model" style="color:var(--sub)">${t('card.none')}</div>`}</div>` : ''));
}

function render() { renderMon(); renderSum(); renderCards(); }

// ---------------------------------------------------------------- instance actions
async function setState(id, state) {
  const i = byId(id);
  if (!i) return;
  if (state === 'running') {
    const V = vramByGpu(), pct = V.length ? Math.max(...V.map(g => g.pct)) : 0;
    if (pct > 85 && !await popup({ kind: 'warn', title: t('w.vram.t'), msg: t('w.vram.m', { pct, n: i.name }), ok: t('btn.start'), cancel: t('btn.cancel') })) return;
  }
  let drain = 0;  // seconds to wait for running requests before stopping
  if (state !== 'running') {
    const busy = i.metrics?.perf?.inflight || 0;
    if (busy > 0) {
      const r = await popup({ kind: 'danger', title: t('w.busy.t'), msg: t('w.busy.m', { n: i.name, k: busy }), ok: t('btn.drainStop'), alt: t('btn.stopNow'), cancel: t('btn.cancel') });
      if (!r) return;
      drain = r === true ? 120 : 0;
    } else if (i.loaded.length && !await ask(t('w.stop.t'), t('w.stop.m', { n: i.name, k: i.loaded.length }), t('btn.stop'), true)) return;
  }
  try {
    await API.post(`/instances/${id}/${state === 'running' ? 'start' : 'stop'}`, drain ? { drain_seconds: drain } : undefined);
  } catch (e) { await fail(e); }
  await loadInstances();
}

async function del(id) {
  const i = byId(id);
  if (!i || !await ask(t('inst.del.title'), t('inst.del.msg', { n: i.name }), t('btn.delete'), true)) return;
  try { await API.del(`/instances/${id}`); } catch (e) { await fail(e); }
  await loadInstances();
}

const kv = (k, v) => `<div class="f row"><label>${k}</label><span>${v}</span></div>`;
async function show(id) {
  const i = byId(id);
  if (!i) return;
  let avail = [];
  if (i.state === 'running') { try { avail = await API.get(`/instances/${id}/models`); } catch { /* shown as "none" */ } }
  const run = i.state === 'running', m = i.metrics, ld = i.loaded.map(x => `<div>${esc(x.name)} · ${x.gb.toFixed(1)} GB</div>`).join('<div class="gp"></div>');
  const vram = m?.vram_bytes != null ? gb(m.vram_bytes).toFixed(1) + ' GB' + (m.vram_source === 'estimated' ? ' ~' : '') : '-';
  $('det').innerHTML = `<h3>${esc(i.name)} <button style="float:right" onclick="det.close()">${mi('close')}</button></h3>
 <div id="dt"><div class="box"><b>${t('new.server')}</b>${kv(t('f.state'), `<span class="badge ${i.state}">${stL(i.state)}</span>`)}${kv(t('f.port'), i.port)}${kv(t('d.addr'), i.listen === 'lan' ? `http://${S.info?.lan_ip || '?'}:${i.port}` : `http://127.0.0.1:${i.port}`)}${kv(t('f.auto'), i.auto ? (i.idle ? t('auto.idle', { n: i.idle }) : t('c.on')) : t('c.off'))}${kv(t('f.lan'), i.listen === 'lan' ? t('c.on') : t('c.off'))}${kv(t('f.key'), i.key ? t('c.on') : t('c.off'))}${kv(t('d.pid'), i.pid ?? '-')}${kv(t('d.uptime'), run ? fmtUp(Date.now() - i.startedAt) : '-')}${kv(t('f.maxLoaded'), fmtN(i.maxLoaded))}${kv(t('f.parallel'), fmtN(i.parallel))}</div>
 <div class="box"><b>${t('d.models')}</b><div class="f row"><label>${t('d.loaded')}</label><div class="ml">${ld || `<div class="sub">${t('d.none')}</div>`}</div></div><div class="f row"><label>${t('d.avail')}</label><div class="ml">${avail.map(x => `<div>${esc(x.name)} · ${gb(x.size).toFixed(1)} GB</div>`).join('<div class="gp"></div>') || `<div class="sub">${t('d.none')}</div>`}</div></div></div>
 <div class="box"><b>${t('d.req')}</b><div id="rq"></div></div>
 <div class="box"><b>${t('d.res')}</b>${kv(t('d.vram'), vram)}${kv(t('f.ctx'), fmtCtx(i.ctx))}${kv(t('f.keep'), fmtKeep(i.keep) + (i.keep >= 0 && i.loaded.length ? ' · ' + expAt(i.loaded[0].exp, i.keep) : ''))}${kv(t('f.device'), esc(gpuName(i.gpu)))}${kv(t('f.kvq'), i.kvq)}${kv(t('f.flash'), i.flash ? t('c.on') : t('c.off'))}</div></div>`;
  S.detail = id;
  refreshRequests();
  $('det').showModal();
}

// Per-model numbers and the latest requests of the instance whose details are open (no prompts or answers are kept).
// Last hour, one column per minute: requests (red part = failed) and the generation speed.
function reqCharts(series) {
  const n = series.length, w = 300, h = 44, bw = w / n, maxR = Math.max(1, ...series.map(x => x.requests));
  const bars = series.map((x, k) => {
    if (!x.requests) return '';
    const bh = Math.max(2, x.requests / maxR * (h - 4)), eh = x.errors / x.requests * bh;
    return `<rect x="${(k * bw + .5).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${(bh - eh).toFixed(1)}" fill="var(--accent)"/>`
      + (eh ? `<rect x="${(k * bw + .5).toFixed(1)}" y="${(h - eh).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${eh.toFixed(1)}" fill="var(--err)"/>` : '');
  }).join('');
  const sp = series.map((x, k) => [k, x.tok_per_s]).filter(p => p[1] != null), maxS = Math.max(1, ...sp.map(p => p[1]));
  const line = sp.length ? `<polyline fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${sp.map(([k, v]) => `${(k * bw + bw / 2).toFixed(1)},${(h - 3 - v / maxS * (h - 6)).toFixed(1)}`).join(' ')}"/>` : '';
  const total = series.reduce((a, x) => a + x.requests, 0);
  return `<div class="sub">${t('rq.hour', { n: total })}</div><svg class="rqc" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${t('rq.hour', { n: total })}">${bars}</svg>
    <div class="sub" style="margin-top:8px">${t('rq.hourSpeed', { n: Math.round(maxS) })}</div><svg class="rqc" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${t('rq.hourSpeed', { n: Math.round(maxS) })}">${line}</svg><div style="height:10px"></div>`;
}
const stClass = r => r.outcome === 'error' ? 'bad' : r.outcome === 'cancelled' ? 'cx' : '';
async function refreshRequests() {
  const box = $('rq');
  if (!box || S.detail == null) return;
  let d, ser;
  try {
    [d, ser] = await Promise.all([API.get(`/instances/${S.detail}/requests?limit=20`), API.get(`/monitor/requests?minutes=60&instance=${S.detail}`)]);
  } catch { return; }
  if (!$('rq')) return;
  const models = Object.entries(d.models);
  const mt = models.length ? `<div class="rqw"><table class="rq"><tr><th>${t('rq.model')}</th><th class="r">${t('rq.count')}</th><th class="r">${t('rq.speed')}</th><th class="r">${t('rq.avg')}</th></tr>${models.map(([m, x]) =>
    `<tr><td>${esc(m)}</td><td class="r">${x.requests}${x.errors ? ` <span class="bad">(${x.errors})</span>` : ''}</td><td class="r">${x.tok_per_s != null ? Math.round(x.tok_per_s) + ' tok/s' : '-'}</td><td class="r">${x.latency_avg != null ? x.latency_avg.toFixed(1) + ' s' : '-'}</td></tr>`).join('')}</table></div>` : '';
  const rt = d.requests.length ? `<div class="rqw"><table class="rq"><tr><th>${t('rq.time')}</th><th>${t('rq.path')}</th><th>${t('rq.model')}</th><th class="r">${t('rq.status')}</th><th class="r">${t('rq.dur')}</th><th class="r">${t('rq.tok')}</th></tr>${d.requests.map(r =>
    `<tr class="${stClass(r)}"><td>${hms(r.ts * 1000)}</td><td>${esc(r.path)}</td><td>${esc(r.model || '-')}</td><td class="r">${r.outcome === 'cancelled' ? t('rq.cancelled') : r.status}</td><td class="r">${r.duration.toFixed(1)} s</td><td class="r">${r.prompt_tokens ?? '-'} / ${r.tokens ?? '-'}</td></tr>`).join('')}</table></div>` : `<div class="sub">${t('rq.none')}</div>`;
  box.innerHTML = reqCharts(ser.series) + (mt ? `<div class="sub">${t('rq.byModel')}</div>${mt}` : '') + `<div class="sub" style="margin-top:${mt ? 10 : 0}px">${t('rq.recent')}</div>${rt}`;
}
$('det').addEventListener('close', () => { S.detail = null; });

// ---------------------------------------------------------------- new instance
const rgFill = e => e.style.setProperty('--p', (e.value - e.min) / (e.max - e.min) * 100 + '%');
document.addEventListener('input', e => { if (e.target.matches?.('.rg')) rgFill(e.target); });

async function openNew() {
  const dlg = $('dlg');
  let port = 11435;
  try { port = (await API.get('/instances/next-port')).port; } catch (e) { await fail(e); return; }
  $('gp').innerHTML = ['auto', 'cpu', ...devices().keys()].map(g => `<option value="${g}">${esc(gpuName(g))}</option>`).join('');
  let k = 1;
  while (S.raw.some(i => i.name === 'worker-' + k)) k++;
  $('n').value = 'worker-' + k; $('p').value = port;
  $('cx').value = 3; $('cv').textContent = '8K';
  $('kp').value = 1; $('kv').textContent = fmtKeep(5);
  $('mlr').value = 2; $('ml').textContent = fmtN(2);
  $('npr').value = 2; $('np').textContent = fmtN(2);
  $('gp').value = 'auto'; $('fa').checked = true; $('kvq').value = 'f16';
  $('lan').checked = false; $('ak').value = ''; $('ak').placeholder = t('f.keyPh');
  $('as').checked = false; $('ist').value = 10; $('istw').style.display = 'none';
  document.querySelectorAll('#sv .cc').forEach(x => x.checked = false);
  document.querySelectorAll('.rg').forEach(rgFill);
  dlg.showModal();
}

function create(ev) {
  const port = +$('p').value, nm = $('n').value.trim();
  const e = ext(), used = [...S.raw.map(i => i.port), ...(e ? [e.port] : [])];
  const bad = !nm ? [t('v.nameReq.t'), t('v.nameReq.m')]
    : S.raw.some(i => i.name === nm) ? [t('v.nameDup.t'), t('v.nameDup.m', { n: nm })]
      : !(port >= 1024 && port <= 65535) ? [t('v.port.t'), t('v.port.m')]
        : used.includes(port) || port === S.cfg.monPort ? [t('port.conflict'), t('v.used.m', { p: port })] : null;
  if (bad) { notify('warn', ...bad); return false; }
  const g = $('gp').value;
  submitNew({
    name: nm, port, options: {
      gpu: g === 'auto' || g === 'cpu' ? g : +g, context_length: 2048 * 2 ** ($('cx').value - 1), keep_alive_min: KEEP[$('kp').value],
      max_loaded_models: +$('mlr').value, num_parallel: +$('npr').value, flash_attention: $('fa').checked, kv_cache_type: $('kvq').value,
      listen: $('lan').checked ? 'lan' : 'local', api_key: $('ak').value.trim() || null,
      auto_start: $('as').checked, idle_stop_min: $('as').checked ? Math.max(0, +$('ist').value || 0) : 0,
    },
  });
  return false;  // the dialog is closed once the backend has accepted the instance
}
const genKey = () => {  // 24 random bytes as URL-safe text
  const b = crypto.getRandomValues(new Uint8Array(24));
  $('ak').value = btoa(String.fromCharCode(...b)).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
};
async function submitNew(body) {
  if (body.options.listen === 'lan' && !body.options.api_key
    && !await popup({ kind: 'warn', title: t('w.lan.t'), msg: t('w.lan.m'), ok: t('btn.open'), cancel: t('btn.cancel') })) return;
  try {
    await API.post('/instances', body);
    $('dlg').close();
  } catch (e) { await notify('warn', t('err.title'), e.message); }
  await loadInstances();
}

// ---------------------------------------------------------------- settings
const caret = mi('expand_more');
const chk = (id, label, v) => `<div class="f row"><label>${label}</label><input id="${id}" class="sw" type="checkbox" role="switch" ${v ? 'checked' : ''}></div>`;
const opt = (a, v) => a.map(([k, label]) => `<option value="${k}" ${k == v ? 'selected' : ''}>${label}`).join('');

function openCfg() {
  const v = S.cfg, det = $('det');
  det.innerHTML = `<h3>${t('set.title')} <button style="float:right" onclick="det.close()">${mi('close')}</button></h3>
 <div oninput="upd()" onchange="chg(event)"><div class="box"><b>${t('set.general')}</b>
 ${chk('lg', t('set.login'), v.login)}
 ${chk('tray', t('set.tray'), v.tray)}
 <div class="f"><div class="f row"><label>${t('set.lang')}</label></div><span class="sel"><select id="lang">${opt(Object.keys(LOCALES).map(k => [k, LOCALES[k]._name]), v.lang)}</select>${caret}</span></div>
 <div class="f"><div class="f row"><label>${t('set.theme')}</label></div><span class="sel"><select id="t">${opt([['system', t('theme.system')], ['light', t('theme.light')], ['dark', t('theme.dark')]], v.theme)}</select>${caret}</span></div>
 </div><div class="box"><b>${t('set.monitor')}</b>
 ${chk('em', t('set.ext'), v.extMon)}
 <div class="f"><div class="f row"><label>${t('set.extPort')}</label></div><input id="mport" type="number" min="1024" max="65535" value="${v.monPort}"></div>
 <div class="f"><div class="f row"><label>${t('set.interval')}</label></div><span class="sel"><select id="iv">${opt([1, 3, 5, 10].map(n => [n, t('sec.n', { n })]), v.interval)}</select>${caret}</span></div>
 </div><div class="box"><b>${t('new.server')}</b>
 <div class="f"><div class="f row"><label>${t('set.exe')}</label></div><span class="pr"><input id="ex" value="${esc(v.exe)}" placeholder="${t('set.exePh')}"><button type="button" onclick="browse('ex')">${t('set.browse')}</button></span></div>
 <div class="f"><div class="f row"><label>${t('set.models')}</label></div><span class="pr"><input id="mp" value="${esc(v.modelsPath)}" placeholder="~/.ollama/models"><button type="button" onclick="browse('mp')">${t('set.browse')}</button></span></div>
 </div><div class="box"><b>${t('set.update')}</b>
 <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px"><span class="sub">${t('set.ver', { v: 'v' + (S.info?.version ?? '?') })}</span></div>
 </div></div> <div class="btns" style="justify-content:flex-end;margin-top:12px"><button onclick="resetCfg()">${t('set.reset')}</button><button class="primary" onclick="save()">${t('set.save')}</button></div>`;
  if (!det.open) det.showModal();
}

// Reads the form into S.cfg and applies it right away (theme, language); saving happens on `change`.
function upd() {
  const lc = $('lang').value !== S.cfg.lang;
  Object.assign(S.cfg, {
    lang: $('lang').value, theme: $('t').value, login: $('lg').checked, tray: $('tray').checked, interval: +$('iv').value,
    extMon: $('em').checked, monPort: +$('mport').value || DEF.monPort, exe: $('ex').value, modelsPath: $('mp').value,
  });
  apply();
  if (lc) openCfg();
}

async function chg(e) {
  const id = e.target.id, p = S.cfg.monPort;
  if (id === 'mport' || id === 'em') {
    const bad = !(p >= 1024 && p <= 65535) ? [t('v.port.t'), t('v.port.m')] : S.raw.some(i => i.port === p) ? [t('port.conflict'), t('sv.portMsg', { p })] : null;
    if (S.cfg.extMon && bad) { await notify('warn', ...bad); return revertCfg(); }
  }
  const patch = {};
  for (const k in KEYMAP) if (S.cfg[k] !== S.saved[k]) patch[KEYMAP[k]] = cfgToApi(k, S.cfg[k]);
  if (!Object.keys(patch).length) return;
  try {
    S.cfg = cfgFromApi(await API.put('/settings', patch));
    S.saved = { ...S.cfg };
  } catch (err) { await fail(err); return revertCfg(); }
  window.omm?.settingsChanged?.(S.saved);
  if (id === 'mport' || id === 'em') {
    S.info = await API.get('/info').catch(() => S.info);
    const x = S.info?.external_monitoring;
    if (x?.enabled && !x.active) notify('warn', t('ext.title'), x.error || '');
    syncSrv(); renderSum();
  }
  if ((id === 'ex' || id === 'mp') && view().some(i => i.state === 'running' || i.state === 'starting')) notify('info', t('rr.t'), t('rr.m'));
}
function revertCfg() { S.cfg = { ...S.saved }; apply(); openCfg(); }

async function resetCfg() {
  if (!await ask(t('rst.title'), t('rst.msg'), t('rst.ok'), true)) return;
  const patch = {};
  for (const k in KEYMAP) patch[KEYMAP[k]] = k === 'lang' ? null : cfgToApi(k, DEF[k]);
  try { S.cfg = cfgFromApi(await API.put('/settings', patch)); S.saved = { ...S.cfg }; } catch (err) { await fail(err); return; }
  window.omm?.settingsChanged?.(S.saved);
  log('Settings reset to defaults');
  apply(); openCfg();
}
function save() { log('Settings saved'); $('det').close(); }  // every change is already stored; this just closes the window

async function browse(id) {
  let v;
  if (window.omm?.pickPath) v = await window.omm.pickPath(id === 'ex' ? 'file' : 'dir');
  else v = window.prompt(t('set.browse'), $(id).value);
  if (v == null || v === '') return;
  $(id).value = v;
  $(id).dispatchEvent(new Event('input', { bubbles: true }));
  $(id).dispatchEvent(new Event('change', { bubbles: true }));
  log(`Path selected: ${v}`);
}

// ---------------------------------------------------------------- models
const modelInfo = tag => {
  const p = tag.match(/(?:^|[-:])(\d+(?:\.\d+)?)b(?=-|$)/i), q = tag.match(/(q\d+(?:_[a-z0-9]+)*|nvfp\d+|fp\d+|bf\d+)/i);
  return t('mdl.param', { p: p ? p[1] + 'B' : '-', q: q ? q[1].toUpperCase() : '-' });
};
const dls = () => Object.values(S.pulls).filter(x => x.status !== 'success').sort((a, b) => a.started_at - b.started_at);

function dlCard(d, tg) {
  const off = d.status !== 'pulling';
  return `<div class="card mc" id="dl-${d.id}" data-s="${d.status}"><div class="top" style="margin:0"><b class="tag">${esc(tg)}</b><span class="sub" data-t>${dlText(d)}</span></div>
  <div class="mi"><div class="dl${off ? ' off' : ''}"><i style="width:${d.percent ?? 0}%"></i></div></div><div class="btns" style="justify-content:space-between"><button class="small" onclick="${off ? 'resumeDl' : 'pauseDl'}('${d.id}')">${t(off ? 'btn.resume' : 'btn.pause')}</button><button class="small" onclick="delDl('${d.id}')">${t('btn.delete')}</button></div></div>`;
}
const dlText = d => {
  const pct = `${Math.floor(d.percent ?? 0)}%`, size = d.total ? ` · ${gb(d.completed).toFixed(1)} / ${gb(d.total).toFixed(1)} GB` : '';
  return d.status === 'paused' ? `${t('mdl.paused')} · ${pct}${size}` : d.status === 'error' ? `${t('mdl.failed')} · ${pct}${size}` : pct + size;
};

function modelGroups() {
  const g = {};
  dls().forEach(d => (g[d.model.split(':')[0]] ??= []).push({ d, tg: d.model.slice(d.model.split(':')[0].length + 1) }));
  S.modelList.forEach(m => (g[m.name.split(':')[0]] ??= []).push({ m }));
  const c = Object.entries(g).map(([f, a]) => `<div class="cat mg"><b>${esc(f)}</b>${a.map(({ m, d, tg }) => {
    if (d) return dlCard(d, tg);
    tg = m.name.slice(f.length + 1);
    return `<div class="card mc"><div class="top" style="margin:0"><b class="tag">${esc(tg)}</b><span class="sub">${gb(m.size).toFixed(1)} GB</span></div>
  <div class="sub mi"><span>${modelInfo(tg)}</span></div><div class="btns" style="justify-content:space-between"><a class="btn small" href="https://ollama.com/library/${encodeURI(m.name)}" target="_blank" rel="noopener noreferrer" aria-label="${t('mdl.library')}" title="${t('mdl.library')}">${mi('open_in_new')}</a><button class="small" data-m="${esc(m.name)}" onclick="delModel(this.dataset.m)">${t('btn.delete')}</button></div></div>`;
  }).join('')}</div>`).join('');
  return `<div class="box" style="margin-top:12px">${c || `<div class="sub">${t('mdl.none')}</div>`}</div>`;
}
const modelStats = () => t('mdl.stats', { path: S.cfg.modelsPath || '~/.ollama/models', n: S.modelList.length, gb: gb(S.modelList.reduce((a, m) => a + m.size, 0)).toFixed(1) });

async function loadModels() {
  try { S.modelList = await API.get('/models'); } catch (e) { S.modelList = []; await fail(e); }
}
// Builds the whole window from S.modelList and S.pulls; the typed model name and the scroll position survive a rebuild.
function renderModels() {
  const keep = $('pn')?.value ?? '', top = $('det').scrollTop;
  $('det').innerHTML = `<h3 id="mdl">${t('hdr.models')} <button style="float:right" onclick="det.close()">${mi('close')}</button></h3>
 <div class="f"><div class="f row"><label>${t('mdl.download')}</label></div><div class="pr"><input id="pn" spellcheck="false" placeholder="${t('mdl.dlPh')}"><button onclick="pull()">${t('mdl.download')}</button></div></div>
 <div class="sub" id="pg" style="min-height:16px">${modelStats()}</div>
 ${modelGroups()}`;
  $('pn').value = keep;
  if (!$('det').open) $('det').showModal();
  $('det').scrollTop = top;
}
async function openModels() {
  await loadModels();
  renderModels();
}

async function pull() {
  let n = $('pn').value.trim();
  if (n && !n.includes(':')) n += ':latest';
  if (!n || S.modelList.some(m => m.name === n)) { notify('warn', t(n ? 'mdl.dup.title' : 'mdl.empty.title'), t(n ? 'mdl.dup.msg' : 'mdl.empty.msg', { n })); return; }
  try {
    const task = await API.post('/models/pull', { model: n });
    S.pulls[task.id] = task;
    $('pn').value = '';
    renderModels();
  } catch (e) { await fail(e); }
}
const dlAct = async (id, act) => {
  if (id === 'fake') { S.pulls.fake.status = act === 'pause' ? 'paused' : 'pulling'; renderModels(); return; }  // developer-mode card: local only
  try { S.pulls[id] = await API.post(`/pulls/${id}/${act}`); renderModels(); } catch (e) { await fail(e); }
};
const pauseDl = id => dlAct(id, 'pause');
const resumeDl = id => dlAct(id, 'resume');
async function delDl(id) {
  const d = S.pulls[id];
  if (!d || !await ask(t('mdl.dl.del.title'), t('mdl.dl.del.msg', { n: d.model }), t('btn.delete'), true)) return;
  try { if (id !== 'fake') await API.del(`/pulls/${id}`); delete S.pulls[id]; log(`Deleted download ${d.model}`); } catch (e) { await fail(e); }
  renderModels();
}
// Pushed by the backend: progress ticks update the bar in place; a change of state rebuilds the window.
async function onPull(task) {
  const prev = S.pulls[task.id];
  S.pulls[task.id] = task;
  if (task.status === 'error' && prev?.status === 'pulling') notify('error', t('err.title'), `${task.model}: ${task.error}`);
  if (task.status === 'success' && prev?.status === 'pulling') log(`Pulled model ${task.model}`);
  if (!$('mdl')) return;  // another window is showing
  if (task.status === 'success') { await loadModels(); renderModels(); return; }
  const card = $(`dl-${task.id}`);
  if (!card || card.dataset.s !== task.status) { renderModels(); return; }
  card.querySelector('.dl i').style.width = `${task.percent ?? 0}%`;
  card.querySelector('[data-t]').textContent = dlText(task);
}
async function delModel(n) {
  if (!await ask(t('mdl.del.title'), t('mdl.del.msg', { n }), t('btn.delete'), true)) return;
  try { await API.del(`/models/${encodeURI(n)}`); log(`Deleted model ${n}`); } catch (e) { await fail(e); }
  await openModels();
}

// ---------------------------------------------------------------- header, static text, theme
const copyText = async (txt, el, msg) => {
  try { await navigator.clipboard.writeText(txt); } catch {
    const a = document.createElement('textarea'); a.value = txt; document.body.append(a); a.select(); document.execCommand('copy'); a.remove();
  }
  log(msg); el.classList.add('pressed'); setTimeout(() => el.classList.remove('pressed'), 150);
};
function syncSrv() {
  const srv = $('srv'), x = S.info?.external_monitoring;
  srv.style.display = x?.active ? '' : 'none';
  if (!x?.active) return;
  const a = `http://${S.info.lan_ip}:${x.port}`;
  srv.querySelector('code').textContent = a;
  srv.title = t('srv.title', { a });
}
function applyStatic() {
  document.title = t('app.title');
  document.documentElement.lang = S.cfg.lang;
  document.querySelectorAll('[data-i]').forEach(e => e.textContent = t(e.dataset.i));
  document.querySelectorAll('[data-i-title]').forEach(e => e.title = t(e.dataset.iTitle));
  document.querySelectorAll('[data-i-aria]').forEach(e => e.setAttribute('aria-label', t(e.dataset.iAria)));
  document.querySelectorAll('main > section').forEach(secLbl);
}
function apply() { document.documentElement.dataset.theme = S.cfg.theme; applyStatic(); syncSrv(); render(); renderLogs(); }

// ---------------------------------------------------------------- sections, dialogs (layout behaviour)
document.querySelectorAll('dialog').forEach(d => {
  const out = e => { const r = d.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
  let down = false;
  d.addEventListener('mousedown', e => down = e.target === d && out(e));
  d.addEventListener('click', e => { if (down && e.target === d && out(e)) d.close(); down = false; });
});
const secLbl = s => {
  const b = s.querySelector('.tog'), h = t(s.classList.contains('off') ? 'sec.show' : 'sec.hide');
  b.title = h; b.setAttribute('aria-label', `${t('sec.' + s.dataset.t)} ${h}`);
};
document.querySelectorAll('main > section').forEach(s => {
  const w = document.createElement('div'), i = document.createElement('div');
  w.className = 'body'; i.append(...s.children); w.append(i); s.append(w);
  s.insertAdjacentHTML('afterbegin', `<div class="sh"><h3 data-i="sec.${s.dataset.t}"></h3><button class="tog">${mi('expand_more')}</button></div>`);
  const b = s.querySelector('.tog'), c = { sum: 'utabs', mon: 'mtabs', logs: 'ltabs', inst: 'stabs' }[s.dataset.t];
  if (c) b.before($(c));
  b.onclick = () => { s.classList.toggle('off'); secLbl(s); };
});
{
  const srv = $('srv'), copyAddr = () => copyText(srv.querySelector('code').textContent, srv, 'Serving address copied');
  srv.onclick = copyAddr;
  srv.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyAddr(); } };
}

// ---------------------------------------------------------------- data loading & live updates
let instTimer = 0;
async function loadInstances() { try { S.raw = await API.get('/instances'); } catch (e) { return fail(e); } render(); }
const loadInstancesSoon = () => { clearTimeout(instTimer); instTimer = setTimeout(loadInstances, 100); };

async function loadAll() {
  const [settings, info, instances, logs, pulls] = await Promise.all([
    API.get('/settings'), API.get('/info'), API.get('/instances'), API.get('/logs?limit=500'), API.get('/pulls'),
  ]);
  S.cfg = cfgFromApi(settings); S.saved = { ...S.cfg }; S.info = info; S.raw = instances;
  S.pulls = Object.fromEntries(pulls.map(x => [x.id, x]));
  if (DEV) S.pulls.fake = { id: 'fake', model: 'fake-model:7b-q4_K_M', status: 'pulling', percent: 40, completed: 2.8 * GiB, total: 7 * GiB, started_at: 0 };
  S.snap = await API.get('/monitor/snapshot').catch(() => null);
  S.logs = logs.map(e => ({ ts: e.ts * 1000, src: nameOf(e.instance), m: e.msg, level: e.level }));
  $('ver').textContent = 'ollama-multi-manager v' + info.version;
  apply();
}

// Developer aid (context menu in OMM_DEV mode): stop the page from redrawing on pushed updates so styles can be
// inspected. Data keeps arriving and is applied in one go on resume.
function setFrozen(on) {
  S.frozen = !!on;
  if (S.frozen) { $('status').textContent = 'Updates paused (developer mode)'; return; }
  const last = S.logs.at(-1);
  if (last) $('status').textContent = `[${hms(last.ts)}] ${last.m}`;
  loadInstances(); renderLogs(); if ($('mdl')) openModels();
}

function onMessage(m) {
  switch (m.type) {
    case 'metrics': S.snap = m.data; if (!S.frozen) { render(); refreshRequests(); } break;
    case 'instance': if (!S.frozen) loadInstancesSoon(); break;
    case 'log': fromBackendLog(m); break;
    case 'pull': if (S.frozen) S.pulls[m.task.id] = m.task; else onPull(m.task); break;
    case 'pull_removed': delete S.pulls[m.id]; if (!S.frozen && $('mdl')) renderModels(); break;
  }
}

let first = true;
async function onConnection(up) {
  S.connected = up;
  if (!up) { $('status').textContent = t('conn.lost'); return; }
  try { await loadAll(); if (first) log('Connected to backend'); else log('Reconnected to backend'); first = false; } catch (e) { $('status').textContent = e.message; }
}

apply();                       // static text and theme first, so the page is readable before data arrives
API.connect(onMessage, onConnection);
