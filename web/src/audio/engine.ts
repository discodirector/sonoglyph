/**
 * Audio engine — Tone.js master + 5 layer presets + 3D panning + voice ducking.
 *
 * Signal graph:
 *
 *   per-layer preset → Panner3D ─┬─→ master (Limiter)
 *                                └─→ reverbSend → reverb → master
 *                                                              │
 *   master ──────────────────────────────────► analyser (pre-voice, layers only)
 *      │
 *      ▼
 *   masterDuck (Gain — ramped down during voice playback)
 *      │
 *      ▼
 *   masterMix (Gain) ───┬─→ destination
 *                       └─→ recorder (full mix incl. voice)
 *      ▲
 *      │
 *   voiceGain ◄─── Web Audio MediaElementSource (TTS playback)
 *
 * Listener (Web Audio AudioListener) is updated each frame from the R3F
 * camera so panning tracks the descent.
 */

import * as Tone from 'tone';
import type { LayerType } from '../state/useSession';

// -----------------------------------------------------------------------------
// Module state — initialized once, after first user gesture.
// -----------------------------------------------------------------------------

let initialized = false;
let master: Tone.Limiter;
let masterDuck: Tone.Gain;
let masterMix: Tone.Gain;
let voiceGain: Tone.Gain;
let reverb: Tone.Reverb;
let reverbSend: Tone.Gain;
let analyzer: Tone.Analyser;
let recorder: Tone.Recorder | null = null;

export async function initAudio(): Promise<void> {
  if (initialized) return;
  await Tone.start();

  Tone.getDestination().volume.value = -6;

  // Final summing point — feeds destination + recorder.
  masterMix = new Tone.Gain(1).toDestination();

  // Layers route: master → masterDuck → masterMix
  master = new Tone.Limiter(-1);
  masterDuck = new Tone.Gain(1);
  master.connect(masterDuck);
  masterDuck.connect(masterMix);

  // Voice route: voiceGain → masterMix (bypasses duck)
  voiceGain = new Tone.Gain(1.4);
  voiceGain.connect(masterMix);

  reverb = new Tone.Reverb({ decay: 16, wet: 1 });
  await reverb.generate();
  reverb.connect(master);

  reverbSend = new Tone.Gain(0.35);
  reverbSend.connect(reverb);

  analyzer = new Tone.Analyser('fft', 64);
  master.connect(analyzer); // pre-duck, pre-voice — measures layers only

  // Loops + scheduled envelopes need the Transport running.
  Tone.getTransport().start();

  initialized = true;
}

export function isAudioReady(): boolean {
  return initialized;
}

// -----------------------------------------------------------------------------
// Listener — synced from R3F camera every frame.
// -----------------------------------------------------------------------------

export function setListenerPosition(x: number, y: number, z: number): void {
  if (!initialized) return;
  const listener = Tone.getContext().rawContext.listener as AudioListener;
  // Modern browsers expose positionX/Y/Z as AudioParams.
  if ('positionX' in listener) {
    listener.positionX.value = x;
    listener.positionY.value = y;
    listener.positionZ.value = z;
  } else {
    // Older fallback — deprecated but harmless.
    // @ts-expect-error legacy API
    listener.setPosition(x, y, z);
  }
}

// -----------------------------------------------------------------------------
// Depth → global wetness.
// -----------------------------------------------------------------------------

export function setGlobalDepth(depth: number): void {
  if (!initialized) return;
  const t = Math.min(1, Math.max(0, depth / 1000));
  reverbSend.gain.rampTo(0.3 + t * 0.55, 1.5);
}

// -----------------------------------------------------------------------------
// Voice playback + sidechain ducking.
//
// Voice arrives as an audio Blob (mp3 from ElevenLabs). We route it through
// Web Audio so we can keep timing-tight ducking on the layers.
// -----------------------------------------------------------------------------

const DUCK_TARGET = 0.32;

function duckLayers(): void {
  if (!initialized) return;
  masterDuck.gain.cancelScheduledValues(Tone.now());
  masterDuck.gain.rampTo(DUCK_TARGET, 0.25);
}

function unduckLayers(): void {
  if (!initialized) return;
  masterDuck.gain.cancelScheduledValues(Tone.now());
  masterDuck.gain.rampTo(1, 0.55);
}

/**
 * Play a voice blob, ducking layers for its duration. Resolves when playback
 * finishes (or fails). Safe to call before audio engine is initialized — in
 * that case it logs and resolves immediately.
 */
export function playVoice(blob: Blob): Promise<void> {
  if (!initialized) {
    console.warn('[engine] playVoice called before init');
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    audio.preload = 'auto';

    const rawCtx = Tone.getContext().rawContext as unknown as AudioContext;
    let source: MediaElementAudioSourceNode | null = null;
    try {
      source = rawCtx.createMediaElementSource(audio);
      // Bridge raw Web Audio source into Tone graph.
      Tone.connect(source, voiceGain);
    } catch (err) {
      console.error('[engine] failed to route voice through Web Audio', err);
      URL.revokeObjectURL(url);
      resolve();
      return;
    }

    const cleanup = () => {
      try {
        source?.disconnect();
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(url);
      unduckLayers();
      resolve();
    };

    audio.addEventListener('ended', cleanup, { once: true });
    audio.addEventListener('error', cleanup, { once: true });

    duckLayers();
    audio.play().catch((err) => {
      console.error('[engine] audio.play rejected', err);
      cleanup();
    });
  });
}

// -----------------------------------------------------------------------------
// Spectral capture — used by App's interval to log spectral_snapshot events.
// Returns 8 bands (low → high), each averaged over a chunk of the FFT bins.
// Values are in dBFS (negative); we normalize roughly to 0..1 for storage.
// -----------------------------------------------------------------------------

export function captureSpectrum(): number[] {
  if (!analyzer) return new Array(8).fill(0);
  const values = analyzer.getValue() as Float32Array;
  const bands: number[] = [];
  const binsPerBand = Math.floor(values.length / 8);
  for (let b = 0; b < 8; b++) {
    let sum = 0;
    for (let i = b * binsPerBand; i < (b + 1) * binsPerBand; i++) {
      sum += values[i];
    }
    const avgDb = sum / binsPerBand;
    // Map -100dB..0dB → 0..1 (clamped).
    const normalized = Math.max(0, Math.min(1, (avgDb + 100) / 100));
    bands.push(Number(normalized.toFixed(3)));
  }
  return bands;
}

// -----------------------------------------------------------------------------
// Recording — full descent captured as WebM blob.
// -----------------------------------------------------------------------------

export function startRecording(): void {
  if (!initialized || recorder) return;
  recorder = new Tone.Recorder();
  // Tap the FINAL mix so the recording captures voice + ducked layers
  // exactly as the user heard them.
  masterMix.connect(recorder);
  recorder.start();
}

export async function stopRecording(): Promise<Blob | null> {
  if (!recorder) return null;
  const blob = await recorder.stop();
  recorder.dispose();
  recorder = null;
  return blob;
}

// -----------------------------------------------------------------------------
// Layer factory — five presets.
// -----------------------------------------------------------------------------

export interface LayerHandle {
  id: string;
  type: LayerType;
  freq: number;
  dispose: () => void;
}

interface PresetBuild {
  /** Output node — gets connected to panner. */
  output: Tone.ToneAudioNode;
  /** Hertz value — primary tone, or representative frequency for noisy presets. */
  freq: number;
  /** Cleanup of all nodes inside the preset. */
  dispose: () => void;
}

const FREQS_LOW = [55, 61.74, 65.41, 73.42, 82.41, 87.31];
const FREQS_MID = [110, 130.81, 146.83, 164.81, 196];
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

function buildDrone(): PresetBuild {
  const freq = pick(FREQS_LOW);
  const detune = (Math.random() - 0.5) * 14;
  const osc = new Tone.Oscillator({ frequency: freq, type: 'sawtooth', detune });
  const sub = new Tone.Oscillator({ frequency: freq / 2, type: 'sine' });
  const filter = new Tone.Filter({ frequency: 320, type: 'lowpass', Q: 1.2 });
  const gain = new Tone.Gain(0);
  osc.connect(gain);
  sub.connect(gain);
  gain.connect(filter);

  const lfo = new Tone.LFO({
    frequency: 0.04 + Math.random() * 0.06,
    min: 180,
    max: 900,
    type: 'sine',
  }).start();
  lfo.connect(filter.frequency);

  osc.start();
  sub.start();
  gain.gain.rampTo(0.16, 4);

  return {
    output: filter,
    freq,
    dispose: () => {
      gain.gain.rampTo(0, 2.5);
      window.setTimeout(() => {
        try {
          osc.stop().dispose();
          sub.stop().dispose();
          filter.dispose();
          gain.dispose();
          lfo.stop().dispose();
        } catch {
          /* already disposed */
        }
      }, 2700);
    },
  };
}

function buildTexture(): PresetBuild {
  const noise = new Tone.Noise('pink');
  const bp = new Tone.Filter({ frequency: 800, type: 'bandpass', Q: 4 });
  const gain = new Tone.Gain(0);
  noise.connect(bp);
  bp.connect(gain);

  const lfo = new Tone.LFO({
    frequency: 0.05 + Math.random() * 0.1,
    min: 350,
    max: 2800,
    type: 'sine',
  }).start();
  lfo.connect(bp.frequency);

  noise.start();
  gain.gain.rampTo(0.09, 5);

  return {
    output: gain,
    freq: 800, // representative
    dispose: () => {
      gain.gain.rampTo(0, 2.5);
      window.setTimeout(() => {
        try {
          noise.stop().dispose();
          bp.dispose();
          gain.dispose();
          lfo.stop().dispose();
        } catch {
          /* already disposed */
        }
      }, 2700);
    },
  };
}

function buildPulse(): PresetBuild {
  const freq = pick(FREQS_MID);
  const osc = new Tone.Oscillator({ frequency: freq, type: 'triangle' });
  const env = new Tone.AmplitudeEnvelope({
    attack: 1.6,
    decay: 0.6,
    sustain: 0.5,
    release: 2.2,
  });
  const gain = new Tone.Gain(0.18);
  osc.connect(env);
  env.connect(gain);
  osc.start();

  const interval = 4 + Math.random() * 3.5; // seconds
  const loop = new Tone.Loop((time) => {
    env.triggerAttackRelease(2.4, time);
  }, interval).start(0);

  return {
    output: gain,
    freq,
    dispose: () => {
      loop.stop().dispose();
      gain.gain.rampTo(0, 2);
      window.setTimeout(() => {
        try {
          env.dispose();
          osc.stop().dispose();
          gain.dispose();
        } catch {
          /* already disposed */
        }
      }, 2200);
    },
  };
}

function buildGlitch(): PresetBuild {
  const noise = new Tone.Noise('white');
  const bp = new Tone.Filter({
    frequency: 1500,
    type: 'bandpass',
    Q: 8,
  });
  const gain = new Tone.Gain(0);
  noise.connect(bp);
  bp.connect(gain);
  noise.start();

  const loop = new Tone.Loop((time) => {
    const target = 800 + Math.random() * 5000;
    bp.frequency.cancelScheduledValues(time);
    bp.frequency.setValueAtTime(target, time);
    gain.gain.cancelScheduledValues(time);
    gain.gain.setValueAtTime(0.16, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
  }, '8n').start(0);
  loop.probability = 0.18; // sparse, ambient

  return {
    output: gain,
    freq: 1500,
    dispose: () => {
      loop.stop().dispose();
      window.setTimeout(() => {
        try {
          noise.stop().dispose();
          bp.dispose();
          gain.dispose();
        } catch {
          /* already disposed */
        }
      }, 200);
    },
  };
}

function buildBreath(): PresetBuild {
  const noise = new Tone.Noise('pink');
  // 'a'-vowel formant approximation — sounds like a hushed /aaa/.
  const formants = [
    { f: 730, q: 8, gain: 1.0 },
    { f: 1090, q: 6, gain: 0.55 },
    { f: 2440, q: 3, gain: 0.3 },
  ];
  const sumGain = new Tone.Gain(1);
  const bps: Tone.Filter[] = [];
  for (const fm of formants) {
    const bp = new Tone.Filter({ frequency: fm.f, type: 'bandpass', Q: fm.q });
    const fg = new Tone.Gain(fm.gain);
    noise.connect(bp);
    bp.connect(fg);
    fg.connect(sumGain);
    bps.push(bp);
  }
  noise.start();

  const env = new Tone.AmplitudeEnvelope({
    attack: 2.2,
    decay: 1.0,
    sustain: 0.5,
    release: 3.0,
  });
  const out = new Tone.Gain(0.12);
  sumGain.connect(env);
  env.connect(out);

  const interval = 5.5 + Math.random() * 2.5;
  const loop = new Tone.Loop((time) => {
    env.triggerAttackRelease(3.0, time);
  }, interval).start(0);

  return {
    output: out,
    freq: 730,
    dispose: () => {
      loop.stop().dispose();
      out.gain.rampTo(0, 2);
      window.setTimeout(() => {
        try {
          noise.stop().dispose();
          bps.forEach((b) => b.dispose());
          sumGain.dispose();
          env.dispose();
          out.dispose();
        } catch {
          /* already disposed */
        }
      }, 2400);
    },
  };
}

function buildPreset(type: LayerType): PresetBuild {
  switch (type) {
    case 'drone':
      return buildDrone();
    case 'texture':
      return buildTexture();
    case 'pulse':
      return buildPulse();
    case 'glitch':
      return buildGlitch();
    case 'breath':
      return buildBreath();
  }
}

// -----------------------------------------------------------------------------
// Public layer API.
// -----------------------------------------------------------------------------

export function addLayer(
  type: LayerType,
  position: [number, number, number],
): LayerHandle {
  if (!initialized) throw new Error('audio engine not initialized');

  const id = crypto.randomUUID();
  const preset = buildPreset(type);

  const panner = new Tone.Panner3D({
    positionX: position[0],
    positionY: position[1],
    positionZ: position[2],
    rolloffFactor: 0.4,
    refDistance: 6,
    maxDistance: 120,
    panningModel: 'HRTF',
  });

  preset.output.connect(panner);
  panner.connect(master);
  panner.connect(reverbSend);

  return {
    id,
    type,
    freq: preset.freq,
    dispose: () => {
      preset.dispose();
      window.setTimeout(() => {
        try {
          panner.dispose();
        } catch {
          /* already disposed */
        }
      }, 3000);
    },
  };
}
