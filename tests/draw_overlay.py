"""Developer-only. Draws tests/out/<name>.overlay.* (see dump_overlay.js) as a labelled PNG.
    python tests/draw_overlay.py <name> [x0 y0 x1 y1]     (optional crop, in straightened-photo pixels)
"""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "out")
name = sys.argv[1]
meta = json.load(open(os.path.join(OUT, name + ".overlay.json"), encoding="utf8"))
im = Image.open(os.path.join(OUT, name + ".overlay.pgm")).convert("RGB")
d = ImageDraw.Draw(im)
fs = max(18, meta["w"] // 70)
try: font = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", fs)
except Exception: font = None
col = {"item": (30, 160, 80), "comma": (140, 140, 140), "extra": (230, 160, 0), "problem": (220, 40, 40)}
for b in meta["boxes"]:
    c = col.get(b["kind"], (0, 0, 0))
    d.rectangle([b["x0"] - 2, b["y0"] - 2, b["x1"] + 2, b["y1"] + 2], outline=c, width=3)
    if b["kind"] in ("item", "problem", "extra"):
        d.text((b["x0"], b["y0"] - fs - 4), b["label"], fill=c, font=font)
if len(sys.argv) >= 6:
    im = im.crop(tuple(int(v) for v in sys.argv[2:6]))
else:
    im.thumbnail((1500, 1900))
p = os.path.join(OUT, name + ".overlay.png"); im.save(p); print(p, im.size)
