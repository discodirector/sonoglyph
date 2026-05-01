import { useState } from 'react';
import { PAD_IDS, PAD_LABELS, useSession, type PadId } from '../state/useSession';
import { startPad, stopPad } from '../audio/engine';

/**
 * Pads panel — atmospheric "air" voices the player can engage in parallel
 * to the placed-layer composition. Mirrors {@link Mixer} structurally and
 * visually: same toggle-button shape, same backdrop-blurred panel above
 * it, same animated open/close. Lives on the *right* side of the cooldown
 * bar (where Mixer is on the left), so the two sit symmetrically under
 * the bottom palette.
 *
 * Pads are derived from `useSession.scale.intervals`: the engine pulls
 * the scale's third / fifth / 9th to build each voice, so two players
 * in different keys hear pads in their own tonality. A pad button is
 * disabled until the scale arrives in the first WS snapshot.
 *
 * State of truth: useSession.padsActive. Each toggle calls `setPadActive`
 * on the store and `startPad`/`stopPad` on the engine — the engine ramps
 * the voice in over ~4 s on start and out over ~3 s on stop, so click
 * latency feels like "the pad swelled up" rather than "the button lit".
 *
 * Three pads:
 *   GLOW — warm mid-range triad (root + third + fifth at oct 3 + sub).
 *   AIR  — high-register shimmer (root + fifth + ninth at oct 4–5).
 *   DEEP — sub foundation (sine sub at oct 1 + low root + fifth).
 */

const LABEL_GRAY = '#6a6660';
// Each pad uses a different accent so a glance at the panel tells you
// which one is engaged. Picked from outside the existing layer-color
// palette so they don't read as "one of the orb types".
const PAD_ACCENT: Record<PadId, string> = {
  glow: '#d4a070', // warm amber
  air: '#a8d4d0',  // pale cyan
  deep: '#8a78b0', // soft violet
};

// One-line description shown under each pad's title, so a player who
// doesn't know synth pad lingo still gets a sense of what each does.
const PAD_HINT: Record<PadId, string> = {
  glow: 'warm body',
  air: 'high shimmer',
  deep: 'deep sub',
};

export function Pads() {
  const phase = useSession((s) => s.phase);
  const scale = useSession((s) => s.scale);
  const padsActive = useSession((s) => s.padsActive);
  const setPadActive = useSession((s) => s.setPadActive);
  const [open, setOpen] = useState(false);

  if (phase !== 'playing') return null;

  // Pad button is enabled only once we have the scale. In practice the
  // scale arrives in the first state snapshot, well before the player
  // clicks Begin, so this guard only really fires on dev hot-reload.
  const ready = scale !== null;

  const togglePad = (id: PadId) => {
    if (!ready || !scale) return;
    const next = !padsActive[id];
    setPadActive(id, next);
    if (next) {
      startPad(id, scale);
    } else {
      stopPad(id);
    }
  };

  return (
    <>
      {/* Panel — same animation envelope as Mixer's. Right-anchored so the
          panel grows leftward from the toggle button, mirroring Mixer's
          left-anchored layout. */}
      <div
        style={{
          position: 'fixed',
          right: 24,
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
          PADS
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {PAD_IDS.map((id) => (
            <PadCell
              key={id}
              id={id}
              active={padsActive[id]}
              disabled={!ready}
              onToggle={() => togglePad(id)}
            />
          ))}
        </div>
      </div>

      {/* Toggle button — bottom-right corner, mirroring Mixer's bottom-left.
          Same vertical position (`bottom: 28`), same height, same border
          treatment. */}
      <button
        onClick={() => setOpen((o) => !o)}
        title="Atmospheric pads"
        style={{
          position: 'fixed',
          right: 24,
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
        <span>PADS</span>
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

function PadCell({
  id,
  active,
  disabled,
  onToggle,
}: {
  id: PadId;
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const accent = PAD_ACCENT[id];
  return (
    <button
      onClick={disabled ? undefined : onToggle}
      disabled={disabled}
      title={`${PAD_LABELS[id]} — ${PAD_HINT[id]}`}
      style={{
        // Cell size — wider than Mixer fader columns (24 px) so we can fit
        // the title + hint comfortably. Three cells × 86 + 2 × 8 gap = 274 px,
        // about the same overall width as the Mixer's 9-fader panel.
        width: 86,
        height: 110,
        padding: '10px 8px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: active ? `${accent}26` : 'transparent', // 26 = ~15% alpha
        border: `1px solid ${active ? accent : '#2a2a2e'}`,
        color: active ? accent : disabled ? '#3a3a3e' : '#d8d4cf',
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit',
        textTransform: 'uppercase',
        transition: 'background 180ms ease, border 180ms ease, color 180ms ease',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Dot ok={active} color={accent} />
      <span
        style={{
          fontSize: 12,
          letterSpacing: '0.25em',
          fontWeight: 500,
        }}
      >
        {PAD_LABELS[id]}
      </span>
      <span
        style={{
          fontSize: 9,
          letterSpacing: '0.1em',
          color: active ? accent : LABEL_GRAY,
          textTransform: 'lowercase',
          fontStyle: 'italic',
          opacity: 0.85,
        }}
      >
        {PAD_HINT[id]}
      </span>
    </button>
  );
}

function Dot({ ok, color }: { ok: boolean; color: string }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: ok ? color : 'transparent',
        border: `1px solid ${ok ? color : '#3a3a3e'}`,
        boxShadow: ok ? `0 0 10px ${color}88` : 'none',
        transition: 'background 200ms, box-shadow 200ms, border 200ms',
      }}
    />
  );
}

