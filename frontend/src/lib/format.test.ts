import { describe, expect, it } from 'vitest';
import { translate } from '@/locales';
import { fmtCtx, fmtKeep, fmtUp, memoryLabel, modelInfo, splitModel } from './format';

const en = (key: string, params?: Record<string, string | number>) => translate('en', key, params);

describe('format', () => {
  it('shows the context length in K', () => {
    expect(fmtCtx(8192)).toBe('8K');
    expect(fmtCtx(2048)).toBe('2K');
  });

  it('picks minutes, hours or days for the keep-alive time', () => {
    expect(fmtKeep(5, en)).toBe(en('keep.min', { n: 5 }));
    expect(fmtKeep(180, en)).toBe(en('keep.hour', { n: 3 }));
    expect(fmtKeep(1440, en)).toBe(en('keep.day', { n: 1 }));
    expect(fmtKeep(-1, en)).toBe(en('keep.unlimited'));
  });

  it('shows uptime as seconds, minutes, or hours and minutes', () => {
    expect(fmtUp(42_000, en)).toBe(en('sec.n', { n: 42 }));
    expect(fmtUp(7 * 60_000, en)).toBe(`7${en('up.m')}`);
    expect(fmtUp((3 * 60 + 5) * 60_000, en)).toBe(`3${en('up.h')} 5${en('up.m')}`);
    expect(fmtUp(-5, en)).toBe(en('sec.n', { n: 0 }));
  });

  it('reads parameters and quantization out of a model tag', () => {
    expect(modelInfo('12b-it-q4_K_M', en)).toBe(en('mdl.param', { p: '12B', q: 'Q4_K_M' }));
    expect(modelInfo('1.5b-base', en)).toBe(en('mdl.param', { p: '1.5B', q: '-' }));
    expect(modelInfo('latest', en)).toBe(en('mdl.param', { p: '-', q: '-' }));
  });

  it('splits a model name into family and tag', () => {
    expect(splitModel('gemma4:12b-it-q4_K_M')).toEqual({ family: 'gemma4', tag: '12b-it-q4_K_M' });
    expect(splitModel('qwen2.5-coder:1.5b')).toEqual({ family: 'qwen2.5-coder', tag: '1.5b' });
  });
});

describe('memoryLabel', () => {
  const t = (k: string) => translate('en', k);
  it('names the GPU memory VRAM, or UMA when it is shared with the CPU', () => {
    expect(memoryLabel([], t)).toBe('VRAM'); // nothing readable: the usual name, shown disabled
    expect(memoryLabel([{ unified: false }, { unified: false }], t)).toBe('VRAM');
    expect(memoryLabel([{ unified: true }], t)).toBe('UMA');
    expect(memoryLabel([{ unified: true }, { unified: false }], t)).toBe('VRAM'); // a mix keeps the common name
  });
});
