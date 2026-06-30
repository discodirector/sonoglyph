/**
 * Thin WebSocket client. Connects to the bridge `/ws` endpoint and keeps
 * a single connection open for the lifetime of the session.
 *
 * URL resolution:
 *   - VITE_BRIDGE_WS env (set at build time) overrides everything
 *   - In a hosted build with no override, derive from window.location:
 *     https → wss, same host, /ws path
 *   - Local dev fallback: ws://localhost:8787/ws
 */

import type { ClientMessage, ServerMessage } from './protocol';

export type ServerHandler = (msg: ServerMessage) => void;

export interface BridgeConnection {
  send: (msg: ClientMessage) => void;
  close: () => void;
  isOpen: () => boolean;
}

export function openBridge(handler: ServerHandler): BridgeConnection {
  const wsUrl = resolveWsUrl();
  const ws = new WebSocket(wsUrl);

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data) as ServerMessage;
      handler(msg);
    } catch (err) {
      console.warn('[ws] unparseable message', err);
    }
  };

  ws.onerror = (e) => {
    console.error('[ws] error', e);
  };

  ws.onclose = () => {
    console.log('[ws] closed');
  };

  return {
    send: (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      } else {
        console.warn('[ws] send dropped — socket not open');
      }
    },
    close: () => ws.close(),
    isOpen: () => ws.readyState === WebSocket.OPEN,
  };
}

function resolveWsUrl(): string {
  const explicit = (import.meta.env.VITE_BRIDGE_WS as string | undefined)?.trim();
  if (explicit) return explicit;
  if (typeof window !== 'undefined' && window.location && window.location.host) {
    const isLocalDev =
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1';
    if (!isLocalDev) {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}/ws`;
    }
  }
  return 'ws://localhost:8787/ws';
}

// ---------------------------------------------------------------------------
// IPFS pinning helper. Posts the descent's WebM blob to the bridge's
// /pin/audio endpoint, which forwards it to Pinata and returns the CID.
//
// The endpoint matches the bridge's HTTP origin (NOT the WS one): in dev
// Vite proxies /pin/* to :8787 alongside /ws and /mcp; in prod Caddy
// already serves both schemes from the same host.
// ---------------------------------------------------------------------------

export interface PinAudioResult {
  cid: string;
  gatewayUrl: string;
  size: number;
}

export async function pinAudio(
  blob: Blob,
  sessionCode?: string,
): Promise<PinAudioResult> {
  const url = sessionCode
    ? `/pin/audio?code=${encodeURIComponent(sessionCode)}`
    : '/pin/audio';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body: blob,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `pin failed: ${res.status} ${res.statusText} — ${text.slice(0, 300)}`,
    );
  }
  return (await res.json()) as PinAudioResult;
}

// ---------------------------------------------------------------------------
// Mint helper. The bridge holds the contract owner key and signs the mint
// transaction itself; we just tell it which address should receive the NFT.
// All other inputs (glyph, journal, audioCid, sessionCode) live server-side
// in GameSession, so the request body stays one field.
// ---------------------------------------------------------------------------

export interface MintResult {
  tokenId: string;
  txHash: string;
  contractAddress: string;
  chainId: number;
  /** True when the bridge returned a previously-stored mint result instead
   *  of broadcasting a new transaction (idempotency for retry / refresh). */
  cached: boolean;
}

export async function mintDescent(
  sessionCode: string,
  playerAddress: string,
): Promise<MintResult> {
  const res = await fetch(`/mint?code=${encodeURIComponent(sessionCode)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerAddress }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { error?: string };
      detail = j?.error ?? '';
    } catch {
      detail = (await res.text().catch(() => '')) || '';
    }
    throw new Error(
      `mint failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`,
    );
  }
  return (await res.json()) as MintResult;
}

/**
 * Live supply snapshot for the Finale screen. Backed by the bridge's
 * /supply endpoint, which reads `lastTokenId()` and `MAX_SUPPLY()` from
 * the contract and caches for 15 s.
 *
 * Throws on any network or 5xx error. Caller (Finale) treats failure as
 * "supply unknown" and hides the counter — the contract enforces the cap
 * regardless of whether the UI surfaces it.
 */
export interface SupplyInfo {
  minted: number;
  max: number;
  cached: boolean;
}

export async function fetchSupply(): Promise<SupplyInfo> {
  const res = await fetch('/supply');
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { error?: string };
      detail = j?.error ?? '';
    } catch {
      /* ignore — body might not be JSON */
    }
    throw new Error(
      `supply lookup failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`,
    );
  }
  return (await res.json()) as SupplyInfo;
}

// ---------------------------------------------------------------------------
// Full collection fetch — backs the /atlas page. The bridge scans every
// minted descent off chain and caches the result for 5 minutes, so the
// first viewer after a TTL expiry pays ~30 s of latency and everyone in
// that window gets the cached blob instantly.
//
// The journal isn't included to keep payload size sane (~150 KB for 250
// tokens with glyph+meta only, vs ~600 KB if we shipped journals too).
// The atlas page only renders glyph thumbnails + traits + rank; journal
// is a per-token follow-up if we ever build a detail view.
// ---------------------------------------------------------------------------

export interface CollectionToken {
  tokenId: number;
  glyph: string;
  sessionCode: string;
  creator: string;
  /** Unix seconds — from the contract's `mintedAt` (uint64). */
  mintedAt: number;
  audioCid: string;
}

export interface CollectionResponse {
  tokens: CollectionToken[];
  count: number;
  cached: boolean;
}

export async function fetchCollection(): Promise<CollectionResponse> {
  const res = await fetch('/collection');
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { error?: string };
      detail = j?.error ?? '';
    } catch {
      /* ignore */
    }
    throw new Error(
      `collection fetch failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`,
    );
  }
  return (await res.json()) as CollectionResponse;
}

// ---------------------------------------------------------------------------
// Runtime feature flags surfaced by the bridge.
//   - shareEnabled: share-button gate; flipped on when the rarity calibration
//     is frozen so tweeted cards don't lie after the next mint reshuffles.
//   - mintClosed: experiment-concluded gate; when true the bridge rejects
//     /mint with 410 and the frontend shows "Experiment concluded" in Intro
//     and Finale instead of the mint flow. Used when we close the descent
//     series before the on-chain MAX_SUPPLY of 250 (contract is immutable,
//     so closure happens at the bridge + UI layer).
//
// Defaults on network failure are conservative: shareEnabled=false (gated UI
// stays hidden) and mintClosed=false (we don't accidentally lock users out
// of mint when the config endpoint is briefly unreachable — the bridge
// itself still rejects the mint if the flag is on the VPS).
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  shareEnabled: boolean;
  mintClosed: boolean;
}

export async function fetchConfig(): Promise<RuntimeConfig> {
  try {
    const res = await fetch('/config');
    if (!res.ok) return { shareEnabled: false, mintClosed: false };
    const j = (await res.json()) as Partial<RuntimeConfig>;
    return {
      shareEnabled: Boolean(j.shareEnabled),
      mintClosed: Boolean(j.mintClosed),
    };
  } catch {
    return { shareEnabled: false, mintClosed: false };
  }
}

// ---------------------------------------------------------------------------
// Shared-agent spawn — for players who don't have their own Hermes install.
// Posts to the bridge, which forks an ephemeral hermes-CLI on the VPS,
// paired to the same `?code=` as this WS session. Subsequent state
// transitions (queued → spawning → active → expired) flow back as
// `shared_agent_status` messages over the existing WS, so this fetch
// returns only the immediate decision and any failure reason.
//
// HTTP semantics:
//   200 — request accepted (`status` is 'spawning' or 'queued', or 'active'
//         on idempotent retry)
//   429 — rate limit (status='failed', error explains)
//   503 — capacity exceeded / spawn machinery error
//   404 — unknown session code (e.g. WS reconnected with a new one)
// ---------------------------------------------------------------------------

export interface SharedAgentRequestResult {
  status: 'queued' | 'spawning' | 'active' | 'expired' | 'failed';
  /** 1-based queue position; only set when status='queued'. */
  position?: number;
  /** Unix ms when the spawned process will be killed. */
  expiresAt?: number;
  /** Human-readable explanation; set on 'failed'. */
  error?: string;
}

export async function requestSharedAgent(
  sessionCode: string,
  personalityKey?: string,
): Promise<SharedAgentRequestResult> {
  // Build the query carefully — `personalityKey` is optional and we want
  // to omit it entirely (rather than send `&personality=`) when unset, so
  // the bridge sees an unset query param and uses the default voice.
  const query = new URLSearchParams({ code: sessionCode });
  if (personalityKey) query.set('personality', personalityKey);
  const res = await fetch(
    `/agents/spawn?${query.toString()}`,
    { method: 'POST' },
  );
  // 200 / 429 / 503 all return a JSON body with `status` + optional
  // `error`. 404 (unknown session) is the only path that doesn't fit the
  // pool's shape — surface it as a synthetic failure.
  if (res.status === 404) {
    return {
      status: 'failed',
      error: 'session not recognised by the bridge — refresh the page',
    };
  }
  try {
    return (await res.json()) as SharedAgentRequestResult;
  } catch {
    return {
      status: 'failed',
      error: `bridge returned ${res.status} ${res.statusText}`,
    };
  }
}
