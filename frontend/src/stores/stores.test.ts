import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullTask } from '@/api/types';
import { useDialogStore } from './dialogStore';
import { MAX_LOG_LINES, useLogStore } from './logStore';
import { unfinished, usePullStore } from './pullStore';
import { useRequestClearStore } from './requestClearStore';
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
  it('gives each line a number that stays with it while others come and go', () => {
    const add = useLogStore.getState().add;
    add({ ts: 1, src: 'app', m: 'a', level: 'info' });
    add({ ts: 2, src: 'app', m: 'b', level: 'info' });
    const [a, b] = useLogStore.getState().lines;
    add({ ts: 3, src: 'app', m: 'c', level: 'info' });
    useLogStore.getState().clear('nothing');
    const now = useLogStore.getState().lines;
    expect(now.slice(0, 2).map((l) => l.id)).toEqual([a!.id, b!.id]); // the page keeps these lines' elements
    expect(new Set(now.map((l) => l.id)).size).toBe(3);
    for (let i = 0; i < MAX_LOG_LINES; i++) add({ ts: 9, src: 'app', m: 'x', level: 'info' });
    const ids = useLogStore.getState().lines.map((l) => l.id);
    expect(ids).toEqual([...ids].sort((p, q) => p - q)); // in order, and a trimmed line's number is not used again
    expect(ids).not.toContain(a!.id);
  });
  it('clears the lines of one source, or all of them', () => {
    const add = useLogStore.getState().add;
    add({ ts: 1, src: 'app', m: 'a', level: 'info' });
    add({ ts: 2, src: 'worker-1', m: 'b', level: 'info' });
    add({ ts: 3, src: 'worker-2', m: 'c', level: 'info' });
    useLogStore.getState().clear('worker-1');
    expect(useLogStore.getState().lines.map((l) => l.m)).toEqual(['a', 'c']);
    add({ ts: 4, src: 'worker-1', m: 'd', level: 'info' }); // new lines of a cleared source come in as usual
    expect(useLogStore.getState().lines.map((l) => l.m)).toEqual(['a', 'c', 'd']);
    useLogStore.getState().clear('all');
    expect(useLogStore.getState().lines).toEqual([]);
  });
});

describe('requestClearStore', () => {
  beforeEach(() => useRequestClearStore.setState({ clearedAt: {} }));
  it('hides requests up to the time given, per instance, and never moves the mark back', () => {
    const { clear } = useRequestClearStore.getState();
    clear(1, 100);
    clear(2, 50);
    clear(1, 80);
    expect(useRequestClearStore.getState().clearedAt).toEqual({ 1: 100, 2: 50 });
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
    external_monitoring_port: 9100, mcp_enabled: false, mcp_port: 9101, mcp_lan: false, mcp_control: false, mcp_token_set: false, external_monitoring_password_set: false, external_monitoring_metrics_token_set: false, external_monitoring_session_hours: 12, refresh_interval_seconds: 3, monitor_default_ollama: true, history_keep_days: 7, vram_warn_percent: 85, ollama_executable_path: null, default_models_path: '/models',
  };
  it('turns the backend settings into the form and back', () => {
    const cfg = cfgFromApi(settings);
    expect(cfg).toMatchObject({ theme: 'dark', tray: true, exe: '', modelsPath: '/models', monPort: 9100 });
    expect(cfg.lang).not.toBe('');
    expect(cfgToApi('exe', '  ' as Cfg['exe'])).toBeNull();
    expect(cfgToApi('modelsPath', ' /x ')).toBe('/x');
    expect(cfgToApi('tray', false)).toBe(false);
  });
  it('keeps the MCP server\'s settings under their own names', () => {
    const saved = cfgFromApi({ ...settings, mcp_enabled: true, mcp_port: 9200, mcp_lan: true, mcp_control: true });
    expect(saved).toMatchObject({ mcpOn: true, mcpPort: 9200, mcpLan: true, mcpControl: true });
    expect(diffCfg(saved, { ...saved, mcpOn: false, mcpPort: 9300 })).toEqual({ mcp_enabled: false, mcp_port: 9300 });
    expect(cfgFromApi(settings)).toMatchObject({ mcpOn: false, mcpPort: 9101, mcpLan: false, mcpControl: false }); // off, this PC only and read-only, until switched on
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
  it('shows every part of the monitor window at first and toggles each one', () => {
    useUiStore.setState({ imHide: [] });
    useUiStore.getState().toggleImPart('cpu');
    expect(useUiStore.getState().imHide).toEqual(['cpu']);
    useUiStore.getState().toggleImPart('cpu');
    expect(useUiStore.getState().imHide).toEqual([]);
  });
  it('opens every monitor sub-section at first and remembers the ones that are closed', () => {
    useUiStore.setState({ imFold: [] });
    useUiStore.getState().toggleImFold('cpu');
    expect(useUiStore.getState().imFold).toEqual(['cpu']);
    useUiStore.getState().toggleImFold('cpu');
    expect(useUiStore.getState().imFold).toEqual([]);
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
    useDialogStore.getState().open({ kind: 'new' });
    expect(useDialogStore.getState().active).toEqual({ kind: 'new' });
    useDialogStore.getState().close();
    expect(useDialogStore.getState().active).toBeNull();
  });
  it('lets a page slide only for a moment after it was opened or closed', () => {
    vi.useFakeTimers();
    try {
      expect(useDialogStore.getState().slide).toBe(false);
      useDialogStore.getState().open({ kind: 'models' });
      expect(useDialogStore.getState().slide).toBe(true);
      vi.advanceTimersByTime(400);
      expect(useDialogStore.getState().slide).toBe(false);
      useDialogStore.getState().close();
      expect(useDialogStore.getState().page).toBeNull();
      expect(useDialogStore.getState().slide).toBe(true);
      vi.advanceTimersByTime(400);
      expect(useDialogStore.getState().slide).toBe(false);
      useDialogStore.getState().open({ kind: 'new' }); // a dialog does not slide
      expect(useDialogStore.getState().slide).toBe(false);
      useDialogStore.getState().close();
    } finally { vi.useRealTimers(); }
  });
  it('slides to a page, apart from the dialogs, and back', () => {
    useDialogStore.getState().open({ kind: 'settings' });
    expect(useDialogStore.getState().page).toBe('settings');
    expect(useDialogStore.getState().active).toBeNull();
    useDialogStore.getState().open({ kind: 'models' });
    expect(useDialogStore.getState().page).toBe('models');
    useDialogStore.getState().open({ kind: 'new' }); // a dialog over the page: closing it leaves the page in view
    useDialogStore.getState().close();
    expect(useDialogStore.getState().active).toBeNull();
    expect(useDialogStore.getState().page).toBe('models');
    useDialogStore.getState().close();
    expect(useDialogStore.getState().page).toBeNull();
  });
});
