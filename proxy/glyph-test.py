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
        "1. The glyph has a SILHOUETTE. Different rows have different WIDTHS",
        "   — some short, some wide, some narrow with a few marks among lots",
        "   of empty space. Think of a sculpture, a rune, a hieroglyph; not",
        "   a textured rectangle. The eye should see a SHAPE first, the",
        "   detail second. A 32-char-wide block of texture every row, no",
        "   matter how varied the chars, is FAILURE.",
        "2. Use plenty of NEGATIVE SPACE (literal spaces). Many rows should",
        "   have content only in the middle 8-20 columns, with empty padding",
        "   on either side. Some rows can be very short (3-6 marks total).",
        "3. Every row is unique. No row may be a single 1-4 character segment",
        "   repeated across the row (no \"<>.<>.<>.\" or \"####|####|\" tiling).",
        "4. The glyph EVOLVES from top to bottom. Top rows are the surface",
        "   (start of descent), bottom rows are the deep end. Width, weight,",
        "   and rhythm should shift as you descend — not stay constant.",
        "5. Each of the 5 bands has its own character palette derived from",
        "   the layers in that band (see BAND PALETTES below). Use the band",
        "   palette so different bands feel distinct.",
        "6. Produce all 16 rows; rows can be very sparse but should not be",
        "   completely empty.",
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
        "POSITIVE EXAMPLE — note how WIDTHS VARY row by row, lots of empty",
        "space on the sides, breathing. (Do NOT copy these characters; invent",
        "your own composition.):",
        "",
        "          # #-                  ",
        "             # .                ",
        "             # . =              ",
        "         < < < = < <            ",
        "          > . =     = > .       ",
        "         | =      *      + -    ",
        "       *>/-/.  *+   - /   *=\\   ",
        "          *=/  \\-/-  +-/+        ",
        "          | =  /++-  +=/  |     ",
        "       =  -=  -  -=  -=-  ==    ",
        "       =  | =-=  =  -=  -  =    ",
        "         - - -    |  -  =       ",
        "          < > < > # # ##=       ",
        "       | .  <  =  =  .=<  >     ",
        "        .=  .=  .=  .=  .<  ><  ",
        "        < > < >.  < >.  <  <    ",
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


def call_kimi(prompt: str, temperature: float) -> str:
    """One Kimi call with given temperature."""
    base = os.environ["KIMI_BASE_URL"]
    key = os.environ["KIMI_API_KEY"]
    model = os.environ["KIMI_MODEL"]
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 1000,
        "temperature": temperature,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=body,
        headers={
            "authorization": f"Bearer {key}",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.loads(r.read().decode("utf-8"))
    return data["choices"][0]["message"].get("content", "")


def detect_tile_runs(s: str) -> int:
    if len(s) < 8:
        return 0
    worst = 0
    for length in range(1, 5):
        for start in range(0, len(s) - length * 4 + 1):
            seg = s[start:start + length]
            reps = 1
            pos = start + length
            while pos + length <= len(s) and s[pos:pos + length] == seg:
                reps += 1
                pos += length
            if reps >= 4 and reps > worst:
                worst = reps
    return worst


def _stddev(values):
    import math as _m
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    var = sum((v - mean) ** 2 for v in values) / len(values)
    return _m.sqrt(var)


def score_glyph(grid: str) -> float:
    """Mirror of scoreGlyph in proxy/src/kimi.ts."""
    import math as _math
    rows = grid.split("\n")
    trimmed = [r.replace(" ", "") for r in rows]

    filled_rows_raw = sum(1 for t in trimmed if len(t) >= 4)
    filled_rows = min(filled_rows_raw, 12)

    unique_filled = len({rows[i] for i in range(len(rows)) if len(trimmed[i]) >= 4})

    counts = {}
    total = 0
    for r in rows:
        for ch in r:
            if ch == " ":
                continue
            counts[ch] = counts.get(ch, 0) + 1
            total += 1
    entropy = 0.0
    if total > 0:
        for c in counts.values():
            p = c / total
            entropy -= p * _math.log2(p)

    filled_densities = [len(t) for t in trimmed if len(t) >= 4]
    density_std_dev = _stddev(filled_densities)

    # Silhouette: trimmed width per row.
    widths = []
    for r in rows:
        stripped = r.rstrip()
        if not stripped or stripped.isspace():
            widths.append(0)
            continue
        # Find first and last non-space.
        left = next(i for i, ch in enumerate(r) if ch != " ")
        right = max(i for i, ch in enumerate(r) if ch != " ")
        widths.append(right - left + 1)
    silhouette_std_dev = _stddev(widths)

    tile_penalty = sum(detect_tile_runs(t) for t in trimmed)

    return (
        filled_rows * 1.0
        + unique_filled * 0.4
        + entropy * 2.5
        + density_std_dev * 1.5
        + silhouette_std_dev * 2.0
        - tile_penalty * 1.8
    )


def main():
    band_palettes, poetic, prompt = build_prompt(LAYERS)

    print("=== BAND PALETTES ===", file=sys.stderr)
    print(band_palettes, file=sys.stderr)
    print("=== POETIC INTENT ===", file=sys.stderr)
    print(poetic, file=sys.stderr)
    print("=== /CONTEXT ===\n", file=sys.stderr)

    import concurrent.futures
    temps = [0.7, 0.9, 1.0]
    print(f"Generating {len(temps)} candidates in parallel "
          f"(temps={temps})...", file=sys.stderr)

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(temps)) as ex:
        futures = [ex.submit(call_kimi, prompt, t) for t in temps]
        results = [f.result() for f in futures]

    scored = []
    for i, raw in enumerate(results):
        grid = normalize_glyph(raw)
        s = score_glyph(grid)
        scored.append((s, temps[i], grid, raw))
        print(f"\n--- candidate {i+1} (temp={temps[i]}, score={s:.2f}) ---")
        print(grid)

    scored.sort(key=lambda x: -x[0])
    print(f"\n=== WINNER (score={scored[0][0]:.2f}, temp={scored[0][1]}) ===")
    print(scored[0][2])


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
