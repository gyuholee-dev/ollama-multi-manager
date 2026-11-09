import { beforeEach, describe, expect, it } from 'vitest';
import type { InstanceMetrics, Snapshot } from '@/api/types';
import { MAX_SAMPLES, useHistoryStore } from './historyStore';

const metrics = (cpu: number, rss: number, vram: number | null): InstanceMetrics => ({
  state: 'running', pid: 1, responsive: true, cpu_percent: cpu, rss, vram_bytes: vram, vram_by_gpu: {}, vram_source: null, gpu_util_by_gpu: null, models: [],
  perf: { inflight: 1, queued: 2, processing: 1, requests: 0, requests_total: 0, errors: 0, errors_total: 0, cancelled: 0, models: {}, latency_avg: null, ttft_avg: null, prompt_tokens: 0, tokens_total: 0, prompt_tokens_total: 0, tokens: 0, eval_seconds: 0, tok_per_s: null, window_seconds: 300 },
});
const snap = (ts: number, instances: Record<string, InstanceMetrics>): Snapshot => ({
  ts, system: { cpu_percent: 0, cpu_count: 4, mem_total: 1, mem_used: 1, disk_total: null, disk_used: null }, gpu: { provider: 'fake', devices: [] }, instances, external: null,
});

describe('history store', () => {
  beforeEach(() => useHistoryStore.setState({ series: {} }));

  it('keeps one reading per snapshot, cpu as a share of the whole machine', () => {
    useHistoryStore.getState().push(snap(10, { '1': metrics(200, 2 ** 30, 2 ** 30) }));
    expect(useHistoryStore.getState().series['1']).toEqual([{ ts: 10000, cpu: 50, rss: 1, vram: 1, processing: 1, queued: 2 }]);
  });

  it('forgets instances that are gone and caps the length', () => {
    for (let k = 0; k < MAX_SAMPLES + 5; k++) useHistoryStore.getState().push(snap(k, { '1': metrics(0, 0, null), '2': metrics(0, 0, null) }));
    expect(useHistoryStore.getState().series['1']).toHaveLength(MAX_SAMPLES);
    useHistoryStore.getState().push(snap(999, { '1': metrics(0, 0, null) }));
    expect(useHistoryStore.getState().series['2']).toBeUndefined();
  });

  it('puts readings the backend kept in front of the ones collected here', () => {
    useHistoryStore.getState().push(snap(100, { '1': metrics(0, 2 ** 30, null) }));
    useHistoryStore.getState().seed('1', [
      { ts: 90, cpu: 5, rss: 2 ** 30, vram: null, processing: 0, queued: 0 },
      { ts: 99, cpu: 6, rss: 2 ** 30, vram: 2 ** 30, processing: 1, queued: 0 },
      { ts: 100, cpu: 7, rss: 2 ** 30, vram: null, processing: 0, queued: 0 }, // already here: not doubled
    ]);
    const series = useHistoryStore.getState().series['1'] ?? [];
    expect(series.map((x) => x.ts)).toEqual([90000, 99000, 100000]);
    expect(series[1]).toMatchObject({ cpu: 6, vram: 1, processing: 1 });
  });
});
