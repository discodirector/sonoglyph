import { useEffect } from 'react';

/**
 * Onboarding screen — sits between BEGIN (audio init + recording start)
 * and the actual descent (`hello` sent to bridge, phase → 'playing').
 *
 * Why this isn't gated on a phase value: the server's notion of `phase`
 * flips to 'playing' the moment we send `hello`, which kicks off the
 * camera descent and the agent's first wait_for_my_turn loop. We want
 * the player to read the rules WITHOUT the world advancing under them,
 * so the gating is purely client-side. App.tsx holds a
 * `showOnboarding` boolean that turns this on after BEGIN and turns it
 * off (along with calling beginLocal + sending hello) when the player
 * hits Enter here.
 *
 * Styling follows Intro's vocabulary: muted greys, the same #c9885b
 * orange accent for section labels, IBM Plex Mono via the global CSS.
 * The "PRESS ENTER" prompt at the bottom uses the existing
 * sg-hint-pulse keyframe (defined in styles.css, ~2.4 s breathing
 * period) so it pulses calmly rather than strobing.
 */
export function Onboarding({ onContinue }: { onContinue: () => void }) {
  // Enter (and Space, as a courtesy for trackpad-only laptops where the
  // Enter key is awkwardly tucked) advances. We listen on window so the
  // player doesn't have to focus anything first — they just hit the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onContinue();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onContinue]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        pointerEvents: 'auto',
        color: '#d8d4cf',
        background: 'rgba(5,5,7,0.92)',
      }}
    >
      <div
        style={{
          minHeight: '100%',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          // Bottom padding leaves clearance for the absolutely-positioned
          // "PRESS ENTER" prompt so the last paragraph doesn't crowd it
          // on shorter viewports.
          padding: '48px 24px 120px',
          gap: 28,
          textAlign: 'center',
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 13,
            fontWeight: 400,
            letterSpacing: '0.45em',
            color: '#6a6660',
            textTransform: 'uppercase',
          }}
        >
          How this works
        </h2>

        <p
          style={{
            margin: 0,
            maxWidth: 540,
            fontSize: 15,
            lineHeight: 1.7,
            color: '#d8d4cf',
            fontStyle: 'italic',
          }}
        >
          You and your Hermes agent are sculpting an ambient track together,
          one tone at a time.
        </p>

        <div
          style={{
            width: '100%',
            maxWidth: 540,
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
            textAlign: 'left',
          }}
        >
          <Section
            label="The loop"
            body={
              <>
                You move first. Pick one of 9 presets from the palette, then
                click anywhere in the empty space — an orb lands and you
                hear it. Your Hermes answers on its turn.{' '}
                <em style={{ color: '#a09d99' }}>
                  10 seconds of cooldown between every move.
                </em>
              </>
            }
          />

          <Section
            label="The end"
            body={
              <>
                15 layers total. When the descent finishes you can mint the
                track as a generative NFT on{' '}
                <strong style={{ color: '#d8d4cf', fontWeight: 500 }}>
                  Monad
                </strong>
                . Gas is on Sonoglyph —{' '}
                <em style={{ color: '#a09d99' }}>
                  no wallet connection required.
                </em>
              </>
            }
          />

          <Section
            label="If your Hermes goes quiet"
            // Red accent (matches the Troubleshoot label on the Intro
            // screen) so this section reads as "fallback path", not as
            // another step in the happy flow.
            labelColor="#c95b5b"
            body={
              <>
                Just tell it{' '}
                <span
                  style={{
                    fontFamily: 'inherit',
                    background: 'rgba(255,255,255,0.06)',
                    padding: '1px 6px',
                    border: '1px solid #2a2a2e',
                    borderRadius: 3,
                  }}
                >
                  make a move
                </span>{' '}
                in the terminal where the Hermes chat is running. Some
                installs hesitate between tool calls; a nudge wakes them up.
              </>
            }
          />
        </div>
      </div>

      {/* PRESS ENTER prompt — pinned to the bottom-center of the
          viewport (not the inner column) so it stays put even when the
          content is short. Uses the existing sg-hint-pulse keyframe
          for a slow breathing fade. */}
      <div
        style={{
          position: 'fixed',
          left: '50%',
          bottom: 36,
          transform: 'translateX(-50%)',
          fontSize: 12,
          letterSpacing: '0.35em',
          color: '#c9885b',
          textTransform: 'uppercase',
          animation: 'sg-hint-pulse 2.4s ease-in-out infinite',
          pointerEvents: 'none',
        }}
      >
        ⏎  Press Enter to continue
      </div>
    </div>
  );
}

function Section({
  label,
  body,
  labelColor = '#c9885b',
}: {
  label: string;
  body: React.ReactNode;
  /**
   * Color applied to the all-caps section label. Defaults to the
   * #c9885b orange used for instruction labels on the Intro screen,
   * so the onboarding feels visually continuous with what the player
   * just came from. Pass a different color (e.g. #c95b5b red) for
   * fallback / warning sections.
   */
  labelColor?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: '0.3em',
          color: labelColor,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.7,
          color: '#d8d4cf',
        }}
      >
        {body}
      </div>
    </div>
  );
}
