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
  monOn: string[];
  imOn: string[]; // the kinds of information shown in the instance monitor window
  collapsed: SectionId[];

  setReady: () => void;
  setConnected: (up: boolean) => void;
  setFrozen: (on: boolean) => void;
  setStatus: (text: string) => void;
  setLogFilter: (name: string) => void;
  sortBy: (key: SortKey) => void;
  toggleSum: (id: string) => void;
  toggleMon: (id: string) => void;
  toggleIm: (id: string) => void;
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
      monOn: ['CPU', 'RAM', 'GPU', 'VRAM'],
      imOn: ['models', 'now', 'hour', 'live', 'recent'],
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
      toggleMon: (id) => set({ monOn: toggle(get().monOn, id) }),
      toggleIm: (id) => set({ imOn: toggle(get().imOn, id) }),
      toggleSection: (id) => set({ collapsed: toggle(get().collapsed, id) }),
    }),
    {
      name: 'omm-ui',
      partialize: (s) => ({ sortKey: s.sortKey, sortDir: s.sortDir, sumOn: s.sumOn, monOn: s.monOn, imOn: s.imOn, collapsed: s.collapsed }),
    },
  ),
);
