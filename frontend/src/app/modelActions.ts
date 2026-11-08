import { api } from '@/api/client';
import type { PullTask } from '@/api/types';
import { t } from '@/locales/useT';
import { useModelStore } from '@/stores/modelStore';
import { usePullStore } from '@/stores/pullStore';
import { ask, fail, notify } from './dialogs';
import { log } from './log';

export async function loadModels(): Promise<void> {
  try { await useModelStore.getState().load(); } catch (e) { await fail(e); }
}

/** Starts a download. Returns true when it started (the caller clears the input). */
export async function startPull(input: string): Promise<boolean> {
  let name = input.trim();
  if (name && !name.includes(':')) name += ':latest';
  const duplicate = useModelStore.getState().list.some((m) => m.name === name);
  if (!name || duplicate) {
    void notify('warn', t(name ? 'mdl.dup.title' : 'mdl.empty.title'), t(name ? 'mdl.dup.msg' : 'mdl.empty.msg', { n: name }));
    return false;
  }
  try {
    usePullStore.getState().upsert(await api.post<PullTask>('/models/pull', { model: name }));
    return true;
  } catch (e) {
    await fail(e);
    return false;
  }
}

export async function pullAction(id: string, action: 'pause' | 'resume'): Promise<void> {
  try { usePullStore.getState().upsert(await api.post<PullTask>(`/pulls/${id}/${action}`)); } catch (e) { await fail(e); }
}

/** Removes a download card together with the part of the file that was already received. */
export async function removePull(id: string): Promise<void> {
  const task = usePullStore.getState().tasks[id];
  if (!task || !(await ask(t('mdl.dl.del.title'), t('mdl.dl.del.msg', { n: task.model }), t('btn.delete'), true))) return;
  try {
    await api.del(`/pulls/${id}`);
    usePullStore.getState().remove(id);
    log(`Deleted download ${task.model}`);
  } catch (e) { await fail(e); }
}

export async function removeModel(name: string): Promise<void> {
  if (!(await ask(t('mdl.del.title'), t('mdl.del.msg', { n: name }), t('btn.delete'), true))) return;
  try {
    await api.del(`/models/${encodeURI(name)}`);
    log(`Deleted model ${name}`);
  } catch (e) { await fail(e); }
  await loadModels();
}
