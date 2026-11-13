import { describe, expect, it } from 'vitest';
import { platformOf } from './platform';

describe('platformOf', () => {
  it('tells macOS, Windows and Linux apart by the user agent', () => {
    expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152.0 Safari/537.36')).toBe('mac');
    expect(platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0 Safari/537.36')).toBe('win');
    expect(platformOf('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/152.0 Safari/537.36')).toBe('linux');
  });
  it('takes a phone or tablet of Apple as macOS and anything unknown as Linux', () => {
    expect(platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('mac');
    expect(platformOf('')).toBe('linux');
  });
});
