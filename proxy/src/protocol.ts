/**
 * Sonoglyph WS protocol — shared between bridge (proxy) and frontend.
 *
 * NOTE: This file is mirrored in `web/src/net/protocol.ts`. Keep them
 * in sync when changing message shapes.
 *
 * Per-session model (Day 5):
 *   - Each browser opens a WS without a code → bridge mints a fresh
 *     GameSession + 6-char code, sends `session_created` immediately.
 *   - Browser shows the code and the `hermes mcp add` command.
 *   - Player runs Hermes locally; Hermes connects via MCP using the same
 *     code → bridge pairs the MCP transport to the session and emits
 *     `agent_paired` to the browser.
 *   - Begin is gated until pairing.
 *
 * Game loop (after pairing + Begin):
 *   1. Player clicks → browser sends `place_layer`.
 *   2. Bridge validates, broadcasts `layer_added` (placedBy='player'),
 *      switches currentTurn='agent', emits `turn_changed` with cooldownEndsAt.
 *   3. After cooldown elapses, Hermes' `wait_for_my_turn` MCP call unblocks.
 *      Hermes thinks, then calls `place_layer` MCP tool with type+comment.
 *   4. Bridge picks a position automatically, broadcasts `layer_added`
 *      (placedBy='agent', comment), switches to 'player'.
 *   5. Repeat until `layers.length === MAX_LAYERS` → `finished` (with
 *      Kimi-generated journal + ASCII glyph attached).
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
  agentConnected: boolean;
}

/**
 * Final artifact produced by Kimi when the descent ends. Embedded in
 * the `finished` message so the browser can render journal + glyph
 * without a follow-up request.
 */
export interface FinalArtifact {
  journal: string;        // poetic field journal (markdown-ish prose)
  glyph: string;          // ASCII art (monospace, ~32x16 chars)
  generatedBy: 'kimi' | 'fallback';
}

// ---------------------------------------------------------------------------
// Client → Server (browser side)
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
// Server → Client (browser side)
// ---------------------------------------------------------------------------
export type ServerMessage =
  | {
      type: 'session_created';
      code: string;
      mcpUrl: string;
      // Recommended one-liner for the player to paste into their WSL.
      hermesCommand: string;
      // Minimal command to register the MCP server (without running chat).
      // Useful when the player wants to test the connection first via
      // `hermes mcp test sonoglyph` before launching the autonomous loop.
      hermesAddCommand: string;
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
