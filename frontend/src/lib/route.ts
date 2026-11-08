/** The page can show one instance's monitor on its own: the address then ends in #monitor=<id>. */
export function monitorIdFromHash(hash: string): number | null {
  const m = hash.match(/(?:^#|&)monitor=(\d+)(?:&|$)/);
  const id = m?.[1] ? Number(m[1]) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The address fragment without the session token (which is read once and must not stay in the address bar). */
export function withoutToken(hash: string): string {
  const rest = hash.replace(/^#/, '').split('&').filter((p) => p && !p.startsWith('token=')).join('&');
  return rest ? `#${rest}` : '';
}
