---
title: Layers & pads
description: The nine layer types and three atmospheric pads — what each one sounds like and where it sits in the mix.
---

Sonoglyph builds its sound out of two families of voices: **layers**
(turn-consuming, one-shot envelopes triggered when you place an orb)
and **pads** (held atmospheric voices toggled from the bottom palette).
Both derive their pitch from the descent's scale.

## Layer types

Nine types. Each has a dedicated synth in `web/src/audio/engine.ts`,
a preferred octave range, and a glyph-character palette that feeds the
end-of-descent ASCII art (see [Artifacts → Glyph](/artifacts/glyph/)).

| Type     | Feel                                          | Glyph chars |
|----------|-----------------------------------------------|-------------|
| `drone`  | low fundamental, anchors the harmonic floor   | `#  |  =`   |
| `texture`| dust, friction, granular grain                | `.  -`      |
| `pulse`  | rhythmic body, mid-band                       | `+  =`      |
| `glitch` | broken, jagged, off-grid                      | `/  \  *`   |
| `breath` | filtered noise inhale/exhale                  | `-  =  <  >`|
| `bell`   | metallic strike, sustained                    | `*  <  >`   |
| `drip`   | isolated pitched mark                         | `.  :`      |
| `swell`  | slow rise-and-fall                            | `~  -  =`   |
| `chord`  | three-voice block in scale                    | `|  =  :`   |

The "feel" column is also the language Hermes sees in its handshake
context — it picks a type by reading what mood the composition needs,
not by choosing a frequency.

### Layer placement

When you click in the 3D scene, the click position (x,y,z) drives:

- the **spatial placement** of the orb in the descent column,
- the **scale-degree candidate set** the pitch picker draws from. The
  vertical position biases towards lower or higher degrees; horizontal
  position biases towards consonant or colour notes.

The agent's `place_layer` skips position entirely — the bridge picks a
spot just below the descending camera (`pickAgentPosition` in
`game.ts`) so the orb appears in front of the player.

## Pads

Three pads, opened by default at the start of a descent. Each one is a
held three-voice chord built from the session scale's intervals:

| Pad   | Voicing                | Bus peak |
|-------|------------------------|----------|
| `GLOW`| root + 3rd + 5th       | 0.208    |
| `AIR` | root + 5th + 9th       | 0.169    |
| `DEEP`| sub + root + 5th       | 0.234    |

Pads use `Tone.AmplitudeEnvelope` with a slow attack/release so toggling
on/off doesn't click. They're routed through their own `padBus` in the
master chain so the mixer's "PAD" channel attenuates all three together
without affecting layer levels.

### Why pads exist

Without them, the descent's harmonic floor is whatever the player and
agent place in `drone` slots. Pads give the player a way to set a
tonal atmosphere *between* layer placements without using a turn. They
also give the agent a stable harmonic context to read when picking its
next move — Hermes can see `pads_active: ["GLOW"]` in the state
snapshot and know the third is currently sounding.

## The mixer

A nine-channel volume mixer sits in the bottom-left during play, opened
by default. Each channel maps to one layer type's bus gain and ramps
over 50 ms when moved. Volumes persist across the session (in Zustand
state) but reset on reload.

The mixer is mostly a "trim" tool — defaults are tuned so a balanced
descent doesn't need touching. The reason it's open by default is that
testing showed first-time players didn't realise they could affect the
mix at all when it was hidden behind a button.
