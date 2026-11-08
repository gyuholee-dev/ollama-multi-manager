import { create } from 'zustand';

export interface LogLine {
  ts: number; // ms
  src: string; // "app" or an instance's name
  m: string;
  level: 'info' | 'warn';
}

export const MAX_LOG_LINES = 500;

interface LogState {
  lines: LogLine[];
  add: (line: LogLine) => void;
  set: (lines: LogLine[]) => void;
}

export const useLogStore = create<LogState>((set, get) => ({
  lines: [],
  add: (line) => set({ lines: [...get().lines, line].slice(-MAX_LOG_LINES) }),
  set: (lines) => set({ lines: lines.slice(-MAX_LOG_LINES) }),
}));
