import { describe, expect, it } from 'vitest';
import { GiB, fileSize, gb, gbDecimal, sizeBoth, sizeText, sizeTitle } from './units';

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

describe('gbDecimal', () => {
  it('converts bytes to GB of 10^9 bytes', () => {
    expect(gbDecimal(8e9)).toBe(8);
    expect(gbDecimal(undefined)).toBe(0);
  });
});

describe('fileSize', () => {
  it('shows a model in GB (10^9 bytes) and in GiB (2^30 bytes)', () => {
    expect(fileSize(8021618941)).toEqual({ main: '8.0 GB', alt: '7.5 GiB' });
    expect(sizeBoth(8021618941)).toBe('8.0 GB (7.5 GiB)');
  });
  it('switches to MB below 1 GB, the way `ollama list` does', () => {
    expect(fileSize(986060385)).toEqual({ main: '986 MB', alt: '940 MiB' });
    expect(sizeBoth(986060385)).toBe('986 MB (940 MiB)');
    expect(fileSize(1e9)).toEqual({ main: '1.0 GB', alt: '954 MiB' });
  });
  it('does not show 1000 MB', () => {
    expect(fileSize(999999999).main).toBe('1.0 GB');
  });
  it('shows bytes below 1 MB, and no second value', () => {
    expect(fileSize(0)).toEqual({ main: '0 B', alt: '' });
    expect(sizeBoth(null)).toBe('0 B');
    expect(sizeBoth(500000)).toBe('500000 B');
  });
  it('gives the short text and the title for a tight place', () => {
    expect(sizeText(8021618941)).toBe('8.0 GB');
    expect(sizeTitle(8021618941)).toBe('7.5 GiB');
    expect(sizeTitle(0)).toBeUndefined();
  });
});
