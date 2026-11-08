import type { Translate } from '@/locales';

/** Choices of the "keep loaded" slider, in minutes (-1 = never unload). */
export const KEEP = [1, 5, 15, 30, 60, 180, 360, 720, 1440, -1];

export const fmtCtx = (tokens: number): string => `${tokens / 1024}K`;

export const fmtN = (n: number | string, t: Translate): string => `${n}${t('u.cnt')}`;

export const fmtKeep = (minutes: number, t: Translate): string => {
  if (minutes < 0) return t('keep.unlimited');
  if (minutes >= 1440) return t('keep.day', { n: minutes / 1440 });
  if (minutes >= 60) return t('keep.hour', { n: minutes / 60 });
  return t('keep.min', { n: minutes });
};

/** "42 s", "7 min", "3 h 5 min" */
export const fmtUp = (ms: number, t: Translate): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t('sec.n', { n: s });
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}${t('up.m')}` : `${Math.floor(m / 60)}${t('up.h')} ${m % 60}${t('up.m')}`;
};

/** When a loaded model is unloaded again ("until 14:05"), or that it stays. */
export const expAt = (exp: string | null, keep: number, t: Translate): string =>
  keep < 0 || !exp ? t('exp.none') : t('exp.at', { t: new Date(exp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) });

export const hms = (tsMs: number): string => new Date(tsMs).toLocaleTimeString('en-GB');

/** "7B" and "Q4_K_M" read out of a model tag such as "qwen3:8b-q4_K_M" -> "parameters 8B · quantization Q4_K_M". */
export const modelInfo = (tag: string, t: Translate): string => {
  const p = tag.match(/(?:^|[-:])(\d+(?:\.\d+)?)b(?=-|$)/i);
  const q = tag.match(/(q\d+(?:_[a-z0-9]+)*|nvfp\d+|fp\d+|bf\d+)/i);
  return t('mdl.param', { p: p?.[1] ? `${p[1]}B` : '-', q: q?.[1] ? q[1].toUpperCase() : '-' });
};

/** "gemma4:12b-it-q4_K_M" -> family "gemma4", tag "12b-it-q4_K_M" */
export const splitModel = (name: string): { family: string; tag: string } => {
  const family = name.split(':')[0] ?? name;
  return { family, tag: name.slice(family.length + 1) };
};

/** "Automatic", "CPU" or "GPU 1 · NVIDIA ...": how an instance's device setting is shown. */
export const gpuLabel = (gpu: 'auto' | 'cpu' | number, devices: { name: string }[], t: Translate): string =>
  gpu === 'auto' ? t('gpu.auto') : gpu === 'cpu' ? 'CPU' : t('gpu.n', { g: gpu, name: devices[gpu]?.name ?? '?' });
