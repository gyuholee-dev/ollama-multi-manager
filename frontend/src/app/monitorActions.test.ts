import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDialogStore } from '@/stores/dialogStore';
import { useUiStore } from '@/stores/uiStore';

// the desktop shell and the width of the viewport are what these tests stand in for
const desktop = vi.hoisted(() => ({ isDesktop: false, fits: true, calls: [] as string[] }));
vi.mock('@/desktop', () => ({
  isDesktop: () => desktop.isDesktop,
  openMonitorWindow: (id: number, dock?: string) => desktop.calls.push(dock ? `window ${id} ${dock}` : `window ${id}`),
  mergeMonitorWindow: (id: number) => desktop.calls.push(`merge ${id}`),
}));
vi.mock('@/lib/panel', () => ({ panelFits: () => desktop.fits }));

const { closePanel, detachMonitor, mergeMonitor, openPanel, showMonitor } = await import('./monitorActions');

beforeEach(() => {
  desktop.isDesktop = true; desktop.fits = true; desktop.calls.length = 0;
  useDialogStore.setState({ monitor: null });
  useUiStore.setState({ monitorMode: 'panel', panelSide: 'right' });
});

describe('detach from the panel on the left', () => {
  it('asks for the window to open on the left of the main window', () => {
    useUiStore.setState({ panelSide: 'left' });
    openPanel(2);
    detachMonitor(2);
    expect(desktop.calls).toEqual(['window 2 left']);
  });
});

describe('the monitor button', () => {
  it('opens the panel at first (the default way), and the window is not touched for it', () => {
    expect(useUiStore.getInitialState().monitorMode).toBe('panel');
    showMonitor(3);
    expect(desktop.calls).toEqual([]); // no window opened, no resizing
    expect(useDialogStore.getState().monitor).toBe(3);
  });
  it('opens a window of its own when that is how it was last used', () => {
    useUiStore.setState({ monitorMode: 'window' });
    showMonitor(3);
    expect(desktop.calls).toEqual(['window 3']);
    expect(useDialogStore.getState().monitor).toBeNull();
  });
  it('in a browser with no room beside the main view a window is not tried: the monitor opens in the main window (a popup is blocked on a phone)', () => {
    desktop.isDesktop = false; desktop.fits = false;
    useUiStore.setState({ monitorMode: 'window' });
    showMonitor(4);
    expect(desktop.calls).not.toContain('window 4');
    expect(useDialogStore.getState().monitor).toBe(4);
  });
  it('in a browser with room it opens a popup, as before', () => {
    desktop.isDesktop = false;
    useUiStore.setState({ monitorMode: 'window' });
    showMonitor(4);
    expect(desktop.calls).toEqual(['window 4']);
  });
});

describe('the panel', () => {
  it('holds one monitor at a time: opening another replaces it', () => {
    openPanel(1);
    openPanel(2);
    expect(useDialogStore.getState().monitor).toBe(2);
  });
  it('closing it leaves the window as it is', () => {
    openPanel(1);
    closePanel();
    expect(useDialogStore.getState().monitor).toBeNull();
    expect(desktop.calls).toEqual([]);
  });
  it('detach: the monitor goes to a window and the button opens windows from now on; merge: the other way', () => {
    openPanel(5);
    detachMonitor(5);
    expect(useUiStore.getState().monitorMode).toBe('window');
    expect(useDialogStore.getState().monitor).toBeNull();
    expect(desktop.calls).toEqual(['window 5 right']); // against the side the panel was on
    mergeMonitor(5);
    expect(useUiStore.getState().monitorMode).toBe('panel');
    expect(desktop.calls.at(-1)).toBe('merge 5');
  });
});
