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

/** Parse `<trend> <plunge> <aperture>` triples (for small circles). */
export function parseTriples(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const m = line.split(/[\s,/]+/).filter(Boolean);
    if (m.length < 3) continue;
    const t = parseFloat(m[0]), p = parseFloat(m[1]), a = parseFloat(m[2]);
    if (Number.isFinite(t) && Number.isFinite(p) && Number.isFinite(a)) out.push([t, p, a]);
  }
  return out;
}

// fault sense letter → numeric code (fault.resolveSense accepts both)
const SENSE_CODE = { n: 2, '-': 2, i: 1, r: 1, '+': 1, d: 3, s: 4, u: 0, f: 0, '?': 0 };

/** Parse `<dip dir> <dip> <rake> [sense]` fault rows; sense may be a letter or number. */
export function parseFaults(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/[#].*$/, '').trim();
    if (!line) continue;
    const m = line.split(/[\s,/]+/).filter(Boolean);
    if (m.length < 3) continue;
    const dd = parseFloat(m[0]), dip = parseFloat(m[1]), rake = parseFloat(m[2]);
    if (![dd, dip, rake].every(Number.isFinite)) continue;
    let sense = 0;
    if (m[3] != null) { const n = parseFloat(m[3]); sense = Number.isFinite(n) ? n : (SENSE_CODE[String(m[3]).toLowerCase()[0]] ?? 0); }
    out.push([dd, dip, rake, sense]);
  }
  return out;
}

// Pick the delimiter of a tabular line: comma / tab / semicolon by frequency,
// else null (meaning whitespace-separated).
function pickDelim(line) {
  const best = [',', '\t', ';']
    .map((d) => [d, line.split(d).length - 1])
    .sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : null;
}
const splitRow = (line, delim) => (delim ? line.split(delim) : line.trim().split(/\s+/)).map((s) => s.trim());

/**
 * Parse delimited text into columns. Auto-detects delimiter (comma/tab/semicolon
 * /whitespace) and whether the first row is a header (any non-numeric cell).
 * `#`-comment lines are skipped. Returns { columns:[{name,values}], rows:[[...]] }.
 */
export function parseTable(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) return { columns: [], rows: [] };
  const delim = pickDelim(lines[0]);
  const grid = lines.map((l) => splitRow(l, delim));
  const ncol = Math.max(...grid.map((r) => r.length));
  const hasHeader = grid[0].some((c) => c !== '' && !Number.isFinite(parseFloat(c)));
  const header = hasHeader ? grid[0] : Array.from({ length: ncol }, (_, i) => `col${i + 1}`);
  const rows = hasHeader ? grid.slice(1) : grid;
  const columns = header.map((name, i) => ({ name: name || `col${i + 1}`, values: rows.map((r) => r[i] ?? '') }));
  return { columns, rows };
}

// Heuristic: guess which columns hold azimuth and dip/plunge from header names.
export function guessRoles(columns) {
  const az = columns.findIndex((c) => /dip\s*dir|dipdir|azimuth|strike|trend|^dd$|direction/i.test(c.name));
  const dip = columns.findIndex((c, i) => i !== az && /dip|plunge|^pl$/i.test(c.name));
  return { azIdx: az >= 0 ? az : 0, dipIdx: dip >= 0 ? dip : 1 };
}

/**
 * Build a typed item payload from a parsed table + column mapping.
 * Keeps only rows whose azimuth and dip parse as finite numbers, and slices
 * every column to the same kept rows so colour-by stays aligned.
 */
export function buildFromTable(table, { azIdx, dipIdx }) {
  const measurements = [], keep = [];
  table.rows.forEach((r, i) => {
    const a = parseFloat(r[azIdx]), b = parseFloat(r[dipIdx]);
    if (Number.isFinite(a) && Number.isFinite(b)) { measurements.push([a, b]); keep.push(i); }
  });
  const columns = table.columns.map((c) => ({ name: c.name, values: keep.map((i) => c.values[i]) }));
  return { measurements, columns };
}
