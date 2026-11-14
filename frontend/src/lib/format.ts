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

/** "parameters 11.9B · quantization Q4_K_M": what Ollama reports about the model (`details`), as it is; what it does not say
 *  is read out of the tag, such as "qwen3:8b-q4_K_M" (a model made from another with `ollama create` often has no such tag). */
export const modelInfo = (tag: string, t: Translate, details?: Record<string, unknown>): string => {
  const given = (key: string): string => { const v = details?.[key]; return typeof v === 'string' ? v.trim() : ''; };
  const p = tag.match(/(?:^|[-:])(\d+(?:\.\d+)?)b(?=-|$)/i);
  const q = tag.match(/(q\d+(?:_[a-z0-9]+)*|nvfp\d+|fp\d+|bf\d+)/i);
  return t('mdl.param', {
    p: given('parameter_size') || (p?.[1] ? `${p[1]}B` : '-'),
    q: given('quantization_level') || (q?.[1] ? q[1].toUpperCase() : '-'),
  });
};

/** "gemma4:12b-it-q4_K_M" -> family "gemma4", tag "12b-it-q4_K_M" */
export const splitModel = (name: string): { family: string; tag: string } => {
  const family = name.split(':')[0] ?? name;
  return { family, tag: name.slice(family.length + 1) };
};

/** "Automatic", "CPU" or "GPU-1 · NVIDIA ...": how an instance's device setting is shown. */
/** What the GPU's memory is called: VRAM, or unified memory when it is shared with the CPU (Apple silicon, integrated graphics). */
/** Every GPU shares its memory with the CPU (Apple silicon, integrated graphics): there is one pool, not a separate VRAM. */
export const isUnified = (devices: { unified: boolean }[]): boolean => devices.length > 0 && devices.every((d) => d.unified);

/** What a GPU's use row is called: "iGPU" for integrated graphics, "GPU" otherwise. Apple silicon has no discrete GPU to be told apart from, so it stays "GPU". */
export const gpuName = (d: { unified: boolean; vendor: string }): string => (d.unified && d.vendor !== 'apple' ? 'iGPU' : 'GPU');

export const memoryLabel = (devices: { unified: boolean }[], t: Translate): string => (isUnified(devices) ? t('mon.unified') : 'VRAM');

export const gpuLabel = (gpu: 'auto' | 'cpu' | number, devices: { name: string }[], t: Translate): string =>
  gpu === 'auto' ? t('gpu.auto') : gpu === 'cpu' ? 'CPU' : t('gpu.n', { g: gpu, name: devices[gpu]?.name ?? '?' });

/** Ollama treats "llama3" and "llama3:latest" as the same model. */
export const normModel = (name: string): string => {
  const n = name.trim();
  return (n.split('/').pop() ?? n).includes(':') ? n : `${n}:latest`;
};

/**
 * The model a tag was derived from (Ollama's `details.parent_model`), or "" for a model that has none or was imported from a file
 * (its parent is then a path or a .gguf name). A model edited in place has itself as its parent.
 */
export const derivedFrom = (details: Record<string, unknown> | undefined): string => {
  const p = typeof details?.parent_model === 'string' ? details.parent_model.trim() : '';
  return p && !/\.gguf$|^[\\/.~]|^[A-Za-z]:[\\/]/.test(p) ? p : '';
};

/** The quantization of a model: what Ollama reports (`details.quantization_level`), else what its tag says ("q4_K_M"); "" when neither does. */
export const quantOf = (name: string, details?: Record<string, unknown>): string => {
  const given = typeof details?.quantization_level === 'string' ? details.quantization_level.trim() : '';
  return (given || name.match(/(q\d+(?:_[a-z0-9]+)*|nvfp\d+|fp\d+|bf\d+)/i)?.[1] || '').toUpperCase();
};

/**
 * The order of the models of one family: by quantization (the fewer bits first: Q4, Q8, F16 ...; a model without one last),
 * and within one quantization the original model first, then the ones derived from it, each by name.
 */
export const compareModels = (a: { name: string; details?: Record<string, unknown> }, b: { name: string; details?: Record<string, unknown> }): number => {
  const qa = quantOf(a.name, a.details);
  const qb = quantOf(b.name, b.details);
  const bits = (q: string): number => { const n = q.match(/\d+/)?.[0]; return n ? Number(n) : Infinity; };
  return (bits(qa) - bits(qb) || 0) // (Infinity - Infinity is NaN: both without one are equal)
    || qa.localeCompare(qb)
    || Number(!!derivedFrom(a.details)) - Number(!!derivedFrom(b.details))
    || a.name.localeCompare(b.name);
};
