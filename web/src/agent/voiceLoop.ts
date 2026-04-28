/**
 * Agent voice loop — one "turn" of The Voice.
 *
 *   1. Build AgentContext from current session state.
 *   2. POST /api/agent/turn (proxy → Hermes if key, stub otherwise).
 *   3. Dispatch the returned tool call:
 *        narrate      → fetch /api/tts/stream → playVoice (ducks layers)
 *        suggest_layer → log event (Day 4 will surface as UI hint)
 *        observe      → log event
 *        wait         → no-op
 *
 * Caller is expected to enforce a hard cooldown (>= 15s) between turns to
 * keep API usage modest. The agent itself is also told to wait() when it
 * just spoke — this is belt-and-braces.
 */

import { playVoice } from '../audio/engine';
import { useSession, type LayerType, type SessionEvent } from '../state/useSession';

export interface AgentContext {
  depth: number;
  phase: string;
  active_layers: Array<{
    type: LayerType;
    freq: number;
    born_seconds_ago: number;
    position: [number, number, number];
  }>;
  recent_actions_30s: Array<{ t_ago: number; action: string; detail?: string }>;
  your_last_utterance_seconds_ago: number | null;
  spectral_now: { low: number; mid: number; high: number };
}

interface ToolCall {
  name: 'narrate' | 'suggest_layer' | 'observe' | 'wait';
  arguments: Record<string, unknown>;
}

export interface VoiceLoopHooks {
  onNarrate?: (text: string, mood: string) => void;
  onSuggest?: (layerType: LayerType, reason: string) => void;
  onSource?: (source: 'hermes' | 'stub' | 'error') => void;
}

/**
 * Build a compact context snapshot from session state. Capped so we don't
 * blow the context window on a long descent.
 */
function buildContext(): AgentContext {
  const s = useSession.getState();
  const now = s.startedAt ? (Date.now() - s.startedAt) / 1000 : 0;

  const active_layers = s.layers.slice(-8).map((l) => ({
    type: l.type,
    freq: Math.round(l.freq * 100) / 100,
    born_seconds_ago: Math.round((Date.now() - l.bornAt) / 100) / 10,
    position: l.position,
  }));

  const recent_actions_30s = s.log
    .filter((e) => now - e.t < 30 && e.type !== 'spectral_snapshot')
    .map((e) => {
      const detail =
        e.type === 'layer_placed'
          ? e.layerType
          : e.type === 'agent_narrate'
          ? `mood=${e.mood}`
          : undefined;
      return {
        t_ago: Math.round((now - e.t) * 10) / 10,
        action: e.type,
        detail,
      };
    });

  // Last spoken time.
  const lastNarrate = [...s.log]
    .reverse()
    .find((e): e is Extract<SessionEvent, { type: 'agent_narrate' }> =>
      e.type === 'agent_narrate',
    );
  const your_last_utterance_seconds_ago = lastNarrate
    ? Math.round((now - lastNarrate.t) * 10) / 10
    : null;

  // Most recent spectral snapshot, reduced to 3 macro bands.
  const lastSpec = [...s.log]
    .reverse()
    .find((e): e is Extract<SessionEvent, { type: 'spectral_snapshot' }> =>
      e.type === 'spectral_snapshot',
    );
  const b = lastSpec?.bands ?? [0, 0, 0, 0, 0, 0, 0, 0];
  const low = round((b[0] + b[1]) / 2);
  const mid = round((b[2] + b[3] + b[4]) / 3);
  const high = round((b[5] + b[6] + b[7]) / 3);

  return {
    depth: Math.round(s.depth),
    phase: s.phase,
    active_layers,
    recent_actions_30s,
    your_last_utterance_seconds_ago,
    spectral_now: { low, mid, high },
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Run a single agent turn. Returns when all side effects (incl. voice
 * playback) have completed.
 */
export async function runAgentTurn(hooks: VoiceLoopHooks = {}): Promise<void> {
  const ctx = buildContext();

  let tool: ToolCall;
  let source: 'hermes' | 'stub' | 'error' = 'error';
  try {
    const res = await fetch('/api/agent/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ctx),
    });
    if (!res.ok) {
      console.warn('[voice] agent/turn HTTP', res.status);
      return;
    }
    const data = (await res.json()) as { tool: ToolCall; source: typeof source };
    tool = data.tool;
    source = data.source;
    hooks.onSource?.(source);
  } catch (err) {
    console.warn('[voice] agent/turn failed', err);
    return;
  }

  switch (tool.name) {
    case 'narrate': {
      const text = String(tool.arguments.text ?? '').trim();
      const mood = String(tool.arguments.mood ?? 'calm');
      if (!text) return;
      hooks.onNarrate?.(text, mood);

      // Fetch TTS audio. If unavailable (no key → 501), skip playback —
      // the line is still shown in the HUD via onNarrate.
      try {
        const ttsRes = await fetch('/api/tts/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, mood }),
        });
        if (ttsRes.status === 501) return;
        if (!ttsRes.ok) {
          console.warn('[voice] tts HTTP', ttsRes.status);
          return;
        }
        const blob = await ttsRes.blob();
        await playVoice(blob);
      } catch (err) {
        console.warn('[voice] tts/play failed', err);
      }
      return;
    }

    case 'suggest_layer': {
      const layerType = tool.arguments.layerType as LayerType;
      const reason = String(tool.arguments.reason ?? '');
      hooks.onSuggest?.(layerType, reason);
      return;
    }

    case 'observe':
    case 'wait':
      return;
  }
}
