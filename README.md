# Sonoglyph

> Descend with Hermes. Carve a sonoglyph.

An immersive solo web experience: you and the **Hermes Agent** (Nous Research)
descend through layers of an abstract void, sculpting an ambient/noise piece
together. At the bottom of the descent, **Kimi K2** reads the full session log
and writes a poetic field journal, plus an Autoglyphs-style ASCII glyph
condensing the descent into a single 32×16 image. The session is recorded,
pinned to IPFS, and minted as an ERC-721 on **Monad mainnet** (chain 143)
with the glyph rendered fully on-chain.

Submission for the **Hermes Agent Creative Hackathon** (Nous Research × Kimi).

- Live: https://sonoglyph.xyz
- Chain: Monad mainnet (143)

---

## Stack

- **Frontend** — Vite, React, TypeScript, React Three Fiber, drei,
  postprocessing, Tone.js (Web Audio), Zustand, wagmi/viem
- **Bridge / Proxy** — Hono on Node, WebSocket session bus, MCP HTTP
  transport for Hermes, server-side calls to Kimi + Pinata + on-chain mint
- **AI** — Hermes 4 (the player's LOCAL Hermes, talking to the bridge over
  MCP), Kimi K2 (`moonshot-v1-128k`, non-reasoning) for end-of-descent
  artifact generation
- **Chain** — Monad mainnet, ERC-721, fully on-chain SVG + HTML renderer
  (the audio player is embedded in `animation_url` so opening the NFT on
  a marketplace plays the recording)
- **Storage** — IPFS (Pinata) for the WebM audio recording

---

## How a descent works

1. The browser opens a WebSocket to the bridge and gets a 6-char pairing
   code + a `hermes mcp add ...` command.
2. The player runs that command on their machine. Hermes connects to the
   bridge over MCP. The bridge marks the session as "agent paired".
3. Player clicks **Begin**. Audio context starts, MediaRecorder starts.
   The descent begins.
4. Turns alternate (10 s cooldown each side). The player places layers by
   clicking in the 3D scene; the agent places layers by calling the MCP
   `place_layer` tool. 15 layers total per descent.
5. Last layer lands → 8 s master fade → recorder stops → blob is pushed
   to Pinata → CID returned. In parallel the bridge calls Kimi to produce
   the journal + glyph.
6. Player clicks **Mint**. The bridge sends a transaction to the
   `Sonoglyph` contract on Monad mainnet, embedding the glyph, journal,
   audio CID, and session code on-chain.

---

## Per-session randomization (every descent is unique)

The "music theory" lives in `proxy/src/theory.ts`. Three layers of variation
combine, so two descents never sound the same — and not just "shuffled
versions" but genuinely different keys, modal colors, and pitch trajectories.

### 1. Scale picker — 96 starting points

At session creation the bridge picks a random root (12 pitch classes) and
mode (8 modes), then locks them for the lifetime of the descent:

| Mode             | Feel                                                                 |
|------------------|----------------------------------------------------------------------|
| Aeolian          | classic minor — melancholy, settled, familiar                        |
| Dorian           | minor with a softened sixth — pensive but not despairing             |
| Phrygian         | dark, eastern, restless — flat second pulls everything toward unease |
| Lydian           | bright but strange — raised fourth, floating, unresolved             |
| Mixolydian       | major-ish but earthy — flat seventh, folkloric                       |
| Locrian          | unstable, hollow — diminished fifth refuses to resolve               |
| Harmonic Minor   | minor with a leading-tone bite — exotic, narrow tension              |
| Pentatonic Minor | no half-steps — gamelan-clean, every interval lands                  |

12 × 8 = **96 distinct (root, mode) combinations**. Comparing C Aeolian to
F♯ Lydian isn't "same music transposed" — they're different sonic worlds.

### 2. Per-layer randomization

Every placed layer (player or agent) goes through `pickFreqForLayer()`:

- **Octave** — each layer type has a preferred octave range (drone oct 2,
  bell oct 4–5, drip oct 5–6, etc.). When the range has multiple options
  the engine picks randomly, so two `bell` placements in the same descent
  can land an octave apart.
- **Scale degree** — chosen from a candidate set derived from the player's
  click (no intent → consonant-weighted random) or the agent's `intent`
  parameter (see below).
- **Sub-parameter jitter inside the engine** — chord amplitude is
  `0.0448 + Math.random() * 0.0358`, swell amplitude is
  `0.125 + Math.random() * 0.10`, glitch noise grain timing is randomized,
  drone filter has a static center but the sub voice gets a random
  detune cent. None of these change the pitch, but they prevent two
  layers of the same type from sounding identical.

### 3. Player + agent compositional choices

On top of pitch randomization, the actual **sequence** of layer types and
their spatial placement is unique per descent: the player chooses 7–8
types and where in 3D space to drop them, and the agent picks the other
half driven by its own reading of the in-progress composition.

### 4. Pads also derive from the session scale

The three atmospheric pads (`GLOW`, `AIR`, `DEEP`) build their voicings
from `scale.intervals`: GLOW uses root + 3rd + 5th, AIR uses root + 5th +
9th, DEEP uses sub + root + 5th. So in C Aeolian the GLOW pad is
C–E♭–G; in F♯ Lydian it's F♯–A♯–C♯. Different notes, different intervals,
different tonal color.

---

## The agent (the player's local Hermes)

There's no server-side LLM call during gameplay. The agent the player hears
is **their own Hermes**, running locally on their machine, talking to the
bridge over MCP (Model Context Protocol). The bridge exposes three tools.

### MCP tool surface (`proxy/src/mcp.ts`)

```
get_state()
  → { phase, turn_count, max_layers, current_turn,
      cooldown_remaining_ms, scale: { key, feel },
      layers_placed: [{ type, placed_by, position, freq_hz, comment }] }

wait_for_my_turn(timeout_sec = 120)
  → long-poll. Resolves with `it_is_my_turn: true` once cooldown has
    elapsed AND it's the agent's turn. Returns `finished: true` if the
    descent ends while waiting; `timed_out: true` after the timeout.

place_layer(type, comment, intent?)
  → places the agent's layer. The bridge auto-positions in 3D (ahead of
    the descending camera) and snaps the pitch to the descent's scale.
    `comment` is shown to the player as the agent's reaction.
    `intent` is the optional compositional bias.
```

### What Hermes sees at handshake

When Hermes connects, the MCP server hands it a context block that
includes the descent's specific scale and a one-line "feel" so it can
reason about pitch in key terms instead of treating every move as
isolated:

> You are co-composing Sonoglyph — a turn-based ambient/noise music
> descent — with a human.
>
> This descent unfolds in **F♯ Lydian — bright but strange — raised
> fourth gives a floating, unresolved quality**.
> All layers (yours and the player's) are pitched within this scale, so
> think of yourself as choosing where in that key to land.
>
> Loop: call `wait_for_my_turn`, then `place_layer(type, comment, intent?)`.
> Stop when the game finishes.
>
> [9 layer types listed with descriptions]
> [5 intent values listed with their scale-degree biases]
>
> Vary your type AND intent across the descent — a sequence like
> (drone hush) → (drone color) → (bell tension) → (chord release) builds
> shape; repeating the same type with the same intent flattens the
> composition.

### How the agent decides what to place

Hermes reads two things each turn:

1. **State snapshot** (`wait_for_my_turn` returns it): all layers placed
   so far with their type, who placed them (`agent` / `player`), 3D
   position, frequency in Hz, and any comment. The agent sees the
   trajectory of the composition — "we've hit the root three times in a
   row, time for a tension move".
2. **Initial context**: scale + feel + the type/intent guidance above.

It then chooses three things on each `place_layer` call:

- **`type`** — one of 9 layer types (`drone`, `texture`, `pulse`,
  `glitch`, `breath`, `bell`, `drip`, `swell`, `chord`). Picks based on
  what's already in the mix, the descent depth, and the mood it wants to
  build.
- **`comment`** — a short evocative line (<80 chars) that the player
  sees float into the HUD as the layer lands. These comments are
  preserved in the placement log and later passed to Kimi as "poetic
  intent" to bend the glyph's shape (see below).
- **`intent`** — optional compositional bias mapping to scale degrees:
  - `tension` — ♭2 / tritone / leading tone
  - `release` — root or fifth
  - `color` — ♭6 / 6th / 9th
  - `emphasis` — third (defines major/minor character of the mode)
  - `hush` — low root only

The bridge does the rest: position is auto-picked just below the
descending camera (`pickAgentPosition` in `game.ts`), pitch is computed
by `pickFreqForLayer(scale, type, intent)` which intersects the intent's
candidate degrees with what the scale actually contains.

### Why the agent has musical agency, not just type-picking

Crucially, the agent doesn't pick a frequency in Hz. It picks a *role*
(`tension`, `release`, …) and the bridge maps that role onto the
descent's specific key. This means:

- Hermes can be told "you're in F♯ Lydian" and immediately understand
  what `tension` means in that mode (the ♯4 tritone) without needing to
  do music-theory arithmetic mid-tool-call.
- Two descents with the same agent moves but different scales sound
  completely different. The agent's musical *intent* is portable; the
  realization is per-session.

### Drone is special-cased

Drone ignores `intent` and is pinned to root or fifth. Its job is to
anchor the descent's harmonic floor; tension/color on a low fundamental
doesn't read musically and pushes saw harmonics into unpleasant
resonance bands. Intent still drives the other 8 types.

---

## End-of-descent artifact generation (Kimi)

When the 15th layer lands the bridge calls Kimi K2 once, asynchronously
with the 8 s master fade, to produce the journal and the glyph. Code in
`proxy/src/kimi.ts`. Model: `moonshot-v1-128k` — explicitly the
non-reasoning chat variant, because reasoning models burn most of the
token budget on hidden chain-of-thought before emitting any `content`,
which led to two earlier failure modes (empty content, or the model's
scratchpad leaking into the player's journal).

### Journal generation

Single API call. The full transcript is formatted as:

```
01. Hermes placed drone — "first tone, the cave breathes"
02. Player placed bell
03. Hermes placed texture — "dust between the marks"
...
```

…and passed to Kimi with strict format rules:

- **Exactly 3 paragraphs**, 2–3 sentences each
- **Under 480 characters** total (we cap at 720 chars in clamp logic
  because moonshot tends to overshoot the advisory)
- **Tone**: introspective, slightly mineral — "a geologist taking notes
  inside a cave"
- Reference 1–2 striking moves from the log
- No title, no markdown, no preamble — output only the prose

If the response overshoots the cap, `clampJournal()` truncates at the
nearest paragraph break, then sentence end, then any whitespace, in that
preference order — it never chops mid-sentence.

### Glyph generation (best-of-3 + structural scoring)

ASCII glyphs have high quality variance from Kimi. Sometimes it produces
a varied breathing composition; sometimes it falls back to tiled
wallpaper. The pipeline:

**1. Three candidates in parallel**

Three concurrent calls at temperatures 0.7 / 0.9 / 1.0. Distinct enough
that the candidates actually diverge instead of collapsing to similar
samples.

**2. Each candidate gets a structured prompt**

The glyph prompt has four parts:

- **Output format**: 32 dashes, 16 rows of glyph (≤32 chars each), 32
  dashes. No header, no explanation, no markdown.
- **Character set**: ` . - = + * # / \ | < > : ~` only. No letters, no
  numbers.
- **Composition rules**: must have a silhouette (rows have varied
  widths — think sculpture / rune / hieroglyph, not textured rectangle);
  plenty of negative space; every row unique; glyph evolves from top
  (descent surface) to bottom (deep end); each of 5 vertical bands uses
  its own derived character palette.
- **Negative + positive examples**: explicit "this is wallpaper, do not
  do this" and "this is what we want" inline, so the model has visual
  anchors instead of just prose rules.

**3. Two structured hints sit alongside the raw transcript:**

- **Band palettes** — the descent is split into 5 vertical bands. Each
  band's character palette is the union of `TYPE_GLYPHS` for the layer
  types that fell into it:
  ```
  drone   → # | =
  pulse   → + =
  glitch  → / \ *
  texture → . -
  breath  → - = < >
  bell    → * < >
  drip    → . :
  swell   → ~ - =
  chord   → | = :
  ```
  So a band heavy in `drone + chord` produces a vertical-stack-flavored
  palette (`# | = :`), while a band of `glitch + drip + texture`
  produces a sparse jagged palette (`/ \ * . :`).
- **Poetic intent** — Hermes's per-layer comments lifted out of the
  transcript and listed with their move number. The model treats these
  as form-shaping images: breath/exhale → soft (`. - =`),
  glitch/fracture → jagged (`/ \ *`), drone/floor → solid (`# |`),
  drip/water → isolated marks (`. :`), and so on.

**4. Each candidate is scored, highest wins**

`scoreGlyph()` rewards visual variation and silhouette shape, penalizes
tile-like wallpaper:

```
score = filledRows * 1.0      // rows with ≥4 non-space chars (capped at 12)
      + uniqueFilled * 0.4    // distinct filled rows
      + entropy * 2.5         // Shannon entropy over char distribution
      + densityStdDev * 1.5   // std-dev of fill-density across rows
      + silhouetteStdDev * 2.0 // std-dev of trimmed row WIDTH
      - tilePenalty * 1.8     // repeating-segment runs ("<>.<>.<>." etc.)
```

The silhouette term carries the heaviest weight because it's the
strongest signal for "is this a glyph with a shape vs a rectangle of
textured content". A solid block scores 0 on silhouette no matter how
varied its characters; a diamond/hourglass/asymmetric silhouette scores
high.

**5. Extraction + normalization**

`extractGlyph()` looks for the dashed boundary lines (also tolerates `=`
or `#` substitutions models occasionally produce); if no boundary is
found it falls back to the longest contiguous block of allowed
characters. Each row is then sanitized (anything outside the glyph
charset → space), trimmed, and either center-padded (if short) or
windowed to its densest 32-char span (if too wide). 16 rows guaranteed.

**6. Fallback**

If `KIMI_API_KEY` is unset or the call fails, `fallback()` produces a
deterministic glyph by tiling per-type characters across the 32×16 grid
in placement order, plus a stub journal. The descent always ends
gracefully.

---

## On-chain storage

`contracts/src/Sonoglyph.sol` — ERC-721 with fully on-chain rendering.
Each token preserves the complete record of one descent:

- `glyph` — the 32×16 ASCII art
- `journal` — the field journal
- `audioCid` — IPFS CIDv1 of the WebM recording
- `sessionCode` — 6-char descent code
- `creator` — address that completed it
- `mintedAt` — block timestamp

`tokenURI(id)` returns a base64-encoded JSON data URI containing:

- `image` — `data:image/svg+xml;base64,...` with the glyph drawn as
  monospace text on black (used by marketplaces for thumbnails)
- `animation_url` — `data:text/html;base64,...` — a self-contained page
  that renders the glyph **plus** an `<audio>` element fetching the
  recording from an IPFS gateway. One click on a marketplace listing →
  the user sees the glyph and hears the descent simultaneously.

Mint policy: only the contract owner (the bridge's signing wallet) can
mint, and it mints to the player's chosen address. We trade
trustlessness for curation — every minted token came from a real
completed descent the bridge witnessed end-to-end.

Supply policy: hard-capped at **250 tokens** for the lifetime of the
contract (`MAX_SUPPLY` constant, no setter). Each address can ever
receive **at most one** Sonoglyph (`hasMinted` mapping, lifetime flag —
transferring the token away does not reset eligibility). 250 distinct
descents, 250 distinct holders.

---

## Layout

```
sonoglyph/
├── web/         Vite + React + R3F (the descent experience)
│   ├── src/audio/engine.ts    Tone.js synthesis, master chain, recording
│   ├── src/scene/             3D scene, camera descent, layer orbs
│   ├── src/ui/                HUD, Mixer, Pads, Intro, Finale
│   ├── src/state/useSession   Zustand store
│   └── src/net/client         Bridge WS client + IPFS pin / mint requests
├── proxy/       Hono + Node bridge
│   ├── src/index.ts           HTTP + WS routing
│   ├── src/game.ts            GameSession (turns, cooldowns, scale)
│   ├── src/theory.ts          Modes, scale picker, freq picker
│   ├── src/mcp.ts             MCP server exposing tools to Hermes
│   ├── src/kimi.ts            Journal + glyph generation
│   ├── src/storage.ts         Pinata IPFS pin
│   ├── src/chain.ts           Monad RPC + mint tx
│   └── src/protocol.ts        Wire types shared with web/
├── contracts/   Foundry (Sonoglyph ERC-721)
├── .env.example template — copy to .env and fill in
└── .gitignore
```

---

## Run locally

```bash
# 1. Fill in API keys
cp .env.example .env
# edit .env — KIMI_API_KEY, PINATA_JWT, MONAD_RPC_URL,
#            MINT_PRIVATE_KEY, SONOGLYPH_CONTRACT_ADDRESS

# 2. Install + run proxy (bridge + MCP server)
cd proxy
npm install
npm run dev          # serves on http://localhost:8787

# 3. In another terminal, run web
cd web
npm install
npm run dev          # serves on http://localhost:5173

# 4. Open http://localhost:5173 — the page prints a
#    `hermes mcp add ...` command. Run it in WSL/your shell, then
#    `hermes chat -q "play sonoglyph with me"` to start the agent loop.
```

---

## License

MIT
