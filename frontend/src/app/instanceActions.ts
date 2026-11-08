import { api } from '@/api/client';
import { buildViews, vramByGpu } from '@/lib/derive';
import { t } from '@/locales/useT';
import { useInstancesStore } from '@/stores/instancesStore';
import { isGuest, useMonitorStore } from '@/stores/monitorStore';
import { ask, fail, popup } from './dialogs';

const currentViews = () => buildViews(useInstancesStore.getState().list, useMonitorStore.getState().snap);

/** Refetches the list; a failure is shown to the user. */
export async function reloadInstances(): Promise<void> {
  try { await useInstancesStore.getState().load(); } catch (e) { await fail(e); }
}

/** Waits this long (seconds) for running requests when the user chooses "stop when done". */
const DRAIN_SECONDS = 120;
const VRAM_WARN_PERCENT = 85;

/** Start or stop an instance, asking first when that could surprise: a nearly full GPU, running requests, loaded models. */
export async function changeState(id: number, state: 'running' | 'stopped'): Promise<void> {
  const views = currentViews();
  const instance = views.find((v) => v.id === id);
  if (!instance || isGuest()) return;

  if (state === 'running') {
    const usage = vramByGpu(views, useMonitorStore.getState().snap?.gpu?.devices ?? []);
    const pct = usage.length ? Math.max(...usage.map((g) => g.pct)) : 0;
    if (pct > VRAM_WARN_PERCENT && !(await popup({ kind: 'warn', title: t('w.vram.t'), msg: t('w.vram.m', { pct, n: instance.name }), ok: t('btn.start'), cancel: t('btn.cancel') }))) return;
  }

  let drain = 0; // seconds to wait for running requests before stopping
  if (state === 'stopped') {
    const busy = instance.metrics?.perf?.inflight ?? 0;
    if (busy > 0) {
      const answer = await popup({ kind: 'danger', title: t('w.busy.t'), msg: t('w.busy.m', { n: instance.name, k: busy }), ok: t('btn.drainStop'), alt: t('btn.stopNow'), cancel: t('btn.cancel') });
      if (!answer) return;
      drain = answer === true ? DRAIN_SECONDS : 0;
    } else if (instance.loaded.length && !(await ask(t('w.stop.t'), t('w.stop.m', { n: instance.name, k: instance.loaded.length }), t('btn.stop'), true))) return;
  }

  try {
    await api.post(`/instances/${id}/${state === 'running' ? 'start' : 'stop'}`, drain ? { drain_seconds: drain } : undefined);
  } catch (e) { await fail(e); }
  await reloadInstances();
}

export async function removeInstance(id: number): Promise<void> {
  const instance = currentViews().find((v) => v.id === id);
  if (!instance || isGuest() || !(await ask(t('inst.del.title'), t('inst.del.msg', { n: instance.name }), t('btn.delete'), true))) return;
  try { await api.del(`/instances/${id}`); } catch (e) { await fail(e); }
  await reloadInstances();
}

/** Limits an instance to the chosen models (an empty list = every installed model). Takes effect at once. */
export async function saveAllowedModels(id: number, models: string[]): Promise<void> {
  if (isGuest()) return;
  try { await api.put(`/instances/${id}/allowed-models`, { models }); } catch (e) { await fail(e); }
  await reloadInstances();
}
