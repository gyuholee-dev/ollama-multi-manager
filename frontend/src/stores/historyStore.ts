import { create } from 'zustand';
import type { InstanceSample, Snapshot } from '@/api/types';
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
  /** Puts readings the backend kept before this page was open in front of the ones collected here. */
  seed: (id: string, samples: InstanceSample[]) => void;
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
  seed: (id, samples) => {
    const older = samples.map((x): Sample => ({ ts: x.ts * 1000, cpu: x.cpu, rss: gb(x.rss), vram: x.vram != null ? gb(x.vram) : null, processing: x.processing, queued: x.queued }));
    const mine = get().series[id] ?? [];
    const first = mine[0]?.ts ?? Infinity;
    set({ series: { ...get().series, [id]: [...older.filter((x) => x.ts < first), ...mine].slice(-MAX_SAMPLES) } });
  },
}));
