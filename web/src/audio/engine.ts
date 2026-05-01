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

/**
 * Outro fade. Ramps the final summing-point gain (`masterMix`) toward zero
 * over `durationSec`, with a Tone.js `rampTo` (exponentialApproachTo under
 * the hood — natural-sounding tail rather than a linear ramp).
 *
 * masterMix is the node the recorder taps, so this single ramp simultaneously
 * fades what the player hears AND what gets baked into the WebM blob — no
 * separate ramps on layer buses, voice, or reverb. Reverb tail keeps decaying
 * during and after the fade since its tail lives upstream in the dry path.
 *
 * Cancels any prior schedule on the param so callers can re-arm or shorten
 * the fade without leftover automation fighting the new value.
 */
export function fadeOutMaster(durationSec: number): void {
  if (!initialized) return;
  masterMix.gain.cancelScheduledValues(Tone.now());
  masterMix.gain.rampTo(0, Math.max(0.05, durationSec));
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

// Frequency picking moved to the bridge (proxy/src/theory.ts) so player and
// agent placements share a single per-session scale. The audio engine just
// receives whatever pitch the bridge computed via the `layer_added` echo.
//
// What's left in this file is the *timbral* variation per instance: each
// build* function widens detune, LFO speeds, envelope times, and filter
// resonances so two layers of the same type at the same pitch still sound
// distinguishably different.

function buildDrone(freq: number): PresetBuild {
  // ±25 cents of detune (was ±7) — wide enough to actually hear beating
  // between the saw and the sub, and so two drones at the same pitch in
  // the same descent don't lock onto identical phase.
  const detune = (Math.random() - 0.5) * 50;
  const osc = new Tone.Oscillator({ frequency: freq, type: 'sawtooth', detune });
  const sub = new Tone.Oscillator({ frequency: freq / 2, type: 'sine' });
  // Cutoff fluctuates session-to-session: 220-450 Hz centre. Lower = more
  // muffled, higher = more present.
  const filterCenter = 220 + Math.random() * 230;
  const filter = new Tone.Filter({
    frequency: filterCenter,
    type: 'lowpass',
    // Q in 0.7..1.8 — at the high end the cutoff rings, giving the drone
    // a vocal resonance; at the low end it sits as flat low-end weight.
    Q: 0.7 + Math.random() * 1.1,
  });
  const gain = new Tone.Gain(0);
  osc.connect(gain);
  sub.connect(gain);
  gain.connect(filter);

  // LFO period 6.5–40s (was ~10–25s). Slow drones now actually drift slowly.
  // LFO sweep range also varies: in dim mode it stays in the bass; in
  // bright mode it climbs into mid territory before settling back.
  const lfoMin = 120 + Math.random() * 160;
  const lfoMax = 600 + Math.random() * 800;
  const lfo = new Tone.LFO({
    frequency: 0.025 + Math.random() * 0.13,
    min: lfoMin,
    max: lfoMax,
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
  // Bandpass Q 3..9 (was fixed 4). Low Q = airy hush, high Q = whistling
  // resonance. Ranges chosen so neither extreme is unpleasant.
  const bp = new Tone.Filter({
    frequency: freq,
    type: 'bandpass',
    Q: 3 + Math.random() * 6,
  });
  const gain = new Tone.Gain(0);
  noise.connect(bp);
  bp.connect(gain);

  // LFO period ~5–35s (was 6–20s). Sweep range also widens session-to-session.
  const lfoMin = 200 + Math.random() * 250;
  const lfoMax = 1800 + Math.random() * 1800;
  const lfo = new Tone.LFO({
    frequency: 0.03 + Math.random() * 0.18,
    min: lfoMin,
    max: lfoMax,
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
  // Pulse waveform varies — triangle is the soft default, sawtooth gives a
  // more reedy/voicelike pulse, square gives a hollow chiptune-y one. Each
  // session-instance picks one; the player perceives "different pulses".
  // `as const` is needed because Tone.Oscillator's options-object overload
  // overlaps with the partial-oscillator one — without literal narrowing,
  // tsc can't figure out which overload `type: wave` belongs to.
  const waveforms = ['triangle', 'sawtooth', 'square'] as const;
  const wave = waveforms[Math.floor(Math.random() * waveforms.length)];
  const osc = new Tone.Oscillator({ frequency: freq, type: wave });
  const env = new Tone.AmplitudeEnvelope({
    attack: 1.0 + Math.random() * 1.6,    // 1.0–2.6s (was 1.6 fixed)
    decay: 0.4 + Math.random() * 0.7,     // 0.4–1.1s
    sustain: 0.35 + Math.random() * 0.35, // 0.35–0.7
    release: 1.5 + Math.random() * 1.8,   // 1.5–3.3s
  });
  const gain = new Tone.Gain(0.18);
  osc.connect(env);
  env.connect(gain);
  osc.start();

  // Pulse interval 3–10s (was 4–7.5s). Tight pulses feel like a heartbeat;
  // long pulses feel like slow breath. Note duration also varies so the
  // pulse occasionally overlaps itself, occasionally leaves silence.
  const interval = 3 + Math.random() * 7;
  const noteDur = 1.6 + Math.random() * 2.4;
  const loop = new Tone.Loop((time) => {
    env.triggerAttackRelease(noteDur, time);
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
    // Q 5–12 (was fixed 8) — narrow Q gives sharp pings, wide Q is more crackle.
    Q: 5 + Math.random() * 7,
  });
  const gain = new Tone.Gain(0);
  noise.connect(bp);
  bp.connect(gain);
  noise.start();

  // Subdivision varies between '16n' (frantic), '8n' (default), '4n' (sparse).
  // Combined with probability 0.10–0.28 the glitch density spans clearly
  // different "machinery on/off" rates between sessions.
  const subdivisions = ['16n', '8n', '8n', '4n'];
  const subdiv = subdivisions[Math.floor(Math.random() * subdivisions.length)];
  // Decay 0.04–0.12s — short clicks vs longer crackles.
  const decay = 0.04 + Math.random() * 0.08;
  const loop = new Tone.Loop((time) => {
    const target = 800 + Math.random() * 5000;
    bp.frequency.cancelScheduledValues(time);
    bp.frequency.setValueAtTime(target, time);
    gain.gain.cancelScheduledValues(time);
    gain.gain.setValueAtTime(0.16, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + decay);
  }, subdiv).start(0);
  loop.probability = 0.10 + Math.random() * 0.18;

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
  // Vowel rotation: each layer instance picks a different mouth-shape
  // (formant set). /a/ is the default open vowel, /o/ is rounder, /i/
  // higher and tighter, /u/ lower and dome-y. Adds a clear timbral
  // distinction between two breath layers in the same descent.
  const vowels = [
    [{ f: 730, q: 8, gain: 1.0 }, { f: 1090, q: 6, gain: 0.55 }, { f: 2440, q: 3, gain: 0.3 }], // /a/
    [{ f: 570, q: 9, gain: 1.0 }, { f: 840, q: 6, gain: 0.55 }, { f: 2410, q: 3, gain: 0.25 }], // /o/
    [{ f: 270, q: 10, gain: 1.0 }, { f: 2290, q: 5, gain: 0.55 }, { f: 3010, q: 3, gain: 0.3 }], // /i/
    [{ f: 300, q: 9, gain: 1.0 }, { f: 870, q: 6, gain: 0.5 }, { f: 2240, q: 3, gain: 0.25 }],  // /u/
  ];
  const formants = vowels[Math.floor(Math.random() * vowels.length)];
  // Per-instance pitch jitter ±10% so even the same vowel sounds slightly
  // different from one breath to the next.
  const jitter = 0.9 + Math.random() * 0.2;
  const sumGain = new Tone.Gain(1);
  const bps: Tone.Filter[] = [];
  for (const fm of formants) {
    const bp = new Tone.Filter({
      frequency: fm.f * jitter,
      type: 'bandpass',
      Q: fm.q,
    });
    const fg = new Tone.Gain(fm.gain);
    noise.connect(bp);
    bp.connect(fg);
    fg.connect(sumGain);
    bps.push(bp);
  }
  noise.start();
  // freq is unused for synthesis (vowel formants are absolute); mark as
  // intentionally read so eslint/no-unused-vars stays happy and the visual
  // breathe-rate that consumes it from the engine still gets a value.
  void freq;

  // Envelope timing widens session-to-session: attack 1.5–3.5s, release
  // 2.0–4.5s. Combined with the interval below, two breath layers can
  // either feel like the same long sigh or two clearly distinct exhales.
  const env = new Tone.AmplitudeEnvelope({
    attack: 1.5 + Math.random() * 2.0,
    decay: 0.6 + Math.random() * 0.8,
    sustain: 0.35 + Math.random() * 0.3,
    release: 2.0 + Math.random() * 2.5,
  });
  const out = new Tone.Gain(0.12);
  sumGain.connect(env);
  env.connect(out);

  // 4–10s breath interval (was 5.5–8s). Hold time 2–4s.
  const interval = 4 + Math.random() * 6;
  const holdDur = 2.0 + Math.random() * 2.0;
  const loop = new Tone.Loop((time) => {
    env.triggerAttackRelease(holdDur, time);
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
  // octave. Inharmonicity ratio 1.97–2.05 (was fixed 2.01) — at 1.97 the
  // bell sounds slightly flat / sad, at 2.05 it's brassy / metallic. Per
  // instance, so two bells in the same descent have a clear identity.
  const osc = new Tone.Oscillator({ frequency: freq, type: 'sine' });
  const harm = new Tone.Oscillator({
    frequency: freq * (1.97 + Math.random() * 0.08),
    type: 'sine',
  });
  const harmGain = new Tone.Gain(0.18 + Math.random() * 0.18); // 0.18–0.36
  // Decay 4–8s (was 5.5 fixed) — short bell vs long bell.
  const env = new Tone.AmplitudeEnvelope({
    attack: 0.008 + Math.random() * 0.02,
    decay: 4 + Math.random() * 4,
    sustain: 0.0,
    release: 1.2 + Math.random() * 1.0,
  });
  const out = new Tone.Gain(0.22);
  osc.connect(env);
  harm.connect(harmGain);
  harmGain.connect(env);
  env.connect(out);
  osc.start();
  harm.start();

  // Strike interval 6–14s (was 8–12s). Ghost-strike probability 0.10–0.40.
  // Some bells now never echo, others have a near-constant trail.
  const interval = 6 + Math.random() * 8;
  const ghostProb = 0.10 + Math.random() * 0.30;
  const loop = new Tone.Loop((time) => {
    env.triggerAttackRelease(6.0, time);
    if (Math.random() < ghostProb) {
      env.triggerAttackRelease(2.5, time + 0.6 + Math.random() * 0.6);
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
  // Quick tonal pluck — sine + lowpass + steep envelope.
  const osc = new Tone.Oscillator({ frequency: freq, type: 'sine' });
  // LP cutoff 1.8x–3.5x of fundamental (was fixed 2.5x). Lower = duller "tup",
  // higher = brighter "ping". Q 3–7 — varies how much resonance "rings".
  const lp = new Tone.Filter({
    frequency: freq * (1.8 + Math.random() * 1.7),
    type: 'lowpass',
    Q: 3 + Math.random() * 4,
  });
  // Decay 0.30–0.65s — staccato drips vs slightly liquid drips.
  const env = new Tone.AmplitudeEnvelope({
    attack: 0.002 + Math.random() * 0.005,
    decay: 0.30 + Math.random() * 0.35,
    sustain: 0.0,
    release: 0.2 + Math.random() * 0.25,
  });
  const out = new Tone.Gain(0.28);
  osc.connect(lp);
  lp.connect(env);
  env.connect(out);
  osc.start();

  // Loop interval 0.45–1.15s (was 0.65 fixed) and probability 0.12–0.32
  // (was 0.22 fixed). Combined: average drip rate from one every ~1.4s
  // (busy splash) to one every ~7s (rare cave drip).
  const baseInterval = 0.45 + Math.random() * 0.7;
  const loop = new Tone.Loop((time) => {
    env.triggerAttackRelease(0.5, time);
  }, baseInterval).start(0);
  loop.probability = 0.12 + Math.random() * 0.20;

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
  // Q 4–10 (was fixed 6) — at low Q the swell is broad and woolly, at high
  // Q it has a clear singing pitch as it passes.
  const bp = new Tone.Filter({
    frequency: freq,
    type: 'bandpass',
    Q: 4 + Math.random() * 6,
  });
  const gain = new Tone.Gain(0);
  noise.connect(bp);
  bp.connect(gain);

  // Amplitude wave period 6–18s (was 10s fixed). Peak amplitude 0.10–0.18.
  // Same swell can either feel like a slow tide or a quick gust.
  const ampPeriod = 6 + Math.random() * 12;
  const ampPeak = 0.10 + Math.random() * 0.08;
  const amp = new Tone.LFO({
    frequency: 1 / ampPeriod,
    min: 0,
    max: ampPeak,
    type: 'sine',
  }).start();
  amp.connect(gain.gain);

  // Filter LFO at half the amp period, offset, so timbre brightens as it
  // swells and dulls as it recedes. Sweep span 0.4x–2.0x freq (was fixed
  // 0.6x–1.6x) — wide-sweep swells feel like a doppler pass, narrow ones
  // sit more like a stationary cloud.
  const sweepLow = 0.4 + Math.random() * 0.3;   // 0.4–0.7
  const sweepHigh = 1.4 + Math.random() * 0.6;  // 1.4–2.0
  const filterLfo = new Tone.LFO({
    frequency: 1 / (ampPeriod * 2),
    min: freq * sweepLow,
    max: freq * sweepHigh,
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
  // so the chord opens like a window rather than punching in.
  // Wider per-instance detuning (was -3/+4 cents fixed): each chord now has
  // its own beating rate and "color" — beats every ~3-12s.
  const root = new Tone.Oscillator({ frequency: rootFreq, type: 'sine' });
  const fifth = new Tone.Oscillator({
    frequency: rootFreq * 1.5,
    type: 'sine',
    detune: -10 + Math.random() * 8,   // -10..-2
  });
  const oct = new Tone.Oscillator({
    frequency: rootFreq * 2,
    type: 'sine',
    detune: -2 + Math.random() * 12,   // -2..+10
  });
  // Voice balance also varies — bright instances lean on the octave,
  // mellow instances lean on the fifth.
  const fifthGain = new Tone.Gain(0.45 + Math.random() * 0.25); // 0.45–0.70
  const octGain = new Tone.Gain(0.25 + Math.random() * 0.30);   // 0.25–0.55
  const sum = new Tone.Gain(1);
  root.connect(sum);
  fifth.connect(fifthGain);
  fifthGain.connect(sum);
  oct.connect(octGain);
  octGain.connect(sum);
  // Soft lowpass cutoff varies 1300–2400 Hz (was 1800 fixed). Lower = warmer,
  // higher = brighter chord. Q stays soft so it doesn't ring.
  const lp = new Tone.Filter({
    frequency: 1300 + Math.random() * 1100,
    type: 'lowpass',
    Q: 0.6 + Math.random() * 0.3,
  });
  sum.connect(lp);

  // Earlier the chord's gain ramped to 0.13 and then sustained forever —
  // one chord was fine, but two or three placed turned the descent into
  // a harmonic-pad drone and the tense minimalism got lost. Now a slow
  // LFO breathes the gain through 0..0.14 on a 24-second period so each
  // chord swells in (~6s), peaks, fades (~6s), and emerges again rather
  // than humming on indefinitely. Phase 270° starts the LFO at min=0 so
  // the chord arrives silently rather than punching in halfway through
  // its first swell.
  //
  // Two Gain stages because a single LFO-driven gain can't be smoothly
  // rampToed to 0 on dispose (the LFO sums with the intrinsic value, so
  // ramping intrinsic to 0 doesn't silence LFO output). outDriven is the
  // LFO target; outFinal is a normal AudioParam we ramp down on dispose.
  const outDriven = new Tone.Gain(0);
  lp.connect(outDriven);
  // Breathe period 16–32s (was 24s fixed) and peak 0.10–0.18 (was 0.14).
  // Different chord layers in the same descent now swell at different
  // rates rather than locking into one global breath.
  const breathePeriod = 16 + Math.random() * 16;
  const breathePeak = 0.10 + Math.random() * 0.08;
  const breathe = new Tone.LFO({
    frequency: 1 / breathePeriod,
    min: 0,
    max: breathePeak,
    type: 'sine',
    phase: 270,
  }).start();
  breathe.connect(outDriven.gain);

  const outFinal = new Tone.Gain(1);
  outDriven.connect(outFinal);

  root.start();
  fifth.start();
  oct.start();

  return {
    output: outFinal,
    freq: rootFreq,
    dispose: () => {
      outFinal.gain.rampTo(0, 3);
      window.setTimeout(() => {
        try {
          breathe.stop().dispose();
          root.stop().dispose();
          fifth.stop().dispose();
          oct.stop().dispose();
          fifthGain.dispose();
          octGain.dispose();
          sum.dispose();
          lp.dispose();
          outDriven.dispose();
          outFinal.dispose();
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
