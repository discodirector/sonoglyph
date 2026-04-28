/**
 * Session store — single source of truth for the descent (frontend side).
 *
 * Authority split:
 *   - Server (bridge) is authoritative for: layers, turnCount, currentTurn,
 *     cooldownEndsAt, agentBusy, game phase. Updates flow in via WS messages.
 *   - Client owns: depth (camera), selectedPreset, proxyOk, recording,
 *     agentComment (transient UI), local event log (FFT snapshots, etc).
 *
 * The local `log` exists for downstream artifacts (Kimi journal + ASCII glyph)
 * and contains things the server doesn't track — spectral snapshots, the
 * camera's continuous descent.
 */

import { create } from 'zustand';
import {
  type CurrentTurn,
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
// Local event log — feeds Kimi field journal + glyph generation later.
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
  | { t: number; type: 'agent_comment'; comment: string; depth: number }
  | { t: number; type: 'spectral_snapshot'; bands: number[]; depth: number };

// Distributive Omit so each union member keeps its discriminator/fields.
export type PendingEvent = SessionEvent extends infer E
  ? E extends SessionEvent
    ? Omit<E, 't'>
    : never
  : never;

// ---------------------------------------------------------------------------
// Phase machine (browser-side)
//   'intro'    — before Begin: nothing is happening, audio is silent.
//   'playing'  — game running (mirrored from server).
//   'finished' — 35 layers reached, awaiting glyph generation + mint.
// ---------------------------------------------------------------------------
export type Phase = 'intro' | 'playing' | 'finished';

interface SessionState {
  // --- mirrored from server ---
  phase: Phase;
  layers: PlacedLayer[];
  turnCount: number;
  maxLayers: number;
  currentTurn: CurrentTurn | null;
  cooldownEndsAt: number | null;
  agentBusy: boolean;

  // --- client-owned ---
  depth: number; // 0..1000 (camera y-mirror)
  selectedPreset: LayerType;
  proxyOk: boolean | null;
  recording: boolean;
  agentComment: string | null;
  startedAt: number | null;
  log: SessionEvent[];

  // --- intent: leave 'intro' (Begin clicked) ---
  beginLocal: () => void;

  // --- server message appliers ---
  applySnapshot: (s: GameStateSnapshot) => void;
  applyLayerAdded: (l: PlacedLayer) => void;
  applyTurnChanged: (
    t: CurrentTurn,
    cooldownEndsAt: number | null,
    turnCount: number,
  ) => void;
  applyAgentThinking: () => void;
  applyFinished: () => void;

  // --- client setters ---
  setDepth: (d: number) => void;
  setSelectedPreset: (t: LayerType) => void;
  setProxyOk: (ok: boolean) => void;
  setRecording: (r: boolean) => void;
  setAgentComment: (c: string | null) => void;
  pushEvent: (e: PendingEvent) => void;
}

export const useSession = create<SessionState>((set) => ({
  phase: 'intro',
  layers: [],
  turnCount: 0,
  maxLayers: MAX_LAYERS,
  currentTurn: null,
  cooldownEndsAt: null,
  agentBusy: false,

  depth: 0,
  selectedPreset: 'drone',
  proxyOk: null,
  recording: false,
  agentComment: null,
  startedAt: null,
  log: [],

  beginLocal: () =>
    set(() => ({
      phase: 'playing',
      startedAt: Date.now(),
      log: [{ t: 0, type: 'descent_started' }],
    })),

  applySnapshot: (s) =>
    set(() => {
      // Browser keeps its own phase: 'intro' until beginLocal, then 'playing'.
      // We only force 'finished' if the server says so; otherwise we leave
      // the local phase untouched (Partial set leaves it alone).
      const next: Partial<SessionState> = {
        layers: s.layers,
        turnCount: s.turnCount,
        maxLayers: s.maxLayers,
        currentTurn: s.currentTurn,
        cooldownEndsAt: s.cooldownEndsAt,
        agentBusy: s.agentBusy,
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
      // surface agent comment via dedicated field for HUD
      agentComment: layer.placedBy === 'agent' ? layer.comment ?? null : s.agentComment,
    })),

  applyTurnChanged: (t, cooldownEndsAt, turnCount) =>
    set(() => ({
      currentTurn: t,
      cooldownEndsAt,
      turnCount,
      // Clear agent comment when player's turn starts, so HUD doesn't
      // hold the last reply forever.
      ...(t === 'player' ? { agentComment: null } : {}),
    })),

  applyAgentThinking: () => set(() => ({ agentBusy: true })),

  applyFinished: () =>
    set(() => ({
      phase: 'finished',
      currentTurn: null,
      cooldownEndsAt: null,
      agentBusy: false,
    })),

  setDepth: (d) => set({ depth: d }),
  setSelectedPreset: (t) => set({ selectedPreset: t }),
  setProxyOk: (ok) => set({ proxyOk: ok }),
  setRecording: (r) => set({ recording: r }),
  setAgentComment: (c) => set({ agentComment: c }),
  pushEvent: (e) =>
    set((s) => ({
      log: [...s.log, { ...e, t: relTime(s.startedAt) } as SessionEvent],
    })),
}));

function relTime(startedAt: number | null): number {
  return startedAt ? (Date.now() - startedAt) / 1000 : 0;
}
