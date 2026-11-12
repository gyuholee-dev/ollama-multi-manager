import { create } from 'zustand';
import { api } from '@/api/client';
import type { InstalledModel, ModelDetail, ModelStorage } from '@/api/types';

interface ModelState {
  list: InstalledModel[];
  loaded: boolean; // the list has been fetched (or tried) at least once: what is shown may be a copy from earlier
  storage: ModelStorage | null; // what the models really take on disk (null until read, or when it cannot be)
  details: Record<string, ModelDetail>; // what Ollama says about a model, read when its card is opened
  /** Fetches the installed models and the disk they take. Throws when the list fails (the earlier list stays). */
  load: () => Promise<void>;
  /** Reads one model's details once (a later call finds it already there). Throws on failure. */
  loadDetail: (name: string) => Promise<void>;
  /** Forgets the stored details of models that changed. */
  forgetDetails: (...names: string[]) => void;
}

export const useModelStore = create<ModelState>((set, get) => ({
  list: [],
  loaded: false,
  storage: null,
  details: {},
  load: async () => {
    try {
      set({ list: await api.get<InstalledModel[]>('/models'), loaded: true });
    } catch (e) {
      set({ loaded: true });
      throw e;
    }
    try { set({ storage: await api.get<ModelStorage>('/models/storage') }); } catch { /* the window falls back to the sum of the list */ }
  },
  loadDetail: async (name) => {
    if (get().details[name]) return;
    const detail = await api.get<ModelDetail>(`/models/show?name=${encodeURIComponent(name)}`);
    set((s) => ({ details: { ...s.details, [name]: detail } }));
  },
  forgetDetails: (...names) => set((s) => ({ details: Object.fromEntries(Object.entries(s.details).filter(([k]) => !names.includes(k))) })),
}));
