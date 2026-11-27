import test from "node:test";
import assert from "node:assert/strict";
import {
  KDF_ITERATIONS,
  createKeyFile,
  sanitizeKeyFile,
  unwrapWithPin,
  unwrapWithRecovery,
  unwrapWithSecret,
  rewrapPin,
  replaceRecovery,
  setSavedRecovery,
  readSavedRecovery,
  encryptRecord,
  decryptRecord,
  encryptText,
  decryptText,
  isEnvelope,
  encodeRecovery,
  parseRecovery,
  newRecoveryKey,
  createKeyring,
  LOCAL_KEYS,
  ENC_SETTINGS
} from "../public/js/crypto.js";
import { createLocalAdapter, migrateBrowserCopy, recordKeys } from "../public/js/adapters/local.js";

const FAST = 1000;
const memStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    map: m
  };
};
// Small seeded PRNG (mulberry32) for repeatable fuzz.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const raw = async (key) => new Uint8Array(await crypto.subtle.exportKey("raw", key));
const sameKey = async (a, b) => assert.deepEqual(await raw(a), await raw(b));

test("key file: shape, default 600k iterations, nothing secret in it", async () => {
  assert.ok(KDF_ITERATIONS >= 600000);
  const { file, dek, recovery } = await createKeyFile({ pin: "4821", iterations: FAST });
  assert.deepEqual(Object.keys(file).sort(), ["alg", "createdAt", "kdf", "kid", "pinWrap", "recoveryWrap", "updatedAt", "v"]);
  assert.equal(file.alg, "AES-256-GCM");
  assert.equal(atob(file.kdf.salt).length, 16);
  assert.equal(atob(file.pinWrap.iv).length, 12);
  assert.match(recovery, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/);
  const text = JSON.stringify(file);
  assert.ok(!text.includes("4821") && !text.includes(recovery.replace(/-/g, "")));
  assert.ok(!text.includes(btoa(String.fromCharCode(...(await raw(dek))))));
  assert.deepEqual(sanitizeKeyFile(file), file);
  assert.equal(sanitizeKeyFile({ ...file, v: 2 }), null);
  assert.equal(sanitizeKeyFile({ ...file, pinWrap: { iv: "x", ct: "y" } }), null);
  const real = await createKeyFile({ pin: "1234" });
  assert.equal(real.file.kdf.iterations, KDF_ITERATIONS);
});

test("wrap / unwrap with the PIN; a wrong PIN gives null", async () => {
  const { file, dek } = await createKeyFile({ pin: "135790", iterations: FAST });
  await sameKey(await unwrapWithPin(file, "135790"), dek);
  assert.equal(await unwrapWithPin(file, "135791"), null);
  assert.equal(await unwrapWithPin(file, "abc"), null);
  assert.equal(await unwrapWithPin({ ...file, kid: "zz" }, "135790"), null);
});

test("recovery key unwraps; typed forms are forgiving; wrong key gives null", async () => {
  const { file, dek, recovery } = await createKeyFile({ pin: "1111", iterations: FAST });
  await sameKey(await unwrapWithRecovery(file, recovery), dek);
  await sameKey(await unwrapWithRecovery(file, ` ${recovery.toLowerCase().replace(/-/g, " ")} `), dek);
  const r = await unwrapWithSecret(file, recovery);
  assert.equal(r.via, "recovery");
  assert.equal((await unwrapWithSecret(file, "1111")).via, "pin");
  assert.equal(await unwrapWithSecret(file, "2222"), null);
  assert.equal(await unwrapWithRecovery(file, newRecoveryKey()), null);
  assert.equal(await unwrapWithRecovery(file, "ABCD"), null);
});

test("recovery text encodes 160 bits and round-trips (fuzz)", () => {
  const next = rng(7);
  for (let i = 0; i < 200; i++) {
    const bytes = Uint8Array.from({ length: 20 }, () => Math.floor(next() * 256));
    const text = encodeRecovery(bytes);
    assert.equal(text.length, 39);
    assert.deepEqual(parseRecovery(text), bytes);
  }
  assert.equal(parseRecovery("not a key"), null);
});

test("PIN change re-wraps: new PIN opens, old PIN no longer does, recovery still works", async () => {
  const { file, dek, recovery } = await createKeyFile({ pin: "1234", iterations: FAST, now: 1 });
  const next = await rewrapPin(file, dek, "987654", { iterations: FAST, now: 2 });
  assert.equal(next.kid, file.kid);
  assert.notEqual(next.kdf.salt, file.kdf.salt);
  assert.equal(next.updatedAt, 2);
  assert.equal(await unwrapWithPin(next, "1234"), null);
  await sameKey(await unwrapWithPin(next, "987654"), dek);
  await sameKey(await unwrapWithRecovery(next, recovery), dek);
});

test("kept recovery key: stored with the DEK, readable only with it; replace / forget", async () => {
  const { file, dek, recovery } = await createKeyFile({ pin: "1234", iterations: FAST, keepRecovery: true });
  assert.ok(file.savedRecovery);
  assert.equal(await readSavedRecovery(file, dek), recovery);
  const other = (await createKeyFile({ pin: "1234", iterations: FAST })).dek;
  assert.equal(await readSavedRecovery(file, other), null);
  const forgot = await setSavedRecovery(file, dek, null);
  assert.equal(forgot.savedRecovery, undefined);
  await assert.rejects(setSavedRecovery(forgot, dek, newRecoveryKey()), /doesn't belong/);
  const kept = await setSavedRecovery(forgot, dek, recovery);
  assert.equal(await readSavedRecovery(kept, dek), recovery);
  const rep = await replaceRecovery(kept, dek, { keep: false });
  assert.equal(rep.file.savedRecovery, undefined);
  assert.equal(await unwrapWithRecovery(rep.file, recovery), null, "the old recovery key stops working");
  await sameKey(await unwrapWithRecovery(rep.file, rep.recovery), dek);
});

test("envelope round-trip, fresh IV per write, AAD binds collection/id, tampering detected", async () => {
  const { file, dek } = await createKeyFile({ pin: "1234", iterations: FAST });
  const rec = { id: "p1", type: "doc", title: "Secret plans", blocks: [{ id: "b", type: "p", text: "über ✓" }] };
  const a = await encryptRecord(dek, file.kid, "pages", "p1", rec);
  const b = await encryptRecord(dek, file.kid, "pages", "p1", rec);
  assert.ok(isEnvelope(a));
  assert.equal(a["denotation-enc"], 1);
  assert.equal(a.kid, file.kid);
  assert.notEqual(a.iv, b.iv);
  assert.ok(!JSON.stringify(a).includes("Secret"));
  assert.deepEqual(await decryptRecord(dek, "pages", "p1", a), rec);
  await assert.rejects(decryptRecord(dek, "pages", "p2", a), (e) => e.code === "decrypt", "moved to another id");
  await assert.rejects(decryptRecord(dek, "rows", "p1", a), (e) => e.code === "decrypt", "moved to another collection");
  const ct = atob(a.ct).split("");
  ct[3] = String.fromCharCode(ct[3].charCodeAt(0) ^ 1);
  await assert.rejects(decryptRecord(dek, "pages", "p1", { ...a, ct: btoa(ct.join("")) }), (e) => e.code === "decrypt", "flipped bit");
  const other = (await createKeyFile({ pin: "1234", iterations: FAST })).dek;
  await assert.rejects(decryptRecord(other, "pages", "p1", a), (e) => e.code === "decrypt", "another key");
  await assert.rejects(decryptText(null, "pages", "p1", a), (e) => e.code === "locked");
});

test("keyring: unlock with the device PIN, lock drops the key, settings sanitised", async () => {
  const s = memStorage();
  const ring = createKeyring({ storage: s });
  assert.equal(ring.inUse(), false);
  assert.equal(ring.paused(), false);
  assert.equal(await ring.unlock("1234"), true, "nothing to open");
  const { file, dek } = await createKeyFile({ pin: "1234", iterations: FAST });
  ring.adopt(dek, file);
  assert.ok(ring.inUse());
  assert.equal(ring.kid, file.kid);
  ring.lock();
  assert.equal(ring.key, null);
  assert.equal(ring.paused(), true);
  assert.equal(await ring.unlock("9999"), false);
  assert.match(ring.error, /couldn't be opened/);
  assert.equal(await ring.unlock("1234"), true);
  await sameKey(ring.key, dek);
  s.setItem(ENC_SETTINGS, JSON.stringify({ files: "yes", browser: "weird" }));
  assert.deepEqual(ring.settings(), { files: false, filesJob: false, browser: "off" });
  ring.saveSettings({ browser: "on" });
  assert.equal(ring.settings().browser, "on");
  assert.ok(s.getItem(LOCAL_KEYS));
});

// ---------- browser copy ----------
async function browserFixture(n = 12) {
  const s = memStorage({ "denotion:prefs": '{"mode":"dark"}', "denotion:pin": '{"v":1}', "denotion:storage-locations": "[]" });
  const ring = createKeyring({ storage: s });
  const { file, dek } = await createKeyFile({ pin: "1234", iterations: FAST });
  ring.adopt(dek, file);
  const local = createLocalAdapter(s, "denotion", { keyring: ring });
  const recs = [];
  for (let i = 0; i < n; i++) {
    const p = { id: `p${i}`, type: "doc", title: `Page ${i}`, createdAt: i, blocks: [] };
    recs.push(["pages", p.id, p]);
    await local.set("pages", p.id, p);
  }
  await local.set("rows", "r1", { id: "r1", dbId: "p0", values: { a: 1 }, createdAt: 1 });
  recs.push(["rows", "r1", { id: "r1", dbId: "p0", values: { a: 1 }, createdAt: 1 }]);
  await local.set("tombstones", "pages:gone", { id: "pages:gone", col: "pages", rid: "gone", deletedAt: 5, synced: false });
  recs.push(["tombstones", "pages:gone", { id: "pages:gone", col: "pages", rid: "gone", deletedAt: 5, synced: false }]);
  return { s, ring, local, recs };
}
const allRead = async (local, recs) => {
  for (const [c, id, r] of recs) assert.deepEqual(await local.get(c, id), r, `${c}/${id}`);
};
const countEnc = (s) => recordKeys(s).filter(({ key }) => isEnvelope(JSON.parse(s.getItem(key)))).length;

test("browser copy: encrypted values when on; settings keys stay plain; mixed values read", async () => {
  const { s, ring, local, recs } = await browserFixture();
  assert.equal(countEnc(s), 0, "off by default");
  ring.saveSettings({ browser: "on" });
  await local.set("pages", "p3", recs[3][2]);
  assert.equal(countEnc(s), 1);
  assert.ok(!s.getItem("denotion:pages:p3").includes("Page 3"));
  await allRead(local, recs);
  assert.equal((await local.list("pages")).length, 12);
  assert.equal(s.getItem("denotion:prefs"), '{"mode":"dark"}');
  ring.lock();
  await assert.rejects(local.get("pages", "p3"), (e) => e.code === "locked");
  await assert.rejects(local.set("pages", "p3", recs[3][2]), (e) => e.code === "locked");
  assert.deepEqual(await local.get("pages", "p4"), recs[4][2], "plain values still read");
});

test("browser copy migration both ways, verified; interrupted at random points (seeded) loses nothing", async () => {
  const { s, ring, local, recs } = await browserFixture(20);
  const total = recordKeys(s).length;
  ring.saveSettings({ browser: "encrypting" });
  const r = await migrateBrowserCopy({ storage: s, keyring: ring, target: "encrypted" });
  assert.equal(r.changed, total);
  assert.equal(countEnc(s), total);
  await allRead(local, recs);
  const again = await migrateBrowserCopy({ storage: s, keyring: ring, target: "encrypted" });
  assert.equal(again.changed, 0);
  assert.equal(again.skipped, total);
  const back = await migrateBrowserCopy({ storage: s, keyring: ring, target: "plain" });
  assert.equal(back.changed, total);
  assert.equal(countEnc(s), 0);
  await allRead(local, recs);

  const next = rng(42);
  for (let round = 0; round < 30; round++) {
    const target = round % 2 ? "plain" : "encrypted";
    const failAt = Math.floor(next() * (total + 2));
    let writes = 0;
    const real = s.setItem;
    s.setItem = (k, v) => {
      if (/^denotion:(pages|rows|tombstones):/.test(k) && writes++ === failAt) throw Object.assign(new Error("QuotaExceededError"), { name: "QuotaExceededError" });
      real(k, v);
    };
    await migrateBrowserCopy({ storage: s, keyring: ring, target }).catch((e) => assert.match(e.message, /Quota/));
    s.setItem = real;
    await allRead(local, recs); // mixed state: everything still reads
    await migrateBrowserCopy({ storage: s, keyring: ring, target }); // resume
    assert.equal(countEnc(s), target === "encrypted" ? total : 0);
    await allRead(local, recs);
  }
});

test("browser copy migration needs the key", async () => {
  const { s, ring } = await browserFixture(2);
  ring.lock();
  await assert.rejects(migrateBrowserCopy({ storage: s, keyring: ring, target: "encrypted" }), (e) => e.code === "locked");
});

test("encryptText / decryptText keep the exact text", async () => {
  const { file, dek } = await createKeyFile({ pin: "1234", iterations: FAST });
  const text = '{\n  "id": "x",\n  "title": "  spaced  "\n}';
  assert.equal(await decryptText(dek, "pages", "x", await encryptText(dek, file.kid, "pages", "x", text)), text);
});
