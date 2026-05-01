/**
 * MCP server — exposes Sonoglyph game tools to the player's local Hermes.
 *
 * Wire model:
 *   - Each browser session has its own GameSession (in the registry) and
 *     its own MCP `Server` instance + `WebStandardStreamableHTTPServerTransport`.
 *   - The pairing code lives in the URL: `/mcp?code=XXXXXX`. Every HTTP
 *     request from Hermes carries it.
 *   - We use **stateless** mode for the transport (no MCP-level session
 *     IDs) — pairing is done at the URL layer, which is simpler and fits
 *     better with a registry that's already keyed by code.
 *
 * Tools surfaced to Hermes:
 *
 *   get_state()
 *     → current game state (whose turn, layers placed so far, finished?).
 *
 *   wait_for_my_turn(timeout_sec?: number = 120)
 *     → long-poll. Resolves with `it_is_my_turn: true` once cooldown passes
 *       and currentTurn === 'agent'. Returns `finished: true` if the game
 *       ends while waiting. Returns `timed_out: true` after the timeout.
 *
 *   place_layer(type, comment)
 *     → places the agent's layer. Bridge auto-positions. `comment` is shown
 *       to the player as the agent's reaction (capped at 200 chars). Type
 *       is one of: drone | texture | pulse | glitch | breath | bell |
 *       drip | swell | chord.
 *
 * Hermes' loop (the player invokes this once via `hermes chat -q "..."`):
 *
 *     while True:
 *       res = wait_for_my_turn()
 *       if res.finished: break
 *       place_layer(type, comment)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

import { GameSession } from './game.js';
import { GameRegistry } from './registry.js';
import { LAYER_TYPES, type LayerType } from './protocol.js';
import {
  describeScale,
  INTENT_DESCRIPTIONS,
  INTENT_VALUES,
  type Intent,
} from './theory.js';

// One MCP server + transport per game session. Built lazily on first MCP
// hit for a given code (Hermes reaches us before or after the browser does
// — either order is fine).
interface McpEntry {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  // Wired callback that flips agentConnected on/off.
  detach: () => void;
}

const mcpBySession = new Map<string, McpEntry>();

const layerTypeSchema = z.enum(LAYER_TYPES as [LayerType, ...LayerType[]]);
const intentSchema = z.enum(INTENT_VALUES as [Intent, ...Intent[]]);

/**
 * Build (or reuse) the MCP server for a given session, then route the
 * incoming Request through its transport. Called from the Hono /mcp route.
 */
export async function handleMcpRequest(
  registry: GameRegistry,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const ua = request.headers.get('user-agent') ?? '?';
  console.log(
    `[mcp] ${request.method} ${url.pathname}${url.search}  ua="${ua.slice(0, 60)}"`,
  );

  if (!code) {
    return new Response(
      JSON.stringify({
        error: 'missing ?code= query parameter',
        hint:
          'Open the Sonoglyph web app first; it will give you a code and a hermes mcp add command.',
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  const game = registry.get(code);
  if (!game) {
    return new Response(
      JSON.stringify({ error: 'unknown session code', code }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  }

  // Robust handshake handling: a POST without Mcp-Session-Id is always a
  // fresh `initialize`. If we have a cached transport from a previous
  // client (now zombie — it has _initialized=true with a stale sessionId),
  // a fresh initialize would fail with 400 "Server already initialized".
  // The MCP client SDK's `close()` does not send HTTP DELETE, so our
  // onsessionclosed callback never fires for orderly client teardowns —
  // we cannot rely on DELETE to recycle. Drop the cached transport on
  // every fresh POST handshake instead.
  if (
    request.method === 'POST' &&
    !request.headers.get('mcp-session-id') &&
    mcpBySession.has(code)
  ) {
    console.log(`[mcp ${code}] fresh handshake — recycling stale transport`);
    disposeMcpForSession(code);
  }

  let entry = mcpBySession.get(code);
  if (!entry) entry = createMcpForSession(code, game);

  return entry.transport.handleRequest(request);
}

/** Drop the MCP server for a code (called when the GameSession is GC'd). */
export function disposeMcpForSession(code: string): void {
  const entry = mcpBySession.get(code);
  if (!entry) return;
  entry.detach();
  entry.server.close().catch(() => {});
  mcpBySession.delete(code);
}

function createMcpForSession(code: string, game: GameSession): McpEntry {
  const scale = game.getScale();
  const intentLines = (Object.keys(INTENT_DESCRIPTIONS) as Intent[])
    .map((k) => `    - ${k}: ${INTENT_DESCRIPTIONS[k]}`)
    .join('\n');

  // The instructions string is read by Hermes once at handshake. We put the
  // descent-specific musical context here so Kimi can reason about pitch
  // and mood across turns instead of just picking layer types in isolation.
  const instructions = [
    `You are co-composing Sonoglyph — a turn-based ambient/noise music descent — with a human.`,
    ``,
    `This descent unfolds in **${describeScale(scale)}**.`,
    `All layers (yours and the player's) are pitched within this scale, so think of yourself as choosing where in that key to land.`,
    ``,
    `Loop: call wait_for_my_turn, then place_layer(type, comment, intent?). Stop when the game finishes.`,
    ``,
    `Layer types — pick the one that fits the moment:`,
    `  drone   — low sustained foundation`,
    `  texture — airy filtered noise, no clear pitch`,
    `  pulse   — slow rhythmic tone`,
    `  glitch  — brief noisy disturbance`,
    `  breath  — vocal exhalation`,
    `  bell    — resonant struck tone with long decay`,
    `  drip    — sparse single tonal pings`,
    `  swell   — slow filtered wave that approaches and recedes`,
    `  chord   — harmonic pad (root + fifth + octave)`,
    ``,
    `Intent (optional, biases the pitch within the descent's key):`,
    intentLines,
    ``,
    `Comment is ONE short evocative line (<80 chars) reacting to the music so far.`,
    `Vary your type AND intent across the descent — a sequence like`,
    `(drone hush) → (drone color) → (bell tension) → (chord release) builds shape;`,
    `repeating the same type with the same intent flattens the composition.`,
  ].join('\n');

  const server = new McpServer(
    { name: 'sonoglyph', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions,
    },
  );

  // ---- get_state -----------------------------------------------------------
  server.registerTool(
    'get_state',
    {
      description:
        'Return the current game state: whose turn it is, layers placed ' +
        'so far, turn count, and whether the game has finished.',
      inputSchema: {},
    },
    async () => {
      console.log(`[mcp ${code}] tool: get_state`);
      const s = game.snapshot();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(serializeStateForAgent(s, game), null, 2),
          },
        ],
      };
    },
  );

  // ---- wait_for_my_turn ----------------------------------------------------
  server.registerTool(
    'wait_for_my_turn',
    {
      description:
        'Long-polls until it becomes the agent\'s turn AND the cooldown ' +
        'window has elapsed (~10s after the last placement). Returns the ' +
        'fresh state plus a flag indicating whether you can act. If the ' +
        'game ends while waiting, returns finished=true.',
      inputSchema: {
        timeout_sec: z
          .number()
          .min(1)
          .max(300)
          .optional()
          .describe('Max seconds to block. Default 120.'),
      },
    },
    async ({ timeout_sec }) => {
      const ms = (timeout_sec ?? 120) * 1000;
      console.log(`[mcp ${code}] tool: wait_for_my_turn (timeout=${ms}ms)`);
      const res = await game.awaitAgentTurn(ms);
      console.log(`[mcp ${code}]   → ${res.kind}`);
      const payload = {
        it_is_my_turn: res.kind === 'ready',
        finished: res.kind === 'finished',
        timed_out: res.kind === 'timeout',
        state: serializeStateForAgent(res.state, game),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  // ---- place_layer ---------------------------------------------------------
  server.registerTool(
    'place_layer',
    {
      description:
        'Place a sound layer of the given type. The bridge picks the 3D ' +
        'position and the pitch — pitch is snapped to the descent\'s key ' +
        '(see initial instructions for the scale), and your `intent` ' +
        'biases which scale degree gets chosen. Provide a short evocative ' +
        'comment (<80 chars) — it\'s shown to the player as your reaction.',
      inputSchema: {
        type: layerTypeSchema.describe(
          'drone | texture | pulse | glitch | breath | bell | drip | swell | chord',
        ),
        comment: z
          .string()
          .min(1)
          .max(200)
          .describe('Short evocative line shown to the player.'),
        intent: intentSchema
          .optional()
          .describe(
            'Compositional intent — biases the pitch toward dissonant ' +
              'or consonant degrees of the descent\'s scale. ' +
              'tension=♭2/tritone/leading-tone, release=root/fifth, ' +
              'color=♭6/6th/9th, emphasis=third, hush=low root. ' +
              'Omit to let the bridge pick a comfortable pitch.',
          ),
      },
    },
    async ({ type, comment, intent }) => {
      console.log(
        `[mcp ${code}] tool: place_layer type=${type} intent=${intent ?? '-'} "${comment.slice(
          0,
          60,
        )}"`,
      );
      const result = game.agentPlace(type, comment, intent);
      if (!result.ok) {
        console.log(`[mcp ${code}]   → REJECTED: ${result.error}`);
        return {
          isError: true,
          content: [
            { type: 'text', text: JSON.stringify({ ok: false, error: result.error }) },
          ],
        };
      }
      const layer = result.layer!;
      console.log(
        `[mcp ${code}]   → placed @ [${layer.position
          .map((n) => n.toFixed(1))
          .join(',')}] freq=${layer.freq.toFixed(2)}Hz`,
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                placed: {
                  type: layer.type,
                  position: layer.position,
                  freq_hz: Number(layer.freq.toFixed(2)),
                  intent: intent ?? null,
                  comment: layer.comment,
                },
                turn: game.snapshot().turnCount,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ---- transport (stateful: one transport per MCP session lifecycle).
  //
  // Pairing rule: pair the GameSession on a real MCP `initialize`. Random
  // probes (Telegram link previews, web crawlers) hit /mcp with GET, never
  // make it through initialize, and so don't pair.
  //
  // Lifecycle quirk we MUST handle: Hermes opens MCP transiently. Each of
  // `hermes mcp add`, `hermes mcp test`, and every tool-call cycle from
  // `hermes chat` ends with an explicit HTTP DELETE that the SDK turns
  // into `transport.close()`. After close, the transport instance is
  // unusable for fresh connections (it still has _initialized=true with
  // a stale sessionId, so a fresh initialize gets rejected as 400). We
  // therefore drop the cached entry on close so the next request mints
  // a fresh transport. agentConnected on the GameSession is sticky — we
  // do NOT flip it back to false on close, see GameSession.setAgentConnected.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: () => {
      console.log(`[mcp ${code}] session initialized — agent paired`);
      game.setAgentConnected(true);
    },
    onsessionclosed: () => {
      console.log(
        `[mcp ${code}] session closed — dropping transport, pairing remains`,
      );
      // Drop the now-zombie transport so the next request makes a fresh one.
      const stale = mcpBySession.get(code);
      if (stale && stale.server === server) {
        mcpBySession.delete(code);
        server.close().catch(() => {});
      }
    },
  });
  server.connect(transport).catch((err) => {
    console.error(`[mcp:${code}] connect failed`, err);
  });

  const detach = () => {
    game.setAgentConnected(false);
  };

  const entry: McpEntry = { server, transport, detach };
  mcpBySession.set(code, entry);
  return entry;
}

/**
 * Compact state shape for the agent. Hermes doesn't need internal IDs
 * or born timestamps — only what's musically meaningful.
 *
 * Each placed layer reports its pitch (`freq_hz`), so the agent can read
 * the trajectory of the composition and decide e.g. "we've hit the root
 * three times in a row, time for a tension move". Scale info is included
 * so the agent can reason about pitch choices in key terms even if it
 * forgot the initial instructions.
 */
function serializeStateForAgent(
  s: ReturnType<GameSession['snapshot']>,
  _game: GameSession,
) {
  return {
    phase: s.phase,
    turn_count: s.turnCount,
    max_layers: s.maxLayers,
    current_turn: s.currentTurn,
    cooldown_remaining_ms: s.cooldownEndsAt
      ? Math.max(0, s.cooldownEndsAt - Date.now())
      : 0,
    scale: {
      key: `${s.scale.rootName} ${s.scale.modeName}`,
      feel: s.scale.feel,
    },
    layers_placed: s.layers.map((l) => ({
      type: l.type,
      placed_by: l.placedBy,
      position: l.position.map((n) => Number(n.toFixed(2))),
      freq_hz: Number(l.freq.toFixed(2)),
      comment: l.comment,
    })),
  };
}
