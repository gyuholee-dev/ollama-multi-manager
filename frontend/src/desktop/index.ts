// The desktop shell (Electron) offers a few extras through window.omm; in a plain browser there is none, so every
// function here has a web fallback. Nothing else in the app touches window.omm.

interface OmmBridge {
  desktop: true;
  customTitleBar?: boolean;
  overlayTitleBar?: boolean;
  headerHeight?: number;
  pickPath(kind: 'file' | 'dir', current: string): Promise<string | null>;
  settingsChanged(): void;
  openMonitor(id: number): void;
}

declare global {
  interface Window {
    omm?: OmmBridge;
    /** Used by the desktop shell's developer context menu. */
    __omm?: { isFrozen(): boolean; setFrozen(on: boolean): void };
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
 */
export function openMonitorWindow(id: number): void {
  if (window.omm?.openMonitor) { window.omm.openMonitor(id); return; }
  window.open(`${location.origin}${location.pathname}#monitor=${id}`, `omm-monitor-${id}`, 'popup,width=480,height=720');
}

/** The desktop shell on macOS hides the system title bar: the page's header is the drag region (see styles/_titlebar.scss). */
export const hasCustomTitleBar = (): boolean => !!window.omm?.customTitleBar;

/** The height of the header row the shell sized its window buttons for, in px (0 in a browser: the stylesheet's own value stands). */
export const shellHeaderHeight = (): number => window.omm?.headerHeight || 0;

/** Windows: the shell draws only the window buttons over the right end of the header, which leaves room for them. */
export const hasOverlayTitleBar = (): boolean => !!window.omm?.overlayTitleBar;
