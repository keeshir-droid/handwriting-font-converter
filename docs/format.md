# The handwriting library format

Everything the app makes comes from one small piece of data, the **library**. It is plain JSON, so other tools (and other projects in this series) can read it or produce it.

```json
{
  "glyphs": {
    "A": { "adv": 612.4, "contours": [ [ {"x": 45, "y": 0, "on": true}, {"x": 210.5, "y": 702.3, "on": false}, "..." ] ] },
    "a": { "adv": 540.0, "contours": [ "..." ] },
    " ": { "adv": 300, "contours": [] }
  },
  "aliases": { "’": "'", "“": "\"", " ": " " }
}
```

- **`glyphs`**: one entry per character. `adv` is the advance width and `contours` is the outline, an array of closed paths.
- **Units**: font units, 1000 per em. `y` points up and the baseline is `y = 0`. Capitals are about 700 high.
- **Points**: `on: true` points lie on the curve, `on: false` points are control points of a quadratic curve (TrueType style). Two off-curve points in a row imply an on-curve point halfway between them.
- **Winding**: outer shapes are clockwise and holes are counter-clockwise (so the "nonzero" fill rule draws them correctly).
- **`aliases`**: characters that reuse another character's shape (curly quotes, non-breaking space).

The app keeps this in the browser (`localStorage`, key `hfc.v1`) together with your ink, paper and text settings.

## Pipeline (one file each in `src/`)

| File | Does |
|---|---|
| `charset.js` | The ordered list of 72 characters to write, and facts about each one |
| `reader.js` | Photo → separate characters (finds the paper, straightens, groups ink blobs, uses the commas, checks the order) |
| `tracer.js` | One character's pixels → smooth quadratic outline |
| `library.js` | Traced letters → the full library above (adds space, `"`, dashes, ellipsis, aliases) |
| `fontwriter.js` | Library → `.ttf` bytes (hand-written TrueType writer) |
| `layout.js` | Text → positioned letters (word wrap, auto-fit, wobble, caret positions) |
| `pdfwriter.js` | Layout → one-page vector PDF |
| `app.js` | The interface, photo intake, drawing, saving, sharing |
