import { beforeEach, describe, expect, it } from 'vitest';
import type { PullTask } from '@/api/types';
import { useDialogStore } from './dialogStore';
import { MAX_LOG_LINES, useLogStore } from './logStore';
import { unfinished, usePullStore } from './pullStore';
import { cfgFromApi, cfgToApi, diffCfg, type Cfg } from './settingsStore';
import { useUiStore } from './uiStore';

const task = (id: string, status: PullTask['status'], started_at = 0): PullTask => ({
  id, model: `m${id}`, status, status_text: '', completed: 0, total: 0, error: null, started_at, finished_at: null, percent: null,
});

describe('logStore', () => {
  beforeEach(() => useLogStore.getState().set([]));
  it('keeps only the newest lines', () => {
    for (let i = 0; i < MAX_LOG_LINES + 20; i++) useLogStore.getState().add({ ts: i, src: 'app', m: String(i), level: 'info' });
    const lines = useLogStore.getState().lines;
    expect(lines).toHaveLength(MAX_LOG_LINES);
    expect(lines[0]?.m).toBe('20');
    expect(lines.at(-1)?.m).toBe(String(MAX_LOG_LINES + 19));
  });
});

describe('pullStore', () => {
  beforeEach(() => usePullStore.getState().setAll([]));
  it('adds, replaces and removes tasks', () => {
    usePullStore.getState().upsert(task('a', 'pulling'));
    usePullStore.getState().upsert({ ...task('a', 'paused'), percent: 40 });
    expect(usePullStore.getState().tasks.a?.status).toBe('paused');
    usePullStore.getState().remove('a');
    expect(usePullStore.getState().tasks).toEqual({});
  });
  it('lists the unfinished downloads, oldest first, without the finished ones', () => {
    const tasks = Object.fromEntries([task('a', 'success', 1), task('b', 'paused', 3), task('c', 'pulling', 2)].map((x) => [x.id, x]));
    expect(unfinished(tasks).map((x) => x.id)).toEqual(['c', 'b']);
  });
});

describe('settings', () => {
  const settings = {
    language: null, theme: 'dark' as const, launch_at_login: false, minimize_to_tray: true, external_monitoring_enabled: false,
    external_monitoring_port: 9100, refresh_interval_seconds: 3, ollama_executable_path: null, default_models_path: '/models',
  };
  it('turns the backend settings into the form and back', () => {
    const cfg = cfgFromApi(settings);
    expect(cfg).toMatchObject({ theme: 'dark', tray: true, exe: '', modelsPath: '/models', monPort: 9100 });
    expect(cfg.lang).not.toBe('');
    expect(cfgToApi('exe', '  ' as Cfg['exe'])).toBeNull();
    expect(cfgToApi('modelsPath', ' /x ')).toBe('/x');
    expect(cfgToApi('tray', false)).toBe(false);
  });
  it('sends only what changed', () => {
    const saved = cfgFromApi(settings);
    expect(diffCfg(saved, saved)).toEqual({});
    expect(diffCfg(saved, { ...saved, interval: 5, exe: '/usr/bin/ollama' })).toEqual({ refresh_interval_seconds: 5, ollama_executable_path: '/usr/bin/ollama' });
  });
});

describe('uiStore', () => {
  it('flips the sort direction on the same key and resets it on another', () => {
    useUiStore.setState({ sortKey: 'name', sortDir: 1 });
    useUiStore.getState().sortBy('name');
    expect(useUiStore.getState()).toMatchObject({ sortKey: 'name', sortDir: -1 });
    useUiStore.getState().sortBy('port');
    expect(useUiStore.getState()).toMatchObject({ sortKey: 'port', sortDir: 1 });
  });
  it('toggles panels and sections', () => {
    useUiStore.setState({ sumOn: ['ins'], collapsed: [] });
    useUiStore.getState().toggleSum('perf');
    useUiStore.getState().toggleSum('ins');
    useUiStore.getState().toggleSection('logs');
    expect(useUiStore.getState().sumOn).toEqual(['perf']);
    expect(useUiStore.getState().collapsed).toEqual(['logs']);
  });
});

describe('dialogStore', () => {
  it('resolves a popup with the pressed button', async () => {
    const answer = useDialogStore.getState().showPopup({ kind: 'confirm', title: 't', msg: 'm', ok: 'OK', cancel: 'No' });
    useDialogStore.getState().closePopup(true);
    expect(await answer).toBe(true);
    expect(useDialogStore.getState().popup).toBeNull();
  });
  it('closes the popup that is still open (as cancelled) when a new one arrives', async () => {
    const first = useDialogStore.getState().showPopup({ kind: 'info', title: '1', msg: '', ok: 'OK' });
    const second = useDialogStore.getState().showPopup({ kind: 'info', title: '2', msg: '', ok: 'OK' });
    expect(await first).toBe(false);
    useDialogStore.getState().closePopup('alt');
    expect(await second).toBe('alt');
  });
  it('opens one big dialog at a time', () => {
    useDialogStore.getState().open({ kind: 'details', id: 3 });
    useDialogStore.getState().open({ kind: 'settings' });
    expect(useDialogStore.getState().active).toEqual({ kind: 'settings' });
    useDialogStore.getState().close();
    expect(useDialogStore.getState().active).toBeNull();
  });
});
