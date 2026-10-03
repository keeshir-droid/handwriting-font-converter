"""Developer-only. Makes fake "photos" of a handwritten sheet so the reader can be tested
before real handwriting is available.

    python tests/make_sheets.py

Writes tests/out/<name>.rgba (8-byte header: width, height as uint32, then RGBA bytes)
and a small .png preview for looking at.
Needs: pillow, numpy (dev only, never shipped).
"""
import os
import random
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
FONTS = r"C:\Windows\Fonts"

# Same order as src/charset.js
ORDER = []
for i in range(26):
    ORDER.append(chr(65 + i))
    ORDER.append(chr(97 + i))
ORDER += list("0123456789")
ORDER += list(".!?'-:;()&")


def make_sheet(font_file, size, seed, width=2000, height=2600, per_line=None,
               line_gap=2.1, jitter=1.0, thick=1, comma_every=True, drop_comma_at=None,
               touch_at=None, marker_gap=0.55):
    rnd = random.Random(seed)
    font = ImageFont.truetype(os.path.join(FONTS, font_file), size)
    img = Image.new("L", (width, height), 245)
    margin = int(size * 1.0)
    x, y = margin, int(size * 1.6)
    row_height = int(size * line_gap)
    items_on_row = 0
    for idx, ch in enumerate(ORDER):
        s = size * (1 + rnd.uniform(-0.05, 0.05) * jitter)
        f = ImageFont.truetype(os.path.join(FONTS, font_file), int(s))
        bbox = f.getbbox(ch, anchor="ls")
        w = bbox[2] - bbox[0]
        gap = int(size * marker_gap)
        # line wrap
        need = w + int(size * 0.35) + gap
        if (per_line and items_on_row >= per_line) or x + need > width - margin:
            x = margin
            y += row_height
            items_on_row = 0
        layer = Image.new("L", (int(s * 2.5), int(s * 2.5)), 0)
        d = ImageDraw.Draw(layer)
        d.text((int(s * 0.5), int(s * 1.7)), ch, font=f, fill=255, anchor="ls",
               stroke_width=thick, stroke_fill=255)
        layer = layer.rotate(rnd.uniform(-4, 4) * jitter, resample=Image.BICUBIC)
        by = int(y + rnd.uniform(-5, 5) * jitter)
        px = x - int(s * 0.5) - bbox[0]
        py = by - int(s * 1.7)
        img.paste(Image.new("L", layer.size, 25), (px, py), layer)
        x += w + int(size * 0.12)
        if touch_at is not None and idx == touch_at:
            x -= int(size * 0.18)  # squeeze: comma almost touches the next
        # the comma
        if not (drop_comma_at is not None and idx == drop_comma_at):
            cl = Image.new("L", (int(s * 1.5), int(s * 1.5)), 0)
            dc = ImageDraw.Draw(cl)
            dc.text((int(s * 0.4), int(s * 1.0)), ",", font=f, fill=255, anchor="ls",
                    stroke_width=thick, stroke_fill=255)
            cl = cl.rotate(rnd.uniform(-5, 5) * jitter, resample=Image.BICUBIC)
            img.paste(Image.new("L", cl.size, 25), (x - int(s * 0.4), by - int(s * 1.0)), cl)
            x += int(size * 0.28)
        x += gap
        items_on_row += 1
    return img


def add_specks(img, spots):
    """Two small stray marks (dirt, a pen dab) between characters: the kind of thing that must not scramble the font."""
    d = ImageDraw.Draw(img)
    for (x, y, rw, rh) in spots:
        d.ellipse([x, y, x + rw, y + rh], fill=25)
    return img


def warp_quad(img, dst, fill=235):
    """Photograph the sheet from an angle: the source rectangle is mapped onto the quad
    `dst` (TL, TR, BR, BL as fractions of width/height). Output keeps the same size."""
    w, h = img.size
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    d = [(x * w, y * h) for x, y in dst]
    # solve for the coefficients that map OUTPUT points back to SOURCE points
    A, B = [], []
    for (X, Y), (x, y) in zip(d, src):
        A.append([X, Y, 1, 0, 0, 0, -x * X, -x * Y]); B.append(x)
        A.append([0, 0, 0, X, Y, 1, -y * X, -y * Y]); B.append(y)
    coef = np.linalg.solve(np.array(A, dtype=np.float64), np.array(B, dtype=np.float64))
    return img.transform((w, h), Image.PERSPECTIVE, tuple(coef), Image.BICUBIC, fillcolor=fill)


def photo_effects(img, tilt=0.0, shadow=0.0, blur=0.0, noise=0.0, table=False):
    a = np.asarray(img).astype(np.float32)
    h, w = a.shape
    if shadow > 0:
        gx = np.linspace(1.0, 1.0 - shadow, w)[None, :]
        gy = np.linspace(1.0, 1.0 - shadow * 0.5, h)[:, None]
        a = a * gx * gy
        # a soft shadow blob (a hand over the page)
        yy, xx = np.mgrid[0:h, 0:w]
        blob = np.exp(-(((xx - w * 0.75) / (w * 0.22)) ** 2 + ((yy - h * 0.3) / (h * 0.12)) ** 2))
        a = a * (1 - shadow * 0.8 * blob)
    out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    if table:
        big = Image.new("L", (int(w * 1.25), int(h * 1.15)), 120)
        d = ImageDraw.Draw(big)
        for i in range(0, big.size[0], 9):
            d.line([(i, 0), (i + random.randint(-4, 4), big.size[1])], fill=random.randint(95, 140), width=2)
        big.paste(out, (int(w * 0.12), int(h * 0.07)))
        out = big
    if tilt:
        out = out.rotate(tilt, resample=Image.BICUBIC, expand=True, fillcolor=120 if table else 235)
    if blur > 0:
        out = out.filter(ImageFilter.GaussianBlur(blur))
    if noise > 0:
        arr = np.asarray(out).astype(np.float32)
        arr += np.random.default_rng(1).normal(0, noise, arr.shape)
        out = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    # cap the long side like the app does
    if max(out.size) > 2600:
        r = 2600 / max(out.size)
        out = out.resize((int(out.size[0] * r), int(out.size[1] * r)), Image.LANCZOS)
    return out


def save(img, name):
    os.makedirs(OUT, exist_ok=True)
    rgba = img.convert("RGBA")
    w, h = rgba.size
    with open(os.path.join(OUT, name + ".rgba"), "wb") as f:
        f.write(struct.pack("<II", w, h))
        f.write(rgba.tobytes())
    rgba.convert("RGB").resize((w // 3, h // 3)).save(os.path.join(OUT, name + ".png"))
    print("wrote", name, w, h)


if __name__ == "__main__":
    which = sys.argv[1:] or ["all"]
    cases = {
        "clean_ink": lambda: make_sheet("Inkfree.ttf", 120, 1),
        "clean_script": lambda: make_sheet("segoesc.ttf", 110, 2, thick=2),
        "clean_comic": lambda: make_sheet("comic.ttf", 110, 3, thick=1),
        "tilt": lambda: photo_effects(make_sheet("Inkfree.ttf", 120, 4), tilt=4.0),
        "shadow": lambda: photo_effects(make_sheet("Inkfree.ttf", 120, 5), shadow=0.35),
        "blur_light": lambda: photo_effects(make_sheet("Inkfree.ttf", 120, 6), blur=1.5),
        "blur_heavy": lambda: photo_effects(make_sheet("Inkfree.ttf", 120, 6), blur=6),
        "table": lambda: photo_effects(make_sheet("Inkfree.ttf", 120, 7), tilt=3, table=True, noise=4),
        "no_comma": lambda: make_sheet("Inkfree.ttf", 120, 8, drop_comma_at=10),
        "faint": lambda: photo_effects(make_sheet("Inkfree.ttf", 120, 9).point(lambda v: 200 if v < 100 else v)),
        "small": lambda: make_sheet("Inkfree.ttf", 70, 10, line_gap=2.2),
        # phone held at an angle (page seen as a trapezoid)
        "stray": lambda: add_specks(make_sheet("Inkfree.ttf", 120, 1), [(930, 680, 14, 10), (962, 690, 14, 10)]),
        "persp_top": lambda: warp_quad(make_sheet("Inkfree.ttf", 120, 11),
                                       [(0.10, 0.02), (0.90, 0.02), (1.02, 1.0), (-0.02, 1.0)]),
        "persp_side": lambda: warp_quad(make_sheet("Inkfree.ttf", 120, 12),
                                        [(0.0, 0.0), (1.0, 0.07), (1.0, 0.93), (0.0, 1.0)]),
        "persp_hard": lambda: warp_quad(make_sheet("Inkfree.ttf", 120, 14),
                                        [(0.16, 0.07), (0.97, 0.0), (1.0, 1.0), (-0.03, 0.90)]),
        "persp_both": lambda: photo_effects(warp_quad(make_sheet("Inkfree.ttf", 120, 13),
                                                      [(0.07, 0.03), (0.95, 0.0), (0.98, 0.97), (0.0, 1.0)]),
                                            tilt=3, noise=3),
    }
    for name, fn in cases.items():
        if which == ["all"] or name in which:
            save(fn(), name)
