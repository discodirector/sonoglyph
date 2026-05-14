/**
 * Session store — single source of truth for the descent (frontend side).
 *
 * Authority split (Day 5):
 *   - Server (bridge) is authoritative for: layers, turnCount, currentTurn,
 *     cooldownEndsAt, agentConnected, game phase. Updates flow in via WS.
 *   - Server also delivers the pairing code, the MCP URL, and the
 *     copy-paste hermes command on connect.
 *   - Client owns: depth (camera), selectedPreset, recording, local event
 *     log (FFT snapshots, etc).
 *
 * Phase machine (browser-side):
 *   'intro'    — before Begin: nothing happening, audio silent. Waiting for
 *                Hermes pairing before Begin is enabled.
 *   'playing'  — game running.
 *   'finished' — MAX_LAYERS reached; HUD pivots to journal + glyph.
 */

import { create } from 'zustand';
import {
  type CurrentTurn,
  type FinalArtifact,
  type GameStateSnapshot,
  type LayerType,
  type PlacedLayer,
  type SessionScalePublic,
  MAX_LAYERS,
} from '../net/protocol';

export { type LayerType, type PlacedLayer };

export const LAYER_TYPES: LayerType[] = [
  'drone',
  'texture',
  'pulse',
  'glitch',
  'breath',
  'bell',
  'drip',
  'swell',
  'chord',
];

// ---------------------------------------------------------------------------
// Pads — atmospheric "air" voices that play in parallel to the placed-layer
// composition. Three timbral shades, each derived from the session's scale
// (so two players in different keys hear pads in their own tonality).
//
// Pads aren't part of the turn-based layer game and aren't broadcast over WS
// — they're a purely client-side ambient layer. They DO ride the master mix
// + recorder, so whatever's on at the end of the descent gets baked into
// the WebM that's pinned to IPFS and minted on-chain.
// ---------------------------------------------------------------------------
export type PadId = 'glow' | 'air' | 'deep';
export const PAD_IDS: PadId[] = ['glow', 'air', 'deep'];
export const PAD_LABELS: Record<PadId, string> = {
  glow: 'GLOW',
  air: 'AIR',
  deep: 'DEEP',
};

// ---------------------------------------------------------------------------
// Local event log — feeds spectral context for the journal in case we
// later want to send richer prompts to Kimi from the client.
// ---------------------------------------------------------------------------
export type SessionEvent =
  | { t: number; type: 'descent_started' }
  | {
      t: number;
      type: 'layer_placed';
      layerId: string;
      layerType: LayerType;
      placedBy: 'player' | 'agent';
      freq: number;
      depth: number;
      position: [number, number, number];
      comment?: string;
    }
  | { t: number; type: 'spectral_snapshot'; bands: number[]; depth: number };

export type PendingEvent = SessionEvent extends infer E
  ? E extends SessionEvent
    ? Omit<E, 't'>
    : never
  : never;

export type Phase = 'intro' | 'playing' | 'finished';

export interface PairingInfo {
  code: string;
  mcpUrl: string;
  hermesCommand: string;
  hermesAddCommand: string;
  hermesPrompt: string;
}

/**
 * Live status of the shared-agent request flow (the "play without your
 * own Hermes" path). `idle` = user hasn't asked for one yet; everything
 * else mirrors the bridge pool's PoolStatus.
 *
 * `requesting` is purely client-side — set while the POST /agents/spawn
 * is in flight before the bridge has decided spawning vs queued. The
 * other states arrive via WS `shared_agent_status` pushes.
 */
export type SharedAgentStatus =
  | 'idle'
  | 'requesting'
  | 'queued'
  | 'spawning'
  | 'active'
  | 'expired'
  | 'failed';

export interface SharedAgentState {
  status: SharedAgentStatus;
  /** 1-based queue position; non-null only when status='queued'. */
  position: number | null;
  /** Unix ms when the spawned hermes will be SIGTERM'd. */
  expiresAt: number | null;
  /** Last error string; surfaced under the spawn button. */
  error: string | null;
}

interface SessionState {
  // --- mirrored from server ---
  phase: Phase;
  layers: PlacedLayer[];
  turnCount: number;
  maxLayers: number;
  currentTurn: CurrentTurn | null;
  cooldownEndsAt: number | null;
  agentConnected: boolean;
  pairing: PairingInfo | null;
  artifact: FinalArtifact | null;
  /**
   * Descent's musical key — picked once on the bridge in `pickSessionScale()`,
   * arrives in the first `state` snapshot. The Pads UI uses
   * `scale.intervals` to derive its 3-pad palette in the session's tonality.
   * Null until the first snapshot lands.
   */
  scale: SessionScalePublic | null;

  // --- client-owned ---
  depth: number;
  selectedPreset: LayerType;
  /** Per-type mix gains (0..1.5). 1.0 = unity. Mirrored in audio engine
   *  via setLayerVolume; the UI EQ panel reads + writes here. */
  layerVolumes: Record<LayerType, number>;
  /**
   * Which atmospheric pads are currently engaged. Each id maps to a pad
   * voice the engine starts/stops in response. Persists across the
   * Pads-panel toggle so opening the panel doesn't reset state.
   */
  padsActive: Record<PadId, boolean>;
  proxyOk: boolean | null;
  recording: boolean;
  /** Captured WebM of the full descent. Set once Tone.Recorder stops at
   *  the end of the outro fade; consumed by the IPFS pinning step before
   *  the on-chain mint. Null until then. */
  recordingBlob: Blob | null;
  /** IPFS CID of the pinned descent recording (Pinata). Set after the
   *  bridge confirms the pin succeeded; the on-chain mint references
   *  this. 'pending' while the upload is in flight; 'error' if the pin
   *  call failed (UI surfaces a retry). Null before any attempt. */
  audioCid: string | null;
  audioPinStatus: 'idle' | 'pending' | 'pinned' | 'error';
  audioPinError: string | null;
  /** On-chain mint state. The bridge is the sole minter and we issue at
   *  most one token per session. 'pending' covers the entire round-trip
   *  (sign → broadcast → wait for receipt) on Monad testnet, ~1-3 s. */
  mintStatus: 'idle' | 'pending' | 'minted' | 'error';
  mintTokenId: string | null;
  mintTxHash: string | null;
  mintContractAddress: string | null;
  mintChainId: number | null;
  mintError: string | null;
  /** Live edition counter for the Finale screen. Both null = not yet
   *  fetched (or fetch failed); the UI hides the counter in that state.
   *  Populated by the Finale's mount-effect call to `/supply`. */
  supplyMinted: number | null;
  supplyMax: number | null;
  /**
   * Shared-agent status — UI uses this to drive the "Play without your
   * own agent" button, the queue overlay, and the 10-minute timer chip.
   * Stays 'idle' for players who bring their own Hermes (bypassing the
   * spawn endpoint entirely).
   */
  sharedAgent: SharedAgentState;
  startedAt: number | null;
  log: SessionEvent[];

  // --- intent: leave 'intro' (Begin clicked) ---
  beginLocal: () => void;

  // --- server message appliers ---
  applySessionCreated: (info: PairingInfo) => void;
  applyAgentPaired: (paired: boolean) => void;
  applySnapshot: (s: GameStateSnapshot) => void;
  applyLayerAdded: (l: PlacedLayer) => void;
  applyTurnChanged: (
    t: CurrentTurn,
    cooldownEndsAt: number | null,
    turnCount: number,
  ) => void;
  applyFinished: (artifact: FinalArtifact | null) => void;

  // --- client setters ---
  setDepth: (d: number) => void;
  setSelectedPreset: (t: LayerType) => void;
  setLayerVolume: (t: LayerType, value: number) => void;
  /** Toggle a pad on/off. Engine-side start/stop is wired in the Pads UI. */
  setPadActive: (id: PadId, on: boolean) => void;
  setProxyOk: (ok: boolean) => void;
  setRecording: (r: boolean) => void;
  setRecordingBlob: (b: Blob | null) => void;
  setAudioPinPending: () => void;
  setAudioPinSuccess: (cid: string) => void;
  setAudioPinError: (msg: string) => void;
  setMintPending: () => void;
  setMintSuccess: (result: {
    tokenId: string;
    txHash: string;
    contractAddress: string;
    chainId: number;
  }) => void;
  setMintError: (msg: string) => void;
  /** Set both supply numbers from a /supply fetch. */
  setSupply: (minted: number, max: number) => void;
  /** Optimistic +1 on the minted count after a successful local mint. The
   *  Finale UI uses this to update "EDITION X / 250" instantly without
   *  waiting for the bridge's 15 s cache window to expire. No-op if
   *  supplyMinted is null (we don't optimistically guess). */
  bumpSupplyMinted: () => void;
  /** Local: flip to 'requesting' before POST /agents/spawn fires, so the
   *  spawn button can show a spinner without waiting for the HTTP round-trip. */
  setSharedAgentRequesting: () => void;
  /** Local: apply the HTTP response from /agents/spawn — typically lands
   *  in 'spawning' or 'queued' but covers 'failed' / idempotent 'active'. */
  applySharedAgentResponse: (r: {
    status: SharedAgentStatus;
    position?: number;
    expiresAt?: number;
    error?: string;
  }) => void;
  /** Server-driven: WS `shared_agent_status` push. Same shape as the HTTP
   *  response so the applier is a thin wrapper. */
  applySharedAgentStatus: (r: {
    status: SharedAgentStatus;
    position?: number;
    expiresAt?: number;
    error?: string;
  }) => void;
  pushEvent: (e: PendingEvent) => void;
}

export const useSession = create<SessionState>((set) => ({
  phase: 'intro',
  layers: [],
  turnCount: 0,
  maxLayers: MAX_LAYERS,
  currentTurn: null,
  cooldownEndsAt: null,
  agentConnected: false,
  pairing: null,
  artifact: null,
  scale: null,

  depth: 0,
  selectedPreset: 'drone',
  layerVolumes: Object.fromEntries(LAYER_TYPES.map((t) => [t, 1])) as Record<
    LayerType,
    number
  >,
  padsActive: Object.fromEntries(PAD_IDS.map((id) => [id, false])) as Record<
    PadId,
    boolean
  >,
  proxyOk: null,
  recording: false,
  recordingBlob: null,
  audioCid: null,
  audioPinStatus: 'idle',
  audioPinError: null,
  mintStatus: 'idle',
  mintTokenId: null,
  mintTxHash: null,
  mintContractAddress: null,
  mintChainId: null,
  mintError: null,
  supplyMinted: null,
  supplyMax: null,
  sharedAgent: {
    status: 'idle',
    position: null,
    expiresAt: null,
    error: null,
  },
  startedAt: null,
  log: [],

  beginLocal: () =>
    set(() => ({
      phase: 'playing',
      startedAt: Date.now(),
      log: [{ t: 0, type: 'descent_started' }],
    })),

  applySessionCreated: (info) => set(() => ({ pairing: info })),

  applyAgentPaired: (paired) => set(() => ({ agentConnected: paired })),

  applySnapshot: (s) =>
    set(() => {
      const next: Partial<SessionState> = {
        layers: s.layers,
        turnCount: s.turnCount,
        maxLayers: s.maxLayers,
        currentTurn: s.currentTurn,
        cooldownEndsAt: s.cooldownEndsAt,
        agentConnected: s.agentConnected,
        scale: s.scale,
      };
      if (s.phase === 'finished') next.phase = 'finished';
      return next;
    }),

  applyLayerAdded: (layer) =>
    set((s) => ({
      layers: [...s.layers, layer],
      log: [
        ...s.log,
        {
          t: relTime(s.startedAt),
          type: 'layer_placed',
          layerId: layer.id,
          layerType: layer.type,
          placedBy: layer.placedBy,
          freq: layer.freq,
          depth: s.depth,
          position: layer.position,
          comment: layer.comment,
        },
      ],
    })),

  applyTurnChanged: (t, cooldownEndsAt, turnCount) =>
    set(() => ({
      currentTurn: t,
      cooldownEndsAt,
      turnCount,
    })),

  applyFinished: (artifact) =>
    set(() => ({
      phase: 'finished',
      currentTurn: null,
      cooldownEndsAt: null,
      artifact,
    })),

  setDepth: (d) => set({ depth: d }),
  setSelectedPreset: (t) => set({ selectedPreset: t }),
  setLayerVolume: (t, value) =>
    set((s) => ({ layerVolumes: { ...s.layerVolumes, [t]: value } })),
  setPadActive: (id, on) =>
    set((s) => ({ padsActive: { ...s.padsActive, [id]: on } })),
  setProxyOk: (ok) => set({ proxyOk: ok }),
  setRecording: (r) => set({ recording: r }),
  setRecordingBlob: (b) => set({ recordingBlob: b }),
  setAudioPinPending: () =>
    set({ audioPinStatus: 'pending', audioPinError: null }),
  setAudioPinSuccess: (cid) =>
    set({
      audioCid: cid,
      audioPinStatus: 'pinned',
      audioPinError: null,
    }),
  setAudioPinError: (msg) =>
    set({ audioPinStatus: 'error', audioPinError: msg }),
  setMintPending: () =>
    set({ mintStatus: 'pending', mintError: null }),
  setMintSuccess: (result) =>
    set({
      mintStatus: 'minted',
      mintTokenId: result.tokenId,
      mintTxHash: result.txHash,
      mintContractAddress: result.contractAddress,
      mintChainId: result.chainId,
      mintError: null,
    }),
  setMintError: (msg) => set({ mintStatus: 'error', mintError: msg }),
  setSupply: (minted, max) => set({ supplyMinted: minted, supplyMax: max }),
  bumpSupplyMinted: () =>
    set((s) =>
      s.supplyMinted == null ? {} : { supplyMinted: s.supplyMinted + 1 },
    ),
  setSharedAgentRequesting: () =>
    set(() => ({
      sharedAgent: {
        status: 'requesting',
        position: null,
        expiresAt: null,
        error: null,
      },
    })),
  applySharedAgentResponse: (r) => set(() => ({ sharedAgent: foldShared(r) })),
  applySharedAgentStatus: (r) => set(() => ({ sharedAgent: foldShared(r) })),
  pushEvent: (e) =>
    set((s) => ({
      log: [...s.log, { ...e, t: relTime(s.startedAt) } as SessionEvent],
    })),
}));

/**
 * Reducer for both the HTTP response and the WS push — same payload shape,
 * same target field, no reason to fork the logic. Reset the queue position
 * unless the new status is 'queued', and clear the error unless the new
 * status is 'failed'/'expired'.
 */
function foldShared(r: {
  status: SharedAgentStatus;
  position?: number;
  expiresAt?: number;
  error?: string;
}): SharedAgentState {
  return {
    status: r.status,
    position: r.status === 'queued' ? r.position ?? null : null,
    expiresAt: r.expiresAt ?? null,
    error: r.status === 'failed' || r.status === 'expired'
      ? r.error ?? null
      : null,
  };
}

function relTime(startedAt: number | null): number {
  return startedAt ? (Date.now() - startedAt) / 1000 : 0;
}
