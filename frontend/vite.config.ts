import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

// While developing, run the backend yourself (e.g. `OMM_TOKEN=dev python -m app --port 8765` in backend/) and open
// http://127.0.0.1:5174/#token=dev ; the dev server forwards the API and the WebSocket to it, so the page is same-origin.
const backend = process.env.OMM_DEV_BACKEND ?? 'http://127.0.0.1:8765';
const api = '^/(info|settings|instances|models|pulls|logs|monitor|health|metrics|shutdown)(/|\\?|$)';

export default defineConfig({
  root,
  plugins: [react()],
  resolve: { alias: { '@': `${root}src` } },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      [api]: { target: backend, changeOrigin: false },
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
});
