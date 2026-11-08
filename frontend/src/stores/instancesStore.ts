import { create } from 'zustand';
import { api } from '@/api/client';
import type { Instance } from '@/api/types';

interface InstancesState {
  list: Instance[];
  set: (list: Instance[]) => void;
  /** Fetches the list again. Throws on failure. */
  load: () => Promise<void>;
  /** Several "instance changed" events arrive in a burst; one fetch after they settle is enough. */
  loadSoon: () => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

export const useInstancesStore = create<InstancesState>((set, get) => ({
  list: [],
  set: (list) => set({ list }),
  load: async () => set({ list: await api.get<Instance[]>('/instances') }),
  loadSoon: () => {
    clearTimeout(timer);
    timer = setTimeout(() => { get().load().catch(() => { /* the connection status already says it */ }); }, 100);
  },
}));
