import type { GpuDevice, SystemStats } from '@/api/types';
import { normModel } from './format';
import { gb } from './units';

/** The memory (GiB) an instance needs when the biggest models it may hold at once are loaded together. An empty `allowed` means every installed model. */
export function modelNeed(installed: { name: string; size: number }[], allowed: string[], maxLoaded: number): number {
  const sizes = installed
    .filter((m) => !allowed.length || allowed.some((a) => normModel(a) === normModel(m.name)))
    .map((m) => gb(m.size))
    .sort((x, y) => y - x);
  return sizes.slice(0, maxLoaded).reduce((a, x) => a + x, 0);
}

/** What a new load can really get on a machine whose memory is shared between the CPU and the GPU (GiB). */
export interface UnifiedRoom {
  cap: number; // the least of the two limits below: what the models can really use now
  avail: number; // what is left of the whole pool
  room: number | null; // what is left of the GPU's own maximum (null for an instance that runs on the CPU)
}

/**
 * How much memory an instance on `gpu` can use when memory is shared: the pool's available part, and for a GPU also
 * what is left under the GPU's maximum, whichever is less. null when memory is not shared there (the VRAM rules apply)
 * or cannot be read.
 */
export function unifiedRoom(devices: GpuDevice[], gpu: 'auto' | 'cpu' | number, system: SystemStats | undefined): UnifiedRoom | null {
  if (!system || !devices.length) return null;
  const avail = gb(Math.max(0, system.mem_total - system.mem_used));
  if (gpu === 'cpu') return devices.every((d) => d.unified) ? { cap: avail, avail, room: null } : null;
  const d = devices[gpu === 'auto' ? 0 : gpu];
  if (!d || !d.unified || !d.supports.mem) return null;
  const room = Math.max(0, gb(d.mem_total) - gb(d.mem_used));
  return { cap: Math.min(room, avail), avail, room };
}
