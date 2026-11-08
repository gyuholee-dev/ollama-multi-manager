import type { GpuDevice, Instance, InstanceMetrics, InstanceState, LoadedModel, Perf, Snapshot } from '@/api/types';
import { gb } from './units';

export interface LoadedView {
  name: string;
  gb: number;
  exp: string | null;
}

/** An instance as the screens want it: the stored record plus what the latest snapshot says about it. */
export interface InstanceView {
  id: number;
  name: string;
  port: number;
  state: InstanceState;
  pid: number | null;
  startedAt: number; // ms
  ctx: number;
  keep: number;
  maxLoaded: number;
  parallel: number;
  gpu: 'auto' | 'cpu' | number;
  flash: boolean;
  kvq: string;
  listen: 'local' | 'lan';
  key: string | null;
  auto: boolean;
  idle: number;
  loaded: LoadedView[];
  metrics?: InstanceMetrics;
}

const toLoaded = (m: LoadedModel): LoadedView => ({ name: m.name, gb: gb(m.size_vram || m.size), exp: m.expires_at });

export function buildViews(raw: Instance[], snap: Snapshot | null): InstanceView[] {
  return raw.map((i) => {
    const m = snap?.instances?.[String(i.id)];
    const o = i.options;
    let state: InstanceState = i.status.state;
    if (state === 'running' && m && !m.responsive) state = 'unreachable';
    return {
      id: i.id, name: i.name, port: i.port, state, pid: i.status.pid, startedAt: (i.status.started_at ?? 0) * 1000,
      ctx: o.context_length, keep: o.keep_alive_min, maxLoaded: o.max_loaded_models, parallel: o.num_parallel,
      gpu: o.gpu, flash: o.flash_attention, kvq: o.kv_cache_type, listen: o.listen, key: o.api_key, auto: o.auto_start, idle: o.idle_stop_min,
      loaded: (m?.models ?? []).map(toLoaded),
      metrics: m,
    };
  });
}

/** The user's own Ollama (default port) when it is running and is not one of ours; shown read-only. */
export interface ExternalView {
  port: number;
  keep: number;
  loaded: LoadedView[];
}
export const externalView = (snap: Snapshot | null): ExternalView | null =>
  snap?.external ? { port: snap.external.port, keep: 5, loaded: snap.external.models.map(toLoaded) } : null;

export const STATE_ORDER: InstanceState[] = ['running', 'starting', 'stopping', 'stopped', 'crashed', 'unreachable'];
export type SortKey = 'name' | 'port' | 'state';

const byName = (a: InstanceView, b: InstanceView) => a.name.localeCompare(b.name, undefined, { numeric: true });

export function sortViews(views: InstanceView[], key: SortKey, dir: 1 | -1): InstanceView[] {
  const order = (a: InstanceView, b: InstanceView) =>
    key === 'state' ? STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) : key === 'port' ? a.port - b.port : byName(a, b);
  return [...views].sort((a, b) => dir * order(a, b) || byName(a, b));
}

/** One colour per instance in the VRAM bars. */
export const instanceColor = (n: number): string => `hsl(${n * 70 + 210} 60% 55%)`;

export interface VramPart {
  name: string;
  v: number; // GiB
  col: string;
}
export interface GpuUsage {
  device: GpuDevice;
  parts: VramPart[];
  used: number;
  total: number;
  pct: number;
}

/** VRAM per GPU, split by instance. Exact when NVML says so, else the instance's own estimate on the GPU it most likely uses. */
export function vramByGpu(views: InstanceView[], devices: GpuDevice[]): GpuUsage[] {
  return devices.map((device) => {
    const parts: VramPart[] = [];
    views.forEach((i, n) => {
      const m = i.metrics;
      if (!m) return;
      let bytes = 0;
      if (m.vram_source === 'nvml') bytes = m.vram_by_gpu?.[String(device.index)] ?? 0;
      else if (m.vram_source === 'estimated' && i.gpu !== 'cpu' && (i.gpu === device.index || (i.gpu === 'auto' && device.index === 0))) bytes = m.vram_bytes ?? 0;
      if (bytes > 0) parts.push({ name: i.name, v: gb(bytes), col: instanceColor(n) });
    });
    const used = gb(device.mem_used);
    const total = gb(device.mem_total);
    return { device, parts, used, total, pct: total ? Math.round((used / total) * 100) : 0 };
  });
}

export interface PerfTotals {
  processing: number;
  queued: number;
  latency: number | null;
  speed: number | null;
  errors: number;
  requests: number;
}

/** Request numbers measured by the instances' proxies, added up over every running instance (last 5 minutes). */
export function perfAll(snap: Snapshot | null): PerfTotals | null {
  const ps = Object.values(snap?.instances ?? {}).map((i) => i.perf).filter((p): p is Perf => !!p);
  if (!ps.length) return null;
  const sum = (pick: (p: Perf) => number) => ps.reduce((a, p) => a + pick(p), 0);
  const requests = sum((p) => p.requests);
  const evalSeconds = sum((p) => p.eval_seconds);
  const latencySum = ps.reduce((a, p) => a + (p.latency_avg != null ? p.latency_avg * p.requests : 0), 0);
  return {
    processing: sum((p) => p.processing),
    queued: sum((p) => p.queued),
    latency: requests && latencySum ? latencySum / requests : null,
    speed: evalSeconds > 0 ? sum((p) => p.tokens) / evalSeconds : null,
    errors: sum((p) => p.errors),
    requests,
  };
}
