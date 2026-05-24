#!/usr/bin/env node
/**
 * Recalibrate the rarity classifier's quantile snapshot.
 *
 * What it does
 * ------------
 * 1. Pulls every minted Sonoglyph from Monad mainnet (descentOf(id) via
 *    public RPC — no key needed).
 * 2. Recomputes the five-axis metrics for each glyph using the same
 *    formulas as web/src/lib/glyphRarity.ts (kept in sync by mirroring
 *    here — these scripts are short enough that duplication beats a
 *    Node import path that would have to reach across web/ and ts).
 * 3. Derives quantile cut-points and trait-bucket counts.
 * 4. Prints a ready-to-paste `CALIBRATION = { … }` block.
 *
 * When to run
 * -----------
 * - After every ~30 new mints, if you care that buckets stay tight.
 * - Definitely once when the contract hits MAX_SUPPLY (250) — that's the
 *   final calibration; lock it in and never touch again.
 *
 * Why this is a script, not an automatic refresh
 * ----------------------------------------------
 * A glyph's bucket label is shown to the holder. Drifting it silently as
 * more mints arrive feels disrespectful. Recalibrating is a deliberate
 * authoring step: the operator decides "the corpus changed enough that
 * the labels should refresh", regenerates, reviews, commits.
 *
 * Usage
 * -----
 *   node scripts/recalibrate-rarity.mjs
 *
 * The script reads no env vars. The contract address is hard-coded so a
 * misconfigured local shell can't accidentally calibrate against a fork
 * or testnet deployment.
 */

import { createPublicClient, defineChain, http } from 'viem';

// -- Chain / contract config (mirror of proxy/src/chain.ts mainnet) ----------

const monad = defineChain({
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } },
});

// Hard-coded for safety — see header comment.
const CONTRACT = '0xeC7e04c7d86824CE3F0d7eD3d367c20C7Be47f35';

const ABI = [
  {
    type: 'function',
    name: 'lastTokenId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'MAX_SUPPLY',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'descentOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'glyph', type: 'string' },
          { name: 'journal', type: 'string' },
          { name: 'audioCid', type: 'string' },
          { name: 'sessionCode', type: 'string' },
          { name: 'creator', type: 'address' },
          { name: 'mintedAt', type: 'uint64' },
        ],
      },
    ],
  },
];

// -- Mirrored metric extraction (must match web/src/lib/glyphRarity.ts) ------

const ROWS = 16;
const COLS = 32;

function normalize(glyph) {
  const lines = glyph.split('\n').slice(0, ROWS);
  while (lines.length < ROWS) lines.push('');
  return lines.map((l) => l.padEnd(COLS, ' ').slice(0, COLS));
}

function metrics(glyph) {
  const rows = normalize(glyph);

  let nonSpace = 0;
  const chars = new Set();
  for (const r of rows) for (const c of r) {
    if (c !== ' ') { nonSpace++; chars.add(c); }
  }
  const density = nonSpace / (ROWS * COLS);

  const widths = rows.map((r) => {
    const l = r.search(/\S/);
    if (l < 0) return 0;
    const rev = r.split('').reverse().join('').search(/\S/);
    return (r.length - 1 - rev) - l + 1;
  });
  const mean = widths.reduce((a, b) => a + b, 0) / ROWS;
  const silhouette = Math.sqrt(
    widths.reduce((a, b) => a + (b - mean) ** 2, 0) / ROWS,
  );

  let sumY = 0;
  let n = 0;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (rows[y][x] !== ' ') { sumY += y; n++; }
  }
  const centroidY = n > 0 ? sumY / n : ROWS / 2;

  let vM = 0, vT = 0;
  for (let i = 0; i < ROWS / 2; i++) {
    for (let c = 0; c < COLS; c++) {
      const top = rows[i][c] !== ' ';
      const bot = rows[ROWS - 1 - i][c] !== ' ';
      if (top || bot) { if (top === bot) vM++; vT++; }
    }
  }
  let hM = 0, hT = 0;
  for (const r of rows) {
    for (let c = 0; c < COLS / 2; c++) {
      const lf = r[c] !== ' ';
      const rt = r[COLS - 1 - c] !== ' ';
      if (lf || rt) { if (lf === rt) hM++; hT++; }
    }
  }
  const vSym = vT > 0 ? vM / vT : 0;
  const hSym = hT > 0 ? hM / hT : 0;
  const symmetry = Math.max(vSym, hSym);

  return { density, silhouette, uniqueChars: chars.size, centroidY, symmetry };
}

// -- Bucket assignment (mirror of glyphRarity.ts) ----------------------------

const DENSITY = ['Whisper', 'Sparse', 'Balanced', 'Dense', 'Saturated'];
const FORM = ['Block', 'Spine', 'Drift', 'Sculpture', 'Apparition'];
const ANCHOR = ['Crown', 'Rising', 'Centered', 'Diving', 'Floor'];
const SYMMETRY = ['Skewed', 'Echoed', 'Mirrored'];

function bucket(v, cuts, labels) {
  for (let i = 0; i < cuts.length; i++) if (v < cuts[i]) return labels[i];
  return labels[labels.length - 1];
}
function lexicon(n) {
  if (n <= 5) return 'Monolith';
  if (n <= 9) return 'Spare';
  if (n <= 12) return 'Rich';
  return 'Polyglot';
}

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)];
}

// -- Main --------------------------------------------------------------------

const client = createPublicClient({ chain: monad, transport: http() });

const [lastId, maxSupply] = await Promise.all([
  client.readContract({ address: CONTRACT, abi: ABI, functionName: 'lastTokenId' }),
  client.readContract({ address: CONTRACT, abi: ABI, functionName: 'MAX_SUPPLY' }),
]);
const N = Number(lastId);
console.error(`Fetching ${N} glyphs from ${CONTRACT}…`);

// Public Monad RPC rate-limits at ~5–10 reqs/sec. We batch with a small
// inter-batch sleep + per-id retry-on-429 so a fresh calibration completes
// without losing tokens. Missing even a handful biases the frequency table.
async function fetchOne(id, attempt = 1) {
  try {
    return await client.readContract({
      address: CONTRACT,
      abi: ABI,
      functionName: 'descentOf',
      args: [BigInt(id)],
    });
  } catch (err) {
    const msg = err?.message ?? '';
    const is429 = msg.includes('429');
    if (is429 && attempt < 6) {
      const backoff = 500 * 2 ** (attempt - 1); // 0.5s, 1s, 2s, 4s, 8s
      await new Promise((r) => setTimeout(r, backoff));
      return fetchOne(id, attempt + 1);
    }
    throw err;
  }
}

const glyphs = [];
const BATCH = 10; // half of before; trades wall time for stability
for (let s = 1; s <= N; s += BATCH) {
  const ids = [];
  for (let i = s; i < s + BATCH && i <= N; i++) ids.push(i);
  const results = await Promise.allSettled(ids.map((id) => fetchOne(id)));
  for (let i = 0; i < ids.length; i++) {
    if (results[i].status === 'fulfilled') {
      glyphs.push(results[i].value.glyph);
    } else {
      console.error(`#${ids[i]} fetch failed after retries: ${results[i].reason?.message?.slice(0, 80)}`);
    }
  }
  console.error(`  fetched ${Math.min(s + BATCH - 1, N)}/${N}`);
  // Tiny pause between batches to stay below the per-second limit even
  // when retries don't kick in.
  await new Promise((r) => setTimeout(r, 150));
}

if (glyphs.length < N) {
  console.error(
    `\nWARNING: ${N - glyphs.length} glyph(s) missing — calibration biased. Re-run.`,
  );
}

const metricsList = glyphs.map(metrics);

const breaks5 = [0.10, 0.30, 0.70, 0.90];
const breaks3 = [0.30, 0.70];

const densityCuts = breaks5.map((b) => quantile(metricsList.map((m) => m.density), b));
const silhouetteCuts = breaks5.map((b) => quantile(metricsList.map((m) => m.silhouette), b));
const centroidYCuts = breaks5.map((b) => quantile(metricsList.map((m) => m.centroidY), b));
const symmetryCuts = breaks3.map((b) => quantile(metricsList.map((m) => m.symmetry), b));

const freqs = {
  density: { Whisper: 0, Sparse: 0, Balanced: 0, Dense: 0, Saturated: 0 },
  form: { Block: 0, Spine: 0, Drift: 0, Sculpture: 0, Apparition: 0 },
  anchor: { Crown: 0, Rising: 0, Centered: 0, Diving: 0, Floor: 0 },
  lexicon: { Monolith: 0, Spare: 0, Rich: 0, Polyglot: 0 },
  symmetry: { Skewed: 0, Echoed: 0, Mirrored: 0 },
};
for (const m of metricsList) {
  freqs.density[bucket(m.density, densityCuts, DENSITY)]++;
  freqs.form[bucket(m.silhouette, silhouetteCuts, FORM)]++;
  freqs.anchor[bucket(m.centroidY, centroidYCuts, ANCHOR)]++;
  freqs.lexicon[lexicon(m.uniqueChars)]++;
  freqs.symmetry[bucket(m.symmetry, symmetryCuts, SYMMETRY)]++;
}

const fmt2 = (n) => Number(n.toFixed(2));
const today = new Date().toISOString().slice(0, 10);

console.error(`\nCalibrated against n=${metricsList.length}. Paste this into web/src/lib/glyphRarity.ts:\n`);

const out = `export const CALIBRATION = {
  calibratedAt: '${today}',
  sampleSize: ${metricsList.length},
  contractMaxSupply: ${Number(maxSupply)},
  thresholds: {
    density: [${densityCuts.map(fmt2).join(', ')}],
    silhouette: [${silhouetteCuts.map(fmt2).join(', ')}],
    centroidY: [${centroidYCuts.map(fmt2).join(', ')}],
    symmetry: [${symmetryCuts.map(fmt2).join(', ')}],
  },
  frequencies: {
    density: ${JSON.stringify(freqs.density)},
    form: ${JSON.stringify(freqs.form)},
    anchor: ${JSON.stringify(freqs.anchor)},
    lexicon: ${JSON.stringify(freqs.lexicon)},
    symmetry: ${JSON.stringify(freqs.symmetry)},
  },
} as const;`;

console.log(out);
