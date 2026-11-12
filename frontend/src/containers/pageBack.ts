import { useEffect, useRef } from 'react';

// what the page in view does with Escape before the page itself goes back: it answers true when it took the key
// (the models page: from its edit screen to its list)
let inner: (() => boolean) | null = null;

/** Lets the page in view handle Escape first. The handler answers whether it did. */
export function usePageBack(handler: () => boolean): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    inner = () => latest.current();
    return () => { inner = null; };
  }, []);
}

/** True when the page in view took the Escape key. */
export const pageHandledBack = (): boolean => inner?.() ?? false;
