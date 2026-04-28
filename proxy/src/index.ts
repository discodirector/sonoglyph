/**
 * Sonoglyph proxy — Hono on Node.
 *
 * Hides API keys for Hermes / Kimi / ElevenLabs.
 *
 * Day 3:
 *   /api/agent/turn    real Hermes call (OpenAI-compatible) with tool use,
 *                      stub fallback when HERMES_API_KEY is missing.
 *   /api/tts/stream    real ElevenLabs streaming TTS, 501 when no key.
 *
 * Day 5 will wire /api/kimi/journal to Kimi K2.
 */

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../.env') });

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { callHermes, type AgentContext, type ToolCall } from './agent.js';
import { getTtsConfig, streamTts } from './tts.js';

const PORT = Number(process.env.PROXY_PORT ?? 8787);
const ORIGIN = process.env.PROXY_ORIGIN ?? 'http://localhost:5173';

const app = new Hono();

app.use('*', cors({ origin: ORIGIN, credentials: true }));

// -----------------------------------------------------------------------------
// Health
// -----------------------------------------------------------------------------
app.get('/health', (c) => {
  return c.json({
    ok: true,
    service: 'sonoglyph-proxy',
    keys: {
      hermes: Boolean(process.env.HERMES_API_KEY),
      kimi: Boolean(process.env.KIMI_API_KEY),
      elevenlabs: Boolean(
        process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID,
      ),
    },
    time: Date.now(),
  });
});

// -----------------------------------------------------------------------------
// /api/agent/turn — single agent turn given session context.
//
// Body: AgentContext (see ./agent.ts)
// Response: { tool: ToolCall, source: 'hermes' | 'stub' }
// -----------------------------------------------------------------------------
app.post('/api/agent/turn', async (c) => {
  let ctx: AgentContext;
  try {
    ctx = (await c.req.json()) as AgentContext;
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  try {
    const tool: ToolCall = await callHermes(ctx);
    return c.json({
      tool,
      source: process.env.HERMES_API_KEY ? 'hermes' : 'stub',
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown';
    console.error('[agent] error:', message);
    return c.json(
      { tool: { name: 'wait', arguments: {} }, source: 'error', error: message },
      200,
    );
  }
});

// -----------------------------------------------------------------------------
// /api/tts/stream — pipe ElevenLabs audio bytes back to browser.
//
// Body: { text: string, mood?: 'calm'|'ominous'|'wonder'|'warning' }
// Response: audio/mpeg stream
// -----------------------------------------------------------------------------
app.post('/api/tts/stream', async (c) => {
  const cfg = getTtsConfig();
  if (!cfg) {
    return c.json(
      {
        error:
          'TTS unavailable — set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env',
      },
      501,
    );
  }

  let body: { text?: string; mood?: 'calm' | 'ominous' | 'wonder' | 'warning' };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  const text = (body.text ?? '').trim();
  if (!text) return c.json({ error: 'text required' }, 400);

  const upstream = await streamTts(cfg, { text, mood: body.mood });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '<no body>');
    console.error('[tts] elevenlabs error', upstream.status, errText.slice(0, 300));
    return c.json(
      { error: `elevenlabs ${upstream.status}`, body: errText.slice(0, 500) },
      502,
    );
  }

  // Pipe upstream body straight through. ElevenLabs streams chunked mp3.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
    },
  });
});

// -----------------------------------------------------------------------------
// /api/kimi/journal — STUB for Day 1-4. Day 5: real Kimi K2.
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
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[sonoglyph-proxy] listening on http://localhost:${info.port}`);
  console.log(`[sonoglyph-proxy] CORS origin: ${ORIGIN}`);
  console.log(
    `[sonoglyph-proxy] keys: hermes=${Boolean(process.env.HERMES_API_KEY)} ` +
      `kimi=${Boolean(process.env.KIMI_API_KEY)} ` +
      `tts=${Boolean(
        process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID,
      )}`,
  );
});
