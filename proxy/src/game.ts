/**
 * GameSession — authoritative game state for one descent.
 *
 * One instance per active session. Bridge currently spawns a single instance
 * (singleton); a future multi-user mode would hold a Map<sessionId, GameSession>.
 *
 * Responsibilities:
 *   - Track layers placed (player/agent), turn count, current turn, cooldowns
 *   - Enforce rules: 35-layer cap, 10s cooldown after each placement,
 *     player goes first, strict alternation
 *   - Schedule agent turns (Day 4: stub timer; Day 5: Hermes via MCP)
 *   - Broadcast state changes to subscribers (WS clients)
 */

import {
  COOLDOWN_MS,
  LAYER_TYPES,
  MAX_LAYERS,
  type CurrentTurn,
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

export class GameSession {
  private layers: PlacedLayer[] = [];
  private turnCount = 0;
  private currentTurn: CurrentTurn | null = null;
  private cooldownEndsAt: number | null = null;
  private agentBusy = false;
  private phase: 'lobby' | 'playing' | 'finished' = 'lobby';

  private listeners = new Set<Listener>();
  private agentScheduleTimer: NodeJS.Timeout | null = null;

  // Day 4: stub agent. Day 5: replaced by callAgent which talks to Hermes.
  private callAgent: (state: GameStateSnapshot) => Promise<{
    type: LayerType;
    position: [number, number, number];
    freq: number;
    comment: string;
  }>;

  constructor(opts?: {
    callAgent?: GameSession['callAgent'];
  }) {
    this.callAgent = opts?.callAgent ?? this.stubAgent.bind(this);
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
      agentBusy: this.agentBusy,
    };
  }

  start(): void {
    if (this.phase !== 'lobby') return;
    this.phase = 'playing';
    this.currentTurn = 'player';
    this.broadcast({ type: 'state', state: this.snapshot() });
  }

  /**
   * Player attempts to place a layer. Returns ok:false on rule violations.
   */
  playerPlace(
    layerType: LayerType,
    position: [number, number, number],
    freq: number,
  ): { ok: boolean; error?: string } {
    if (this.phase !== 'playing') return fail('not playing');
    if (this.currentTurn !== 'player') return fail('not your turn');
    if (this.cooldownEndsAt && Date.now() < this.cooldownEndsAt) return fail('cooldown');
    if (this.layers.length >= MAX_LAYERS) return fail('max layers reached');

    this.appendLayer({
      type: layerType,
      position,
      freq,
      placedBy: 'player',
    });
    this.afterPlace('player');
    return { ok: true };
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
      this.broadcast({ type: 'finished', reason: 'max_layers' });
      return;
    }

    this.cooldownEndsAt = Date.now() + COOLDOWN_MS;

    if (by === 'player') {
      this.currentTurn = 'agent';
      this.broadcast({
        type: 'turn_changed',
        currentTurn: 'agent',
        cooldownEndsAt: this.cooldownEndsAt,
        turnCount: this.turnCount,
      });
      this.scheduleAgentTurn();
    } else {
      this.currentTurn = 'player';
      this.broadcast({
        type: 'turn_changed',
        currentTurn: 'player',
        cooldownEndsAt: this.cooldownEndsAt,
        turnCount: this.turnCount,
      });
    }
  }

  /**
   * Kick off the agent's turn. The agent must respond within COOLDOWN_MS,
   * but in practice will respond faster — its layer appears as soon as ready,
   * the cooldown still runs to give the audio room to breathe.
   */
  private scheduleAgentTurn(): void {
    if (this.agentScheduleTimer) clearTimeout(this.agentScheduleTimer);

    this.agentBusy = true;
    this.broadcast({ type: 'agent_thinking' });

    // Small think-delay even for the stub so it feels deliberate.
    const thinkDelay = 1500 + Math.random() * 4500;

    this.agentScheduleTimer = setTimeout(async () => {
      try {
        const action = await this.callAgent(this.snapshot());
        this.agentBusy = false;
        this.appendLayer({
          type: action.type,
          position: action.position,
          freq: action.freq,
          placedBy: 'agent',
          comment: action.comment,
        });
        this.afterPlace('agent');
      } catch (err) {
        console.error('[game] agent turn failed', err);
        this.agentBusy = false;
        // Fallback: skip agent turn, return to player.
        this.currentTurn = 'player';
        this.broadcast({
          type: 'turn_changed',
          currentTurn: 'player',
          cooldownEndsAt: this.cooldownEndsAt,
          turnCount: this.turnCount,
        });
      }
    }, thinkDelay);
  }

  // ---------------------------------------------------------------------------
  // Stub agent — Day 4 only. Day 5 replaces this via constructor option.
  // Picks a random preset; positions deeper than the most recent layer so
  // the descent stays coherent.
  // ---------------------------------------------------------------------------
  private async stubAgent(state: GameStateSnapshot) {
    const lastY =
      state.layers.length > 0
        ? state.layers[state.layers.length - 1].position[1]
        : 0;

    const type = LAYER_TYPES[Math.floor(Math.random() * LAYER_TYPES.length)];
    const freqs = FREQS_BY_TYPE[type];
    const freq = freqs[Math.floor(Math.random() * freqs.length)];

    const angle = Math.random() * Math.PI * 2;
    const radius = 2 + Math.random() * 4;
    const position: [number, number, number] = [
      Math.cos(angle) * radius,
      lastY - (10 + Math.random() * 8),
      -(8 + Math.random() * 8) + Math.sin(angle) * 1.5,
    ];

    const comments: Record<LayerType, string[]> = {
      drone: ['Adding weight here.', 'Foundation needs depth.', 'A low resonance.'],
      texture: ['Air for the bones.', 'Some grain, then.', 'Static between the tones.'],
      pulse: ['A pulse to keep time.', 'Marking the descent.', 'Slow heartbeat.'],
      glitch: ['A break.', 'Mineral fracture.', 'Brief disturbance.'],
      breath: ['Something exhales.', 'A voice in the rock.', 'Breath through stone.'],
    };
    const comment = comments[type][Math.floor(Math.random() * comments[type].length)];

    return { type, position, freq, comment };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private broadcast(msg: ServerMessage): void {
    for (const fn of this.listeners) fn(msg);
  }
}

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

function cryptoRandomId(): string {
  // Node 19+ has globalThis.crypto.randomUUID
  if (
    typeof globalThis.crypto !== 'undefined' &&
    'randomUUID' in globalThis.crypto
  ) {
    return globalThis.crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
