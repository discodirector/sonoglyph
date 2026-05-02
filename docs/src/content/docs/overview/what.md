---
title: What is Sonoglyph
description: A solo web experience where you and the Hermes Agent co-compose an ambient descent that ends as a minted on-chain glyph.
---

Sonoglyph is a solo web experience where you and the **Hermes Agent**
(Nous Research) descend together through layers of an abstract void,
sculpting an ambient/noise piece in turns. There are 15 layers per
descent, alternating sides, with a 10-second cooldown each turn.

When the last layer lands, the piece fades over 8 seconds, the recording
is pushed to IPFS, and **Kimi K2** reads the full session log to produce
two artifacts:

- 3-paragraph **field journal** in the voice of a geologist taking
  notes inside a cave.
- 32×16 **ASCII glyph** condensing the descent into a single image.

You then mint the result as an ERC-721 on **Monad mainnet**.
The contract stores the glyph, journal, audio CID, and session code
on-chain; the audio player is embedded directly into `animation_url`, so
opening the NFT on a marketplace plays the recording.

## What makes it interesting

- **The agent is local.** Hermes is *your* Hermes, running on your
  machine, talking to the bridge over MCP. No server-side LLM call
  during gameplay.
- **Every descent is genuinely unique.** The bridge picks a fresh
  (root, mode) pair from 96 options at session creation; the agent's
  musical *intent* is portable across descents but the realisation is
  per-key. See [Per-session randomization](/composition/randomization/).
- **The agent has musical agency, not just type-picking.** Hermes
  reasons in compositional roles (`tension`, `release`, `color`, …);
  the bridge maps those onto the descent's specific scale. See
  [How Hermes decides](/agent/decisions/).
- **The output is fully on-chain.** Glyph and
  journal live in contract storage; the audio CID is the only off-chain
  pointer, and even the audio player is embedded in the data URI.

## What’s happening?

- During a single descent, you make 7–8 compositional decisions; the agent handles the rest, and the final result is shaped by both.
- This is not a multiplayer experience. One human, one agent, one descent.
- To receive the NFT, you only need to provide your wallet address, and the mint will be executed to your wallet. Gas fees are covered by Sonoglyph.

