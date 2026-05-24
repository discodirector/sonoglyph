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
import {
  chainConfigStatus,
  mintSonoglyph,
  getSupplyInfo,
  fetchAllDescents,
  fetchOneDescent,
  type DescentSummary,
} from './chain.js';
import { isAddress } from 'viem';
import type { ClientMessage, ServerMessage } from './protocol.js';
import { AgentPool } from './agents/pool.js';
import { isValidPersonalityKey, type PersonalityKey } from './agents/spawn.js';
import {
  checkMintAllowed,
  reserveMintSlot,
  releaseMintSlot,
} from './mintRateLimit.js';
import { getOrRenderOgPng, renderAtlasHtml } from './og.js';
import { getOrRenderVideo, videoExistsOnDisk } from './video.js';

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

// Catch-all error logger. Hono silently 500s on uncaught handler throws —
// without this, a buggy route turns the whole bridge into a black box.
// We keep the response body terse (no stack to the client) but log the
// full error to stderr so journalctl picks it up.
app.onError((err, c) => {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack ?? '' : '';
  console.error(`[bridge] handler error on ${c.req.method} ${c.req.path}: ${msg}\n${stack}`);
  return c.text('internal error', 500);
});

const registry = new GameRegistry();

// -----------------------------------------------------------------------------
// AgentPool — manages the ephemeral Hermes processes we spawn on behalf of
// players who don't have their own Hermes install. The listener forwards
// pool status events to the matching GameSession's WS subscribers so the
// browser UI can show queue position / "spawning..." / etc.
//
// We construct the pool eagerly so the daily counter starts ticking from
// boot, even before the first /agents/spawn hit.
// -----------------------------------------------------------------------------
const agentPool = new AgentPool((sessionCode, status) => {
  const game = registry.get(sessionCode);
  if (game) {
    game.notifySharedAgentStatus(status);
  } else {
    // Session disappeared mid-flight (WS closed before spawn completed).
    // Make sure we don't keep a zombie agent burning a slot.
    console.warn(
      `[pool] orphan status for ${sessionCode} (${status.status}) — session gone`,
    );
  }
});

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
    sharedAgents: agentPool.status(),
    time: Date.now(),
  });
});

// -----------------------------------------------------------------------------
// Shared-agent spawn endpoint — frontend hits this when the user clicks
// "Play without your own agent". The bridge spawns an ephemeral Hermes
// subprocess, paired to the same session code as the browser.
//
// Response shape echoes pool.request()'s PoolStatus:
//   { status: 'spawning' | 'queued' | 'failed' (or 'active' on retry),
//     position?: number,        // for queued
//     expiresAt?: number,       // for spawning/active
//     error?: string }          // for failed
//
// HTTP status:
//   200 — request accepted (status spawning/queued/active)
//   429 — rate limited (response body has status='failed' + reason)
//   503 — capacity exceeded / spawn machinery broken (failed + reason)
//
// Idempotency: hitting /agents/spawn twice for the same code is a no-op —
// the pool returns the current status of the existing entry.
// -----------------------------------------------------------------------------
app.post('/agents/spawn', async (c) => {
  const code = c.req.query('code');
  if (!code) {
    return c.json({ error: 'missing ?code= query parameter' }, 400);
  }
  const game = registry.get(code);
  if (!game) {
    return c.json({ error: `unknown session: ${code}` }, 404);
  }
  // Optional voice/character preset. Closed list defined in
  // proxy/src/agents/spawn.ts:PERSONALITY_PROMPTS; we reject unknown keys
  // with 400 (rather than silently dropping them) so a stale frontend
  // bundle that ships a renamed key surfaces the error immediately
  // instead of mysteriously producing a default-voiced agent.
  const personalityRaw = c.req.query('personality');
  let personalityKey: PersonalityKey | undefined;
  if (personalityRaw !== undefined && personalityRaw !== '') {
    if (!isValidPersonalityKey(personalityRaw)) {
      return c.json(
        { error: `unknown personality: ${personalityRaw}` },
        400,
      );
    }
    personalityKey = personalityRaw;
  }
  // Caddy forwards the real client IP via X-Forwarded-For; fall back to
  // X-Real-IP, then to a sentinel that lumps everything into the same
  // rate-limit bucket (still useful as a coarse global brake).
  const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = xff || c.req.header('x-real-ip') || 'unknown';

  const result = await agentPool.request(code, ip, personalityKey);
  let httpStatus: 200 | 429 | 503 = 200;
  if (result.status === 'failed') {
    httpStatus = result.error?.startsWith('Too many') ? 429 : 503;
  }
  return c.json(result, httpStatus);
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
// Collection snapshot — backs the /atlas frontend route. Returns every
// minted descent as a flat array (tokenId, glyph, sessionCode, creator,
// mintedAt, audioCid). The frontend derives rarity + archetype + rank
// locally with web/src/lib/glyphRarity.ts; we keep the bridge thin and
// dumb about traits.
//
// Cache window: 5 minutes. Rationale:
//   - A full scan of 250 tokens takes ~30 s on the public Monad RPC.
//     Serving every atlas mount from the chain would melt both the RPC
//     and the player's loading state.
//   - Mints arrive irregularly (~minutes apart at peak, hours at quiet
//     times), so a 5-minute staleness window is unobservable to anyone
//     but the player who just minted — and they see their own glyph in
//     the Finale UI immediately, not via /collection.
//   - When a fresh mint completes, we proactively invalidate the cache
//     in the /mint handler so the next /collection hit re-scans. This
//     keeps the atlas reasonably live without compromising the cache.
//
// Failure mode: if the chain is unreachable, returns 503 with the error.
// The atlas page treats that as "collection unavailable" and shows a
// brief message + retry button.
// -----------------------------------------------------------------------------
let collectionCache:
  | { value: DescentSummary[]; expiresAt: number }
  | null = null;
const COLLECTION_CACHE_TTL_MS = 5 * 60_000;

// Concurrent-fetch guard: while one /collection request is mid-scan we
// share its promise with any others that land in the window. Without this
// guard a cold-start surge of N atlas mounts triggers N parallel 30-second
// chain scans, hammering the RPC and saturating the bridge.
let inflightCollection: Promise<DescentSummary[]> | null = null;

app.get('/collection', async (c) => {
  const now = Date.now();
  if (collectionCache && collectionCache.expiresAt > now) {
    return c.json({
      tokens: collectionCache.value,
      count: collectionCache.value.length,
      cached: true,
    });
  }
  try {
    if (!inflightCollection) {
      inflightCollection = (async () => {
        try {
          const value = await fetchAllDescents();
          collectionCache = { value, expiresAt: Date.now() + COLLECTION_CACHE_TTL_MS };
          return value;
        } finally {
          inflightCollection = null;
        }
      })();
    }
    const value = await inflightCollection;
    return c.json({ tokens: value, count: value.length, cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[collection] scan failed:', message);
    return c.json({ error: message }, 503);
  }
});

// -----------------------------------------------------------------------------
// Shareable token URL plumbing.
//
// Twitter, Discord, Slack, Telegram, etc. all read OG/Twitter meta from a
// server-rendered HTML response — they do NOT execute JS. So when someone
// shares https://sonoglyph.xyz/atlas/42 we need that exact URL to return
// HTML whose <head> contains the per-token meta block. The SPA continues to
// hydrate normally; Atlas.tsx already deep-links from /atlas/:id into the
// detail modal.
//
// The PNG referenced by og:image is rendered on demand at /og/:id.png,
// cached to disk by token id, and revalidated only when OG_CACHE_VERSION
// bumps (post-final-calibration recalibration scenario).
//
// Why we look up the token via in-memory cache OR a single descentOf call
// (rather than waiting for the full /collection scan): Twitter's crawler
// gives a request maybe ~10 s before giving up. A 30 s cold-cache scan
// would mean every fresh-deploy share renders the fallback "Sonoglyph #N"
// generic card. The single-token fetch is ~500 ms, well inside budget.
// -----------------------------------------------------------------------------

/** Pluck a token from the collection cache without triggering a refresh. */
function tokenFromCache(id: number): DescentSummary | null {
  if (!collectionCache) return null;
  return collectionCache.value.find((t) => t.tokenId === id) ?? null;
}

/** Look up by cache first, then single-token chain read. Null on miss or
 *  on chain error — callers fall back to generic OG meta rather than 500. */
async function lookupToken(id: number): Promise<DescentSummary | null> {
  const cached = tokenFromCache(id);
  if (cached) return cached;
  try {
    return await fetchOneDescent(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[og] chain lookup failed for #${id}: ${msg.slice(0, 120)}`);
    return null;
  }
}

function parseTokenId(raw: string): number | null {
  // Accept "5" or "5.png" — the OG endpoint is served at /og/:id.png so we
  // strip the suffix here rather than embedding the parse in two places.
  const m = raw.match(/^(\d+)(?:\.png)?$/);
  if (!m) return null;
  const id = Number.parseInt(m[1], 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Server-rendered atlas page for a single token. Returns the SPA shell
 * with OG/Twitter meta tags spliced into the head. The browser still
 * runs the full SPA — this exists purely for crawlers.
 */
app.get('/atlas/:id{[0-9]+}', async (c) => {
  const id = parseTokenId(c.req.param('id'));
  if (!id) return c.text('not found', 404);
  const origin = PUBLIC_BASE_URL.replace(/\/+$/, '');
  const token = await lookupToken(id);
  try {
    // Only advertise og:video if the MP4 is actually on disk. First-share
    // crawler will see image-only meta; a background render kicked off
    // below warms the cache so subsequent crawler hits include video.
    const videoReady = await videoExistsOnDisk(id);
    const html = await renderAtlasHtml(
      origin,
      id,
      token ? { tokenId: token.tokenId, glyph: token.glyph } : null,
      videoReady,
    );

    // Fire-and-forget MP4 prerender for the natural "user opens /atlas/:id
    // before clicking Share" flow. By the time they go to share, the MP4
    // is on disk and the crawler hit is sub-second instead of waiting on
    // ffmpeg. We swallow errors here — they show up in the dedicated
    // /video/:id.mp4 handler with proper status codes when something
    // actually requests the bytes. Skipped when audioCid is missing
    // (older tokens minted before audio pinning was wired up).
    if (token && token.audioCid && !videoReady) {
      void getOrRenderVideo({
        tokenId: token.tokenId,
        glyph: token.glyph,
        audioCid: token.audioCid,
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[video] prerender for #${id} failed: ${msg.slice(0, 200)}`);
      });
    }

    // Short cache: 60 s lets a sudden burst of shares hit the same HTML
    // without re-stating index.html, but still picks up redeploys fast.
    c.header('Cache-Control', 'public, max-age=60');
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(html);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[atlas/:id] render failed for #${id}: ${msg}`);
    // 503 rather than 500 so Twitter retries on its own schedule instead
    // of permanently blacklisting the URL.
    return c.text(`atlas render failed: ${msg}`, 503);
  }
});

/**
 * 1200×630 PNG card for crawlers and download-then-attach manual sharing.
 *
 * Path shape: `/og/:filename` rather than `/og/:id.png`. Hono's path
 * router corrupts param extraction when a regex-constrained param is
 * followed by a literal dot-extension (`/og/:id{[0-9]+}.png` made every
 * route in the bridge 500), so we accept any single segment under /og/
 * and validate `<digits>.png` manually in {@link parseTokenId}.
 *
 * Aggressive Cache-Control: PNGs are deterministic per (tokenId, OG_CACHE
 * _VERSION). 24 h is plenty for the crawler hop chain to keep one copy in
 * its CDN. We also set immutable so reload buttons don't refetch.
 */
app.get('/og/:filename', async (c) => {
  const id = parseTokenId(c.req.param('filename'));
  if (!id) return c.text('not found', 404);
  const token = await lookupToken(id);
  if (!token) return c.text('token not found', 404);
  try {
    const png = await getOrRenderOgPng({ tokenId: id, glyph: token.glyph });
    c.header('Content-Type', 'image/png');
    c.header('Cache-Control', 'public, max-age=86400, immutable');
    return c.body(png as unknown as ArrayBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[og/:id] render failed for #${id}: ${msg}`);
    return c.text(`og render failed: ${msg}`, 500);
  }
});

/**
 * MP4 card for the same /og/:id.png semantic key — pairs the static OG
 * image with the descent's pinned audio so the crawler (Facebook /
 * Discord / Telegram) can preview audio inline. The same URL also acts
 * as the "download to attach to a tweet" path, because Twitter's player
 * card pipeline gates inline video behind a per-domain approval we don't
 * have. Disk-cached just like the PNG; the first hit costs an ffmpeg run
 * (~3-8 s) and subsequent hits stream from disk.
 *
 * Same path-shape workaround as /og/:filename: Hono's router can't carry
 * a literal `.mp4` after a regex-constrained param, so we accept any
 * single segment and validate `<digits>.mp4` inside parseVideoId.
 */
function parseVideoId(raw: string): number | null {
  const m = raw.match(/^(\d+)\.mp4$/);
  if (!m) return null;
  const id = Number.parseInt(m[1], 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

app.get('/video/:filename', async (c) => {
  const id = parseVideoId(c.req.param('filename'));
  if (!id) return c.text('not found', 404);
  const token = await lookupToken(id);
  if (!token) return c.text('token not found', 404);
  if (!token.audioCid) {
    return c.text('token has no pinned audio', 404);
  }
  try {
    const mp4 = await getOrRenderVideo({
      tokenId: id,
      glyph: token.glyph,
      audioCid: token.audioCid,
    });
    c.header('Content-Type', 'video/mp4');
    c.header('Cache-Control', 'public, max-age=86400, immutable');
    // Suggest a filename so the "Download Video" button on Atlas yields
    // sonoglyph-<id>.mp4 instead of "video.mp4" when the user attaches
    // it to a tweet.
    c.header(
      'Content-Disposition',
      `inline; filename="sonoglyph-${id}.mp4"`,
    );
    return c.body(mp4 as unknown as ArrayBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[video/:id] render failed for #${id}: ${msg.slice(0, 300)}`);
    return c.text(`video render failed: ${msg.slice(0, 300)}`, 500);
  }
});

/**
 * Runtime feature flags surfaced to the frontend. Right now this is just
 * the share-button gate — we keep it disabled until supply hits 250 and
 * the rarity calibration is frozen, because pre-freeze rank values can
 * shift between mints (and a tweeted card showing "RANK 7" would lie
 * after the next mint reshuffles).
 *
 * Toggle by setting SHARE_ENABLED=true in .env on the VPS; the frontend
 * polls this once on Atlas mount.
 */
app.get('/config', (c) => {
  const shareEnabled = process.env.SHARE_ENABLED === 'true';
  return c.json({ shareEnabled });
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

  // Per-IP rate limit. Caddy forwards the real client IP via
  // X-Forwarded-For; falling back to X-Real-IP and finally to a
  // sentinel string keeps the bucket coherent even in local dev where
  // no proxy is in front. The 'unknown' bucket exists mostly to make
  // unproxied dev requests visible (they'll share one slot pool) — in
  // production every request is XFF-tagged.
  //
  // Policy lives in mintRateLimit.ts: 2 mints per IP per 48h. The
  // intent is to keep airdrop farmers from rotating fresh wallets
  // through one IP — the on-chain contract enforces one-mint-per-
  // address but cannot see IPs, so this is the brake one layer up.
  // Cached-result returns above this check are intentionally free:
  // an idempotent retry of an already-minted session should never be
  // counted as a new mint.
  const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = xff || c.req.header('x-real-ip') || 'unknown';
  const decision = checkMintAllowed(ip);
  if (!decision.allowed) {
    console.warn(
      `[mint ${code}] rate-limited ip=${ip} (used=${decision.used}/` +
        `${decision.limit}, retryAfterSec=${decision.retryAfterSec})`,
    );
    return c.json(
      {
        error:
          `mint rate limit reached for this IP (${decision.used}/${decision.limit} ` +
          `in the last 48 h) — try again in ` +
          `${Math.ceil((decision.retryAfterSec ?? 0) / 3600)} h`,
        retryAfterSec: decision.retryAfterSec,
        used: decision.used,
        limit: decision.limit,
      },
      429,
      decision.retryAfterSec
        ? { 'Retry-After': String(decision.retryAfterSec) }
        : undefined,
    );
  }

  console.log(
    `[mint ${code}] minting to ${playerAddress} from ip=${ip} ` +
      `(slot ${decision.used + 1}/${decision.limit}, ` +
      `audioCid=${payload.audioCid}, glyph=${payload.glyph.length}ch, ` +
      `journal=${payload.journal.length}ch)`,
  );

  // Reserve a slot BEFORE the chain call so two concurrent requests
  // from the same IP can't both pass checkMintAllowed during the
  // ~1-2 s that mintSonoglyph is awaiting an RPC response. On failure
  // we release it, so a transient RPC blip doesn't permanently burn a
  // slot.
  const slot = reserveMintSlot(ip);

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
    // Invalidate caches that depend on supply state. /supply has its own
    // 15 s TTL we don't need to clear; /collection's 5-minute window is
    // long enough that the new mint would be invisible on the atlas page
    // until expiry. Dropping the entry forces the next viewer to re-scan.
    collectionCache = null;
    return c.json({
      tokenId: result.tokenId,
      txHash: result.txHash,
      contractAddress: result.contractAddress,
      chainId: result.chainId,
      cached: false,
    });
  } catch (err) {
    releaseMintSlot(ip, slot);
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
    // Promote shared-agent status from 'spawning' to 'active' once the
    // spawned hermes has completed its MCP handshake (which is the signal
    // that produces `agent_paired` upstream). No-op for BYO sessions —
    // the pool tracks nothing for them.
    if (msg.type === 'agent_paired') {
      agentPool.markActive(code);
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
    // Cancel any pending shared agent (queued or active) for this session
    // immediately — keeping a dead-tab session in the queue would stall
    // others, and an active spawned agent has no reason to keep playing
    // (the player can't see it). The pool no-ops if there's no entry.
    agentPool.cancel(code);
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
