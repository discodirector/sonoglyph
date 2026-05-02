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
import { chainConfigStatus, mintSonoglyph, getSupplyInfo } from './chain.js';
import { isAddress } from 'viem';
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
app.get('/health', (c) => {
  const chain = chainConfigStatus();
  return c.json({
    ok: true,
    service: 'sonoglyph-bridge',
    sessions: registry.size(),
    keys: {
      kimi: Boolean(process.env.KIMI_API_KEY),
      pinata: Boolean(process.env.PINATA_JWT),
      // Mint-readiness: both keys must be set AND the contract address must
      // pass viem's isAddress check. Surfaced so the frontend can hide the
      // mint button when the bridge can't honour it.
      mint: chain.hasPrivateKey && chain.hasContract,
    },
    chain: {
      contract: chain.contractAddress,
      chainId: chain.chainId,
      rpcUrl: chain.rpcUrl,
    },
    time: Date.now(),
  });
});

// -----------------------------------------------------------------------------
// Supply snapshot — backs the Finale screen's "EDITION X / 250" counter.
//
// Cached for 15 s so a burst of Finale mounts (e.g. multiple players hitting
// the mint screen simultaneously) doesn't hammer the RPC. lastTokenId only
// changes on successful mint, so a 15 s window is plenty fresh — the player
// who just minted gets their new tokenId from the /mint response directly,
// not from /supply, and the Finale UI optimistically increments after a
// successful mint anyway.
//
// Failure mode: if the chain is unreachable (RPC down, contract not yet
// deployed, etc.), returns 503 with the error. The frontend treats this as
// "supply unknown" and just hides the counter — the mint button still
// works, since the contract enforces the cap regardless of UI hints.
// -----------------------------------------------------------------------------
let supplyCache: { value: { minted: number; max: number }; expiresAt: number } | null = null;
const SUPPLY_CACHE_TTL_MS = 15_000;

app.get('/supply', async (c) => {
  const now = Date.now();
  if (supplyCache && supplyCache.expiresAt > now) {
    return c.json({ ...supplyCache.value, cached: true });
  }
  try {
    const value = await getSupplyInfo();
    supplyCache = { value, expiresAt: now + SUPPLY_CACHE_TTL_MS };
    return c.json({ ...value, cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[supply] read failed:', message);
    return c.json({ error: message }, 503);
  }
});

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

    // Persist the CID into the GameSession (if one exists for this code)
    // so /mint can pull it without trusting the client. Sessions disappear
    // ~30 s after WS close, so we tolerate the lookup failing — pinning
    // succeeded either way and the client's response has the CID for
    // out-of-band verification.
    const game = registry.get(code);
    if (game) {
      game.setAudioCid(result.cid);
    } else {
      console.warn(`[pin ${code}] session not found — CID not persisted`);
    }

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
// Mint — sign + broadcast a Sonoglyph.mintDescent transaction from the
// bridge's wallet, on behalf of `playerAddress`. The bridge is the contract's
// sole authorized minter (see chain.ts), which lets players claim their NFT
// without paying gas or holding testnet MON.
//
// Authoritative inputs (server-side, NOT trusted from the client):
//   - glyph + journal      live on the GameSession after Kimi finalization
//   - audioCid             written to GameSession by /pin/audio
//   - sessionCode          the URL ?code=... param itself
//
// Client-supplied input (the only thing we accept from the body):
//   - playerAddress        EIP-55 address; viem's isAddress validates it
//
// Idempotency: GameSession.isMinted() locks after the first successful mint.
// A second click on the same code returns the cached { tokenId, txHash }
// instead of producing a duplicate token.
// -----------------------------------------------------------------------------
app.post('/mint', async (c) => {
  const code = c.req.query('code');
  if (!code) {
    return c.json({ error: 'missing ?code= query parameter' }, 400);
  }
  const game = registry.get(code);
  if (!game) {
    return c.json({ error: `unknown session: ${code}` }, 404);
  }

  let body: { playerAddress?: unknown };
  try {
    body = (await c.req.json()) as { playerAddress?: unknown };
  } catch {
    return c.json({ error: 'invalid json body' }, 400);
  }
  const playerAddress = body.playerAddress;
  if (typeof playerAddress !== 'string' || !isAddress(playerAddress)) {
    return c.json(
      {
        error: 'playerAddress must be a valid 0x-prefixed EIP-55 address',
      },
      400,
    );
  }

  // Already minted? Return the cached result so the UI lands on the success
  // state regardless of whether this is a retry, a stale request, or a tab
  // re-open.
  const existing = game.getMintResult();
  if (existing) {
    console.log(
      `[mint ${code}] already minted (token=${existing.tokenId}, ` +
        `tx=${existing.txHash}) — returning cached result`,
    );
    return c.json({
      tokenId: existing.tokenId,
      txHash: existing.txHash,
      contractAddress: chainConfigStatus().contractAddress,
      chainId: chainConfigStatus().chainId,
      cached: true,
    });
  }

  // Pre-flight: do we have everything we need?
  if (game.getPhase() !== 'finished') {
    return c.json(
      {error: 'session not finished yet (descent still in progress)'},
      409,
    );
  }
  const payload = game.getMintPayload();
  if (!payload) {
    const audioCid = game.getAudioCid();
    return c.json(
      {
        error: !audioCid
          ? 'audio not pinned to IPFS yet — wait for PRESERVED status'
          : 'artifact not ready yet — Kimi is still composing',
      },
      409,
    );
  }
  const cfg = chainConfigStatus();
  if (!cfg.hasPrivateKey || !cfg.hasContract) {
    return c.json(
      {
        error:
          'bridge mint config incomplete (DEPLOYER_PRIVATE_KEY or SONOGLYPH_CONTRACT_ADDRESS missing)',
      },
      503,
    );
  }

  console.log(
    `[mint ${code}] minting to ${playerAddress} (audioCid=${payload.audioCid}, ` +
      `glyph=${payload.glyph.length}ch, journal=${payload.journal.length}ch)`,
  );

  try {
    const result = await mintSonoglyph({
      to: playerAddress as `0x${string}`,
      glyph: payload.glyph,
      journal: payload.journal,
      audioCid: payload.audioCid,
      sessionCode: payload.sessionCode,
    });
    game.setMintResult(result.tokenId, result.txHash);
    console.log(
      `[mint ${code}] tokenId=${result.tokenId} tx=${result.txHash} ` +
        `block=${result.blockNumber} gas=${result.gasUsed}`,
    );
    return c.json({
      tokenId: result.tokenId,
      txHash: result.txHash,
      contractAddress: result.contractAddress,
      chainId: result.chainId,
      cached: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mint ${code}] failed:`, message);
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
    "Read the server's initial instructions for the descent's musical key (root + mode). " +
    "Loop autonomously now: " +
    "(1) call wait_for_my_turn (it blocks ~10s for the cooldown). " +
    "(2) when it returns it_is_my_turn=true, immediately call place_layer(type, comment, intent). " +
    "(3) repeat from step 1. " +
    "Stop only when wait_for_my_turn returns finished=true. " +
    "Do not emit text between tool calls. " +
    "Layer types: drone, texture, pulse, glitch, breath, bell, drip, swell, chord. " +
    "Intent (optional but encouraged): tension | release | color | emphasis | hush — " +
    "this biases the pitch within the descent's scale. " +
    "Vary BOTH type and intent across the descent so the composition has a shape " +
    "(e.g. hush → color → tension → release). " +
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
        // Pitch is no longer client-supplied — the bridge picks it from
        // the descent's scale (see GameSession.playerPlace → theory.ts).
        // The chosen freq comes back to the client via the `layer_added`
        // echo, so the audio engine plays the agreed pitch.
        const result = game.playerPlace(msg.layerType, msg.position);
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
