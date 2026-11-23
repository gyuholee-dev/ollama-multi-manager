import { useSyncExternalStore } from 'react';

/** The width of the monitor panel in px: that of a monitor window. */
export const PANEL_WIDTH = 480;
/** Below this viewport width the monitor panel is not a column beside the main view but covers it completely (the same width as the media query of the page panels in _views.scss). */
export const PANEL_FULL_BELOW = 768;

const QUERY = `(max-width: ${PANEL_FULL_BELOW - 0.02}px)`;

/** True when the monitor panel covers the whole main view (a viewport narrower than PANEL_FULL_BELOW); false when it is the column beside it. (A media query, not a resize
 * listener: it tells only when the width crosses the limit.) */
export const panelFull = (): boolean => window.matchMedia(QUERY).matches;

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

export const usePanelFull = (): boolean => useSyncExternalStore(subscribe, panelFull, () => false);
