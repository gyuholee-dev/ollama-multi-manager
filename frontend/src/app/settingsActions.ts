import { api } from '@/api/client';
import type { Info } from '@/api/types';
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
  if (field === 'exe' || field === 'modelsPath') void loadModels(); // another executable or folder: another list
  if ((field === 'exe' || field === 'modelsPath') && useInstancesStore.getState().list.some((i) => i.status.state === 'running' || i.status.state === 'starting')) {
    void notify('info', t('rr.t'), t('rr.m'));
  }
}

export async function resetSettings(): Promise<void> {
  if (!(await ask(t('rst.title'), t('rst.msg'), t('rst.ok'), true))) return;
  try { await useSettingsStore.getState().reset(); } catch (e) { await fail(e); return; }
  notifySettingsChanged();
  void loadModels();
  log('Settings reset to defaults');
}
