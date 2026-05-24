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
      // On-chain mint. Bridge signs + broadcasts the mintDescent tx.
      '/mint': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      // Atlas page data — full minted-token scan, cached server-side.
      '/collection': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      // Mint supply counter — used by Finale before/after mint.
      '/supply': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      // OG share-card PNGs. The crawler-facing meta-injection at
      // /atlas/:id is NOT proxied in dev because Vite's index.html
      // catch-all lets the SPA hydrate normally; meta injection only
      // matters for production crawlers and is hit-tested via curl
      // against the bridge port directly.
      '/og': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      // Per-token MP4 (PNG + audio). Used by the "Download Video" button
      // for manual upload to X / Bluesky, and by og:video crawlers like
      // Discord/Telegram for inline preview playback.
      '/video': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      // Frontend feature flags (share button gate, etc).
      '/config': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
