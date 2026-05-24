/**
 * On-chain minter — viem wrapper around the Sonoglyph ERC-721 deployed on
 * Monad mainnet (chain id 143). MONAD_CHAIN_ID can override to testnet
 * (10143) for local dev / replay; default is mainnet.
 *
 * The bridge holds DEPLOYER_PRIVATE_KEY (which is the contract's owner) and
 * is therefore the ONLY address authorized to call mintDescent. Players
 * never sign anything — they just tell us "here's where to send my
 * Sonoglyph", and we do the rest. Trade-off documented in the contract
 * README: trustful, curated, but every minted token is provably from a
 * real descent the bridge witnessed end-to-end.
 *
 * Contract enforces a lifetime supply cap of 250 tokens AND a one-mint-
 * per-address rule. Both are checked inside mintDescent and surface as
 * revert reasons "max supply" / "already minted" — viem catches them
 * during simulateContract below; the message propagates up to the /mint
 * handler in index.ts, which currently returns 500 with the message in
 * the body. Frontend's Finale panel surfaces the revert reason verbatim,
 * so the player sees the specific cause.
 *
 * Lazy init: we don't construct the wallet client until /mint is first
 * called. That way the bridge starts cleanly even before the operator has
 * filled in DEPLOYER_PRIVATE_KEY / SONOGLYPH_CONTRACT_ADDRESS — the
 * /health endpoint just reports the missing keys instead of crash-looping
 * the systemd unit.
 */

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  isAddress,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Minimal ABI — only the entry points the bridge actually needs. Keeping
// it inline (rather than reading from contracts/out/*.json) means the
// bridge build doesn't depend on a `forge build` having run first.
export const SONOGLYPH_ABI = [
  {
    type: 'function',
    name: 'mintDescent',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'to', type: 'address'},
      {name: 'glyph', type: 'string'},
      {name: 'journal', type: 'string'},
      {name: 'audioCid', type: 'string'},
      {name: 'sessionCode', type: 'string'},
    ],
    outputs: [{name: 'tokenId', type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'lastTokenId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{name: '', type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'MAX_SUPPLY',
    stateMutability: 'view',
    inputs: [],
    outputs: [{name: '', type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'descentOf',
    stateMutability: 'view',
    inputs: [{name: 'tokenId', type: 'uint256'}],
    outputs: [
      {
        type: 'tuple',
        components: [
          {name: 'glyph', type: 'string'},
          {name: 'journal', type: 'string'},
          {name: 'audioCid', type: 'string'},
          {name: 'sessionCode', type: 'string'},
          {name: 'creator', type: 'address'},
          {name: 'mintedAt', type: 'uint64'},
        ],
      },
    ],
  },
  {
    type: 'event',
    name: 'DescentMinted',
    inputs: [
      {indexed: true, name: 'tokenId', type: 'uint256'},
      {indexed: true, name: 'to', type: 'address'},
      {indexed: false, name: 'sessionCode', type: 'string'},
      {indexed: false, name: 'audioCid', type: 'string'},
    ],
  },
] as const;

// Two Monad networks defined inline because viem doesn't ship built-ins
// yet (mainnet launched recently, testnet still ahead of the release
// cadence). We pick between them at runtime from MONAD_CHAIN_ID.
const monadMainnet = /*#__PURE__*/ defineChain({
  id: 143,
  name: 'Monad',
  nativeCurrency: {name: 'Monad', symbol: 'MON', decimals: 18},
  rpcUrls: {
    default: {http: ['https://rpc.monad.xyz']},
  },
  blockExplorers: {
    default: {
      name: 'Monad Explorer',
      url: 'https://monadexplorer.com',
    },
  },
});

const monadTestnet = /*#__PURE__*/ defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: {name: 'Monad', symbol: 'MON', decimals: 18},
  rpcUrls: {
    default: {http: ['https://testnet-rpc.monad.xyz']},
  },
  blockExplorers: {
    default: {
      name: 'Monad Testnet Explorer',
      url: 'https://testnet.monadexplorer.com',
    },
  },
  testnet: true,
});

/**
 * Resolve the active chain from env. If MONAD_CHAIN_ID is set we pick by
 * id; otherwise default to mainnet (we're past the deploy-on-testnet
 * phase). Throws on unknown ids so a typo in .env doesn't silently fall
 * back to a default.
 */
function pickChain(): Chain {
  const raw = process.env.MONAD_CHAIN_ID;
  if (!raw) return monadMainnet;
  const id = Number.parseInt(raw, 10);
  if (id === monadMainnet.id) return monadMainnet;
  if (id === monadTestnet.id) return monadTestnet;
  throw new Error(`unknown MONAD_CHAIN_ID: ${raw} (expected 143 or 10143)`);
}

interface ChainContext {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
  contractAddress: `0x${string}`;
}

let cached: ChainContext | null = null;

function loadContext(): ChainContext {
  if (cached) return cached;

  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  const contractAddress = process.env.SONOGLYPH_CONTRACT_ADDRESS;
  const chain = pickChain();
  const rpcUrl =
    process.env.MONAD_RPC_URL ?? chain.rpcUrls.default.http[0];

  if (!pk) {
    throw new Error('DEPLOYER_PRIVATE_KEY not set');
  }
  if (!contractAddress || !isAddress(contractAddress)) {
    throw new Error(
      `SONOGLYPH_CONTRACT_ADDRESS not set or invalid (${contractAddress ?? '<empty>'})`,
    );
  }

  // viem expects 0x-prefixed hex for the private key. Accept both forms.
  const pkHex: Hex = (pk.startsWith('0x') ? pk : `0x${pk}`) as Hex;
  const account = privateKeyToAccount(pkHex);

  // RPC url override goes through both clients so tests / forks can swap it.
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({chain, transport});
  const walletClient = createWalletClient({
    chain,
    transport,
    account,
  });

  cached = {
    publicClient,
    walletClient,
    account,
    contractAddress: contractAddress as `0x${string}`,
  };
  return cached;
}

export interface MintArgs {
  to: `0x${string}`;
  glyph: string;
  journal: string;
  audioCid: string;
  sessionCode: string;
}

export interface MintResult {
  tokenId: string;
  txHash: `0x${string}`;
  blockNumber: bigint;
  gasUsed: bigint;
  contractAddress: `0x${string}`;
  chainId: number;
}

/**
 * Sign + broadcast a {@link Sonoglyph.mintDescent} call from the bridge's
 * wallet, wait for inclusion, and parse the DescentMinted log to recover
 * the new tokenId.
 *
 * Throws on:
 *   - missing/invalid env vars (DEPLOYER_PRIVATE_KEY, contract address)
 *   - simulation failure (e.g. caller is not the contract owner — only the
 *     bridge's own wallet should be calling, but this guards against
 *     misconfiguration where SONOGLYPH_CONTRACT_ADDRESS points at a
 *     contract owned by a different account)
 *   - tx revert on chain
 *   - inability to find the DescentMinted log in the receipt
 */
export async function mintSonoglyph(args: MintArgs): Promise<MintResult> {
  const ctx = loadContext();

  // Simulate first so we get the would-be return value (tokenId) AND a
  // human-readable revert reason if the call would fail. This is also how
  // viem builds up the request that writeContract sends — re-using its
  // output skips a redundant eth_call when we go to write.
  const {request, result: simulatedTokenId} = await ctx.publicClient.simulateContract({
    address: ctx.contractAddress,
    abi: SONOGLYPH_ABI,
    functionName: 'mintDescent',
    args: [args.to, args.glyph, args.journal, args.audioCid, args.sessionCode],
    account: ctx.account,
  });

  const txHash = await ctx.walletClient.writeContract(request);

  // Wait for inclusion. Monad testnet has fast blocks (~0.5 s) so this
  // typically resolves in ~1 receipt poll. Bumping confirmations would only
  // add latency on a chain with no reorgs.
  const receipt = await ctx.publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });

  if (receipt.status !== 'success') {
    throw new Error(`mint reverted on chain (tx ${txHash})`);
  }

  // Recover tokenId from the DescentMinted event. Falls back to the
  // simulated value if the log can't be parsed (shouldn't happen if the
  // ABI matches, but keeps us robust).
  let tokenId = simulatedTokenId.toString();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ctx.contractAddress.toLowerCase()) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: SONOGLYPH_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'DescentMinted') {
        tokenId = (decoded.args.tokenId as bigint).toString();
        break;
      }
    } catch {
      // Not the event we're looking for; skip.
    }
  }

  return {
    tokenId,
    txHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    contractAddress: ctx.contractAddress,
    chainId: ctx.walletClient.chain?.id ?? pickChain().id,
  };
}

/**
 * Supply snapshot — calls `lastTokenId()` and `MAX_SUPPLY()` on the live
 * contract. Used by the /supply endpoint that powers the Finale screen's
 * "EDITION X / 250" counter. The Promise.all keeps both reads in one
 * round-trip to the RPC; both are pure view calls.
 *
 * MAX_SUPPLY is a constant in the deployed bytecode, so it never changes.
 * lastTokenId increments on every successful mint. The /supply endpoint
 * caches the result for a short window so the Finale screen doesn't
 * hammer the RPC if multiple players reach the mint screen simultaneously.
 */
export async function getSupplyInfo(): Promise<{ minted: number; max: number }> {
  const ctx = loadContext();
  const [minted, max] = await Promise.all([
    ctx.publicClient.readContract({
      address: ctx.contractAddress,
      abi: SONOGLYPH_ABI,
      functionName: 'lastTokenId',
    }),
    ctx.publicClient.readContract({
      address: ctx.contractAddress,
      abi: SONOGLYPH_ABI,
      functionName: 'MAX_SUPPLY',
    }),
  ]);
  return {
    minted: Number(minted),
    max: Number(max),
  };
}

/**
 * One entry in the full collection — what `/collection` returns per token.
 *
 * The journal isn't included even though `descentOf` returns it: the atlas
 * page renders thumbnails + ranks, and full prose for ~250 tokens would
 * inflate the payload from ~150 KB to ~600 KB without UI benefit. The
 * detail modal pulls the full descent via a separate read if needed.
 */
export interface DescentSummary {
  tokenId: number;
  glyph: string;
  sessionCode: string;
  creator: `0x${string}`;
  mintedAt: number;
  audioCid: string;
}

/**
 * Fetch every minted Sonoglyph from the contract by walking `descentOf` for
 * tokenIds 1..lastTokenId. Used by the /collection endpoint to feed the
 * atlas page.
 *
 * Why not events: `DescentMinted` carries tokenId + to + sessionCode +
 * audioCid but NOT the glyph string, so we'd need a per-token read anyway.
 * One scan call per token is the cheapest path that surfaces the glyph.
 *
 * Rate-limit shape (mirrors scripts/recalibrate-rarity.mjs):
 *   - Batch size 10 in parallel, 150 ms pause between batches.
 *   - Per-token retry on HTTP 429 with exponential backoff (0.5/1/2/4/8 s).
 *   - Tokens that still fail after 5 retries are silently dropped from the
 *     result; we log them so the operator can re-run if too many leak.
 *
 * The full scan is slow (~30 s at 250 tokens on the public RPC), which is
 * why /collection caches aggressively in front of this call.
 */
export async function fetchAllDescents(): Promise<DescentSummary[]> {
  const ctx = loadContext();
  const lastId = (await ctx.publicClient.readContract({
    address: ctx.contractAddress,
    abi: SONOGLYPH_ABI,
    functionName: 'lastTokenId',
  })) as bigint;
  const N = Number(lastId);
  if (N === 0) return [];

  console.log(`[collection] scanning ${N} tokens…`);

  const fetchOne = async (id: number, attempt = 1): Promise<DescentSummary | null> => {
    try {
      const d = (await ctx.publicClient.readContract({
        address: ctx.contractAddress,
        abi: SONOGLYPH_ABI,
        functionName: 'descentOf',
        args: [BigInt(id)],
      })) as {
        glyph: string;
        journal: string;
        audioCid: string;
        sessionCode: string;
        creator: `0x${string}`;
        mintedAt: bigint;
      };
      return {
        tokenId: id,
        glyph: d.glyph,
        sessionCode: d.sessionCode,
        creator: d.creator,
        mintedAt: Number(d.mintedAt),
        audioCid: d.audioCid,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const is429 = msg.includes('429');
      if (is429 && attempt < 6) {
        // 0.5, 1, 2, 4, 8 seconds.
        const backoff = 500 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
        return fetchOne(id, attempt + 1);
      }
      console.warn(`[collection] token #${id} failed: ${msg.slice(0, 100)}`);
      return null;
    }
  };

  const out: DescentSummary[] = [];
  const BATCH = 10;
  for (let s = 1; s <= N; s += BATCH) {
    const ids: number[] = [];
    for (let i = s; i < s + BATCH && i <= N; i++) ids.push(i);
    const results = await Promise.all(ids.map((id) => fetchOne(id)));
    for (const r of results) if (r) out.push(r);
    // Tiny inter-batch pause to stay under the public RPC's per-second
    // limit even when no individual call hit 429.
    await new Promise((r) => setTimeout(r, 150));
  }

  const dropped = N - out.length;
  if (dropped > 0) {
    console.warn(`[collection] scan dropped ${dropped}/${N} tokens after retries`);
  }
  return out;
}

/**
 * Single-token variant of {@link fetchAllDescents}. Used by /og/:id.png and
 * /atlas/:id when the bridge's full-collection cache is cold and we'd
 * rather spend 1 RPC call than 30 s of full-scan time. Returns null if
 * the token doesn't exist or the chain call exhausts retries.
 *
 * Backoff mirrors fetchAllDescents (0.5/1/2/4/8 s) so we get the same
 * retry envelope without duplicating the policy.
 */
export async function fetchOneDescent(id: number): Promise<DescentSummary | null> {
  if (!Number.isFinite(id) || id <= 0) return null;
  const ctx = loadContext();
  const attemptOnce = async (attempt: number): Promise<DescentSummary | null> => {
    try {
      const d = (await ctx.publicClient.readContract({
        address: ctx.contractAddress,
        abi: SONOGLYPH_ABI,
        functionName: 'descentOf',
        args: [BigInt(id)],
      })) as {
        glyph: string;
        journal: string;
        audioCid: string;
        sessionCode: string;
        creator: `0x${string}`;
        mintedAt: bigint;
      };
      // descentOf returns the zero struct for non-existent ids on this
      // contract (no revert). A zero mintedAt is our "token absent" tell.
      if (Number(d.mintedAt) === 0) return null;
      return {
        tokenId: id,
        glyph: d.glyph,
        sessionCode: d.sessionCode,
        creator: d.creator,
        mintedAt: Number(d.mintedAt),
        audioCid: d.audioCid,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const is429 = msg.includes('429');
      if (is429 && attempt < 6) {
        const backoff = 500 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
        return attemptOnce(attempt + 1);
      }
      console.warn(`[og] descentOf(#${id}) failed: ${msg.slice(0, 120)}`);
      return null;
    }
  };
  return attemptOnce(1);
}

/** Used by /health to surface mint-readiness. Doesn't hit the chain. */
export function chainConfigStatus(): {
  hasPrivateKey: boolean;
  hasContract: boolean;
  contractAddress: string | null;
  rpcUrl: string;
  chainId: number;
} {
  const contractRaw = process.env.SONOGLYPH_CONTRACT_ADDRESS ?? null;
  // Don't crash on a misconfigured MONAD_CHAIN_ID — /health should still
  // come up so the operator can see the bad value and fix it.
  let chain;
  try {
    chain = pickChain();
  } catch {
    chain = monadMainnet;
  }
  const rpcUrl = process.env.MONAD_RPC_URL ?? chain.rpcUrls.default.http[0];
  return {
    hasPrivateKey: Boolean(process.env.DEPLOYER_PRIVATE_KEY),
    hasContract: Boolean(contractRaw && isAddress(contractRaw)),
    contractAddress: contractRaw,
    rpcUrl,
    chainId: chain.id,
  };
}
