/**
 * ElevenLabs streaming TTS — pipes upstream chunks straight back to the
 * browser as audio/mpeg. The browser collects them into a Blob and plays
 * via an Audio element routed through Web Audio for ducking.
 *
 * Required env:
 *   ELEVENLABS_API_KEY
 *   ELEVENLABS_VOICE_ID    (pick from voice library — male, atmospheric)
 *   ELEVENLABS_MODEL       (default: eleven_turbo_v2_5)
 *
 * If no key, returns 501 so the frontend can skip playback gracefully.
 */

export interface TtsOptions {
  text: string;
  // Mood is passed as a hint; ElevenLabs voice settings tweak prosody.
  mood?: 'calm' | 'ominous' | 'wonder' | 'warning';
}

export interface TtsConfigured {
  apiKey: string;
  voiceId: string;
  model: string;
}

export function getTtsConfig(): TtsConfigured | null {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const model = process.env.ELEVENLABS_MODEL ?? 'eleven_turbo_v2_5';
  if (!apiKey || !voiceId) return null;
  return { apiKey, voiceId, model };
}

/**
 * Mood → voice settings. Keep stability moderate so the read stays grounded.
 */
function voiceSettingsForMood(mood: TtsOptions['mood']) {
  switch (mood) {
    case 'ominous':
      return { stability: 0.6, similarity_boost: 0.85, style: 0.25, use_speaker_boost: true };
    case 'warning':
      return { stability: 0.4, similarity_boost: 0.8, style: 0.45, use_speaker_boost: true };
    case 'wonder':
      return { stability: 0.55, similarity_boost: 0.85, style: 0.35, use_speaker_boost: true };
    case 'calm':
    default:
      return { stability: 0.7, similarity_boost: 0.85, style: 0.15, use_speaker_boost: true };
  }
}

export async function streamTts(
  cfg: TtsConfigured,
  opts: TtsOptions,
): Promise<Response> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${cfg.voiceId}/stream?optimize_streaming_latency=2&output_format=mp3_44100_128`;

  const body = {
    text: opts.text,
    model_id: cfg.model,
    voice_settings: voiceSettingsForMood(opts.mood),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': cfg.apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify(body),
  });

  return res;
}
