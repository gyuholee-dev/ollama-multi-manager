import { describe, expect, it } from 'vitest';
import { translate } from '@/locales';
import { compareModels, derivedFrom, fmtCtx, fmtKeep, fmtUp, memoryLabel, modelInfo, quantOf, splitModel } from './format';

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

  it('prefers what Ollama reports about the model to what its tag says', () => {
    const details = { parameter_size: '11.9B', quantization_level: 'Q4_K_M' };
    expect(modelInfo('12b-it-q4_K_M', en, details)).toBe(en('mdl.param', { p: '11.9B', q: 'Q4_K_M' }));
    expect(modelInfo('1.5b-gpu', en, { parameter_size: '1.5B', quantization_level: 'Q4_K_M' })).toBe(en('mdl.param', { p: '1.5B', q: 'Q4_K_M' }));
    expect(modelInfo('1.5b-base', en, { parameter_size: '', quantization_level: 5 })).toBe(en('mdl.param', { p: '1.5B', q: '-' })); // not given: the tag
  });

  it('finds the model a tag was derived from, and ignores a file as parent', () => {
    expect(derivedFrom({ parent_model: 'qwen2.5-coder:1.5b-base' })).toBe('qwen2.5-coder:1.5b-base');
    expect(derivedFrom({ parent_model: 'imatrix-20260927-12b/model-q4_K_M.gguf' })).toBe('');
    expect(derivedFrom({ parent_model: 'D:\\models\\x.gguf' })).toBe('');
    expect(derivedFrom({ parent_model: '' })).toBe('');
    expect(derivedFrom(undefined)).toBe('');
  });

  it('reads the quantization from the details, else from the tag', () => {
    expect(quantOf('x:1b-gpu', { quantization_level: 'Q4_K_M' })).toBe('Q4_K_M');
    expect(quantOf('qwen3:8b-q8_0')).toBe('Q8_0');
    expect(quantOf('x:latest')).toBe('');
  });

  it('orders the models of a family by quantization, the original first within one', () => {
    const q4 = { quantization_level: 'Q4_K_M' };
    const models = [
      { name: 'f:b-gpu', details: { ...q4, parent_model: 'f:b' } },
      { name: 'f:fp16', details: { quantization_level: 'F16' } },
      { name: 'f:b', details: q4 },
      { name: 'f:q8', details: { quantization_level: 'Q8_0' } },
      { name: 'f:a-code', details: { ...q4, parent_model: 'f:b' } },
      { name: 'f:none', details: {} },
    ];
    expect(models.sort(compareModels).map((m) => m.name)).toEqual(['f:b', 'f:a-code', 'f:b-gpu', 'f:q8', 'f:fp16', 'f:none']);
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
