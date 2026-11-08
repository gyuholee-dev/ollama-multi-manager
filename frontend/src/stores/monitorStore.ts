import { create } from 'zustand';
import type { Info, Snapshot } from '@/api/types';

interface MonitorState {
  info: Info | null;
  snap: Snapshot | null;
  setInfo: (info: Info | null) => void;
  setSnap: (snap: Snapshot | null) => void;
}

export const useMonitorStore = create<MonitorState>((set) => ({
  info: null,
  snap: null,
  setInfo: (info) => set({ info }),
  setSnap: (snap) => set({ snap }),
}));

/**
 * Whether this page is a read-only guest page. Until the server has said which kind of page it is, treat it as a
 * guest: nothing is offered before it is known.
 */
export const isGuestInfo = (info: Info | null): boolean => info?.guest !== false;
export const useIsGuest = (): boolean => useMonitorStore((s) => isGuestInfo(s.info));
export const isGuest = (): boolean => isGuestInfo(useMonitorStore.getState().info);
