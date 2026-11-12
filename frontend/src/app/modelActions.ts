import { api } from '@/api/client';
import type { ModelCreateBody, PullTask } from '@/api/types';
import { derivedFrom as parentOf, normModel } from '@/lib/format';
import { sizeBoth } from '@/lib/units';
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

/** The installed models made from `name` (their `details.parent_model` is it). */
export const derivedFrom = (name: string): string[] =>
  useModelStore.getState().list.filter((m) => normModel(m.name) !== normModel(name) && parentOf(m.details) && normModel(parentOf(m.details)) === normModel(name)).map((m) => m.name);

export async function removeModel(name: string): Promise<void> {
  const { storage } = useModelStore.getState();
  const derived = derivedFrom(name);
  const own = storage?.models[name]?.own;
  const msg = [
    t('mdl.del.msg', { n: name }),
    derived.length ? t('mdl.del.derived', { k: derived.length }) : '',
    own != null ? t('mdl.del.frees', { size: sizeBoth(own) }) : '',
  ].filter(Boolean).join('\n');
  if (!(await ask(t('mdl.del.title'), msg, t('btn.delete'), true))) return;
  try {
    await api.del(`/models/${encodeURI(name)}`);
    useModelStore.getState().forgetDetails(name);
    log(`Deleted model ${name}`);
  } catch (e) { await fail(e); }
  await loadModels();
}

/** Reads the details of a model for its open card; a failure is the caller's to show. */
export const loadModelDetail = (name: string): Promise<void> => useModelStore.getState().loadDetail(name);

/** Makes a derived model (with `base` = its own name, changes the settings of that model). An existing name is replaced after the user agreed, unless `askBeforeReplacing` is off. Returns true when it was made. */
export async function createModel(body: ModelCreateBody, askBeforeReplacing = true): Promise<boolean> {
  const exists = useModelStore.getState().list.some((m) => normModel(m.name) === normModel(body.name));
  if (askBeforeReplacing && exists && !(await ask(t('mdl.derive.exists.title'), t('mdl.derive.exists.msg', { n: body.name }), t('mdl.derive.replace'), true))) return false;
  try {
    await api.post('/models/create', body);
    useModelStore.getState().forgetDetails(body.name);
    log(`Created model ${body.name} from ${body.base}`);
  } catch (e) {
    await fail(e);
    return false;
  }
  await loadModels();
  return true;
}
