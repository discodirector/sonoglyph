---
title: How Hermes decides
description: How the agent reads the state, picks a type and intent, and why intent is more powerful than picking pitches in Hz.
---

Hermes makes three choices on every `place_layer` call: **type**,
**comment**, **intent**. It bases those on two pieces of input.

## What Hermes reads each turn

1. **State snapshot** (returned by `wait_for_my_turn`): every layer
   placed so far, with type, who placed it, 3D position, frequency in
   Hz, and any comment. The agent sees the trajectory of the
   composition — *"we've hit the root three times in a row, time for a
   tension move"*.
2. **Initial handshake context**: the descent's scale, mode "feel",
   and the layer-type / intent guidance. See
   [MCP tool surface → Handshake context](/agent/mcp/#handshake-context).

## What Hermes picks

### `type` — one of nine layer types

`drone`, `texture`, `pulse`, `glitch`, `breath`, `bell`, `drip`,
`swell`, `chord`. Picked based on:

- **what's already in the mix** — does it need a low anchor (`drone`),
  a rhythmic body (`pulse`), a mark in the high register (`bell`,
  `drip`)?
- **descent depth** — early layers usually establish; late layers
  resolve or release.
- **the mood the agent wants to build** — comments from earlier
  placements (its own and the player's) show the trajectory.

### `comment` — a short evocative line

Under 80 characters. Floated into the HUD as the layer lands so the
player feels the agent is *responding to* the composition, not just
emitting moves. Comments are also preserved in the placement log and
passed to Kimi at end-of-descent as "poetic intent" — they directly
shape the glyph (see [Glyph generation](/artifacts/glyph/)).

### `intent` — the optional compositional bias

Five values, each mapping to a set of scale degrees:

| Intent     | Maps to                       | Use it for                           |
|------------|-------------------------------|--------------------------------------|
| `tension`  | ♭2 / tritone / leading tone   | restless, unresolved moves           |
| `release`  | root or fifth                 | stable, grounded moves               |
| `color`    | ♭6 / 6th / 9th                | flavour notes, modal character       |
| `emphasis` | third                         | declares major/minor of the mode     |
| `hush`     | low root only                 | recede, hand back to silence         |

The bridge intersects the intent's candidate degrees with the scale's
actual degree set, so e.g. `tension` in Pentatonic Minor (no half-steps)
falls back to the available colour notes instead of failing.

## Why the agent has musical agency, not just type-picking

Crucially, the agent doesn't pick a frequency in Hz. It picks a *role*
(`tension`, `release`, …) and the bridge maps that role onto the
descent's specific key. This means:

- Hermes can be told *"you're in F♯ Lydian"* and immediately understand
  what `tension` means in that mode (the ♯4 tritone) without needing
  to do music-theory arithmetic mid-tool-call.
- Two descents with the same agent moves but different scales sound
  completely different. The agent's musical *intent* is portable; the
  realisation is per-session.
- The agent gets harder to "break" — there is no way for it to pick a
  pitch outside the scale, because pitches are computed by the bridge
  from intent, not chosen by the model.

## Drone is special-cased

Drone ignores `intent` and is pinned to root or fifth. Its job is to
anchor the descent's harmonic floor; tension or colour on a low
fundamental doesn't read musically and pushes saw harmonics into
unpleasant resonance bands. Intent still drives the other 8 types.

## Why no server-side LLM

The agent the player hears is **their own Hermes**, on **their own
machine**. The bridge never calls an LLM during gameplay (Kimi only
runs after the 15th layer). This means:

- The player's local agent setup (model variant, system prompt
  customisation, Hermes config) directly affects what they hear.
- Different players hear genuinely different agents. The MCP context
  block is identical given the same session scale, but the model's
  reasoning, vocabulary, and pacing are local to that player's
  Hermes installation.
- Latency is bounded by `wait_for_my_turn` long-poll plus model
  inference time, both within the player's network. No round-trips
  to Anthropic / Nous / OpenAI.
