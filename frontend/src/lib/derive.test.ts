import { describe, expect, it } from 'vitest';
import type { GpuDevice, Instance, InstanceMetrics, Perf, Snapshot } from '@/api/types';
import { GiB } from './units';
import { buildViews, perfAll, sortViews, vramByGpu } from './derive';

const options = {
  gpu: 'auto', context_length: 4096, keep_alive_min: 5, max_loaded_models: 1, num_parallel: 1, flash_attention: false,
  kv_cache_type: 'f16', models_path: null, listen: 'local', auto_start: false, idle_stop_min: 0, api_key: null, save_requests: false,
} as const;

const instance = (id: number, name: string, port: number, state: Instance['status']['state'] = 'running'): Instance => ({
  id, name, port, options: { ...options }, desired_state: 'running', status: { state, pid: 100 + id, started_at: 1 },
});

const metrics = (over: Partial<InstanceMetrics> = {}): InstanceMetrics => ({
  state: 'running', pid: 1, responsive: true, cpu_percent: 0, rss: 0, vram_bytes: null, vram_by_gpu: {}, vram_source: null, gpu_util_by_gpu: null, models: [], perf: null, ...over,
});

const snapshot = (instances: Record<string, InstanceMetrics>, devices: GpuDevice[] = []): Snapshot => ({
  ts: 1, system: { cpu_percent: 1, cpu_count: 4, mem_total: 8 * GiB, mem_used: 4 * GiB, disk_total: null, disk_used: null },
  gpu: { provider: 'fake', devices }, instances, external: null,
});

const gpu = (index: number, used: number, total: number): GpuDevice => ({ index, uuid: `u${index}`, name: `GPU ${index}`, mem_total: total * GiB, mem_used: used * GiB, util_percent: null, temperature_c: null,
  vendor: 'nvidia', kind: 'gpu', unified: false, env_index: index, supports: { mem: true, util: true, temp: true, process: true, process_util: true } });

describe('buildViews', () => {
  it('marks a running instance that does not answer as unreachable', () => {
    const views = buildViews([instance(1, 'a', 11435), instance(2, 'b', 11436)], snapshot({ '1': metrics({ responsive: false }), '2': metrics() }));
    expect(views.map((v) => v.state)).toEqual(['unreachable', 'running']);
  });

  it('keeps the stored state when there is no snapshot yet', () => {
    expect(buildViews([instance(1, 'a', 11435, 'stopped')], null)[0]?.state).toBe('stopped');
  });

  it('lists the loaded models with their VRAM size, falling back to the size', () => {
    const loaded = [{ name: 'm1', size: 4 * GiB, size_vram: 2 * GiB, expires_at: null }, { name: 'm2', size: GiB, size_vram: 0, expires_at: null }];
    const v = buildViews([instance(1, 'a', 11435)], snapshot({ '1': metrics({ models: loaded }) }))[0];
    expect(v?.loaded.map((m) => m.gb)).toEqual([2, 1]);
  });
});

describe('sortViews', () => {
  const views = buildViews([instance(1, 'worker-10', 11437, 'stopped'), instance(2, 'worker-2', 11435), instance(3, 'worker-1', 11436, 'crashed')], null);
  it('sorts names naturally (2 before 10)', () => {
    expect(sortViews(views, 'name', 1).map((v) => v.name)).toEqual(['worker-1', 'worker-2', 'worker-10']);
    expect(sortViews(views, 'name', -1).map((v) => v.name)).toEqual(['worker-10', 'worker-2', 'worker-1']);
  });
  it('sorts by port and by state (running first)', () => {
    expect(sortViews(views, 'port', 1).map((v) => v.port)).toEqual([11435, 11436, 11437]);
    expect(sortViews(views, 'state', 1).map((v) => v.state)).toEqual(['running', 'stopped', 'crashed']);
  });
});

describe('vramByGpu', () => {
  it('splits an NVML reading by GPU', () => {
    const views = buildViews([instance(1, 'a', 11435)], snapshot({ '1': metrics({ vram_source: 'nvml', vram_by_gpu: { '0': 2 * GiB, '1': 1 * GiB } }) }));
    const usage = vramByGpu(views, [gpu(0, 6, 8), gpu(1, 1, 8)]);
    expect(usage.map((u) => u.parts.map((p) => p.v))).toEqual([[2], [1]]);
    expect(usage[0]?.pct).toBe(75);
  });

  it('puts an estimate on GPU-0 for "auto", on the chosen GPU otherwise, and not at all for CPU', () => {
    const estimated = (gpuOption: 'auto' | 'cpu' | number) => {
      const inst = instance(1, 'a', 11435);
      inst.options.gpu = gpuOption;
      const views = buildViews([inst], snapshot({ '1': metrics({ vram_source: 'estimated', vram_bytes: 3 * GiB }) }));
      return vramByGpu(views, [gpu(0, 3, 8), gpu(1, 0, 8)]).map((u) => u.parts.length);
    };
    expect(estimated('auto')).toEqual([1, 0]);
    expect(estimated(1)).toEqual([0, 1]);
    expect(estimated('cpu')).toEqual([0, 0]);
  });
});

describe('perfAll', () => {
  const perf = (over: Partial<Perf>): Perf => ({
    inflight: 0, queued: 0, processing: 0, requests: 0, requests_total: 0, errors: 0, errors_total: 0, cancelled: 0, models: {},
    latency_avg: null, ttft_avg: null, prompt_tokens: 0, tokens_total: 0, prompt_tokens_total: 0, tokens: 0, eval_seconds: 0,
    tok_per_s: null, window_seconds: 300, ...over,
  });

  it('is null when no instance reports numbers', () => {
    expect(perfAll(null)).toBeNull();
    expect(perfAll(snapshot({ '1': metrics() }))).toBeNull();
  });

  it('adds the instances up, weighting the response time by request count and the speed by time', () => {
    const snap = snapshot({
      '1': metrics({ perf: perf({ processing: 1, queued: 2, requests: 1, latency_avg: 1, tokens: 100, eval_seconds: 5, errors: 1 }) }),
      '2': metrics({ perf: perf({ processing: 2, requests: 3, latency_avg: 3, tokens: 100, eval_seconds: 5 }) }),
    });
    expect(perfAll(snap)).toEqual({ processing: 3, queued: 2, latency: 2.5, speed: 20, errors: 1, requests: 4 });
  });
});
