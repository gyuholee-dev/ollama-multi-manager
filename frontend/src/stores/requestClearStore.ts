import { create } from 'zustand';

/** "Clear" on an instance's recent-request list hides what is there now; the journal on disk is not touched. */
interface State {
  /** per instance: requests at or before this time (seconds) are hidden */
  clearedAt: Record<number, number>;
  clear: (iid: number, upTo: number) => void;
}

export const useRequestClearStore = create<State>((set) => ({
  clearedAt: {},
  clear: (iid, upTo) => set((s) => ({ clearedAt: { ...s.clearedAt, [iid]: Math.max(upTo, s.clearedAt[iid] ?? 0) } })),
}));
