// The desktop shell (Electron) offers a few extras through window.omm; in a plain browser there is none, so every
// function here has a web fallback. Nothing else in the app touches window.omm.

interface OmmBridge {
  desktop: true;
  customTitleBar?: boolean;
  overlayTitleBar?: boolean;
  headerHeight?: number;
  pickPath(kind: 'file' | 'dir', current: string): Promise<string | null>;
  settingsChanged(): void;
  openMonitor(id: number, dock?: 'left' | 'right'): void;
  /** Tells the shell which instance's monitor the panel shows now (null: none), for the shell's own use (the screenshots of the MCP server). */
  panelShows(id: number | null): void;
  /** A monitor window asks to be merged into the main window's panel: the shell has the main window show it, then closes that window. */
  mergeMonitor(id: number): void;
  /** The shell asks the page to show a monitor in the panel (a monitor window was merged). Returns what stops listening. */
  onShowPanel(callback: (id: number) => void): () => void;
}

declare global {
  interface Window {
    omm?: OmmBridge;
    /** Used by the desktop shell's developer context menu. */
    __omm?: { isFrozen(): boolean; setFrozen(on: boolean, quiet?: boolean): void; status(text: string): void };
  }
}

export const isDesktop = (): boolean => !!window.omm?.desktop;

/** Asks for a file or folder path; null when cancelled. In a browser the user types it. */
export async function pickPath(kind: 'file' | 'dir', current: string, label: string): Promise<string | null> {
  if (window.omm?.pickPath) return window.omm.pickPath(kind, current);
  const typed = window.prompt(label, current);
  return typed === null || typed === '' ? null : typed;
}

/** Tells the shell that settings changed so it can apply tray, launch at login and theme. */
export const notifySettingsChanged = (): void => window.omm?.settingsChanged();

/**
 * Opens the monitor of an instance in a window of its own. The desktop shell makes a window (one per instance);
 * in a browser a named popup does, so a second click on the same instance brings the same window back.
 * `dock`: detached from the panel on that side of the main window: the shell opens the window against that side (and forgets where the window was before).
 */
export function openMonitorWindow(id: number, dock?: 'left' | 'right'): void {
  if (window.omm?.openMonitor) { window.omm.openMonitor(id, dock); return; }
  window.open(`${location.origin}${location.pathname}#monitor=${id}`, `omm-monitor-${id}`, 'popup,width=480,height=720');
}

/** The desktop shell on macOS hides the system title bar: the page's header is the drag region (see styles/_titlebar.scss). */
export const hasCustomTitleBar = (): boolean => !!window.omm?.customTitleBar;

/** The height of the header row the shell sized its window buttons for, in px (0 in a browser: the stylesheet's own value stands). */
export const shellHeaderHeight = (): number => window.omm?.headerHeight || 0;

/** Windows: the shell draws only the window buttons over the right end of the header, which leaves room for them. */
export const hasOverlayTitleBar = (): boolean => !!window.omm?.overlayTitleBar;

/** Tells the shell which monitor the panel shows now. */
export const panelShows = (id: number | null): void => window.omm?.panelShows?.(id);

/**
 * "Merge" from a monitor window: the main window shows the monitor in its panel and this window closes. In the shell the shell does it; in a browser the popup
 * tells the page that opened it (same origin) and closes itself.
 */
export function mergeMonitorWindow(id: number): void {
  if (window.omm?.mergeMonitor) { window.omm.mergeMonitor(id); return; }
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage({ omm: 'show-monitor-panel', id }, location.origin);
    window.close();
  }
}

/** True where a monitor window can be merged into a panel: in the shell, and in a popup that has a page behind it. */
export const canMergeMonitor = (): boolean => !!window.omm?.mergeMonitor || !!(window.opener && !window.opener.closed);

/** Listens for the request to show a monitor in the panel (from the shell, or from a monitor popup of this site). Returns what stops listening. */
export function onShowPanel(callback: (id: number) => void): () => void {
  const stopShell = window.omm?.onShowPanel?.(callback);
  const onMessage = (e: MessageEvent) => {
    const data = e.data as { omm?: string; id?: number } | null;
    if (e.origin === location.origin && data?.omm === 'show-monitor-panel' && Number.isInteger(data.id)) callback(data.id as number);
  };
  window.addEventListener('message', onMessage);
  return () => { stopShell?.(); window.removeEventListener('message', onMessage); };
}
