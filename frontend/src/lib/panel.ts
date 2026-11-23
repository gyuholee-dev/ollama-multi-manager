import { useSyncExternalStore } from 'react';

/** The width of the monitor panel in px: that of a monitor window. */
export const PANEL_WIDTH = 480;
/** The narrowest viewport that has room for the panel beside the main view, which keeps at least as much (the desktop window is never narrower than this). */
export const PANEL_MIN_VIEWPORT = 2 * PANEL_WIDTH;

const QUERY = `(min-width: ${PANEL_MIN_VIEWPORT}px)`;

/** True when the viewport is wide enough for the monitor panel beside the main view. (A media query, not a resize listener: it tells only when the width crosses the limit.) */
export const panelFits = (): boolean => window.matchMedia(QUERY).matches;

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

export const usePanelFits = (): boolean => useSyncExternalStore(subscribe, panelFits, () => true);
