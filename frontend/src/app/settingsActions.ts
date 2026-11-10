import { api } from '@/api/client';
import type { Info, Settings } from '@/api/types';
import { notifySettingsChanged } from '@/desktop';
import { t } from '@/locales/useT';
import { useInstancesStore } from '@/stores/instancesStore';
import { useMonitorStore } from '@/stores/monitorStore';
import { useSettingsStore, type Cfg } from '@/stores/settingsStore';
import { ask, fail, notify } from './dialogs';
import { loadModels } from './modelActions';
import { log } from './log';

const portProblem = (port: number): [string, string] | null => {
  if (!(port >= 1024 && port <= 65535)) return [t('v.port.t'), t('v.port.m')];
  if (useInstancesStore.getState().list.some((i) => i.port === port)) return [t('port.conflict'), t('sv.portMsg', { p: port })];
  return null;
};

/**
 * Stores what the settings form changed, right after the field was edited. A bad web access port is refused and the
 * form goes back to what is saved. The changes of paths are applied to instances only when they start again.
 */
export async function commitSetting(field: keyof Cfg): Promise<void> {
  const store = useSettingsStore.getState();
  const { cfg } = store;
  if (field === 'monPort' || field === 'extMon') {
    const bad = portProblem(cfg.monPort);
    if (cfg.extMon && bad) {
      store.revert();
      await notify('warn', ...bad);
      return;
    }
  }
  // a path counts as changed only when its text differs from what was saved (touching the field and leaving it changes nothing)
  const pathChanged = (field === 'exe' || field === 'modelsPath') && String(cfg[field]).trim() !== String(store.saved[field]).trim();
  try {
    await store.save();
  } catch (e) {
    store.revert();
    await fail(e);
    return;
  }
  notifySettingsChanged();
  if (field === 'monPort' || field === 'extMon') {
    try { useMonitorStore.getState().setInfo(await api.get<Info>('/info')); } catch { /* keep the old info */ }
    const x = useMonitorStore.getState().info?.external_monitoring;
    if (x?.enabled && !x.active) void notify('warn', t('ext.title'), x.error ?? '');
  }
  if (pathChanged) void loadModels(); // another executable or folder: another list
  if (pathChanged && useInstancesStore.getState().list.some((i) => i.status.state === 'running' || i.status.state === 'starting')) {
    void notify('info', t('rr.t'), t('rr.m'));
  }
}

/** Sets the web access password (write-only: the backend keeps only a hash). Resolves true when it was saved. */
export async function commitPassword(password: string): Promise<boolean> {
  if (password.length < 4) { await notify('warn', t('ext.title'), t('ext.pwShort')); return false; }
  try {
    await api.put<Settings>('/settings', { external_monitoring_password: password });
  } catch (e) {
    await fail(e);
    return false;
  }
  try { useMonitorStore.getState().setInfo(await api.get<Info>('/info')); } catch { /* keep the old info */ }
  void notify('info', t('ext.title'), t('ext.pwSaved'));
  return true;
}

export async function resetSettings(): Promise<void> {
  if (!(await ask(t('rst.title'), t('rst.msg'), t('rst.ok'), true))) return;
  try { await useSettingsStore.getState().reset(); } catch (e) { await fail(e); return; }
  notifySettingsChanged();
  void loadModels();
  log('Settings reset to defaults');
}
