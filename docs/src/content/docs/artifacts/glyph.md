---
title: Glyph generation
description: The best-of-3 ASCII glyph pipeline — three concurrent Kimi calls, structural scoring, and a deterministic fallback.
---

The glyph is the visual condensation of a descent — a 32-wide, 16-tall
ASCII image rendered fully on-chain in the contract's `tokenURI`.
ASCII glyphs have high quality variance from Kimi: sometimes the model
produces a varied breathing composition, sometimes it falls back to
tiled wallpaper. The pipeline is built around that variance.

## Pipeline

### 1. Three candidates in parallel

Three concurrent calls at temperatures **0.7 / 0.9 / 1.0**. Distinct
enough that the candidates actually diverge instead of collapsing to
similar samples. We tried 0.6 / 0.7 / 0.8 first; the candidates were
nearly identical. The current spread sacrifices some "safe" outputs at
1.0 in exchange for diversity.

### 2. Each candidate gets a structured prompt

Four parts:

- **Output format**: 32 dashes (top boundary), 16 rows of glyph
  (≤32 chars each), 32 dashes (bottom boundary). No header, no
  explanation, no markdown.
- **Character set**: `` . - = + * # / \ | < > : ~ `` only. No letters,
  no numbers.
- **Composition rules**: must have a silhouette (rows have varied
  widths — think sculpture / rune / hieroglyph, not textured rectangle);
  plenty of negative space; every row unique; glyph evolves from top
  (descent surface) to bottom (deep end); each of 5 vertical bands uses
  its own derived character palette.
- **Negative + positive examples** inline — explicit
  *"this is wallpaper, do not do this"* and *"this is what we want"*,
  so the model has visual anchors instead of just prose rules.

### 3. Structured hints alongside the raw transcript

Two pieces of structure feed the prompt:

#### Band palettes

The descent is split into 5 vertical bands. Each band's character
palette is the union of `TYPE_GLYPHS` for the layer types that fell
into it:

| Type     | Glyph chars |
|----------|-------------|
| `drone`  | `# | =`     |
| `pulse`  | `+ =`       |
| `glitch` | `/ \ *`     |
| `texture`| `. -`       |
| `breath` | `- = < >`   |
| `bell`   | `* < >`     |
| `drip`   | `. :`       |
| `swell`  | `~ - =`     |
| `chord`  | `| = :`     |

So a band heavy in `drone + chord` produces a vertical-stack-flavoured
palette (`# | = :`), while a band of `glitch + drip + texture` produces
a sparse jagged palette (`/ \ * . :`). The shape of the descent
literally shapes the glyph's character distribution.

#### Poetic intent

Hermes's per-layer comments are lifted out of the transcript and
listed with their move number. The model treats these as form-shaping
images — `breath / exhale` → soft (`. - =`),
`glitch / fracture` → jagged (`/ \ *`),
`drone / floor` → solid (`# |`),
`drip / water` → isolated marks (`. :`).

### 4. Each candidate is scored, highest wins

`scoreGlyph()` rewards visual variation and silhouette shape, penalises
tile-like wallpaper:

```text
score = filledRows       * 1.0    // rows with ≥4 non-space chars (capped at 12)
      + uniqueFilled     * 0.4    // distinct filled rows
      + entropy          * 2.5    // Shannon entropy over char distribution
      + densityStdDev    * 1.5    // std-dev of fill-density across rows
      + silhouetteStdDev * 2.0    // std-dev of trimmed row WIDTH
      - tilePenalty      * 1.8    // repeating-segment runs ("<>.<>.<>." etc.)
```

The **silhouette term carries the heaviest weight** because it's the
strongest signal for *"is this a glyph with a shape vs a rectangle of
textured content"*. A solid block scores 0 on silhouette no matter
how varied its characters; a diamond / hourglass / asymmetric
silhouette scores high.

### 5. Extraction + normalization

`extractGlyph()` does the post-processing:

1. Looks for the dashed boundary lines. Tolerates `=` or `#`
   substitutions models occasionally produce instead of `-`.
2. If no boundary is found, falls back to the longest contiguous
   block of allowed characters in the response.
3. Each row is sanitised — anything outside the glyph charset becomes
   a space.
4. Rows are trimmed and either centre-padded (if short) or windowed to
   their densest 32-char span (if too wide).
5. Always 16 rows out, padded with empty rows if the model
   under-produced.

### 6. Fallback

If `KIMI_API_KEY` is unset or all three calls fail, `fallback()`
produces a deterministic glyph by tiling per-type characters across
the 32×16 grid in placement order. Plus the journal stub. The descent
always ends gracefully.

## Why best-of-3, not best-of-1

We tried single-call generation with various prompts and seed
strategies for two days. The hit rate for "actually a glyph, not
wallpaper" hovered around 60–70%. Best-of-3 with structural scoring
brings it above 95% — the worst output of three is rarely chosen,
and when all three are weak the scoring still picks the most varied
of the bunch.

The cost is three API calls per descent instead of one. At Kimi's
pricing this is negligible; at the player-experience level it's the
difference between *"sometimes the glyph is amazing"* and *"the glyph
is reliably interesting"*.
