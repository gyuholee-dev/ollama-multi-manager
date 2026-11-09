import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SortKey } from '@/lib/derive';

export type SectionId = 'sum' | 'mon' | 'inst' | 'logs';

interface UiState {
  // volatile
  ready: boolean; // the first load is over: the page may be shown
  connected: boolean;
  frozen: boolean; // developer aid: pushed updates are held back
  status: string; // footer text
  logFilter: string; // 'all', 'app' or an instance's name

  // preferences (kept in the browser)
  sortKey: SortKey;
  sortDir: 1 | -1;
  sumOn: string[];
  monOff: string[]; // system monitor boxes switched off (a box that is not listed is shown: a new GPU starts on)
  imHide: string[]; // the categories of the instance monitor window that are switched off
  imFold: string[]; // the sub-sections of the instance monitor window that are closed
  collapsed: SectionId[];

  setReady: () => void;
  setConnected: (up: boolean) => void;
  setFrozen: (on: boolean) => void;
  setStatus: (text: string) => void;
  setLogFilter: (name: string) => void;
  sortBy: (key: SortKey) => void;
  toggleSum: (id: string) => void;
  toggleMon: (id: string) => void;
  toggleImCat: (id: string) => void;
  toggleImFold: (id: string) => void;
  toggleSection: (id: SectionId) => void;
}

const toggle = <T,>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      ready: false,
      connected: false,
      frozen: false,
      status: '',
      logFilter: 'all',

      sortKey: 'name',
      sortDir: 1,
      sumOn: ['ins', 'usage'],
      monOff: [],
      imHide: [],
      imFold: [],
      collapsed: [],

      setReady: () => set({ ready: true }),
      setConnected: (connected) => set({ connected }),
      setFrozen: (frozen) => set({ frozen }),
      setStatus: (status) => set({ status }),
      setLogFilter: (logFilter) => set({ logFilter }),
      sortBy: (key) => {
        const { sortKey, sortDir } = get();
        set(sortKey === key ? { sortDir: (-sortDir) as 1 | -1 } : { sortKey: key, sortDir: 1 });
      },
      toggleSum: (id) => set({ sumOn: toggle(get().sumOn, id) }),
      toggleMon: (id) => set({ monOff: toggle(get().monOff, id) }),
      toggleImCat: (id) => set({ imHide: toggle(get().imHide, id) }),
      toggleImFold: (id) => set({ imFold: toggle(get().imFold, id) }),
      toggleSection: (id) => set({ collapsed: toggle(get().collapsed, id) }),
    }),
    {
      name: 'omm-ui',
      version: 1,
      // version 0 saved the boxes that were on; the choice for CPU and RAM carries over (GPU boxes are per GPU now and start on)
      migrate: (state, version) => {
        const s = state as { monOn?: string[]; monOff?: string[] };
        if (version < 1) {
          const on = Array.isArray(s.monOn) ? s.monOn : ['CPU', 'RAM'];
          s.monOff = ['CPU', 'RAM'].filter((k) => !on.includes(k));
          delete s.monOn;
        }
        return s as never;
      },
      partialize: (s) => ({ sortKey: s.sortKey, sortDir: s.sortDir, sumOn: s.sumOn, monOff: s.monOff, imHide: s.imHide, imFold: s.imFold, collapsed: s.collapsed }),
    },
  ),
);
