import { isDesktop, mergeMonitorWindow, openMonitorWindow } from '@/desktop';
import { panelFits } from '@/lib/panel';
import { useDialogStore } from '@/stores/dialogStore';
import { useUiStore } from '@/stores/uiStore';

/**
 * The monitor button of an instance: opens the monitor the way it was last used (the panel beside the main view at first, or a window of its own).
 * Where there is no room for the panel, a panel becomes a page over the main view; in a browser (where a popup is often blocked, on a phone always)
 * a window too.
 */
export function showMonitor(id: number): void {
  const wantsPanel = useUiStore.getState().monitorMode === 'panel';
  if (wantsPanel || (!isDesktop() && !panelFits())) return openPanel(id);
  openMonitorWindow(id);
}

/** Opens the panel beside the main view (or, where the window is too narrow for that, the page the monitor is shown as). The window is never resized for it. */
export function openPanel(id: number): void {
  useDialogStore.getState().showMonitor(id);
}

/** Closes the panel (or the page the monitor was shown as). */
export function closePanel(): void {
  useDialogStore.getState().hideMonitor();
}

/** "Detach": the monitor of the panel goes to a window of its own, and the next monitor button opens a window. */
export function detachMonitor(id: number): void {
  const { panelSide, setMonitorMode } = useUiStore.getState();
  setMonitorMode('window');
  closePanel();
  openMonitorWindow(id, panelSide); // where the panel was: against that side of the main window
}

/** "Merge", from a monitor window: the monitor goes to the panel of the main window (opened by the shell, or by the page that opened this popup), and this window closes. */
export function mergeMonitor(id: number): void {
  useUiStore.getState().setMonitorMode('panel');
  mergeMonitorWindow(id);
}
