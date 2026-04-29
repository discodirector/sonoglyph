/**
 * GameRegistry — owns all live GameSessions, keyed by short pairing codes.
 *
 * Day 5 architecture:
 *   - Browser opens WS → registry mints a fresh session + code, hands it back.
 *   - Player runs `hermes mcp add sonoglyph --url .../mcp?code=XXX` →
 *     MCP transport looks up the same code → session is paired.
 *
 * Codes use an unambiguous alphabet (no I/O/0/1) so they can be read aloud
 * or copied without confusion. Sessions are GC'd after `idleMs` of no
 * activity (no WS messages, no MCP calls).
 */

import { GameSession } from './game.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

interface Entry {
  game: GameSession;
  createdAt: number;
  lastActiveAt: number;
}

export class GameRegistry {
  private sessions = new Map<string, Entry>();
  private gcTimer: NodeJS.Timeout;

  constructor(private idleMs: number = 30 * 60 * 1000) {
    this.gcTimer = setInterval(() => this.gc(), 60_000);
    // Don't keep the process alive just for the GC timer.
    if (typeof this.gcTimer.unref === 'function') this.gcTimer.unref();
  }

  /** Mint a brand-new session with a unique code. */
  create(): { code: string; game: GameSession } {
    let code: string;
    let attempts = 0;
    do {
      code = generateCode();
      if (++attempts > 100) {
        // Astronomical odds, but bail loudly rather than spin forever.
        throw new Error('failed to generate unique session code');
      }
    } while (this.sessions.has(code));

    const game = new GameSession(code);
    this.sessions.set(code, {
      game,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    });
    return { code, game };
  }

  /** Look up an existing session; touches lastActive. Returns null if missing. */
  get(code: string): GameSession | null {
    const entry = this.sessions.get(code);
    if (!entry) return null;
    entry.lastActiveAt = Date.now();
    return entry.game;
  }

  /** Manually retire a session (called on terminal states / disconnect). */
  drop(code: string): void {
    const entry = this.sessions.get(code);
    if (entry) entry.game.dispose();
    this.sessions.delete(code);
  }

  /** Approximate count for /health. */
  size(): number {
    return this.sessions.size;
  }

  private gc(): void {
    const cutoff = Date.now() - this.idleMs;
    for (const [code, entry] of this.sessions) {
      if (entry.lastActiveAt < cutoff) {
        entry.game.dispose();
        this.sessions.delete(code);
      }
    }
  }
}

function generateCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) {
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return s;
}
