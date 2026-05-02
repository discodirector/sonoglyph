---
title: On-chain storage
description: How a Sonoglyph token preserves the full record of one descent — glyph, journal, audio, code — and renders directly from contract storage.
---

`contracts/src/Sonoglyph.sol` is an ERC-721 with **fully on-chain
rendering**. Each token preserves the complete record of one descent
in contract storage; nothing about the visible artifact lives in
external metadata or off-chain JSON.

## What's stored per token

| Field         | Type        | Source                                |
|---------------|-------------|---------------------------------------|
| `glyph`       | `string`    | The 32×16 ASCII art from Kimi         |
| `journal`     | `string`    | The 3-paragraph field journal         |
| `audioCid`    | `string`    | IPFS CIDv1 of the WebM recording      |
| `sessionCode` | `string`    | 6-char descent code                   |
| `creator`     | `address`   | Address that completed the descent    |
| `mintedAt`    | `uint256`   | Block timestamp at mint               |

Only the audio CID is an off-chain pointer, and even that pointer
resolves to a file pinned by us (Pinata) with its CID embedded in the
on-chain `animation_url` so any IPFS gateway can serve it.

## `tokenURI(id)`

Returns a base64-encoded JSON data URI containing two rendered media:

### `image` — SVG thumbnail

`data:image/svg+xml;base64,...` — the glyph drawn as monospace text
on a black background. This is what marketplaces use for grid
previews. It's a static SVG, no animation, no JavaScript. It's
constructed string-by-string from the on-chain `glyph` field at
`tokenURI` call time.

### `animation_url` — interactive HTML

`data:text/html;base64,...` — a self-contained page that renders the
glyph **plus** an `<audio>` element fetching the recording from an
IPFS gateway. One click on a marketplace listing → the user sees the
glyph and hears the descent simultaneously.

The HTML is also constructed at `tokenURI` time. Contract storage
holds the raw fields; the renderer composes them on read. This means
we can update the visual style by deploying a renderer contract
upgrade in future without re-minting tokens (the constructor takes
a renderer address; storage is preserved across renderer upgrades).

## Why fully on-chain

Three reasons.

**1. The glyph is the artifact.** We don't want it to be an IPFS link
that could rot. The 32×16 string is ~520 bytes per token; storage
cost on Monad mainnet is far below the scale where this becomes a
concern.

**2. Marketplaces should "just work".** Any marketplace that supports
the ERC-721 metadata standard already understands `tokenURI` returning
a data URI. No custom rendering server, no IPFS dependency at the
metadata layer.

**3. The audio + glyph belong together.** Embedding the audio player
in `animation_url` means a marketplace listing is the experience —
you don't need to leave the listing page to hear the descent. The
visual and the sound co-arrive.

## Mint policy

Only the contract owner (the bridge's signing wallet) can mint, and
it mints **to the player's chosen address**.

```solidity
function mintDescent(
    address to,
    string calldata glyph,
    string calldata journal,
    string calldata audioCid,
    string calldata sessionCode
) external onlyOwner returns (uint256 tokenId)
```

We trade trustlessness for curation — every minted token came from
a real completed descent the bridge witnessed end-to-end. There's
no "mint anything" path. If the bridge wallet is ever compromised
the worst case is junk tokens, not stolen ones.

The bridge wallet's private key lives in `MINT_PRIVATE_KEY` on the
VPS, only readable by the bridge process. It's a hot wallet by
necessity — minting needs to happen mid-descent without human
intervention.

## Cost

Per mint on Monad mainnet, with current gas levels, a Sonoglyph mint
costs a small fraction of a cent. The on-chain string storage
dominates the gas; the actual ERC-721 logic is standard OpenZeppelin
plus the renderer dispatch.
