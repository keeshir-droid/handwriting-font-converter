"""Developer-only. Builds everything in examples/ from the sample sheet, using the app's own code (via node):
  examples/sample-sheet.jpg  (made by tools/make_sample.py)
  examples/sample-font.ttf, examples/sample-card.pdf, examples/sample-card.png

    python tools/make_examples.py

Needs: node, pillow, numpy (dev only).
"""
import json
import math
import os
import struct
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "tests", "out")
EX = os.path.join(ROOT, "examples")
sys.path.insert(0, os.path.join(ROOT, "tests"))
from preview_lib import flatten  # noqa: E402

os.makedirs(OUT, exist_ok=True)
os.makedirs(EX, exist_ok=True)

# 1) the sample sheet as raw pixels for node
im = Image.open(os.path.join(EX, "sample-sheet.jpg")).convert("RGBA")
with open(os.path.join(OUT, "sample.rgba"), "wb") as f:
    f.write(struct.pack("<II", *im.size))
    f.write(im.tobytes())

# 2) node: sheet -> font, library, card PDF, card layout
subprocess.check_call(["node", os.path.join(ROOT, "tests", "test_font.js"), "sample"], cwd=ROOT)
subprocess.check_call(["node", os.path.join(ROOT, "tests", "test_pdf.js"), "sample"], cwd=ROOT)
for src, dst in [("sample.ttf", "sample-font.ttf"), ("sample.card.pdf", "sample-card.pdf")]:
    open(os.path.join(EX, dst), "wb").write(open(os.path.join(OUT, src), "rb").read())

# 3) card PNG: same layout as the PDF, drawn with Pillow (3x, even-odd fill like the canvas)
js = r"""
const fs=require('fs'),path=require('path');const {loadAll}=require('./tests/load');const HF=loadAll();
const lib=JSON.parse(fs.readFileSync('tests/out/sample.library.json','utf8'));
const pg=HF.layout.PAGES.card;
const note="Dear friend, I wish I could hand you this note in person. Since I can't, I wrote it in my own handwriting instead. Miss you lots.";
const L=HF.layout.layoutText(note,lib,{pageW:pg.w,pageH:pg.h,size:HF.layout.defaultSize('card',5),seed:3});
fs.writeFileSync('tests/out/sample.layout.json',JSON.stringify({page:pg,layout:L}));
"""
subprocess.check_call(["node", "-e", js], cwd=ROOT)
data = json.load(open(os.path.join(OUT, "sample.layout.json"), encoding="utf8"))
lib = json.load(open(os.path.join(OUT, "sample.library.json"), encoding="utf8"))
pg, L = data["page"], data["layout"]
K = 3
W, H = int(pg["w"] * K), int(pg["h"] * K)
paper, ink, rule = (251, 244, 228), (20, 40, 75), None
rule = tuple(round(p + (i - p) * 0.16) for p, i in zip(paper, ink))
img = Image.new("RGB", (W, H), paper)
d = ImageDraw.Draw(img)
for y in L["ruleYs"]:
    d.line([(L["margin"] * K, y * K), ((pg["w"] - L["margin"]) * K, y * K)], fill=rule, width=2)
ss = 2  # supersample the glyph layer for smooth edges
mask = Image.new("L", (W * ss, H * ss), 0)
mm = np.zeros((H * ss, W * ss), dtype=np.uint8)
for g in L["glyphs"]:
    cs, sn = math.cos(g["rot"]), math.sin(g["rot"])
    layer = np.zeros_like(mm)
    cx = g["cx"]
    for c in lib["glyphs"][g["ch"]]["contours"]:
        poly = []
        for u, v in flatten(c):
            X = g["x"] + cs * g["s"] * (u - cx) + sn * g["s"] * v
            Y = g["y"] + sn * g["s"] * (u - cx) - cs * g["s"] * v
            poly.append((X * K * ss, Y * K * ss))
        tile = Image.new("1", (W * ss, H * ss), 0)
        ImageDraw.Draw(tile).polygon(poly, fill=1)
        layer ^= np.asarray(tile, dtype=np.uint8)
    mm |= layer
mask = Image.fromarray(mm * 255).resize((W, H), Image.LANCZOS)
img.paste(Image.new("RGB", (W, H), ink), (0, 0), mask)
img.save(os.path.join(EX, "sample-card.png"), optimize=True)
print("examples written:", ", ".join(sorted(os.listdir(EX))))
