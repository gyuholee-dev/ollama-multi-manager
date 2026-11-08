import { describe, expect, it } from 'vitest';
import { GiB, gb } from './units';

describe('gb', () => {
  it('converts bytes to GiB', () => {
    expect(gb(GiB)).toBe(1);
    expect(gb(3 * GiB)).toBe(3);
  });
  it('treats a missing value as zero', () => {
    expect(gb(undefined)).toBe(0);
    expect(gb(null)).toBe(0);
  });
});
