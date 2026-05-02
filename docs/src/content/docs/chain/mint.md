---
title: Mint flow
description: What happens between "the 15th layer landed" and "the player sees their token on Monad".
---

The mint flow runs in two phases. First the bridge prepares the
artifacts (Kimi + IPFS), then the player triggers the on-chain mint.

## Phase 1 — artifact prep (parallel with the master fade)

Triggered when the 15th layer lands.

```
master fade (8s) ──────────────────────────────────▶
Kimi journal (1 call) ──────────────▶
Kimi glyph (3 calls in parallel) ────▶ score + pick best ─▶
recorder.stop() ──────────────────────────▶
   ├─ blob → POST /pin ─▶ Pinata ─▶ CID
   └─ done
```

The bridge gathers `{ glyph, journal, audioCid, sessionCode }` and
emits `mint_ready` over the WebSocket. The web UI flips the FINALE
panel from "Encoding…" to "MINT" so the player can sign.

## Phase 2 — the mint transaction

Player clicks **MINT**. The browser sends `POST /mint` to the bridge:

```ts
{
  to:           address,          // recipient
  glyph:        string,           // 32×16 ASCII
  journal:      string,           // 3-paragraph prose
  audioCid:     string,           // IPFS CIDv1
  sessionCode:  string,           // 6-char code
}
```

The bridge re-validates the session by `sessionCode` (this is the
only mint authorisation — the bridge will refuse to sign for sessions
it doesn't recognise as completed). Then it builds and broadcasts
the tx using viem's `walletClient`:

```ts
const hash = await wallet.writeContract({
  address: SONOGLYPH_CONTRACT_ADDRESS,
  abi: sonoglyphAbi,
  functionName: 'mintDescent',
  args: [to, glyph, journal, audioCid, sessionCode],
})
```

Response shape:

```ts
{
  txHash:  string,
  tokenId: number,    // parsed from the Transfer event
  monadExplorerUrl: string,
}
```

The web UI shows the explorer link and updates the FINALE panel to
"Minted." The descent ends. The player can refresh to start a new
session.

## Failure modes

### Pinata pin fails

`POST /pin` retries once on transient errors, then surfaces a UI
error. The descent stays in "FINALE — pinning…" state and the
player can retry. The recording is held in memory in the browser
until pinning succeeds, so a failed pin doesn't lose audio (a
page reload does).

### Mint tx reverts

Most likely cause: the bridge wallet's nonce or balance is off.
The bridge logs the revert reason and returns a 500. The player
sees a "mint failed, contact us" UI. We've never seen this in
production but the path exists.

### Kimi fails after the 15th layer

Fallback artifacts kick in (deterministic stub journal +
type-tiled glyph). The mint still happens; the token is still
unique (different `audioCid` and `sessionCode`) but the journal
and glyph are the fallback variants. We log this but don't
surface it to the player.

## Why the bridge mints, not the player

A player-side mint would mean publishing the contract address as
permissionless and exposing `mintDescent` to anyone with funds. We
chose curation: the bridge is the only minter, and it only mints
sessions it witnessed. This eliminates spam minting and keeps the
on-chain set as a record of *real* descents.

The cost is operational: the bridge wallet must always have Monad
gas to keep the experience fluid. We monitor balance and refill
manually for the hackathon submission window. A production version
would automate the refill.
