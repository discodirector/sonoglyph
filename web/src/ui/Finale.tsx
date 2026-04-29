import { useSession } from '../state/useSession';

/**
 * Finale screen — shown after the final layer (MAX_LAYERS).
 *
 * Layout: heading on top, glyph centered (its 32×16 monospace block is the
 * focal point), 3-paragraph journal below in a constrained column, footer
 * credit at the bottom. The bridge guarantees the journal is ≤520 chars
 * (see clampJournal in proxy/src/kimi.ts), so we can afford a fixed
 * non-scrolling viewport here.
 */
export function Finale() {
  const artifact = useSession((s) => s.artifact);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 28,
        padding: '40px 24px',
        pointerEvents: 'auto',
        color: '#d8d4cf',
        background:
          'linear-gradient(to bottom, rgba(5,5,7,0.4) 0%, rgba(5,5,7,0.92) 100%)',
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: '0.3em',
          color: '#6a6660',
        }}
      >
        DESCENT COMPLETE
      </div>

      {!artifact ? (
        <div
          style={{
            color: '#a09d99',
            fontStyle: 'italic',
            fontSize: 14,
          }}
        >
          the cave is composing the record…
        </div>
      ) : (
        <>
          {/* Glyph — the central artifact. Self-contained 32×16 block, so
              we render it inside its own flex item to keep the centering
              robust even if the journal below is short. */}
          <pre
            style={{
              margin: 0,
              fontFamily: 'ui-monospace, Menlo, monospace',
              fontSize: 14,
              lineHeight: 1.05,
              color: '#c9885b',
              letterSpacing: '0.05em',
              whiteSpace: 'pre',
              textAlign: 'center',
            }}
          >
            {artifact.glyph}
          </pre>

          {/* Journal — short prose, max 3 paragraphs of 2-3 sentences.
              Fixed maxWidth so line-length stays comfortable. */}
          <div
            style={{
              maxWidth: 540,
              fontSize: 13,
              lineHeight: 1.7,
              fontStyle: 'italic',
              color: '#d8d4cf',
              textAlign: 'center',
              whiteSpace: 'pre-wrap',
            }}
          >
            {artifact.journal}
          </div>

          <div
            style={{
              fontSize: 10,
              letterSpacing: '0.25em',
              color: '#6a6660',
              marginTop: 4,
            }}
          >
            {artifact.generatedBy === 'kimi'
              ? 'TRANSCRIBED BY KIMI'
              : 'OFFLINE TRANSCRIPT'}
          </div>
        </>
      )}
    </div>
  );
}
