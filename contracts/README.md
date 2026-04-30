# Sonoglyph contracts

ERC-721 of completed Sonoglyph descents. Fully on-chain rendering of glyph
+ journal (audio lives on IPFS via Pinata, referenced by CID in
`animation_url`).

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
