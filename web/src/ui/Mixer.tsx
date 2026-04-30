import { LAYER_TYPES, useSession } from '../state/useSession';
import type { LayerType } from '../state/useSession';
import { setLayerVolume } from '../audio/engine';

/**
 * Mini-EQ — left side of the screen during play. Nine vertical faders, one
 * per layer type, each driving the matching per-type bus in the audio engine.
 *
 * Why CSS `transform: rotate(-90deg)` instead of `writing-mode: vertical-lr`
 * or `appearance: slider-vertical`: the modern way still has gaps in older
 * Chromium and the legacy `slider-vertical` is non-standard and silently
 * collapses to a 16×100 *horizontal* slider in some builds (the slider
 * disappears off the screen). Rotating a normal horizontal range slider works
 * everywhere and ships a guaranteed 100×16 vertical fader.
 *
 * State of truth: useSession.layerVolumes. The setter both updates the store
 * (so the slider stays in sync after re-renders) and pokes setLayerVolume on
 * the engine, which ramps the bus gain over 50ms to avoid clicks. Range 0..1.5
 * — slightly above unity so the player can boost a single layer above the
 * default mix without touching others.
 */

const colors: Record<LayerType, string> = {
  drone: '#8aa1b3',
  texture: '#aab0a8',
  pulse: '#cc5d4d',
  glitch: '#7be0d4',
  breath: '#d4a098',
  bell: '#e8c97a',
  drip: '#7eb6d6',
  swell: '#9f7eb8',
  chord: '#d4c8a8',
};

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
        padding: '12px 12px 10px',
        background: 'rgba(5,5,7,0.55)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 2,
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
      }}
    >
      <div
        style={{
          fontSize: 9,
          letterSpacing: '0.35em',
          color: '#9a958c',
          textAlign: 'center',
          marginBottom: 10,
        }}
      >
        MIX
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
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
  const color = colors[type];
  const muted = value < 0.02;
  const pct = Math.round(value * 100);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        width: 28,
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
            accentColor: muted ? '#3a3a3e' : color,
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
          color: muted ? '#3a3a3e' : color,
          fontWeight: 600,
        }}
      >
        {SHORT[type]}
      </span>
      <span
        style={{
          fontSize: 8,
          letterSpacing: '0.05em',
          color: muted ? '#3a3a3e' : '#9a958c',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {pct}
      </span>
    </div>
  );
}
