import { LAYER_TYPES, useSession } from '../state/useSession';
import type { LayerType } from '../state/useSession';
import { setLayerVolume } from '../audio/engine';

/**
 * Mini-EQ — left side of the screen during play. Nine vertical faders, one
 * per layer type, each driving the matching per-type bus in the audio engine.
 *
 * Visually deliberately quiet: two grays, no border, tight spacing — the EQ
 * should be reachable but never compete with the orbs for attention. Colour
 * info is already carried by the orbs themselves and by the bottom palette,
 * so the mixer doesn't need to repeat it.
 *
 * Why CSS `transform: rotate(-90deg)` instead of `writing-mode: vertical-lr`
 * or `appearance: slider-vertical`: the modern way still has gaps in older
 * Chromium and the legacy `slider-vertical` is non-standard and silently
 * collapses to a 16×100 *horizontal* slider in some builds. Rotating a normal
 * horizontal range slider works everywhere.
 *
 * State of truth: useSession.layerVolumes. The setter both updates the store
 * and pokes setLayerVolume on the engine, which ramps the bus gain over 50ms.
 */

// Two grays from the project palette. TRACK paints the slider accent (track
// + thumb); LABEL is for the type abbreviation, the percent readout, and the
// "MIX" header. Muted channels just dim via opacity — we don't introduce a
// third colour for that state.
const TRACK_GRAY = '#aab0a8';
const LABEL_GRAY = '#6a6660';

// 3-letter abbreviations so the column stays narrow. Full type name appears
// in the slider's title attribute (native tooltip on hover).
const SHORT: Record<LayerType, string> = {
  drone: 'DRO',
  texture: 'TEX',
  pulse: 'PUL',
  glitch: 'GLI',
  breath: 'BRE',
  bell: 'BEL',
  drip: 'DRP',
  swell: 'SWL',
  chord: 'CHO',
};

const FADER_HEIGHT = 110;
const FADER_THICKNESS = 18;

export function Mixer() {
  const phase = useSession((s) => s.phase);
  const volumes = useSession((s) => s.layerVolumes);
  const setVol = useSession((s) => s.setLayerVolume);

  if (phase !== 'playing') return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: 16,
        top: '50%',
        transform: 'translateY(-50%)',
        // Explicit z-index so we always paint above the R3F <canvas>
        // (which is also `position: fixed; inset: 0`) and the Hud's
        // mixBlendMode container.
        zIndex: 20,
        pointerEvents: 'auto',
        color: '#d8d4cf',
        padding: '10px 10px 8px',
        background: 'rgba(5,5,7,0.55)',
        // Border removed — the panel reads as a soft dark patch, not a
        // framed box.
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
      }}
    >
      <div
        style={{
          fontSize: 9,
          letterSpacing: '0.35em',
          color: LABEL_GRAY,
          textAlign: 'center',
          marginBottom: 8,
        }}
      >
        MIX
      </div>
      {/* gap: 3 (down from 6) — half the previous spacing without letting
          the labels under each fader collide. Column width is 24, so neighbour
          centres land 27px apart. */}
      <div style={{ display: 'flex', gap: 3 }}>
        {LAYER_TYPES.map((t) => (
          <Channel
            key={t}
            type={t}
            value={volumes[t] ?? 1}
            onChange={(v) => {
              setVol(t, v);
              setLayerVolume(t, v);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function Channel({
  type,
  value,
  onChange,
}: {
  type: LayerType;
  value: number;
  onChange: (v: number) => void;
}) {
  const muted = value < 0.02;
  const pct = Math.round(value * 100);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 5,
        width: 24,
        opacity: muted ? 0.4 : 1,
        transition: 'opacity 150ms ease',
      }}
    >
      {/* Wrapper reserves the rotated bounding box: fader is laid out as a
          regular horizontal range, then rotated -90° around its center. */}
      <div
        style={{
          position: 'relative',
          width: FADER_THICKNESS,
          height: FADER_HEIGHT,
        }}
      >
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          title={`${type} — ${pct}%`}
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: FADER_HEIGHT,
            height: FADER_THICKNESS,
            transform: 'translate(-50%, -50%) rotate(-90deg)',
            transformOrigin: 'center',
            accentColor: TRACK_GRAY,
            cursor: 'pointer',
            background: 'transparent',
            margin: 0,
          }}
        />
      </div>
      <span
        style={{
          fontSize: 8,
          letterSpacing: '0.1em',
          color: LABEL_GRAY,
          fontWeight: 600,
        }}
      >
        {SHORT[type]}
      </span>
      <span
        style={{
          fontSize: 8,
          letterSpacing: '0.05em',
          color: LABEL_GRAY,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {pct}
      </span>
    </div>
  );
}
