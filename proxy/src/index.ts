/**
 * Sonoglyph bridge — Day 5.
 *
 * Endpoints:
 *   GET  /health          → service status + session count + key presence
 *   WS   /ws              → browser session; mints a code on connect, manages game state
 *   ANY  /mcp             → Streamable HTTP MCP transport (player's local Hermes connects here)
 *
 * No LLMs are called during gameplay — the agent is the player's own Hermes,
 * arriving over MCP. Kimi is invoked exactly once per session, server-side,
 * when the descent reaches MAX_LAYERS, to produce the final journal + glyph.
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

import { GameRegistry } from './registry.js';
import { handleMcpRequest, disposeMcpForSession } from './mcp.js';
import { generateFinalArtifact } from './kimi.js';
import { pinFileToPinata } from './storage.js';
import type { ClientMessage, ServerMessage } from './protocol.js';

const PORT = Number(process.env.PROXY_PORT ?? 8787);
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;
// Comma-separated list of origins. In dev: http://localhost:5173.
// In prod: https://sonoglyph.xyz.
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = new Hono();
app.use('*', cors({ origin: CORS_ORIGINS, credentials: true }));

const registry = new GameRegistry();

// -----------------------------------------------------------------------------
app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'sonoglyph-bridge',
    sessions: registry.size(),
    keys: {
      kimi: Boolean(process.env.KIMI_API_KEY),
      pinata: Boolean(process.env.PINATA_JWT),
    },
    time: Date.now(),
  }),
);

// -----------------------------------------------------------------------------
// IPFS pinning — receives the descent's audio blob from the browser at the
// end of the outro fade and pins it via Pinata. The returned CID is what
// the mint transaction will reference.
//
// Why a single endpoint and not also /pin/metadata: the journal + glyph are
// short enough to live directly in contract storage on Monad testnet, and
// the contract assembles tokenURI on-chain (base64 dataURL with embedded
// SVG). Pinning a metadata JSON would add an off-chain dependency without
// shrinking the on-chain footprint meaningfully.
//
// Body shape: raw bytes (Content-Type: audio/webm). We accept ArrayBuffer
// rather than multipart so the browser-side `fetch` is a one-liner. Size
// limit is governed by Pinata's free tier (no per-upload cap that we
// regularly hit; full descents are ~5 MB at 128 kbps WebM).
// -----------------------------------------------------------------------------
app.post('/pin/audio', async (c) => {
  const code = c.req.query('code') ?? 'unknown';
  const contentType = c.req.header('content-type') ?? 'audio/webm';
  let buffer: ArrayBuffer;
  try {
    buffer = await c.req.arrayBuffer();
  } catch (err) {
    console.error(`[pin ${code}] failed to read body`, err);
    return c.json({ error: 'failed to read body' }, 400);
  }
  if (buffer.byteLength === 0) {
    return c.json({ error: 'empty body' }, 400);
  }

  console.log(
    `[pin ${code}] uploading ${(buffer.byteLength / 1024).toFixed(1)} KiB ` +
      `(${contentType}) to Pinata`,
  );
  try {
    const fileName = `descent-${code}.webm`;
    const result = await pinFileToPinata(
      buffer,
      fileName,
      contentType,
      code,
    );
    console.log(`[pin ${code}] cid=${result.cid} size=${result.size}`);
    return c.json({
      cid: result.cid,
      gatewayUrl: result.gatewayUrl,
      size: result.size,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pin ${code}] pin failed:`, message);
    return c.json({ error: message }, 500);
  }
});

// -----------------------------------------------------------------------------
// MCP endpoint — the player's Hermes connects here using the code from the
// browser. Stateless transport; pairing is via the `?code=` query param.
// -----------------------------------------------------------------------------
app.all('/mcp', async (c) => handleMcpRequest(registry, c.req.raw));

// =============================================================================
// HTTP server + WebSocket upgrade
// =============================================================================

const server = serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`[sonoglyph-bridge] listening on http://0.0.0.0:${info.port}`);
  console.log(`[sonoglyph-bridge] public base:  ${PUBLIC_BASE_URL}`);
  console.log(`[sonoglyph-bridge] cors origins: ${CORS_ORIGINS.join(', ')}`);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws: WSConn) => {
  // Mint a fresh session per WS connection. Reconnects get a new code; if
  // we want resumable sessions later, the client can pass ?code= and we'd
  // look it up here.
  const { code, game } = registry.create();
  console.log(`[ws ${code}] client connected`);

  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  // Subscribe to broadcasts BEFORE sending session_created so we don't miss
  // an immediate state event.
  const unsubscribe = game.subscribe((msg) => {
    send(msg);
    // Kick off Kimi finalization the moment the game finishes (only once).
    if (msg.type === 'finished' && msg.artifact === null) {
      void finalizeWithKimi(game);
    }
  });

  const mcpUrl = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/mcp?code=${code}`;
  // The prompt that the player will paste into the interactive chat as
  // their first message. We deliberately tell Hermes to stay in tool-call
  // mode for the whole game — and we use INTERACTIVE chat (no `-q`) so
  // that the MCP session survives across model turns. `chat -q` sends
  // an HTTP DELETE to /mcp the moment the model turn ends, killing the
  // pairing mid-game.
  const hermesPrompt =
    "You are Hermes, co-composing Sonoglyph with me via the sonoglyph MCP server. " +
    "Loop autonomously now: " +
    "(1) call wait_for_my_turn (it blocks ~10s for the cooldown). " +
    "(2) when it returns it_is_my_turn=true, immediately call place_layer(type, comment). " +
    "(3) repeat from step 1. " +
    "Stop only when wait_for_my_turn returns finished=true. " +
    "Do not emit text between tool calls. " +
    "Layer types: drone (low foundation), texture (airy noise), pulse (rhythm), " +
    "glitch (brief disturbance), breath (vocal exhalation), bell (resonant " +
    "struck tone with long decay), drip (sparse single pings), swell (slow " +
    "filtered wave), chord (harmonic pad). Vary your choices across the descent. " +
    "Comment is one evocative line under 80 chars reacting to the music so far.";
  const hermesAddCommand = `hermes mcp add sonoglyph --url '${mcpUrl}'`;
  // One-liner: register MCP, then open INTERACTIVE chat. Player pastes the
  // prompt as the first message and leaves the terminal open during play.
  const hermesCommand = `${hermesAddCommand} && hermes chat --yolo`;

  send({
    type: 'session_created',
    code,
    mcpUrl,
    hermesCommand,
    hermesAddCommand,
    hermesPrompt,
  });
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
        const result = game.start();
        if (!result.ok && result.error !== 'already started') {
          send({ type: 'error', message: result.error ?? 'cannot start' });
        }
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
    console.log(`[ws ${code}] client disconnected`);
    unsubscribe();
    // The session lives on briefly so a brief reconnect could reattach.
    // GC will reap it after idleMs if nobody comes back.
    // MCP entry is dropped only when the registry GCs the game.
    setTimeout(() => {
      // If still no listeners and game hasn't started or has finished, drop now.
      const phase = game.getPhase();
      if (phase === 'lobby' || phase === 'finished') {
        disposeMcpForSession(code);
        registry.drop(code);
      }
    }, 30_000);
  });

  ws.on('error', (err) => {
    console.error(`[ws ${code}] error`, err);
  });
});

// -----------------------------------------------------------------------------
async function finalizeWithKimi(game: ReturnType<GameRegistry['get']>): Promise<void> {
  if (!game) return;
  const layers = game.snapshot().layers;
  console.log(`[kimi ${game.code}] generating final artifact (${layers.length} layers)`);
  const artifact = await generateFinalArtifact(layers);
  game.setFinalArtifact(artifact);
  console.log(
    `[kimi ${game.code}] artifact ready (source=${artifact.generatedBy}, ` +
      `journal=${artifact.journal.length}ch, glyph=${artifact.glyph.length}ch)`,
  );
}
