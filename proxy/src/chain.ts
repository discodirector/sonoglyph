/**
 * On-chain minter — viem wrapper around the Sonoglyph ERC-721 deployed on
 * Monad testnet.
 *
 * The bridge holds DEPLOYER_PRIVATE_KEY (which is the contract's owner) and
 * is therefore the ONLY address authorized to call mintDescent. Players
 * never sign anything — they just tell us "here's where to send my
 * Sonoglyph", and we do the rest. Trade-off documented in the contract
 * README: trustful, curated, but every minted token is provably from a
 * real descent the bridge witnessed end-to-end.
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
