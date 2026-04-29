import { useSession } from '../state/useSession';

/**
 * Finale screen — shown after the 35th layer.
 *
 * Displays the Kimi-generated journal + ASCII glyph. If Kimi hasn't
 * responded yet (artifact === null), shows a "the cave is composing…"
 * placeholder until the bridge re-broadcasts `finished` with the
 * artifact attached.
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
        gap: 24,
        padding: '40px 24px',
        pointerEvents: 'auto',
        color: '#d8d4cf',
        background:
          'linear-gradient(to bottom, rgba(5,5,7,0.4) 0%, rgba(5,5,7,0.92) 100%)',
        overflow: 'auto',
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
          <pre
            style={{
              margin: 0,
              fontFamily: 'ui-monospace, Menlo, monospace',
              fontSize: 14,
              lineHeight: 1.05,
              color: '#c9885b',
              letterSpacing: '0.05em',
              whiteSpace: 'pre',
            }}
          >
            {artifact.glyph}
          </pre>
          <p
            style={{
              maxWidth: 560,
              fontSize: 14,
              lineHeight: 1.7,
              fontStyle: 'italic',
              color: '#d8d4cf',
              textAlign: 'left',
              whiteSpace: 'pre-wrap',
              margin: 0,
            }}
          >
            {artifact.journal}
          </p>
          <div
            style={{
              fontSize: 10,
              letterSpacing: '0.25em',
              color: '#6a6660',
              marginTop: 8,
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
