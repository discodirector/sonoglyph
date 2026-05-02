---
title: MCP tool surface
description: The three tools the Sonoglyph bridge exposes to Hermes over MCP, and the handshake context Hermes receives at connect.
---

The agent the player hears is **their own Hermes**, running locally on
their machine, talking to the bridge over MCP. There is no server-side
LLM call during gameplay.

The bridge exposes three tools (defined in `proxy/src/mcp.ts`).

## `get_state()`

Read-only snapshot of the current descent. Hermes calls this whenever
it needs to reason about the in-progress composition.

```ts
{
  phase: 'pairing' | 'playing' | 'fading' | 'finished',
  turn_count: number,           // layers placed so far (0..15)
  max_layers: 15,
  current_turn: 'player' | 'agent',
  cooldown_remaining_ms: number,
  scale: {
    key: string,                // e.g. "F#"
    feel: string,               // human-readable mode line
  },
  layers_placed: Array<{
    type: LayerType,
    placed_by: 'player' | 'agent',
    position: { x: number, y: number, z: number },
    freq_hz: number,
    comment: string | null,
  }>,
  pads_active: Array<'GLOW' | 'AIR' | 'DEEP'>,
}
```

## `wait_for_my_turn(timeout_sec = 120)`

Long-poll. Resolves when:

- cooldown has elapsed **and** it's the agent's turn → `it_is_my_turn: true`,
  with the same payload as `get_state`,
- or the descent ends → `finished: true`,
- or the timeout expires → `timed_out: true`.

This is the loop primitive. Hermes typically calls it, places, then
calls it again. Letting the bridge gate on cooldown means the agent
never races past the player.

## `place_layer(type, comment, intent?)`

Places the agent's layer. Three arguments:

- `type` (required) — one of the nine layer types
  (`drone`, `texture`, `pulse`, `glitch`, `breath`, `bell`, `drip`,
  `swell`, `chord`).
- `comment` (required) — a short evocative line (≤80 chars) shown to
  the player as the layer lands. Also preserved in the placement log
  and later passed to Kimi as "poetic intent" when generating the
  glyph.
- `intent` (optional) — compositional bias mapping to scale degrees:
  - `tension` — ♭2 / tritone / leading tone
  - `release` — root or fifth
  - `color` — ♭6 / 6th / 9th
  - `emphasis` — third (defines major/minor character of the mode)
  - `hush` — low root only

The bridge fills in the position (just below the descending camera)
and computes the pitch via `pickFreqForLayer(scale, type, intent)`.
The agent doesn't pick frequencies in Hz — see
[How Hermes decides → Why the agent has musical agency](/agent/decisions/#why-the-agent-has-musical-agency-not-just-type-picking).

## Handshake context

When Hermes opens the MCP connection, the server returns a context
block describing this specific descent:

```text
You are co-composing Sonoglyph — a turn-based ambient/noise music
descent — with a human.

This descent unfolds in F♯ Lydian — bright but strange — raised fourth
gives a floating, unresolved quality.
All layers (yours and the player's) are pitched within this scale, so
think of yourself as choosing where in that key to land.

Loop: call wait_for_my_turn, then place_layer(type, comment, intent?).
Stop when the game finishes.

[9 layer types listed with descriptions]
[5 intent values listed with their scale-degree biases]

Vary your type AND intent across the descent — a sequence like
(drone hush) → (drone color) → (bell tension) → (chord release)
builds shape; repeating the same type with the same intent flattens
the composition.
```

The key/feel block is dynamically generated from the session's scale,
so two players' Hermes instances see different context blocks for
their respective descents.

## Transport

Streamable HTTP, served at `/mcp` on the bridge. Caddy reverse-proxies
with `flush_interval -1` so SSE chunks reach Hermes without buffering.
The pairing code in the URL (`hermes mcp add sonoglyph https://sonoglyph.xyz/mcp/<code>`)
is what binds Hermes's MCP session to the browser's WebSocket session.
