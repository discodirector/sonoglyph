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
        "OUTPUT CONSTRAINTS — follow exactly:",
        "- Exactly 32 columns wide, exactly 16 rows tall.",
        "- Use only these characters: space, .  -  =  +  *  #  /  \\  |  <  >",
        "- No letters, no numbers, no other punctuation.",
        "- Output ONLY the glyph, between two lines of exactly 32 dashes (-).",
        "  No header, no explanation, no markdown, no fenced code block.",
        "",
        "COMPOSITION GUIDANCE:",
        "- Each glyph row corresponds to a depth in the descent. Row 0 is the",
        "  surface (the first move); row 15 is the deepest (the final move).",
        "- The DENSITY MAP below tells you how visually heavy each horizontal",
        "  band must be. Honour it row-for-row:",
        '    "dense"  → predominantly thick chars  (#, *, =, |, +)',
        '    "medium" → mixed weight               (+, /, \\, <, >, =)',
        '    "sparse" → mostly spaces and dots     (., -, single +)',
        "- The POETIC INTENT below is what Hermes felt when placing each",
        "  layer. Let those images bend the local shape:",
        "    breath / exhale / mist  → soft chars  (., -, =)",
        "    fracture / glitch / static → jagged   (/, \\, *)",
        "    drone / floor / hum     → solid       (#, |, =)",
        "    pulse / clock / rhythm  → rhythmic    (+, =)",
        "",
        "DENSITY MAP (top → bottom of the glyph):",
        density_map,
        "",
        "POETIC INTENT (Hermes's reactions in placement order):",
        poetic,
        "",
        "Full placement log (for reference only):",
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


if __name__ == "__main__":
    main()
