# Sonoglyph contracts

ERC-721 of completed Sonoglyph descents. Fully on-chain rendering of glyph
+ journal (audio lives on IPFS via Pinata, referenced by CID in
`animation_url`).

## Deployed

| Network        | Chain ID | Address | Format |
|----------------|----------|---------|--------|
| **Monad mainnet** _(production)_ | 143    | [`0x17aA406cc810f7c5E66c41e763c0eF5333AecAc2`](https://monadexplorer.com/address/0x17aA406cc810f7c5E66c41e763c0eF5333AecAc2) | HTML `animation_url` |
| Monad testnet _(development)_   | 10143  | [`0x809a2dE0a24537a5BAb8a3E5Ead2d648a16Aa931`](https://testnet.monadexplorer.com/address/0x809a2dE0a24537a5BAb8a3E5Ead2d648a16Aa931) | `ipfs://` `animation_url` (v0) |

Mainnet was redeployed at deployer-nonce 2 (after the v0 mainnet deploy
at nonce 0 + first mint at nonce 1) so the new mainnet address differs
from testnet. v0 token #1 at the old mainnet address remains as a
historical artifact.

The two contracts differ only in `tokenURI`'s `animation_url` field:
- v0 (`ipfs://<audioCid>`) → marketplace falls back to its built-in audio
  player; the glyph appears only as a thumbnail.
- v1 (`data:text/html;base64,<page>`) → marketplace renders a self-contained
  page that shows the glyph AND plays the audio together. See
  `_renderHtml` in `src/Sonoglyph.sol`.

Mint storage layout is identical, so nothing else (bridge, frontend) had
to change beyond the `SONOGLYPH_CONTRACT_ADDRESS` env update.

Owner / sole minter: `0x331d5F69d188b1A37B0b1D6dd058f76b52e4457b` — the
bridge wallet, used by `proxy/` to sign mint transactions on the player's
behalf. The bridge's active network is selected by `MONAD_CHAIN_ID` in
`.env` (currently `143` → mainnet). Switch to `10143` to point the same
bridge at testnet without redeploying anything.

## Layout

```
contracts/
├── foundry.toml         build config (solc 0.8.24, optimizer 200, cancun)
├── remappings.txt       @openzeppelin/, forge-std/
├── src/Sonoglyph.sol    main ERC-721 + on-chain SVG/JSON tokenURI
├── test/Sonoglyph.t.sol forge tests (mint, ACL, tokenURI roundtrip)
└── script/Deploy.s.sol  deploys with deployer == owner (== bridge wallet)
```

## Mint policy

`mintDescent(...)` is `onlyOwner`. The owner is the bridge's signing wallet,
set at construction. The bridge holds `DEPLOYER_PRIVATE_KEY` and signs mint
transactions on the player's behalf — players never need testnet MON.
Trade-off: trust the bridge's curation. Win: every minted token came from
a real completed descent the bridge witnessed end-to-end.

## Build / test (local or on the prod Linux box)

```bash
# One-time: install Foundry (Linux/macOS).
curl -L https://foundry.paradigm.xyz | bash
exec $SHELL  # or restart terminal
foundryup

# Inside contracts/:
forge install openzeppelin/openzeppelin-contracts --no-commit
forge install foundry-rs/forge-std --no-commit
forge build
forge test -vvv
```

## Deploy to Monad testnet

```bash
# Pre-flight:
#   1. DEPLOYER_PRIVATE_KEY set in .env (no 0x prefix needed for forge --private-key,
#      but Foundry accepts both forms).
#   2. That address has testnet MON — claim from https://faucet.monad.xyz
#   3. MONAD_RPC_URL set (default https://testnet-rpc.monad.xyz, chain 10143)

source ../.env  # exposes the env vars to the shell

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$MONAD_RPC_URL" \
  --broadcast \
  --private-key "$DEPLOYER_PRIVATE_KEY"
```

The script prints the deployed address. Copy it into the repo `.env` as
`SONOGLYPH_CONTRACT_ADDRESS=0x...`, restart the bridge, and the mint flow
in Finale will reach it.

## Verification (optional)

Monad testnet uses Sourcify, not Etherscan-classic:

```bash
forge verify-contract <address> Sonoglyph \
  --chain-id 10143 \
  --verifier sourcify
```

## Gas notes

- `mintDescent` writes one Descent struct (~5 strings, ~1.5 KB total).
  Roughly 200-500k gas depending on string lengths. On Monad testnet
  this is effectively free.
- `tokenURI` is a `view` — no gas at runtime, just RPC compute. The
  function builds two base64 layers (SVG → JSON) and returns ~2-3 KB of
  string data; well under typical RPC response caps.

## When the contract changes

The ABI baked into the bridge (Phase 4 work) lives at
`proxy/src/abi/Sonoglyph.json` (extracted from `out/Sonoglyph.sol/Sonoglyph.json`
after `forge build`). Re-run that extraction after any storage-layout or
mint-signature change.
