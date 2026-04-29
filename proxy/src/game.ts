/**
 * GameSession — authoritative state for one descent.
 *
 * Day 5 model: bridge does NOT call any LLM during gameplay. The agent
 * is the player's own Hermes, talking to us over MCP. This class:
 *
 *   - Tracks layers, turn, cooldowns, agent connection
 *   - Validates moves from both sides (`playerPlace`, `agentPlace`)
 *   - Auto-positions agent layers (Hermes only chooses type + comment)
 *   - Provides `awaitAgentTurn()` for the MCP `wait_for_my_turn` tool —
 *     a Promise that resolves the moment it becomes the agent's turn
 *     AND the cooldown has elapsed
 *   - Broadcasts state changes to subscribers (browser WS clients)
 *
 * Cooldown rule: every placement (player or agent) starts a 10s window
 * during which nobody can act. After the window, it's the other side's
 * turn.
 */

import {
  COOLDOWN_MS,
  LAYER_TYPES,
  MAX_LAYERS,
  type CurrentTurn,
  type FinalArtifact,
  type GameStateSnapshot,
  type LayerType,
  type PlacedLayer,
  type ServerMessage,
} from './protocol.js';

const FREQS_BY_TYPE: Record<LayerType, number[]> = {
  drone: [55, 61.74, 65.41, 73.42, 82.41, 87.31],
  texture: [800],
  pulse: [110, 130.81, 146.83, 164.81, 196],
  glitch: [1500],
  breath: [730],
};

type Listener = (msg: ServerMessage) => void;

/** Resolution shape for `awaitAgentTurn`. */
export type AgentTurnResolution =
  | { kind: 'ready'; state: GameStateSnapshot }
  | { kind: 'finished'; state: GameStateSnapshot }
  | { kind: 'timeout'; state: GameStateSnapshot };

export class GameSession {
  readonly code: string;

  private layers: PlacedLayer[] = [];
  private turnCount = 0;
  private currentTurn: CurrentTurn | null = null;
  private cooldownEndsAt: number | null = null;
  private agentConnected = false;
  private phase: 'lobby' | 'playing' | 'finished' = 'lobby';
  private finalArtifact: FinalArtifact | null = null;

  private listeners = new Set<Listener>();
  private cooldownTimer: NodeJS.Timeout | null = null;
  private waiters: Array<() => boolean> = [];

  constructor(code: string) {
    this.code = code;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  snapshot(): GameStateSnapshot {
    return {
      phase: this.phase,
      layers: [...this.layers],
      turnCount: this.turnCount,
      maxLayers: MAX_LAYERS,
      currentTurn: this.currentTurn,
      cooldownEndsAt: this.cooldownEndsAt,
      agentConnected: this.agentConnected,
    };
  }

  getPhase(): 'lobby' | 'playing' | 'finished' {
    return this.phase;
  }

  hasAgent(): boolean {
    return this.agentConnected;
  }

  /** Called by the bridge when Hermes' MCP transport pairs to this session. */
  setAgentConnected(connected: boolean): void {
    if (this.agentConnected === connected) return;
    this.agentConnected = connected;
    this.broadcast({ type: connected ? 'agent_paired' : 'agent_disconnected' });

    // If agent dropped out mid-game, unblock anyone waiting (they'll see the
    // resolution as a stale state and can re-poll).
    if (!connected) this.fireWaiters();
  }

  /** Begin the descent. Requires the agent to be paired. */
  start(): { ok: boolean; error?: string } {
    if (this.phase !== 'lobby') return fail('already started');
    if (!this.agentConnected) return fail('agent not paired yet');
    this.phase = 'playing';
    this.currentTurn = 'player';
    this.broadcast({ type: 'state', state: this.snapshot() });
    return { ok: true };
  }

  /** Player attempts to place a layer. */
  playerPlace(
    layerType: LayerType,
    position: [number, number, number],
    freq: number,
  ): { ok: boolean; error?: string } {
    if (this.phase !== 'playing') return fail('not playing');
    if (this.currentTurn !== 'player') return fail('not your turn');
    if (this.cooldownEndsAt && Date.now() < this.cooldownEndsAt)
      return fail('cooldown');
    if (this.layers.length >= MAX_LAYERS) return fail('max layers reached');

    this.appendLayer({ type: layerType, position, freq, placedBy: 'player' });
    this.afterPlace('player');
    return { ok: true };
  }

  /**
   * Agent (Hermes via MCP) attempts to place a layer.
   * Position is computed by the server — Hermes only picks type + comment.
   */
  agentPlace(
    layerType: LayerType,
    comment: string,
  ): {
    ok: boolean;
    error?: string;
    layer?: PlacedLayer;
  } {
    if (this.phase !== 'playing') return fail('not playing');
    if (this.currentTurn !== 'agent') return fail('not your turn');
    if (this.cooldownEndsAt && Date.now() < this.cooldownEndsAt)
      return fail('cooldown still active');
    if (this.layers.length >= MAX_LAYERS) return fail('max layers reached');
    if (!LAYER_TYPES.includes(layerType)) return fail(`unknown type: ${layerType}`);

    const position = pickAgentPosition(this.layers);
    const freqs = FREQS_BY_TYPE[layerType];
    const freq = freqs[Math.floor(Math.random() * freqs.length)];

    const layer = this.appendLayer({
      type: layerType,
      position,
      freq,
      placedBy: 'agent',
      comment: comment.slice(0, 200), // hard cap so a runaway agent can't flood
    });
    this.afterPlace('agent');
    return { ok: true, layer };
  }

  /**
   * Long-poll for the agent's turn. Resolves the moment:
   *   - the cooldown ends AND it's currently the agent's turn → 'ready'
   *   - the game finishes → 'finished'
   *   - the timeout elapses → 'timeout'
   *
   * Multiple concurrent waiters are allowed (e.g. if Hermes retries) but
   * only one can usefully act since `agentPlace` is rate-gated by state.
   */
  awaitAgentTurn(timeoutMs: number = 120_000): Promise<AgentTurnResolution> {
    return new Promise((resolve) => {
      let settled = false;

      const tryResolve = (): boolean => {
        if (settled) return true;
        if (this.phase === 'finished') {
          settled = true;
          resolve({ kind: 'finished', state: this.snapshot() });
          return true;
        }
        const cooldownPast =
          !this.cooldownEndsAt || Date.now() >= this.cooldownEndsAt;
        if (this.currentTurn === 'agent' && cooldownPast) {
          settled = true;
          resolve({ kind: 'ready', state: this.snapshot() });
          return true;
        }
        return false;
      };

      if (tryResolve()) return;

      this.waiters.push(tryResolve);

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          const idx = this.waiters.indexOf(tryResolve);
          if (idx >= 0) this.waiters.splice(idx, 1);
          resolve({ kind: 'timeout', state: this.snapshot() });
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  /** Called by the bridge once Kimi finishes — embedded into `finished`. */
  setFinalArtifact(artifact: FinalArtifact): void {
    this.finalArtifact = artifact;
    if (this.phase === 'finished') {
      // Artifact arrived after the initial finished broadcast — re-broadcast.
      this.broadcast({ type: 'finished', reason: 'max_layers', artifact });
    }
  }

  /** Tear down timers, drop subscribers. Used by registry GC. */
  dispose(): void {
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;
    this.waiters.length = 0;
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private appendLayer(opts: {
    type: LayerType;
    position: [number, number, number];
    freq: number;
    placedBy: CurrentTurn;
    comment?: string;
  }): PlacedLayer {
    const layer: PlacedLayer = {
      id: cryptoRandomId(),
      type: opts.type,
      position: opts.position,
      freq: opts.freq,
      bornAt: Date.now(),
      placedBy: opts.placedBy,
      comment: opts.comment,
    };
    this.layers.push(layer);
    this.turnCount += 1;
    this.broadcast({ type: 'layer_added', layer });
    return layer;
  }

  private afterPlace(by: CurrentTurn): void {
    if (this.layers.length >= MAX_LAYERS) {
      this.phase = 'finished';
      this.currentTurn = null;
      this.cooldownEndsAt = null;
      this.broadcast({
        type: 'finished',
        reason: 'max_layers',
        artifact: this.finalArtifact,
      });
      this.fireWaiters();
      return;
    }

    this.cooldownEndsAt = Date.now() + COOLDOWN_MS;
    this.currentTurn = by === 'player' ? 'agent' : 'player';
    this.broadcast({
      type: 'turn_changed',
      currentTurn: this.currentTurn,
      cooldownEndsAt: this.cooldownEndsAt,
      turnCount: this.turnCount,
    });

    // Schedule a wakeup at end of cooldown — that's when waiters should
    // potentially fire (only if it's now the agent's turn).
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.fireWaiters();
    }, COOLDOWN_MS);
    if (typeof this.cooldownTimer.unref === 'function') this.cooldownTimer.unref();
  }

  /** Iterate waiters, dropping the ones that resolved. */
  private fireWaiters(): void {
    if (this.waiters.length === 0) return;
    const snapshot = [...this.waiters];
    for (const w of snapshot) {
      if (w()) {
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) this.waiters.splice(idx, 1);
      }
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const fn of this.listeners) fn(msg);
  }
}

// ---------------------------------------------------------------------------
// Position picker — keeps the descent visually coherent regardless of what
// type Hermes chooses. Each layer drops 10–18 units below the previous one,
// scattered around a narrow cone in front of the camera.
// ---------------------------------------------------------------------------
function pickAgentPosition(
  existing: PlacedLayer[],
): [number, number, number] {
  const lastY = existing.length > 0 ? existing[existing.length - 1].position[1] : 0;
  const angle = Math.random() * Math.PI * 2;
  const radius = 2 + Math.random() * 4;
  return [
    Math.cos(angle) * radius,
    lastY - (10 + Math.random() * 8),
    -(8 + Math.random() * 8) + Math.sin(angle) * 1.5,
  ];
}

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

function cryptoRandomId(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    'randomUUID' in globalThis.crypto
  ) {
    return globalThis.crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
