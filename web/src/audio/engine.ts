/**
 * Audio engine — Tone.js master + drone layer factory.
 *
 * Day 1: single drone preset (sawtooth + sub sine + lowpass + slow LFO sweep).
 * Day 2: 5 presets (drone / texture / pulse / glitch / breath), spatial pan,
 *        master MediaRecorder for session capture.
 */

import * as Tone from 'tone';

let initialized = false;
let master: Tone.Limiter;
let reverb: Tone.Reverb;

export async function initAudio(): Promise<void> {
  if (initialized) return;
  // Required by browser audio policy — must be called from a user gesture.
  await Tone.start();

  Tone.getDestination().volume.value = -6;
  master = new Tone.Limiter(-1).toDestination();

  reverb = new Tone.Reverb({ decay: 14, wet: 0.45 });
  await reverb.generate();
  reverb.connect(master);

  initialized = true;
}

export function isAudioReady(): boolean {
  return initialized;
}

export interface LayerHandle {
  id: string;
  freq: number;
  dispose: () => void;
}

// Sub-bass / low-mid drone fundamentals. Slightly detuned across layers
// produces natural beating that ambient music thrives on.
const FREQS = [55, 61.74, 65.41, 73.42, 82.41, 87.31, 98, 110];

export function addDroneLayer(): LayerHandle {
  if (!initialized) throw new Error('audio engine not initialized');

  const id = crypto.randomUUID();
  const freq = FREQS[Math.floor(Math.random() * FREQS.length)];
  const detune = (Math.random() - 0.5) * 14; // ±7 cents

  const osc = new Tone.Oscillator({ frequency: freq, type: 'sawtooth', detune });
  const sub = new Tone.Oscillator({ frequency: freq / 2, type: 'sine' });

  const filter = new Tone.Filter({ frequency: 320, type: 'lowpass', Q: 1.2 });
  const gain = new Tone.Gain(0);

  osc.connect(gain);
  sub.connect(gain);
  gain.connect(filter);
  filter.connect(master);
  filter.connect(reverb);

  // Slow filter sweep — the heartbeat of ambient.
  const lfo = new Tone.LFO({
    frequency: 0.04 + Math.random() * 0.06,
    min: 180,
    max: 900,
    type: 'sine',
  }).start();
  lfo.connect(filter.frequency);

  // Fade in.
  gain.gain.rampTo(0.16, 4);
  osc.start();
  sub.start();

  return {
    id,
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

/**
 * Map global descent depth (0..1000) to mood:
 *   - reverb wet rises
 *   - master tilt darkens (Day 2 will add a per-layer floor)
 */
export function setGlobalDepth(depth: number): void {
  if (!initialized) return;
  const t = Math.min(1, Math.max(0, depth / 1000));
  reverb.wet.rampTo(0.4 + t * 0.45, 1.5);
}
