/**
 * Per-IP mint rate limiter for the `/mint` endpoint.
 *
 * Why this exists: the on-chain contract enforces one-mint-per-address,
 * but airdrop farmers happily rotate fresh wallet addresses through a
 * single IP to siphon mints out of the 250-token supply. The contract
 * cannot see IPs; this is the IP-level brake that sits in front of the
 * chain call. Caddy already populates X-Forwarded-For with the real
 * client IP, and the existing `/agents/spawn` handler in index.ts uses
 * the same extraction pattern (xff || x-real-ip || 'unknown') we rely
 * on here.
 *
 * Policy: at most {@link MAX_MINTS_PER_WINDOW} successful mints per IP
 * within a rolling {@link WINDOW_MS}-millisecond window. Idempotent
 * cached responses (`game.isMinted()` returned true) do NOT consume a
 * slot — only mints that actually broadcast a fresh on-chain
 * transaction count.
 *
 * Storage: in-memory `Map`. The bridge process rarely restarts and
 * a restart resets the counters, which is the acceptable failure mode
 * for a hackathon. Promote to SQLite when persistence matters.
 *
 * Race safety: {@link reserveMintSlot} adds the timestamp BEFORE the
 * chain call. If the chain call fails, {@link releaseMintSlot} rolls
 * the reservation back so the IP isn't punished for a transient RPC
 * problem. Concurrent requests from the same IP see each other's
 * pending reservations during the `await mintSonoglyph(...)` window,
 * which closes the race that a plain "check then mint, record after
 * success" pattern would leave open.
 */

const WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours
const MAX_MINTS_PER_WINDOW = 2;

/** ip → sorted array of mint timestamps within the current window. */
const history = new Map<string, number[]>();

export interface RateLimitDecision {
  allowed: boolean;
  /** Unix ms when the oldest mint falls out of the window and a slot frees. */
  resetAt?: number;
  /** Number of mints (or pending reservations) for this IP right now. */
  used: number;
  limit: number;
  /** Seconds until the next slot frees. Convenient for the Retry-After header. */
  retryAfterSec?: number;
}

/**
 * Pre-flight check — does NOT mutate state. Suitable for a cheap 429
 * before we do any heavy work. The downstream caller MUST still call
 * {@link reserveMintSlot} just before broadcasting the chain
 * transaction, to close the await-window race.
 */
export function checkMintAllowed(ip: string): RateLimitDecision {
  const now = Date.now();
  const all = history.get(ip) ?? [];
  const recent = all.filter((t) => now - t < WINDOW_MS);
  // Prune old entries opportunistically — keeps the Map from
  // monotonically growing as stale timestamps age out.
  if (recent.length !== all.length) {
    if (recent.length === 0) history.delete(ip);
    else history.set(ip, recent);
  }
  if (recent.length >= MAX_MINTS_PER_WINDOW) {
    const resetAt = recent[0] + WINDOW_MS;
    return {
      allowed: false,
      resetAt,
      retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      used: recent.length,
      limit: MAX_MINTS_PER_WINDOW,
    };
  }
  return {
    allowed: true,
    used: recent.length,
    limit: MAX_MINTS_PER_WINDOW,
  };
}

/**
 * Atomically reserve a slot for this IP. Returns the reservation
 * timestamp so the caller can roll it back via {@link releaseMintSlot}
 * if the chain call subsequently fails.
 *
 * Call this AFTER all cheap validation and AFTER the cached-mint
 * idempotency check, but BEFORE `mintSonoglyph(...)`. The reservation
 * is what stops two parallel mint requests from the same IP from both
 * passing {@link checkMintAllowed} while one is mid-flight.
 */
export function reserveMintSlot(ip: string): number {
  const now = Date.now();
  const all = history.get(ip) ?? [];
  const recent = all.filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  history.set(ip, recent);
  return now;
}

/**
 * Roll back a reservation created by {@link reserveMintSlot}. Call
 * this in the catch arm of the chain mint so a transient RPC failure
 * doesn't burn the IP's slot.
 */
export function releaseMintSlot(ip: string, slot: number): void {
  const all = history.get(ip);
  if (!all) return;
  const idx = all.indexOf(slot);
  if (idx === -1) return;
  all.splice(idx, 1);
  if (all.length === 0) history.delete(ip);
}
