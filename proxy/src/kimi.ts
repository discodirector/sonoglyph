/**
 * Kimi finalization — called once when a session reaches MAX_LAYERS.
 *
 * Generates two artifacts from the full layer log:
 *   - `journal`  — a short poetic field journal (markdown-ish prose, ~120 words)
 *   - `glyph`    — Autoglyphs-style ASCII art (~32 cols × 16 rows)
 *
 * Kimi is OpenAI-compatible: https://api.moonshot.ai/v1/chat/completions
 * Model: kimi-k2.6 (overridable via env). Uses our server-side key —
 * the player's local Hermes is NOT involved in this step.
 *
 * Failures are swallowed: if Kimi is down or unauthorized, we return a
 * fallback artifact so the descent still ends gracefully.
 */

import type { FinalArtifact, PlacedLayer } from './protocol.js';

const KIMI_BASE = process.env.KIMI_BASE_URL ?? 'https://api.moonshot.ai/v1';
const KIMI_MODEL = process.env.KIMI_MODEL ?? 'kimi-k2.6';

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
      callKimi(apiKey, journalPrompt(transcript), 380),
      callKimi(apiKey, glyphPrompt(transcript), 700),
    ]);
    return {
      journal: stripFences(journal).trim(),
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
  const res = await fetch(`${KIMI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: KIMI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.85,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`kimi ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('kimi returned empty content');
  return text;
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
    'You are the archivist of Sonoglyph — a contemplative descent through',
    'an abstract sonic void, jointly composed by a human player and the',
    'Hermes agent. The descent is now complete. Below is the placement',
    'log.',
    '',
    'Write a SHORT field journal (about 100–140 words, 4–6 short paragraphs).',
    'Tone: introspective, slightly mineral, like a geologist taking notes',
    'inside a cave. Reference specific moves where they were striking.',
    "Do NOT title it. Do NOT use bullet points. Do NOT use the word 'Sonoglyph'.",
    'Plain prose only.',
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
  // Pad/truncate to 32 cols × 16 rows so the frontend can render in a
  // fixed-size box without measuring.
  block = block
    .slice(0, 16)
    .map((l) => (l.length >= 32 ? l.slice(0, 32) : l.padEnd(32, ' ')));
  while (block.length < 16) block.push(' '.repeat(32));
  return block.join('\n');
}

function stripFences(text: string): string {
  // Strip ```lang ... ``` if Kimi wrapped the answer.
  const m = text.match(/```(?:\w+)?\s*\n?([\s\S]*?)\n?```/);
  return m ? m[1] : text;
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

  // Simple deterministic glyph derived from layer types.
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
