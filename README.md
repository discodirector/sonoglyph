# Sonoglyph

> Descend with Hermes. Carve a sonoglyph.

An immersive solo web experience: you and the **Hermes Agent** (Nous Research) descend through layers of an abstract void, sculpting an ambient/noise piece together. The Voice — a TTS-rendered Hermes — narrates the descent and suggests sonic moves. At the bottom, **Kimi K2** reads the full session log and writes a poetic field journal. The session is hashed into a deterministic **ASCII glyph** (Autoglyphs lineage) and minted as an ERC-721 on the **Monad** testnet.

Submission for the **Hermes Agent Creative Hackathon** (Nous Research × Kimi).

## Stack

- **Frontend** — Vite, React, TypeScript, React Three Fiber, drei, postprocessing, Tone.js, Zustand, wagmi/viem
- **Proxy** — Hono on Node (streams Hermes / Kimi / ElevenLabs server-side, hides keys)
- **AI** — Hermes 4 (Voice + co-composer via tool use), Kimi K2 (long-context field journal)
- **Voice** — ElevenLabs streaming TTS
- **Chain** — Monad testnet, ERC-721, on-chain SVG glyph renderer
- **Storage** — IPFS (web3.storage / Pinata) for audio + journal

## Layout

```
sonoglyph/
├── web/         Vite + React + R3F (the experience)
├── proxy/       Hono + Node (Hermes/Kimi/TTS proxy)
├── contracts/   Foundry (Day 5)
├── .env.example template — copy to .env and fill in
└── .gitignore
```

## Quickstart

```bash
# 1. Fill in API keys
cp .env.example .env
# edit .env

# 2. Install + run proxy
cd proxy
npm install
npm run dev          # serves on http://localhost:8787

# 3. In another terminal, run web
cd web
npm install
npm run dev          # serves on http://localhost:5173
```

## Status

Day 1 — vertical slice: repo skeleton, scene, audio, proxy stub.

## License

MIT (TBD)
