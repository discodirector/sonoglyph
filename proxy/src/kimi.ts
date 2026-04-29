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

import type { FinalArtifact, PlacedLayer } from './protocol.js';

const KIMI_BASE = process.env.KIMI_BASE_URL ?? 'https://api.moonshot.ai/v1';
const KIMI_MODEL = process.env.KIMI_MODEL ?? 'moonshot-v1-128k';

// Hard cap on journal length we surface to the player. The frontend assumes
// the text fits in a fixed-height paragraph below the glyph; runaway prose
// would push the layout past the viewport. ~520 chars ≈ 3 short paragraphs.
const JOURNAL_MAX_CHARS = 520;

export async function generateFinalArtifact(
  layers: PlacedLayer[],
): Promise<FinalArtifact> {
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) {
    console.warn('[kimi] KIMI_API_KEY not set — using fallback artifact');
    return fallback(layers);
  }

  const transcript = formatTranscript(layers);

  try {
    const [journal, glyph] = await Promise.all([
      callKimi(apiKey, journalPrompt(transcript), 600),
      callKimi(apiKey, glyphPrompt(transcript), 800),
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
    'Write a SHORT field journal. STRICT FORMAT:',
    '- Exactly 3 paragraphs.',
    '- Each paragraph 2 to 3 sentences (NO MORE).',
    '- Total length under 480 characters.',
    '- Tone: introspective, slightly mineral, like a geologist taking notes',
    '  inside a cave. Reference one or two striking moves.',
    '- No title, no bullet points, no headings, no markdown formatting.',
    '- Do not mention "Sonoglyph" by name.',
    '- Output ONLY the prose. No preamble, no explanation, no closing remark.',
    '',
    'Log:',
    transcript,
  ].join('\n');
}

function glyphPrompt(transcript: string): string {
  return [
    'You are an Autoglyphs-style generative artist. Output an ASCII glyph',
    'that visually condenses the descent below. Constraints — follow exactly:',
    '',
    '- Exactly 32 columns wide, exactly 16 rows tall.',
    '- Use only these characters: space, .  -  =  +  *  #  /  \\  |  <  >',
    '- No letters, no numbers, no other punctuation.',
    '- The composition should suggest depth and layering — denser glyphs',
    "  toward where the music had weight, sparser where it didn't.",
    '',
    'Output ONLY the glyph between two lines of exactly 32 dashes (`-`).',
    'No explanation, no header, nothing else.',
    '',
    'Log of the descent:',
    transcript,
  ].join('\n');
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
  block = block
    .slice(0, 16)
    .map((l) => (l.length >= 32 ? l.slice(0, 32) : l.padEnd(32, ' ')));
  while (block.length < 16) block.push(' '.repeat(32));
  return block.join('\n');
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
