import { useEffect, useState } from 'react';
import { isAddress } from 'viem';
import { useSession } from '../state/useSession';
import { mintDescent, fetchSupply } from '../net/client';

/**
 * Finale screen — shown after the final layer (MAX_LAYERS).
 *
 * Layout (top → bottom):
 *   - "DESCENT COMPLETE" caption
 *   - the ASCII glyph (the visual focal point)
 *   - the journal in italic prose
 *   - "TRANSCRIBED BY KIMI / OFFLINE TRANSCRIPT" credit
 *   - PinStatus    — IPFS pin progress for the WebM recording
 *   - MintPanel    — mint the descent as an ERC-721 on Monad testnet
 *                    (only renders once the pin lands, since mintDescent
 *                    needs the audioCid the bridge stores after pinning)
 *
 * The bridge is the contract's sole minter, so the player doesn't sign
 * anything or hold testnet MON — they just paste a recipient address (or
 * pull it from window.ethereum) and the bridge does the rest. Player only
 * gets one token per session: the GameSession on the bridge locks
 * after the first successful mint.
 */
export function Finale() {
  const artifact = useSession((s) => s.artifact);
  const audioCid = useSession((s) => s.audioCid);
  const audioPinStatus = useSession((s) => s.audioPinStatus);
  const audioPinError = useSession((s) => s.audioPinError);
  const setSupply = useSession((s) => s.setSupply);

  // One-shot supply fetch on mount. The bridge caches for 15 s so this is
  // cheap; we just want a snapshot the moment the player lands on Finale.
  // Failures are silent — the UI hides the counter when supplyMinted is
  // null, and the contract enforces the cap regardless of UI hints.
  useEffect(() => {
    let cancelled = false;
    void fetchSupply()
      .then((s) => {
        if (!cancelled) setSupply(s.minted, s.max);
      })
      .catch((err) => {
        console.warn('[finale] supply fetch failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [setSupply]);

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
        padding: '40px 24px',
        pointerEvents: 'auto',
        color: '#d8d4cf',
        background:
          'linear-gradient(to bottom, rgba(5,5,7,0.4) 0%, rgba(5,5,7,0.92) 100%)',
        // The mint panel can grow when error text wraps, so let the column
        // scroll on tiny viewports rather than clipping the button.
        overflowY: 'auto',
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

      {/* Mint panel only mounts once we have a pinned CID — the bridge needs
          it to fill audioCid in the on-chain Descent struct. */}
      {audioPinStatus === 'pinned' && <MintPanel />}
    </div>
  );
}

// -----------------------------------------------------------------------------
// PinStatus — IPFS preservation indicator under the journal credit.
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// MintPanel — recipient address input + mint button + result. The bridge
// holds the contract owner key and signs/broadcasts mintDescent, so the
// player does NOT need a wallet, MON, or chain switching — they just say
// where the token should land. Auto-fill from window.ethereum.eth_accounts
// when available so connected-wallet users don't have to paste.
// -----------------------------------------------------------------------------

function MintPanel() {
  const code = useSession((s) => s.pairing?.code ?? null);
  const mintStatus = useSession((s) => s.mintStatus);
  const mintTokenId = useSession((s) => s.mintTokenId);
  const mintTxHash = useSession((s) => s.mintTxHash);
  const mintContractAddress = useSession((s) => s.mintContractAddress);
  const mintChainId = useSession((s) => s.mintChainId);
  const mintError = useSession((s) => s.mintError);
  const supplyMinted = useSession((s) => s.supplyMinted);
  const supplyMax = useSession((s) => s.supplyMax);
  const setMintPending = useSession((s) => s.setMintPending);
  const setMintSuccess = useSession((s) => s.setMintSuccess);
  const setMintError = useSession((s) => s.setMintError);
  const bumpSupplyMinted = useSession((s) => s.bumpSupplyMinted);

  const [recipient, setRecipient] = useState('');
  const [walletNote, setWalletNote] = useState<string | null>(null);

  // Edition counter — null until /supply resolves. Once both numbers are
  // present, we know whether the series is exhausted (250 / 250). The
  // contract reverts with "max supply" past that point, so we show a
  // dedicated panel instead of the recipient input + button.
  const supplyKnown = supplyMinted != null && supplyMax != null;
  const exhausted =
    supplyKnown && (supplyMinted as number) >= (supplyMax as number);

  // Silent auto-fill: ask window.ethereum for already-authorized accounts.
  // `eth_accounts` does NOT prompt — it returns [] if the user hasn't
  // previously connected, which is exactly what we want for a passive
  // pre-fill. `eth_requestAccounts` (below) is the explicit opt-in path.
  useEffect(() => {
    const eth = (window as unknown as { ethereum?: EthereumProvider }).ethereum;
    if (!eth?.request) return;
    let cancelled = false;
    void eth
      .request({ method: 'eth_accounts' })
      .then((accounts) => {
        if (cancelled) return;
        if (Array.isArray(accounts) && accounts.length > 0) {
          const first = accounts[0];
          if (typeof first === 'string' && isAddress(first)) {
            setRecipient(first);
          }
        }
      })
      .catch(() => {
        /* ignore — provider just doesn't support this method */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isValid = isAddress(recipient.trim());
  const trimmed = recipient.trim();

  // ---- Success state ----
  if (mintStatus === 'minted' && mintTokenId && mintTxHash) {
    return (
      <MintSuccess
        tokenId={mintTokenId}
        txHash={mintTxHash}
        contractAddress={mintContractAddress}
        chainId={mintChainId}
        supplyMax={supplyMax}
      />
    );
  }

  const onUseWallet = async () => {
    const eth = (window as unknown as { ethereum?: EthereumProvider }).ethereum;
    if (!eth?.request) {
      setWalletNote('No wallet detected in this browser');
      return;
    }
    try {
      const accounts = await eth.request({ method: 'eth_requestAccounts' });
      if (Array.isArray(accounts) && accounts.length > 0) {
        const first = accounts[0];
        if (typeof first === 'string' && isAddress(first)) {
          setRecipient(first);
          setWalletNote(null);
          return;
        }
      }
      setWalletNote('Wallet returned no usable address');
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setWalletNote(m.slice(0, 100));
    }
  };

  const onMint = async () => {
    if (!code || !isValid) return;
    setMintPending();
    try {
      const result = await mintDescent(code, trimmed);
      setMintSuccess(result);
      // Optimistic +1 on the visible counter — only when the bridge actually
      // broadcast a new tx. `cached: true` means the bridge replayed an
      // already-stored result (page refresh / retry), in which case the
      // /supply we fetched on Finale mount already includes that mint.
      if (!result.cached) bumpSupplyMinted();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setMintError(m);
    }
  };

  const pending = mintStatus === 'pending';

  // ---- Exhausted state ----
  // Series is sold out. Mint button hidden; contract would revert anyway.
  // We still show the edition counter so the player understands why.
  if (exhausted) {
    return (
      <div
        style={{
          marginTop: 4,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          maxWidth: 520,
          width: '100%',
          fontFamily: 'ui-monospace, Menlo, monospace',
        }}
      >
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.3em',
            color: '#6a6660',
          }}
        >
          EDITION · {supplyMinted} / {supplyMax}
        </div>
        <div
          style={{
            fontSize: 13,
            letterSpacing: '0.18em',
            color: '#c9885b',
            textTransform: 'uppercase',
            marginTop: 6,
          }}
        >
          Edition complete
        </div>
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.05em',
            color: '#a09d99',
            textAlign: 'center',
            maxWidth: 420,
            lineHeight: 1.6,
          }}
        >
          The 250-token series has been fully minted. Your descent is
          recorded — the audio CID and journal are above. The on-chain
          edition is closed.
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: 4,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        maxWidth: 520,
        width: '100%',
      }}
    >
      {supplyKnown && (
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.3em',
            color: '#6a6660',
            fontFamily: 'ui-monospace, Menlo, monospace',
          }}
        >
          EDITION · {supplyMinted} / {supplyMax}
        </div>
      )}

      <div
        style={{
          fontSize: 10,
          letterSpacing: '0.3em',
          color: '#6a6660',
          fontFamily: 'ui-monospace, Menlo, monospace',
        }}
      >
        MINT TO ADDRESS
      </div>

      <div style={{ display: 'flex', gap: 6, width: '100%' }}>
        <input
          type="text"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          disabled={pending}
          style={{
            flex: 1,
            padding: '10px 12px',
            background: 'rgba(255,255,255,0.04)',
            border: `1px solid ${
              recipient && !isValid ? '#c97a5b' : '#2a2a2e'
            }`,
            color: '#d8d4cf',
            fontFamily: 'ui-monospace, Menlo, monospace',
            fontSize: 12,
            letterSpacing: '0.04em',
            outline: 'none',
            borderRadius: 0,
          }}
        />
        <button
          type="button"
          onClick={onUseWallet}
          disabled={pending}
          title="Pull address from injected wallet (e.g. MetaMask)"
          style={{
            padding: '8px 12px',
            background: 'transparent',
            border: '1px solid #3a3a3e',
            color: '#a09d99',
            fontSize: 9,
            letterSpacing: '0.25em',
            fontFamily: 'inherit',
            cursor: pending ? 'default' : 'pointer',
            textTransform: 'uppercase',
            opacity: pending ? 0.4 : 1,
          }}
        >
          USE WALLET
        </button>
      </div>

      {walletNote && (
        <div style={{ fontSize: 10, color: '#c97a5b', letterSpacing: '0.05em' }}>
          {walletNote}
        </div>
      )}

      <button
        type="button"
        onClick={onMint}
        disabled={!isValid || pending}
        style={{
          padding: '12px 28px',
          marginTop: 4,
          background: isValid && !pending ? '#d8d4cf' : 'transparent',
          color: isValid && !pending ? '#050507' : '#3a3a3e',
          border: `1px solid ${isValid && !pending ? '#d8d4cf' : '#3a3a3e'}`,
          letterSpacing: '0.3em',
          fontSize: 12,
          textTransform: 'uppercase',
          cursor: isValid && !pending ? 'pointer' : 'default',
          fontFamily: 'inherit',
          transition: 'background 200ms, color 200ms, border 200ms',
          minWidth: 220,
        }}
      >
        {pending ? 'MINTING ON MONAD…' : 'MINT GLYPH'}
      </button>

      {mintStatus === 'error' && mintError && (
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.05em',
            color: '#c97a5b',
            fontFamily: 'ui-monospace, Menlo, monospace',
            maxWidth: 480,
            textAlign: 'center',
            lineHeight: 1.5,
            marginTop: 4,
          }}
        >
          MINT FAILED · {mintError.slice(0, 200)}
        </div>
      )}
    </div>
  );
}

function MintSuccess({
  tokenId,
  txHash,
  contractAddress,
  chainId,
  supplyMax,
}: {
  tokenId: string;
  txHash: string;
  contractAddress: string | null;
  chainId: number | null;
  supplyMax: number | null;
}) {
  // Two Monad explorers in active rotation:
  //   - monadexplorer.com — standard tx / address pages, works well for tx
  //     receipts with internal calls and event logs
  //   - monadvision.com   — has a dedicated /nft/<contract>/<tokenId> route
  //     that renders the metadata, image, and animation_url playback
  //     (which is what we want users to land on for the audio/glyph view)
  // We split the targets accordingly: tx link → explorer, NFT link → vision.
  // Mainnet (143) drops the `testnet.` subdomain on both hosts.
  const isMainnet = chainId === 143;
  const txExplorer = isMainnet
    ? 'https://monadexplorer.com'
    : 'https://testnet.monadexplorer.com';
  const nftExplorer = isMainnet
    ? 'https://monadvision.com'
    : 'https://testnet.monadvision.com';
  const txUrl = `${txExplorer}/tx/${txHash}`;
  const tokenUrl =
    contractAddress != null
      ? `${nftExplorer}/nft/${contractAddress}/${tokenId}`
      : null;
  const txShort = `${txHash.slice(0, 10)}…${txHash.slice(-6)}`;

  return (
    <div
      style={{
        marginTop: 4,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        fontFamily: 'ui-monospace, Menlo, monospace',
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: '0.3em',
          color: '#7be0d4',
        }}
      >
        MINTED
      </div>
      <div
        style={{
          fontSize: 22,
          letterSpacing: '0.1em',
          color: '#c9885b',
        }}
      >
        SONOGLYPH&nbsp;#{tokenId}
        {supplyMax != null && (
          <span
            style={{
              fontSize: 12,
              letterSpacing: '0.2em',
              color: '#6a6660',
              marginLeft: 10,
            }}
          >
            / {supplyMax}
          </span>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 14,
          fontSize: 10,
          letterSpacing: '0.18em',
          color: '#6a6660',
        }}
      >
        <a
          href={txUrl}
          target="_blank"
          rel="noreferrer"
          style={{ color: '#a09d99', textDecoration: 'none' }}
        >
          TX {txShort} ↗
        </a>
        {tokenUrl && (
          <a
            href={tokenUrl}
            target="_blank"
            rel="noreferrer"
            style={{ color: '#a09d99', textDecoration: 'none' }}
          >
            VIEW ON CHAIN ↗
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * Minimal injected-provider type. We only ever call `request` with a couple
 * of known methods; pulling in @types/web3-eip1193 felt heavy for that.
 */
interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}
