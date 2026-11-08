import { api, initClient } from '@/api/client';
import { connectSocket } from '@/api/socket';
import type { Info, Instance, LogEvent, PullTask, Settings, Snapshot, SocketMessage } from '@/api/types';
import { t } from '@/locales/useT';
import { useInstancesStore } from '@/stores/instancesStore';
import { useLogStore, type LogLine } from '@/stores/logStore';
import { useMonitorStore } from '@/stores/monitorStore';
import { usePullStore } from '@/stores/pullStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { notify } from './dialogs';
import { isFrozen, pushInstancesChanged, pushLog, pushPull, pushPullRemoved, pushSnapshot, setFrozen } from './live';
import { log } from './log';

/** The name shown for the source of a log line: 0 is the app itself. */
export const sourceName = (instanceId: number): string =>
  instanceId === 0 ? 'app' : (useInstancesStore.getState().list.find((i) => i.id === instanceId)?.name ?? `instance-${instanceId}`);

export const toLogLine = (e: LogEvent): LogLine => ({ ts: e.ts * 1000, src: sourceName(e.instance), m: e.msg, level: e.level });

/** Everything the page shows, fetched in one go (at the first connection and after every reconnect). */
export async function loadAll(): Promise<void> {
  const [settings, info, instances, logs, pulls] = await Promise.all([
    api.get<Settings>('/settings'),
    api.get<Info>('/info'),
    api.get<Instance[]>('/instances'),
    api.get<LogEvent[]>('/logs?limit=500'),
    api.get<PullTask[]>('/pulls'),
  ]);
  const snap = await api.get<Snapshot>('/monitor/snapshot').catch(() => null);
  useSettingsStore.getState().load(settings);
  useInstancesStore.getState().set(instances);
  useMonitorStore.setState({ info, snap });
  usePullStore.getState().setAll(pulls);
  useLogStore.getState().set(logs.map(toLogLine));
}

function onMessage(m: SocketMessage): void {
  switch (m.type) {
    case 'metrics': pushSnapshot(m.data); break;
    case 'instance': pushInstancesChanged(); break;
    case 'log': pushLog(toLogLine(m)); break;
    case 'pull': {
      const prev = usePullStore.getState().tasks[m.task.id];
      pushPull(m.task);
      if (isFrozen()) break; // developer aid: no popups while the page is held still
      if (m.task.status === 'error' && prev?.status === 'pulling') void notify('error', t('err.title'), `${m.task.model}: ${m.task.error ?? ''}`);
      if (m.task.status === 'success' && prev?.status === 'pulling') log(`Pulled model ${m.task.model}`);
      break;
    }
    case 'pull_removed': pushPullRemoved(m.id); break;
  }
}

let first = true;

async function onStatus(up: boolean): Promise<void> {
  const ui = useUiStore.getState();
  ui.setConnected(up);
  if (!up) {
    ui.setStatus(t('conn.lost'));
    ui.setReady(); // show the page anyway: its frame and the connection notice are better than a blank screen
    return;
  }
  try {
    await loadAll();
    log(first ? 'Connected to backend' : 'Reconnected to backend');
    first = false;
  } catch (e) {
    ui.setStatus(e instanceof Error ? e.message : String(e));
  }
  ui.setReady(); // the first load is over: the page may be shown (before this only a loading note is visible)
}

/** Starts talking to the backend. Returns a function that stops it. */
export function startApp(): () => void {
  initClient();
  window.__omm = { isFrozen, setFrozen };
  return connectSocket(onMessage, (up) => { void onStatus(up); });
}
