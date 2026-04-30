import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy /api requests to the local Hono server on :8787 so the browser
// only ever talks to the same origin and we never expose API keys.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      // IPFS pinning. Bridge accepts the raw WebM body and forwards to Pinata.
      '/pin': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
