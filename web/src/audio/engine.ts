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
import { LAYER_TYPES, type LayerType, type PadId } from '../state/useSession';
import type { SessionScalePublic } from '../net/protocol';

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

// Pad bus — sister to typeBuses but for the atmospheric pads. All three
// pad voices share one bus so the player perceives them as a single
// "atmosphere" track. Connects to master + reverbSend like the per-type
// buses, so pads ride the same cathedral reverb. Default 0.7 gain — well
// below unity so pads sit *under* the placed-layer composition.
let padBus: Tone.Gain;
// Live pad voices keyed by PadId. Each value is a dispose function that
// fades the voice out and tears down its nodes; absent entry = pad is off.
type PadDispose = () => void;
const padHandles: Map<PadId, PadDispose> = new Map();

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

  // Pads bus — single shared bus for all three atmospheric pad voices.
  // Gain 0.45 (was 0.7) — pads are background atmosphere, not lead voices,
  // and the previous 0.7 was loud enough to compete with placed layers
  // when more than one pad was engaged. The relative balance between
  // GLOW / AIR / DEEP is set per-pad by PAD_PEAK; this bus just attenuates
  // the whole group so they sit *under* the composition.
  padBus = new Tone.Gain(0.45);
  padBus.connect(master);
  padBus.connect(reverbSend);

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
  // Sub voice — one octave below the fundamental. With drone now at
  // oct 2 (fundamental 65–185 Hz, see proxy/src/theory.ts), the sub
  // lands at 33–93 Hz which is cleanly reproducible on most playback
  // systems. The 30 Hz floor below is defensive — it kicks in only
  // if drone is ever moved back to a lower octave; at oct 2 freq/2
  // is always ≥33 Hz so the floor's ternary always falls through to
  // the true sub-octave.
  const subFreq = freq / 2 < 30 ? freq : freq / 2;
  const sub = new Tone.Oscillator({ frequency: subFreq, type: 'sine' });
  // Octave-up triangle voice — bypasses the LP filter so it provides
  // constant audible body even when the LFO closes the cutoff. The
  // saw fundamental sits at 65–185 Hz now (drone moved from oct 1 to
  // oct 2; see proxy/src/theory.ts for why), so it's reproducible on
  // most playback systems — but octUp at 130–370 Hz still adds a clean
  // mid-band presence that the LFO can't sweep away. Triangle's 1/n²
  // harmonic falloff keeps it gentle even unfiltered.
  const octUp = new Tone.Oscillator({ frequency: freq * 2, type: 'triangle' });

  // Sources: saw + sub merge here, then go through the swept LP. octUp
  // routes around the filter and joins back at the final env (`gain`).
  const srcMix = new Tone.Gain(1);

  // Cutoff fluctuates session-to-session: 220-450 Hz centre. Lower = more
  // muffled, higher = more present.
  const filterCenter = 220 + Math.random() * 230;
  const filter = new Tone.Filter({
    frequency: filterCenter,
    type: 'lowpass',
    // Q in 0.5..0.9 (was 0.7..1.8). Above 1.0 the filter resonates at
    // the cutoff; on the swept LFO that meant a moving formant peak rang
    // through whichever saw harmonic crossed it — the "vocal buzz" the
    // user heard as noise. Capping below resonance gives a smooth
    // roll-off instead.
    Q: 0.5 + Math.random() * 0.4,
  });

  // octUp at -9dB relative to saw/sub. Loud enough to be heard on any
  // playback (laptop speakers can reach 66+ Hz), quiet enough that the
  // saw + sub pair stays the dominant identity of the voice.
  const octUpAtten = new Tone.Gain(0.35);

  // Master env. Also acts as the summing point where the filtered
  // (saw+sub) branch and the unfiltered (octUp) branch merge.
  const gain = new Tone.Gain(0);

  osc.connect(srcMix);
  sub.connect(srcMix);
  srcMix.connect(filter);
  filter.connect(gain);

  octUp.connect(octUpAtten);
  octUpAtten.connect(gain);

  // LFO period 6.5–40s (was ~10–25s). Slow drones now actually drift slowly.
  // LFO sweep range narrowed: lfoMax 400–800 (was 600–1400). Capping the
  // peak below 800 Hz keeps saw harmonics from ringing through the filter
  // when the LFO opens up — that was the "shleyf" the user heard as the
  // buzzy phase took 5–15 s to subside per LFO cycle.
  const lfoMin = 120 + Math.random() * 160;
  const lfoMax = 400 + Math.random() * 400;
  const lfo = new Tone.LFO({
    frequency: 0.025 + Math.random() * 0.13,
    min: lfoMin,
    max: lfoMax,
    type: 'sine',
  }).start();
  lfo.connect(filter.frequency);

  osc.start();
  sub.start();
  octUp.start();
  // Master env target 0.07168 (cumulative cuts: 0.16 → 0.112 → 0.0896 →
  // 0.07168). Drone is the densest single voice in the mix (saw + sub
  // + octUp through a moving filter, ~5-second attack), and successive
  // listener feedback kept reporting it as too loud relative to other
  // layers and the new pads. Per-instance peak math: saw + sub through
  // unit-gain srcMix can reach ~2.0 before the LP, the filtered branch
  // peaks near unity in the passband, octUp adds another 0.35 — so the
  // env scales an internal signal of ~2.35 down. 0.07168 brings
  // per-drone peak to ~0.17, leaving the limiter completely untouched
  // even with 5 drones stacked.
  gain.gain.rampTo(0.07168, 4);

  return {
    output: gain,
    freq,
    dispose: () => {
      gain.gain.rampTo(0, 2.5);
      window.setTimeout(() => {
        try {
          osc.stop().dispose();
          sub.stop().dispose();
          octUp.stop().dispose();
          srcMix.dispose();
          filter.dispose();
          octUpAtten.dispose();
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
  // Pulse waveform — triangle is the soft default (weighted 2/3),
  // sawtooth gives a more reedy/voicelike pulse (1/3). Square was
  // dropped: its slowly-falling odd-harmonic spectrum (1/n) at high
  // pitches sat right in the 2-4 kHz Fletcher-Munson sensitivity peak,
  // reading as "shrill" rather than "pulse".
  // `as const` is needed because Tone.Oscillator's options-object overload
  // overlaps with the partial-oscillator one — without literal narrowing,
  // tsc can't figure out which overload `type: wave` belongs to.
  const waveforms = ['triangle', 'triangle', 'sawtooth'] as const;
  const wave = waveforms[Math.floor(Math.random() * waveforms.length)];
  const osc = new Tone.Oscillator({ frequency: freq, type: wave });
  // LP at 4× fundamental — preserves the first 3-4 harmonics (which give
  // pulse its waveform character) but cuts everything above ~2 kHz at
  // the high end of the pitch range. Without this the saw pulse at oct 3
  // (~466 Hz fundamental, harmonics up to Nyquist) leaked harsh content
  // through to master, where the ear's 2-4 kHz sensitivity peak picked
  // it up as the "loud and unpleasant" complaint. Q 0.6..0.9 — well
  // below resonance, just a smooth roll-off, no formant.
  const filter = new Tone.Filter({
    frequency: freq * 4,
    type: 'lowpass',
    Q: 0.6 + Math.random() * 0.3,
  });
  const env = new Tone.AmplitudeEnvelope({
    attack: 1.0 + Math.random() * 1.6,    // 1.0–2.6s (was 1.6 fixed)
    decay: 0.4 + Math.random() * 0.7,     // 0.4–1.1s
    sustain: 0.35 + Math.random() * 0.35, // 0.35–0.7
    release: 1.5 + Math.random() * 1.8,   // 1.5–3.3s
  });
  // Out gain 0.1152 (cumulative: 0.18 → 0.144 → 0.1152). Pulse's
  // repeating attack envelope means multiple instances can hit on
  // overlapping cycles and stack — dropping the per-instance peak
  // gives the master limiter room when 3-4 pulses align, and
  // continued listener feedback flagged pulse as still too prominent.
  const gain = new Tone.Gain(0.1152);
  osc.connect(filter);
  filter.connect(env);
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
          filter.dispose();
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
  // Out gain 0.09856 (cumulative: 0.22 → 0.154 → 0.1232 → 0.09856).
  // Bells stand out in the mix because their decay envelope is longer
  // than most layer types — multiple overlapping bells stack into a
  // sustained chord-of-bells, and the original 0.22 ceiling pushed the
  // cumulative bell loudness above the surrounding layers. Successive
  // cuts bring the bell tail in line with pads + cut drone/chord/etc.
  const out = new Tone.Gain(0.09856);
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
  // Out gain 0.12544 (cumulative: 0.28 → 0.196 → 0.1568 → 0.12544).
  // Drip's transient attack puts most of its energy in a sub-millisecond
  // peak that the ear reads as "loud" disproportionate to its perceived
  // RMS — the original 0.28 made dense drip sequences pop above the
  // rest of the mix. Successive cuts pull the transient peak down
  // without losing the staccato bite.
  const out = new Tone.Gain(0.12544);
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
  // LFO breathes the gain through 0..breathePeak on a 16-32 s period so
  // each chord swells in (~6s), peaks, fades (~6s), and emerges again
  // rather than humming on indefinitely. Phase 270° starts the LFO at
  // min=0 so the chord arrives silently rather than punching in halfway
  // through its first swell.
  //
  // Two Gain stages because a single LFO-driven gain can't be smoothly
  // rampToed to 0 on dispose (the LFO sums with the intrinsic value, so
  // ramping intrinsic to 0 doesn't silence LFO output). outDriven is the
  // LFO target; outFinal is a normal AudioParam we ramp down on dispose.
  const outDriven = new Tone.Gain(0);
  lp.connect(outDriven);
  // Breathe period 16–32 s. Peak 0.0448–0.08064 (cumulative: 0.10–0.18
  // → 0.07–0.126 → 0.056–0.1008 → 0.0448–0.08064). Like buildDrone
  // above, the chord's internal sum (root + 0.45-0.7×fifth +
  // 0.25-0.55×oct ≈ 2.25 worst case) gets scaled by the LFO peak to
  // produce per-instance output. At 0.08064 cap per-instance peak is
  // ~0.18, well clear of the master limiter even with multiple chords
  // overlapping at their swell peaks.
  const breathePeriod = 16 + Math.random() * 16;
  const breathePeak = 0.0448 + Math.random() * 0.03584;
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
// Pads — three atmospheric voices, each derived from the session's scale.
//
// Pads aren't placed in the world; they're a separate "air" track the player
// can engage as background. All three route through `padBus` (initialized
// alongside the per-type buses in initAudio), which is wired to master +
// reverbSend so pads ride the cathedral reverb like everything else.
//
// Pads share the descent's tonal centre (rootPc) and pull harmony notes from
// the scale's `intervals` array. We pick "the scale's third / fifth / etc."
// dynamically — Phrygian gives us a minor third, Lydian a sharp fourth, and
// pentatonics fall back gracefully when an interval is absent. Two players
// in different keys hear different pad chords.
//
// Voice envelopes sustain indefinitely while the pad is engaged. Start ramps
// in over ~4 s, stop ramps out over ~3 s and disposes nodes after the tail.
// -----------------------------------------------------------------------------

/**
 * Convert (octave, semitone-from-root) → Hz using the descent's root pitch
 * class. Same MIDI math as `freqAt` in proxy/src/theory.ts — kept local so
 * the engine doesn't need to import from theory (which lives in proxy/).
 */
function padFreq(scale: SessionScalePublic, octave: number, semitone: number): number {
  const midi = 12 * (octave + 1) + scale.rootPc + semitone;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Find the first matching semitone in the scale, with fallbacks. e.g.
 * `pickInterval(scale, 3, 4)` returns minor third if present, else major
 * third, else null. Returning null lets callers omit a voice rather than
 * forcing an unscale-tone.
 */
function pickInterval(
  scale: SessionScalePublic,
  ...candidates: number[]
): number | null {
  for (const c of candidates) {
    if (scale.intervals.includes(c)) return c;
  }
  return null;
}

interface PadVoiceBuild {
  output: Tone.ToneAudioNode;
  oscillators: Tone.Oscillator[];
  extras: { dispose: () => void }[];
}

/**
 * GLOW — warm mid-range triad. Saw-stack on root + third + fifth at oct 3,
 * sine sub at oct 2 for body. LP cutoff sweeps slowly between 350 and
 * 1100 Hz — keeps the timbre breathing without ever opening up too far.
 *
 * Identity: this is the "centred" pad — present, harmonically complete,
 * fills the mid spectrum. Use alone for a held chord, or combine with AIR
 * for shimmer or DEEP for foundation.
 */
function buildPadGlow(scale: SessionScalePublic): PadVoiceBuild {
  const third = pickInterval(scale, 3, 4); // minor or major third
  const fifth = pickInterval(scale, 7, 6, 8) ?? 7; // perfect / dim / aug
  const rootHz = padFreq(scale, 3, 0);
  const subHz = padFreq(scale, 2, 0);

  const sum = new Tone.Gain(1);
  const oscs: Tone.Oscillator[] = [];
  const extras: { dispose: () => void }[] = [];

  // Saw root with subtle detune (chorus warmth on a single voice).
  const sawRoot = new Tone.Oscillator({
    frequency: rootHz,
    type: 'sawtooth',
    detune: -6 + Math.random() * 4,
  });
  sawRoot.connect(sum);
  oscs.push(sawRoot);

  // Saw third — gain attenuated so the third doesn't dominate over root.
  if (third !== null) {
    const sawThird = new Tone.Oscillator({
      frequency: padFreq(scale, 3, third),
      type: 'sawtooth',
      detune: -3 + Math.random() * 6,
    });
    const thirdGain = new Tone.Gain(0.55);
    sawThird.connect(thirdGain);
    thirdGain.connect(sum);
    oscs.push(sawThird);
    extras.push(thirdGain);
  }

  // Saw fifth.
  const sawFifth = new Tone.Oscillator({
    frequency: padFreq(scale, 3, fifth),
    type: 'sawtooth',
    detune: 3 + Math.random() * 4,
  });
  const fifthGain = new Tone.Gain(0.55);
  sawFifth.connect(fifthGain);
  fifthGain.connect(sum);
  oscs.push(sawFifth);
  extras.push(fifthGain);

  // Sine sub one octave below root — body the laptop speakers can't quite
  // reach but headphones / decent speakers feel as foundation.
  const sineSub = new Tone.Oscillator({ frequency: subHz, type: 'sine' });
  const subGain = new Tone.Gain(0.45);
  sineSub.connect(subGain);
  subGain.connect(sum);
  oscs.push(sineSub);
  extras.push(subGain);

  // Slow LP sweep. Q stays below resonance — pad is supposed to be
  // featureless background, no formant ringing.
  const filter = new Tone.Filter({
    frequency: 600,
    type: 'lowpass',
    Q: 0.6 + Math.random() * 0.2,
  });
  sum.connect(filter);
  extras.push(sum, filter);

  // 14–26 s LFO period. min 350, max 1100 — narrower than buildDrone's
  // sweep so the pad reads as steady atmosphere, not a moving texture.
  const lfo = new Tone.LFO({
    frequency: 1 / (14 + Math.random() * 12),
    min: 350,
    max: 1100,
    type: 'sine',
  }).start();
  lfo.connect(filter.frequency);
  extras.push({ dispose: () => lfo.stop().dispose() });

  return { output: filter, oscillators: oscs, extras };
}

/**
 * AIR — high-register shimmer. Triangles + sine on root + fifth + ninth at
 * oct 4–5. No third (open quartal-ish quality). Subtle vibrato keeps the
 * upper harmonics alive without straying off-pitch.
 *
 * Identity: this is the "ceiling" pad — light, breathy, sits above the
 * placed layers. Pairs naturally with GLOW (which fills the middle) or
 * DEEP (where the contrast feels like sky over earth).
 */
function buildPadAir(scale: SessionScalePublic): PadVoiceBuild {
  const fifth = pickInterval(scale, 7, 6, 8) ?? 7;
  // Ninth = root of next octave + 2 semitones (i.e. semitone 14 in
  // absolute terms). Will use octave 5 directly with semitone 2 if
  // available in scale, else fall back to root+12 (octave doubling).
  const second = pickInterval(scale, 2, 1, 3); // 2nd, ♭2, or ♭3 fallback
  const rootHi = padFreq(scale, 4, 0);
  const fifthHi = padFreq(scale, 4, fifth);
  // "Ninth" voice — semitone 2 of octave 5 if scale has a 2nd, else
  // an octave-doubled root (still consonant).
  const ninthHz = second !== null ? padFreq(scale, 5, second) : padFreq(scale, 5, 0);

  const sum = new Tone.Gain(1);
  const oscs: Tone.Oscillator[] = [];
  const extras: { dispose: () => void }[] = [];

  // Triangle root — soft, harmonically gentle.
  const triRoot = new Tone.Oscillator({
    frequency: rootHi,
    type: 'triangle',
    detune: -4 + Math.random() * 8,
  });
  triRoot.connect(sum);
  oscs.push(triRoot);

  // Triangle fifth.
  const triFifth = new Tone.Oscillator({
    frequency: fifthHi,
    type: 'triangle',
    detune: -2 + Math.random() * 6,
  });
  const fifthG = new Tone.Gain(0.55);
  triFifth.connect(fifthG);
  fifthG.connect(sum);
  oscs.push(triFifth);
  extras.push(fifthG);

  // Sine ninth (or octave-doubled root) — quietest of the stack, just a
  // shimmer on top.
  const sineNinth = new Tone.Oscillator({ frequency: ninthHz, type: 'sine' });
  const ninthG = new Tone.Gain(0.32);
  sineNinth.connect(ninthG);
  ninthG.connect(sum);
  oscs.push(sineNinth);
  extras.push(ninthG);

  // Subtle vibrato — fast LFO, narrow depth on the root frequency. Adds
  // life without sounding like seasick chorusing.
  const vibrato = new Tone.LFO({
    frequency: 4.5 + Math.random() * 1.5,
    min: -8,
    max: 8,
    type: 'sine',
  }).start();
  vibrato.connect(triRoot.detune);
  extras.push({ dispose: () => vibrato.stop().dispose() });

  // Higher LP cutoff — air pad is supposed to be present in the upper mids.
  const filter = new Tone.Filter({
    frequency: 2400,
    type: 'lowpass',
    Q: 0.5 + Math.random() * 0.2,
  });
  sum.connect(filter);
  extras.push(sum, filter);

  // Slow filter LFO — wider sweep than GLOW so AIR shimmers more.
  const sweep = new Tone.LFO({
    frequency: 1 / (10 + Math.random() * 10),
    min: 1500,
    max: 3500,
    type: 'sine',
  }).start();
  sweep.connect(filter.frequency);
  extras.push({ dispose: () => sweep.stop().dispose() });

  return { output: filter, oscillators: oscs, extras };
}

/**
 * DEEP — sub-foundation drone. Sine sub at oct 1 + saw root at oct 2 +
 * saw fifth at oct 2. Heavily filtered (LP 200–600 Hz) so it reads as
 * "underground room tone" rather than a melodic line.
 *
 * Identity: this is the "floor" pad — sub-bass body the placed-layer
 * drone can't always provide on its own, plus a quiet fifth for harmonic
 * grounding. On laptop speakers DEEP barely registers; on headphones or
 * subs it transforms the whole mix into something cinematic.
 */
function buildPadDeep(scale: SessionScalePublic): PadVoiceBuild {
  const fifth = pickInterval(scale, 7, 6, 8) ?? 7;
  const subHz = padFreq(scale, 1, 0);
  const rootLow = padFreq(scale, 2, 0);
  const fifthLow = padFreq(scale, 2, fifth);

  const sum = new Tone.Gain(1);
  const oscs: Tone.Oscillator[] = [];
  const extras: { dispose: () => void }[] = [];

  // Sine sub — primary body. Loudest of the three voices.
  const sineSub = new Tone.Oscillator({ frequency: subHz, type: 'sine' });
  sineSub.connect(sum);
  oscs.push(sineSub);

  // Saw root one octave above the sub. Detuned slightly so two playthroughs
  // of the same scale don't sound identical.
  const sawRoot = new Tone.Oscillator({
    frequency: rootLow,
    type: 'sawtooth',
    detune: -8 + Math.random() * 6,
  });
  const rootG = new Tone.Gain(0.5);
  sawRoot.connect(rootG);
  rootG.connect(sum);
  oscs.push(sawRoot);
  extras.push(rootG);

  // Saw fifth — quiet harmonic grounding.
  const sawFifth = new Tone.Oscillator({
    frequency: fifthLow,
    type: 'sawtooth',
    detune: 4 + Math.random() * 6,
  });
  const fifthG = new Tone.Gain(0.32);
  sawFifth.connect(fifthG);
  fifthG.connect(sum);
  oscs.push(sawFifth);
  extras.push(fifthG);

  // Heavy LP — DEEP is supposed to be felt, not heard distinctly. Cutoff
  // ~250 Hz centre, sweep 200–600. Above 600 the saw harmonics start to
  // push the pad into "low drone" territory and lose the cave-floor feel.
  const filter = new Tone.Filter({
    frequency: 320,
    type: 'lowpass',
    Q: 0.55 + Math.random() * 0.25,
  });
  sum.connect(filter);
  extras.push(sum, filter);

  // Very slow LFO — 22–40 s period. DEEP barely moves; that's the point.
  const lfo = new Tone.LFO({
    frequency: 1 / (22 + Math.random() * 18),
    min: 200,
    max: 600,
    type: 'sine',
  }).start();
  lfo.connect(filter.frequency);
  extras.push({ dispose: () => lfo.stop().dispose() });

  return { output: filter, oscillators: oscs, extras };
}

function buildPadVoice(id: PadId, scale: SessionScalePublic): PadVoiceBuild {
  switch (id) {
    case 'glow':
      return buildPadGlow(scale);
    case 'air':
      return buildPadAir(scale);
    case 'deep':
      return buildPadDeep(scale);
  }
}

/** Per-pad envelope peak. Tuned so 1 pad ≈ tasteful, all 3 ≈ full but
 *  still under the placed-layer mix. Sum of peaks (0.16+0.13+0.18 = 0.47)
 *  × padBus 0.7 ≈ 0.33 peak into master before limiter — leaves headroom. */
const PAD_PEAK: Record<PadId, number> = {
  glow: 0.16,
  air: 0.13,
  deep: 0.18,
};

/**
 * Engage a pad voice. No-op if the pad is already engaged or if `scale`
 * is null (snapshot hasn't arrived yet — the UI guards this anyway).
 */
export function startPad(id: PadId, scale: SessionScalePublic): void {
  if (!initialized) return;
  if (padHandles.has(id)) return;

  const voice = buildPadVoice(id, scale);
  // Slow attack envelope — pad is supposed to materialise, not punch in.
  const env = new Tone.Gain(0);
  voice.output.connect(env);
  env.connect(padBus);

  for (const o of voice.oscillators) o.start();
  // Attack 12 s — pad swell is the whole point. 4 s read as "punched in";
  // 12 s is "material slowly forming" — the texture is fully present only
  // by the time the next layer turn rolls around. Tone's linear rampTo
  // from a Gain at 0 to PAD_PEAK is smooth across the full duration.
  env.gain.rampTo(PAD_PEAK[id], 12);

  padHandles.set(id, () => {
    // Release 6 s. Don't manually cancelScheduledValues — Tone.Param.rampTo
    // already calls setRampPoint→cancelAndHoldAtTime internally, and a
    // duplicate external cancel can leave a tiny window where the
    // AudioParam value drifts before the new ramp anchors, which can
    // produce a tick on dispose. Letting rampTo own the cancel keeps the
    // taper monotonic from current value to 0.
    env.gain.rampTo(0, 6);
    // Buffer 6.5 s — comfortably past the 6 s ramp end so env.gain has
    // settled at exactly 0 before any oscillator/LFO is stopped. Stopping
    // an oscillator while the gain is still tiny-but-nonzero is what makes
    // the click on tear-down audible.
    window.setTimeout(() => {
      try {
        for (const o of voice.oscillators) o.stop().dispose();
        for (const e of voice.extras) e.dispose();
        env.dispose();
      } catch {
        /* already disposed */
      }
    }, 6500);
  });
}

/** Disengage a pad voice. No-op if it isn't engaged. */
export function stopPad(id: PadId): void {
  const dispose = padHandles.get(id);
  if (!dispose) return;
  padHandles.delete(id);
  dispose();
}

/** Stop every active pad — used when the descent ends so we don't leak
 *  voices past `phase === 'finished'` (audible damage is nil because the
 *  outro fade is already silencing masterMix, but it cleans up CPU). */
export function stopAllPads(): void {
  for (const id of Array.from(padHandles.keys())) {
    stopPad(id);
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
