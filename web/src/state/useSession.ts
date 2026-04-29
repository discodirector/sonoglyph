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
 *   'finished' — 35 layers reached; HUD pivots to journal + glyph.
 */

import { create } from 'zustand';
import {
  type CurrentTurn,
  type FinalArtifact,
  type GameStateSnapshot,
  type LayerType,
  type PlacedLayer,
  MAX_LAYERS,
} from '../net/protocol';

export { type LayerType, type PlacedLayer };

export const LAYER_TYPES: LayerType[] = [
  'drone',
  'texture',
  'pulse',
  'glitch',
  'breath',
];

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

  // --- client-owned ---
  depth: number;
  selectedPreset: LayerType;
  proxyOk: boolean | null;
  recording: boolean;
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
  setProxyOk: (ok: boolean) => void;
  setRecording: (r: boolean) => void;
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

  depth: 0,
  selectedPreset: 'drone',
  proxyOk: null,
  recording: false,
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
  setProxyOk: (ok) => set({ proxyOk: ok }),
  setRecording: (r) => set({ recording: r }),
  pushEvent: (e) =>
    set((s) => ({
      log: [...s.log, { ...e, t: relTime(s.startedAt) } as SessionEvent],
    })),
}));

function relTime(startedAt: number | null): number {
  return startedAt ? (Date.now() - startedAt) / 1000 : 0;
}
