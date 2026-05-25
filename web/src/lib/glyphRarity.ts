/**
 * Sonoglyph rarity classifier — deterministic from the ASCII glyph string.
 *
 * Why off-chain
 * -------------
 * The deployed ERC-721 is immutable: its on-chain `attributes` only carry
 * session code / token id / mint date / creator. OpenSea cannot be told to
 * override that, and changing it on-chain would require redeploying. Instead
 * we classify every minted glyph here, in the frontend, and surface rarity
 * on the Sonoglyph atlas page and on the Finale screen.
 *
 * What this file IS
 * -----------------
 * A pure, side-effect-free function set. Given a 32×16 glyph string it
 * returns:
 *   - 5 trait axes (Density / Form / Lexicon / Anchor / Symmetry)
 *   - 1 archetype label (composite, primary display)
 *   - a rarity score and rank derived from the trait frequencies of the
 *     calibration corpus (currently the first 181 minted glyphs).
 *
 * Calibration model
 * -----------------
 * Bucket thresholds are *quantile snapshots* — taken once from a real
 * corpus of minted glyphs and frozen in {@link CALIBRATION} below. They
 * are not recomputed at runtime; the atlas does not need every viewer to
 * re-derive the same numbers. To refresh after more mints, run
 * `node scripts/recalibrate-rarity.mjs` and paste the output back in here.
 *
 * Why snapshots, not live quantiles: a per-glyph bucket should be stable
 * for the holder. If we recomputed quantiles every page-load, the same
 * token could drift between "Sparse" and "Balanced" as new mints arrive —
 * confusing and slightly insulting if you got demoted.
 *
 * Why 5 axes, not 6 (HANDOFF lists six)
 * -------------------------------------
 * The original sketch had Class/Density/Form/Lexicon/Field/Cadence; on a
 * sample of all 181 mints those collapsed to ~3 truly independent signals
 * (Class is composite; Form and Field overlap on a 32×16 canvas; Cadence
 * and Density correlate strongly). Five orthogonal axes give cleaner per-
 * trait ranks without redundant buckets.
 *
 * Why symmetry counts only over content cells
 * -------------------------------------------
 * Half-empty glyphs would otherwise score "Mirrored" automatically — two
 * empty halves are trivially symmetric. We only count cells where at
 * least one side has a non-space character, so symmetry reflects actual
 * compositional choice rather than where the glyph happens to end.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DensityLabel = 'Whisper' | 'Sparse' | 'Balanced' | 'Dense' | 'Saturated';
export type FormLabel = 'Block' | 'Spine' | 'Drift' | 'Sculpture' | 'Apparition';
export type AnchorLabel = 'Crown' | 'Rising' | 'Centered' | 'Diving' | 'Floor';
export type LexiconLabel = 'Monolith' | 'Spare' | 'Rich' | 'Polyglot';
export type SymmetryLabel = 'Skewed' | 'Echoed' | 'Mirrored';

export type Archetype =
  | 'Totem'
  | 'Cipher'
  | 'Sediment'
  | 'Matrix'
  | 'Sigil'
  | 'Halo'
  | 'Constellation'
  | 'Veil'
  | 'Weave'
  | 'Drift';

export interface GlyphTraits {
  density: DensityLabel;
  form: FormLabel;
  anchor: AnchorLabel;
  lexicon: LexiconLabel;
  symmetry: SymmetryLabel;
}

export interface GlyphMetrics {
  /** Fraction of the 32×16 grid occupied by non-space characters (0..1). */
  density: number;
  /** Std-dev of per-row content width — high = strong silhouette, low = block. */
  silhouette: number;
  /** Distinct non-space characters used (2..14 in practice). */
  uniqueChars: number;
  /** Vertical centroid of non-space cells (0..15). Low = top-heavy. */
  centroidY: number;
  /** Max of horizontal/vertical symmetry, counted only over content cells. */
  symmetry: number;
}

export interface GlyphAnalysis {
  traits: GlyphTraits;
  archetype: Archetype;
  metrics: GlyphMetrics;
  /**
   * Statistical rarity score: Σ (1 / freq(trait_value)). Higher = rarer.
   * Computed against {@link CALIBRATION.frequencies}, so a fresh glyph that
   * hasn't been minted yet still gets a comparable score.
   */
  rarityScore: number;
  /**
   * Per-axis frequencies expressed as a percentage of the calibration
   * corpus. Useful for trait badges (e.g. "Form: Sculpture · 20%").
   */
  traitPercents: Record<keyof GlyphTraits, number>;
}

// ---------------------------------------------------------------------------
// Calibration snapshot — refreshed by scripts/recalibrate-rarity.mjs
// ---------------------------------------------------------------------------

/**
 * Frozen calibration data.
 *
 * `thresholds` are quantile cut-points taken from the full corpus. For an
 * axis with 4 cuts (`[c0, c1, c2, c3]`), the buckets map as:
 *   value <  c0     → bucket 0 (rarest low)
 *   value <  c1     → bucket 1
 *   value <  c2     → bucket 2 (modal)
 *   value <  c3     → bucket 3
 *   value >= c3     → bucket 4 (rarest high)
 *
 * `frequencies` are raw counts in the calibration corpus. Divide by
 * `sampleSize` to get probabilities for the rarity score.
 */
export const CALIBRATION = {
  calibratedAt: '2026-05-23',
  sampleSize: 181,
  contractMaxSupply: 250,
  thresholds: {
    density: [0.11, 0.18, 0.30, 0.48],
    silhouette: [2.24, 4.57, 8.75, 14.37],
    centroidY: [2.38, 5.50, 7.62, 8.63],
    symmetry: [0.24, 0.45],
  },
  frequencies: {
    density: { Whisper: 16, Sparse: 38, Balanced: 70, Dense: 37, Saturated: 20 },
    form: { Block: 18, Spine: 36, Drift: 71, Sculpture: 36, Apparition: 20 },
    anchor: { Crown: 18, Rising: 36, Centered: 71, Diving: 37, Floor: 19 },
    lexicon: { Monolith: 9, Spare: 15, Rich: 77, Polyglot: 80 },
    symmetry: { Skewed: 54, Echoed: 71, Mirrored: 56 },
  },
} as const;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROWS = 16;
const COLS = 32;

const DENSITY_LABELS: readonly DensityLabel[] = [
  'Whisper', 'Sparse', 'Balanced', 'Dense', 'Saturated',
] as const;
const FORM_LABELS: readonly FormLabel[] = [
  'Block', 'Spine', 'Drift', 'Sculpture', 'Apparition',
] as const;
const ANCHOR_LABELS: readonly AnchorLabel[] = [
  'Crown', 'Rising', 'Centered', 'Diving', 'Floor',
] as const;
const SYMMETRY_LABELS: readonly SymmetryLabel[] = [
  'Skewed', 'Echoed', 'Mirrored',
] as const;

// ---------------------------------------------------------------------------
// Metrics extraction
// ---------------------------------------------------------------------------

/**
 * Normalise the input string to exactly ROWS lines of exactly COLS columns.
 * Glyphs from the bridge are already shaped this way (the contract stores
 * them verbatim from {@link extractGlyph} in proxy/src/kimi.ts), but we
 * defend against trailing-whitespace stripping by IPFS gateways or human
 * edits before passing through.
 */
function normalize(glyph: string): string[] {
  const lines = glyph.split('\n').slice(0, ROWS);
  while (lines.length < ROWS) lines.push('');
  return lines.map((l) => l.padEnd(COLS, ' ').slice(0, COLS));
}

/** Compute the raw numerical metrics for a single glyph. */
export function computeMetrics(glyph: string): GlyphMetrics {
  const rows = normalize(glyph);

  // Density + unique-char palette
  let nonSpace = 0;
  const chars = new Set<string>();
  for (const r of rows) {
    for (const c of r) {
      if (c !== ' ') {
        nonSpace++;
        chars.add(c);
      }
    }
  }
  const density = nonSpace / (ROWS * COLS);

  // Per-row content envelope (first non-space..last non-space) → silhouette
  // is the std-dev of that envelope across all 16 rows. Empty rows count as
  // width 0, which is what we want — they pull the std-dev up exactly when
  // the glyph has a distinctive "void" section.
  const widths: number[] = [];
  for (const r of rows) {
    const left = r.search(/\S/);
    if (left < 0) {
      widths.push(0);
      continue;
    }
    const revIdx = r.split('').reverse().join('').search(/\S/);
    const right = r.length - 1 - revIdx;
    widths.push(right - left + 1);
  }
  const meanW = widths.reduce((a, b) => a + b, 0) / ROWS;
  const silhouette = Math.sqrt(
    widths.reduce((a, b) => a + (b - meanW) ** 2, 0) / ROWS,
  );

  // Centroid Y. If the glyph is completely empty we default to the middle
  // so downstream classification doesn't divide by zero — but the density
  // bucket will already mark it as Whisper, so the anchor matters less.
  let sumY = 0;
  let n = 0;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (rows[y][x] !== ' ') {
        sumY += y;
        n++;
      }
    }
  }
  const centroidY = n > 0 ? sumY / n : ROWS / 2;

  // Symmetry — count only cells where AT LEAST ONE side has content.
  // Empty-vs-empty pairs would otherwise inflate the score on glyphs that
  // happen to have a vast empty half; that's not artistic symmetry, that's
  // "this glyph ends early".
  let vMatch = 0;
  let vTotal = 0;
  for (let i = 0; i < ROWS / 2; i++) {
    for (let c = 0; c < COLS; c++) {
      const top = rows[i][c] !== ' ';
      const bot = rows[ROWS - 1 - i][c] !== ' ';
      if (top || bot) {
        if (top === bot) vMatch++;
        vTotal++;
      }
    }
  }
  let hMatch = 0;
  let hTotal = 0;
  for (const r of rows) {
    for (let c = 0; c < COLS / 2; c++) {
      const lf = r[c] !== ' ';
      const rt = r[COLS - 1 - c] !== ' ';
      if (lf || rt) {
        if (lf === rt) hMatch++;
        hTotal++;
      }
    }
  }
  const vSym = vTotal > 0 ? vMatch / vTotal : 0;
  const hSym = hTotal > 0 ? hMatch / hTotal : 0;
  const symmetry = Math.max(vSym, hSym);

  return {
    density,
    silhouette,
    uniqueChars: chars.size,
    centroidY,
    symmetry,
  };
}

// ---------------------------------------------------------------------------
// Bucket assignment
// ---------------------------------------------------------------------------

function bucket<T extends string>(
  value: number,
  cuts: readonly number[],
  labels: readonly T[],
): T {
  for (let i = 0; i < cuts.length; i++) {
    if (value < cuts[i]) return labels[i];
  }
  return labels[labels.length - 1];
}

/**
 * Lexicon uses fixed (non-quantile) thresholds because the alphabet is
 * bounded at 14 characters. Quantile cuts would collapse: the 70th and
 * 90th percentile are both 13 chars (most Kimi glyphs use the full set),
 * which makes "Polyglot" and "Rich" the same bucket. Fixed thresholds
 * keep four distinguishable categories with a meaningful Monolith tail.
 */
function lexiconLabel(uniqueChars: number): LexiconLabel {
  if (uniqueChars <= 5) return 'Monolith';
  if (uniqueChars <= 9) return 'Spare';
  if (uniqueChars <= 12) return 'Rich';
  return 'Polyglot';
}

export function classifyTraits(m: GlyphMetrics): GlyphTraits {
  return {
    density: bucket(m.density, CALIBRATION.thresholds.density, DENSITY_LABELS),
    form: bucket(m.silhouette, CALIBRATION.thresholds.silhouette, FORM_LABELS),
    anchor: bucket(m.centroidY, CALIBRATION.thresholds.centroidY, ANCHOR_LABELS),
    lexicon: lexiconLabel(m.uniqueChars),
    symmetry: bucket(m.symmetry, CALIBRATION.thresholds.symmetry, SYMMETRY_LABELS),
  };
}

// ---------------------------------------------------------------------------
// Archetype assignment
// ---------------------------------------------------------------------------

/**
 * Map a trait vector to a single primary archetype. Rules are checked in
 * order — first match wins. Order matters: more specific composites come
 * before the catch-all defaults so a Totem-shaped glyph isn't accidentally
 * tagged as a Constellation.
 *
 * Distribution on the calibration corpus (n=181), pre-split:
 *   Drift 51%, Constellation 18%, Halo 8%, Sigil 7%, Totem 6%,
 *   Cipher 5%, Sediment 3%, Matrix 3%.
 *
 * That Drift bucket was too wide — half the supply under one label washes
 * out the signal a holder gets from their archetype. The middle-density
 * remainder is now split along the symmetry axis:
 *   Mirrored → Veil   (axis-folded composition)
 *   Echoed   → Weave  (repeating motif across the field)
 *   Skewed   → Drift  (off-balance organic flow — the true catch-all)
 * Measured post-split on the same n=181 corpus:
 *   Weave 30%, Constellation 18%, Veil 12%, Drift 9%, Halo 8%,
 *   Cipher 6%, Sigil 6%, Totem 6%, Sediment 3%, Matrix 2%.
 * Symmetry already feeds the per-trait rarity score, so the split only
 * relabels — it does not double-count rarity.
 */
export function classifyArchetype(t: GlyphTraits): Archetype {
  // Sparse rune sitting at the top, vast emptiness below.
  if (
    (t.anchor === 'Crown' || t.anchor === 'Rising') &&
    (t.density === 'Whisper' || t.density === 'Sparse') &&
    (t.lexicon === 'Monolith' || t.lexicon === 'Spare')
  ) {
    return 'Totem';
  }

  // Bottom-heavy heaviness — strata at the floor.
  if (
    t.anchor === 'Floor' &&
    (t.density === 'Dense' || t.density === 'Saturated')
  ) {
    return 'Sediment';
  }

  // Full rectangle of mid-density texture — wall, not silhouette.
  if (t.density === 'Saturated' && t.form === 'Block') return 'Matrix';

  // Anything else with a Crown anchor: a dense rune at the top.
  if (t.anchor === 'Crown') return 'Cipher';

  // Strong, asymmetric, hand-drawn form.
  if (
    (t.form === 'Sculpture' || t.form === 'Apparition') &&
    t.symmetry === 'Skewed'
  ) {
    return 'Sigil';
  }

  // Scattered marks across the whole canvas.
  if (t.density === 'Whisper' || t.density === 'Sparse') {
    return 'Constellation';
  }

  // Mirrored sculpture — ritual mark, almost an emblem.
  if (
    t.symmetry === 'Mirrored' &&
    (t.form === 'Sculpture' || t.form === 'Apparition')
  ) {
    return 'Halo';
  }

  // ---- former Drift bucket, split by symmetry axis ----

  // Mirrored, non-sculpture forms: a folded composition — the axis is the
  // structure, but without the strong silhouette that would have made it
  // a Halo.
  if (t.symmetry === 'Mirrored') return 'Veil';

  // Echoed: a motif repeats across the field without true mirror folding.
  // This is the largest of the three split sub-buckets in practice.
  if (t.symmetry === 'Echoed') return 'Weave';

  // Skewed mid-density remainder — true Drift: off-balance, organic flow,
  // neither mirrored nor repeating.
  return 'Drift';
}

// ---------------------------------------------------------------------------
// Rarity score
// ---------------------------------------------------------------------------

function freqPercent<K extends keyof GlyphTraits>(
  axis: K,
  value: GlyphTraits[K],
): number {
  // Cast through `Record<string, number>` because TypeScript can't infer
  // that the discriminated union values are valid keys of the frequency
  // table; the alternative is per-axis switch statements that buy us
  // nothing at runtime.
  const table = CALIBRATION.frequencies[axis] as Record<string, number>;
  const count = table[value as string] ?? 0;
  // Guard against an unseen label: if a future calibration adds a new
  // bucket without bumping the snapshot, count=0 would make freq=0 and
  // explode the rarity score. Treat unseen as one occurrence — slightly
  // optimistic but bounded.
  const safe = Math.max(count, 1);
  return safe / CALIBRATION.sampleSize;
}

function computeRarityScore(traits: GlyphTraits): number {
  let score = 0;
  // The ordering matters only for readability; the sum is commutative.
  score += 1 / freqPercent('density', traits.density);
  score += 1 / freqPercent('form', traits.form);
  score += 1 / freqPercent('anchor', traits.anchor);
  score += 1 / freqPercent('lexicon', traits.lexicon);
  score += 1 / freqPercent('symmetry', traits.symmetry);
  return score;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Full analysis for one glyph. Pure, deterministic, ~O(rows*cols) — runs
 * in well under a millisecond even on a low-end phone. Safe to call inline
 * in render code.
 */
export function analyzeGlyph(glyph: string): GlyphAnalysis {
  const metrics = computeMetrics(glyph);
  const traits = classifyTraits(metrics);
  const archetype = classifyArchetype(traits);
  const rarityScore = computeRarityScore(traits);

  const traitPercents: Record<keyof GlyphTraits, number> = {
    density: freqPercent('density', traits.density) * 100,
    form: freqPercent('form', traits.form) * 100,
    anchor: freqPercent('anchor', traits.anchor) * 100,
    lexicon: freqPercent('lexicon', traits.lexicon) * 100,
    symmetry: freqPercent('symmetry', traits.symmetry) * 100,
  };

  return { traits, archetype, metrics, rarityScore, traitPercents };
}

// ---------------------------------------------------------------------------
// Archetype descriptions — short lore for UI tooltips and atlas headers.
// ---------------------------------------------------------------------------

export const ARCHETYPE_DESCRIPTIONS: Record<Archetype, string> = {
  Totem:
    'A sparse rune at the top of the field, the rest of the descent left silent. ' +
    'Whisper-density, narrow palette, all weight on the surface.',
  Cipher:
    'A dense mark sitting at the crown of the canvas, almost legible — like ' +
    'three lines of an alphabet that doesn\'t exist.',
  Sediment:
    'Heaviness at the floor. The composition descends into something solid ' +
    'and settles there; the surface is empty.',
  Matrix:
    'A near-full rectangle of mid-density texture. No silhouette — the descent ' +
    'is the field itself.',
  Sigil:
    'A hand-drawn, asymmetric form with a distinct shape. Off-balance on ' +
    'purpose; reads like a single gesture rather than a pattern.',
  Halo:
    'A mirrored sculpture — strong silhouette folded across an axis. Ritual ' +
    'or emblematic; the symmetry is the point.',
  Constellation:
    'Scattered marks across the whole field with no obvious centre. Light ' +
    'density, full canvas, the eye picks its own grouping.',
  Veil:
    'A mid-density composition folded across an axis — mirrored, but without ' +
    'the strong silhouette of a Halo. The fold is structural, not decorative.',
  Weave:
    'A repeating motif spread across the field. Echoed rather than mirrored: ' +
    'the same gesture restated until it becomes texture.',
  Drift:
    'The middle of the descent. Mid-density, skewed, no extreme anchor — ' +
    'an off-balance organic flow, the true catch-all of the corpus.',
};

// ---------------------------------------------------------------------------
// Ranking against a known corpus
// ---------------------------------------------------------------------------

export interface RankedGlyph extends GlyphAnalysis {
  tokenId: number;
  glyph: string;
  /** 1-indexed position when the collection is sorted by descending rarityScore. */
  rarityRank: number;
}

/**
 * Sort an array of minted glyphs by rarity (descending score), assigning
 * 1-indexed ranks. Stable for equal scores: the lower tokenId wins, so
 * ranks are reproducible. Use this on the atlas page when displaying the
 * full collection.
 */
export function rankCollection(
  glyphs: Array<{ tokenId: number; glyph: string }>,
): RankedGlyph[] {
  const analysed = glyphs.map((g) => ({
    ...analyzeGlyph(g.glyph),
    tokenId: g.tokenId,
    glyph: g.glyph,
  }));
  analysed.sort((a, b) => {
    if (b.rarityScore !== a.rarityScore) return b.rarityScore - a.rarityScore;
    return a.tokenId - b.tokenId;
  });
  return analysed.map((a, i) => ({ ...a, rarityRank: i + 1 }));
}
