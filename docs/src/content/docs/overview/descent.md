---
title: How a descent works
description: The six stages of a single Sonoglyph descent, from pairing the agent through the on-chain mint.
---

A single descent goes through six stages. The whole thing takes
~3–4 minutes from page load to minted token.

## 1. Pairing

The browser opens a WebSocket to the bridge and receives:

- a 6-character **pairing code** that namespaces this session, and
- a ready-to-paste `hermes mcp add ...` command.

The intro screen shows both, with a TROUBLESHOOT panel for the common
"Hermes can't reach the bridge" cases.

## 2. Agent connects over MCP

The player runs the printed `hermes mcp add ...` command on their
machine. Hermes opens an MCP connection to the bridge using the
[Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http).
The bridge marks the session as "agent paired" and the BEGIN button on
the page lights up.

At handshake the MCP server hands Hermes a context block including the
descent's specific scale, mode "feel", and the layer-type / intent
guidance. See [The agent → MCP tool surface](/agent/mcp/).

## 3. Onboarding + BEGIN

The player clicks BEGIN. The web page:

- starts the audio context (must be inside a user gesture in browsers),
- starts a `MediaRecorder` capturing the master bus, and
- shows a one-screen onboarding panel with the rules. Press Enter to
  drop into the descent.

## 4. The descent (15 turns)

Turns alternate between player and agent. Each side has a 10-second
cooldown after they place. 15 layers total.

- The **player** places by clicking in the 3D scene. Click position
  drives both the spatial position of the layer's orb and the candidate
  set the pitch picker draws from.
- The **agent** places by calling the MCP `place_layer` tool with a
  type, a short comment, and an optional intent. The bridge auto-picks
  a position (just below the descending camera) and snaps the pitch
  into the descent's scale.

The player can also touch three **atmospheric pads** (`GLOW`, `AIR`,
`DEEP`) that sustain background voicings derived from the session
scale. Pads are one-shot toggles, not turn-consuming.

## 5. Fade + artifact generation

When the 15th layer lands:

1. The master bus fades over 8 seconds. The recorder keeps capturing.
2. In parallel, the bridge calls Kimi K2 once for the **journal** and
   three times in parallel for the **glyph** candidates (the highest
   structural-score wins). See
   [Artifacts → Journal](/artifacts/journal/) and
   [Artifacts → Glyph](/artifacts/glyph/).
3. When the fade completes, the recorder is stopped and the WebM blob
   is pushed to **Pinata**. The CID comes back.

## 6. Mint

The player clicks MINT. The bridge sends a transaction to the
`Sonoglyph` contract on Monad mainnet, embedding:

- the 32×16 glyph,
- the journal,
- the IPFS CID of the recording,
- the 6-char session code,
- the player's chosen recipient address,
- the block timestamp.

Token URI rendering happens fully on-chain. See
[Chain → On-chain storage](/chain/storage/).
