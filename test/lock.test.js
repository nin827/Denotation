import test from "node:test";
import assert from "node:assert/strict";
import {
  ITERATIONS,
  PIN_KEY,
  ATTEMPTS_KEY,
  IDLE_KEY,
  DEFAULT_IDLE,
  MAX_DELAY_MS,
  validPin,
  constantTimeEqual,
  createPinRecord,
  sanitizeRecord,
  verifyPin,
  setPin,
  removePin,
  hasPin,
  loadRecord,
  tryPin,
  delayMs,
  waitLeft,
  loadAttempts,
  loadIdle,
  saveIdle,
  randomCode,
  resetKeys,
  clearAppKeys,
  onUnlock,
  runUnlockHooks
} from "../public/js/lock.js";

const FAST = 1000; // iterations for tests that don't measure the real cost
function memStorage(init = {}) {
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
}

test("validPin: exact length, digits only, 4 or 6", () => {
  assert.equal(validPin("1234", 4), true);
  assert.equal(validPin("012345", 6), true);
  assert.equal(validPin("123", 4), false);
  assert.equal(validPin("12345", 4), false);
  assert.equal(validPin("12a4", 4), false);
  assert.equal(validPin("１２３４", 4), false); // full-width digits
  assert.equal(validPin("12345", 5), false);
  assert.equal(validPin(1234, 4), false);
});

test("constantTimeEqual", () => {
  assert.equal(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0])), false);
  assert.equal(constantTimeEqual(null, new Uint8Array([1])), false);
});

test("record shape: v1, salt 16 bytes, hash 32 bytes, default iterations >= 600000, PIN not stored", async () => {
  assert.ok(ITERATIONS >= 600000);
  const r = await createPinRecord("4821", 4);
  assert.deepEqual(Object.keys(r).sort(), ["hash", "iterations", "length", "salt", "v"]);
  assert.equal(r.v, 1);
  assert.equal(r.length, 4);
  assert.equal(r.iterations, ITERATIONS);
  assert.equal(atob(r.salt).length, 16);
  assert.equal(atob(r.hash).length, 32);
  assert.ok(!JSON.stringify(r).includes("4821"));
  assert.equal(await verifyPin("4821", r), true);
  assert.equal(await verifyPin("4822", r), false);
});

test("fresh salt per record", async () => {
  const a = await createPinRecord("1111", 4, { iterations: FAST });
  const b = await createPinRecord("1111", 4, { iterations: FAST });
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test("verifyPin rejects wrong length, junk and broken records", async () => {
  const r = await createPinRecord("123456", 6, { iterations: FAST });
  assert.equal(await verifyPin("123456", r), true);
  assert.equal(await verifyPin("12345", r), false);
  assert.equal(await verifyPin("", r), false);
  assert.equal(await verifyPin("abcdef", r), false);
  assert.equal(await verifyPin("123456", { ...r, hash: "x" }), false);
  assert.equal(await verifyPin("123456", { ...r, v: 2 }), false);
  assert.equal(sanitizeRecord(null), null);
  assert.equal(sanitizeRecord({ ...r, salt: btoa("short") }), null);
  assert.equal(sanitizeRecord({ ...r, length: 5 }), null);
  assert.deepEqual(sanitizeRecord(r), r);
});

test("createPinRecord refuses invalid PINs", async () => {
  await assert.rejects(createPinRecord("12", 4, { iterations: FAST }));
  await assert.rejects(createPinRecord("1234", 6, { iterations: FAST }));
});

test("setPin / removePin with storage; idle defaults to 5 when a PIN is first set", async () => {
  const s = memStorage();
  assert.equal(hasPin(s), false);
  assert.equal(loadIdle(s), DEFAULT_IDLE);
  await setPin("2468", 4, { storage: s, iterations: FAST });
  assert.equal(hasPin(s), true);
  assert.equal(JSON.parse(s.getItem(IDLE_KEY)), 5);
  assert.equal(loadRecord(s).length, 4);
  saveIdle(15, s);
  await setPin("135790", 6, { storage: s, iterations: FAST });
  assert.equal(loadIdle(s), 15, "changing the PIN keeps the idle choice");
  saveIdle(0, s);
  assert.equal(loadIdle(s), 0);
  saveIdle(7, s);
  assert.equal(loadIdle(s), DEFAULT_IDLE);
  removePin(s);
  assert.equal(hasPin(s), false);
  assert.equal(s.getItem(PIN_KEY), null);
});

test("delay schedule: 3 wrong -> 2 s, doubling, capped at 5 min", () => {
  assert.deepEqual([0, 1, 2].map(delayMs), [0, 0, 0]);
  assert.equal(delayMs(3), 2000);
  assert.equal(delayMs(4), 4000);
  assert.equal(delayMs(5), 8000);
  assert.equal(delayMs(10), 256000);
  assert.equal(delayMs(11), MAX_DELAY_MS);
  assert.equal(delayMs(50), MAX_DELAY_MS);
});

test("tryPin: counts failures, persists the wait, refuses during it, resets on success", async () => {
  const s = memStorage();
  await setPin("9090", 4, { storage: s, iterations: FAST });
  let t = 1_000_000;
  const now = () => t;
  for (let i = 1; i <= 2; i++) {
    const r = await tryPin("0000", { storage: s, now });
    assert.deepEqual([r.ok, r.failures, r.waitMs], [false, i, 0]);
  }
  const third = await tryPin("0000", { storage: s, now });
  assert.equal(third.waitMs, 2000);
  assert.equal(JSON.parse(s.getItem(ATTEMPTS_KEY)).failures, 3, "persisted (survives a reload)");
  // during the wait even the right PIN is refused, without counting
  const blocked = await tryPin("9090", { storage: s, now });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.throttled, true);
  assert.equal(loadAttempts(s).failures, 3);
  assert.equal(waitLeft(s, t), 2000);
  t += 2000;
  const fourth = await tryPin("1111", { storage: s, now });
  assert.equal(fourth.waitMs, 4000);
  t += 4000;
  assert.equal((await tryPin("9090", { storage: s, now })).ok, true);
  assert.equal(s.getItem(ATTEMPTS_KEY), null);
});

test("waitLeft never exceeds the cap (clock set back)", () => {
  const s = memStorage({ [ATTEMPTS_KEY]: JSON.stringify({ failures: 20, until: 10 ** 13 }) });
  assert.equal(waitLeft(s, 0), MAX_DELAY_MS);
});

test("tryPin without a PIN opens", async () => {
  assert.equal((await tryPin("1234", { storage: memStorage() })).ok, true);
});

test("randomCode: 8 digits, roughly uniform (seeded-free fuzz)", () => {
  const counts = new Array(10).fill(0);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = randomCode(8);
    assert.match(c, /^[0-9]{8}$/);
    seen.add(c);
    for (const d of c) counts[d]++;
  }
  assert.ok(seen.size > 1990, "codes differ each time");
  for (const n of counts) assert.ok(n > 1300 && n < 1900, `digit count ${n} out of range`);
});

test("reset sweep: only denotion / denotation keys", () => {
  const s = memStorage({
    "denotion:pages:1": "{}",
    "denotion:prefs": "{}",
    "denotion:pin": "{}",
    "denotion:ai-permissions": "{}",
    "denotation:anything": "1",
    "other-app": "keep",
    "studyblock:prefs": "keep"
  });
  assert.equal(resetKeys(s).length, 5);
  assert.equal(clearAppKeys(s), 5);
  assert.deepEqual([...s.map.keys()].sort(), ["other-app", "studyblock:prefs"]);
});

test("unlock hooks receive the PIN; unsubscribe works", async () => {
  const got = [];
  const off = onUnlock((pin) => got.push(pin));
  await runUnlockHooks("1234");
  off();
  await runUnlockHooks("5678");
  assert.deepEqual(got, ["1234"]);
});
