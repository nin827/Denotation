// WinZip AES encryption for ZIP entries (AE-1 / AE-2), built on WebCrypto. No dependencies.
// Spec: WinZip "AES Encryption Information" (https://www.winzip.com/en/support/aes-encryption/).
//
//   entry data = salt (8 / 12 / 16 bytes for AES-128 / 192 / 256) | password verifier (2) | ciphertext | auth code (10)
//   keys       = PBKDF2-HMAC-SHA1(password UTF-8, salt, 1000 iterations) -> AES key | HMAC key | verifier
//                (key lengths 16 / 24 / 32 bytes each, then 2 verifier bytes)
//   cipher     = AES in CTR mode with a 16-byte counter block that is a little-endian integer starting at 1
//                (Gladman's fcrypt). WebCrypto's AES-CTR increments big-endian, so each counter block is built here
//                and encrypted on its own (AES-CTR over one zero block with that counter = AES-ECB of the counter).
//   auth code  = HMAC-SHA1(HMAC key, ciphertext), first 10 bytes.
//   ZIP header: method 99, general flag bit 0, extra field 0x9901 { vendor version (1 = AE-1, 2 = AE-2), "AE",
//               strength (1 / 2 / 3), actual method }. AE-2 stores CRC-32 = 0 (the auth code protects the data).

export const AES_METHOD = 99;
export const AES_EXTRA_ID = 0x9901;
export const PBKDF2_ITERATIONS = 1000;
const KEY_LEN = { 1: 16, 2: 24, 3: 32 };
const subtle = () => globalThis.crypto.subtle;
const te = new TextEncoder();
const BATCH = 2048;

const fail = (msg, code) => Object.assign(new Error(msg), { code });

/** PBKDF2-HMAC-SHA1 key material for `strength` (3 = AES-256). -> { aesKey, hmacKey, verifier, raw } */
export async function deriveKeys(password, salt, strength = 3) {
  const n = KEY_LEN[strength];
  if (!n) throw fail(`Unsupported AES strength ${strength}`, "corrupt");
  if (salt.length !== n / 2) throw fail("Wrong salt length for this AES strength", "corrupt");
  const base = await subtle().importKey("raw", te.encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  const raw = new Uint8Array(await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-1", salt, iterations: PBKDF2_ITERATIONS }, base, (2 * n + 2) * 8));
  const aesKey = await subtle().importKey("raw", raw.slice(0, n), "AES-CTR", false, ["encrypt"]);
  const hmacKey = await subtle().importKey("raw", raw.slice(n, 2 * n), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return { aesKey, hmacKey, verifier: raw.slice(2 * n), raw };
}

/** The 16-byte little-endian counter block for block number `i` (WinZip starts at 1). */
export function counterBlock(i) {
  const b = new Uint8Array(16);
  let v = i;
  for (let k = 0; k < 8 && v > 0; k++) {
    b[k] = v % 256;
    v = Math.floor(v / 256);
  }
  return b;
}

/** XOR `data` with the WinZip AES-CTR keystream (encrypt and decrypt are the same). */
export async function aesCtrLE(aesKey, data) {
  const out = new Uint8Array(data.length);
  const blocks = Math.ceil(data.length / 16);
  const zero = new Uint8Array(16);
  for (let start = 0; start < blocks; start += BATCH) {
    const end = Math.min(blocks, start + BATCH);
    const ks = await Promise.all(
      Array.from({ length: end - start }, (_, j) => subtle().encrypt({ name: "AES-CTR", counter: counterBlock(start + j + 1), length: 64 }, aesKey, zero))
    );
    for (let j = 0; j < ks.length; j++) {
      const k = new Uint8Array(ks[j]);
      const off = (start + j) * 16;
      const lim = Math.min(16, data.length - off);
      for (let x = 0; x < lim; x++) out[off + x] = data[off + x] ^ k[x];
    }
  }
  return out;
}

const mac10 = async (hmacKey, ct) => new Uint8Array(await subtle().sign("HMAC", hmacKey, ct)).slice(0, 10);
function equal(a, b) {
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return d === 0;
}

/** Encrypt one entry's (already compressed) data. -> salt | verifier | ciphertext | auth code */
export async function encryptEntry(data, password, { strength = 3, salt = null } = {}) {
  const n = KEY_LEN[strength];
  const s = salt ?? globalThis.crypto.getRandomValues(new Uint8Array(n / 2));
  const { aesKey, hmacKey, verifier } = await deriveKeys(password, s, strength);
  const ct = await aesCtrLE(aesKey, data);
  const mac = await mac10(hmacKey, ct);
  const out = new Uint8Array(s.length + 2 + ct.length + 10);
  out.set(s, 0);
  out.set(verifier, s.length);
  out.set(ct, s.length + 2);
  out.set(mac, s.length + 2 + ct.length);
  return out;
}

/** Decrypt one entry's data. Throws code "bad-password" (wrong password) or "corrupt" (damaged / tampered). */
export async function decryptEntry(body, password, strength = 3) {
  const n = KEY_LEN[strength];
  if (!n) throw fail(`Unsupported AES strength ${strength}`, "corrupt");
  const sl = n / 2;
  if (body.length < sl + 2 + 10) throw fail("Corrupt encrypted ZIP entry (too short)", "corrupt");
  const salt = body.subarray(0, sl);
  const { aesKey, hmacKey, verifier } = await deriveKeys(password, salt, strength);
  if (!equal(verifier, body.subarray(sl, sl + 2))) throw fail("Wrong password.", "bad-password");
  const ct = body.subarray(sl + 2, body.length - 10);
  if (!equal(await mac10(hmacKey, ct), body.subarray(body.length - 10))) {
    throw fail("Wrong password, or the ZIP is damaged (authentication failed).", "bad-password");
  }
  return aesCtrLE(aesKey, ct);
}

/** The 11-byte AES extra field. */
export function aesExtra(actualMethod, { strength = 3, vendorVersion = 2 } = {}) {
  const x = new Uint8Array(11);
  const v = new DataView(x.buffer);
  v.setUint16(0, AES_EXTRA_ID, true);
  v.setUint16(2, 7, true);
  v.setUint16(4, vendorVersion, true);
  x[6] = 0x41; // "A"
  x[7] = 0x45; // "E"
  x[8] = strength;
  v.setUint16(9, actualMethod, true);
  return x;
}
/** Find and parse the AES extra field in an extra-field block. -> { vendorVersion, strength, method } | null */
export function parseAesExtra(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let p = 0; p + 4 <= bytes.length;) {
    const id = v.getUint16(p, true);
    const size = v.getUint16(p + 2, true);
    if (p + 4 + size > bytes.length) return null;
    if (id === AES_EXTRA_ID && size >= 7 && bytes[p + 6] === 0x41 && bytes[p + 7] === 0x45) {
      return { vendorVersion: v.getUint16(p + 4, true), strength: bytes[p + 8], method: v.getUint16(p + 9, true) };
    }
    p += 4 + size;
  }
  return null;
}
