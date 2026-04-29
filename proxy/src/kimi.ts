/**
 * Kimi finalization — called once when a session reaches MAX_LAYERS.
 *
 * Generates two artifacts from the full layer log:
 *   - `journal` — short field journal, 3 paragraphs × 2–3 sentences
 *   - `glyph`   — Autoglyphs-style ASCII art (32 cols × 16 rows)
 *
 * Kimi is OpenAI-compatible: https://api.moonshot.ai/v1/chat/completions.
 *
 * Model choice: we default to `moonshot-v1-128k` — a NON-reasoning chat
 * model. Reasoning variants (kimi-k2.6, kimi-thinking-preview) burn most
 * of the token budget on hidden chain-of-thought before emitting any
 * `content`, which led to two earlier failure modes:
 *   1. finish_reason='length' with empty content → fallthrough to the
 *      offline stand-in.
 *   2. our reasoning_content rescue path leaking the model's raw scratchpad
 *      ("Wait, the user said 4-6 paragraphs…") into the player's journal.
 * A non-reasoning model returns the answer directly in `content`, so neither
 * problem can occur. Override with `KIMI_MODEL=…` if you want to experiment.
 *
 * Failures are swallowed: if Kimi is down or unauthorized we return a
 * deterministic fallback so the descent always ends gracefully.
 */

import type { FinalArtifact, LayerType, PlacedLayer } from './protocol.js';

const KIMI_BASE = process.env.KIMI_BASE_URL ?? 'https://api.moonshot.ai/v1';
const KIMI_MODEL = process.env.KIMI_MODEL ?? 'moonshot-v1-128k';

// Hard cap on journal length we surface to the player. Journal lives in a
// 540px-wide column with line-height 1.7 — at fontSize 13 that's roughly
// 70 chars per line, so 720 chars ≈ 10 lines, comfortably above the fold.
// We over-shoot the prompt's 480-char advisory because moonshot-v1-128k
// tends to come in around 600 even when asked for less; clamping further
// would routinely chop the third paragraph mid-thought.
const JOURNAL_MAX_CHARS = 720;

export async function generateFinalArtifact(
  layers: PlacedLayer[],
): Promise<FinalArtifact> {
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) {
    console.warn('[kimi] KIMI_API_KEY not set — using fallback artifact');
    return fallback(layers);
  }

  const transcript = formatTranscript(layers);
  const bandPalettes = buildBandPalettes(layers);
  const poeticIntent = buildPoeticIntent(layers);
  const gPrompt = glyphPrompt(transcript, bandPalettes, poeticIntent);

  try {
    // Best-of-N glyph generation. The model has high quality variance on
    // glyphs — sometimes it produces a varied, breathing composition and
    // sometimes it falls back to tiled wallpaper. Generating 3 candidates
    // in parallel at high temperature and picking the one with the best
    // structural score reliably gets us a glyph worth showing.
    const [journal, ...glyphCandidates] = await Promise.all([
      callKimi(apiKey, journalPrompt(transcript), 600),
      // Temperature spread within moonshot-v1's [0, 1] window. Three
      // distinct points so the candidates actually diverge instead of
      // collapsing to similar samples.
      callKimi(apiKey, gPrompt, 1000, 0.7),
      callKimi(apiKey, gPrompt, 1000, 0.9),
      callKimi(apiKey, gPrompt, 1000, 1.0),
    ]);

    const scored = glyphCandidates.map((raw) => {
      const grid = extractGlyph(raw);
      return { grid, score: scoreGlyph(grid) };
    });
    scored.sort((a, b) => b.score - a.score);
    console.log(
      `[kimi] glyph candidate scores: ${scored.map((s) => s.score.toFixed(2)).join(', ')} ` +
        `(picked top: ${scored[0].score.toFixed(2)})`,
    );

    return {
      journal: clampJournal(stripFences(journal).trim()),
      glyph: scored[0].grid,
      generatedBy: 'kimi',
    };
  } catch (err) {
    console.error('[kimi] generation failed', err);
    return fallback(layers);
  }
}

// ---------------------------------------------------------------------------
async function callKimi(
  apiKey: string,
  prompt: string,
  maxTokens: number,
  temperature?: number,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: KIMI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
  };
  // moonshot-v1-* accepts temperature normally and tends to be less varied
  // than k2.6. Reasoning models (kimi-k2.6) reject anything other than 1,
  // so don't pass temperature for them; detect that by model name.
  if (!/^kimi-k2(\.|-)/.test(KIMI_MODEL)) {
    body.temperature = temperature ?? 0.85;
  }

  const res = await fetch(`${KIMI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`kimi ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string };
      finish_reason?: string;
    }>;
  };
  const choice = data.choices?.[0];
  const content = choice?.message?.content?.trim();
  if (!content) {
    throw new Error(
      `kimi returned empty content (finish_reason=${choice?.finish_reason ?? '?'})`,
    );
  }
  return content;
}

// ---------------------------------------------------------------------------
function formatTranscript(layers: PlacedLayer[]): string {
  return layers
    .map((l, i) => {
      const who = l.placedBy === 'agent' ? 'Hermes' : 'Player';
      const c = l.comment ? ` — "${l.comment}"` : '';
      return `${String(i + 1).padStart(2, '0')}. ${who} placed ${l.type}${c}`;
    })
    .join('\n');
}

function journalPrompt(transcript: string): string {
  return [
    'You are the archivist of a contemplative descent through an abstract',
    'sonic void, jointly composed by a human player and the Hermes agent.',
    'The descent is now complete. Below is the placement log.',
    '',
    'Write a SHORT field journal. RULES — follow exactly:',
    '',
    '1. Exactly THREE paragraphs.',
    '2. Each paragraph: 2 to 3 sentences, never more.',
    '3. Total length: under 480 characters.',
    '4. Separate paragraphs with a SINGLE BLANK LINE (i.e. two newlines).',
    '   This is mandatory; the layout depends on it.',
    '5. Tone: introspective, slightly mineral — a geologist taking notes',
    '   inside a cave. Reference one or two striking moves from the log.',
    '6. No title. No bullet points. No headings. No markdown formatting.',
    '7. Do not mention "Sonoglyph" by name.',
    '8. Output ONLY the prose itself. No preamble, no commentary, no',
    '   closing remark.',
    '',
    'Format example (style only — do not copy the wording):',
    '<para 1: 2-3 sentences>',
    '',
    '<para 2: 2-3 sentences>',
    '',
    '<para 3: 2-3 sentences>',
    '',
    'Log:',
    transcript,
  ].join('\n');
}

function glyphPrompt(
  transcript: string,
  bandPalettes: string,
  poeticIntent: string,
): string {
  return [
    'You are an Autoglyphs-style generative artist. Output an ASCII glyph',
    'that visually condenses the descent below.',
    '',
    'OUTPUT FORMAT — exactly this and nothing else:',
    '  line 1: 32 dashes (--------------------------------)',
    '  lines 2-17: the 16 rows of the glyph (each row up to 32 chars)',
    '  line 18: 32 dashes (--------------------------------)',
    'No header, no explanation, no markdown, no code fence, no closing',
    'remarks. The opening and closing separator MUST use dashes (-);',
    'do NOT substitute = or # for the boundary lines.',
    '',
    'CHARACTER SET (rows only): space  .  -  =  +  *  #  /  \\  |  <  >',
    'No letters, no numbers, no other punctuation inside the glyph.',
    '',
    'COMPOSITION RULES — mandatory, the result must satisfy ALL:',
    '1. Produce ALL 16 rows. Do not stop early. Every row must contain',
    '   at least one non-space character — no blank rows.',
    '2. Every row is UNIQUE. No two rows may share the same pattern, and',
    '   no row may be a tiling of one repeating segment (like',
    '   "####|####|####|") — that reads as wallpaper, not a glyph.',
    '3. The glyph must visibly EVOLVE from top to bottom. Top rows are',
    '   the surface (start of descent), bottom rows are the deep end.',
    '   Character weight, rhythm, and the use of empty space should',
    '   shift as you descend — not stay constant.',
    '4. Each of the 5 bands has its OWN character palette computed from',
    '   the layers placed in that band (see BAND PALETTES below). Draw',
    '   each band mostly from its palette so bands feel distinct.',
    '5. Some rows can be airy (a few marks among spaces), others can be',
    '   denser. Mix them to create breathing room and weight.',
    '',
    'NEGATIVE EXAMPLES — do NOT produce output that looks like these:',
    '',
    '  Bad (one tiled segment across the whole image):',
    '    ####|####|####|####|####|####|##',
    '    ####|####|####|####|####|####|##',
    '    ####|####|####|####|####|####|##',
    '',
    '  Bad (one alternation repeated for nearly every row):',
    '    =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-',
    '    -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=',
    '    =.=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-',
    '',
    'POSITIVE EXAMPLE — varied silhouette, breathing, evolving downward',
    '(do NOT copy these characters; invent your own composition):',
    '',
    '       .   .                ',
    '     . . +   .              ',
    '      ..++.    .            ',
    '     ++/\\++.   /+           ',
    '   /+++/+\\*+++/+\\           ',
    '   <><>../+++/+-+-+-+        ',
    '  +++/+\\*=##|##|=#           ',
    '  ##| ==== ##|##| ====       ',
    '   ##|##|##|====   ===       ',
    '    -- = - = - = - =         ',
    '     . - = .  -  =           ',
    '      .   |   .              ',
    '       . . .                 ',
    '         .                   ',
    '         |                   ',
    '         .                   ',
    '',
    'BAND PALETTES (top → bottom of the glyph):',
    bandPalettes,
    '',
    "POETIC INTENT — Hermes's reactions while placing each layer. Let",
    'these images bend local shape: breath/exhale → soft (., -, =);',
    'glitch/fracture → jagged (/, \\, *); drone/floor → solid (#, |);',
    'pulse/clock → rhythmic (+, =); texture/dust → scattered (., -):',
    poeticIntent,
    '',
    'Full placement log (reference only — band palettes already encode it):',
    transcript,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Glyph context builders.
//
// Two structured hints sit alongside the raw transcript in the glyph prompt:
//
//   1. BAND PALETTES — the descent is split into 5 vertical bands of the
//      glyph (top → bottom). Each band gets a CHARACTER PALETTE derived
//      from the layer types that fell into it. The palette tells the
//      model which symbols to draw from for that band; because layer
//      mixes differ between bands, the palettes differ too. This pushes
//      the model toward visual variation across rows even when our older
//      sparse/medium/dense classification flattened to the same label.
//
//   2. POETIC INTENT — Hermes's per-layer comments lifted out of the
//      transcript and listed with their move number. The model treats
//      these as form-shaping images (breath → soft, glitch → jagged, …).
// ---------------------------------------------------------------------------

// Per-type character palettes. Listed roughly in order of "weight":
//   drone   — sustained low: solid uprights and bars
//   pulse   — rhythm: equals signs, plus signs (clock-like)
//   glitch  — fracture: diagonals and asterisks
//   texture — atmospheric: dots and short dashes
//   breath  — exhalation: long dashes, soft curves, equals
const TYPE_GLYPHS: Record<LayerType, string[]> = {
  drone: ['#', '|', '='],
  pulse: ['+', '='],
  glitch: ['/', '\\', '*'],
  texture: ['.', '-'],
  breath: ['-', '=', '<', '>'],
};

interface Band {
  index: number;          // 1..N, top → bottom
  rowRange: string;       // e.g. "rows 0-2"
  types: LayerType[];     // types in this slice, in placement order
}

/**
 * Slice the descent into `nBands` vertical bands. Layers are split by
 * placement order — the first chunk maps to the top of the glyph, the
 * last to the bottom. With 15 layers and 5 bands each band gets 3 layers;
 * with 16 rows the bands cover row ranges 0-2, 3-5, 6-9, 10-12, 13-15.
 */
function computeBands(
  layers: PlacedLayer[],
  nBands = 5,
  nRows = 16,
): Band[] {
  const bands: Band[] = [];
  for (let b = 0; b < nBands; b++) {
    const startIdx = Math.floor((b * layers.length) / nBands);
    const endIdx = Math.floor(((b + 1) * layers.length) / nBands);
    const slice = layers.slice(startIdx, endIdx);
    const startRow = Math.floor((b * nRows) / nBands);
    const endRow = Math.floor(((b + 1) * nRows) / nBands) - 1;
    bands.push({
      index: b + 1,
      rowRange: `rows ${startRow}-${endRow}`,
      types: slice.map((l) => l.type),
    });
  }
  return bands;
}

/**
 * For each band, render a one-line hint: "rows 3-5  drone, pulse, breath
 *   → use:  # | + = -". Palette is the union of TYPE_GLYPHS for the band's
 * types, deduplicated, in a stable order. Spaces are not added to the
 * palette explicitly — they're always allowed; the negative-space rule
 * is enforced separately in the prompt's COMPOSITION RULES.
 */
function buildBandPalettes(layers: PlacedLayer[]): string {
  return computeBands(layers)
    .map((b) => {
      // Preserve order: walk types in placement order, accumulate unique chars.
      const palette: string[] = [];
      for (const t of b.types) {
        for (const ch of TYPE_GLYPHS[t]) {
          if (!palette.includes(ch)) palette.push(ch);
        }
      }
      const types = b.types.join(', ') || '(empty)';
      return (
        `- band ${b.index} (${b.rowRange.padEnd(10)}): ` +
        `${types.padEnd(28)} → use: ${palette.join(' ')}`
      );
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Glyph quality scorer.
//
// We generate N glyph candidates in parallel and pick the one with the
// highest score here. The score rewards visual variation and penalises
// tile-like wallpaper output AND empty/short outputs. Components:
//
//   + filledRows     — rows with ≥4 non-space chars. The most important
//                      term: a 3-row glyph cannot beat a 14-row glyph by
//                      having higher "uniqueness ratio".
//   + uniqueFilled   — distinct filled rows (so 16 identical rows still
//                      score badly).
//   + charEntropy    — Shannon entropy over the non-space char distribution.
//                      A glyph using 2 chars scores low, one using the
//                      whole palette scores high.
//   + densityStdDev  — std-deviation of non-space chars per row. A uniform
//                      fill scores 0; a glyph that breathes scores higher.
//   - tilePenalty    — sum across rows of detected repeating-segment counts.
//                      "+#+#+#+#" gives a high penalty.
//
// Coefficients chosen empirically — adjustable.
// ---------------------------------------------------------------------------
function scoreGlyph(grid: string): number {
  const rows = grid.split('\n');
  const trimmed = rows.map((r) => r.replace(/\s+/g, ''));

  // 1. Filled rows — rows with real content. ≥4 non-space chars threshold
  // dodges the degenerate "single dot" rows.
  const filledRows = trimmed.filter((t) => t.length >= 4).length;

  // 2. Unique filled rows: distinct row strings among the filled ones.
  // Use the original (with-whitespace) row so leading-space layouts count
  // as different.
  const filledSet = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    if (trimmed[i].length >= 4) filledSet.add(rows[i]);
  }
  const uniqueFilled = filledSet.size;

  // 3. Character entropy across the whole glyph.
  const counts = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    for (const ch of r) {
      if (ch === ' ') continue;
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
      total += 1;
    }
  }
  let entropy = 0;
  if (total > 0) {
    for (const c of counts.values()) {
      const p = c / total;
      entropy -= p * Math.log2(p);
    }
  }

  // 4. Density std-dev across filled rows only — empty rows would
  // artificially inflate it and reward sparse, half-empty glyphs.
  const filledDensities = trimmed
    .filter((t) => t.length >= 4)
    .map((t) => t.length);
  let stdDev = 0;
  if (filledDensities.length > 1) {
    const mean =
      filledDensities.reduce((a, b) => a + b, 0) / filledDensities.length;
    const variance =
      filledDensities.reduce((a, b) => a + (b - mean) ** 2, 0) /
      filledDensities.length;
    stdDev = Math.sqrt(variance);
  }

  // 5. Tile penalty.
  let tilePenalty = 0;
  for (const r of trimmed) {
    tilePenalty += detectTileRuns(r);
  }

  return (
    filledRows * 2.0 +
    uniqueFilled * 0.5 +
    entropy * 3.0 +
    stdDev * 1.0 -
    tilePenalty * 1.5
  );
}

function detectTileRuns(s: string): number {
  if (s.length < 8) return 0;
  let worst = 0;
  for (let len = 1; len <= 4; len++) {
    for (let start = 0; start + len * 4 <= s.length; start++) {
      const seg = s.slice(start, start + len);
      let reps = 1;
      let pos = start + len;
      while (pos + len <= s.length && s.slice(pos, pos + len) === seg) {
        reps += 1;
        pos += len;
      }
      if (reps >= 4 && reps > worst) worst = reps;
    }
  }
  return worst;
}

function buildPoeticIntent(layers: PlacedLayer[]): string {
  const lines = layers
    .map((l, i) =>
      l.comment
        ? `- move ${String(i + 1).padStart(2, '0')} (${l.type}): "${l.comment}"`
        : null,
    )
    .filter((x): x is string => x !== null);
  if (lines.length === 0) {
    return '(no agent comments captured — improvise form from the type sequence alone)';
  }
  return lines.join('\n');
}

/**
 * Pull the glyph out of the response. We asked for it between dashed
 * delimiters; if the model complies we pluck it cleanly. If it doesn't,
 * we take the longest contiguous block of mostly-glyph chars as a
 * best-effort.
 */
function extractGlyph(raw: string): string {
  const text = stripFences(raw);
  const lines = text.split(/\r?\n/);
  // Boundary detection: any line ≥20 chars made of a single repeated
  // non-space symbol counts. We ask for dashes in the prompt, but models
  // sometimes substitute = or # for the closing rule, and rejecting those
  // would leave us in best-effort and pull garbage.
  const boundaryRe = /^([\-=#*+/\\|.~])\1{19,}$/;
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (boundaryRe.test(lines[i].trim())) {
      if (start < 0) start = i;
      else {
        end = i;
        break;
      }
    }
  }
  let block: string[];
  if (start >= 0 && end > start) {
    block = lines.slice(start + 1, end);
  } else {
    // Best-effort: keep lines made mostly of allowed glyph chars, but
    // reject decorative all-one-character lines (separators that crept
    // through without proper boundary detection).
    const allowed = /^[ .\-=+*#/\\|<>]+$/;
    block = lines.filter((l) => {
      const trimmed = l.trim();
      if (trimmed.length < 6) return false;
      if (!allowed.test(l)) return false;
      // All-one-char lines: drop if long (likely separator) — short ones
      // can be legit (e.g. a row of just dots).
      if (trimmed.length >= 16 && new Set(trimmed).size === 1) return false;
      return true;
    });
  }
  block = block.slice(0, 16).map((l) => normalizeRow(l, 32));
  while (block.length < 16) block.push(' '.repeat(32));
  return block.join('\n');
}

/**
 * Coerce a single response line into a 32-char glyph row.
 *
 * The model frequently misjudges width — it pads with leading spaces or
 * runs past the 32-char target. Naive truncation (`slice(0, 32)`) silently
 * eats meaningful glyph chars when the model left-padded; we'd see rows of
 * empty space on screen even though the model drew something. Instead:
 *
 *   - Trim trailing whitespace (rarely meaningful).
 *   - If the result is short, CENTER-pad with spaces — looks more like
 *     a deliberate composition than a left-stuck row.
 *   - If the result is too wide, slide a 32-char window over it and pick
 *     the position with the most non-space characters. That preserves
 *     the densest part of the row instead of always starting at column 0.
 */
// Allowed glyph characters; anything else gets replaced by space.
const ALLOWED_GLYPH_CHARS = new Set(' .-=+*#/\\|<>'.split(''));

function sanitizeChars(s: string): string {
  let out = '';
  for (const ch of s) out += ALLOWED_GLYPH_CHARS.has(ch) ? ch : ' ';
  return out;
}

function normalizeRow(raw: string, width: number): string {
  const cleaned = sanitizeChars(raw);
  const trimmed = cleaned.replace(/\s+$/, '');
  if (trimmed.length === 0) return ' '.repeat(width);
  if (trimmed.length === width) return trimmed;
  if (trimmed.length < width) {
    const left = Math.floor((width - trimmed.length) / 2);
    const right = width - trimmed.length - left;
    return ' '.repeat(left) + trimmed + ' '.repeat(right);
  }
  // Wider than the frame — find the densest 32-char window.
  let bestStart = 0;
  let bestScore = -1;
  for (let s = 0; s + width <= trimmed.length; s++) {
    let score = 0;
    for (let i = 0; i < width; i++) {
      if (trimmed[s + i] !== ' ') score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = s;
    }
  }
  return trimmed.slice(bestStart, bestStart + width);
}

function stripFences(text: string): string {
  const m = text.match(/```(?:\w+)?\s*\n?([\s\S]*?)\n?```/);
  return m ? m[1] : text;
}

/**
 * Last-resort defense against an over-eager model. If the prose came back
 * longer than the layout can hold, truncate at a sentence/paragraph break
 * near the cap. We don't want to ship the player a wall of text that pushes
 * the journal past the viewport.
 */
function clampJournal(text: string): string {
  if (text.length <= JOURNAL_MAX_CHARS) return text;
  const slice = text.slice(0, JOURNAL_MAX_CHARS);
  // Prefer a paragraph break, then a sentence end, then any whitespace.
  const lastPara = slice.lastIndexOf('\n\n');
  if (lastPara > JOURNAL_MAX_CHARS * 0.5) return slice.slice(0, lastPara).trim();
  const lastSentence = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('.\n'),
  );
  if (lastSentence > JOURNAL_MAX_CHARS * 0.5)
    return slice.slice(0, lastSentence + 1).trim();
  return slice.trim() + '…';
}

// ---------------------------------------------------------------------------
// Fallback artifact when Kimi isn't reachable. Keeps the demo functional
// without a key.
// ---------------------------------------------------------------------------
function fallback(layers: PlacedLayer[]): FinalArtifact {
  const counts: Record<string, number> = {};
  for (const l of layers) counts[l.type] = (counts[l.type] ?? 0) + 1;
  const summary = Object.entries(counts)
    .map(([t, n]) => `${n}× ${t}`)
    .join(', ');

  const journal =
    `The descent ended at layer ${layers.length}. The composition gathered ` +
    `${summary}. Some moves landed close together, others left long gaps; ` +
    `the cave kept everything. — (Kimi was not available; this is a stand-in.)`;

  const rows: string[] = [];
  for (let r = 0; r < 16; r++) {
    let row = '';
    for (let c = 0; c < 32; c++) {
      const i = (r * 32 + c) % Math.max(1, layers.length);
      const t = layers[i]?.type ?? 'drone';
      row += GLYPH_CHARS[t];
    }
    rows.push(row);
  }
  return { journal, glyph: rows.join('\n'), generatedBy: 'fallback' };
}

const GLYPH_CHARS: Record<string, string> = {
  drone: '#',
  texture: '.',
  pulse: '+',
  glitch: '/',
  breath: '-',
};
