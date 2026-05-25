/**
 * Sonoglyph atlas — gallery of every minted descent.
 *
 * What this page is for
 * ---------------------
 * The on-chain contract is immutable: its `attributes` block only carries
 * session code + token id + mint date + creator. OpenSea cannot be told to
 * override that, and we'd have to redeploy to change it. So rarity and
 * archetype live here, off-chain, as a deterministic function of the glyph
 * string. The atlas is the canonical place where players can see the full
 * collection sorted by rarity, filtered by archetype, and inspect any
 * individual descent.
 *
 * Load pattern
 * ------------
 * One fetch to /collection on mount. The bridge caches that response for
 * 5 minutes (server-side), so most viewers in any 5-minute window pay the
 * cached cost. First viewer after a mint or after TTL pays ~30 s of chain
 * scan — we show a progress message while that's happening.
 *
 * No WebSocket. Atlas is a passive read-only view; opening a descent
 * session for a passive visitor would waste a bridge slot.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchCollection,
  fetchConfig,
  type CollectionToken,
} from '../net/client';
import {
  ARCHETYPE_DESCRIPTIONS,
  analyzeGlyph,
  type Archetype,
  type RankedGlyph,
  rankCollection,
} from '../lib/glyphRarity';

type SortMode = 'rarity' | 'token' | 'recent';

/**
 * Parse the current pathname to see if we're deep-linked to a token. Returns
 * null for /atlas (no id) or any non-/atlas path. We do this rather than
 * react-router because the rest of the app uses a single pathname check —
 * adding a router for one optional path segment is heavier than necessary.
 */
function tokenIdFromPath(path: string): number | null {
  const m = path.match(/^\/atlas\/(\d+)(?:\/.*)?$/);
  if (!m) return null;
  const id = Number.parseInt(m[1], 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

const ARCHETYPE_ORDER: Archetype[] = [
  'Totem',
  'Cipher',
  'Sediment',
  'Matrix',
  'Sigil',
  'Halo',
  'Constellation',
  'Veil',
  'Weave',
  'Drift',
];

export function Atlas() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tokens, setTokens] = useState<CollectionToken[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Archetype | 'all'>('all');
  const [sort, setSort] = useState<SortMode>('rarity');
  // openId is the source of truth for "is the modal open and for which
  // token". We initialise it from the URL so deep-links like /atlas/42 open
  // straight into the modal — that's also what Twitter cards rely on once
  // we add OG meta in step 2.
  const [openId, setOpenId] = useState<number | null>(() =>
    typeof window === 'undefined' ? null : tokenIdFromPath(window.location.pathname),
  );
  // Share button gate. Fetched once on mount; defaults to false so the
  // button stays hidden if the bridge isn't reachable. The bridge flips
  // this to true via SHARE_ENABLED=true in env once supply hits 250 and
  // the rarity calibration is frozen.
  const [shareEnabled, setShareEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchConfig().then((cfg) => {
      if (!cancelled) setShareEnabled(cfg.shareEnabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Atlas needs the page to scroll AND the user to be able to select text
  // (session codes, glyphs, etc). styles.css clamps both globally for the
  // 3D descent scene; we override those bits while Atlas is mounted and
  // restore on unmount so navigating back to the descent gets the right
  // viewport behaviour. Touching the inline style rather than swapping a
  // class means we don't need to maintain CSS in two places.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prev = {
      htmlOverflow: document.documentElement.style.overflow,
      bodyOverflow: document.body.style.overflow,
      bodyUserSelect: document.body.style.userSelect,
      htmlHeight: document.documentElement.style.height,
      bodyHeight: document.body.style.height,
    };
    document.documentElement.style.overflow = 'auto';
    document.body.style.overflow = 'auto';
    document.body.style.userSelect = 'auto';
    // Drop the 100% height locks so the page can grow with content;
    // otherwise overflow:auto inside a 100%-tall body just clips.
    document.documentElement.style.height = 'auto';
    document.body.style.height = 'auto';
    return () => {
      document.documentElement.style.overflow = prev.htmlOverflow;
      document.body.style.overflow = prev.bodyOverflow;
      document.body.style.userSelect = prev.bodyUserSelect;
      document.documentElement.style.height = prev.htmlHeight;
      document.body.style.height = prev.bodyHeight;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    void fetchCollection()
      .then((res) => {
        if (cancelled) return;
        setTokens(res.tokens);
        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        const m = err instanceof Error ? err.message : String(err);
        setError(m);
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep URL ⇔ openId in sync. Browser back/forward fires popstate; we
  // re-read the pathname rather than tracking history state, so a manually
  // typed /atlas/N also resolves correctly.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPop = () => setOpenId(tokenIdFromPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const openToken = (id: number) => {
    setOpenId(id);
    if (typeof window !== 'undefined' && window.location.pathname !== `/atlas/${id}`) {
      window.history.pushState({}, '', `/atlas/${id}`);
    }
  };

  const closeModal = () => {
    setOpenId(null);
    if (typeof window !== 'undefined' && window.location.pathname !== '/atlas') {
      window.history.pushState({}, '', '/atlas');
    }
  };

  // Rank the full collection once (memoised on tokens), then apply
  // filter+sort in a separate pass. Doing it in one step would re-rank on
  // every filter click, which is wrong: rank is a property of the whole
  // corpus, not of the currently-visible slice.
  const ranked: RankedGlyph[] = useMemo(() => {
    if (tokens.length === 0) return [];
    return rankCollection(tokens.map((t) => ({ tokenId: t.tokenId, glyph: t.glyph })));
  }, [tokens]);

  // Augment ranked entries with the original token metadata (creator,
  // mintedAt, audioCid, sessionCode) — the rarity layer doesn't carry
  // them. Keyed by tokenId for O(1) lookup in the detail view.
  const metaByToken: Map<number, CollectionToken> = useMemo(() => {
    const m = new Map<number, CollectionToken>();
    for (const t of tokens) m.set(t.tokenId, t);
    return m;
  }, [tokens]);

  const archetypeCounts = useMemo(() => {
    const counts: Record<Archetype, number> = {
      Totem: 0, Cipher: 0, Sediment: 0, Matrix: 0,
      Sigil: 0, Halo: 0, Constellation: 0, Veil: 0, Weave: 0, Drift: 0,
    };
    for (const r of ranked) counts[r.archetype]++;
    return counts;
  }, [ranked]);

  const visible = useMemo(() => {
    const filtered =
      filter === 'all' ? ranked : ranked.filter((r) => r.archetype === filter);
    const sorted = [...filtered];
    if (sort === 'token') {
      sorted.sort((a, b) => a.tokenId - b.tokenId);
    } else if (sort === 'recent') {
      sorted.sort((a, b) => {
        const ta = metaByToken.get(a.tokenId)?.mintedAt ?? 0;
        const tb = metaByToken.get(b.tokenId)?.mintedAt ?? 0;
        return tb - ta;
      });
    }
    // 'rarity' is already the default order from rankCollection().
    return sorted;
  }, [ranked, filter, sort, metaByToken]);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#050507',
        color: '#d8d4cf',
        fontFamily: 'ui-monospace, Menlo, monospace',
        padding: '40px 24px 80px',
      }}
    >
      <header
        style={{
          maxWidth: 1200,
          margin: '0 auto 32px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 18 }}>
          <a
            href="/"
            style={{
              fontSize: 11,
              letterSpacing: '0.3em',
              color: '#6a6660',
              textDecoration: 'none',
            }}
          >
            ← SONOGLYPH
          </a>
          <h1
            style={{
              margin: 0,
              fontSize: 22,
              letterSpacing: '0.25em',
              color: '#c9885b',
              fontWeight: 400,
            }}
          >
            ATLAS
          </h1>
          {status === 'ready' && (
            <span style={{ fontSize: 11, letterSpacing: '0.2em', color: '#6a6660' }}>
              {ranked.length} MINTED
            </span>
          )}
        </div>
        <p
          style={{
            margin: 0,
            maxWidth: 720,
            fontSize: 12,
            lineHeight: 1.7,
            color: '#a09d99',
            fontFamily: 'system-ui, sans-serif',
            fontStyle: 'italic',
          }}
        >
          Every minted descent, sorted by an off-chain rarity score
          derived from five orthogonal axes of the glyph: density, form,
          anchor, lexicon, and symmetry. Click a glyph for its journal
          and traits.
        </p>
      </header>

      {status === 'loading' && (
        <LoadingState />
      )}

      {status === 'error' && (
        <ErrorState message={error} onRetry={() => window.location.reload()} />
      )}

      {status === 'ready' && (
        <>
          <Controls
            archetypeCounts={archetypeCounts}
            total={ranked.length}
            filter={filter}
            onFilter={setFilter}
            sort={sort}
            onSort={setSort}
          />
          <Grid
            items={visible}
            onOpen={openToken}
          />
        </>
      )}

      {openId != null && metaByToken.has(openId) && (
        <DetailModal
          /* key forces a fresh mount per token — that resets the audio
             player state without us having to manually clear refs. */
          key={openId}
          token={metaByToken.get(openId)!}
          analysis={ranked.find((r) => r.tokenId === openId) ?? null}
          totalCount={ranked.length}
          shareEnabled={shareEnabled}
          onClose={closeModal}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading / error
// ---------------------------------------------------------------------------

function LoadingState() {
  // Cold-start /collection takes ~30 s while the bridge walks the chain;
  // we don't bother estimating progress — just be honest about why it's
  // slow on first hit.
  return (
    <div
      style={{
        maxWidth: 480,
        margin: '80px auto',
        textAlign: 'center',
        fontSize: 12,
        letterSpacing: '0.18em',
        color: '#6a6660',
        lineHeight: 1.8,
      }}
    >
      <div style={{ animation: 'sg-hint-pulse 2.4s ease-in-out infinite' }}>
        LOADING THE COLLECTION
      </div>
      <div style={{ marginTop: 12, fontSize: 10, letterSpacing: '0.1em', color: '#4a463f' }}>
        First load after a fresh mint can take up to 30 seconds.
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div
      style={{
        maxWidth: 480,
        margin: '80px auto',
        textAlign: 'center',
        fontSize: 12,
        color: '#c97a5b',
        letterSpacing: '0.1em',
        lineHeight: 1.8,
      }}
    >
      <div style={{ letterSpacing: '0.22em', marginBottom: 12 }}>COLLECTION UNAVAILABLE</div>
      <div style={{ fontSize: 10, color: '#a09d99' }}>{message?.slice(0, 200) ?? 'unknown error'}</div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          marginTop: 18,
          padding: '8px 18px',
          background: 'transparent',
          color: '#d8d4cf',
          border: '1px solid #3a3a3e',
          fontFamily: 'inherit',
          letterSpacing: '0.25em',
          fontSize: 10,
          cursor: 'pointer',
        }}
      >
        RETRY
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls (filter pills + sort)
// ---------------------------------------------------------------------------

function Controls({
  archetypeCounts,
  total,
  filter,
  onFilter,
  sort,
  onSort,
}: {
  archetypeCounts: Record<Archetype, number>;
  total: number;
  filter: Archetype | 'all';
  onFilter: (a: Archetype | 'all') => void;
  sort: SortMode;
  onSort: (m: SortMode) => void;
}) {
  return (
    <div
      style={{
        maxWidth: 1200,
        margin: '0 auto 24px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <ArchetypePill
        label="ALL"
        count={total}
        active={filter === 'all'}
        onClick={() => onFilter('all')}
      />
      {ARCHETYPE_ORDER.map((a) => (
        <ArchetypePill
          key={a}
          label={a.toUpperCase()}
          count={archetypeCounts[a] ?? 0}
          active={filter === a}
          onClick={() => onFilter(a)}
        />
      ))}
      <div style={{ flex: 1 }} />
      <SortControl current={sort} onChange={onSort} />
    </div>
  );
}

function ArchetypePill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const disabled = count === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '6px 12px',
        background: active ? '#c9885b' : 'transparent',
        color: active ? '#050507' : disabled ? '#3a3a3e' : '#a09d99',
        border: `1px solid ${active ? '#c9885b' : '#2a2a2e'}`,
        fontFamily: 'inherit',
        fontSize: 10,
        letterSpacing: '0.22em',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label} · {count}
    </button>
  );
}

function SortControl({
  current,
  onChange,
}: {
  current: SortMode;
  onChange: (m: SortMode) => void;
}) {
  const opts: Array<{ k: SortMode; label: string }> = [
    { k: 'rarity', label: 'RARITY' },
    { k: 'token', label: '# ↑' },
    { k: 'recent', label: 'RECENT' },
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 9, letterSpacing: '0.25em', color: '#4a463f' }}>SORT</span>
      {opts.map((o) => (
        <button
          key={o.k}
          type="button"
          onClick={() => onChange(o.k)}
          style={{
            padding: '4px 8px',
            background: 'transparent',
            color: current === o.k ? '#c9885b' : '#6a6660',
            border: 'none',
            fontFamily: 'inherit',
            fontSize: 10,
            letterSpacing: '0.2em',
            cursor: 'pointer',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid + thumbnail
// ---------------------------------------------------------------------------

function Grid({
  items,
  onOpen,
}: {
  items: RankedGlyph[];
  onOpen: (id: number) => void;
}) {
  return (
    <div
      style={{
        maxWidth: 1200,
        margin: '0 auto',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 14,
      }}
    >
      {items.map((r) => (
        <Thumbnail key={r.tokenId} item={r} onOpen={() => onOpen(r.tokenId)} />
      ))}
    </div>
  );
}

function Thumbnail({ item, onOpen }: { item: RankedGlyph; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        textAlign: 'left',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid #1a1a1d',
        padding: 14,
        cursor: 'pointer',
        color: 'inherit',
        fontFamily: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          fontSize: 9,
          letterSpacing: '0.22em',
          color: '#6a6660',
        }}
      >
        <span>#{item.tokenId}</span>
        <span>RANK {item.rarityRank}</span>
      </div>
      {/* Glyph thumbnail. We let the <pre> shrink with the card via a
          modest font-size and rely on the 32×16 grid's own aspect ratio
          for the thumbnail proportions. */}
      <pre
        style={{
          margin: 0,
          fontSize: 7,
          lineHeight: 1.05,
          letterSpacing: '0.05em',
          color: '#c9885b',
          whiteSpace: 'pre',
          textAlign: 'center',
          overflow: 'hidden',
        }}
      >
        {item.glyph}
      </pre>
      <div
        style={{
          fontSize: 10,
          letterSpacing: '0.2em',
          color: '#c9885b',
          marginTop: 2,
        }}
      >
        {item.archetype.toUpperCase()}
      </div>
      <div
        style={{
          fontSize: 9,
          letterSpacing: '0.1em',
          color: '#4a463f',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px 8px',
        }}
      >
        <span>{item.traits.density}</span>
        <span>·</span>
        <span>{item.traits.form}</span>
        <span>·</span>
        <span>{item.traits.anchor}</span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Detail modal — full glyph, all five trait chips, archetype description.
// ---------------------------------------------------------------------------

function DetailModal({
  token,
  analysis,
  totalCount,
  shareEnabled,
  onClose,
}: {
  token: CollectionToken;
  analysis: RankedGlyph | null;
  totalCount: number;
  shareEnabled: boolean;
  onClose: () => void;
}) {
  // ESC closes the modal — light affordance, no focus-trap library.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Fall back to a fresh analyzeGlyph if the ranked entry isn't on hand
  // for some reason (defensive; shouldn't happen since modals open from
  // grid items that are already in `ranked`).
  const a = analysis ?? {
    ...analyzeGlyph(token.glyph),
    tokenId: token.tokenId,
    glyph: token.glyph,
    rarityRank: 0,
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(5,5,7,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 720,
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: '#0a0a0c',
          border: '1px solid #2a2a2e',
          padding: '28px 28px 36px',
          fontFamily: 'ui-monospace, Menlo, monospace',
          color: '#d8d4cf',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: 18, letterSpacing: '0.1em', color: '#c9885b' }}>
            SONOGLYPH #{token.tokenId}
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#6a6660',
              fontSize: 18,
              cursor: 'pointer',
              padding: 4,
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <pre
          style={{
            margin: '0 0 20px',
            fontSize: 12,
            lineHeight: 1.05,
            letterSpacing: '0.05em',
            color: '#c9885b',
            whiteSpace: 'pre',
            textAlign: 'center',
          }}
        >
          {token.glyph}
        </pre>

        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 12,
            marginBottom: 6,
          }}
        >
          <div style={{ fontSize: 16, letterSpacing: '0.15em', color: '#c9885b' }}>
            {a.archetype.toUpperCase()}
          </div>
          {a.rarityRank > 0 && (
            <div style={{ fontSize: 10, letterSpacing: '0.22em', color: '#6a6660' }}>
              RANK {a.rarityRank} / {totalCount}
            </div>
          )}
        </div>
        <p
          style={{
            margin: '0 0 18px',
            fontSize: 12,
            lineHeight: 1.6,
            color: '#a09d99',
            fontFamily: 'system-ui, sans-serif',
            fontStyle: 'italic',
          }}
        >
          {ARCHETYPE_DESCRIPTIONS[a.archetype]}
        </p>

        <TraitGrid analysis={a} />

        {token.audioCid && (
          <div style={{ marginTop: 22 }}>
            <AudioPlayer cid={token.audioCid} />
          </div>
        )}

        {shareEnabled && (
          <div
            style={{
              marginTop: 14,
              display: 'flex',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <ShareOnX tokenId={token.tokenId} />
            <DownloadVideo tokenId={token.tokenId} />
            <CopyImage tokenId={token.tokenId} />
          </div>
        )}

        <div
          style={{
            marginTop: 18,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div
            style={{
              fontSize: 10,
              letterSpacing: '0.18em',
              color: '#6a6660',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '6px 18px',
            }}
          >
            <span>SESSION {token.sessionCode}</span>
            <span>MINTED {new Date(token.mintedAt * 1000).toISOString().slice(0, 10)}</span>
            {token.audioCid && (
              <a
                href={`https://gateway.pinata.cloud/ipfs/${token.audioCid}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: '#6a6660', textDecoration: 'none' }}
              >
                IPFS ↗
              </a>
            )}
          </div>
          <CopyLink tokenId={token.tokenId} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CopyLink — small clipboard button at the bottom-right of the detail
// modal. Surfaces the canonical /atlas/:id deep link so a viewer can grab
// it for non-X channels (DMs, notes, Discord posts) without having to
// hand-copy from the URL bar.
//
// We use navigator.clipboard.writeText when available and fall back to a
// classic execCommand path for the rare browser that doesn't expose it
// (older Safari over HTTP, sandboxed iframes). The "COPIED" pulse uses a
// 1.6 s timer because anything shorter reads as a flicker and anything
// longer collides with the user reaching for their next click.
// ---------------------------------------------------------------------------
function CopyLink({ tokenId }: { tokenId: number }) {
  const [copied, setCopied] = useState(false);

  const onClick = async () => {
    const url = `${window.location.origin}/atlas/${tokenId}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // Legacy fallback: stamp a hidden textarea, select, execCommand.
        // Works in non-secure contexts where the async clipboard API is
        // blocked by the browser.
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      console.warn('[atlas] copy failed:', err);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Copy link to this Sonoglyph"
      style={{
        background: 'transparent',
        border: '1px solid #2a2a2e',
        color: copied ? '#c9885b' : '#6a6660',
        fontFamily: 'inherit',
        fontSize: 10,
        letterSpacing: '0.22em',
        padding: '6px 12px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        transition: 'color 120ms ease, border-color 120ms ease',
        borderColor: copied ? '#c9885b' : '#2a2a2e',
      }}
      onMouseEnter={(e) => {
        if (!copied) e.currentTarget.style.borderColor = '#4a463f';
      }}
      onMouseLeave={(e) => {
        if (!copied) e.currentTarget.style.borderColor = '#2a2a2e';
      }}
    >
      {copied ? 'COPIED' : 'COPY LINK'}
      <span style={{ fontSize: 11, letterSpacing: 0 }}>
        {copied ? '✓' : '⧉'}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Inline audio player — one ASCII button + elapsed/total readout.
//
// Why a hand-rolled player vs <audio controls>:
// - The default browser UI is huge and themed with system colors; on dark
//   monospace pages it looks like a fish in a tuxedo.
// - We just need play/pause + progress. No volume slider, no download menu,
//   no playback rate dropdown. Streaming a 60-second .webm is fast enough
//   over the Pinata gateway that we don't need fancy buffering UI either.
//
// Singleton-ness is handled at the call site by keying DetailModal on
// openId: when the user opens a different token's modal, this whole subtree
// unmounts and the new one mounts fresh. That naturally stops the audio.
//
// IPFS gateway choice: we use gateway.pinata.cloud because we pinned via
// Pinata at mint time, so their gateway is guaranteed to have the file
// cached. Falling back to a public gateway (ipfs.io / w3s.link) would also
// work but adds a slow path on first hit.
// ---------------------------------------------------------------------------
function AudioPlayer({ cid }: { cid: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(false);

  const url = `https://gateway.pinata.cloud/ipfs/${cid}`;

  // Wire the <audio> element's events into state. The element itself lives
  // in JSX below; this effect attaches once and tears down on unmount.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      // Seek back to start so the next ▶ click plays from 0 rather than
      // sitting at the end.
      el.currentTime = 0;
      setCurrentTime(0);
    };
    const onTime = () => setCurrentTime(el.currentTime);
    const onMeta = () => setDuration(el.duration || 0);
    const onError = () => setError(true);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('error', onError);
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('error', onError);
      // Explicitly pause on unmount so a player closing during playback
      // doesn't leak an autoplaying ghost into the next modal mount.
      el.pause();
    };
  }, []);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => setError(true));
    } else {
      el.pause();
    }
  };

  const fmt = (s: number) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${r.toString().padStart(2, '0')}`;
  };

  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        border: '1px solid #2a2a2e',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      <button
        type="button"
        onClick={toggle}
        disabled={error}
        aria-label={playing ? 'Pause' : 'Play'}
        style={{
          width: 32,
          height: 32,
          flexShrink: 0,
          border: '1px solid #c9885b',
          background: playing ? '#c9885b' : 'transparent',
          color: playing ? '#050507' : '#c9885b',
          fontFamily: 'inherit',
          fontSize: 12,
          cursor: error ? 'not-allowed' : 'pointer',
          opacity: error ? 0.4 : 1,
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {playing ? '∥' : '▶'}
      </button>
      <div
        style={{
          flex: 1,
          height: 2,
          background: '#1a1a1d',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: `${pct}%`,
            background: '#c9885b',
            transition: 'width 0.12s linear',
          }}
        />
      </div>
      <div
        style={{
          fontSize: 10,
          letterSpacing: '0.15em',
          color: error ? '#c97a5b' : '#a09d99',
          fontVariantNumeric: 'tabular-nums',
          minWidth: 78,
          textAlign: 'right',
        }}
      >
        {error ? 'AUDIO UNAVAILABLE' : `${fmt(currentTime)} / ${fmt(duration)}`}
      </div>
      {/* preload=metadata lets us show the duration immediately without
          paying for full audio download until the user clicks play. */}
      <audio ref={audioRef} src={url} preload="metadata" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Share-on-X button — opens Twitter's intent endpoint with a pre-filled
// tweet body and the canonical /atlas/:id URL. Twitter's crawler then
// fetches that URL, which the bridge serves with per-token OG meta tags
// (og:image points at /og/:id.png), so the resulting tweet renders with
// a large summary card.
//
// Gating: this component only ever mounts when the bridge reports
// shareEnabled=true. We keep it switched off until the collection mints
// out to 250 — pre-freeze, the rarity classifier's calibration snapshot
// can shift between mints, and a tweet promising a specific archetype is
// brittle if a later recalibration moves a token across the boundary.
//
// Composition: the tweet body is "I composed Sonoglyph #N — a [Archetype]
// glyph on Monad. Listen right on X." — phrasing chosen to read as
// first-person from whoever shares (clicker is usually the creator) and
// to flag the audio payload that Twitter renders inline from the og:video
// tag once step B (MP4 generation) ships.
// ---------------------------------------------------------------------------
function ShareOnX({ tokenId }: { tokenId: number }) {
  // Tweet text layout we want:
  //
  //   How does this Sonoglyph sound?
  //
  //   https://sonoglyph.xyz/atlas/N
  //
  // Twitter intent's `text` + `url` params concatenate the URL onto the
  // end of the text on the same line, which collapses the layout. Putting
  // the URL inside `text` with explicit \n\n preserves the blank-line
  // separator and Twitter still parses it as the card source. We don't
  // need to pass `url` separately when it's already in the body.
  const onClick = () => {
    const url = `${window.location.origin}/atlas/${tokenId}`;
    const text = `How does this Sonoglyph sound?\n\n${url}`;
    const intent =
      'https://twitter.com/intent/tweet' +
      `?text=${encodeURIComponent(text)}`;
    // noopener: the intent page is on x.com; we don't want it to retain
    // a reference back to the atlas tab. width/height keep it as a small
    // popup on desktop; mobile browsers ignore the geometry and open a
    // new tab, which is also fine.
    window.open(intent, '_blank', 'noopener,width=600,height=600');
  };

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        minWidth: 180,
        padding: '12px 16px',
        background: '#c9885b',
        color: '#050507',
        border: '1px solid #c9885b',
        fontFamily: 'ui-monospace, Menlo, monospace',
        fontSize: 11,
        letterSpacing: '0.28em',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = '#d99b6e';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = '#c9885b';
      }}
    >
      SHARE ON X
      <span style={{ fontSize: 12, letterSpacing: 0 }}>↗</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Download Video — companion button to Share-on-X. Twitter's "card with
// video" pipeline requires a per-domain approval we don't have, so the
// only way the audio actually plays inline on X is the user attaching
// the MP4 to their tweet themselves. This button downloads that file.
//
// The bridge renders the MP4 lazily on first hit (~5-8 s). On the second
// click it streams from disk in milliseconds. We surface progress via the
// button label so a user who clicks once and waits sees the encode
// happening rather than thinking the button is dead.
//
// We do NOT try the Web Share API even though `navigator.share({files})`
// would be a one-click path on mobile — desktop support is too patchy
// (notably absent on Chrome/Firefox), and a "this might or might not
// work" CTA is worse than two predictable buttons.
// ---------------------------------------------------------------------------
function DownloadVideo({ tokenId }: { tokenId: number }) {
  const [status, setStatus] = useState<'idle' | 'fetching' | 'error'>('idle');

  const onClick = async () => {
    if (status === 'fetching') return;
    setStatus('fetching');
    try {
      const res = await fetch(`/video/${tokenId}.mp4`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const blob = await res.blob();
      // Construct a download via a transient <a download> — this is the
      // most reliable cross-browser save path and respects the bridge's
      // Content-Disposition filename when present.
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = `sonoglyph-${tokenId}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after a tick so the click handler has a chance to start
      // the download stream before we invalidate the URL.
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
      setStatus('idle');
    } catch (err) {
      console.warn('[atlas] video download failed:', err);
      setStatus('error');
      // Auto-reset after a moment so the user can retry without
      // reopening the modal.
      setTimeout(() => setStatus('idle'), 4000);
    }
  };

  const label =
    status === 'fetching'
      ? 'RENDERING…'
      : status === 'error'
      ? 'FAILED — RETRY'
      : 'DOWNLOAD VIDEO';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={status === 'fetching'}
      style={{
        flex: 1,
        minWidth: 180,
        padding: '12px 16px',
        background: 'transparent',
        color: status === 'error' ? '#c97a5b' : '#c9885b',
        border: `1px solid ${status === 'error' ? '#c97a5b' : '#c9885b'}`,
        fontFamily: 'ui-monospace, Menlo, monospace',
        fontSize: 11,
        letterSpacing: '0.28em',
        cursor: status === 'fetching' ? 'wait' : 'pointer',
        opacity: status === 'fetching' ? 0.7 : 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
      }}
      onMouseEnter={(e) => {
        if (status === 'idle') {
          e.currentTarget.style.background = 'rgba(201,136,91,0.1)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {label}
      {status === 'idle' && (
        <span style={{ fontSize: 12, letterSpacing: 0 }}>↓</span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// CopyImage — write the OG card PNG directly into the system clipboard so
// the viewer can paste it into a tweet / Discord / messenger without going
// through download + upload. Same source asset as the share card (/og/:id.png),
// 1200×630 with archetype + branding burnt in.
//
// Why ClipboardItem with a Promise<Blob>, not `await fetch` first:
// Safari (both desktop and iOS) requires that `navigator.clipboard.write`
// is called within the user-activation tick. If we await the network round
// trip ourselves, by the time we reach `clipboard.write` the activation
// has expired and the write silently fails. The ClipboardItem constructor
// accepts a Promise per MIME type and Safari treats the eventual resolution
// as still inside the original gesture — this is the only path that works
// uniformly across Chrome/Safari/Edge.
//
// Fallback: if Clipboard API or the image/png MIME type is unsupported
// (Firefox < 127, some WebViews, non-HTTPS preview environments), we open
// the PNG in a new tab so the user can right-click → Copy Image or
// long-press → Save. Better than a dead button with no signal.
// ---------------------------------------------------------------------------

function CopyImage({ tokenId }: { tokenId: number }) {
  const [status, setStatus] = useState<
    'idle' | 'copying' | 'copied' | 'fallback' | 'error'
  >('idle');

  const onClick = async () => {
    if (status === 'copying') return;
    setStatus('copying');
    try {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
        throw new Error('clipboard-api-unavailable');
      }
      const item = new ClipboardItem({
        'image/png': fetch(`/og/${tokenId}.png`).then((r) => {
          if (!r.ok) throw new Error(`og fetch ${r.status}`);
          return r.blob();
        }),
      });
      await navigator.clipboard.write([item]);
      setStatus('copied');
      setTimeout(() => setStatus('idle'), 1800);
    } catch (err) {
      console.warn('[atlas] image copy failed, opening fallback tab:', err);
      try {
        window.open(`/og/${tokenId}.png`, '_blank', 'noopener');
        setStatus('fallback');
        setTimeout(() => setStatus('idle'), 2600);
      } catch {
        setStatus('error');
        setTimeout(() => setStatus('idle'), 4000);
      }
    }
  };

  const label =
    status === 'copying'
      ? 'COPYING…'
      : status === 'copied'
      ? 'COPIED ✓'
      : status === 'fallback'
      ? 'OPENED — SAVE IMAGE ↗'
      : status === 'error'
      ? 'FAILED — RETRY'
      : 'COPY IMAGE';

  const accent = status === 'error' ? '#c97a5b' : '#c9885b';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={status === 'copying'}
      style={{
        flex: 1,
        minWidth: 180,
        padding: '12px 16px',
        background: 'transparent',
        color: accent,
        border: `1px solid ${accent}`,
        fontFamily: 'ui-monospace, Menlo, monospace',
        fontSize: 11,
        letterSpacing: '0.28em',
        cursor: status === 'copying' ? 'wait' : 'pointer',
        opacity: status === 'copying' ? 0.7 : 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
      }}
      onMouseEnter={(e) => {
        if (status === 'idle') {
          e.currentTarget.style.background = 'rgba(201,136,91,0.1)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {label}
      {status === 'idle' && (
        <span style={{ fontSize: 12, letterSpacing: 0 }}>⧉</span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Trait chips — re-used by both the atlas detail view and the Finale badge.
// Exported so Finale.tsx can render the same row of pills.
// ---------------------------------------------------------------------------

export function TraitGrid({ analysis }: { analysis: { traits: import('../lib/glyphRarity').GlyphTraits; traitPercents: Record<keyof import('../lib/glyphRarity').GlyphTraits, number> } }) {
  const order: Array<keyof typeof analysis.traits> = [
    'density', 'form', 'anchor', 'lexicon', 'symmetry',
  ];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
        gap: 8,
      }}
    >
      {order.map((axis) => (
        <div
          key={axis}
          style={{
            padding: '10px 12px',
            border: '1px solid #1a1a1d',
            background: 'rgba(255,255,255,0.02)',
          }}
        >
          <div style={{ fontSize: 9, letterSpacing: '0.22em', color: '#4a463f' }}>
            {axis.toUpperCase()}
          </div>
          <div style={{ fontSize: 13, letterSpacing: '0.08em', color: '#d8d4cf', marginTop: 4 }}>
            {analysis.traits[axis]}
          </div>
          <div style={{ fontSize: 9, letterSpacing: '0.1em', color: '#6a6660', marginTop: 2 }}>
            {analysis.traitPercents[axis].toFixed(0)}% OF CORPUS
          </div>
        </div>
      ))}
    </div>
  );
}
