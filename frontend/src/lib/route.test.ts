import { describe, expect, it } from 'vitest';
import { monitorIdFromHash, withoutToken } from './route';

describe('route', () => {
  it('reads the instance of a monitor window from the address', () => {
    expect(monitorIdFromHash('#monitor=3')).toBe(3);
    expect(monitorIdFromHash('#token=abc&monitor=12')).toBe(12);
    expect(monitorIdFromHash('#monitor=3&token=abc')).toBe(3);
  });
  it('is not a monitor window without a valid id', () => {
    expect(monitorIdFromHash('')).toBeNull();
    expect(monitorIdFromHash('#token=abc')).toBeNull();
    expect(monitorIdFromHash('#monitor=0')).toBeNull();
    expect(monitorIdFromHash('#monitor=x')).toBeNull();
    expect(monitorIdFromHash('#xmonitor=4')).toBeNull();
  });
  it('removes only the token from the fragment', () => {
    expect(withoutToken('#token=abc')).toBe('');
    expect(withoutToken('#token=abc&monitor=3')).toBe('#monitor=3');
    expect(withoutToken('#monitor=3')).toBe('#monitor=3');
  });
});
