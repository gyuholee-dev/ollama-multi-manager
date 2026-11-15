import { create } from 'zustand';

export interface LogLine {
  ts: number; // ms
  src: string; // "app" or an instance's name
  m: string;
  level: 'info' | 'warn';
}

/** A line as the store keeps it, with a number that stays with it: the page keeps each line's own element (and a selection in it) while other lines come and go. */
export interface StoredLine extends LogLine {
  id: number;
}

export const MAX_LOG_LINES = 500;

let seq = 0;
const numbered = (lines: LogLine[]): StoredLine[] => lines.map((l) => ({ ...l, id: ++seq }));

interface LogState {
  lines: StoredLine[];
  add: (line: LogLine) => void;
  set: (lines: LogLine[]) => void;
  /** Empties the lines of one source ("app" or an instance's name), or all of them for "all". What the backend kept is not touched. */
  clear: (src: string) => void;
}

export const useLogStore = create<LogState>((set, get) => ({
  lines: [],
  add: (line) => set({ lines: [...get().lines, ...numbered([line])].slice(-MAX_LOG_LINES) }),
  set: (lines) => set({ lines: numbered(lines.slice(-MAX_LOG_LINES)) }),
  clear: (src) => set({ lines: src === 'all' ? [] : get().lines.filter((l) => l.src !== src) }),
}));
