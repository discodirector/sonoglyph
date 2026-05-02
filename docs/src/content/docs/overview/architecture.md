---
title: Architecture
description: The four moving parts — frontend, bridge/proxy, MCP server, and contract — and the flow between them.
---

Four components, three deployed processes (the contract is on Monad
mainnet, not a process we run).

```
┌──────────────────┐        WebSocket          ┌──────────────────┐
│   web (Vite)     │ ◀──────────────────────▶ │                  │
│   React + R3F    │   /ws/<session-code>      │  proxy (Hono)    │
│   Tone.js        │                           │  bridge + MCP    │
└────────┬─────────┘                           │  Node + tsx      │
         │                                     │                  │
         │ HTTP: /pin, /mint, /health          │   ┌────────────┐ │
         └────────────────────────────────────▶│   │ MCP server │◀┼── Streamable HTTP
                                                │   │  (mcp.ts)  │ │      from Hermes
                                                │   └────────────┘ │       on player's
                                                │                  │       machine
                                                │   theory.ts      │
                                                │   game.ts        │
                                                │   kimi.ts ───────┼─▶ moonshot-v1-128k
                                                │   storage.ts ────┼─▶ Pinata IPFS
                                                │   chain.ts ──────┼─▶ Monad RPC
                                                └──────────────────┘
                                                                    
                                                    ┌──────────────────┐
                                                    │ Sonoglyph.sol    │
                                                    │ ERC-721          │
                                                    │ Monad mainnet    │
                                                    └──────────────────┘
```

## web (`/web`)

Vite + React + TypeScript. The descent renders in **React Three Fiber**
with `drei` and the `postprocessing` package for bloom. Audio synthesis
is **Tone.js** routed through a master gain node feeding a
`MediaRecorder`. State is **Zustand**. Wallet/chain interactions use
**wagmi + viem**.

Key files:

| File | Role |
|------|------|
| `src/audio/engine.ts` | Tone.js synthesis, master chain, recording |
| `src/scene/` | 3D scene, camera descent, layer orbs |
| `src/ui/` | HUD, Mixer, Pads, Intro, Onboarding, Finale |
| `src/state/useSession.ts` | Zustand store |
| `src/net/client.ts` | Bridge WS client + IPFS pin / mint requests |

## proxy (`/proxy`)

Hono on Node. Three jobs:

1. **WebSocket session bus** for the browser. Each browser session gets
   a unique 6-char code; messages on `/ws/<code>` are routed to that
   session's `GameSession` (`game.ts`).
2. **MCP server** at `/mcp` exposing tools to Hermes. Streamable HTTP
   transport. See [Agent → MCP tool surface](/agent/mcp/).
3. **Server-side calls** to Kimi (`kimi.ts`), Pinata (`storage.ts`),
   and Monad RPC (`chain.ts`). The signing wallet for `mintDescent`
   lives here.

Key files:

| File | Role |
|------|------|
| `src/index.ts` | HTTP + WS routing |
| `src/game.ts` | `GameSession` class — turns, cooldowns, scale state |
| `src/theory.ts` | Modes, scale picker, frequency picker |
| `src/mcp.ts` | MCP server exposing tools to Hermes |
| `src/kimi.ts` | Journal + glyph generation |
| `src/storage.ts` | Pinata IPFS pin |
| `src/chain.ts` | Monad RPC + mint tx |
| `src/protocol.ts` | Wire types shared with `web/` |

## contracts (`/contracts`)

Foundry. One contract: `Sonoglyph.sol`, ERC-721 with fully on-chain
`tokenURI` rendering. See [Chain → On-chain storage](/chain/storage/).

## Deployment topology

In production:

- Web bundle is built by Vite into `web/dist` and served as static
  files by Caddy at the root of `sonoglyph.xyz`.
- Bridge runs as a systemd unit (`sonoglyph-bridge.service`) on the
  same host. Caddy reverse-proxies `/ws`, `/mcp`, `/pin`, `/mint`,
  `/health` to it on `127.0.0.1:8787`.
- Contract is deployed once to Monad mainnet; the address is read from
  `SONOGLYPH_CONTRACT_ADDRESS` env on the bridge.

The whole deploy flow is `git pull` + `bash deploy/redeploy.sh`. See
[Run → Deploy](/run/deploy/).
