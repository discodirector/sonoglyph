import { useState } from 'react';
import { LAYER_TYPES, useSession } from '../state/useSession';
import type { LayerType } from '../state/useSession';
import { setLayerVolume } from '../audio/engine';

/**
 * Volume mixer — open by default at the start of a descent so the player
 * sees the controls immediately (they had been hiding behind a button
 * which made first-time players miss them entirely). The toggle still
 * works, so anyone who finds the panel distracting can collapse it.
 * Sits above the cooldown bar so it doesn't cover the preset palette.
 *
 * Visually deliberately quiet: two grays, no border. Colour info is already
 * carried by the orbs and the bottom palette, so the mixer doesn't need to
 * repeat it.
 *
 * Why CSS `transform: rotate(-90deg)` for the faders instead of
 * `writing-mode: vertical-lr` or `appearance: slider-vertical`: the modern
 * way still has gaps in older Chromium and the legacy `slider-vertical`
 * silently collapses to a 16×100 *horizontal* slider in some builds.
 * Rotating a normal horizontal range slider works everywhere.
 *
 * State of truth: useSession.layerVolumes. Setter updates the store and
 * pokes setLayerVolume on the engine, which ramps the bus gain over 50ms.
 * Open/closed state is local to this component — no need to persist; the
 * volumes themselves do persist across toggles.
 */

// Two grays from the project palette. TRACK paints the slider accent;
// LABEL is for the type abbreviation, the percent readout, and the "MIX"
// header. Muted channels just dim via opacity — no third colour needed.
const TRACK_GRAY = '#aab0a8';
const LABEL_GRAY = '#6a6660';

// 3-letter abbreviations so columns stay narrow. Full type name appears
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
  // Panel starts OPEN so first-time players see the faders without
  // having to hunt for the toggle. They can still collapse it via the
  // bottom-left "MIXER" button — local state means the choice persists
  // across re-renders within the session but resets on reload.
  const [open, setOpen] = useState(true);

  if (phase !== 'playing') return null;

  return (
    <>
      {/* Panel — always mounted so we can animate the transition. When
          closed: faded out + nudged downward + pointer-events disabled so
          it doesn't catch clicks invisibly. Bottom 90px clears the
          ~74px-tall bottom palette and the 14px top-padding above the
          cooldown bar. */}
      <div
        style={{
          position: 'fixed',
          // Aligned with the left edge of the cooldown bar inside the bottom
          // palette (which has horizontal padding 24). The button below
          // shares this offset so the two stack as a clean column under
          // the loading line.
          left: 24,
          bottom: 90,
          zIndex: 20,
          pointerEvents: open ? 'auto' : 'none',
          opacity: open ? 1 : 0,
          transform: open ? 'translateY(0)' : 'translateY(8px)',
          transition: 'opacity 180ms ease, transform 180ms ease',
          color: '#d8d4cf',
          padding: '10px 10px 8px',
          background: 'rgba(5,5,7,0.72)',
          backdropFilter: 'blur(3px)',
          WebkitBackdropFilter: 'blur(3px)',
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
        {/* gap: 3 — neighbouring centres land 27px apart without label
            collisions. */}
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

      {/* Toggle button — bottom-left corner, height matches the preset
          palette row. Higher z-index than the panel so it stays clickable
          if the panel ever expands over it. */}
      <button
        onClick={() => setOpen((o) => !o)}
        title="Volume mixer"
        style={{
          position: 'fixed',
          left: 24,
          bottom: 28,
          zIndex: 21,
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          background: open ? LABEL_GRAY : 'transparent',
          color: open ? '#050507' : '#d8d4cf',
          border: `1px solid ${open ? LABEL_GRAY : '#3a3a3e'}`,
          letterSpacing: '0.15em',
          fontSize: 11,
          textTransform: 'uppercase',
          cursor: 'pointer',
          transition: 'background 120ms ease, color 120ms ease',
          fontFamily: 'inherit',
        }}
      >
        <span>MIXER</span>
        <span
          style={{
            fontSize: 9,
            display: 'inline-block',
            transition: 'transform 180ms ease',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        >
          ▲
        </span>
      </button>
    </>
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
