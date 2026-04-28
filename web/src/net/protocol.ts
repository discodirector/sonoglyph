/**
 * WS protocol — mirror of proxy/src/protocol.ts.
 * MUST stay in sync with the bridge.
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

export type ClientMessage =
  | { type: 'hello' }
  | {
      type: 'place_layer';
      layerType: LayerType;
      position: [number, number, number];
      freq: number;
    };

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
