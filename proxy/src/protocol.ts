/**
 * Sonoglyph WS protocol — shared between bridge (proxy) and frontend.
 *
 * NOTE: This file is mirrored in `web/src/net/protocol.ts`. Keep them
 * in sync when changing message shapes.
 *
 * Flow:
 *
 *   1. Browser opens ws → sends `hello`.
 *   2. Bridge replies `state` with full snapshot.
 *   3. Player clicks → browser sends `place_layer`.
 *   4. Bridge validates, broadcasts `layer_added` (placedBy='player'),
 *      switches turn to 'agent', emits `turn_changed` (cooldownEndsAt set).
 *   5. Bridge schedules agent turn — emits `agent_thinking`.
 *      During this, agent calls MCP `place_layer` (Day 5) — for Day 4
 *      it's a stub timer producing a random placement.
 *   6. Bridge broadcasts `layer_added` (placedBy='agent', comment),
 *      switches turn back to 'player'.
 *   7. Repeat until `layers.length === MAX_LAYERS` → `finished` is sent.
 */

export const MAX_LAYERS = 35;
export const COOLDOWN_MS = 10_000;

export type LayerType = 'drone' | 'texture' | 'pulse' | 'glitch' | 'breath';

export const LAYER_TYPES: LayerType[] = [
  'drone',
  'texture',
  'pulse',
  'glitch',
  'breath',
];

export interface PlacedLayer {
  id: string;
  type: LayerType;
  position: [number, number, number];
  freq: number;
  bornAt: number;
  placedBy: 'player' | 'agent';
  comment?: string;
}

export type GamePhase = 'lobby' | 'playing' | 'finished';
export type CurrentTurn = 'player' | 'agent';

export interface GameStateSnapshot {
  phase: GamePhase;
  layers: PlacedLayer[];
  turnCount: number;
  maxLayers: number;
  currentTurn: CurrentTurn | null;
  cooldownEndsAt: number | null;
  agentBusy: boolean;
}

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------
export type ClientMessage =
  | { type: 'hello' }
  | {
      type: 'place_layer';
      layerType: LayerType;
      position: [number, number, number];
      freq: number;
    };

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------
export type ServerMessage =
  | { type: 'state'; state: GameStateSnapshot }
  | { type: 'layer_added'; layer: PlacedLayer }
  | {
      type: 'turn_changed';
      currentTurn: CurrentTurn;
      cooldownEndsAt: number | null;
      turnCount: number;
    }
  | { type: 'agent_thinking' }
  | { type: 'finished'; reason: 'max_layers' }
  | { type: 'error'; message: string };
