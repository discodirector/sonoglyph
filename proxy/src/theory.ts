/**
 * Music theory helpers — scales, intents, frequency calc.
 *
 * Why this module exists: every descent picks a single key + mode at session
 * creation time. All layer frequencies (player and agent) are then snapped
 * to that scale's pitches. Two descents in different keys sound distinctly
 * different even when they reach for the same layer types in the same
 * order. Within a session the shared key glues drone + bell + chord into a
 * coherent palette instead of three unrelated random pitches.
 *
 * Modes are deliberately broader than just major/minor — Phrygian/Locrian
 * give us the dark/unstable colors Sonoglyph leans into, Lydian gives us a
 * rare bright/strange descent. Each mode carries a one-line "feel" that's
 * handed to Hermes so it can choose its layers with the mood in mind.
 *
 * Pure functions, no I/O, no shared mutable state. RNG is injectable so
 * tests can pin a specific scale; in production we just default to
 * Math.random.
 */

import type { LayerType } from './protocol.js';

export type ScaleMode =
  | 'aeolian'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'locrian'
  | 'harmonicMinor'
  | 'pentatonicMinor';

/**
 * Compositional intent the agent passes on each place_layer call. Maps
 * to a scale degree, biasing the pitch toward dissonant or consonant
 * positions within the descent's key. Optional — when absent we pick a
 * "comfortable" degree weighted toward root + fifth.
 */
export type Intent = 'tension' | 'release' | 'color' | 'emphasis' | 'hush';

export const INTENT_VALUES: Intent[] = [
  'tension',
  'release',
  'color',
  'emphasis',
  'hush',
];

interface ModeDef {
  /** Semitone offsets from root. `[0,2,3,5,7,8,10]` = natural minor. */
  intervals: number[];
  name: string;
  /** One-line description shown to the agent + stored in session info. */
  feel: string;
}

const MODES: Record<ScaleMode, ModeDef> = {
  aeolian: {
    intervals: [0, 2, 3, 5, 7, 8, 10],
    name: 'Aeolian',
    feel: 'classic minor — melancholy, settled, familiar',
  },
  dorian: {
    intervals: [0, 2, 3, 5, 7, 9, 10],
    name: 'Dorian',
    feel: 'minor with a softened sixth — pensive but not despairing',
  },
  phrygian: {
    intervals: [0, 1, 3, 5, 7, 8, 10],
    name: 'Phrygian',
    feel: 'dark, eastern, restless — flat second pulls everything toward unease',
  },
  lydian: {
    intervals: [0, 2, 4, 6, 7, 9, 11],
    name: 'Lydian',
    feel: 'bright but strange — raised fourth gives a floating, unresolved quality',
  },
  mixolydian: {
    intervals: [0, 2, 4, 5, 7, 9, 10],
    name: 'Mixolydian',
    feel: 'major-ish but earthy — flat seventh keeps it grounded, folkloric',
  },
  locrian: {
    intervals: [0, 1, 3, 5, 6, 8, 10],
    name: 'Locrian',
    feel: 'unstable, hollow — diminished fifth refuses to resolve',
  },
  harmonicMinor: {
    intervals: [0, 2, 3, 5, 7, 8, 11],
    name: 'Harmonic Minor',
    feel: 'minor with a leading-tone bite — exotic, narrow tension',
  },
  pentatonicMinor: {
    intervals: [0, 3, 5, 7, 10],
    name: 'Pentatonic Minor',
    feel: 'minor with no half-steps — gamelan-clean, every interval lands',
  },
};

const ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface SessionScale {
  /** Pitch class 0..11 (0=C). */
  rootPc: number;
  rootName: string;
  mode: ScaleMode;
  modeName: string;
  feel: string;
  /** Semitone offsets from the root. */
  intervals: number[];
}

/**
 * Pick a random scale. 12 roots × 8 modes = 96 distinct starting points
 * per descent. RNG is injectable for testability.
 */
export function pickSessionScale(rng: () => number = Math.random): SessionScale {
  const rootPc = Math.floor(rng() * 12);
  const modeKeys = Object.keys(MODES) as ScaleMode[];
  const mode = modeKeys[Math.floor(rng() * modeKeys.length)];
  const def = MODES[mode];
  return {
    rootPc,
    rootName: ROOT_NAMES[rootPc],
    mode,
    modeName: def.name,
    feel: def.feel,
    intervals: def.intervals.slice(),
  };
}

/** MIDI note number → frequency. A4 (MIDI 69) = 440 Hz. */
function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Frequency for (octave, scale degree). Octave follows the C4 = MIDI 60
 * convention (so C4 ≈ 261.6 Hz). `degreeIndex` wraps within the scale's
 * length, so degree 0 = root, degree 7 = root one octave up if the scale
 * has 7 notes, etc.
 */
export function freqAt(
  scale: SessionScale,
  octave: number,
  degreeIndex: number,
): number {
  const len = scale.intervals.length;
  const wrapped = ((degreeIndex % len) + len) % len;
  const semitone = scale.intervals[wrapped];
  const midi = 12 * (octave + 1) + scale.rootPc + semitone;
  return midiToFreq(midi);
}

/**
 * Octave preferences per layer type. Drone sits low, bell high, etc.
 * Returning an array lets the picker randomize within the type's home
 * range so two drones in the same descent aren't necessarily the same
 * octave.
 *
 * Drone and chord are pinned to a single octave on purpose. The earlier
 * two-octave ranges ([1,2] and [2,3]) let scale + leading-tone
 * combinations push drone up to ~233 Hz fundamental and chord up to ~466
 * Hz — at those pitches the drone's saw harmonics ring through the LP
 * filter sweep (with Q resonance making the upper harmonics buzz), and
 * the chord's octave voice (root × 2) reaches ~933 Hz where it stops
 * blending and starts cutting. Pinning drone to oct 1 keeps the
 * fundamental at 33–93 Hz (root or fifth only — see pickFreqForLayer),
 * and chord to oct 2 keeps root at 65–233 Hz with the octave voice
 * still under 470 Hz — both back inside the "harmonic floor / mid pad"
 * identities the engine expects.
 */
function preferredOctaves(type: LayerType): number[] {
  switch (type) {
    case 'drone':
      return [1];
    case 'pulse':
      return [2, 3];
    case 'chord':
      return [2]; // chord build adds 5 + octave on top inside the engine
    case 'breath':
      return [3, 4];
    case 'bell':
      return [4, 5];
    case 'drip':
      return [5, 6];
    case 'swell':
      return [3, 4];
    case 'texture':
      return [4];
    case 'glitch':
      return [5, 6];
  }
}

/**
 * Map an intent to a set of candidate scale degrees, intersected with what
 * the scale actually has. Falls back to the root if no candidate matches.
 *
 *   tension  — ♭2 (semitone 1), tritone (6), leading tone (11).
 *   release  — root, fifth.
 *   color    — ♭6, 6th, 9th — coloration without a strong pull.
 *   emphasis — third — defines whether the mode reads as major or minor.
 *   hush     — root only.
 */
function pickDegreeForIntent(
  scale: SessionScale,
  intent: Intent | undefined,
  rng: () => number,
): number {
  const findDeg = (semis: number): number => scale.intervals.indexOf(semis);
  const has = (semis: number): boolean => findDeg(semis) >= 0;

  let candidates: number[] = [];
  switch (intent) {
    case 'tension':
      candidates = [findDeg(1), findDeg(6), findDeg(11)].filter((d) => d >= 0);
      break;
    case 'release':
      candidates = [0, findDeg(7)].filter((d) => d >= 0);
      break;
    case 'color':
      candidates = [findDeg(8), findDeg(9), findDeg(2)].filter((d) => d >= 0);
      break;
    case 'emphasis':
      candidates = [findDeg(3), findDeg(4)].filter((d) => d >= 0);
      break;
    case 'hush':
      candidates = [0];
      break;
    default:
      // No-intent path (player, or agent skipping the field): consonant
      // weighted with some color. Root + fifth get double weight.
      candidates = [0, 0];
      if (has(7)) candidates.push(findDeg(7), findDeg(7));
      if (has(3)) candidates.push(findDeg(3));
      if (has(4)) candidates.push(findDeg(4));
      if (has(5)) candidates.push(findDeg(5));
      if (has(9)) candidates.push(findDeg(9));
      break;
  }
  if (candidates.length === 0) candidates = [0];
  return candidates[Math.floor(rng() * candidates.length)];
}

/**
 * One-call freq picker combining scale + type + intent. This is the only
 * function callers in game.ts need.
 *
 * `hush` is special-cased to the lowest available octave for the type with
 * the root note — useful for the agent to anchor a quiet section.
 *
 * `drone` ignores intent entirely and is pinned to root or fifth. Drone's
 * job is to anchor the descent's harmonic floor; tension/color/emphasis on
 * a 33 Hz sub doesn't read musically, and letting drone wander up the
 * scale loses its identity (and pushes saw harmonics into unpleasant
 * resonance bands). Intent still drives the other 8 layer types where
 * pitch motion is a feature, not a bug.
 */
export function pickFreqForLayer(
  scale: SessionScale,
  type: LayerType,
  intent: Intent | undefined,
  rng: () => number = Math.random,
): number {
  const octs = preferredOctaves(type);
  if (intent === 'hush') {
    return freqAt(scale, octs[0], 0);
  }
  if (type === 'drone') {
    const fifthDeg = scale.intervals.indexOf(7);
    const droneDegrees = fifthDeg >= 0 ? [0, fifthDeg] : [0];
    const oct = octs[Math.floor(rng() * octs.length)];
    const deg = droneDegrees[Math.floor(rng() * droneDegrees.length)];
    return freqAt(scale, oct, deg);
  }
  const oct = octs[Math.floor(rng() * octs.length)];
  const deg = pickDegreeForIntent(scale, intent, rng);
  return freqAt(scale, oct, deg);
}

/** Human-readable scale label used in agent prompts and logs. */
export function describeScale(scale: SessionScale): string {
  return `${scale.rootName} ${scale.modeName} — ${scale.feel}`;
}

export const INTENT_DESCRIPTIONS: Record<Intent, string> = {
  tension: '♭2 / tritone / leading tone — pulls toward unease, suspends resolution',
  release: 'root or fifth — settles, breathes out',
  color: '♭6 / 6th / 9th — coloration without strong pull',
  emphasis: 'the third — establishes the mode\'s character',
  hush: 'low root only — quiet anchor near the floor of the layer\'s range',
};
