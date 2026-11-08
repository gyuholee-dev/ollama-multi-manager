import { create } from 'zustand';
import { api } from '@/api/client';
import type { InstalledModel } from '@/api/types';

interface ModelState {
  list: InstalledModel[];
  loaded: boolean; // the list has been fetched at least once since the window was opened
  /** Fetches the installed models. Throws on failure (the list is then empty). */
  load: () => Promise<void>;
  reset: () => void;
}

export const useModelStore = create<ModelState>((set) => ({
  list: [],
  loaded: false,
  load: async () => {
    try {
      set({ list: await api.get<InstalledModel[]>('/models'), loaded: true });
    } catch (e) {
      set({ list: [], loaded: true });
      throw e;
    }
  },
  reset: () => set({ list: [], loaded: false }),
}));
