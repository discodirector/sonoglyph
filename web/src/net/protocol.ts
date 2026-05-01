/**
 * WS protocol — mirror of proxy/src/protocol.ts.
 * MUST stay in sync with the bridge.
 */

export const MAX_LAYERS = 15;
export const COOLDOWN_MS = 10_000;
export const DESCENT_SPEED_PER_SEC = 1000 / 360;

export type LayerType =
  | 'drone'
  | 'texture'
  | 'pulse'
  | 'glitch'
  | 'breath'
  | 'bell'
  | 'drip'
  | 'swell'
  | 'chord';

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

/** Wire-format view of the descent's musical key. */
export interface SessionScalePublic {
  rootPc: number;     // 0..11
  rootName: string;   // 'F#'
  modeName: string;   // 'Phrygian'
  feel: string;
}

export interface GameStateSnapshot {
  phase: GamePhase;
  layers: PlacedLayer[];
  turnCount: number;
  maxLayers: number;
  currentTurn: CurrentTurn | null;
  cooldownEndsAt: number | null;
  agentConnected: boolean;
  scale: SessionScalePublic;
}

export interface FinalArtifact {
  journal: string;
  glyph: string;
  generatedBy: 'kimi' | 'fallback';
}

export type ClientMessage =
  | { type: 'hello' }
  | {
      // freq is decided server-side from the descent's scale — see theory.ts
      // on the bridge. The chosen pitch comes back via `layer_added`.
      type: 'place_layer';
      layerType: LayerType;
      position: [number, number, number];
    };

export type ServerMessage =
  | {
      type: 'session_created';
      code: string;
      mcpUrl: string;
      hermesCommand: string;
      hermesAddCommand: string;
      hermesPrompt: string;
    }
  | { type: 'agent_paired' }
  | { type: 'agent_disconnected' }
  | { type: 'state'; state: GameStateSnapshot }
  | { type: 'layer_added'; layer: PlacedLayer }
  | {
      type: 'turn_changed';
      currentTurn: CurrentTurn;
      cooldownEndsAt: number | null;
      turnCount: number;
    }
  | {
      type: 'finished';
      reason: 'max_layers';
      artifact: FinalArtifact | null;
    }
  | { type: 'error'; message: string };
