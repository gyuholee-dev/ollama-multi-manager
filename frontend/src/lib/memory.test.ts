import { describe, expect, it } from 'vitest';
import type { GpuDevice, SystemStats } from '@/api/types';
import { modelNeed, unifiedRoom } from './memory';

const GiB = 2 ** 30;
const dev = (over: Partial<GpuDevice>): GpuDevice => ({
  index: 0, uuid: 'u', name: 'GPU', mem_total: 17.8 * GiB, mem_used: 0.7 * GiB, util_percent: null, temperature_c: null,
  vendor: 'apple', kind: 'gpu', unified: true, env_index: 0, supports: { mem: true, util: true, temp: true, process: false, process_util: false }, ...over,
});
const system = (used: number): SystemStats => ({ cpu_percent: 0, cpu_count: 12, mem_total: 24 * GiB, mem_used: used * GiB, disk_total: null, disk_used: null });

describe('modelNeed', () => {
  const installed = [{ name: 'a:8b', size: 5 * GiB }, { name: 'b:7b', size: 4 * GiB }, { name: 'c:3b', size: 2 * GiB }];
  it('adds up the biggest models that can sit in memory together', () => {
    expect(modelNeed(installed, ['a:8b', 'b:7b', 'c:3b'], 2)).toBe(9);
    expect(modelNeed(installed, ['b:7b', 'c:3b'], 1)).toBe(4);
  });
  it('counts every installed model when none is selected', () => {
    expect(modelNeed(installed, [], 3)).toBe(11);
    expect(modelNeed([], [], 3)).toBe(0);
  });
});

describe('unifiedRoom', () => {
  it('is the pool\'s free part when that is less than what is left under the GPU maximum', () => {
    const r = unifiedRoom([dev({})], 'auto', system(12.9))!;
    expect(r.avail).toBeCloseTo(11.1);
    expect(r.room).toBeCloseTo(17.1);
    expect(r.cap).toBeCloseTo(11.1);
  });
  it('is what is left under the GPU maximum when that is less', () => {
    const r = unifiedRoom([dev({ mem_used: 10 * GiB })], 0, system(3))!;
    expect(r.avail).toBeCloseTo(21);
    expect(r.room).toBeCloseTo(7.8);
    expect(r.cap).toBeCloseTo(7.8);
  });
  it('uses the whole pool for an instance that runs on the CPU, and none of the GPU numbers', () => {
    const r = unifiedRoom([dev({})], 'cpu', system(12.9))!;
    expect(r).toEqual({ cap: expect.closeTo(11.1), avail: expect.closeTo(11.1), room: null });
  });
  it('is not there where memory is not shared or cannot be read', () => {
    expect(unifiedRoom([dev({ unified: false })], 'auto', system(1))).toBeNull();
    expect(unifiedRoom([dev({ supports: { mem: false, util: false, temp: false, process: false, process_util: false } })], 'auto', system(1))).toBeNull();
    expect(unifiedRoom([], 'auto', system(1))).toBeNull();
    expect(unifiedRoom([dev({}), dev({ index: 1, unified: false })], 'cpu', system(1))).toBeNull();
    expect(unifiedRoom([dev({})], 'auto', undefined)).toBeNull();
    expect(unifiedRoom([dev({}), dev({ index: 1, unified: false })], 1, system(1))).toBeNull();
  });
});
