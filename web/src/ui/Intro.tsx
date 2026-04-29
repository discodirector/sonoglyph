import { useState } from 'react';
import { useSession } from '../state/useSession';

/**
 * Intro / pairing screen.
 *
 * Shown until the player clicks Begin (and `agent_paired` has arrived).
 * Walks them through:
 *   1. Copy the printed `hermes mcp add … && hermes chat …` command
 *   2. Run it in WSL
 *   3. Wait for the green "AGENT PAIRED" indicator
 *   4. Begin descent
 */
export function Intro({ onBegin }: { onBegin: () => void }) {
  const pairing = useSession((s) => s.pairing);
  const agentConnected = useSession((s) => s.agentConnected);
  const proxyOk = useSession((s) => s.proxyOk);

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
        textAlign: 'center',
        padding: '32px 24px',
        pointerEvents: 'auto',
        color: '#d8d4cf',
      }}
    >
      <h1
        style={{
          letterSpacing: '0.45em',
          fontWeight: 300,
          fontSize: 30,
          margin: 0,
        }}
      >
        SONOGLYPH
      </h1>
      <p
        style={{
          maxWidth: 520,
          color: '#a09d99',
          fontStyle: 'italic',
          margin: 0,
          lineHeight: 1.6,
        }}
      >
        A descent. Place tones into the dark with your own Hermes — together,
        you compose the cave.
      </p>

      {!pairing ? (
        <p style={{ color: '#6a6660', fontSize: 12, letterSpacing: '0.2em' }}>
          {proxyOk === false ? 'BRIDGE OFFLINE' : 'OPENING BRIDGE…'}
        </p>
      ) : (
        <PairingPanel command={pairing.hermesCommand} code={pairing.code} />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <StatusDot ok={agentConnected} />
        <span
          style={{
            fontSize: 12,
            letterSpacing: '0.2em',
            color: agentConnected ? '#7be0d4' : '#6a6660',
          }}
        >
          {agentConnected ? 'AGENT PAIRED' : 'WAITING FOR YOUR HERMES…'}
        </span>
      </div>

      <button
        onClick={onBegin}
        disabled={!agentConnected}
        style={{
          marginTop: 8,
          padding: '12px 28px',
          letterSpacing: '0.3em',
          fontSize: 13,
          background: agentConnected ? '#d8d4cf' : 'transparent',
          color: agentConnected ? '#050507' : '#3a3a3e',
          border: `1px solid ${agentConnected ? '#d8d4cf' : '#3a3a3e'}`,
          cursor: agentConnected ? 'pointer' : 'default',
          textTransform: 'uppercase',
          transition: 'background 200ms, color 200ms, border 200ms',
        }}
      >
        Begin descent
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
function PairingPanel({ command, code }: { command: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Best-effort; user can still select-and-copy.
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        alignItems: 'center',
        maxWidth: 720,
        width: '100%',
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: '0.25em',
          color: '#6a6660',
        }}
      >
        DESCENT CODE
      </div>
      <div
        style={{
          fontSize: 28,
          letterSpacing: '0.4em',
          fontFamily: 'ui-monospace, Menlo, monospace',
          color: '#c9885b',
        }}
      >
        {code}
      </div>

      <div
        style={{
          marginTop: 8,
          fontSize: 11,
          letterSpacing: '0.2em',
          color: '#6a6660',
        }}
      >
        IN WSL — RUN
      </div>
      <pre
        style={{
          margin: 0,
          padding: '12px 16px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid #2a2a2e',
          borderRadius: 4,
          fontSize: 11,
          fontFamily: 'ui-monospace, Menlo, monospace',
          color: '#a09d99',
          textAlign: 'left',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          maxWidth: '100%',
          lineHeight: 1.6,
        }}
      >
        {command}
      </pre>
      <button
        onClick={onCopy}
        style={{
          padding: '6px 14px',
          fontSize: 10,
          letterSpacing: '0.25em',
          background: 'transparent',
          color: '#a09d99',
          border: '1px solid #3a3a3e',
          cursor: 'pointer',
          textTransform: 'uppercase',
        }}
      >
        {copied ? 'COPIED' : 'COPY'}
      </button>
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: ok ? '#7be0d4' : '#3a3a3e',
        boxShadow: ok ? '0 0 12px rgba(123,224,212,0.6)' : 'none',
        transition: 'background 200ms, box-shadow 200ms',
      }}
    />
  );
}
