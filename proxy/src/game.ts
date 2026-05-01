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
  DESCENT_SPEED_PER_SEC,
  LAYER_TYPES,
  MAX_LAYERS,
  type CurrentTurn,
  type FinalArtifact,
  type GameStateSnapshot,
  type LayerType,
  type PlacedLayer,
  type ServerMessage,
  type SessionScalePublic,
} from './protocol.js';
import {
  pickFreqForLayer,
  pickSessionScale,
  type Intent,
  type SessionScale,
} from './theory.js';

type Listener = (msg: ServerMessage) => void;

/** Resolution shape for `awaitAgentTurn`. */
export type AgentTurnResolution =
  | { kind: 'ready'; state: GameStateSnapshot }
  | { kind: 'finished'; state: GameStateSnapshot }
  | { kind: 'timeout'; state: GameStateSnapshot };

/** Snapshot of everything the bridge needs to mint a Sonoglyph for a session. */
export interface MintPayload {
  glyph: string;
  journal: string;
  audioCid: string;
  sessionCode: string;
  generatedBy: 'kimi' | 'fallback';
}

export class GameSession {
  readonly code: string;

  private layers: PlacedLayer[] = [];
  private turnCount = 0;
  private currentTurn: CurrentTurn | null = null;
  private cooldownEndsAt: number | null = null;
  private agentConnected = false;
  private phase: 'lobby' | 'playing' | 'finished' = 'lobby';
  private finalArtifact: FinalArtifact | null = null;
  // Picked once at construction; immutable for the lifetime of the descent.
  // Both player clicks and agent place_layer calls go through this scale
  // when choosing pitches, so every layer in the session shares a key.
  private readonly scale: SessionScale = pickSessionScale();
  // Wall-clock when the descent started; used to project the current camera
  // depth on the bridge so agent-placed layers land in the player's view.
  private gameStartedAt: number | null = null;

  // IPFS CID (Pinata-pinned) of the descent's WebM recording. Set once the
  // /pin/audio endpoint successfully forwards the blob and gets a CID back.
  // Required to assemble a MintPayload — the audio is the ONE part of the
  // artifact that doesn't fit cleanly on-chain.
  private audioCid: string | null = null;
  // After a successful mint via /mint, we lock the session so a second
  // click can't spawn a duplicate token. tokenId is decimal-string for JSON
  // ergonomics (uint256 doesn't round-trip through Number).
  private mintedTokenId: string | null = null;
  private mintTxHash: string | null = null;

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
      scale: this.scalePublic(),
    };
  }

  /** Full scale info for in-process callers (mcp.ts uses this for prompts). */
  getScale(): SessionScale {
    return this.scale;
  }

  /** Public-shape scale for wire payloads. */
  scalePublic(): SessionScalePublic {
    return {
      rootPc: this.scale.rootPc,
      rootName: this.scale.rootName,
      modeName: this.scale.modeName,
      feel: this.scale.feel,
      // Slice so a client mutating the array can't reach back through the
      // wire shape into our authoritative scale (it can't, but defensive).
      intervals: this.scale.intervals.slice(),
    };
  }

  getPhase(): 'lobby' | 'playing' | 'finished' {
    return this.phase;
  }

  hasAgent(): boolean {
    return this.agentConnected;
  }

  /**
   * Called by the bridge when Hermes' MCP transport pairs to this session.
   *
   * Pairing is **sticky** — once we've seen a real MCP `initialize` from
   * Hermes for this code, we consider the agent paired for the lifetime
   * of the GameSession. The reason: Hermes opens MCP transiently. Both
   * `hermes mcp add` (tool discovery) and each tool-call cycle from
   * `hermes chat` end with an explicit DELETE that tears the session
   * down. Treating those DELETEs as "agent disconnected" would make the
   * HUD bounce on every action and gate the Begin button incorrectly.
   *
   * Trade-off: if the player closes their WSL terminal mid-game, we'll
   * still report PAIRED until the session is GC'd. The player will
   * notice because Hermes stops making moves; the bridge can't distinguish
   * "Hermes is between tool-calls" from "Hermes has gone away" without
   * polling, which we don't want to do over MCP.
   */
  setAgentConnected(connected: boolean): void {
    if (!connected) {
      // Ignore disconnect signals from MCP transport closes — see comment
      // above. We only ever report "paired" once it happens.
      return;
    }
    if (this.agentConnected) return;
    this.agentConnected = true;
    this.broadcast({ type: 'agent_paired' });
  }

  /** Begin the descent. Requires the agent to be paired. */
  start(): { ok: boolean; error?: string } {
    if (this.phase !== 'lobby') return fail('already started');
    if (!this.agentConnected) return fail('agent not paired yet');
    this.phase = 'playing';
    this.currentTurn = 'player';
    this.gameStartedAt = Date.now();
    this.broadcast({ type: 'state', state: this.snapshot() });
    return { ok: true };
  }

  /**
   * Player attempts to place a layer. The player has no `intent` parameter
   * — every click goes through the no-intent branch of the freq picker
   * (consonant-weighted random degree within the descent's scale). That
   * keeps the click-to-sound feedback loop tight while still landing every
   * pitch in the session's key.
   */
  playerPlace(
    layerType: LayerType,
    position: [number, number, number],
  ): { ok: boolean; error?: string } {
    if (this.phase !== 'playing') return fail('not playing');
    if (this.currentTurn !== 'player') return fail('not your turn');
    if (this.cooldownEndsAt && Date.now() < this.cooldownEndsAt)
      return fail('cooldown');
    if (this.layers.length >= MAX_LAYERS) return fail('max layers reached');
    if (!LAYER_TYPES.includes(layerType)) return fail(`unknown type: ${layerType}`);

    const freq = pickFreqForLayer(this.scale, layerType, undefined);

    this.appendLayer({ type: layerType, position, freq, placedBy: 'player' });
    this.afterPlace('player');
    return { ok: true };
  }

  /**
   * Agent (Hermes via MCP) attempts to place a layer.
   *
   * Position is computed by the server — Hermes only picks type + comment.
   *
   * `intent` is the agent's compositional intent for this placement
   * (`tension`, `release`, `color`, `emphasis`, `hush`). It biases the
   * pitch within the descent's scale: e.g. `tension` favors the ♭2 / tritone
   * / leading tone, `release` settles on root or fifth. Optional — if the
   * agent omits it we fall back to the same consonant-weighted random
   * choice the player gets.
   */
  agentPlace(
    layerType: LayerType,
    comment: string,
    intent?: Intent,
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

    const position = pickAgentPosition(this.gameStartedAt ?? Date.now());
    const freq = pickFreqForLayer(this.scale, layerType, intent);

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

  // ---------------------------------------------------------------------------
  // Mint-flow helpers — the bridge owns audioCid + mint state authoritatively.
  // The browser tells the bridge nothing more than `playerAddress`; everything
  // else (glyph, journal, CID, sessionCode) comes out of session memory, so a
  // misbehaving client can't slip in fake content.
  // ---------------------------------------------------------------------------

  /** Set when /pin/audio finishes a successful Pinata pin. */
  setAudioCid(cid: string): void {
    this.audioCid = cid;
  }

  getAudioCid(): string | null {
    return this.audioCid;
  }

  /**
   * Build the payload for {@link Sonoglyph.mintDescent}. Returns null if any
   * piece is missing — caller should surface a "not ready" error rather than
   * minting with placeholders.
   */
  getMintPayload(): MintPayload | null {
    if (!this.finalArtifact) return null;
    if (!this.audioCid) return null;
    return {
      glyph: this.finalArtifact.glyph,
      journal: this.finalArtifact.journal,
      audioCid: this.audioCid,
      sessionCode: this.code,
      generatedBy: this.finalArtifact.generatedBy,
    };
  }

  /** Idempotency lock — true if this session has already been minted. */
  isMinted(): boolean {
    return this.mintedTokenId !== null;
  }

  /** Recorded after a successful on-chain mint. */
  setMintResult(tokenId: string, txHash: string): void {
    this.mintedTokenId = tokenId;
    this.mintTxHash = txHash;
  }

  getMintResult(): { tokenId: string; txHash: string } | null {
    if (this.mintedTokenId === null || this.mintTxHash === null) return null;
    return { tokenId: this.mintedTokenId, txHash: this.mintTxHash };
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
// Position picker — drops the agent's orb onto the SAME placement plane
// (camera_y - 18) the player would click right now. We compute the camera's
// current Y on the bridge from `gameStartedAt + elapsed * speed`, mirroring
// the frontend's DescentCamera. The naive "lastY - 14" chain we used before
// silently broke once Hermes started thinking for 20-30s per turn — by the
// time the tool call landed, the camera had already moved tens of units past
// `lastY`, so the orb spawned far above the visible frustum.
// ---------------------------------------------------------------------------
function pickAgentPosition(
  gameStartedAt: number,
): [number, number, number] {
  const elapsedSec = (Date.now() - gameStartedAt) / 1000;
  const cameraY = -elapsedSec * DESCENT_SPEED_PER_SEC;
  // Match the frontend PlacementPlane offset (camera.y - 18) plus a small
  // jitter so consecutive agent moves don't pile up at exactly the same Y.
  const placementY = cameraY - 16 - Math.random() * 6;
  const angle = Math.random() * Math.PI * 2;
  const radius = 2 + Math.random() * 4;
  return [
    Math.cos(angle) * radius,
    placementY,
    -10 + Math.sin(angle) * 3,
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
