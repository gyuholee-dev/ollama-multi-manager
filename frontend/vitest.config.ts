import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Tests run on their own config: vitest ships its own copy of Vite, so it does not share vite.config.mts.
export default defineConfig({
  root,
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  test: { environment: 'node', include: ['src/**/*.test.{ts,tsx}'], setupFiles: ['src/test/setup.ts'] },
});
