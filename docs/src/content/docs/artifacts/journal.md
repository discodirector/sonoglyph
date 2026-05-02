---
title: Journal generation
description: How Kimi K2 turns the descent's placement log into a 3-paragraph field journal in the voice of a geologist taking notes inside a cave.
---

When the 15th layer lands, the bridge calls Kimi K2 once,
asynchronously with the 8-second master fade, to produce the journal.
Code lives in `proxy/src/kimi.ts`.

## Model choice

`moonshot-v1-128k` — explicitly the **non-reasoning** chat variant. Two
reasons:

1. Reasoning models burn most of the token budget on hidden
   chain-of-thought before emitting any `content`. With a tight prose
   target (≤480 chars) we hit empty-content responses repeatedly on
   reasoning variants.
2. The reasoning scratchpad occasionally leaked into the visible
   journal, breaking the second-person geological voice.

The 128k context window is overkill for a 15-line transcript but means
we never have to truncate or summarise the placement log going in.

## Input format

The full transcript is formatted as one numbered placement per line,
with the comment in quotes when present:

```text
01. Hermes placed drone — "first tone, the cave breathes"
02. Player placed bell
03. Hermes placed texture — "dust between the marks"
04. Player placed pulse
...
15. Hermes placed swell — "lift, then dissolve"
```

That transcript plus a short scale header (key + mode feel) is the
entire prompt context.

## Format rules

The system prompt enforces:

- **Exactly 3 paragraphs**, 2–3 sentences each
- **Under 480 characters** total (we cap at 720 in clamp logic because
  moonshot tends to overshoot the advisory)
- **Tone**: introspective, slightly mineral — *"a geologist taking
  notes inside a cave"*
- Reference 1–2 striking moves from the log
- No title, no markdown, no preamble — output only the prose

## Clamp logic

If the response overshoots the cap, `clampJournal()` truncates in
preference order:

1. Cut at the **last paragraph break** that fits under the cap.
2. If a single paragraph is too long, cut at the **last sentence end**
   (`.`, `!`, `?`) that fits.
3. Last resort, cut at the **last whitespace** that fits.

It never chops mid-sentence. If the model returns something completely
out-of-format (no paragraph breaks, no punctuation), the descent
fallback kicks in (see below).

## Fallback

If `KIMI_API_KEY` is unset or the call fails, the bridge produces a
deterministic stub journal — a one-line acknowledgement that the
descent completed, with the layer count and key. The descent always
ends gracefully; mints never block on Kimi availability.

## Why one call, not three

The journal is single-shot because variance there is small. We've
never observed a "bad" journal from moonshot in the way we observe bad
glyphs — the model is reliably introspective in the requested voice.
Glyphs need [best-of-3 with structural scoring](/artifacts/glyph/);
journals don't.
