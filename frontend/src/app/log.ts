import { pushLog } from './live';

/** A message from the page itself (the backend's own messages arrive over the socket). */
export const log = (m: string): void => pushLog({ ts: Date.now(), src: 'app', m, level: 'info' });
