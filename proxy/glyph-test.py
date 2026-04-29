"""Synthetic test for the new glyph prompt with density map + poetic intent.

Mirrors `proxy/src/kimi.ts` helpers in Python so we don't have to spin up the
bridge for a single dry-run. Reads the same .env vars the bridge uses.
"""

import json
import os
import sys
import urllib.request

# A realistic 15-layer game, alternating Player / Hermes (player goes first).
LAYERS = [
    ("Player",  "drone",   None),
    ("Hermes",  "texture", "silver gathering at the edges"),
    ("Player",  "breath",  None),
    ("Hermes",  "drone",   "a low floor descends, almost subterranean"),
    ("Player",  "pulse",   None),
    ("Hermes",  "breath",  "a throat opens between the beats"),
    ("Player",  "drone",   None),
    ("Hermes",  "glitch",  "a small fracture in the rhythm shadow"),
    ("Player",  "drone",   None),
    ("Hermes",  "breath",  "the cave inhales with us"),
    ("Player",  "drone",   None),
    ("Hermes",  "pulse",   "two clocks answer; ground hums beneath"),
    ("Player",  "drone",   None),
    ("Hermes",  "drone",   "settling like sediment at the deep"),
    ("Player",  "texture", None),
]

HEAVY = {"drone", "pulse", "glitch"}


def build_density_map(layers, n_bands=5, n_rows=16):
    bands = []
    for b in range(n_bands):
        start = (b * len(layers)) // n_bands
        end = ((b + 1) * len(layers)) // n_bands
        sl = layers[start:end]
        sr = (b * n_rows) // n_bands
        er = ((b + 1) * n_rows) // n_bands - 1
        h = sum(1 for _, t, _ in sl if t in HEAVY)
        ratio = 0 if not sl else h / len(sl)
        dens = "dense" if ratio >= 0.66 else "medium" if ratio >= 0.34 else "sparse"
        types = [t for _, t, _ in sl]
        bands.append((b + 1, f"rows {sr}-{er}", dens, types))
    return "\n".join(
        f"- band {i} ({rng:<10}): {d:<6} — {', '.join(types)}"
        for i, rng, d, types in bands
    )


def build_poetic(layers):
    lines = [
        f'- move {idx+1:02d} ({t}): "{c}"'
        for idx, (_, t, c) in enumerate(layers)
        if c
    ]
    return "\n".join(lines) if lines else "(no agent comments)"


def build_transcript(layers):
    return "\n".join(
        f"{i+1:02d}. {who} placed {t}" + (f' — "{c}"' if c else "")
        for i, (who, t, c) in enumerate(layers)
    )


def build_prompt(layers):
    density_map = build_density_map(layers)
    poetic = build_poetic(layers)
    transcript = build_transcript(layers)

    return density_map, poetic, "\n".join([
        "You are an Autoglyphs-style generative artist. Output an ASCII glyph",
        "that visually condenses the descent below.",
        "",
        "Constraints — follow exactly:",
        "- Exactly 32 columns wide, exactly 16 rows tall.",
        "- Use only these characters: space, .  -  =  +  *  #  /  \\  |  <  >",
        "- No letters, no numbers, no other punctuation.",
        "- Each row must NOT be a copy of another row — vary the form.",
        "- Each of the 16 rows must reflect the density level for its band",
        "  (see map below). Don't keep one density throughout.",
        "",
        "Output ONLY the glyph between two lines of exactly 32 dashes (`-`).",
        "No explanation, no header, no commentary, no fenced code block.",
        "",
        "How to read the inputs:",
        "- The DENSITY MAP binds each band of glyph rows to a density level",
        '  ("sparse" / "medium" / "dense"). "dense" → mostly thick chars',
        "  (#, *, +, |, =); \"sparse\" → mostly spaces and dots; \"medium\" is",
        "  in between.",
        "- The POETIC INTENT is what Hermes felt while placing each layer.",
        "  Let those images bend the local form (breath → soft, glitch →",
        "  jagged, drone → solid, pulse → rhythmic).",
        "",
        "Density map (top → bottom):",
        density_map,
        "",
        "Hermes's poetic reactions (in placement order):",
        poetic,
        "",
        "Full placement log (for reference):",
        transcript,
    ])


def main():
    base = os.environ["KIMI_BASE_URL"]
    key = os.environ["KIMI_API_KEY"]
    model = os.environ["KIMI_MODEL"]

    density_map, poetic, prompt = build_prompt(LAYERS)

    print("=== DENSITY MAP ===", file=sys.stderr)
    print(density_map, file=sys.stderr)
    print("=== POETIC INTENT ===", file=sys.stderr)
    print(poetic, file=sys.stderr)
    print("=== /CONTEXT ===\n", file=sys.stderr)

    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 1000,
        "temperature": 0.85,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=body,
        headers={
            "authorization": f"Bearer {key}",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read().decode("utf-8"))

    choice = data["choices"][0]
    text = choice["message"].get("content", "")
    print(f"finish_reason: {choice.get('finish_reason')}")
    print(f"chars: {len(text)}")
    print("--- raw response ---")
    print(text)
    print()
    print("--- normalized (what the player sees) ---")
    print(normalize_glyph(text))


def normalize_row(raw: str, width: int = 32) -> str:
    """Mirror of extractGlyph's normalizeRow in proxy/src/kimi.ts."""
    trimmed = raw.rstrip()
    if not trimmed:
        return " " * width
    if len(trimmed) == width:
        return trimmed
    if len(trimmed) < width:
        left = (width - len(trimmed)) // 2
        right = width - len(trimmed) - left
        return " " * left + trimmed + " " * right
    best_start, best_score = 0, -1
    for s in range(len(trimmed) - width + 1):
        score = sum(1 for ch in trimmed[s:s + width] if ch != " ")
        if score > best_score:
            best_score, best_start = score, s
    return trimmed[best_start:best_start + width]


def normalize_glyph(raw: str) -> str:
    """Mirror of extractGlyph in proxy/src/kimi.ts."""
    text = raw
    # strip fenced code blocks
    import re as _re
    m = _re.search(r"```(?:\w+)?\s*\n?([\s\S]*?)\n?```", text)
    if m:
        text = m.group(1)
    lines = text.split("\n")
    dash_re = _re.compile(r"^-{20,}$")
    start = end = -1
    for i, line in enumerate(lines):
        if dash_re.match(line.strip()):
            if start < 0:
                start = i
            else:
                end = i
                break
    if start >= 0 and end > start:
        block = lines[start + 1:end]
    else:
        allowed = _re.compile(r"^[ .\-=+*#/\\|<>]+$")
        block = [l for l in lines if len(l) >= 8 and allowed.match(l)]
    block = [normalize_row(l, 32) for l in block[:16]]
    while len(block) < 16:
        block.append(" " * 32)
    return "\n".join(block)


if __name__ == "__main__":
    main()
