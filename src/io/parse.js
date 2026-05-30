/**
 * @module io/parse — minimal text → measurements (the I/O seam, load side).
 *
 * v0: a forgiving line parser for `<a> <b>` degree pairs (whitespace, comma, or
 * slash separated; `#`/`;` comments). The seam is the point: standalone reads
 * files here; a Works surface swaps in a VFS reader; columnar CSV import (map
 * columns → attitude roles) lands here later and produces typed DataItems.
 */

export function parsePairs(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const m = line.split(/[\s,/]+/).filter(Boolean);
    if (m.length < 2) continue;
    const a = parseFloat(m[0]), b = parseFloat(m[1]);
    if (Number.isFinite(a) && Number.isFinite(b)) out.push([a, b]);
  }
  return out;
}
