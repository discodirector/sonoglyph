/**
 * AgentPool — slot manager for ephemeral "shared" Hermes agents.
 *
 * Players who don't have their own Hermes install can ask the bridge to
 * spawn one for them. The pool keeps:
 *
 *   - At most `maxConcurrent` agents running at once (default 5; an 8 GB
 *     VPS can sleeve ~150 MB per Hermes × 5 = ~750 MB which leaves plenty
 *     for the bridge + Caddy + descents in progress).
 *   - A FIFO queue of waiting sessions when slots are full. Each queued
 *     session's WS connection receives a `shared_agent_status` push with
 *     its current position; positions update when a slot frees up.
 *   - A daily counter (UTC midnight rollover) capped at `dailyCap` to keep
 *     the operator's OpenAI subscription bill bounded. Default 250 matches
 *     the NFT max-supply so we don't pay to spawn agents beyond what can
 *     ever be minted.
 *   - A per-IP rate limit (1 spawn per minute by default) to prevent a
 *     single client opening dozens of sessions and starving the queue.
 *
 * The pool is provider-agnostic about what an "agent" is — it talks to
 * `spawnHermesAgent()` from spawn.ts via a clean SpawnedAgent interface.
 *
 * Status callbacks: the pool emits `(sessionCode, PoolStatus)` events to
 * the `listener` passed in the constructor. The bridge wires the listener
 * to GameSession.notifyAgentStatus(), which broadcasts to the session's
 * WS subscribers. We deliberately don't import GameSession here — this
 * file should be testable in isolation.
 */

import { loadSpawnConfig, spawnHermesAgent, type SpawnedAgent } from './spawn.js';

export type AgentStatus = 'queued' | 'spawning' | 'active' | 'expired' | 'failed';

export interface PoolStatus {
  status: AgentStatus;
  /** 1-based queue position for status='queued'. */
  position?: number;
  /** Unix ms when the agent will be killed (status='active'/'spawning'). */
  expiresAt?: number;
  /** Human-readable error for status='failed'/'expired'. */
  error?: string;
}

export type StatusListener = (sessionCode: string, status: PoolStatus) => void;

export interface PoolConfig {
  maxConcurrent: number;
  dailyCap: number;
  sessionTimeoutMs: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
}

const DEFAULT_CONFIG: PoolConfig = {
  maxConcurrent: 5,
  dailyCap: 250,
  sessionTimeoutMs: 10 * 60 * 1000,
  rateLimitWindowMs: 60 * 1000,
  rateLimitMaxRequests: 1,
};

export function loadPoolConfig(): PoolConfig {
  return {
    maxConcurrent: numberOrDefault(
      process.env.SHARED_AGENT_MAX_CONCURRENT,
      DEFAULT_CONFIG.maxConcurrent,
    ),
    dailyCap: numberOrDefault(
      process.env.SHARED_AGENT_DAILY_CAP,
      DEFAULT_CONFIG.dailyCap,
    ),
    sessionTimeoutMs: numberOrDefault(
      process.env.SHARED_AGENT_TIMEOUT_MS,
      DEFAULT_CONFIG.sessionTimeoutMs,
    ),
    rateLimitWindowMs: numberOrDefault(
      process.env.SHARED_AGENT_RATE_LIMIT_MS,
      DEFAULT_CONFIG.rateLimitWindowMs,
    ),
    rateLimitMaxRequests: numberOrDefault(
      process.env.SHARED_AGENT_RATE_LIMIT_MAX,
      DEFAULT_CONFIG.rateLimitMaxRequests,
    ),
  };
}

interface ActiveAgent {
  agent: SpawnedAgent;
  expiresAt: number;
  killTimer: NodeJS.Timeout;
}

interface QueuedEntry {
  sessionCode: string;
  enqueuedAt: number;
}

export class AgentPool {
  private readonly config: PoolConfig;
  private readonly listener: StatusListener;
  private readonly active = new Map<string, ActiveAgent>();
  private readonly queue: QueuedEntry[] = [];
  private readonly ipHistory = new Map<string, number[]>();
  private dailyCount = 0;
  private dailyResetAt: number;

  constructor(listener: StatusListener, config?: Partial<PoolConfig>) {
    this.config = { ...loadPoolConfig(), ...config };
    this.listener = listener;
    this.dailyResetAt = computeNextUtcMidnight();
  }

  /**
   * Player requests a shared agent. Returns the immediate post-decision
   * status; the caller relays that back to the browser as the HTTP
   * response. Subsequent transitions (queued → spawning, spawning → active,
   * active → expired) arrive via the `listener` callback.
   *
   * Idempotent for repeated calls on the same session: if the session
   * already has an active or queued agent, returns its current status
   * without enqueuing again.
   */
  async request(
    sessionCode: string,
    ip: string,
  ): Promise<PoolStatus> {
    this.rolloverDaily();

    // Idempotency
    const existing = this.active.get(sessionCode);
    if (existing) {
      return { status: 'active', expiresAt: existing.expiresAt };
    }
    const queueIdx = this.queue.findIndex((q) => q.sessionCode === sessionCode);
    if (queueIdx >= 0) {
      return { status: 'queued', position: queueIdx + 1 };
    }

    // Per-IP rate limit (NOT per-session — sessions are 6-char codes that
    // anyone can mint by opening a fresh WS, so rate-limiting per session
    // would be trivially bypassed).
    if (!this.checkIpRate(ip)) {
      return {
        status: 'failed',
        error: 'Too many spawn requests from your IP. Try again in a minute.',
      };
    }

    // Daily cap — checked AFTER rate limit so the rate-limit counter still
    // applies (otherwise spammers could probe the cap status for free).
    if (this.dailyCount >= this.config.dailyCap) {
      return {
        status: 'failed',
        error: `Daily limit reached (${this.config.dailyCap} shared agents today). ` +
          `Either bring your own Hermes or come back tomorrow.`,
      };
    }

    // Slot available — spawn immediately.
    if (this.active.size < this.config.maxConcurrent) {
      try {
        await this.spawnFor(sessionCode);
        const a = this.active.get(sessionCode);
        return { status: 'spawning', expiresAt: a?.expiresAt };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { status: 'failed', error: `Spawn failed: ${message}` };
      }
    }

    // No slot — enqueue.
    this.queue.push({ sessionCode, enqueuedAt: Date.now() });
    const position = this.queue.length;
    // Push status to WS as well so the frontend's queue overlay updates
    // even if its HTTP response races with the listener callback.
    this.listener(sessionCode, { status: 'queued', position });
    return { status: 'queued', position };
  }

  /**
   * Promote 'spawning' → 'active' on a confirmed MCP handshake. The bridge
   * calls this from the WS subscriber when the game emits `agent_paired`
   * (which is wired from the MCP transport's `onsessioninitialized`).
   *
   * Idempotent: no-op if the session isn't actually spawning (e.g. BYO
   * sessions reach `agent_paired` without ever going through the pool).
   */
  markActive(sessionCode: string): void {
    const active = this.active.get(sessionCode);
    if (!active) return;
    this.listener(sessionCode, {
      status: 'active',
      expiresAt: active.expiresAt,
    });
  }

  /**
   * Remove a session from the queue or kill its active agent. Called from
   * the WS-close handler when the browser disconnects so we don't keep a
   * dead session in the queue (or burn an OpenAI-billed slot on a tab
   * that's gone).
   */
  cancel(sessionCode: string): void {
    const queueIdx = this.queue.findIndex((q) => q.sessionCode === sessionCode);
    if (queueIdx >= 0) {
      this.queue.splice(queueIdx, 1);
      this.broadcastQueuePositions();
      return;
    }
    const active = this.active.get(sessionCode);
    if (active) {
      console.log(`[pool ${sessionCode}] cancel — killing active agent`);
      void active.agent.kill();
      // release() fires from the exit listener wired in spawnFor.
    }
  }

  /** Health/telemetry snapshot, mostly for /health surfacing. */
  status(): {
    active: number;
    queued: number;
    dailyCount: number;
    dailyCap: number;
    maxConcurrent: number;
  } {
    this.rolloverDaily();
    return {
      active: this.active.size,
      queued: this.queue.length,
      dailyCount: this.dailyCount,
      dailyCap: this.config.dailyCap,
      maxConcurrent: this.config.maxConcurrent,
    };
  }

  // ---- internals ----------------------------------------------------------

  private async spawnFor(sessionCode: string): Promise<void> {
    this.dailyCount += 1;
    const spawnConfig = loadSpawnConfig();
    const agent = await spawnHermesAgent(sessionCode, spawnConfig);
    const expiresAt = Date.now() + this.config.sessionTimeoutMs;

    // Hard timeout: if the descent runs long, kill the agent so it doesn't
    // hog a slot indefinitely. 10 minutes is generous — a vanilla descent
    // is ~6 minutes (15 layers × ~10 s cooldown × both sides + agent
    // thinking).
    const killTimer = setTimeout(() => {
      console.log(
        `[pool ${sessionCode}] hard timeout (${this.config.sessionTimeoutMs}ms) — killing agent`,
      );
      void agent.kill();
    }, this.config.sessionTimeoutMs);
    if (typeof killTimer.unref === 'function') killTimer.unref();

    this.active.set(sessionCode, { agent, expiresAt, killTimer });
    this.listener(sessionCode, { status: 'spawning', expiresAt });

    // When the process exits (natural or kill), free the slot and pull
    // the next queued session in.
    agent.exitPromise.then(({ code, signal }) => {
      this.release(sessionCode, code, signal);
    });
  }

  private release(
    sessionCode: string,
    code: number | null,
    signal: string | null,
  ): void {
    const active = this.active.get(sessionCode);
    if (!active) return;
    clearTimeout(active.killTimer);
    this.active.delete(sessionCode);

    // Natural exit = exit code 0 with no signal = wait_for_my_turn returned
    // finished:true and the agent walked off the stage cleanly. In that
    // case the game already broadcast its own 'finished' WS event and there
    // is no need to confuse the player with an extra "expired" notification.
    const naturalExit = code === 0 && !signal;
    if (!naturalExit) {
      const detail = signal ? `killed by ${signal}` : `exited with code ${code}`;
      console.log(`[pool ${sessionCode}] non-zero exit (${detail})`);
      this.listener(sessionCode, {
        status: 'expired',
        error: detail,
      });
    }

    // Pull next from queue.
    if (this.queue.length > 0 && this.active.size < this.config.maxConcurrent) {
      const next = this.queue.shift()!;
      this.spawnFor(next.sessionCode).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[pool ${next.sessionCode}] failed to spawn from queue:`, message);
        this.listener(next.sessionCode, {
          status: 'failed',
          error: message,
        });
      });
    }
    // Even after dequeuing, remaining queued sessions might shift up.
    this.broadcastQueuePositions();
  }

  private broadcastQueuePositions(): void {
    for (let i = 0; i < this.queue.length; i += 1) {
      this.listener(this.queue[i].sessionCode, {
        status: 'queued',
        position: i + 1,
      });
    }
  }

  private rolloverDaily(): void {
    if (Date.now() >= this.dailyResetAt) {
      console.log(`[pool] daily counter rollover (was ${this.dailyCount})`);
      this.dailyCount = 0;
      this.dailyResetAt = computeNextUtcMidnight();
    }
  }

  private checkIpRate(ip: string): boolean {
    const now = Date.now();
    const cutoff = now - this.config.rateLimitWindowMs;
    const history = (this.ipHistory.get(ip) ?? []).filter((t) => t > cutoff);
    if (history.length >= this.config.rateLimitMaxRequests) {
      this.ipHistory.set(ip, history); // persist the trimmed slice
      return false;
    }
    history.push(now);
    this.ipHistory.set(ip, history);
    return true;
  }
}

function numberOrDefault(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function computeNextUtcMidnight(): number {
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime();
}
