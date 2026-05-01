import { useEffect, useState } from 'react';
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
// Each hint MUST stay on a single line at the cell's content width
// (~70 px @ 9 px font with 0.1em letter-spacing → ~12 chars). "high
// shimmer" used to wrap into two lines, which pushed AIR's label up
// relative to GLOW/DEEP because the cells are flex-justify-between
// (label sits between the top dot and the bottom hint).
const PAD_HINT: Record<PadId, string> = {
  glow: 'warm body',
  air: 'shimmer',
  deep: 'deep sub',
};

export function Pads() {
  const phase = useSession((s) => s.phase);
  const scale = useSession((s) => s.scale);
  const padsActive = useSession((s) => s.padsActive);
  const setPadActive = useSession((s) => s.setPadActive);
  // Panel starts OPEN — same reasoning as Mixer: first-time players
  // were missing the pads entirely because they were hidden behind
  // a button. They can still collapse the panel via the toggle.
  const [open, setOpen] = useState(true);

  // Onboarding hint that points at the pads panel ~20 s into the
  // descent if the player hasn't engaged any pad yet. Three pieces
  // of state because the lifecycle has three distinct events:
  //   - hintArmed: 20 s timer fired, hint is allowed to render
  //   - hintDismissed: player engaged a pad OR the hint timed out
  //                    after being visible — either way we never
  //                    show it again this session
  //   - the actual visibility derived from open && armed && !dismissed
  // We also track whether the panel was ever closed; if the player
  // closed it before 20 s elapsed they've clearly already discovered
  // the pads and don't need the nudge.
  const [hintArmed, setHintArmed] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(false);

  // 20 s arming timer — kicks off when phase enters 'playing'.
  useEffect(() => {
    if (phase !== 'playing') return;
    const t = window.setTimeout(() => setHintArmed(true), 20_000);
    return () => window.clearTimeout(t);
  }, [phase]);

  // Auto-dismiss after the hint has been visible for ~15 s. We don't
  // want it to linger forever if the player is busy with placement;
  // the arrow has done its job by then.
  useEffect(() => {
    if (!hintArmed || hintDismissed) return;
    const t = window.setTimeout(() => setHintDismissed(true), 15_000);
    return () => window.clearTimeout(t);
  }, [hintArmed, hintDismissed]);

  // Engaging any pad dismisses the hint immediately — the player
  // has clearly understood the prompt, no need for the arrow to
  // keep pointing.
  useEffect(() => {
    const anyActive = Object.values(padsActive).some(Boolean);
    if (anyActive) setHintDismissed(true);
  }, [padsActive]);

  if (phase !== 'playing') return null;

  // Pad button is enabled only once we have the scale. In practice the
  // scale arrives in the first state snapshot, well before the player
  // clicks Begin, so this guard only really fires on dev hot-reload.
  const ready = scale !== null;

  // Hint is gated on `open` — if the panel is already collapsed when
  // the timer fires, the player has actively dismissed pads and a
  // hand-drawn arrow into empty space would just look weird.
  const showHint = open && hintArmed && !hintDismissed;

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

      <PadsHint visible={showHint} />
    </>
  );
}

/**
 * One-shot onboarding hint that nudges the player toward the pads ~20 s
 * into the descent. Two animations stage the entrance:
 *
 *   1. Container fades in + slides 20 px to the left (700 ms).
 *   2. After a 200 ms hold, the arrow's stroke-dashoffset animates
 *      from full-length (invisible) to zero, "drawing" the arrow
 *      across 1.1 s. The arrowhead fades in last on a 300 ms tail
 *      so it caps the drawn line cleanly instead of appearing
 *      mid-stroke.
 *
 * pointerEvents: 'none' on the container — the hint is purely
 * decorative and must not eat clicks meant for the panel behind /
 * around it.
 */
function PadsHint({ visible }: { visible: boolean }) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (!visible) {
      setDrawn(false);
      return;
    }
    const t = window.setTimeout(() => setDrawn(true), 200);
    return () => window.clearTimeout(t);
  }, [visible]);

  return (
    <div
      style={{
        position: 'fixed',
        // Pads panel geometry (from the panel <div> style above):
        //   right: 24, bottom: 90, width ≈ 274 px (3 × 86 + 2 × 8),
        //   height ≈ 149 px (10 top-pad + 13 label + 8 gap + 110
        //   cell + 8 bottom-pad). So:
        //     panel top-LEFT corner ≈ (right: 298, bottom: 239).
        //
        // Hint anchored at (right: 290, bottom: 230) puts the SVG
        // arrow tip — at SVG-coords (168, 38) within a 180×50
        // canvas — at viewport (right: 302, bottom: 242). That's
        // ~4 px left and ~3 px above the panel's top-left corner,
        // which reads as "pointing AT the corner" (approaching from
        // upper-left, stopping just shy) rather than "stabbing
        // into the middle of the panel" which is what the previous
        // bottom: 110 produced.
        right: 290,
        bottom: 230,
        zIndex: 19,
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateX(0)' : 'translateX(20px)',
        transition: 'opacity 700ms ease, transform 700ms ease',
        maxWidth: 240,
        textAlign: 'right',
      }}
    >
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.5,
          color: '#c9885b',
          letterSpacing: '0.04em',
          fontStyle: 'italic',
          marginBottom: 6,
        }}
      >
        Play with the pads — turn one on for a few seconds, then another.
      </div>
      <svg
        width="180"
        height="50"
        viewBox="0 0 180 50"
        style={{ display: 'block', marginLeft: 'auto' }}
        aria-hidden="true"
      >
        {/* Curved shaft. strokeDasharray ≈ path length so dashoffset
            transitions cover the full draw distance; values larger
            than the actual length are fine (the path just stays
            invisible past offset=length). */}
        <path
          d="M 5 10 C 60 10, 100 38, 168 38"
          stroke="#c9885b"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          strokeDasharray="220"
          strokeDashoffset={drawn ? 0 : 220}
          style={{ transition: 'stroke-dashoffset 1100ms ease' }}
        />
        {/* Arrowhead — two short strokes meeting at the shaft's tip.
            Faded in after the shaft finishes drawing so it reads as
            "the line landed and the head pointed". */}
        <path
          d="M 168 38 L 158 32 M 168 38 L 158 44"
          stroke="#c9885b"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          opacity={drawn ? 1 : 0}
          style={{ transition: 'opacity 300ms ease 1000ms' }}
        />
      </svg>
    </div>
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
          // Prevent wrapping — a 2-line hint would push the title up and
          // misalign GLOW / AIR / DEEP across the row. If a future hint
          // ever overflows, it'll get clipped instead, which we'd see
          // immediately rather than silently breaking the layout.
          whiteSpace: 'nowrap',
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

