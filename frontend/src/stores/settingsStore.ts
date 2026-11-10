import { create } from 'zustand';
import { api } from '@/api/client';
import type { Settings, SettingsPatch } from '@/api/types';
import { detectLang } from '@/locales';

/** The settings as the form edits them (flat, with empty strings instead of null for paths). */
export interface Cfg {
  lang: string;
  theme: 'system' | 'light' | 'dark';
  login: boolean;
  tray: boolean;
  interval: number;
  extMon: boolean; // "web monitoring"
  monPort: number;
  exe: string;
  modelsPath: string;
}

/** form field -> key in the backend's settings */
export const KEYMAP: Record<keyof Cfg, keyof Settings> = {
  lang: 'language', theme: 'theme', login: 'launch_at_login', tray: 'minimize_to_tray', interval: 'refresh_interval_seconds',
  extMon: 'external_monitoring_enabled', monPort: 'external_monitoring_port', exe: 'ollama_executable_path', modelsPath: 'default_models_path',
};

export const DEFAULT_PORT = 9100;
const DEFAULTS: Cfg = { lang: '', theme: 'system', login: false, tray: false, interval: 3, extMon: false, monPort: DEFAULT_PORT, exe: '', modelsPath: '' };

export const defaultCfg = (): Cfg => ({ ...DEFAULTS, lang: detectLang() });

export const cfgFromApi = (s: Settings): Cfg => ({
  lang: s.language || detectLang(), theme: s.theme, login: s.launch_at_login, tray: s.minimize_to_tray,
  interval: s.refresh_interval_seconds, extMon: s.external_monitoring_enabled, monPort: s.external_monitoring_port,
  exe: s.ollama_executable_path || '', modelsPath: s.default_models_path || '',
});

/** A cleared path is stored as null, the language "automatic" as null. */
export const cfgToApi = <K extends keyof Cfg>(key: K, value: Cfg[K]): unknown =>
  key === 'exe' || key === 'modelsPath' ? (String(value).trim() || null) : value;

/** What changed between the saved and the edited form, in the backend's terms. */
export function diffCfg(saved: Cfg, edited: Cfg): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(KEYMAP) as (keyof Cfg)[]) {
    if (edited[k] !== saved[k]) patch[KEYMAP[k]] = cfgToApi(k, edited[k]);
  }
  return patch as SettingsPatch;
}

interface SettingsState {
  cfg: Cfg; // what the form shows (theme and language apply the moment they are edited)
  saved: Cfg; // what the backend has
  load: (settings: Settings) => void;
  edit: (patch: Partial<Cfg>) => void;
  /** Sends what changed; resolves with the backend's answer. Throws on failure (the caller decides what to show). */
  save: () => Promise<void>;
  revert: () => void;
  /** Back to the defaults (the language goes back to "automatic"). */
  reset: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  cfg: defaultCfg(),
  saved: defaultCfg(),
  load: (settings) => {
    const cfg = cfgFromApi(settings);
    set({ cfg, saved: { ...cfg } });
  },
  edit: (patch) => set({ cfg: { ...get().cfg, ...patch } }),
  save: async () => {
    const patch = diffCfg(get().saved, get().cfg);
    if (!Object.keys(patch).length) return;
    const cfg = cfgFromApi(await api.put<Settings>('/settings', patch));
    set({ cfg, saved: { ...cfg } });
  },
  revert: () => set({ cfg: { ...get().saved } }),
  reset: async () => {
    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(KEYMAP) as (keyof Cfg)[]) patch[KEYMAP[k]] = k === 'lang' ? null : cfgToApi(k, DEFAULTS[k]);
    const cfg = cfgFromApi(await api.put<Settings>('/settings', patch));
    set({ cfg, saved: { ...cfg } });
  },
}));
