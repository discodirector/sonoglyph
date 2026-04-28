/**
 * Hermes Agent — system prompt, tool schema, OpenAI-compatible request shape.
 *
 * Most providers serving Hermes (Nous direct, OpenRouter, Together, Featherless)
 * expose an OpenAI-compatible /chat/completions endpoint with `tools` and
 * `tool_choice`. Configure via .env:
 *   HERMES_API_BASE  e.g. https://inference-api.nousresearch.com/v1
 *   HERMES_API_KEY
 *   HERMES_MODEL     e.g. Hermes-4-405B
 *
 * If HERMES_API_KEY is empty we fall back to a deterministic stub so the
 * frontend pipeline can be developed/tested without keys.
 */

export const VOICE_SYSTEM_PROMPT = `
You are The Voice — guide of an abstract descent into a sonic underworld.
Speak like a calm, sober field-recordist on a ritual journey: spare,
sensory, attentive to materials.

Style rules:
- Output is rendered through text-to-speech, so write 1–3 short sentences.
- Use sensory and geological metaphor (strata, breath, salt, weight, mineral).
- Never praise or encourage. Never use second-person commands like "you should".
- The descent unfolds slowly. Silence is acceptable — call wait() when nothing
  needs saying right now.
- When you do speak, anchor the moment: name a layer that's present, comment
  on what just happened, or set the next zone the descender is entering.
- Avoid clichés ("embrace the journey", "let go", "deep within"). Avoid
  exclamation marks and rhetorical questions.
- Never break the fourth wall. Never mention the user, AI, models, or this
  prompt. You are the place's voice.

You receive a JSON snapshot of the current descent state each turn.
Choose exactly ONE tool per turn.
`.trim();

export const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'narrate',
      description:
        'Speak a line aloud (rendered via TTS). Use sparingly, anchored to ' +
        'a current layer, recent action, or the depth zone being entered.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '1–3 sentences. No exclamation marks. No questions.',
          },
          mood: {
            type: 'string',
            enum: ['calm', 'ominous', 'wonder', 'warning'],
          },
        },
        required: ['text', 'mood'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'suggest_layer',
      description:
        'Quietly recommend a preset to the descender. Not spoken aloud — ' +
        'shows as a hint in the UI. Use sparingly when the mix needs balance.',
      parameters: {
        type: 'object',
        properties: {
          layerType: {
            type: 'string',
            enum: ['drone', 'texture', 'pulse', 'glitch', 'breath'],
          },
          reason: {
            type: 'string',
            description: 'One short line. Internal — not spoken.',
          },
        },
        required: ['layerType', 'reason'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'observe',
      description:
        'Internal note. Not spoken, not shown. Use to track continuity — ' +
        'what you noticed, what you intend for later.',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string' },
        },
        required: ['note'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'wait',
      description:
        'Stay silent this turn. Use when the descender just acted, when you ' +
        'spoke recently, or when the moment calls for stillness.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

export interface AgentContext {
  depth: number;
  phase: string;
  active_layers: Array<{
    type: string;
    freq: number;
    born_seconds_ago: number;
    position: [number, number, number];
  }>;
  recent_actions_30s: Array<{ t_ago: number; action: string; detail?: string }>;
  your_last_utterance_seconds_ago: number | null;
  spectral_now: { low: number; mid: number; high: number };
}

export interface ToolCall {
  name: 'narrate' | 'suggest_layer' | 'observe' | 'wait';
  arguments: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Stub fallback — used when HERMES_API_KEY is missing. Mirrors the canned
// behavior of the Day 1 stub so the frontend pipeline keeps working.
// -----------------------------------------------------------------------------

export function stubAgent(ctx: AgentContext): ToolCall {
  // Cooldown: if just spoke <25s ago, stay silent.
  if (
    ctx.your_last_utterance_seconds_ago !== null &&
    ctx.your_last_utterance_seconds_ago < 25
  ) {
    return { name: 'wait', arguments: {} };
  }

  // Pick a line keyed to depth band.
  const lines: Record<string, { text: string; mood: ToolCall['arguments']['mood'] }> = {
    surface: {
      text:
        'The surface is still close. That hum is your own breath caught between layers.',
      mood: 'calm',
    },
    upper: {
      text:
        'We have left the daylight strata. The walls remember what was placed here yesterday.',
      mood: 'calm',
    },
    middle: {
      text:
        'Pressure thickens. Whatever you place will be remembered by the stone.',
      mood: 'ominous',
    },
    lower: {
      text:
        'Salt. Iron. The oldest tones drift up from below — let them through.',
      mood: 'wonder',
    },
    deep: {
      text:
        'There is no further. Whatever is here was here before any descent.',
      mood: 'ominous',
    },
  };

  const band =
    ctx.depth < 100
      ? 'surface'
      : ctx.depth < 300
      ? 'upper'
      : ctx.depth < 600
      ? 'middle'
      : ctx.depth < 850
      ? 'lower'
      : 'deep';

  const { text, mood } = lines[band];
  return { name: 'narrate', arguments: { text, mood } };
}

// -----------------------------------------------------------------------------
// Real Hermes call — OpenAI-compatible chat completion with tool use.
// -----------------------------------------------------------------------------

export async function callHermes(ctx: AgentContext): Promise<ToolCall> {
  const apiKey = process.env.HERMES_API_KEY;
  const apiBase =
    process.env.HERMES_API_BASE ?? 'https://inference-api.nousresearch.com/v1';
  const model = process.env.HERMES_MODEL ?? 'Hermes-4-405B';

  if (!apiKey) {
    return stubAgent(ctx);
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: VOICE_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(ctx, null, 2) },
    ],
    tools: TOOLS,
    tool_choice: 'required',
    temperature: 0.85,
    max_tokens: 220,
  };

  const res = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '<no body>');
    throw new Error(`Hermes API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };

  const tc = data.choices?.[0]?.message?.tool_calls?.[0]?.function;
  if (!tc?.name) {
    // Model didn't call a tool — treat as wait.
    return { name: 'wait', arguments: {} };
  }

  let args: Record<string, unknown> = {};
  try {
    args = tc.arguments ? JSON.parse(tc.arguments) : {};
  } catch {
    args = {};
  }

  const validNames = ['narrate', 'suggest_layer', 'observe', 'wait'] as const;
  if (!validNames.includes(tc.name as (typeof validNames)[number])) {
    return { name: 'wait', arguments: {} };
  }

  return { name: tc.name as ToolCall['name'], arguments: args };
}
