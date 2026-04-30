import { useSession } from '../state/useSession';

/**
 * Finale screen — shown after the final layer (MAX_LAYERS).
 *
 * Layout: heading on top, glyph centered (its 32×16 monospace block is the
 * focal point), 3-paragraph journal below in a constrained column, footer
 * credit at the bottom. The bridge guarantees the journal is ≤520 chars
 * (see clampJournal in proxy/src/kimi.ts), so we can afford a fixed
 * non-scrolling viewport here.
 *
 * Below the credit we also surface the IPFS pinning status of the descent
 * recording. Three visible states:
 *   pending — "PRESERVING…" with a soft pulse, while the WebM uploads
 *   pinned  — "PRESERVED ON IPFS · <cid prefix>" with a gateway link
 *   error   — "PRESERVATION FAILED" + the truncated error text
 * Idle state is hidden — there's no useful signal before the outro fade
 * captures the blob.
 */
export function Finale() {
  const artifact = useSession((s) => s.artifact);
  const audioCid = useSession((s) => s.audioCid);
  const audioPinStatus = useSession((s) => s.audioPinStatus);
  const audioPinError = useSession((s) => s.audioPinError);

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

      <PinStatus
        status={audioPinStatus}
        cid={audioCid}
        error={audioPinError}
      />
    </div>
  );
}

/**
 * One-line status for the IPFS recording pin. Renders nothing while idle,
 * a quiet pulsing label while pending, the truncated CID + a gateway link
 * once pinned, or an error message on failure. Color register matches
 * the rest of the Finale (#6a6660 dim / #c9885b warm accent).
 */
function PinStatus({
  status,
  cid,
  error,
}: {
  status: 'idle' | 'pending' | 'pinned' | 'error';
  cid: string | null;
  error: string | null;
}) {
  if (status === 'idle') return null;

  const baseStyle: React.CSSProperties = {
    fontSize: 10,
    letterSpacing: '0.22em',
    color: '#6a6660',
    marginTop: 0,
    fontFamily: 'ui-monospace, Menlo, monospace',
  };

  if (status === 'pending') {
    return (
      <div
        style={{
          ...baseStyle,
          animation: 'sg-hint-pulse 2.4s ease-in-out infinite',
        }}
      >
        PRESERVING ON IPFS…
      </div>
    );
  }

  if (status === 'error') {
    const msg = error ?? 'unknown error';
    return (
      <div style={{ ...baseStyle, color: '#c97a5b' }}>
        PRESERVATION FAILED · {msg.slice(0, 80)}
      </div>
    );
  }

  // status === 'pinned'
  if (!cid) return null;
  const short = `${cid.slice(0, 8)}…${cid.slice(-6)}`;
  const gateway = `https://gateway.pinata.cloud/ipfs/${cid}`;
  return (
    <div style={baseStyle}>
      PRESERVED · CID&nbsp;
      <a
        href={gateway}
        target="_blank"
        rel="noreferrer"
        style={{ color: '#c9885b', textDecoration: 'none' }}
      >
        {short} ↗
      </a>
    </div>
  );
}
