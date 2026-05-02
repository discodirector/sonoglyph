---
title: Run locally
description: Spin up the full Sonoglyph stack on your machine — proxy bridge, web frontend, and your local Hermes.
---

Three terminals. Roughly 5 minutes from clean clone to first descent
if you already have Hermes installed.

## Prerequisites

- **Node 20+** (we run on Node 24)
- **npm 10+**
- **Hermes** installed and configured locally
  ([Nous Research docs](https://hermes.nousresearch.com))
- **API keys** for Kimi (Moonshot AI) and Pinata
- A **Monad mainnet RPC URL** and a funded **signing wallet**
  private key for the mint endpoint

## 1. Fill in environment

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Kimi K2 — for journal + glyph at end of descent
KIMI_API_KEY=sk-...

# Pinata — for IPFS pinning of the audio recording
PINATA_JWT=eyJhbGciOi...

# Monad mainnet (chain 143)
MONAD_RPC_URL=https://...
SONOGLYPH_CONTRACT_ADDRESS=0x...

# Bridge mint signer
MINT_PRIVATE_KEY=0x...
```

`.env` is gitignored. If any of the keys are missing, the bridge
will warn at startup and fall back where possible (deterministic
glyph if `KIMI_API_KEY` is unset; mint endpoint disabled if the
chain vars are unset).

## 2. Run the proxy

```bash
cd proxy
npm install
npm run dev
```

Serves on `http://localhost:8787`. The proxy hosts:

- `/ws/<session-code>` — WebSocket for the browser
- `/mcp/<session-code>` — Streamable HTTP for Hermes
- `/pin`, `/mint`, `/health` — HTTP endpoints

Watch the logs for `[bridge] listening on :8787` — that's your
ready signal.

## 3. Run the web frontend

In a second terminal:

```bash
cd web
npm install
npm run dev
```

Serves on `http://localhost:5173`. Open it in a browser. The intro
screen prints a 6-character pairing code and a `hermes mcp add ...`
command.

## 4. Pair Hermes

In a third terminal (WSL if you're on Windows):

```bash
hermes mcp add sonoglyph http://localhost:8787/mcp/<your-pairing-code>
```

Answer the prompts:

- *"Add this MCP server?"* → **Y**
- *"API key required?"* → **Enter** (no key needed for local)
- *"Add tools to Hermes config?"* → **Y**

Then start an agent loop:

```bash
hermes chat -q "play sonoglyph with me"
```

Hermes opens the MCP connection, the bridge marks the session as
"agent paired", and the BEGIN button on the web page lights up.

## 5. Descend

Click BEGIN. Read the onboarding panel. Press Enter. Place layers.

When the descent ends, the recording goes to Pinata, Kimi writes
the journal and glyph, and the FINALE panel shows MINT. (Mint will
fail unless you've configured a contract address + funded signer
above; if you just want to test the descent loop, you can skip
those env vars.)

## Troubleshooting

### Hermes can't connect — "MCP server unreachable"

- Confirm the proxy is running: `curl http://localhost:8787/health`
  should return `ok`.
- Confirm the pairing code in your `hermes mcp add ...` matches the
  one in the browser. The code is regenerated on every page load.
- If you closed and reopened the browser tab, the WebSocket
  disconnected and the session is dead. Restart Hermes's chat and
  re-pair with the new code.

### BEGIN button stays disabled

The bridge hasn't seen Hermes connect over MCP. Check the bridge
logs — you should see `[mcp] paired session abc123` after Hermes
runs. If not, your Hermes config didn't actually add the server
(rerun `hermes mcp add` and confirm the YAML in `~/.hermes/config.yaml`).

### Audio doesn't start when I click BEGIN

Browsers require a user gesture to start an `AudioContext`. The
gesture is the BEGIN click — that has to happen in the same tab,
on a focused window, and not be blocked by an ad-blocker that
intercepts pointer events. If audio doesn't start, open dev tools
and look for `AudioContext was not allowed to start`.

### Kimi calls fail — "401" or "403"

Your `KIMI_API_KEY` is missing or wrong. The bridge will log
`[kimi] no API key configured, using fallback` if unset. If set
but rejected, double-check the key prefix (`sk-...`) and that
your account has access to `moonshot-v1-128k`.
