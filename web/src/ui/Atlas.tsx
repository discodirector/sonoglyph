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

import { useEffect, useMemo, useState } from 'react';
import {
  fetchCollection,
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

const ARCHETYPE_ORDER: Archetype[] = [
  'Totem',
  'Cipher',
  'Sediment',
  'Matrix',
  'Sigil',
  'Halo',
  'Constellation',
  'Drift',
];

export function Atlas() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tokens, setTokens] = useState<CollectionToken[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Archetype | 'all'>('all');
  const [sort, setSort] = useState<SortMode>('rarity');
  const [openId, setOpenId] = useState<number | null>(null);

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
      Sigil: 0, Halo: 0, Constellation: 0, Drift: 0,
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
            onOpen={(id) => setOpenId(id)}
          />
        </>
      )}

      {openId != null && metaByToken.has(openId) && (
        <DetailModal
          token={metaByToken.get(openId)!}
          analysis={ranked.find((r) => r.tokenId === openId) ?? null}
          totalCount={ranked.length}
          onClose={() => setOpenId(null)}
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
  onClose,
}: {
  token: CollectionToken;
  analysis: RankedGlyph | null;
  totalCount: number;
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

        <div
          style={{
            marginTop: 22,
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
              style={{ color: '#c9885b', textDecoration: 'none' }}
            >
              AUDIO ↗
            </a>
          )}
        </div>
      </div>
    </div>
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
