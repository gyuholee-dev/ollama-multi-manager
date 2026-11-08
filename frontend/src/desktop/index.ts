// The desktop shell (Electron) offers a few extras through window.omm; in a plain browser there is none, so every
// function here has a web fallback. Nothing else in the app touches window.omm.

interface OmmBridge {
  desktop: true;
  pickPath(kind: 'file' | 'dir'): Promise<string | null>;
  settingsChanged(): void;
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
  if (window.omm?.pickPath) return window.omm.pickPath(kind);
  const typed = window.prompt(label, current);
  return typed === null || typed === '' ? null : typed;
}

/** Tells the shell that settings changed so it can apply tray, launch at login and theme. */
export const notifySettingsChanged = (): void => window.omm?.settingsChanged();
