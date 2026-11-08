import { create } from 'zustand';
import type { PullTask } from '@/api/types';

interface PullState {
  tasks: Record<string, PullTask>;
  upsert: (task: PullTask) => void;
  remove: (id: string) => void;
  setAll: (list: PullTask[]) => void;
}

export const usePullStore = create<PullState>((set, get) => ({
  tasks: {},
  upsert: (task) => set({ tasks: { ...get().tasks, [task.id]: task } }),
  remove: (id) => {
    const { [id]: _gone, ...rest } = get().tasks;
    set({ tasks: rest });
  },
  setAll: (list) => set({ tasks: Object.fromEntries(list.map((x) => [x.id, x])) }),
}));

/** Downloads that are not finished (running, paused or failed), oldest first. */
export const unfinished = (tasks: Record<string, PullTask>): PullTask[] =>
  Object.values(tasks).filter((x) => x.status !== 'success').sort((a, b) => a.started_at - b.started_at);
