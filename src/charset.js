// The fixed list of characters a person writes on paper, in order.
// Order: A a B b ... Z z, then 0-9, then a few punctuation marks.
// (The comma is not in the list: the commas people write BETWEEN items become the comma glyph.)
(function () {
  const HF = (globalThis.HF = globalThis.HF || {});

  const PUNCT = ".!?'-:;()&";
  const NO_BASELINE = "gjpqyQJ"; // letters that hang below the line: don't use them to find the baseline
  const CAP_REF = "ABCDEFGHIKLMNOPRSTUVWXYZ"; // capitals used to measure writing size (J and Q can hang)
  const SMALL_ITEMS = ".'-:;"; // marks that are naturally tiny, so they may look "comma-like"

  const ORDER = [];
  for (let i = 0; i < 26; i++) {
    ORDER.push(String.fromCharCode(65 + i));
    ORDER.push(String.fromCharCode(97 + i));
  }
  for (let d = 0; d < 10; d++) ORDER.push(String(d));
  for (const p of PUNCT) ORDER.push(p);

  function kindOf(ch) {
    if (ch >= "A" && ch <= "Z") return "cap";
    if (ch >= "a" && ch <= "z") return "low";
    if (ch >= "0" && ch <= "9") return "digit";
    return "punct";
  }

  const ITEMS = ORDER.map(function (ch) {
    const kind = kindOf(ch);
    return {
      ch: ch,
      kind: kind,
      baselineOK: kind !== "punct" && NO_BASELINE.indexOf(ch) < 0,
      capRef: CAP_REF.indexOf(ch) >= 0,
      small: SMALL_ITEMS.indexOf(ch) >= 0,
    };
  });

  // The list as people should write it, split into lines for display.
  function displayLines(perLine) {
    perLine = perLine || 12;
    const lines = [];
    for (let i = 0; i < ORDER.length; i += perLine) {
      lines.push(ORDER.slice(i, i + perLine));
    }
    return lines;
  }

  HF.charset = { ORDER: ORDER, ITEMS: ITEMS, displayLines: displayLines, PUNCT: PUNCT };
})();
