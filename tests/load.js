// Developer-only helper: loads the app's source files into node so they can be tested.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src");
const FILES = ["charset.js", "outline.js", "reader.js", "tracer.js", "library.js", "fontwriter.js", "layout.js", "pdfwriter.js"];

function loadAll() {
  globalThis.HF = {};
  for (const f of FILES) {
    const p = path.join(SRC, f);
    if (!fs.existsSync(p)) continue;
    vm.runInThisContext(fs.readFileSync(p, "utf8"), { filename: p });
  }
  return globalThis.HF;
}

function readRgba(name) {
  const buf = fs.readFileSync(path.join(__dirname, "out", name + ".rgba"));
  const width = buf.readUInt32LE(0), height = buf.readUInt32LE(4);
  return { width, height, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, width * height * 4) };
}

module.exports = { loadAll, readRgba };
