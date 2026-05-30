/**
 * @module io/zip — a tiny, dependency-free ZIP reader (read-only).
 *
 * Enough to open `.openstereo` projects: parses the central directory, then
 * inflates each entry with the platform DecompressionStream('deflate-raw')
 * (browsers + Node ≥ 18). Handles stored (0) and deflate (8); no ZIP64.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CDIR = 0x02014b50;

async function inflateRaw(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Unzip an ArrayBuffer/Uint8Array into a map of { filename: Uint8Array }.
 * @returns {Promise<Record<string, Uint8Array>>}
 */
export async function unzip(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // locate the End-Of-Central-Directory record (scan back over its variable comment)
  let eocd = -1;
  for (let i = dv.byteLength - 22; i >= 0; i--) { if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; } }
  if (eocd < 0) throw new Error('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);            // start of central directory
  const dec = new TextDecoder();
  const entries = [];
  for (let n = 0; n < count && off + 46 <= dv.byteLength; n++) {
    if (dv.getUint32(off, true) !== SIG_CDIR) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const out = {};
  for (const e of entries) {
    // the local header repeats name/extra lengths; data follows it
    const lNameLen = dv.getUint16(e.localOff + 26, true);
    const lExtraLen = dv.getUint16(e.localOff + 28, true);
    const start = e.localOff + 30 + lNameLen + lExtraLen;
    const comp = u8.subarray(start, start + e.compSize);
    if (e.method === 0) out[e.name] = comp.slice();
    else if (e.method === 8) out[e.name] = await inflateRaw(comp);
    else throw new Error(`unsupported zip compression method ${e.method} for ${e.name}`);
  }
  return out;
}

/** True if the bytes start with the ZIP local-file signature "PK\x03\x04". */
export function looksLikeZip(u8) {
  return u8 && u8.length >= 2 && u8[0] === 0x50 && u8[1] === 0x4b;
}
