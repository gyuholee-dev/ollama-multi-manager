import { describe, expect, it } from 'vitest';
import { LOCALES, detectLang, translate } from './index';

describe('translate', () => {
  it('fills placeholders', () => {
    expect(translate('en', 'sec.n', { n: 3 })).toContain('3');
  });
  it('falls back to English, then to the key', () => {
    expect(translate('xx', 'btn.cancel')).toBe(translate('en', 'btn.cancel'));
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });
  it('leaves an unknown placeholder empty rather than printing "undefined"', () => {
    expect(translate('en', 'sec.n', {})).not.toContain('undefined');
  });
});

describe('detectLang', () => {
  it('takes the first browser language that has a translation', () => {
    expect(detectLang(['fr-FR', 'ko-KR', 'en-US'])).toBe('ko');
    expect(detectLang(['en-GB'])).toBe('en');
  });
  it('defaults to English', () => {
    expect(detectLang(['fr', 'de'])).toBe('en');
    expect(detectLang([])).toBe('en');
  });
});

describe('language files', () => {
  const english = Object.keys(LOCALES.en ?? {});
  it('has no key in Korean that English lacks (English is the fallback)', () => {
    expect(Object.keys(LOCALES.ko ?? {}).filter((k) => !english.includes(k))).toEqual([]);
  });
  it('has a Korean text for every English key', () => {
    expect(english.filter((k) => !(k in (LOCALES.ko ?? {})))).toEqual([]);
  });
  it('uses the same placeholders in every language', () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    const mismatched = english.filter((k) => names(LOCALES.en?.[k] ?? '') !== names(LOCALES.ko?.[k] ?? ''));
    expect(mismatched).toEqual([]);
  });
});
