/**
 * Sonoglyph bridge — Hono on Node + WebSocket + (Day 5) MCP server.
 *
 * Endpoints:
 *   GET  /health             keys + game stats
 *   WS   /ws                 game state, player → bridge ← agent
 *   POST /api/tts/stream     ElevenLabs streaming TTS (legacy day-3, kept
 *                            for the optional voice toggle)
 *   POST /api/kimi/journal   stub for now, real on day 5/6
 *   POST /api/agent/turn     legacy day-3 path; kept while we transition
 *
 * Day 4: WS + stub agent. Day 5: MCP server attached so Hermes can call
 *        place_layer as an MCP tool, replacing the stub.
 */

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../.env') });

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WebSocketServer } from 'ws';
import type { WebSocket as WSConn } from 'ws';

import { callHermes, type AgentContext, type ToolCall } from './agent.js';
import { getTtsConfig, streamTts } from './tts.js';
import { GameSession } from './game.js';
import type { ClientMessage, ServerMessage } from './protocol.js';

const PORT = Number(process.env.PROXY_PORT ?? 8787);
const ORIGIN = process.env.PROXY_ORIGIN ?? 'http://localhost:5173';

const app = new Hono();
app.use('*', cors({ origin: ORIGIN, credentials: true }));

// Single global session for the demo (one descent per running process).
const game = new GameSession();

// -----------------------------------------------------------------------------
app.get('/health', (c) => {
  const s = game.snapshot();
  return c.json({
    ok: true,
    service: 'sonoglyph-bridge',
    keys: {
      hermes: Boolean(process.env.HERMES_API_KEY),
      kimi: Boolean(process.env.KIMI_API_KEY),
      elevenlabs: Boolean(
        process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID,
      ),
    },
    game: {
      phase: s.phase,
      turnCount: s.turnCount,
      maxLayers: s.maxLayers,
      currentTurn: s.currentTurn,
      agentBusy: s.agentBusy,
    },
    time: Date.now(),
  });
});

// -----------------------------------------------------------------------------
// /api/tts/stream — kept from Day 3 for the optional voice toggle.
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
  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
  });
});

// -----------------------------------------------------------------------------
// Legacy day-3 endpoint, kept while the new flow is being verified.
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
    return c.json(
      { tool: { name: 'wait', arguments: {} }, source: 'error', error: message },
      200,
    );
  }
});

// -----------------------------------------------------------------------------
app.post('/api/kimi/journal', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const events = Array.isArray(body?.log) ? body.log.length : 0;
  return c.json({
    journal:
      `Field journal — placeholder.\n\n` +
      `${events} events recorded across the descent. ` +
      `The archivist has not yet been called; this text is a stand-in until Kimi wires up.`,
    word_count: 32,
    model: 'stub',
  });
});

// =============================================================================
// HTTP server + WebSocket upgrade
// =============================================================================

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[sonoglyph-bridge] listening on http://localhost:${info.port}`);
  console.log(`[sonoglyph-bridge] ws endpoint:  ws://localhost:${info.port}/ws`);
  console.log(`[sonoglyph-bridge] CORS origin: ${ORIGIN}`);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws: WSConn) => {
  console.log('[ws] client connected');

  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  // Subscribe this client to broadcasts.
  const unsubscribe = game.subscribe(send);

  // Send initial snapshot.
  send({ type: 'state', state: game.snapshot() });

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send({ type: 'error', message: 'invalid json' });
      return;
    }

    switch (msg.type) {
      case 'hello': {
        if (game.snapshot().phase === 'lobby') {
          game.start();
        }
        // Always re-send fresh state on hello (handles reconnects mid-game).
        send({ type: 'state', state: game.snapshot() });
        return;
      }
      case 'place_layer': {
        const result = game.playerPlace(msg.layerType, msg.position, msg.freq);
        if (!result.ok) {
          send({ type: 'error', message: result.error ?? 'place rejected' });
        }
        return;
      }
    }
  });

  ws.on('close', () => {
    console.log('[ws] client disconnected');
    unsubscribe();
  });

  ws.on('error', (err) => {
    console.error('[ws] error', err);
  });
});
