/**
 * Audio engine — Tone.js master + 9 layer presets + 3D panning + voice ducking.
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
import { LAYER_TYPES, type LayerType } from '../state/useSession';

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

// Per-type mix buses. Built once in initAudio. Each layer's panner routes
// to its type's bus, and the bus routes to BOTH master (dry) and reverbSend
// (wet) — so muting a type via the EQ also silences its reverb tail. The
// session store mirrors these gains so the UI can drive them; on init we
// re-apply whatever the user had set.
const typeBuses: Map<LayerType, Tone.Gain> = new Map();

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

  // One Gain per layer type. Sits between every layer's panner and the
  // master limiter; also feeds the reverb send so muted types don't leave
  // a wet ghost behind. Default 1.0; the UI can change them via setLayerVolume.
  for (const type of LAYER_TYPES) {
    const bus = new Tone.Gain(1);
    bus.connect(master);
    bus.connect(reverbSend);
    typeBuses.set(type, bus);
  }

  analyzer = new Tone.Analyser('fft', 64);
  master.connect(analyzer); // pre-duck, pre-voice — measures layers only

  // Loops + scheduled envelopes need the Transport running.
  Tone.getTransport().start();

  initialized = true;
}

/**
 * Per-type volume control for the EQ panel. Value 0..1.5 (1.0 = unity).
 * Cheap to call — ramps the bus gain over 50ms so dragging a slider doesn't
 * click. No-op before initAudio().
 */
export function setLayerVolume(type: LayerType, value: number): void {
  if (!initialized) return;
  const bus = typeBuses.get(type);
  if (!bus) return;
  bus.gain.rampTo(Math.max(0, Math.min(2, value)), 0.05);
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
// Layer factory — nine presets.
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
// Bell pitches — A4..A5 covering a comfortable resonant range. Picked
// natural diatonic so successive bells form a coherent melodic palette.
const FREQS_BELL = [440, 523.25, 587.33, 659.25, 783.99, 880];
const FREQS_DRIP = [800, 1000, 1200];
const FREQS_SWELL = [600, 700, 820];

/**
 * Pick a representative frequency for a preset. Exported so the client can
 * decide a frequency BEFORE sending to the bridge — the bridge stores it,
 * broadcasts it back, and the engine plays the layer with the agreed freq.
 * For presets that don't use pitched oscillators (texture/glitch/breath/drip/swell)
 * the value is symbolic — it's used by the visual layer for breathe-rate
 * and by the agent context for descriptive purposes.
 */
export function pickFreqForType(type: LayerType): number {
  switch (type) {
    case 'drone':
      return FREQS_LOW[Math.floor(Math.random() * FREQS_LOW.length)];
    case 'pulse':
      return FREQS_MID[Math.floor(Math.random() * FREQS_MID.length)];
    case 'texture':
      return 800;
    case 'glitch':
      return 1500;
    case 'breath':
      return 730;
    case 'bell':
      return FREQS_BELL[Math.floor(Math.random() * FREQS_BELL.length)];
    case 'drip':
      return FREQS_DRIP[Math.floor(Math.random() * FREQS_DRIP.length)];
    case 'swell':
      return FREQS_SWELL[Math.floor(Math.random() * FREQS_SWELL.length)];
    case 'chord':
      // Chord uses a low root; the build adds 5th + octave on top.
      return FREQS_MID[Math.floor(Math.random() * FREQS_MID.length)];
  }
}

function buildDrone(freq: number): PresetBuild {
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

function buildTexture(freq: number): PresetBuild {
  const noise = new Tone.Noise('pink');
  const bp = new Tone.Filter({ frequency: freq, type: 'bandpass', Q: 4 });
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
    freq,
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

function buildPulse(freq: number): PresetBuild {
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

function buildGlitch(freq: number): PresetBuild {
  const noise = new Tone.Noise('white');
  const bp = new Tone.Filter({
    frequency: freq,
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
    freq,
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

function buildBreath(freq: number): PresetBuild {
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
    freq,
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

// -----------------------------------------------------------------------------
// Day 6 expansion — bell / drip / swell / chord.
//
// Design intent (from the brainstorm doc):
//   bell  — resonance with long decay. ONE bright tone with a slow exponential
//           tail; periodic re-strikes every ~9 sec. Closes the "no resonance"
//           gap left by drone/pulse/glitch (none of which sustain a tone).
//   drip  — sparse single events. Short percussive hit with a tonal pluck;
//           clusters of 1–3 hits at irregular intervals. Distinct from pulse
//           (regular rhythm) and glitch (digital fault).
//   swell — slow wave. Filtered noise that swells in over ~4s, holds, then
//           recedes over ~4s. Distinct from drone (constant) and breath (vocal
//           formant). Closes the "everything stationary" gap.
//   chord — harmonic pad. Three sine partials (root + perfect fifth + octave)
//           with a slow attack. Closes the "all monophonic" gap. Used sparingly
//           or it kills the tense minimalism of the rest of the palette.
// -----------------------------------------------------------------------------

function buildBell(freq: number): PresetBuild {
  // Two partials so it sings rather than buzzes: root + a slightly inharmonic
  // octave. Bandpass softens the sharper component a touch.
  const osc = new Tone.Oscillator({ frequency: freq, type: 'sine' });
  const harm = new Tone.Oscillator({
    frequency: freq * 2.01, // detuned octave for a metallic shimmer
    type: 'sine',
  });
  const harmGain = new Tone.Gain(0.25);
  const env = new Tone.AmplitudeEnvelope({
    attack: 0.01,
    decay: 5.5,
    sustain: 0.0,
    release: 1.5,
  });
  const out = new Tone.Gain(0.22);
  osc.connect(env);
  harm.connect(harmGain);
  harmGain.connect(env);
  env.connect(out);
  osc.start();
  harm.start();

  // Strike every 8–12 sec with a small probability of a quieter "ghost" double.
  const interval = 8 + Math.random() * 4;
  const loop = new Tone.Loop((time) => {
    env.triggerAttackRelease(6.0, time);
    if (Math.random() < 0.18) {
      env.triggerAttackRelease(2.5, time + 0.7 + Math.random() * 0.4);
    }
  }, interval).start(0);

  return {
    output: out,
    freq,
    dispose: () => {
      loop.stop().dispose();
      out.gain.rampTo(0, 2);
      window.setTimeout(() => {
        try {
          osc.stop().dispose();
          harm.stop().dispose();
          harmGain.dispose();
          env.dispose();
          out.dispose();
        } catch {
          /* already disposed */
        }
      }, 2200);
    },
  };
}

function buildDrip(freq: number): PresetBuild {
  // Quick tonal pluck — sine + lowpass + steep envelope. We re-trigger at
  // irregular intervals so drips feel like cave water, not a clock.
  const osc = new Tone.Oscillator({ frequency: freq, type: 'sine' });
  const lp = new Tone.Filter({ frequency: freq * 2.5, type: 'lowpass', Q: 4 });
  const env = new Tone.AmplitudeEnvelope({
    attack: 0.003,
    decay: 0.45,
    sustain: 0.0,
    release: 0.3,
  });
  const out = new Tone.Gain(0.28);
  osc.connect(lp);
  lp.connect(env);
  env.connect(out);
  osc.start();

  // Loop at a tight base interval, then probabilistically gate. With p=0.22
  // the average drip rate is about one every 3 seconds, with natural clustering.
  const loop = new Tone.Loop((time) => {
    env.triggerAttackRelease(0.5, time);
  }, 0.65).start(0);
  loop.probability = 0.22;

  return {
    output: out,
    freq,
    dispose: () => {
      loop.stop().dispose();
      out.gain.rampTo(0, 0.6);
      window.setTimeout(() => {
        try {
          osc.stop().dispose();
          lp.dispose();
          env.dispose();
          out.dispose();
        } catch {
          /* already disposed */
        }
      }, 800);
    },
  };
}

function buildSwell(freq: number): PresetBuild {
  // Pink noise through a resonant bandpass; a long-period LFO sweeps both the
  // amplitude and the filter so the swell "approaches and passes" rather than
  // staying glued in place.
  const noise = new Tone.Noise('pink');
  const bp = new Tone.Filter({ frequency: freq, type: 'bandpass', Q: 6 });
  const gain = new Tone.Gain(0);
  noise.connect(bp);
  bp.connect(gain);

  // Amplitude wave: ~10 sec cycle (4s up, 2s plateau, 4s down).
  const amp = new Tone.LFO({
    frequency: 0.1, // 10s period
    min: 0,
    max: 0.16,
    type: 'sine',
  }).start();
  amp.connect(gain.gain);

  // Filter wave: half the period, offset, so the timbre brightens as it
  // swells and dulls as it recedes.
  const filterLfo = new Tone.LFO({
    frequency: 0.05,
    min: freq * 0.6,
    max: freq * 1.6,
    type: 'sine',
    phase: 90,
  }).start();
  filterLfo.connect(bp.frequency);

  noise.start();

  return {
    output: gain,
    freq,
    dispose: () => {
      amp.stop().dispose();
      filterLfo.stop().dispose();
      gain.gain.rampTo(0, 3);
      window.setTimeout(() => {
        try {
          noise.stop().dispose();
          bp.dispose();
          gain.dispose();
        } catch {
          /* already disposed */
        }
      }, 3200);
    },
  };
}

function buildChord(rootFreq: number): PresetBuild {
  // Three sine partials: root, perfect fifth (×1.5), octave (×2). Slow attack
  // so the chord opens like a window rather than punching in. Shared envelope
  // keeps the parts coherent.
  const root = new Tone.Oscillator({ frequency: rootFreq, type: 'sine' });
  const fifth = new Tone.Oscillator({
    frequency: rootFreq * 1.5,
    type: 'sine',
    detune: -3,
  });
  const oct = new Tone.Oscillator({
    frequency: rootFreq * 2,
    type: 'sine',
    detune: 4,
  });
  const fifthGain = new Tone.Gain(0.6);
  const octGain = new Tone.Gain(0.4);
  const sum = new Tone.Gain(1);
  root.connect(sum);
  fifth.connect(fifthGain);
  fifthGain.connect(sum);
  oct.connect(octGain);
  octGain.connect(sum);
  // Soft lowpass to prevent the upper octave from getting shrill.
  const lp = new Tone.Filter({ frequency: 1800, type: 'lowpass', Q: 0.7 });
  sum.connect(lp);
  const out = new Tone.Gain(0);
  lp.connect(out);
  root.start();
  fifth.start();
  oct.start();
  out.gain.rampTo(0.13, 7);

  return {
    output: out,
    freq: rootFreq,
    dispose: () => {
      out.gain.rampTo(0, 3);
      window.setTimeout(() => {
        try {
          root.stop().dispose();
          fifth.stop().dispose();
          oct.stop().dispose();
          fifthGain.dispose();
          octGain.dispose();
          sum.dispose();
          lp.dispose();
          out.dispose();
        } catch {
          /* already disposed */
        }
      }, 3200);
    },
  };
}

function buildPreset(type: LayerType, freq: number): PresetBuild {
  switch (type) {
    case 'drone':
      return buildDrone(freq);
    case 'texture':
      return buildTexture(freq);
    case 'pulse':
      return buildPulse(freq);
    case 'glitch':
      return buildGlitch(freq);
    case 'breath':
      return buildBreath(freq);
    case 'bell':
      return buildBell(freq);
    case 'drip':
      return buildDrip(freq);
    case 'swell':
      return buildSwell(freq);
    case 'chord':
      return buildChord(freq);
  }
}

// -----------------------------------------------------------------------------
// Public layer API.
// -----------------------------------------------------------------------------

/**
 * Play a layer. The freq is provided externally so the bridge stays
 * authoritative — the client picks freq via pickFreqForType, sends it to
 * the bridge, the bridge stores + broadcasts it back, and we play with the
 * agreed value. The optional `id` is used to attach the layer to a server-
 * generated PlacedLayer so visuals + audio share an identity.
 */
export function addLayer(
  type: LayerType,
  position: [number, number, number],
  freq: number,
  id?: string,
): LayerHandle {
  if (!initialized) throw new Error('audio engine not initialized');

  const layerId = id ?? crypto.randomUUID();
  const preset = buildPreset(type, freq);

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
  // Route via the per-type mix bus so the EQ panel can fade types in/out.
  // Bus already feeds master + reverbSend, so we only connect once here.
  // Fallback to master directly is just defensive — the bus map is populated
  // in initAudio for every LayerType.
  const bus = typeBuses.get(type);
  if (bus) {
    panner.connect(bus);
  } else {
    panner.connect(master);
    panner.connect(reverbSend);
  }

  return {
    id: layerId,
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
