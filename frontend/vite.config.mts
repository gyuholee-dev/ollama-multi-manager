import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  resolve: { alias: { '@': `${root}src` } },
  build: { outDir: 'dist', emptyOutDir: true },
});
