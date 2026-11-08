import { create } from 'zustand';
import type { Snapshot } from '@/api/types';
import { gb } from '@/lib/units';

/** One reading of a running instance, taken from a snapshot. */
export interface Sample {
  ts: number; // ms
  cpu: number; // % of the whole machine
  rss: number; // GiB
  vram: number | null; // GiB
  processing: number;
  queued: number;
}

/** Enough for about 12 minutes at the default refresh interval. */
export const MAX_SAMPLES = 240;

interface HistoryState {
  series: Record<string, Sample[]>;
  push: (snap: Snapshot) => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  series: {},
  push: (snap) => {
    const cores = snap.system.cpu_count || 1;
    const next: Record<string, Sample[]> = {};
    for (const [id, m] of Object.entries(snap.instances)) {
      const sample: Sample = {
        ts: snap.ts * 1000, cpu: m.cpu_percent / cores, rss: gb(m.rss), vram: m.vram_bytes != null ? gb(m.vram_bytes) : null,
        processing: m.perf?.processing ?? 0, queued: m.perf?.queued ?? 0,
      };
      next[id] = [...(get().series[id] ?? []), sample].slice(-MAX_SAMPLES); // instances that are gone drop out here
    }
    set({ series: next });
  },
}));
