import test from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { deriveKeys, counterBlock, aesCtrLE, encryptEntry, decryptEntry, aesExtra, parseAesExtra } from "../public/js/zipcrypto.js";
import { createZip, readZip, zipNeedsPassword, crc32 } from "../public/js/zip.js";

const hex = (u8) => Buffer.from(u8).toString("hex");
const fromHex = (s) => new Uint8Array(Buffer.from(s, "hex"));

// Reference WinZip AES written against node:crypto (OpenSSL), independent of the WebCrypto code under test:
// PBKDF2-HMAC-SHA1 x1000, AES-ECB of explicit little-endian counter blocks starting at 1, HMAC-SHA1 / 10.
function referenceEncrypt(data, password, salt) {
  const n = salt.length * 2;
  const km = nodeCrypto.pbkdf2Sync(Buffer.from(password, "utf8"), salt, 1000, 2 * n + 2, "sha1");
  const ecb = nodeCrypto.createCipheriv(`aes-${n * 8}-ecb`, km.subarray(0, n), null);
  ecb.setAutoPadding(false);
  const out = Buffer.alloc(data.length);
  for (let i = 0; i * 16 < data.length; i++) {
    const ctr = Buffer.alloc(16);
    ctr.writeBigUInt64LE(BigInt(i + 1), 0);
    const ks = ecb.update(ctr);
    for (let j = 0; j < 16 && i * 16 + j < data.length; j++) out[i * 16 + j] = data[i * 16 + j] ^ ks[j];
  }
  const mac = nodeCrypto.createHmac("sha1", km.subarray(n, 2 * n)).update(out).digest().subarray(0, 10);
  return Buffer.concat([Buffer.from(salt), km.subarray(2 * n), out, mac]);
}

test("PBKDF2-HMAC-SHA1 matches RFC 6070 (the KDF WinZip AES uses)", async () => {
  // Our 1000-iteration derivation against node:crypto, and RFC 6070 test 1 (c = 1) for WebCrypto's PBKDF2-SHA1.
  const salt = fromHex("000102030405060708090a0b0c0d0e0f");
  const { raw } = await deriveKeys("password", salt, 3);
  assert.equal(hex(raw), nodeCrypto.pbkdf2Sync("password", salt, 1000, 66, "sha1").toString("hex"));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode("password"), "PBKDF2", false, ["deriveBits"]);
  const rfc = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-1", salt: new TextEncoder().encode("salt"), iterations: 1 }, base, 160));
  assert.equal(hex(rfc), "0c60c80f961f0e71f3a9b524af6012062fe037a6");
});

test("AES-256 block matches FIPS-197 C.3 through the per-block CTR trick", async () => {
  const key = await crypto.subtle.importKey("raw", fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"), "AES-CTR", false, ["encrypt"]);
  const ks = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: fromHex("00112233445566778899aabbccddeeff"), length: 64 }, key, new Uint8Array(16)));
  assert.equal(hex(ks), "8ea2b7ca516745bfeafc49904b496089");
});

test("counter blocks are little-endian, starting at 1", () => {
  assert.equal(hex(counterBlock(1)), "01000000000000000000000000000000");
  assert.equal(hex(counterBlock(256)), "00010000000000000000000000000000");
  assert.equal(hex(counterBlock(0x01020304)), "04030201000000000000000000000000");
});

test("fixed test vector: password 'secret', salt 00..0f, 37 bytes", async () => {
  const salt = fromHex("000102030405060708090a0b0c0d0e0f");
  const data = new TextEncoder().encode("Denotation WinZip AES test vector 01!");
  const got = await encryptEntry(data, "secret", { salt });
  const ref = referenceEncrypt(data, "secret", salt);
  assert.equal(hex(got), ref.toString("hex"));
  assert.equal(hex(got), VECTOR);
  assert.deepEqual(await decryptEntry(got, "secret"), data);
});
// Computed independently with Python's `cryptography` (AES-ECB of LE counters + hashlib PBKDF2 / HMAC).
const VECTOR = "000102030405060708090a0b0c0d0e0fa3361edc502f3af4c08ceb1e82e3adba0f678145a92ff2bdd399039016ace3bc7da4861723f577eecc677304b96b73594b";

test("matches the reference for random sizes, passwords and all three strengths", async () => {
  for (let i = 0; i < 40; i++) {
    const len = [0, 1, 15, 16, 17, 31, 32, 33, 1000, 40000][i % 10] + (i >> 3);
    const data = nodeCrypto.randomBytes(len);
    const strength = 1 + (i % 3);
    const salt = nodeCrypto.randomBytes(4 + 4 * strength);
    const pw = `pä$$-${i}-🔑`;
    const got = await encryptEntry(new Uint8Array(data), pw, { strength, salt: new Uint8Array(salt) });
    assert.equal(hex(got), referenceEncrypt(data, pw, salt).toString("hex"), `case ${i}`);
    assert.deepEqual(Buffer.from(await decryptEntry(got, pw, strength)), data);
  }
});

test("wrong password and tampering are detected", async () => {
  const data = new TextEncoder().encode("hello hello hello hello");
  const enc = await encryptEntry(data, "right");
  await assert.rejects(decryptEntry(enc, "wrong"), (e) => e.code === "bad-password");
  const t = enc.slice();
  t[20] ^= 1;
  await assert.rejects(decryptEntry(t, "right"), (e) => e.code === "bad-password");
  await assert.rejects(decryptEntry(enc.subarray(0, 20), "right"), (e) => e.code === "corrupt");
});

test("AES extra field round-trips", () => {
  const x = aesExtra(8);
  assert.equal(hex(x), "0199070002004145030800");
  assert.deepEqual(parseAesExtra(x), { vendorVersion: 2, strength: 3, method: 8 });
  const withOther = new Uint8Array([0x55, 0x54, 1, 0, 9, ...x]);
  assert.deepEqual(parseAesExtra(withOther), { vendorVersion: 2, strength: 3, method: 8 });
  assert.equal(parseAesExtra(new Uint8Array([1, 2])), null);
});

const files = [
  { path: "denotation.json", data: JSON.stringify({ app: "denotation", format: "json", version: 1 }) },
  { path: "pages/a.json", data: JSON.stringify({ id: "a", title: "Secret plans ".repeat(50) }) },
  { path: "rows/r.json", data: "x" },
  { path: "attachments/img.png", data: new Uint8Array([137, 80, 78, 71, 0, 1, 2]) }
];

test("passworded ZIP: AE-2 headers, round trip, nothing in clear", async () => {
  const zip = await createZip(files, { password: "hunter2" });
  const v = new DataView(zip.buffer);
  assert.equal(v.getUint16(4, true), 51, "version needed 5.1");
  assert.equal(v.getUint16(6, true) & 1, 1, "encrypted flag");
  assert.equal(v.getUint16(8, true), 99, "method 99");
  assert.equal(v.getUint32(14, true), 0, "AE-2 stores CRC 0");
  assert.ok(!Buffer.from(zip).includes("Secret plans"));
  assert.ok(Buffer.from(zip).includes("pages/a.json"), "names stay visible (standard ZIP)");
  assert.equal(await zipNeedsPassword(zip), true);
  await assert.rejects(readZip(zip), (e) => e.code === "password-required");
  await assert.rejects(readZip(zip, { password: "hunter3" }), (e) => e.code === "bad-password");
  const out = await readZip(zip, { password: "hunter2" });
  assert.deepEqual(out.map((f) => f.path), files.map((f) => f.path));
  for (let i = 0; i < files.length; i++) {
    const want = typeof files[i].data === "string" ? new TextEncoder().encode(files[i].data) : files[i].data;
    assert.deepEqual(out[i].data, want);
  }
  // our deflated entry decrypts with the independent reference too (salt from the file)
  const nlen = v.getUint16(26, true);
  const xlen = v.getUint16(28, true);
  const csize = v.getUint32(18, true);
  const body = zip.subarray(30 + nlen + xlen, 30 + nlen + xlen + csize);
  assert.equal(hex(body), referenceEncrypt(Buffer.from(await decryptEntry(body, "hunter2")), "hunter2", body.subarray(0, 16)).toString("hex"));
});

test("plain ZIPs are unchanged; ZipCrypto entries and zip-slip are still refused", async () => {
  const plain = await createZip(files);
  assert.equal(await zipNeedsPassword(plain), false);
  assert.equal((await readZip(plain)).length, 4);
  // flag bit 0 without method 99 = traditional ZipCrypto
  const z = plain.slice();
  const dv = new DataView(z.buffer);
  const eocd = z.length - 22;
  const cd = dv.getUint32(eocd + 16, true);
  dv.setUint16(cd + 8, dv.getUint16(cd + 8, true) | 1, true);
  await assert.rejects(readZip(z), /ZipCrypto/);
  const evil = await createZip([{ path: "../evil.json", data: "{}" }], { password: "p" });
  await assert.rejects(readZip(evil, { password: "p" }), /Unsafe path/);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});
