// In-house ZIP reader/writer. No dependencies. Methods 0 (store) and 8 (deflate).
// Deflate uses the built-in CompressionStream / DecompressionStream("deflate-raw").

const MAX_TOTAL = 512 * 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");

let CRC_TABLE = null;
function table() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

export function crc32(bytes) {
  const t = table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(bytes, stream) {
  const writer = stream.writable.getWriter();
  const done = writer.write(bytes).then(() => writer.close());
  const chunks = [];
  let total = 0;
  const reader = stream.readable.getReader();
  for (;;) {
    const { done: fin, value } = await reader.read();
    if (fin) break;
    chunks.push(value);
    total += value.length;
    if (total > MAX_TOTAL) {
      await reader.cancel().catch(() => {});
      throw new Error("ZIP entry too large (limit 512 MB)");
    }
  }
  await done;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const canCompress = () => typeof CompressionStream === "function";
const canDecompress = () => typeof DecompressionStream === "function";

function dosDateTime(d) {
  if (!(d instanceof Date) || isNaN(d)) d = new Date();
  let y = d.getFullYear();
  if (y < 1980) { y = 1980; d = new Date(1980, 0, 1); }
  if (y > 2107) y = 2107;
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export async function createZip(files, { compress = true } = {}) {
  const useDeflate = compress && canCompress();
  const parts = [];
  const central = [];
  let offset = 0;
  if (files.length > 0xffff) throw new Error("Too many files for a non-ZIP64 archive");
  for (const f of files) {
    const nameBytes = enc.encode(String(f.path));
    const raw = typeof f.data === "string" ? enc.encode(f.data) : f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
    const crc = crc32(raw);
    let method = 0;
    let body = raw;
    if (useDeflate && raw.length > 0) {
      const z = await pipe(raw, new CompressionStream("deflate-raw"));
      if (z.length < raw.length) { method = 8; body = z; }
    }
    if (raw.length >= 0xffffffff || body.length >= 0xffffffff || offset >= 0xffffffff) {
      throw new Error("ZIP64 archives are not supported");
    }
    const { time, date } = dosDateTime(f.date);
    const flags = 0x0800;
    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    central.push(ch);

    parts.push(lh, body);
    offset += lh.length + body.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { parts.push(c); cdSize += c.length; }
  if (cdStart + cdSize >= 0xffffffff) throw new Error("ZIP64 archives are not supported");
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  parts.push(eocd);
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function cleanPath(name) {
  const p = name.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new Error(`Unsafe path in ZIP (absolute): ${name}`);
  if (p.split("/").some((s) => s === "..")) throw new Error(`Unsafe path in ZIP (".."): ${name}`);
  return p;
}

export async function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 22) throw new Error("Not a ZIP file (too small)");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= lowest; i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP file (end of central directory not found)");
  if (eocd >= 20 && v.getUint32(eocd - 20, true) === 0x07064b50) throw new Error("ZIP64 archives are not supported");
  const count = v.getUint16(eocd + 10, true);
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOff = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new Error("ZIP64 archives are not supported");
  if (cdOff + cdSize > bytes.length) throw new Error("Corrupt ZIP (central directory out of range)");

  // First pass: parse entries and check total declared size.
  const entries = [];
  let p = cdOff;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt ZIP (bad central directory entry)");
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const lho = v.getUint32(p + 42, true);
    if (p + 46 + nlen > bytes.length) throw new Error("Corrupt ZIP (truncated entry)");
    const rawName = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) throw new Error("ZIP64 archives are not supported");
    if (flags & 1) throw new Error(`Encrypted ZIP entries are not supported: ${rawName}`);
    total += usize;
    if (total > MAX_TOTAL) throw new Error("ZIP archive too large (uncompressed size exceeds 512 MB)");
    entries.push({ rawName, flags, method, crc, csize, usize, lho });
  }

  const out = [];
  for (const e of entries) {
    const path = cleanPath(e.rawName);
    if (path.endsWith("/")) continue;
    if (e.method !== 0 && e.method !== 8) throw new Error(`Unsupported ZIP compression method ${e.method}: ${e.rawName}`);
    const q = e.lho;
    if (q + 30 > bytes.length || v.getUint32(q, true) !== 0x04034b50) throw new Error(`Corrupt ZIP (bad local header): ${e.rawName}`);
    const start = q + 30 + v.getUint16(q + 26, true) + v.getUint16(q + 28, true);
    if (start + e.csize > bytes.length) throw new Error(`Corrupt ZIP (data out of range): ${e.rawName}`);
    const body = bytes.subarray(start, start + e.csize);
    let data;
    if (e.method === 0) {
      data = body.slice();
    } else {
      if (!canDecompress()) throw new Error("DecompressionStream is not available in this environment");
      data = await pipe(body, new DecompressionStream("deflate-raw"));
    }
    if (data.length !== e.usize) throw new Error(`Corrupt ZIP (size mismatch): ${e.rawName}`);
    if (crc32(data) !== e.crc) throw new Error(`CRC32 mismatch (corrupt data): ${e.rawName}`);
    out.push({ path, data });
  }
  return out;
}
