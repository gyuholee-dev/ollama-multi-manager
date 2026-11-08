// Applies what the backend pushes to the stores. In developer mode the updates can be held back ("frozen") so the
// page stays still while its styles are inspected: they pile up here and are applied in one go on resume.
import type { PullTask, Snapshot } from '@/api/types';
import { hms } from '@/lib/format';
import { useInstancesStore } from '@/stores/instancesStore';
import { useLogStore, type LogLine } from '@/stores/logStore';
import { useMonitorStore } from '@/stores/monitorStore';
import { usePullStore } from '@/stores/pullStore';
import { useUiStore } from '@/stores/uiStore';

interface Pending {
  snap: Snapshot | null;
  instancesChanged: boolean;
  logs: LogLine[];
  pulls: Map<string, PullTask>;
  removed: Set<string>;
}

const empty = (): Pending => ({ snap: null, instancesChanged: false, logs: [], pulls: new Map(), removed: new Set() });
let pending = empty();

export const isFrozen = (): boolean => useUiStore.getState().frozen;

function showLog(line: LogLine): void {
  useLogStore.getState().add(line);
  useUiStore.getState().setStatus(`[${hms(line.ts)}] ${line.m}`);
}

export function pushLog(line: LogLine): void {
  if (isFrozen()) pending.logs.push(line);
  else showLog(line);
}

export function pushSnapshot(snap: Snapshot): void {
  if (isFrozen()) pending.snap = snap;
  else useMonitorStore.getState().setSnap(snap);
}

export function pushInstancesChanged(): void {
  if (isFrozen()) pending.instancesChanged = true;
  else useInstancesStore.getState().loadSoon();
}

export function pushPull(task: PullTask): void {
  if (isFrozen()) {
    pending.pulls.set(task.id, task);
    pending.removed.delete(task.id);
  } else usePullStore.getState().upsert(task);
}

export function pushPullRemoved(id: string): void {
  if (isFrozen()) {
    pending.removed.add(id);
    pending.pulls.delete(id);
  } else usePullStore.getState().remove(id);
}

const PAUSED_TEXT = 'Updates paused (developer mode)';

export function setFrozen(on: boolean): void {
  const ui = useUiStore.getState();
  if (on === ui.frozen) return;
  if (on) {
    ui.setFrozen(true);
    ui.setStatus(PAUSED_TEXT);
    return;
  }
  ui.setFrozen(false);
  const p = pending;
  pending = empty();
  if (p.snap) useMonitorStore.getState().setSnap(p.snap);
  p.logs.forEach(showLog);
  const last = useLogStore.getState().lines.at(-1);
  if (last) ui.setStatus(`[${hms(last.ts)}] ${last.m}`);
  p.pulls.forEach((task) => usePullStore.getState().upsert(task));
  p.removed.forEach((id) => usePullStore.getState().remove(id));
  useInstancesStore.getState().loadSoon(); // whatever changed meanwhile: ask again
}
