---
title: Per-session randomization
description: Three layers of variation — scale picker, per-layer pitch, and player/agent compositional choices — that make every descent sonically unique.
---

The "music theory" lives in `proxy/src/theory.ts`. Three layers of
variation combine, so two descents never sound the same — and not just
"shuffled versions of the same piece" but genuinely different keys,
modal colours, and pitch trajectories.

## 1. Scale picker — 96 starting points

At session creation the bridge picks a random root (12 pitch classes)
and a random mode (8 modes), then **locks them for the lifetime of the
descent**:

| Mode             | Feel                                                                 |
|------------------|----------------------------------------------------------------------|
| Aeolian          | classic minor — melancholy, settled, familiar                        |
| Dorian           | minor with a softened sixth — pensive but not despairing             |
| Phrygian         | dark, eastern, restless — flat second pulls everything toward unease |
| Lydian           | bright but strange — raised fourth, floating, unresolved             |
| Mixolydian       | major-ish but earthy — flat seventh, folkloric                       |
| Locrian          | unstable, hollow — diminished fifth refuses to resolve               |
| Harmonic Minor   | minor with a leading-tone bite — exotic, narrow tension              |
| Pentatonic Minor | no half-steps — gamelan-clean, every interval lands                  |

12 × 8 = **96 distinct (root, mode) combinations**. Comparing C Aeolian
to F♯ Lydian isn't "same music transposed" — they're different sonic
worlds, with different intervals, different harmonic gravity, and
different colour notes.

## 2. Per-layer randomization

Every placed layer (player or agent) goes through `pickFreqForLayer()`,
which composes three sources of variation:

- **Octave** — each layer type has a preferred octave range (drone
  oct 2, bell oct 4–5, drip oct 5–6, etc.). When the range has multiple
  options the engine picks randomly, so two `bell` placements in the
  same descent can land an octave apart.
- **Scale degree** — chosen from a candidate set derived from the
  player's click (no intent → consonant-weighted random) or the
  agent's `intent` parameter ([see below](#3-player--agent-compositional-choices)).
- **Sub-parameter jitter inside the engine** — chord amplitude is
  `0.0448 + Math.random() * 0.0358`; swell amplitude is
  `0.125 + Math.random() * 0.10`; glitch grain timing is randomised;
  drone filter has a static centre but the sub voice gets a random
  detune cent. None of these change the pitch, but they prevent two
  same-type layers from sounding identical.

## 3. Player + agent compositional choices

On top of pitch randomization, the actual **sequence** of layer types
and their spatial placement is unique per descent. The player chooses
7–8 types and where in 3D space to drop them; the agent picks the
other half driven by its own reading of the in-progress composition
(see [How Hermes decides](/agent/decisions/)).

## 4. Pads also derive from the session scale

The three atmospheric pads (`GLOW`, `AIR`, `DEEP`) build their voicings
from `scale.intervals`:

- `GLOW` — root + 3rd + 5th
- `AIR` — root + 5th + 9th
- `DEEP` — sub + root + 5th

So in C Aeolian the GLOW pad is C–E♭–G; in F♯ Lydian it's F♯–A♯–C♯.
Different notes, different intervals, different tonal colour. Pads
aren't a fixed sample bank — they're synthesised in-key on every
descent.

## Why this matters

Without (1), a session would always be in the same key — every minted
glyph would be tied to the same fundamental, and the agent's `tension`
would always mean the same interval. Without (2), every drone in a
descent would land on identical Hz. Without (3), the sequence would
collapse into agent-only or player-only patterns. Stacking the three
gives 96 × layer-choice × pitch-jitter possibilities, far more than the
~10⁴ tokens we expect to mint.
