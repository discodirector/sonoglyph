/**
 * Sonoglyph proxy — Hono on Node.
 *
 * Hides API keys for Hermes / Kimi / ElevenLabs.
 * Day 1: skeleton + /health + /api/hermes/stream stub (fake SSE so frontend
 *        can wire up the streaming UX immediately). Real upstream calls land
 *        on Day 3 (Hermes), Day 5 (Kimi).
 */

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load root-level .env (one shared file for proxy + contracts + scripts).
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../.env') });

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';

const PORT = Number(process.env.PROXY_PORT ?? 8787);
const ORIGIN = process.env.PROXY_ORIGIN ?? 'http://localhost:5173';

const app = new Hono();

app.use('*', cors({ origin: ORIGIN, credentials: true }));

// -----------------------------------------------------------------------------
// Health — frontend pings this on boot to verify proxy reachable.
// -----------------------------------------------------------------------------
app.get('/health', (c) => {
  return c.json({
    ok: true,
    service: 'sonoglyph-proxy',
    keys: {
      hermes: Boolean(process.env.HERMES_API_KEY),
      kimi: Boolean(process.env.KIMI_API_KEY),
      elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
    },
    time: Date.now(),
  });
});

// -----------------------------------------------------------------------------
// /api/hermes/stream — STUB for Day 1.
// Accepts a context blob, returns a fake SSE stream of tool calls so we can
// build the frontend ingestion + TTS pipeline against a stable contract.
// Day 3: replaced with real Hermes streaming + tool use.
// -----------------------------------------------------------------------------
app.post('/api/hermes/stream', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const depth = typeof body?.depth === 'number' ? body.depth : 0;

  return streamSSE(c, async (stream) => {
    // Fake "thinking"
    await stream.writeSSE({ event: 'status', data: 'thinking' });
    await stream.sleep(400);

    // Fake tool call: narrate
    const text =
      depth < 100
        ? 'The surface is still close. Listen — that hum is your own breath caught between layers.'
        : depth < 500
        ? 'We are deeper now. The light here is older. Let one tone hold while you place the next.'
        : 'Pressure thickens. Whatever you place will be remembered by the stone.';

    await stream.writeSSE({
      event: 'tool_call',
      data: JSON.stringify({
        name: 'narrate',
        arguments: { text, mood: 'calm' },
      }),
    });

    await stream.writeSSE({ event: 'status', data: 'done' });
  });
});

// -----------------------------------------------------------------------------
// /api/kimi/journal — STUB for Day 1. Returns canned journal text.
// Day 5: replaced with real Kimi K2 long-context call.
// -----------------------------------------------------------------------------
app.post('/api/kimi/journal', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const events = Array.isArray(body?.log) ? body.log.length : 0;

  return c.json({
    journal:
      `Field journal — placeholder.\n\n` +
      `${events} events recorded across the descent. ` +
      `The archivist has not yet been called; this text is a stand-in until Day 5 wires Kimi K2.`,
    word_count: 32,
    model: 'stub',
  });
});

// -----------------------------------------------------------------------------
// /api/tts/stream — STUB for Day 1. Day 3: ElevenLabs streaming TTS.
// -----------------------------------------------------------------------------
app.post('/api/tts/stream', async (c) => {
  return c.json({ error: 'not implemented yet — Day 3' }, 501);
});

// -----------------------------------------------------------------------------
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[sonoglyph-proxy] listening on http://localhost:${info.port}`);
  console.log(`[sonoglyph-proxy] CORS origin: ${ORIGIN}`);
  console.log(
    `[sonoglyph-proxy] keys: hermes=${Boolean(process.env.HERMES_API_KEY)} ` +
      `kimi=${Boolean(process.env.KIMI_API_KEY)} ` +
      `tts=${Boolean(process.env.ELEVENLABS_API_KEY)}`,
  );
});
