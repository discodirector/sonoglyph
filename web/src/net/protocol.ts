/**
 * WS protocol — mirror of proxy/src/protocol.ts.
 * MUST stay in sync with the bridge.
 */

export const MAX_LAYERS = 15;
export const COOLDOWN_MS = 10_000;
export const DESCENT_SPEED_PER_SEC = 1000 / 360;

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
  agentConnected: boolean;
}

export interface FinalArtifact {
  journal: string;
  glyph: string;
  generatedBy: 'kimi' | 'fallback';
}

export type ClientMessage =
  | { type: 'hello' }
  | {
      type: 'place_layer';
      layerType: LayerType;
      position: [number, number, number];
      freq: number;
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
