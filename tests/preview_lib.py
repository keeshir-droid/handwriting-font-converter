"""Developer-only. Draws a traced glyph library (tests/out/<name>.lib.json) as a PNG so you can look at it.

    python tests/preview_lib.py [name]      (default clean_ink)

Needs: pillow, numpy (dev only).
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
ORDER = []
for i in range(26):
    ORDER += [chr(65 + i), chr(97 + i)]
ORDER += list("0123456789") + list(".!?'-:;()&,")


def explicit(contour):
    n = len(contour)
    pts = []
    for i in range(n):
        p, q = contour[i], contour[(i + 1) % n]
        pts.append(p)
        if not p["on"] and not q["on"]:
            pts.append({"x": (p["x"] + q["x"]) / 2, "y": (p["y"] + q["y"]) / 2, "on": True})
    first = next(i for i, p in enumerate(pts) if p["on"])
    return pts[first:] + pts[:first]


def flatten(contour, steps=8):
    pts = explicit(contour)
    n = len(pts)
    poly = [(pts[0]["x"], pts[0]["y"])]
    i = 1
    while i <= n:
        p = pts[i % n]
        if p["on"]:
            poly.append((p["x"], p["y"]))
            i += 1
        else:
            e = pts[(i + 1) % n]
            x0, y0 = poly[-1]
            for s in range(1, steps + 1):
                t = s / steps
                poly.append(((1 - t) ** 2 * x0 + 2 * (1 - t) * t * p["x"] + t * t * e["x"],
                             (1 - t) ** 2 * y0 + 2 * (1 - t) * t * p["y"] + t * t * e["y"]))
            i += 2
    return poly


def render_glyph(g, cell, scale):
    """even-odd fill (outer + holes) on a cell x cell canvas; baseline at 72% of the height"""
    m = np.zeros((cell, cell), dtype=np.uint8)
    for c in g["contours"]:
        layer = Image.new("1", (cell, cell), 0)
        poly = [(10 + x * scale, cell * 0.72 - y * scale) for x, y in flatten(c)]
        ImageDraw.Draw(layer).polygon(poly, fill=1)
        m ^= np.asarray(layer, dtype=np.uint8)
    return m


if __name__ == "__main__":
    name = sys.argv[1] if len(sys.argv) > 1 else "clean_ink"
    lib = json.load(open(os.path.join(OUT, name + ".lib.json"), encoding="utf8"))
    cell, scale, cols = 150, 0.14, 12
    rows = (len(ORDER) + cols - 1) // cols
    sheet = Image.new("L", (cols * cell, rows * cell), 255)
    d = ImageDraw.Draw(sheet)
    for k, ch in enumerate(ORDER):
        if ch not in lib:
            continue
        gx, gy = (k % cols) * cell, (k // cols) * cell
        m = render_glyph(lib[ch], cell, scale)
        tile = Image.fromarray((1 - m) * 255)
        sheet.paste(tile, (gx, gy))
        by = gy + int(cell * 0.72)
        d.line([(gx, by), (gx + cell, by)], fill=200)          # baseline
        d.line([(gx, by - 700 * scale), (gx + cell, by - 700 * scale)], fill=225)  # cap line
        d.rectangle([gx, gy, gx + cell - 1, gy + cell - 1], outline=235)
    path = os.path.join(OUT, name + ".lib.png")
    sheet.save(path)
    print("wrote", path)
