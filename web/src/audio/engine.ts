/**
 * Audio engine — Tone.js master + 9 layer presets + 3D panning + voice ducking.
 *
 * Signal graph:
 *
 *   per-layer preset → Panner3D ─┬─→ master (Gain)
 *                                └─→ reverbSend → reverb → master
 *                                                              │
 *   master ──────────────────────────────────► analyser (pre-voice, layers only)
 *      │
 *      ▼
 *   masterDuck (Gain — ramped down during voice playback)
 *      │
 *      ▼
 *   masterMix (Gain) ───┬─→ masterLimiter (-1 dBFS) → destination
 *                       └─→ recorder (pre-limiter; full mix incl. voice)
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
/**
 * Master sum point — was `Tone.Limiter(-1)` through Day 6. Listener
 * reported persistent peak-time clicks audible BOTH in playback and
 * in the recording (recorder taps masterMix downstream of `master`,
 * so any click captured at masterMix is in the digital signal —
 * rules out speakers/drivers/system-audio-thread).
 *
 * Diagnostic suspicion: Tone.Limiter wraps Web Audio's
 * DynamicsCompressorNode, which applies a small amount of look-ahead
 * (~6 ms in Chrome) and RMS-smoothing even on signals well below
 * threshold. On signals with strong slow beating (drone's ±25 cent
 * detune between fund and its octave-related sub/octUp gives ~1–3 Hz
 * amplitude modulation; chord's three slightly-detuned sines also
 * beat slowly), the RMS detector can twitch at the slow envelope's
 * peaks and produce subtle compression-curve discontinuities — heard
 * as clicks correlating with the perceived "peak" of the sound.
 * Math says our signal (max ~0.2 instantaneous) is well below the
 * -1 dBFS threshold (0.89) so the compressor should be transparent,
 * but DCN's actual behavior at low signal levels isn't fully
 * transparent in practice.
 *
 * Replacing with a static Gain(0.9): same ~-1 dB headroom via pure
 * attenuation, NO compression / RMS / look-ahead / threshold logic.
 * If this kills the click we'll add back a softer compressor (slow
 * attack, soft knee) as the safety net for the rare extreme
 * stack-up case. If clicks persist, the cause is upstream of master
 * (reverb chain, layer presets) and we move the diagnostic there.
 */
let master: Tone.Gain;
// masterHpf — temporarily removed (see initAudio diagnostic comment).
// Restore via re-adding declaration + Filter creation if HPF turns out
// to be exonerated. Keeping the declaration commented (not deleted)
// makes restoring it a one-line revert.
// let masterHpf: Tone.Filter;
let masterDuck: Tone.Gain;
let masterMix: Tone.Gain;
// masterLimiter — restored after the click cause was traced to Panner3D
// HRTF mode + 60 Hz listener updates (NOT the limiter as originally
// suspected). Now sits between masterMix and destination, catching
// peaks at −1 dBFS. Recorder taps masterMix UPSTREAM of the limiter
// so recordings keep the full pre-limit dynamic range.
let masterLimiter: Tone.Limiter;
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

  // Final summing point — feeds masterLimiter (→ destination) + recorder.
  // masterLimiter is at −1 dBFS, so any peak that pokes above ≈0.891 at
  // masterMix's output gets clamped before it hits the speakers. This is
  // the safety net that lets the per-layer mix run hot without the
  // March/April series of "still too quiet" bumps risking digital clip.
  masterMix = new Tone.Gain(1);
  masterLimiter = new Tone.Limiter(-1);
  masterMix.connect(masterLimiter);
  masterLimiter.toDestination();

  // Layers route: master → masterDuck → masterMix.
  //
  // masterHpf DISCONNECTED for diagnostic. Listener report after the
  // recorder-disable round: "не важно сколько звуков на сцене, один
  // drone или 10 разных, редкие потрескивания и клики остаются".
  // That signature — clicks independent of layer count — means the
  // cause is in shared infrastructure (master chain) not per-preset
  // synthesis or per-layer cold-start. Limiter bypass + reverb
  // disconnect + recorder disable already done. Of what's still in
  // the master path, the only biquad with internal state is masterHpf.
  //
  // Biquad filters maintain z-1, z-2 delay-line state. On signals
  // with low-amplitude beating (drone's ±25 cent fund/sub/octUp
  // detune produces ~1-3 Hz amplitude modulation), the filter state
  // can briefly drift toward denormal floating-point values during
  // beating troughs. On x86 CPUs denormal arithmetic is up to 100x
  // slower than normal — audio thread can underrun → click. Rate
  // would correlate with beating frequency (a few Hz), matching
  // the "редкие потрескивания" report.
  //
  // Without the HPF, subsonic content (<40 Hz) again reaches the
  // destination. That was a real concern for cone-flap before, but
  // the listener already confirmed clicks are in the recording too —
  // so the cause we're chasing is in the digital signal, not the
  // playback chain. We can re-add subsonic mitigation later via
  // per-preset HPFs (one-pole, no z-state issue) if the listener
  // reports cone-flap returning.
  //
  // Gain bumped 0.9 → 1.4 (×1.55, ≈ +3.8 dB) to address the listener's
  // "65% on speakers should feel like 100% does now" complaint. The −6 dB
  // destination volume above + masterLimiter at −1 dBFS keep this safe:
  // per-layer peaks summing through master at 1.4 still have ≈0.5×
  // headroom before the limiter catches them, and the limiter prevents
  // the sum-of-peaks worst case (drone+chord+pads coinciding) from
  // hard-clipping the destination. See masterLimiter declaration above.
  master = new Tone.Gain(1.4);
  masterDuck = new Tone.Gain(1);
  master.connect(masterDuck);
  masterDuck.connect(masterMix);

  // Voice route: voiceGain → masterMix (bypasses duck)
  voiceGain = new Tone.Gain(1.4);
  voiceGain.connect(masterMix);

  // Reverb — algorithmic 16-second IR via ConvolverNode. Was disconnected
  // for several diagnostic rounds while we hunted the rare-click bug.
  // Click cause turned out to be Panner3D in HRTF mode + 60 Hz listener
  // position updates (each update re-rendered the HRTF convolver), NOT
  // reverb. Reverb is back online — provides the cathedral-ambient feel
  // that's central to Sonoglyph's identity.
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

  // Drone-specific extra reverb send. Drone is the cathedral atmosphere
  // voice and gets ~2× the wet of other layers (in addition to the shared
  // depth-modulated reverbSend above). Tap point is the drone typeBus —
  // crucially NOT the layer's `breath` output directly. Reason: tapping
  // breath bypasses the typeBus.gain stage, so when the EQ panel mutes
  // drone (typeBus.gain → 0), drone signal still leaks into the reverb
  // tail through this dedicated path. Routing via the typeBus means the
  // mute zeros every downstream branch, including this one.
  //
  // Single Gain shared across all drone instances (vs the previous
  // per-instance node). Drones place into the same typeBus and the
  // typeBus output is what feeds the reverb here; no need for an
  // instance-level node.
  const droneBus = typeBuses.get('drone');
  if (droneBus) {
    const droneReverbBoost = new Tone.Gain(0.5);
    droneBus.connect(droneReverbBoost);
    droneReverbBoost.connect(reverb);
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

// -----------------------------------------------------------------------------
// Drone timbre profiles — picked uniformly per buildDrone() call.
//
// Why per-instance variation: the user's complaint — "дрон тянется
// бесконечно и скучно через весь трек" — was really about uniformity
// across the descent. Three drones placed = three identical voices
// stacked. Selecting a profile at construction means three drones now
// sound like three different drones in the same key, not three layered
// copies of the same patch.
//
// All four profiles preserve the no-resonance constraint (Q=0.5
// everywhere, never sweeps) so the click-bug history that motivated
// the static-filter rewrite (see buildDrone for the full chain) is
// still respected: cutoff varies BETWEEN drones, never WITHIN one.
//
// Naming reads as a description of where the drone sits sonically.
// 'body' is the original pre-profile mix, kept verbatim so the volume
// chain calibration still has its anchor reference.
// -----------------------------------------------------------------------------

type DroneProfile = {
  name: 'deep' | 'body' | 'airy' | 'hollow';
  oscGain: number; // fundamental triangle pre-mix gain
  subGain: number; // sub sine attenuation
  octUpGain: number; // octave-up triangle attenuation
  cutoff: number; // LP cutoff Hz (Q stays 0.5 across all profiles)
};

const DRONE_PROFILES: DroneProfile[] = [
  // Bass-tilted: sub up, octUp barely there, dark cutoff. "Cave floor".
  { name: 'deep', oscGain: 1.0, subGain: 0.7, octUpGain: 0.15, cutoff: 350 },
  // The original pre-profile balance. Volume calibration is anchored here.
  { name: 'body', oscGain: 1.0, subGain: 0.5, octUpGain: 0.25, cutoff: 500 },
  // Mid-scooped, octUp dominant. "Shimmer over the floor".
  { name: 'airy', oscGain: 0.85, subGain: 0.3, octUpGain: 0.4, cutoff: 900 },
  // Hollowed-mid, both ends present, fundamental sits back. "Distant low note".
  { name: 'hollow', oscGain: 0.5, subGain: 0.5, octUpGain: 0.4, cutoff: 600 },
];

function buildDrone(freq: number): PresetBuild {
  // Profile picked uniformly per instance. Multiple drones in the same
  // descent get distinct timbres rather than rendering as layered copies.
  const profile =
    DRONE_PROFILES[Math.floor(Math.random() * DRONE_PROFILES.length)];

  // ±25 cents of detune (was ±7) — wide enough to actually hear beating
  // between the saw and the sub, and so two drones at the same pitch in
  // the same descent don't lock onto identical phase. This is the INITIAL
  // offset; the oscDetuneLfo further down drifts ±10 c around it so the
  // detune is no longer a one-shot value set at construction.
  const detune = (Math.random() - 0.5) * 50;
  // Fundamental wave: triangle, NOT sawtooth (was sawtooth through Day 6).
  //
  // Saw has a hard-edge discontinuity at every period — the waveform jumps
  // from +1 back to -1 instantaneously. Even with bandlimited oscillators
  // the discontinuity manifests as a sharp transient at the start of each
  // period (every 5.4–15.4 ms at drone's oct 2 fundamentals 65–185 Hz).
  // With the LFO sweeping LP cutoff between lfoMin (~120) and lfoMax
  // (formerly 400–800 Hz), at MAX cutoff the filter let through the saw's
  // upper harmonics and the edge transient with them — audible as a few
  // discrete clicks per LFO peak. At MIN cutoff the harmonics are
  // smoothed out and the click is inaudible. So clicks only appeared on
  // peaks of the LFO sweep — exactly the symptom the listener reported,
  // even with a single drone alone.
  //
  // Triangle has no edge discontinuity — the waveform is continuous, only
  // its derivative has corners. Harmonic content rolls off as 1/n²
  // (third harmonic at 1/9, fifth at 1/25, seventh at 1/49) versus saw's
  // 1/n. So the LP filter has very little upper-harmonic content to deal
  // with regardless of cutoff position; nothing to crack on at peak.
  // Tradeoff: drone's "growl" identity softens. The saw character lives
  // mostly in the upper harmonics (3rd–8th) which the LP was filtering
  // out most of the time anyway; triangle keeps the low-order body
  // (fundamental + 3rd harmonic at much reduced level) which is what
  // the listener actually heard.
  const osc = new Tone.Oscillator({ frequency: freq, type: 'triangle', detune });
  // Sub voice — one octave below the fundamental. With drone now at
  // oct 2 (fundamental 65–185 Hz, see proxy/src/theory.ts), the sub
  // lands at 33–93 Hz which is cleanly reproducible on most playback
  // systems. The 30 Hz floor below is defensive — it kicks in only
  // if drone is ever moved back to a lower octave; at oct 2 freq/2
  // is always ≥33 Hz so the floor's ternary always falls through to
  // the true sub-octave.
  const subFreq = freq / 2 < 30 ? freq : freq / 2;
  const sub = new Tone.Oscillator({ frequency: subFreq, type: 'sine' });
  // Sub attenuation — was a flat 0.5 across all instances. Now drawn from
  // the profile (0.3 / 0.5 / 0.5 / 0.7) so 'deep' anchors heavier on the
  // sub while 'airy' lifts off it. The original 0.5 is preserved by the
  // 'body' profile so the headroom math (master HPF at 40 Hz, sub-band
  // contribution to limiter, etc.) still has its calibration anchor.
  const subAtten = new Tone.Gain(profile.subGain);
  // Octave-up triangle voice — bypasses the LP filter so it provides
  // audible body even with the filter relatively closed. The fundamental
  // sits at 65–185 Hz, so octUp at 130–370 Hz adds a clean mid-band
  // presence. Triangle's 1/n² harmonic falloff keeps it gentle unfiltered.
  const octUp = new Tone.Oscillator({ frequency: freq * 2, type: 'triangle' });

  // NEW (per-profile): osc fundamental no longer feeds srcMix at unity.
  // 'hollow' specifically uses oscGain=0.5 to push the fundamental back
  // and let sub + octUp dominate, reading as "low note seen from far".
  // Other profiles are at or near unity, so this stage is mostly a
  // no-op for them but gives 'hollow' a recognisable identity.
  const oscAtten = new Tone.Gain(profile.oscGain);

  // Sources: osc + sub merge here, then go through the LP. octUp routes
  // around the filter and joins back at the env summing point.
  const srcMix = new Tone.Gain(1);

  // Cutoff comes from the profile (350 / 500 / 900 / 600 Hz). Q is
  // fixed 0.5 across all profiles — overdamped, no resonance peak.
  //
  // Earlier versions had an LFO sweeping cutoff between (intrinsic 220-450)
  // + (lfo output 120-450), with Q up to 0.9 producing a small (~0.6 dB)
  // resonance peak right at cutoff. Each LFO cycle dragged that peak
  // through the fundamental + harmonics, momentarily amplifying whichever
  // partial sat at cutoff. On top of that, the LFO drove the biquad's
  // frequency AudioParam at audio rate, forcing per-block coefficient
  // recompute — a known source of subtle DSP artifacts on lower-end
  // playback systems. The cure was eliminating biquad modulation entirely.
  //
  // What we DIDN'T eliminate: per-instance cutoff diversity. The cutoff
  // is set ONCE at construction from the profile and never moves — no
  // biquad coefficient recompute happens at audio rate, no resonance
  // crossings, no AudioParam scheduling. So the no-click guarantee
  // still holds; we just get four cutoff "shades" across the descent
  // instead of one.
  const filter = new Tone.Filter({
    frequency: profile.cutoff,
    type: 'lowpass',
    Q: 0.5,
  });

  // octUp gain comes from the profile (0.15 / 0.25 / 0.4 / 0.4). The
  // 'body' profile's 0.25 is the post-static-filter calibration value;
  // 'airy' bumps to 0.4 so octUp dominates over a quieter fundamental,
  // 'deep' drops to 0.15 so the high mid is barely present.
  const octUpAtten = new Tone.Gain(profile.octUpGain);

  // env — multi-stage envelope (see schedule below at the bottom of
  // buildDrone). Peak value is 0.26138.
  //
  // Cumulative volume chain across all passes:
  //   0.16 → 0.112 → 0.0896 → 0.07168 → 0.055 → 0.06875 → 0.0859
  //   → 0.1117 → 0.16755 → 0.21782 → 0.32673 → 0.26138
  // (last step −20 % off the post-LFO-fix peak, listener report:
  //  drone now lands too loud after the breath bug fix corrected the
  //  effective gain by a factor of ≈22×).
  //
  // Why the +50 %/+30 % bumps before the LFO fix were ineffective:
  // the breath LFO was overwriting breath.gain to oscillate
  // −0.15 … +0.15 (Tone.Signal connections OVERRIDE AudioParams, not
  // sum with them — see breath block). The drone therefore ran at
  // |sin| × 0.15 ≈ 0.095× env on average, with zero-crossing every
  // half-period producing the "drone disappears for 3 seconds"
  // complaint. With the LFO range corrected to 0.6 … 1.0, peak is
  // exactly env × 1.0 and trough is env × 0.6.
  //
  // Peak instantaneous gain: 0.26138 × 1.0 = 0.26138 at the breath
  // LFO apex (during the t=1 s peak of the envelope); trough during
  // peak phase: 0.26138 × 0.6 = 0.157. The masterLimiter at −1 dBFS
  // is the backstop for the sum-of-peaks worst case.
  const env = new Tone.Gain(0);

  // NEW (A, fixed): amplitude breath. Slow LFO modulating a multiplier
  // post-env so the drone is no longer a flat-line gain after the ramp.
  //
  // BUG history (now fixed): originally min/max were −0.15 / +0.15 with
  // a `breath = Gain(1)` intrinsic, written under the assumption that
  // the LFO would SUM with the intrinsic 1 to produce a 0.85 … 1.15
  // multiplier. That assumption was wrong: Tone.Signal `.connect()` to
  // an AudioParam OVERRIDES the param value (Tone clears the intrinsic
  // and the Signal's output becomes the param's effective value). So
  // breath.gain actually swung −0.15 … +0.15, twice crossing zero per
  // period. Audible result: drone reduced to |sin| × 0.15 average gain,
  // with full silence at every zero-crossing held for ~1–3 s before the
  // amplitude crawled back. Listener report ("drone disappears for 3 s,
  // slow to come back") matched exactly.
  //
  // Fix: min/max are now 0.6 … 1.0, treated as absolute multipliers
  // (which is what Tone's override semantics actually deliver). Trough
  // is 60 % of env (never silent), peak is unity. Period also dropped
  // 1.5× (20–60 s → 13–40 s) per the same listener request that the
  // breath cycle return to peak faster.
  //
  // Why post-env, not on env directly: env is being .rampTo()'d during
  // start and dispose. Connecting an LFO to env.gain too would mean the
  // LFO override clobbers the rampTo schedule — start/dispose fades
  // would no longer ramp, they'd snap to the LFO output. Keeping breath
  // as a separate stage means env owns the ramp and breath owns the LFO.
  const breath = new Tone.Gain(1);
  const breathPeriod = 13 + Math.random() * 27; // 13–40 s (was 20–60 s; 1.5× faster)
  const breathLfo = new Tone.LFO({
    frequency: 1 / breathPeriod,
    min: 0.6, // trough — drone audibly recedes but never falls silent
    max: 1.0, // peak — env's full amplitude
    type: 'sine',
    phase: Math.random() * 360,
  });
  breathLfo.connect(breath.gain);
  breathLfo.start();

  // NEW (B): slow detune drift on osc + octUp. ±10 c around the initial
  // detune offset, period 30–90 s, independent random phase per LFO so
  // the two voices phase against each other continuously instead of
  // locking after init. Together with breath, this prevents a single
  // drone from settling into a perfectly static signal.
  //
  // Sub stays unmodulated — it's the bass anchor. Modulating sub at
  // freq/2 (33–93 Hz) would create LF wobble that's hard to track and
  // would fight the master HPF at 40 Hz that's clipping the bottom of
  // sub's range already.
  //
  // Detune is a parameter on the oscillator, not the filter, so unlike
  // the historic LFO+filter combination this modulation does NOT touch
  // any biquad coefficients. It changes the oscillator's playback rate;
  // no risk of resonance crossings, no audio-rate parameter scheduling.
  const oscDetuneLfo = new Tone.LFO({
    frequency: 1 / (30 + Math.random() * 60),
    min: -10,
    max: 10,
    type: 'sine',
    phase: Math.random() * 360,
  });
  oscDetuneLfo.connect(osc.detune);
  oscDetuneLfo.start();

  const octUpDetuneLfo = new Tone.LFO({
    frequency: 1 / (30 + Math.random() * 60),
    min: -10,
    max: 10,
    type: 'sine',
    phase: Math.random() * 360,
  });
  octUpDetuneLfo.connect(octUp.detune);
  octUpDetuneLfo.start();

  // NEW (D): harmonic crossfade. Two LFOs in antiphase that morph the
  // drone between dark (fundamental dominant) and bright (octUp dominant)
  // over a 25–45 s period. This is the timbral equivalent of the breath
  // amplitude LFO — same kind of slow lifelike motion but on the spectral
  // axis instead of the loudness axis.
  //
  // Mapping (in antiphase, period shared):
  //   oscAtten LFO     min = profile.oscGain × 0.6, max = profile.oscGain × 1.0
  //   octUpAtten LFO   min = profile.octUpGain × 0.4, max = profile.octUpGain × 1.6
  //
  // When oscAtten is at max (loud fundamental) octUpAtten is at min
  // (quiet octUp) → DARK moment. Half a period later: oscAtten at min,
  // octUpAtten at max → BRIGHT moment. The crossfade preserves the
  // profile's identity (the per-profile values still anchor the centre
  // of each LFO's range) while giving each instance a slow tonal
  // breathing layered on top of the amplitude breath.
  //
  // Sub stays unmodulated, same reason as the detune drift LFOs above:
  // the sub-octave is the bass anchor and doesn't benefit from spectral
  // modulation at this depth.
  //
  // No biquad involvement — both targets are plain Gain AudioParams,
  // so this modulation is in the same "no z-state, no coefficient
  // recompute" safe class as the existing LFOs.
  const crossfadePeriod = 25 + Math.random() * 20; // 25–45 s
  const crossfadePhase = Math.random() * 360;
  const oscGainLfo = new Tone.LFO({
    frequency: 1 / crossfadePeriod,
    min: profile.oscGain * 0.6,
    max: profile.oscGain * 1.0,
    type: 'sine',
    phase: crossfadePhase,
  });
  oscGainLfo.connect(oscAtten.gain);
  oscGainLfo.start();

  const octUpGainLfo = new Tone.LFO({
    frequency: 1 / crossfadePeriod,
    min: profile.octUpGain * 0.4,
    max: profile.octUpGain * 1.6,
    type: 'sine',
    phase: (crossfadePhase + 180) % 360, // antiphase to oscGainLfo
  });
  octUpGainLfo.connect(octUpAtten.gain);
  octUpGainLfo.start();

  // Routing — osc now goes through oscAtten before srcMix; everything
  // post-filter goes through env then breath.
  osc.connect(oscAtten);
  oscAtten.connect(srcMix);
  sub.connect(subAtten);
  subAtten.connect(srcMix);
  srcMix.connect(filter);
  filter.connect(env);

  octUp.connect(octUpAtten);
  octUpAtten.connect(env);

  env.connect(breath);

  // Note: the drone-specific extra reverb send is set up ONCE in
  // initAudio (tapped from the drone typeBus), not per instance here.
  // Earlier version tapped `breath` directly into reverb, which leaked
  // past the typeBus mute — drone kept feeding the reverb tail even
  // when the EQ slider was at 0. The shared per-type send fixes that
  // and also avoids growing/disposing a Gain node on every drone
  // placement. See typeBuses block in initAudio.

  osc.start();
  sub.start();
  octUp.start();

  // Multi-stage envelope giving drone an audible shape rather than a
  // constant presence:
  //
  //    t=0    t=1     t=26          t=36           t=61
  //     │      │       │             │              │
  //     0 ───→ peak ──→ 0 ──────────→ peak/2 ──────→ 0
  //            │        │             │              │
  //            1 s atk  25 s decay    10 s re-atk    25 s dissolve
  //
  // Listener intent: drone becomes a shaped event with a slow rebound
  // echo, not background music. The re-attack is 10 s (NOT a pop) so
  // the second wave reads as the cave breathing back, not a second
  // hit. After ~61 s the voice naturally fades to silence; the layer
  // object stays alive (Web Audio nodes don't get torn down) so the
  // listener can place a second drone later in the descent for
  // another wave, by choice rather than by default.
  //
  // Linear ramps (not exponential) so the drone audibly persists
  // through the full 25 s decay rather than dropping by half in
  // the first few seconds. With breath LFO multiplying on top
  // (range 0.6–1.0 over 13–40 s), the linear decay reads as
  // "fading while still breathing" instead of dead-flat ramp.
  const peak = 0.26138;
  const t0 = Tone.now();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(peak, t0 + 1);          //  1 s attack
  env.gain.linearRampToValueAtTime(0, t0 + 26);            // 25 s decay
  env.gain.linearRampToValueAtTime(peak * 0.5, t0 + 36);   // 10 s re-attack
  env.gain.linearRampToValueAtTime(0, t0 + 61);            // 25 s dissolve

  return {
    output: breath,
    freq,
    dispose: () => {
      env.gain.rampTo(0, 2.5);
      window.setTimeout(() => {
        try {
          // LFOs first — once the gain stages are disposed they stop
          // emitting silently anyway, but cleaning up the LFO nodes
          // explicitly avoids leaking Web Audio scheduling state.
          breathLfo.stop().dispose();
          oscDetuneLfo.stop().dispose();
          octUpDetuneLfo.stop().dispose();
          oscGainLfo.stop().dispose();
          octUpGainLfo.stop().dispose();
          osc.stop().dispose();
          sub.stop().dispose();
          subAtten.dispose();
          octUp.stop().dispose();
          srcMix.dispose();
          filter.dispose();
          octUpAtten.dispose();
          oscAtten.dispose();
          env.dispose();
          breath.dispose();
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
  // texture env: 0.09 → 0.1125 → 0.1406 → 0.1828 → 0.14624 → 0.19011
  // (fourth pass −20%, fifth pass +30% — the +30% is the latest "raise
  // everything except pads" pass; texture is back above its post-third-
  // pass level but still below the pre-cut 0.1828 thanks to the −20%).
  gain.gain.rampTo(0.19011, 5);

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
  // Out gain 0.1521 (chain: 0.18 → 0.144 → 0.1152 → 0.144 → 0.18 →
  // 0.12 → 0.156 → 0.117 → 0.1521 — fourth pass −25% and fifth pass
  // +30% applied together in a single edit; net 0.1521 is essentially
  // pulse's pre-cut 0.156 minus a hair, intentional because pulse's
  // repeating attack envelope had been poking out again after the
  // drone/bell/drip rebalance and the user requested its bite be
  // dialled back relative to the rest of the bed before the +30%
  // global lift).
  const gain = new Tone.Gain(0.1521);
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
    // glitch peak: 0.16 → 0.20 → 0.25 → 0.325 → 0.4225 (fourth pass
    // at +30%, "raise everything except pads"). At 0.4225 glitch is
    // now the second-loudest peak after swell — its short decay
    // (0.04–0.12 s) keeps the RMS contribution low so it shouldn't
    // dominate, but worth A/B-checking against other transients.
    gain.gain.setValueAtTime(0.4225, time);
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
  // breath out gain 0.12 → 0.15 → 0.1875 → 0.2438 → 0.19504 → 0.25355
  // (fourth pass −20%, fifth pass +30% — the +30% is the latest "raise
  // everything except pads" pass; breath now sits above the previous
  // 0.2438 peak, which is fine because the rolloffFactor=0 fix means
  // drone holds level and won't be progressively masked by breath
  // through the descent the way it was before that fix).
  const out = new Tone.Gain(0.25355);
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
  // Out gain 0.15620 (cumulative: 0.22 → 0.154 → 0.1232 → 0.09856 →
  // 0.1232 → 0.1602 → 0.12015 → 0.15620 with fifth pass at +30%
  // "raise everything except pads"; bell is back near its third-pass
  // peak of 0.1602 but still below it, so the chord-of-bells masking
  // observed pre-fourth-pass shouldn't fully return).
  const out = new Tone.Gain(0.15620);
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
  // Out gain 0.24843 (cumulative: 0.28 → 0.196 → 0.1568 → 0.12544 →
  // 0.1568 → 0.196 → 0.2548 → 0.1911 → 0.24843 with fifth pass at
  // +30%). Drip is now back near its previous 0.2548 peak. Drip's
  // sub-millisecond transient still reads "loud" relative to RMS, so
  // if it starts punching through drone again next pass would bring
  // it back below 0.2 rather than reaching for further boosts.
  const out = new Tone.Gain(0.24843);
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

  // Amplitude wave period 6–18s. Peak amplitude 0.26416–0.47541 (chain:
  // 0.10–0.18 → 0.125–0.225 → 0.1563–0.2813 → 0.2032–0.3657 →
  // 0.26416–0.47541, fourth pass at +30% "raise everything except
  // pads"). Swell's max peak is now the loudest single-source peak
  // in the 9 layer types — its slow attack and infrequent placement
  // mean the high peak only shows up sporadically, but if the bed
  // ever starts pumping the limiter it'll be the first suspect.
  const ampPeriod = 6 + Math.random() * 12;
  const ampPeak = 0.26416 + Math.random() * 0.21125;
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
  // Breathe period 16–32 s. Peak 0.09464–0.17030 (cumulative chain:
  // 0.10–0.18 → 0.07–0.126 → 0.056–0.1008 → 0.0448–0.08064 → 0.0358–
  // 0.06451 → 0.0448–0.0806 → 0.056–0.1008 → 0.0728–0.131 → 0.09464–
  // 0.17030, fourth pass at +30% "raise everything except pads"; now
  // sits at-or-above the original pre-cut peak level). Chord's internal
  // sum (root + 0.45-0.7×fifth + 0.25-0.55×oct ≈ 2.25 worst case)
  // scaled by LFO peak: instantaneous peak ~0.383 at max. The advisory
  // about restoring masterLimiter is now in effect — see initAudio,
  // master is Gain(1.4) followed by Tone.Limiter(-1) so peaks above
  // ≈0.891 at masterMix get clamped before the destination.
  const breathePeriod = 16 + Math.random() * 16;
  const breathePeak = 0.09464 + Math.random() * 0.07566;
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
 *  still under the placed-layer mix. Bumped +30% in the third volume
 *  pass alongside the layer presets so pads kept their relative weight
 *  in the bed. Sum of peaks (0.208+0.169+0.234 = 0.611) × padBus 0.45
 *  ≈ 0.275 peak into master — well within headroom now that
 *  master is Gain(1.4) followed by masterLimiter at −1 dBFS. */
const PAD_PEAK: Record<PadId, number> = {
  glow: 0.208, // 0.16 → 0.208 (+30%)
  air: 0.169,  // 0.13 → 0.169 (+30%)
  deep: 0.234, // 0.18 → 0.234 (+30%)
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

  // Distance attenuation override for drone.
  //
  // Web Audio's PannerNode uses inverse-distance attenuation:
  //   gain = refDistance / (refDistance + rolloffFactor × (distance − refDistance))
  // With the defaults below (refDistance 6, rolloffFactor 0.4), a layer
  // 50 units from the listener plays at gain 0.25 (−12 dB). For most
  // layer types that's the desired behaviour: bells / drips / glitches
  // are transient and get triggered at positions close to the camera,
  // so they always sound at near-unity. Drone is different — it's
  // placed once near the start of the descent and sustains until the
  // end, while the listener (= R3F camera) keeps descending away from
  // it. By mid-descent drone is sitting at −5 to −10 dB just from
  // distance attenuation, on top of the Fletcher-Munson penalty its
  // low fundamental already pays. That was the real "drone is too
  // quiet" complaint — successive volume bumps could only compensate
  // partially because the attenuation is time-dependent.
  //
  // rolloffFactor: 0 collapses the inverse-distance formula to gain=1
  // regardless of distance, so drone holds its level for the full
  // descent. Stereo positioning (L/R based on position relative to
  // the listener) still works — that's a function of the panner's
  // angle, not its distance gain — so two drones placed at different
  // x positions still feel different in the stereo field.
  //
  // Only drone gets this; other sustained types (texture, chord) are
  // localised atmosphere and benefit from the distance fade.
  const isOmnipresent = type === 'drone';

  const panner = new Tone.Panner3D({
    positionX: position[0],
    positionY: position[1],
    positionZ: position[2],
    rolloffFactor: isOmnipresent ? 0 : 0.4,
    refDistance: 6,
    maxDistance: 120,
    // DIAGNOSTIC: equalpower instead of HRTF. HRTF panning convolves
    // the signal with head-related impulse responses on the audio
    // thread; equalpower is a simple stereo-gain ratio based on
    // position with no convolution. If clicks are caused by HRTF
    // convolver state churn (especially combined with frequent
    // listener-position updates from the camera descent), switching
    // to equalpower will fix them. Tradeoff: 3D positioning sounds
    // less precise, more like simple stereo panning. We can revert
    // to HRTF if it turns out not to be the cause.
    panningModel: 'equalpower',
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

  // Drone-only: slow stereo pan drift. LFO sweeps panner.positionX across
  // a ±5-unit range centred on the original placement x, with a random
  // 40–90 s period. Listener subconsciously tracks the drift, which
  // prevents the drone from feeling like a fixed point in space.
  //
  // Tone.Signal connect overrides the AudioParam, so the LFO's min/max
  // are absolute target values — the original position[0] passed to the
  // Panner3D constructor gets wiped and replaced by the LFO output. We
  // encode the placement x as the CENTRE of the LFO range so the
  // perceived placement stays anchored where the bridge originally
  // chose; the drift is symmetrical motion around that anchor.
  //
  // Random phase per drone instance — multiple drones don't pan in sync.
  // Random period within the 40–90 s window also helps decorrelate.
  //
  // Only drone gets this. Other layers either don't sustain long enough
  // to benefit (bell/drip/glitch are transient) or have positional
  // identity tied to their placement (texture/chord/breath are
  // "localised atmosphere" — moving them would make the placement
  // visualisation drift away from the audio source).
  let panLfo: Tone.LFO | null = null;
  if (isOmnipresent) {
    panLfo = new Tone.LFO({
      frequency: 1 / (40 + Math.random() * 50), // 40–90 s
      min: position[0] - 5,
      max: position[0] + 5,
      type: 'sine',
      phase: Math.random() * 360,
    });
    panLfo.connect(panner.positionX);
    panLfo.start();
  }

  return {
    id: layerId,
    type,
    freq: preset.freq,
    dispose: () => {
      preset.dispose();
      window.setTimeout(() => {
        try {
          if (panLfo) panLfo.stop().dispose();
          panner.dispose();
        } catch {
          /* already disposed */
        }
      }, 3000);
    },
  };
}
