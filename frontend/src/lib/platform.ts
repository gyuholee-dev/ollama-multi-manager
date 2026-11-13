/** The system the page runs on, as far as the page's look depends on it (<html data-platform="...">). */
export type Platform = 'mac' | 'win' | 'linux';

export const platformOf = (userAgent: string): Platform =>
  /Mac|iPhone|iPad/i.test(userAgent) ? 'mac' : /Win/i.test(userAgent) ? 'win' : 'linux';

/** From the browser's own user agent: the same for the desktop shell and for a browser that opens the web access address. */
export const detectPlatform = (): Platform => platformOf(typeof navigator === 'undefined' ? '' : navigator.userAgent);
