import { useEffect, useState } from 'react';
import { useSession } from '../state/useSession';

/**
 * Full-screen blocking overlay shown when the user requested a shared
 * Hermes agent but all spawn slots are taken. The bridge has placed
 * their session in a FIFO queue (`sharedAgent.status === 'queued'`)
 * and will spawn for them as soon as a slot frees.
 *
 * Auto-dismisses the moment status leaves 'queued' — either 'spawning'
 * (slot opened) or 'failed' (rejection). The parent (Intro) handles
 * those states inline.
 *
 * Design: darkened blurred backdrop over the entire viewport, blinking
 * centred line. Deliberately minimal — the player has nothing to do
 * here but wait, and a single readable beat ("X players ahead of you,
 * please wait") respects that.
 */
export function SharedAgentOverlay() {
  const status = useSession((s) => s.sharedAgent.status);
  const position = useSession((s) => s.sharedAgent.position);

  if (status !== 'queued') return null;

  return (
    <div
      // Highest z-index of the UI layer — the overlay must sit above the
      // Intro pairing panel AND the external-links rail (which is z=2),
      // AND keep its own contents clickable for any future "cancel queue"
      // button while blocking clicks to the underlying Intro.
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'rgba(5,5,7,0.94)',
        // Subtle blur so the dimmed Intro behind doesn't just go flat —
        // there's still a visual hint that the page hasn't crashed, it's
        // just gated.
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'auto',
      }}
    >
      {/* Inject the blink keyframes once. Doing it inline keeps the
          overlay self-contained — no need to thread global CSS through
          App.tsx for one animation. */}
      <style>
        {`
          @keyframes sg-blink {
            0%, 100% { opacity: 0.55; }
            50%      { opacity: 1; }
          }
          @keyframes sg-pulse-dot {
            0%, 100% { transform: scale(0.85); opacity: 0.4; }
            50%      { transform: scale(1.0);  opacity: 1.0; }
          }
        `}
      </style>
      <div
        style={{
          textAlign: 'center',
          maxWidth: 560,
          padding: '0 24px',
        }}
      >
        {/* Three pulsing dots above the title — a quiet "the system is
            alive, it's waiting on something" signal so the player doesn't
            second-guess whether the page is frozen. */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 10,
            marginBottom: 28,
          }}
        >
          <PulseDot delay={0} />
          <PulseDot delay={0.25} />
          <PulseDot delay={0.5} />
        </div>
        <div
          style={{
            fontSize: 14,
            letterSpacing: '0.42em',
            color: '#c9885b',
            textTransform: 'uppercase',
            marginBottom: 18,
            animation: 'sg-blink 2.2s ease-in-out infinite',
          }}
        >
          Please wait for your turn
        </div>
        <p
          style={{
            margin: 0,
            fontSize: 15,
            lineHeight: 1.7,
            color: '#d8d4cf',
            letterSpacing: '0.04em',
          }}
        >
          All shared agents are currently composing with other players.
          {position !== null && (
            <>
              <br />
              <ElapsedQueueLine position={position} />
            </>
          )}
        </p>
        <p
          style={{
            marginTop: 22,
            fontSize: 11,
            letterSpacing: '0.25em',
            color: '#6a6660',
            textTransform: 'uppercase',
          }}
        >
          You will join automatically when a slot opens
        </p>
      </div>
    </div>
  );
}

/**
 * The 1-based position is server-pushed via WS, so it can change at any
 * time without the user doing anything. We also show an elapsed-time
 * counter so the wait feels measured rather than open-ended — a player
 * who's been queued 3 minutes wants to know that, both to set expectations
 * and to decide whether to keep waiting.
 */
function ElapsedQueueLine({ position }: { position: number }) {
  // Reset the elapsed timer whenever `position` ticks down (someone ahead
  // finished) so the player sees "30s · #2" rather than "3m · #2" right
  // after a queue advance. The position prop itself is the right effect
  // dep — when it changes, we record a fresh anchor.
  const [anchor, setAnchor] = useState(() => Date.now());
  useEffect(() => {
    setAnchor(Date.now());
  }, [position]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const elapsedSec = Math.max(0, Math.floor((now - anchor) / 1000));
  const mm = Math.floor(elapsedSec / 60).toString();
  const ss = (elapsedSec % 60).toString().padStart(2, '0');
  return (
    <span style={{ color: '#a09d99' }}>
      You are <strong style={{ color: '#d8d4cf' }}>#{position}</strong> in
      line · waited{' '}
      <code
        style={{
          fontFamily: 'inherit',
          color: '#d8d4cf',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {mm}:{ss}
      </code>
    </span>
  );
}

function PulseDot({ delay }: { delay: number }) {
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: '#c9885b',
        display: 'inline-block',
        animation: `sg-pulse-dot 1.4s ease-in-out infinite`,
        animationDelay: `${delay}s`,
      }}
    />
  );
}
