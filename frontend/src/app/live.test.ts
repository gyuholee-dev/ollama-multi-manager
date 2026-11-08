import { beforeEach, describe, expect, it } from 'vitest';
import type { PullTask, Snapshot } from '@/api/types';
import { useLogStore } from '@/stores/logStore';
import { useMonitorStore } from '@/stores/monitorStore';
import { usePullStore } from '@/stores/pullStore';
import { useUiStore } from '@/stores/uiStore';
import { pushLog, pushPull, pushPullRemoved, pushSnapshot, setFrozen } from './live';

const snap = (ts: number) => ({ ts } as Snapshot);
const pull = (id: string, status: PullTask['status']) => ({ id, model: id, status } as PullTask);
const line = (m: string, ts = 1000) => ({ ts, src: 'app', m, level: 'info' as const });

beforeEach(() => {
  setFrozen(false);
  useMonitorStore.setState({ snap: null });
  useLogStore.getState().set([]);
  usePullStore.getState().setAll([]);
  useUiStore.setState({ status: '' });
});

describe('live updates', () => {
  it('applies pushed data right away when not frozen', () => {
    pushSnapshot(snap(1));
    pushLog(line('hello'));
    pushPull(pull('a', 'pulling'));
    expect(useMonitorStore.getState().snap?.ts).toBe(1);
    expect(useLogStore.getState().lines.map((l) => l.m)).toEqual(['hello']);
    expect(useUiStore.getState().status).toContain('hello');
    expect(usePullStore.getState().tasks.a?.status).toBe('pulling');
  });

  it('holds everything back while frozen and applies it once on resume', () => {
    setFrozen(true);
    expect(useUiStore.getState().status).toMatch(/paused/i);
    pushSnapshot(snap(1));
    pushSnapshot(snap(2));
    pushLog(line('one'));
    pushLog(line('two', 2000));
    pushPull(pull('a', 'pulling'));
    pushPull(pull('a', 'paused'));
    pushPull(pull('b', 'pulling'));
    pushPullRemoved('b');
    expect(useMonitorStore.getState().snap).toBeNull();
    expect(useLogStore.getState().lines).toEqual([]);
    expect(usePullStore.getState().tasks).toEqual({});

    setFrozen(false);
    expect(useMonitorStore.getState().snap?.ts).toBe(2); // only the latest snapshot matters
    expect(useLogStore.getState().lines.map((l) => l.m)).toEqual(['one', 'two']);
    expect(usePullStore.getState().tasks.a?.status).toBe('paused'); // the latest state of the task
    expect(usePullStore.getState().tasks.b).toBeUndefined(); // removed while frozen: never shows up
    expect(useUiStore.getState().status).toContain('two'); // the footer shows the newest line again
  });
});
