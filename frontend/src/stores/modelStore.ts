import { create } from 'zustand';
import { api } from '@/api/client';
import type { InstalledModel } from '@/api/types';

interface ModelState {
  list: InstalledModel[];
  loaded: boolean; // the list has been fetched (or tried) at least once: what is shown may be a copy from earlier
  /** Fetches the installed models. Throws on failure (the earlier list stays). */
  load: () => Promise<void>;
}

export const useModelStore = create<ModelState>((set) => ({
  list: [],
  loaded: false,
  load: async () => {
    try {
      set({ list: await api.get<InstalledModel[]>('/models'), loaded: true });
    } catch (e) {
      set({ loaded: true });
      throw e;
    }
  },
}));
