// Tests run in Node, which has no window and no localStorage; the UI store keeps its preferences there (zustand looks it
// up as window.localStorage). An in-memory stand-in keeps the store working (and quiet) in tests.
(globalThis as { window?: unknown }).window ??= globalThis;
const data = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  },
});
