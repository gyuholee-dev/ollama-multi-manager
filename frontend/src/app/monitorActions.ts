import { isDesktop, mergeMonitorWindow, openMonitorWindow } from '@/desktop';
import { panelFull } from '@/lib/panel';
import { useDialogStore } from '@/stores/dialogStore';
import { useUiStore } from '@/stores/uiStore';

/**
 * The monitor button of an instance: opens the monitor the way it was last used (the panel beside the main view at first, or a window of its own).
 * The panel is always a panel (below 768 px wide it covers the main view); in a browser a narrow viewport (where a popup is often blocked, on a phone always) opens
 * it as the panel, not as a window.
 */
export function showMonitor(id: number): void {
  const wantsPanel = useUiStore.getState().monitorMode === 'panel';
  if (wantsPanel || (!isDesktop() && panelFull())) return openPanel(id);
  openMonitorWindow(id);
}

/** Opens the panel beside the main view (or, below 768 px, covering it). The window is never resized for it. */
export function openPanel(id: number): void {
  useDialogStore.getState().showMonitor(id);
}

/** Closes the panel. */
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
