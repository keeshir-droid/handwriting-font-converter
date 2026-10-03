"""Developer-only. Checks a .ttf made by tests/test_font.js with fontTools and draws a sample with Pillow.

    python tests/validate_font.py [name]        (default clean_ink)

Needs: fonttools, pillow (dev only, never shipped).
"""
import os
import struct
import sys

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
name = sys.argv[1] if len(sys.argv) > 1 else "clean_ink"
path = os.path.join(OUT, name + ".ttf")
problems = []


def check(cond, msg):
    if not cond:
        problems.append(msg)
        print("  PROBLEM:", msg)


raw = open(path, "rb").read()

# 1) whole-file checksum rule: sum of all uint32 words == 0xB1B0AFBA
padded = raw + b"\0" * (-len(raw) % 4)
total = sum(struct.unpack(">%dI" % (len(padded) // 4), padded)) & 0xFFFFFFFF
check(total == 0xB1B0AFBA, "file checksum is %08X, expected B1B0AFBA" % total)

# 2) table directory checksums
num = struct.unpack(">H", raw[4:6])[0]
for i in range(num):
    tag, csum, off, length = struct.unpack(">4sIII", raw[12 + 16 * i: 28 + 16 * i])
    data = raw[off: off + length]
    data += b"\0" * (-len(data) % 4)
    s = sum(struct.unpack(">%dI" % (len(data) // 4), data)) & 0xFFFFFFFF
    if tag == b"head":  # computed with checkSumAdjustment = 0
        d = bytearray(data); d[8:12] = b"\0\0\0\0"
        s = sum(struct.unpack(">%dI" % (len(d) // 4), bytes(d))) & 0xFFFFFFFF
    check(s == csum, "table %s checksum mismatch" % tag.decode())
    check(off % 4 == 0, "table %s not 4-byte aligned" % tag.decode())

# 3) fontTools can read everything
font = TTFont(path, lazy=False)
tables = sorted(font.keys())
print("tables:", " ".join(tables))
for t in ["OS/2", "cmap", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "name", "post"]:
    check(t in font, "missing table " + t)

order = font.getGlyphOrder()
cmap = font.getBestCmap()
print("glyphs:", len(order), " characters mapped:", len(cmap), " unitsPerEm:", font["head"].unitsPerEm)
check(font["maxp"].numGlyphs == len(order), "numGlyphs mismatch")
check(font["head"].unitsPerEm == 1000, "unitsPerEm is not 1000")

# 4) every printable ASCII character is mapped
want = [chr(c) for c in range(0x41, 0x5B)] + [chr(c) for c in range(0x61, 0x7B)] + list("0123456789.,!?'-:;()& ")
missing = [c for c in want if ord(c) not in cmap]
check(not missing, "characters not in the font: %r" % "".join(missing))
for c in [" ", "‘", "’", "“", "”", "–", "—", "…", '"']:
    check(ord(c) in cmap, "missing U+%04X" % ord(c))

# 5) outlines: stored bounds == recomputed bounds, no empty glyphs for letters, contour counts sane
glyf = font["glyf"]
hmtx = font["hmtx"]
bad_bounds = 0
for g in order:
    gl = glyf[g]
    if gl.numberOfContours > 0:
        stored = (gl.xMin, gl.yMin, gl.xMax, gl.yMax)
        gl.recalcBounds(glyf)
        if stored != (gl.xMin, gl.yMin, gl.xMax, gl.yMax):
            bad_bounds += 1
check(bad_bounds == 0, "%d glyphs have wrong stored bounds" % bad_bounds)
for c in "AaBbgyi0&.,":
    if ord(c) in cmap:
        gl = glyf[cmap[ord(c)]]
        check(gl.numberOfContours > 0, "glyph %r has no outline" % c)
check(glyf[cmap[32]].numberOfContours == 0, "space should be empty")
check(hmtx[cmap[32]][0] > 0, "space has no width")

# 6) rendered sample (Pillow uses FreeType, a second opinion on the file)
try:
    f_big = ImageFont.truetype(path, 120)
    f_small = ImageFont.truetype(path, 64)
    img = Image.new("L", (1900, 760), 255)
    d = ImageDraw.Draw(img)
    d.text((40, 20), "Dear friend, I wish I", font=f_big, fill=0)
    d.text((40, 170), "could hand you this note!", font=f_big, fill=0)
    d.text((40, 330), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", font=f_small, fill=0)
    d.text((40, 420), "abcdefghijklmnopqrstuvwxyz", font=f_small, fill=0)
    d.text((40, 510), "0123456789 .,!?'-:;()& “quoted” — wait…", font=f_small, fill=0)
    d.text((40, 620), "Quick brown fox: \"jumps\" over 13 lazy dogs (really)?", font=f_small, fill=0)
    sample = os.path.join(OUT, name + ".ttf.png")
    img.save(sample)
    print("rendered", sample)
except Exception as e:  # noqa: BLE001
    check(False, "Pillow/FreeType could not load the font: %r" % e)

fam = font["name"].getDebugName(1)
print("family name:", fam, "| postscript:", font["name"].getDebugName(6))
print("\n%d problem(s)" % len(problems) if problems else "\nfont looks valid")
sys.exit(1 if problems else 0)
