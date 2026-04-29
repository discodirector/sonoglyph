import { useEffect, useState } from 'react';
import { LAYER_TYPES, useSession } from '../state/useSession';
import type { LayerType } from '../state/useSession';

/**
 * Day 4 HUD — turn-based collaboration with Hermes.
 *
 * Top row: SONOGLYPH | TURN x/35 | WHO_PLAYS | PROXY status | REC indicator
 * Middle:  agent comment when present
 * Bottom:  preset palette (locked outside player's turn / during cooldown)
 *          cooldown progress bar above the palette
 */
export function Hud() {
  const phase = useSession((s) => s.phase);
  const turnCount = useSession((s) => s.turnCount);
  const maxLayers = useSession((s) => s.maxLayers);
  const currentTurn = useSession((s) => s.currentTurn);
  const cooldownEndsAt = useSession((s) => s.cooldownEndsAt);
  const agentConnected = useSession((s) => s.agentConnected);
  // Derive the "currently shown" agent comment from the latest layer.
  // If the last placed layer is the agent's — show its comment. As soon
  // as the player places the next layer, that becomes the latest, and
  // the comment naturally disappears. No timing race possible.
  const agentComment = useSession((s) => {
    const last = s.layers[s.layers.length - 1];
    return last && last.placedBy === 'agent' ? last.comment ?? null : null;
  });
  const proxyOk = useSession((s) => s.proxyOk);
  const recording = useSession((s) => s.recording);
  const selected = useSession((s) => s.selectedPreset);
  const setSelected = useSession((s) => s.setSelectedPreset);
  const depth = useSession((s) => s.depth);

  const cooldownLeft = useCooldownLeft(cooldownEndsAt);

  if (phase === 'intro') return null;

  const playerCanAct =
    phase === 'playing' &&
    currentTurn === 'player' &&
    cooldownLeft === 0 &&
    turnCount < maxLayers;

  const isAgentTurn = currentTurn === 'agent';
  const turnLabel =
    phase === 'finished'
      ? 'DESCENT COMPLETE'
      : !agentConnected
      ? 'HERMES DISCONNECTED'
      : isAgentTurn
      ? 'HERMES IS HAVING FUN'
      : currentTurn === 'player'
      ? 'YOUR TURN'
      : '';

  return (
    <>
      {/* Top status row + agent comment */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 24,
          paddingBottom: 130,
          mixBlendMode: 'difference',
          color: '#d8d4cf',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 11,
            letterSpacing: '0.18em',
          }}
        >
          <span>SONOGLYPH</span>
          <span style={{ display: 'flex', gap: 16 }}>
            {recording && <span style={{ color: '#c97a5b' }}>● REC</span>}
            <span>TURN {turnCount.toString().padStart(2, '0')}/{maxLayers}</span>
            <span style={{ color: turnLabelColor(currentTurn, agentConnected, phase) }}>
              {turnLabel}
            </span>
            <span>DEPTH {Math.round(depth).toString().padStart(4, '0')}</span>
            <span>BRIDGE {proxyOk === null ? '…' : proxyOk ? 'OK' : 'OFFLINE'}</span>
          </span>
        </div>

        {/* Agent comment — italic line, centered */}
        {agentComment ? (
          <div
            style={{
              alignSelf: 'center',
              maxWidth: 640,
              textAlign: 'center',
              fontSize: 16,
              fontStyle: 'italic',
              opacity: 0.9,
              lineHeight: 1.6,
            }}
          >
            “{agentComment}” — <span style={{ opacity: 0.6 }}>hermes</span>
          </div>
        ) : (
          <div />
        )}
      </div>

      {/* Bottom palette + cooldown bar */}
      <div
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          padding: '14px 24px 20px',
          pointerEvents: 'auto',
          background:
            'linear-gradient(to top, rgba(5,5,7,0.9) 0%, rgba(5,5,7,0) 100%)',
        }}
      >
        <CooldownBar cooldownEndsAt={cooldownEndsAt} agentTurn={isAgentTurn} />

        <div
          style={{
            marginTop: 10,
            display: 'flex',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          {LAYER_TYPES.map((t, i) => (
            <PresetButton
              key={t}
              type={t}
              index={i + 1}
              active={t === selected}
              disabled={!playerCanAct}
              onClick={() => setSelected(t)}
            />
          ))}
        </div>

        {/* Hint — only during player's first turn */}
        {playerCanAct && turnCount === 0 && (
          <div
            style={{
              marginTop: 10,
              textAlign: 'center',
              fontSize: 11,
              letterSpacing: '0.2em',
              color: '#6a6660',
            }}
          >
            CLICK INTO THE DARK TO PLACE A LAYER · KEYS 1-5 SELECT PRESET
          </div>
        )}
      </div>
    </>
  );
}

// -----------------------------------------------------------------------------
function useCooldownLeft(cooldownEndsAt: number | null): number {
  const [, force] = useState(0);
  useEffect(() => {
    if (!cooldownEndsAt) return;
    const id = window.setInterval(() => force((n) => n + 1), 100);
    return () => window.clearInterval(id);
  }, [cooldownEndsAt]);
  if (!cooldownEndsAt) return 0;
  return Math.max(0, cooldownEndsAt - Date.now());
}

function CooldownBar({
  cooldownEndsAt,
  agentTurn,
}: {
  cooldownEndsAt: number | null;
  agentTurn: boolean;
}) {
  const left = useCooldownLeft(cooldownEndsAt);
  if (!cooldownEndsAt || left <= 0) {
    return <div style={{ height: 2, background: 'rgba(255,255,255,0.06)' }} />;
  }
  // Estimate progress assuming 10s window; actual remaining vs total.
  const total = 10000;
  const progress = Math.max(0, Math.min(1, 1 - left / total));
  // Same cyan as the "HERMES IS HAVING FUN" label while it's the agent's
  // turn; warm orange while the player is in cooldown.
  const fill = agentTurn ? '#7be0d4' : '#c9885b';
  return (
    <div
      style={{
        height: 2,
        background: 'rgba(255,255,255,0.08)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          width: `${progress * 100}%`,
          background: fill,
          transition: 'width 100ms linear, background 200ms ease',
        }}
      />
    </div>
  );
}

const presetColors: Record<LayerType, string> = {
  drone: '#8aa1b3',
  texture: '#aab0a8',
  pulse: '#c9885b',
  glitch: '#7be0d4',
  breath: '#d4a098',
};

function PresetButton({
  type,
  index,
  active,
  disabled,
  onClick,
}: {
  type: LayerType;
  index: number;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const color = presetColors[type];
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: '10px 14px',
        minWidth: 86,
        background: active && !disabled ? color : 'transparent',
        color: active && !disabled ? '#050507' : disabled ? '#3a3a3e' : '#d8d4cf',
        border: `1px solid ${active && !disabled ? color : disabled ? '#222' : '#3a3a3e'}`,
        letterSpacing: '0.15em',
        fontSize: 11,
        textTransform: 'uppercase',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'opacity 200ms ease, background 120ms ease',
      }}
    >
      <span style={{ fontSize: 9, opacity: 0.6 }}>{index}</span>
      <span>{type}</span>
    </button>
  );
}

function turnLabelColor(
  currentTurn: 'player' | 'agent' | null,
  agentConnected: boolean,
  phase: string,
): string {
  if (phase === 'finished') return '#c9885b';
  if (!agentConnected) return '#c97a5b';
  if (currentTurn === 'agent') return '#7be0d4';
  if (currentTurn === 'player') return '#d8d4cf';
  return '#6a6660';
}
