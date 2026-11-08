import en from './en';
import ko from './ko';
import type { Messages } from './types';

export const LOCALES: Record<string, Messages> = { en, ko };

export type TParams = Record<string, string | number>;
export type Translate = (key: string, params?: TParams) => string;

/** The first browser language we have a translation for, else English. */
export function detectLang(languages: readonly string[] = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language])): string {
  for (const l of languages) {
    const base = String(l || '').toLowerCase().split('-')[0] ?? '';
    if (base in LOCALES) return base;
  }
  return 'en';
}

/** Looks the key up in the language, then in English, then falls back to the key itself; fills {placeholders}. */
export function translate(lang: string, key: string, params?: TParams): string {
  const text = LOCALES[lang]?.[key] ?? LOCALES.en?.[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''));
}
