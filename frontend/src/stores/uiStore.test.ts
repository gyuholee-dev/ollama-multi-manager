import { describe, expect, it } from 'vitest';
import { useUiStore } from './uiStore';

describe('uiStore', () => {
  it('starts with every system monitor box on, and a box is switched off by listing it', () => {
    expect(useUiStore.getState().monOff).toEqual([]);
    useUiStore.getState().toggleMon('GPU-1');
    expect(useUiStore.getState().monOff).toEqual(['GPU-1']);
    useUiStore.getState().toggleMon('GPU-1');
    expect(useUiStore.getState().monOff).toEqual([]);
  });

  it('carries the old choice of boxes over: CPU and RAM keep theirs, the GPU boxes start on', () => {
    const migrate = useUiStore.persist.getOptions().migrate!;
    expect(migrate({ monOn: ['CPU', 'GPU', 'VRAM'], sumOn: ['ins'] }, 0)).toEqual({ monOff: ['RAM'], sumOn: ['ins'] });
    expect(migrate({}, 0)).toEqual({ monOff: [] });
  });
});
