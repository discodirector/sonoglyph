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
  const densityMap = buildDensityMap(layers);
  const poeticIntent = buildPoeticIntent(layers);

  try {
    const [journal, glyph] = await Promise.all([
      callKimi(apiKey, journalPrompt(transcript), 600),
      callKimi(
        apiKey,
        glyphPrompt(transcript, densityMap, poeticIntent),
        1000,
      ),
    ]);
    return {
      journal: clampJournal(stripFences(journal).trim()),
      glyph: extractGlyph(glyph),
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
): Promise<string> {
  const body: Record<string, unknown> = {
    model: KIMI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
  };
  // moonshot-v1-* accepts temperature normally and tends to be less varied
  // than k2.6 — a small kick keeps the prose interesting. Reasoning models
  // (kimi-k2.6) reject anything other than 1, so don't pass temperature for
  // them; detect that by model name.
  if (!/^kimi-k2(\.|-)/.test(KIMI_MODEL)) {
    body.temperature = 0.85;
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
  densityMap: string,
  poeticIntent: string,
): string {
  return [
    'You are an Autoglyphs-style generative artist. Output an ASCII glyph',
    'that visually condenses the descent below.',
    '',
    'Constraints — follow exactly:',
    '- Exactly 32 columns wide, exactly 16 rows tall.',
    '- Use only these characters: space, .  -  =  +  *  #  /  \\  |  <  >',
    '- No letters, no numbers, no other punctuation.',
    '- Each row must NOT be a copy of another row — vary the form.',
    '- Each of the 16 rows must reflect the density level for its band',
    "  (see map below). Don't keep one density throughout.",
    '',
    'Output ONLY the glyph between two lines of exactly 32 dashes (`-`).',
    'No explanation, no header, no commentary, no fenced code block.',
    '',
    'How to read the inputs:',
    '- The DENSITY MAP binds each band of glyph rows to a density level',
    '  ("sparse" / "medium" / "dense"). "dense" → mostly thick chars',
    '  (#, *, +, |, =); "sparse" → mostly spaces and dots; "medium" is',
    '  in between.',
    '- The POETIC INTENT is what Hermes felt while placing each layer.',
    '  Let those images bend the local form (breath → soft, glitch →',
    '  jagged, drone → solid, pulse → rhythmic).',
    '',
    'Density map (top → bottom):',
    densityMap,
    '',
    "Hermes's poetic reactions (in placement order):",
    poeticIntent,
    '',
    'Full placement log (for reference):',
    transcript,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Glyph context builders.
//
// Both functions exist so the model gets STRUCTURED hints separated from the
// raw transcript. The glyph prompt is a 16-row visual format; the density
// map binds each band of rows to an actual property of the partition (count
// of "loud" types per slice). The poetic-intent block lifts Hermes's quotes
// out of the transcript so the model treats them as form-shaping images
// rather than journal filler.
// ---------------------------------------------------------------------------

// Layer types whose timbre tends to feel heavy on the page; the rest
// (texture, breath) read as breath / mist / silence.
const HEAVY_TYPES: ReadonlySet<LayerType> = new Set(['drone', 'pulse', 'glitch']);

interface DensityBand {
  index: number;          // 1..N, top → bottom
  rowRange: string;       // e.g. "rows 0-2"
  density: 'sparse' | 'medium' | 'dense';
  types: LayerType[];     // types in this slice, in placement order
}

/**
 * Slice the descent into `nBands` vertical bands and label each one with a
 * density category and its constituent types. Layers split into bands by
 * placement order — the first 3 are the top of the glyph, the last 3 are
 * the bottom. The density category is the ratio of "heavy" types
 * (drone/pulse/glitch) to the slice size.
 */
function computeBands(
  layers: PlacedLayer[],
  nBands = 5,
  nRows = 16,
): DensityBand[] {
  const bands: DensityBand[] = [];
  for (let b = 0; b < nBands; b++) {
    const startIdx = Math.floor((b * layers.length) / nBands);
    const endIdx = Math.floor(((b + 1) * layers.length) / nBands);
    const slice = layers.slice(startIdx, endIdx);
    const startRow = Math.floor((b * nRows) / nBands);
    const endRow = Math.floor(((b + 1) * nRows) / nBands) - 1;
    const heavy = slice.filter((l) => HEAVY_TYPES.has(l.type)).length;
    const ratio = slice.length === 0 ? 0 : heavy / slice.length;
    const density: DensityBand['density'] =
      ratio >= 0.66 ? 'dense' : ratio >= 0.34 ? 'medium' : 'sparse';
    bands.push({
      index: b + 1,
      rowRange: `rows ${startRow}-${endRow}`,
      density,
      types: slice.map((l) => l.type),
    });
  }
  return bands;
}

function buildDensityMap(layers: PlacedLayer[]): string {
  return computeBands(layers)
    .map(
      (b) =>
        `- band ${b.index} (${b.rowRange.padEnd(10)}): ` +
        `${b.density.padEnd(6)} — ${b.types.join(', ') || '(empty)'}`,
    )
    .join('\n');
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
  const dashRe = /^-{20,}$/;
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (dashRe.test(lines[i].trim())) {
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
    // Best-effort: keep lines made mostly of allowed glyph chars.
    const allowed = /^[ .\-=+*#/\\|<>]+$/;
    block = lines.filter((l) => l.length >= 8 && allowed.test(l));
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
function normalizeRow(raw: string, width: number): string {
  const trimmed = raw.replace(/\s+$/, '');
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
