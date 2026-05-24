import { useEffect, useState } from 'react';
import { useSession } from '../state/useSession';
import { HERMES_FIX_PROMPT } from './hermesFixPrompt';
import { requestSharedAgent } from '../net/client';

/**
 * Intro / pairing screen.
 *
 * Shown until the player clicks Begin (and `agent_paired` has arrived).
 * Walks them through:
 *   1. Copy the printed `hermes mcp add … && hermes chat …` command
 *   2. Run it in their terminal
 *   3. Wait for the green "AGENT PAIRED" indicator
 *   4. Begin descent
 */
export function Intro({ onBegin }: { onBegin: () => void }) {
  const pairing = useSession((s) => s.pairing);
  const agentConnected = useSession((s) => s.agentConnected);
  const proxyOk = useSession((s) => s.proxyOk);
  const sharedAgent = useSession((s) => s.sharedAgent);
  const setSharedAgentRequesting = useSession(
    (s) => s.setSharedAgentRequesting,
  );
  const applySharedAgentResponse = useSession(
    (s) => s.applySharedAgentResponse,
  );

  // "Shared agent" is engaged the moment the player has clicked the spawn
  // button (or the server has put them in a queue / actively running
  // process). We hide the BYO pairing instructions in those states because
  // they don't apply — the bridge is doing the work for them. `idle` and
  // `failed` keep the BYO panel visible (failed shows a retryable error
  // banner above the spawn button).
  const sharedAgentEngaged =
    sharedAgent.status !== 'idle' && sharedAgent.status !== 'failed';

  // Top-level tab — which path the player is reading right now. Initial
  // state is `null`, meaning NEITHER tab is selected. A fresh visitor
  // therefore sees only the title block + tab row (no setup instructions
  // dumped on them up-front) and must explicitly pick a path.
  //
  // Auto-flip rule: if a shared agent is already engaged (queued / spawning
  // / active) we force the tab to 'shared' so a stray click on the BYO tab
  // — or a page refresh that lands on `null` — can't visually orphan the
  // spawned process. Players who want to bail from a queued spawn use the
  // page-level overlay or close the tab; the BYO tab stays disabled
  // (greyed) while engagement is live.
  const [topTab, setTopTab] = useState<'byo' | 'shared' | null>(null);
  useEffect(() => {
    if (sharedAgentEngaged && topTab !== 'shared') setTopTab('shared');
  }, [sharedAgentEngaged, topTab]);

  // Two-layer container so the intro can grow taller than the viewport
  // (e.g. the troubleshooter is expanded with the long Hermes-patch
  // prompt) without the centered flex layout pushing upper UI off-screen
  // — earlier versions used just `position:fixed; justifyContent:center`,
  // which clips the top half of overflowing content and leaves no way to
  // scroll back to it. With min-height:100% on the inner box, content
  // stays centered when it fits and naturally grows past the viewport
  // when it doesn't, with the outer box providing the scrollbar.
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        pointerEvents: 'auto',
        color: '#d8d4cf',
      }}
    >
      {/* External-links rail — fixed to the viewport corner so it stays
          visible while the player scrolls through long content like the
          troubleshoot Hermes-patch prompt. Three muted icons; backgrounds
          are transparent to keep the corner quiet (the centered title
          block is the focal point). zIndex above the inner content but
          well below modal/finale overlays. */}
      <ExternalLinks />
      <div
        style={{
          minHeight: '100%',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          // flex-start (not center) so the title + tab row stay anchored
          // near the top of the viewport instead of bouncing toward the
          // middle when a tab's content expands the flex column. The
          // adaptive top padding (clamp) gives the hero block breathing
          // room on tall desktops without crushing it on mobile.
          justifyContent: 'flex-start',
          gap: 24,
          textAlign: 'center',
          padding: 'clamp(48px, 10vh, 120px) 24px 64px',
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
      {/* Slogan / value-prop tagline. Three-beat rhythm matching the
          three external partners — composition agent (Hermes), final
          artifact generator (Kimi), settlement chain (Monad). Reads
          as a SUBTITLE under SONOGLYPH: same color (#d8d4cf, the
          page-default warm off-white) as the title, sized between
          the 30 px h1 and the 13 px instruction labels so the eye
          treats it as part of the title block rather than a
          separate paragraph. */}
      <p
        style={{
          margin: 0,
          maxWidth: 620,
          fontSize: 18,
          letterSpacing: '0.08em',
          color: '#d8d4cf',
          lineHeight: 1.5,
          fontWeight: 300,
        }}
      >
        Compose with Hermes, create with Kimi, own on Monad.
      </p>
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

      {/* While the bridge mints the session code we can't render either
          tab's contents (PairingPanel needs the printed command, the
          shared path needs a code to POST to /agents/spawn). Show a
          single line of status copy until `pairing` resolves; the table
          of CTAs reveals itself below it. */}
      {!pairing ? (
        <p style={{ color: '#6a6660', fontSize: 12, letterSpacing: '0.2em' }}>
          {proxyOk === false ? 'BRIDGE OFFLINE' : 'OPENING BRIDGE…'}
        </p>
      ) : (
        <>
          {/* Top-level tab row — splits the intro into two clearly
              separated paths so a fresh visitor never has to scan the
              page to figure out which controls apply to them. Styled
              identically to the Auto/Manual sub-tabs inside PairingPanel
              for consistency. The BYO tab is locked (greyed) while a
              shared spawn is queued/spawning/active — switching tabs in
              that window would visually orphan the running process. */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              width: '100%',
              maxWidth: 520,
            }}
          >
            <TabButton
              active={topTab === 'byo'}
              onClick={() => {
                if (!sharedAgentEngaged) setTopTab('byo');
              }}
              disabled={sharedAgentEngaged}
            >
              I have agent
            </TabButton>
            <TabButton
              active={topTab === 'shared'}
              onClick={() => setTopTab('shared')}
            >
              I don't have agent
            </TabButton>
          </div>

          {/* Secondary entry point to the atlas — kept visible regardless
              of which tab (if any) is selected, so a fresh visitor and a
              mid-setup player can both wander into the collection. Sits
              below the tab row as a muted text link so it never reads
              as a competing primary CTA against "Begin descent" / "Play
              without your own agent". The atlas is a separate SPA route
              served by the same bundle (Caddy try_files fallback), so a
              plain <a href> works — no router needed. */}
          <AtlasLink />

          {topTab === 'byo' && (
            <ByoPath
              agentConnected={agentConnected}
              onBegin={onBegin}
              command={pairing.hermesCommand}
              prompt={pairing.hermesPrompt}
              code={pairing.code}
            />
          )}
          {topTab === 'shared' && (
            <SharedPath
              sessionCode={pairing.code}
              agentConnected={agentConnected}
              sharedAgent={sharedAgent}
              sharedAgentEngaged={sharedAgentEngaged}
              onBegin={onBegin}
              onRequesting={setSharedAgentRequesting}
              onResponse={applySharedAgentResponse}
            />
          )}
        </>
      )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Per-tab content blocks. Both share the same "status row → BEGIN button →
// path-specific controls" rhythm so that switching tabs feels like
// changing a single panel, not jumping between two unrelated screens.
//
// We intentionally repeat StatusRow + BeginButton inside each path rather
// than hoisting them above the tab content — the wording on the status
// row differs ("waiting for your Hermes" vs "bridge spawning") and the
// BEGIN button stays disabled until the matching path actually pairs an
// agent, so hoisting would just push conditionals into the parent.
// -----------------------------------------------------------------------------
function ByoPath({
  agentConnected,
  onBegin,
  command,
  prompt,
  code,
}: {
  agentConnected: boolean;
  onBegin: () => void;
  command: string;
  prompt: string;
  code: string;
}) {
  return (
    <>
      <StatusRow
        ok={agentConnected}
        label={agentConnected ? 'AGENT PAIRED' : 'WAITING FOR YOUR HERMES…'}
      />
      <BeginButton enabled={agentConnected} onClick={onBegin} />
      <PairingPanel command={command} prompt={prompt} code={code} />
    </>
  );
}

function SharedPath({
  sessionCode,
  agentConnected,
  sharedAgent,
  sharedAgentEngaged,
  onBegin,
  onRequesting,
  onResponse,
}: {
  sessionCode: string;
  agentConnected: boolean;
  sharedAgent: {
    status:
      | 'idle'
      | 'requesting'
      | 'queued'
      | 'spawning'
      | 'active'
      | 'expired'
      | 'failed';
    position: number | null;
    expiresAt: number | null;
    error: string | null;
  };
  sharedAgentEngaged: boolean;
  onBegin: () => void;
  onRequesting: () => void;
  onResponse: (r: {
    status:
      | 'idle'
      | 'requesting'
      | 'queued'
      | 'spawning'
      | 'active'
      | 'expired'
      | 'failed';
    position?: number;
    expiresAt?: number;
    error?: string;
  }) => void;
}) {
  const statusLabel = agentConnected
    ? 'AGENT PAIRED — STARTING DESCENT…'
    : sharedAgentEngaged
    ? 'BRIDGE IS SPAWNING YOUR AGENT…'
    : 'PICK A VOICE AND HIT PLAY';

  // Auto-begin on the shared path. The BYO tab keeps an explicit BEGIN
  // button because the player there is in control of when their terminal
  // is ready; the shared tab, however, only reaches `agentConnected=true`
  // AFTER the player already committed by clicking "Play without your own
  // agent", so making them click a second button at that point is empty
  // ceremony. We require both `sharedAgentEngaged` and `agentConnected`
  // so we don't accidentally auto-begin if a player jumps from BYO (where
  // they already paired) into the shared tab without engaging the pool.
  useEffect(() => {
    if (sharedAgentEngaged && agentConnected) {
      onBegin();
    }
  }, [sharedAgentEngaged, agentConnected, onBegin]);

  return (
    <>
      <StatusRow ok={agentConnected} label={statusLabel} />
      {sharedAgentEngaged ? (
        <SharedAgentPanel status={sharedAgent.status} />
      ) : (
        <SharedAgentButton
          sessionCode={sessionCode}
          onRequesting={onRequesting}
          onResponse={onResponse}
          lastError={
            sharedAgent.status === 'failed' ? sharedAgent.error : null
          }
        />
      )}
    </>
  );
}

function StatusRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <StatusDot ok={ok} />
      <span
        style={{
          fontSize: 12,
          letterSpacing: '0.2em',
          color: ok ? '#7be0d4' : '#6a6660',
        }}
      >
        {label}
      </span>
    </div>
  );
}

function BeginButton({
  enabled,
  onClick,
}: {
  enabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!enabled}
      style={{
        padding: '12px 28px',
        letterSpacing: '0.3em',
        fontSize: 13,
        background: enabled ? '#d8d4cf' : 'transparent',
        color: enabled ? '#050507' : '#3a3a3e',
        border: `1px solid ${enabled ? '#d8d4cf' : '#3a3a3e'}`,
        cursor: enabled ? 'pointer' : 'default',
        textTransform: 'uppercase',
        transition: 'background 200ms, color 200ms, border 200ms',
      }}
    >
      Begin descent
    </button>
  );
}

// -----------------------------------------------------------------------------
// Voice / character presets the player can pick before spawning a shared
// Hermes. Keys MUST match proxy/src/agents/spawn.ts:PERSONALITY_PROMPTS —
// if the bridge sees an unknown key it returns 400. The blurbs here are
// player-facing copy and are deliberately distinct from the prompt
// sentences the agent itself receives; the agent's copy lives server-side
// to keep prompt-engineering decisions colocated with the spawn logic.
// -----------------------------------------------------------------------------
const PERSONALITY_OPTIONS = [
  {
    key: 'sage',
    label: 'Sage',
    blurb: 'Quiet and reflective. Favours low, sustained tones; lets silences linger.',
  },
  {
    key: 'trickster',
    label: 'Trickster',
    blurb: 'Playful and contrary. Jumps registers; answers with the unexpected.',
  },
  {
    key: 'architect',
    label: 'Architect',
    blurb: 'Builds symmetry. Echoes intervals; rhymes with what you place.',
  },
  {
    key: 'storm',
    label: 'Storm',
    blurb: 'Wide intervals, high contrast. Dramatic gestures and weighty comments.',
  },
] as const;

type PersonalityOption = (typeof PERSONALITY_OPTIONS)[number];
type PersonalityOptionKey = PersonalityOption['key'];

// -----------------------------------------------------------------------------
// "Play without your own agent" CTA — bridge spawns a Hermes process on the
// VPS, paired to this session for up to 10 minutes. The button replaces
// itself with a small spinner row while the HTTP request is in flight.
//
// Above the button sits a row of voice presets the player can pick from.
// Sage is the default — most neutral musical bias, lowest "personality
// pressure" on top of the base prompt. Switching pills updates a one-line
// blurb under the row so the player knows what they're choosing without
// any modal or tooltip lookup.
//
// Failure stays inline (small red caption below the button) rather than
// going to a modal, so the player can retry with one click.
// -----------------------------------------------------------------------------
function SharedAgentButton({
  sessionCode,
  onRequesting,
  onResponse,
  lastError,
}: {
  sessionCode: string;
  onRequesting: () => void;
  onResponse: (r: {
    status:
      | 'idle'
      | 'requesting'
      | 'queued'
      | 'spawning'
      | 'active'
      | 'expired'
      | 'failed';
    position?: number;
    expiresAt?: number;
    error?: string;
  }) => void;
  lastError: string | null;
}) {
  const [hover, setHover] = useState(false);
  const [selectedKey, setSelectedKey] =
    useState<PersonalityOptionKey>('sage');
  const selected =
    PERSONALITY_OPTIONS.find((o) => o.key === selectedKey) ??
    PERSONALITY_OPTIONS[0];

  const onClick = async () => {
    onRequesting();
    const result = await requestSharedAgent(sessionCode, selectedKey);
    onResponse(result);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        // Soft separator from the primary Begin button — same hairline
        // colour as the other intro dividers so the secondary CTA reads
        // as "alternative path" rather than a competing primary action.
        paddingTop: 14,
        marginTop: 4,
        borderTop: '1px solid #1a1a1c',
        width: 'min(460px, 100%)',
      }}
    >
      {/* Heading for the voice picker. The "don't have an agent?" framing
          that used to live here became redundant once the top-level tabs
          made the path explicit — players who see this label have already
          picked the shared route. The label now answers the next
          question instead: "what kind of companion?". */}
      <span
        style={{
          fontSize: 10,
          color: '#6a6660',
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          textAlign: 'center',
          lineHeight: 1.6,
          maxWidth: 360,
        }}
      >
        CHOOSE YOUR COMPANION'S PERSONALITY
      </span>

      {/* Pill row — four voice presets. Flex wrap so on narrow mobile
          viewports the row breaks into two lines of two pills rather
          than overflowing the container. */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: 6,
        }}
      >
        {PERSONALITY_OPTIONS.map((opt) => (
          <PersonalityPill
            key={opt.key}
            option={opt}
            selected={opt.key === selectedKey}
            onSelect={() => setSelectedKey(opt.key)}
          />
        ))}
      </div>

      {/* Blurb for the currently-selected voice. Min-height stabilises
          layout so swapping between short and long blurbs doesn't reflow
          the button position. */}
      <span
        style={{
          fontSize: 11,
          color: '#a09d99',
          letterSpacing: '0.04em',
          fontStyle: 'italic',
          textAlign: 'center',
          lineHeight: 1.55,
          maxWidth: 380,
          minHeight: 34,
        }}
      >
        {selected.blurb}
      </span>

      <button
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          padding: '10px 22px',
          fontSize: 11,
          letterSpacing: '0.28em',
          background: 'transparent',
          color: hover ? '#d8d4cf' : '#a09d99',
          border: `1px solid ${hover ? '#c9885b' : '#3a3a3e'}`,
          cursor: 'pointer',
          textTransform: 'uppercase',
          transition: 'color 160ms, border 160ms',
        }}
      >
        Play without your own agent
      </button>
      {lastError && (
        <span
          style={{
            fontSize: 10,
            color: '#c95b5b',
            letterSpacing: '0.05em',
            marginTop: 4,
            textAlign: 'center',
            maxWidth: 360,
          }}
        >
          {lastError}
        </span>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Single voice pill. Visually subtle so the row reads as a control group
// rather than four competing buttons — active pill picks up the orange
// brand accent we use elsewhere (Step headers, SharedAgentPanel border),
// inactive ones stay in the muted-grey palette. Hover bumps the border
// only, never the background, so the pills don't compete with the
// primary "Play without your own agent" button below.
// -----------------------------------------------------------------------------
function PersonalityPill({
  option,
  selected,
  onSelect,
}: {
  option: PersonalityOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const [hover, setHover] = useState(false);
  const borderColor = selected
    ? '#c9885b'
    : hover
    ? '#5a5a5e'
    : '#3a3a3e';
  const textColor = selected
    ? '#d8d4cf'
    : hover
    ? '#d8d4cf'
    : '#a09d99';
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-pressed={selected}
      style={{
        padding: '5px 12px',
        fontSize: 10,
        letterSpacing: '0.22em',
        background: 'transparent',
        color: textColor,
        border: `1px solid ${borderColor}`,
        borderRadius: 999,
        cursor: selected ? 'default' : 'pointer',
        textTransform: 'uppercase',
        fontFamily: 'inherit',
        transition: 'color 160ms, border 160ms',
      }}
    >
      {option.label}
    </button>
  );
}

// -----------------------------------------------------------------------------
// Replacement for the PairingPanel once the player has engaged the shared-
// agent path. Compact card explaining what's happening so they don't feel
// stranded between click and pairing.
// -----------------------------------------------------------------------------
function SharedAgentPanel({
  status,
}: {
  status:
    | 'idle'
    | 'requesting'
    | 'queued'
    | 'spawning'
    | 'active'
    | 'expired'
    | 'failed';
}) {
  const headline =
    status === 'requesting'
      ? 'CONTACTING THE BRIDGE…'
      : status === 'queued'
      ? 'WAITING FOR A FREE SLOT…'
      : status === 'spawning'
      ? 'SPAWNING YOUR AGENT…'
      : status === 'active'
      ? 'YOUR AGENT IS READY'
      : status === 'expired'
      ? 'YOUR AGENT EXPIRED'
      : 'UNAVAILABLE';

  const body =
    status === 'expired'
      ? 'Your shared agent ran past its 10-minute window. Refresh the page to start a fresh descent.'
      : status === 'queued'
      ? 'A queue overlay will appear shortly with your position.'
      : status === 'active'
      ? 'The bridge has handed off to your agent. Your descent is starting…'
      : 'Hold on a beat — this usually takes about five seconds. ' +
        'The pairing light will turn green when your agent connects.';

  return (
    <div
      style={{
        maxWidth: 560,
        width: '100%',
        padding: '20px 24px',
        border: '1px solid #2a2a2e',
        borderLeft: '2px solid #c9885b',
        borderRadius: 3,
        background: 'rgba(255,255,255,0.02)',
        textAlign: 'left',
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: '0.32em',
          color: '#c9885b',
          textTransform: 'uppercase',
          marginBottom: 10,
        }}
      >
        {headline}
      </div>
      <p
        style={{
          margin: 0,
          fontSize: 13,
          lineHeight: 1.7,
          color: '#a09d99',
          letterSpacing: '0.02em',
        }}
      >
        {body}
      </p>
    </div>
  );
}

// -----------------------------------------------------------------------------
type SetupTab = 'auto' | 'manual';

/**
 * Setup-instructions panel with two switchable tabs:
 *
 *   auto   — `hermes mcp add … && hermes chat --yolo`. The fast path
 *            for players whose Hermes install can parse the `--url`
 *            flag correctly. Includes the TROUBLESHOOT dropdown
 *            because that path can fail silently (Hermes runs straight
 *            into the chat without prompting), and the troubleshooter
 *            ships a ready-made fix-prompt the player hands to their
 *            own Hermes.
 *
 *   manual — direct edit of `~/.hermes/config.yaml`. No CLI flags
 *            involved, so it bypasses the bug that motivates the
 *            auto-tab troubleshooter; consequently the manual tab
 *            does NOT show the troubleshooter (it would be empty
 *            advice — there's nothing for it to fix).
 *
 * Tab state is local because it's purely a presentation choice that
 * shouldn't survive page reloads — fresh visitors get the auto path
 * by default since it's two-line setup vs the manual seven-step.
 */
function PairingPanel({
  command,
  prompt,
  code,
}: {
  command: string;
  prompt: string;
  code: string;
}) {
  const [tab, setTab] = useState<SetupTab>('auto');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        alignItems: 'stretch',
        maxWidth: 720,
        width: '100%',
        textAlign: 'left',
      }}
    >
      {/* Tab switcher. Two buttons sharing the panel width so each
          tab has equal visual weight regardless of label length —
          the auto tab is shorter to type but the manual tab covers
          a real fallback need (Hermes installs with the --url bug),
          and we don't want the buttons to suggest one is "primary"
          via size. */}
      <div style={{ display: 'flex', gap: 8 }}>
        <TabButton active={tab === 'auto'} onClick={() => setTab('auto')}>
          ① Automatic Setup
        </TabButton>
        <TabButton active={tab === 'manual'} onClick={() => setTab('manual')}>
          ② Manual Config
        </TabButton>
      </div>

      {tab === 'auto' ? (
        <AutomaticTab command={command} prompt={prompt} />
      ) : (
        <ManualTab code={code} prompt={prompt} />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
function AutomaticTab({
  command,
  prompt,
}: {
  command: string;
  prompt: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <Step number={1} title="Run the setup command">
        <p style={stepText}>Open your terminal and execute:</p>
        <CommandBlock body={command} />
        <Callout kind="warn">
          If the terminal does <strong>not</strong> ask you any questions about
          the connection and goes straight into the chat, close it and jump to
          the <strong>Troubleshoot</strong> section below.
        </Callout>
      </Step>

      <Step number={2} title="Answer the prompts">
        <p style={stepText}>
          For the connection question — answer <Inline>Y</Inline>.
          <br />
          For the API key question — just press <Inline>Enter</Inline> to leave
          it empty.
          <br />
          For the tools question — answer <Inline>Y</Inline>.
        </p>
        <p style={{ ...stepText, color: '#6a6660' }}>
          Once you've answered all three, the chat will launch.
        </p>
      </Step>

      <Step number={3} title="Send the composition prompt">
        <p style={stepText}>Paste this prompt into the chat:</p>
        <CommandBlock body={prompt} scrollable />
      </Step>

      <Step number={4} title="Play">
        <Callout kind="info">
          KEEP THE TERMINAL OPEN THROUGHOUT THE GAME.
          <br />
          Once the <strong>AGENT PAIRED</strong> light is on, hit{' '}
          <strong>BEGIN</strong> and place your first layer.
        </Callout>
      </Step>

      {/* Troubleshoot details — only here in the auto tab, since the
          --url flag bug it patches doesn't apply when the player
          hand-edits config.yaml. */}
      <details
        style={{
          width: '100%',
          fontSize: 11,
          letterSpacing: '0.2em',
          color: '#6a6660',
          textAlign: 'left',
        }}
      >
        <summary style={{ cursor: 'pointer', padding: '4px 0', color: '#c95b5b' }}>
          NOT WORKING? TROUBLESHOOT ↓
        </summary>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            marginTop: 10,
            paddingLeft: 12,
            borderLeft: '1px solid #2a2a2e',
            color: '#a09d99',
            fontSize: 11,
            letterSpacing: '0.06em',
            lineHeight: 1.7,
            textTransform: 'none',
          }}
        >
          <div>
            <strong style={{ color: '#d8d4cf' }}>1.</strong> Update your
            Hermes:
          </div>
          <CommandBlock body="hermes update" />
          <div>
            <strong style={{ color: '#d8d4cf' }}>2.</strong> If the update
            didn't fix it, hand this prompt to your Hermes agent so it can
            patch the bug. The changes are safe — they target the bug
            specifically and were authored by the Sonoglyph developer's own
            Hermes.
          </div>
          <CommandBlock body={HERMES_FIX_PROMPT} scrollable />
          <div>
            <strong style={{ color: '#d8d4cf' }}>3.</strong> Close the chat
            and exit back to the terminal.
          </div>
          <div>
            <strong style={{ color: '#d8d4cf' }}>4.</strong> Go back to{' '}
            <strong style={{ color: '#c9885b' }}>STEP 1</strong> at the top
            of this page and run the setup command again — the patched
            Hermes will now prompt you correctly.
          </div>
        </div>
      </details>
    </div>
  );
}

// -----------------------------------------------------------------------------
function ManualTab({ code, prompt }: { code: string; prompt: string }) {
  // Heredoc that creates `~/.hermes/config.yaml` if missing and appends
  // the sonoglyph entry. The 'EOF' marker is single-quoted on purpose —
  // it stops the shell from expanding `$` inside (the URL has none, but
  // a future operator change could introduce one and it's cheap
  // insurance).
  const writeConfig =
    `mkdir -p ~/.hermes && touch ~/.hermes/config.yaml && cat >> ~/.hermes/config.yaml << 'EOF'\n` +
    `mcp_servers:\n` +
    `  sonoglyph:\n` +
    `    url: https://sonoglyph.xyz/mcp?code=${code}\n` +
    `    enabled: true\n` +
    `EOF`;

  // Snippet for the "I already have other servers" path — just the
  // server entry, indented two spaces under the assumed existing
  // `mcp_servers:` parent.
  const yamlSnippet =
    `  sonoglyph:\n` +
    `    url: https://sonoglyph.xyz/mcp?code=${code}\n` +
    `    enabled: true`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <Step number={1} title="Open your terminal">
        <p style={stepText}>
          Open the terminal on the machine where Hermes is installed.
        </p>
      </Step>

      <Step number={2} title="Configure the MCP server">
        <SubStep label="Option A — You don't have any MCP servers yet">
          <p style={stepText}>
            Add the Sonoglyph MCP to your config file:
          </p>
          <CommandBlock body={writeConfig} />
        </SubStep>

        <SubStep label="Option B — You already have MCP servers configured">
          <p style={stepText}>
            Open <Inline>~/.hermes/config.yaml</Inline> in your editor and add{' '}
            <Inline>sonoglyph</Inline> to the existing{' '}
            <Inline>mcp_servers</Inline> list:
          </p>
          <CommandBlock body={yamlSnippet} />
          <p style={{ ...stepText, color: '#6a6660' }}>
            Make sure the indentation matches your other servers (two spaces
            under <Inline>mcp_servers:</Inline>).
          </p>
        </SubStep>
      </Step>

      <Step number={3} title="Verify the configuration">
        <p style={stepText}>
          Run these commands to confirm the server is registered and reachable:
        </p>
        <CommandBlock body={'hermes mcp list\nhermes mcp test sonoglyph'} />
        <p style={{ ...stepText, color: '#6a6660' }}>
          You should see <Inline>sonoglyph</Inline> in the list and a
          successful test response.
        </p>
      </Step>

      <Step number={4} title="Launch Hermes">
        <p style={stepText}>Start the agent:</p>
        <CommandBlock body="hermes" />
      </Step>

      <Step number={5} title="Trigger Sonoglyph in chat">
        <p style={stepText}>Send this message to Hermes:</p>
        <CommandBlock body="Run Sonoglyph" />
      </Step>

      <Step number={6} title="Send the composition prompt">
        <p style={stepText}>
          Paste the following prompt into the chat to drive the autonomous
          co-composition loop:
        </p>
        <CommandBlock body={prompt} scrollable />
      </Step>

      <Step number={7} title="Return to the site and play">
        <p style={stepText}>
          Go back to the Sonoglyph site and start the game.
        </p>
        <Callout kind="info">
          The access code is <strong>single-use</strong>. To play again, you'll
          need to update your config with a fresh code.
          <br />
          <br />
          Alternatively, switch to the <strong>Automatic Setup</strong> tab —
          but if your Hermes install has the <Inline>--url</Inline> flag bug,
          ask your agent to apply the fix prompt available there first.
        </Callout>
      </Step>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Layout helpers — Step / SubStep / Callout / Inline / TabButton.
//
// These don't need their own files; they're intro-screen-specific
// shapes layered on top of the global IBM Plex Mono + dark palette.
// Keeping them inline means a hackathon-judge reading Intro.tsx
// straight through gets the full picture without jumping files.
// -----------------------------------------------------------------------------

const stepText: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.7,
  color: '#d8d4cf',
  letterSpacing: '0.02em',
};

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: '0.3em',
          color: '#c9885b',
          textTransform: 'uppercase',
          fontWeight: 500,
        }}
      >
        Step {number} · {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

function SubStep({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        paddingLeft: 12,
        borderLeft: '1px solid #2a2a2e',
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: '0.15em',
          color: '#a09d99',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Callout({
  kind,
  children,
}: {
  /** `warn` paints a red left-border (matches the Troubleshoot summary
   *  color — "something to be careful about"). `info` uses the orange
   *  accent — same as Step headers, "this is part of the instruction
   *  flow, just emphasized". */
  kind: 'warn' | 'info';
  children: React.ReactNode;
}) {
  const accent = kind === 'warn' ? '#c95b5b' : '#c9885b';
  return (
    <div
      style={{
        padding: '10px 14px',
        background: 'rgba(255,255,255,0.03)',
        borderLeft: `2px solid ${accent}`,
        borderTop: '1px solid #2a2a2e',
        borderRight: '1px solid #2a2a2e',
        borderBottom: '1px solid #2a2a2e',
        borderRadius: 3,
        fontSize: 12,
        lineHeight: 1.6,
        color: '#d8d4cf',
        letterSpacing: '0.02em',
      }}
    >
      {children}
    </div>
  );
}

function Inline({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        fontFamily: 'inherit',
        background: 'rgba(255,255,255,0.06)',
        padding: '1px 6px',
        border: '1px solid #2a2a2e',
        borderRadius: 3,
        fontSize: '0.92em',
        color: '#d8d4cf',
      }}
    >
      {children}
    </code>
  );
}

function TabButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  /** When true, the tab is non-interactive. We keep it visually present
   *  (not hidden) so the player still sees that the other path exists —
   *  it just can't be activated while the current one holds a shared
   *  spawn slot. */
  disabled?: boolean;
  children: React.ReactNode;
}) {
  // Three styling tiers: active (orange fill), disabled-inactive (dim grey,
  // not clickable), normal-inactive (mid grey, hover-ready).
  const muted = disabled && !active;
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        flex: 1,
        padding: '10px 14px',
        fontSize: 12,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        fontFamily: 'inherit',
        background: active ? '#c9885b' : 'transparent',
        color: active ? '#050507' : muted ? '#4a4a4e' : '#a09d99',
        border: `1px solid ${active ? '#c9885b' : muted ? '#2a2a2e' : '#3a3a3e'}`,
        cursor: active ? 'default' : disabled ? 'not-allowed' : 'pointer',
        opacity: muted ? 0.6 : 1,
        transition: 'background 160ms ease, color 160ms ease, border 160ms ease, opacity 160ms ease',
      }}
    >
      {children}
    </button>
  );
}

function CommandBlock({
  label,
  labelColor = '#6a6660',
  body,
  scrollable,
}: {
  label?: string;
  /**
   * Color applied to the label text. Defaults to the muted grey used
   * elsewhere as section-label color; pass `#c9885b` (or another
   * accent) when this block is one of the player's primary
   * step-by-step instructions and the eye needs to land on it.
   */
  labelColor?: string;
  body: string;
  /**
   * Cap the <pre> at ~320 px with an internal scrollbar instead of
   * letting it expand to fit the whole body. Use for long bodies (the
   * Hermes-fix prompt is ~50 lines) so the page doesn't grow to 2000+
   * px just to render a single block. The outer page is still
   * scrollable as a safety net.
   */
  scrollable?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // best-effort
    }
  };
  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {label && (
        <div style={{ fontSize: 11, letterSpacing: '0.2em', color: labelColor }}>
          {label}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <pre
          style={{
            margin: 0,
            // Top padding bumped (12 → 36) so the first line of text
            // clears the absolutely-positioned COPY button instead of
            // sliding under it. Side+bottom unchanged.
            padding: '36px 16px 12px',
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
            maxHeight: scrollable ? 320 : undefined,
            overflowY: scrollable ? 'auto' : undefined,
          }}
        >
          {body}
        </pre>
        <button
          onClick={onCopy}
          style={{
            position: 'absolute',
            top: 6,
            // Hug the right edge in normal mode; pull in past the
            // ~14 px vertical scrollbar (with breathing room) only
            // when the <pre> is scrollable, so the semi-transparent
            // button doesn't bleed into the scroll track.
            right: scrollable ? 32 : 6,
            padding: '4px 10px',
            fontSize: 9,
            letterSpacing: '0.25em',
            background: 'rgba(5,5,7,0.6)',
            color: '#a09d99',
            border: '1px solid #3a3a3e',
            cursor: 'pointer',
            textTransform: 'uppercase',
          }}
        >
          {copied ? 'COPIED' : 'COPY'}
        </button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Small secondary link to the atlas page. Lives just under the top-level
// tab row on Intro. Subtle on purpose — the primary action on this screen
// is "pick a path → begin", and the atlas is an aside ("see what other
// people made"). Hover bumps it to the orange accent the brand uses for
// active states so the affordance is felt without weight at rest.
// -----------------------------------------------------------------------------
function AtlasLink() {
  const [hover, setHover] = useState(false);
  return (
    <a
      href="/atlas"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        fontSize: 10,
        letterSpacing: '0.32em',
        color: hover ? '#c9885b' : '#6a6660',
        textDecoration: 'none',
        textTransform: 'uppercase',
        marginTop: -8,
        // Same monospace stack as the rest of the brand's small caps so
        // the link inherits the chrome's typographic rhythm rather than
        // catching the eye as foreign text.
        fontFamily: 'ui-monospace, Menlo, monospace',
        transition: 'color 160ms ease',
      }}
    >
      See the collection ↗
    </a>
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

// -----------------------------------------------------------------------------
// External-links rail — top-right corner of the intro screen.
//
// Three icon links: author's X (Twitter), the GitHub repo, and the docs
// site. Rendered as bare SVGs (no button chrome) because the surrounding
// page is deliberately quiet — borders or filled backgrounds in the
// corner would compete with the centered title block. Hover bumps the
// stroke colour from the muted `#a09d99` (matches italic descent prose)
// to the title's `#d8d4cf` so the affordance is felt without adding
// visual weight at rest.
//
// `position: fixed` so the row stays anchored to the viewport while the
// outer scroll container moves underneath it (the troubleshoot section
// can push content well past one screen).
// -----------------------------------------------------------------------------

function ExternalLinks() {
  return (
    <div
      style={{
        position: 'fixed',
        top: 20,
        right: 24,
        zIndex: 2,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <IconLink href="https://x.com/badfriend" label="Author on X">
        <XIcon />
      </IconLink>
      <IconLink
        href="https://github.com/discodirector/sonoglyph"
        label="Source on GitHub"
      >
        <GithubIcon />
      </IconLink>
      <IconLink href="https://docs.sonoglyph.xyz" label="Documentation">
        <DocsIcon />
      </IconLink>
    </div>
  );
}

function IconLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        // 28 px hit-target, 18 px glyph centred — generous click area
        // without the visual noise of a 36 px ghost-button.
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: hover ? '#d8d4cf' : '#a09d99',
        transition: 'color 160ms ease',
        textDecoration: 'none',
      }}
    >
      {children}
    </a>
  );
}

// Icon glyphs use `currentColor` so the parent <a> drives the hover
// transition. 18×18 final size, viewBox 24×24 — standard for the X and
// GitHub brand marks. Source paths sourced from the official brand
// guides / Octicons; trimmed to their first sub-path so we ship as
// little SVG as possible.

function XIcon() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117l11.966 15.644z" />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function DocsIcon() {
  // Open-book glyph — picked over a generic document icon so it reads
  // as "READ THE DOCS" at a glance, not "open file". 2 px stroke-equivalent
  // built from filled paths so it matches the brand-icon weight.
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 5.5C10.5 4.6 8.5 4 6 4H3a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h3c2 0 3.5.5 5 1.5V5.5zM13 5.5v15c1.5-1 3-1.5 5-1.5h3a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-3c-2.5 0-4.5.6-5 1.5z" />
    </svg>
  );
}
