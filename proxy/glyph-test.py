"""Synthetic test for the new glyph prompt with density map + poetic intent.

Mirrors `proxy/src/kimi.ts` helpers in Python so we don't have to spin up the
bridge for a single dry-run. Reads the same .env vars the bridge uses.
"""

import json
import os
import sys
import urllib.request

# Realistic drone-heavy game roughly matching what the user just played:
# 8x drone (dominant) + texture pulses + a glitch fracture + closing texture.
LAYERS = [
    ("Player",  "drone",   None),
    ("Hermes",  "texture", "pale hiss"),
    ("Player",  "drone",   None),
    ("Hermes",  "pulse",   "a faint clock starts in the wall"),
    ("Player",  "glitch",  None),
    ("Hermes",  "drone",   "deeper blue gravity"),
    ("Player",  "texture", None),
    ("Hermes",  "texture", "electric dust"),
    ("Player",  "drone",   None),
    ("Hermes",  "pulse",   "the clock catches"),
    ("Player",  "drone",   None),
    ("Hermes",  "drone",   "low water rising"),
    ("Player",  "glitch",  None),
    ("Hermes",  "drone",   "last floor"),
    ("Player",  "drone",   None),
]

TYPE_GLYPHS = {
    "drone": ["#", "|", "="],
    "pulse": ["+", "="],
    "glitch": ["/", "\\", "*"],
    "texture": [".", "-"],
    "breath": ["-", "=", "<", ">"],
}


def build_band_palettes(layers, n_bands=5, n_rows=16):
    out = []
    for b in range(n_bands):
        start = (b * len(layers)) // n_bands
        end = ((b + 1) * len(layers)) // n_bands
        sl = layers[start:end]
        sr = (b * n_rows) // n_bands
        er = ((b + 1) * n_rows) // n_bands - 1
        types = [t for _, t, _ in sl]
        palette = []
        for t in types:
            for ch in TYPE_GLYPHS[t]:
                if ch not in palette:
                    palette.append(ch)
        types_str = (", ".join(types)) or "(empty)"
        rng = f"rows {sr}-{er}"
        out.append(
            f"- band {b+1} ({rng:<10}): {types_str:<28} → use: {' '.join(palette)}"
        )
    return "\n".join(out)


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
    band_palettes = build_band_palettes(layers)
    poetic = build_poetic(layers)
    transcript = build_transcript(layers)

    return band_palettes, poetic, "\n".join([
        "You are an Autoglyphs-style generative artist. Output an ASCII glyph",
        "that visually condenses the descent below.",
        "",
        "OUTPUT FORMAT — exactly this and nothing else:",
        "  line 1: 32 dashes (--------------------------------)",
        "  lines 2-17: the 16 rows of the glyph (each row up to 32 chars)",
        "  line 18: 32 dashes (--------------------------------)",
        "No header, no explanation, no markdown, no code fence, no closing",
        "remarks. The opening and closing separator MUST use dashes (-);",
        "do NOT substitute = or # for the boundary lines.",
        "",
        "CHARACTER SET (rows only): space  .  -  =  +  *  #  /  \\  |  <  >",
        "No letters, no numbers, no other punctuation inside the glyph.",
        "",
        "COMPOSITION RULES — mandatory, the result must satisfy ALL:",
        "1. Produce ALL 16 rows. Do not stop early. Every row must contain",
        "   at least one non-space character — no blank rows.",
        "2. Every row is UNIQUE. No two rows may share the same pattern, and",
        "   no row may be a tiling of one repeating segment (like",
        "   \"####|####|####|\") — that reads as wallpaper, not a glyph.",
        "3. The glyph must visibly EVOLVE from top to bottom. Top rows are",
        "   the surface (start of descent), bottom rows are the deep end.",
        "   Character weight, rhythm, and the use of empty space should",
        "   shift as you descend — not stay constant.",
        "4. Each of the 5 bands has its OWN character palette computed from",
        "   the layers placed in that band (see BAND PALETTES below). Draw",
        "   each band mostly from its palette so bands feel distinct.",
        "5. Some rows can be airy (a few marks among spaces), others can be",
        "   denser. Mix them to create breathing room and weight.",
        "",
        "NEGATIVE EXAMPLES — do NOT produce output that looks like these:",
        "",
        "  Bad (one tiled segment across the whole image):",
        "    ####|####|####|####|####|####|##",
        "    ####|####|####|####|####|####|##",
        "    ####|####|####|####|####|####|##",
        "",
        "  Bad (one alternation repeated for nearly every row):",
        "    =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-",
        "    -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=",
        "    =.=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-",
        "",
        "POSITIVE EXAMPLE — varied silhouette, breathing, evolving downward",
        "(do NOT copy these characters; invent your own composition):",
        "",
        "       .   .                ",
        "     . . +   .              ",
        "      ..++.    .            ",
        "     ++/\\++.   /+           ",
        "   /+++/+\\*+++/+\\           ",
        "   <><>../+++/+-+-+-+        ",
        "  +++/+\\*=##|##|=#           ",
        "  ##| ==== ##|##| ====       ",
        "   ##|##|##|====   ===       ",
        "    -- = - = - = - =         ",
        "     . - = .  -  =           ",
        "      .   |   .              ",
        "       . . .                 ",
        "         .                   ",
        "         |                   ",
        "         .                   ",
        "",
        "BAND PALETTES (top → bottom of the glyph):",
        band_palettes,
        "",
        "POETIC INTENT — Hermes's reactions while placing each layer. Let",
        "these images bend local shape: breath/exhale → soft (., -, =);",
        "glitch/fracture → jagged (/, \\, *); drone/floor → solid (#, |);",
        "pulse/clock → rhythmic (+, =); texture/dust → scattered (., -):",
        poetic,
        "",
        "Full placement log (reference only — band palettes already encode it):",
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


ALLOWED_GLYPH = set(" .-=+*#/\\|<>")


def sanitize_chars(s: str) -> str:
    return "".join(ch if ch in ALLOWED_GLYPH else " " for ch in s)


def normalize_row(raw: str, width: int = 32) -> str:
    """Mirror of extractGlyph's normalizeRow in proxy/src/kimi.ts."""
    cleaned = sanitize_chars(raw)
    trimmed = cleaned.rstrip()
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
    boundary_re = _re.compile(r"^([\-=#*+/\\|.~])\1{19,}$")
    start = end = -1
    for i, line in enumerate(lines):
        if boundary_re.match(line.strip()):
            if start < 0:
                start = i
            else:
                end = i
                break
    if start >= 0 and end > start:
        block = lines[start + 1:end]
    else:
        allowed = _re.compile(r"^[ .\-=+*#/\\|<>]+$")
        def keep(l):
            t = l.strip()
            if len(t) < 6:
                return False
            if not allowed.match(l):
                return False
            if len(t) >= 16 and len(set(t)) == 1:
                return False
            return True
        block = [l for l in lines if keep(l)]
    block = [normalize_row(l, 32) for l in block[:16]]
    while len(block) < 16:
        block.append(" " * 32)
    return "\n".join(block)


if __name__ == "__main__":
    main()
