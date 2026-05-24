/**
 * OG image + meta-tag plumbing for the Sonoglyph atlas.
 *
 * Two surface area concerns:
 *
 *   1. PNG card generation — Twitter/Open Graph crawlers fetch a static
 *      image, not a live preview. We render 1200×630 PNGs per token via
 *      satori (JSX-ish → SVG) + resvg-js (SVG → PNG). Output is cached on
 *      disk so the second crawler hit and every cache-warmed share are
 *      effectively free.
 *
 *   2. HTML meta injection — `<meta property="og:*">` and `<meta name=
 *      "twitter:*">` tags are read from the response HTML, NOT from the
 *      live DOM. Twitter's crawler does not execute JS. So for /atlas/:id
 *      we need to serve a per-token HTML body whose head contains the
 *      right OG tags. We do that by reading the built SPA `index.html`
 *      once on startup, then string-splicing the meta block in for each
 *      tokenId. The SPA itself still hydrates client-side and opens the
 *      detail modal from the URL — see Atlas.tsx.
 *
 * Why we don't pre-warm the PNG cache on startup
 * ----------------------------------------------
 * Rendering all ~250 PNGs would burn ~50 s of CPU at boot. Lazy is cheap
 * enough (~200 ms per cold render) since the first crawler hit will warm
 * the cache before any human shares the URL. If the operator wants to
 * force-warm, hitting `/og/1.png … /og/N.png` in a loop does the job.
 *
 * Font choice
 * -----------
 * JetBrains Mono is bundled at `proxy/assets/fonts/JetBrainsMono-Regular
 * .ttf` (~270 KB). It's a monospace face whose box-drawing glyphs render
 * cleanly at small sizes, which matters for the ASCII descent diagram —
 * the alternative (sans-serif fallback) collapses to ambiguous geometry.
 */

import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { analyzeGlyph } from './glyphRarity.js';

// ---------------------------------------------------------------------------
// Font + HTML asset loaders. Both are read once and memoised — they don't
// change between requests, and disk IO on every crawler hit would be wasted
// work.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_PATH = path.resolve(HERE, '../assets/fonts/JetBrainsMono-Regular.ttf');
// The bridge runs from proxy/, the built SPA sits at ../web/dist. In dev
// (vite dev server) this file may not exist yet — we treat that as a soft
// failure and respond with a 503 so the operator notices instead of
// serving a half-broken HTML.
const INDEX_HTML_PATH = path.resolve(HERE, '../../web/dist/index.html');
// On-disk PNG cache. Configurable via OG_CACHE_DIR for ops; defaults to a
// path under the systemd service's writable working directory. We do NOT
// use /tmp because systemd's PrivateTmp would isolate it per service
// restart, defeating the cache.
const CACHE_DIR =
  process.env.OG_CACHE_DIR ?? path.resolve(HERE, '../../cache/og');

let fontCache: ArrayBuffer | null = null;
let indexHtmlCache: string | null = null;

async function loadFont(): Promise<ArrayBuffer> {
  if (fontCache) return fontCache;
  const buf = await readFile(FONT_PATH);
  // satori expects an ArrayBuffer; Node's Buffer has a backing ArrayBuffer
  // that may be larger than the file (pool allocation), so we slice to the
  // exact bytes the font occupies.
  fontCache = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return fontCache;
}

/**
 * Read the built SPA shell. We re-read on every call rather than caching
 * indefinitely so a redeploy with a new bundle hash takes effect without
 * needing a bridge restart. The file is tiny (~800 bytes) so the cost is
 * negligible compared to the meta-injection work that follows.
 */
async function loadIndexHtml(): Promise<string> {
  // Bust the cache if the file mtime moved since we last read it. This is
  // the redeploy case — vite emits a new index.html, redeploy.sh bumps it
  // into place, and we want the next request to pick up the new asset hash
  // without us having to bounce the bridge.
  try {
    const st = await stat(INDEX_HTML_PATH);
    const mtime = Math.floor(st.mtimeMs);
    if (indexHtmlCache && indexHtmlCacheMtime === mtime) return indexHtmlCache;
    const html = await readFile(INDEX_HTML_PATH, 'utf-8');
    indexHtmlCache = html;
    indexHtmlCacheMtime = mtime;
    return html;
  } catch (err) {
    throw new Error(
      `index.html not built yet at ${INDEX_HTML_PATH}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
let indexHtmlCacheMtime = 0;

// ---------------------------------------------------------------------------
// Meta-tag injection.
//
// We always include both `og:*` and `twitter:*` tag families because the
// crawlers don't fall back from one to the other reliably (Twitter prefers
// twitter:* but accepts og:*; Discord wants og:*; Slack tries both). Cost
// of including both is ~300 bytes of HTML per response.
//
// Description copy is intentionally short — Twitter clips at ~200 chars in
// the card UI, longer text just wastes bytes. We mention the archetype
// (gives someone scrolling Twitter a hook) and the listening pathway.
// ---------------------------------------------------------------------------

export interface AtlasTokenMeta {
  tokenId: number;
  glyph: string;
}

export interface AtlasMetaOptions {
  /**
   * When true, the meta block also advertises `og:video` pointing at the
   * MP4 endpoint. Set this from the bridge only after confirming the MP4
   * exists on disk (otherwise crawlers like Facebook will request the
   * video and report a broken share preview when it 404s). For Twitter
   * cards the og:video field is largely cosmetic — the only path to
   * inline playback on X today is the user attaching the .mp4 file
   * manually to their tweet, which is the "Download" button on Atlas.
   */
  includeVideo?: boolean;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function buildAtlasMetaTags(
  origin: string,
  token: AtlasTokenMeta | null,
  tokenId: number,
  options: AtlasMetaOptions = {},
): string {
  const url = `${origin}/atlas/${tokenId}`;
  if (!token) {
    // Token not yet in cache (cold start or invalid id). We still produce
    // a meta block so the share link looks intentional rather than blank —
    // it just falls back to a generic card. The crawler will re-fetch
    // later if the user retweets, by which time the cache is warm.
    const title = `Sonoglyph #${tokenId}`;
    const desc = 'A minted descent on Monad. Listen on Sonoglyph.';
    return renderMetaBlock({
      url,
      title,
      desc,
      image: `${origin}/og/${tokenId}.png`,
      video: options.includeVideo ? `${origin}/video/${tokenId}.mp4` : null,
    });
  }
  const a = analyzeGlyph(token.glyph);
  const archetype = a.archetype;
  const title = `Sonoglyph #${tokenId} — ${archetype}`;
  // Five-axis trait line, comma-separated. Reads naturally as a tagline
  // and gives the share preview a concrete fingerprint to differentiate
  // it from the next token.
  const desc =
    `A ${archetype} glyph composed on Monad. ` +
    `${a.traits.density} · ${a.traits.form} · ${a.traits.anchor} · ` +
    `${a.traits.lexicon} · ${a.traits.symmetry}. Listen on Sonoglyph.`;
  return renderMetaBlock({
    url,
    title,
    desc,
    image: `${origin}/og/${tokenId}.png`,
    video: options.includeVideo ? `${origin}/video/${tokenId}.mp4` : null,
  });
}

function renderMetaBlock(args: {
  url: string;
  title: string;
  desc: string;
  image: string;
  video: string | null;
}): string {
  const t = escapeAttr(args.title);
  const d = escapeAttr(args.desc);
  const i = escapeAttr(args.image);
  const u = escapeAttr(args.url);
  const tags: string[] = [
    `<meta property="og:url" content="${u}">`,
    `<meta property="og:type" content="${args.video ? 'video.other' : 'website'}">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:image" content="${i}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${i}">`,
  ];
  if (args.video) {
    const v = escapeAttr(args.video);
    tags.push(
      `<meta property="og:video" content="${v}">`,
      `<meta property="og:video:url" content="${v}">`,
      `<meta property="og:video:secure_url" content="${v}">`,
      `<meta property="og:video:type" content="video/mp4">`,
      `<meta property="og:video:width" content="1200">`,
      `<meta property="og:video:height" content="630">`,
    );
  }
  return tags.join('\n  ');
}

/**
 * Splice OG/Twitter meta tags into the SPA shell for a given tokenId.
 * Strips the existing `<title>` so the share preview matches the token
 * (rather than the static "Sonoglyph" page title).
 *
 * `videoReady` controls whether we advertise og:video — set this only
 * when the bridge has confirmed the MP4 exists on disk. Otherwise a
 * crawler will dereference and 404, which Facebook in particular treats
 * as a broken preview and refuses to retry for ~24 h.
 */
export async function renderAtlasHtml(
  origin: string,
  tokenId: number,
  token: AtlasTokenMeta | null,
  videoReady: boolean = false,
): Promise<string> {
  const shell = await loadIndexHtml();
  const meta = buildAtlasMetaTags(origin, token, tokenId, {
    includeVideo: videoReady,
  });
  const archetype = token ? analyzeGlyph(token.glyph).archetype : null;
  const newTitle = archetype
    ? `<title>Sonoglyph #${tokenId} — ${archetype}</title>`
    : `<title>Sonoglyph #${tokenId}</title>`;
  // Replace the existing title; inject meta just before </head>. Both
  // operations are tolerant of missing matches — if a future Vite build
  // emits a different shell shape, we still return something rather than
  // throwing.
  let out = shell.replace(/<title>[^<]*<\/title>/i, newTitle);
  if (!/<title>/i.test(out)) {
    // Title tag was missing entirely; append into head.
    out = out.replace(/<\/head>/i, `  ${newTitle}\n</head>`);
  }
  out = out.replace(/<\/head>/i, `  ${meta}\n</head>`);
  return out;
}

// ---------------------------------------------------------------------------
// PNG card renderer.
//
// Layout (1200×630):
//
//   ┌────────────────────────────────────────────────────────────┐
//   │  SONOGLYPH #123                                            │  ← top-left
//   │                                                            │
//   │                                                            │
//   │           [ ASCII GLYPH CENTERED, BRAND COLOR ]            │
//   │                                                            │
//   │                                                            │
//   │  CONSTELLATION                              sonoglyph.xyz  │  ← bottom row
//   │  sparse · drift · centered · rich · mirrored               │
//   └────────────────────────────────────────────────────────────┘
// ---------------------------------------------------------------------------

const COLORS = {
  bg: '#050507',
  brand: '#c9885b',
  muted: '#6a6660',
  faint: '#3a3a3e',
  text: '#d8d4cf',
};

interface SatoriNode {
  type: string;
  key?: string | number;
  props: Record<string, unknown> & { children?: unknown };
}

function el(
  type: string,
  style: Record<string, unknown>,
  children?: unknown,
): SatoriNode {
  // satori traverses children to render text. We allow either a string,
  // a single node, or an array — same shape React.createElement accepts.
  return { type, props: { style, children } };
}

export async function renderOgPng(input: AtlasTokenMeta): Promise<Buffer> {
  const a = analyzeGlyph(input.glyph);
  const font = await loadFont();

  const traitLine = [
    a.traits.density,
    a.traits.form,
    a.traits.anchor,
    a.traits.lexicon,
    a.traits.symmetry,
  ].join('  ·  ');

  const root: SatoriNode = el(
    'div',
    {
      width: '1200px',
      height: '630px',
      background: COLORS.bg,
      color: COLORS.text,
      fontFamily: 'JetBrains Mono',
      padding: '54px 60px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
    },
    [
      // Top row
      el(
        'div',
        {
          fontSize: 18,
          letterSpacing: '6px',
          color: COLORS.muted,
        },
        `SONOGLYPH #${input.tokenId}`,
      ),

      // Center glyph
      el(
        'div',
        {
          display: 'flex',
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
        },
        el(
          'div',
          {
            // pre formatting; satori treats whitespace literally when
            // whiteSpace=pre is set. Font size tuned so the 32-char wide
            // glyph occupies ~70% of the card width.
            whiteSpace: 'pre',
            fontSize: 28,
            lineHeight: 1.05,
            letterSpacing: '2px',
            color: COLORS.brand,
            textAlign: 'center',
          },
          input.glyph,
        ),
      ),

      // Bottom row: archetype + traits + URL
      el(
        'div',
        {
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
        },
        [
          el(
            'div',
            {
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            },
            [
              el(
                'div',
                {
                  fontSize: 38,
                  letterSpacing: '6px',
                  color: COLORS.brand,
                },
                a.archetype.toUpperCase(),
              ),
              el(
                'div',
                {
                  fontSize: 16,
                  letterSpacing: '2px',
                  color: COLORS.muted,
                },
                traitLine,
              ),
            ],
          ),
          el(
            'div',
            {
              fontSize: 16,
              letterSpacing: '4px',
              color: COLORS.faint,
            },
            'SONOGLYPH.XYZ',
          ),
        ],
      ),
    ],
  );

  // satori is permissive about the node shape (it accepts our minimal
  // SatoriNode form), but its public types require ReactNode. The double
  // cast is safe because we never instantiate a real React tree — satori
  // just walks .type / .props / .children. We avoid pulling @types/react
  // into the proxy dep graph for one cast.
  const svg = await satori(root as unknown as Parameters<typeof satori>[0], {
    width: 1200,
    height: 630,
    fonts: [
      {
        name: 'JetBrains Mono',
        data: font,
        weight: 400,
        style: 'normal',
      },
    ],
  });

  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
  })
    .render()
    .asPng();
  return png;
}

// ---------------------------------------------------------------------------
// Disk cache. Cache key is the tokenId — same id means same glyph means
// same PNG (the on-chain glyph string is immutable). We DO recompute if
// the cached file is older than the bundled classifier, which guards us
// against stale cards when we calibrate against the final 250-token corpus
// (the archetype assignment can shift). The bridge bumps OG_CACHE_VERSION
// in env when that happens; mismatched files in the cache dir are ignored.
// ---------------------------------------------------------------------------

const CACHE_VERSION = process.env.OG_CACHE_VERSION ?? 'v1';

function cachePath(tokenId: number): string {
  return path.join(CACHE_DIR, `${CACHE_VERSION}-${tokenId}.png`);
}

export async function getOrRenderOgPng(input: AtlasTokenMeta): Promise<Buffer> {
  const p = cachePath(input.tokenId);
  try {
    const cached = await readFile(p);
    return cached;
  } catch {
    /* fall through to render */
  }
  const png = await renderOgPng(input);
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(p, png);
  } catch (err) {
    // Cache write is best-effort. A read-only filesystem or a perms
    // mismatch will cause every request to re-render, which is fine for
    // correctness — we just log and move on.
    console.warn(
      `[og] cache write failed at ${p}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return png;
}
