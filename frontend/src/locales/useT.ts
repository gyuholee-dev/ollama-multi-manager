import { useSettingsStore } from '@/stores/settingsStore';
import { translate, type TParams, type Translate } from './index';

/** Translator for components: re-renders when the language changes. */
export function useT(): Translate {
  const lang = useSettingsStore((s) => s.cfg.lang);
  return (key: string, params?: TParams) => translate(lang, key, params);
}

/** Translator for code outside components (stores, event handlers). */
export const t: Translate = (key, params) => translate(useSettingsStore.getState().cfg.lang, key, params);
