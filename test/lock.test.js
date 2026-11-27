import test from "node:test";
import assert from "node:assert/strict";
import {
  ITERATIONS,
  PIN_KEY,
  ATTEMPTS_KEY,
  IDLE_KEY,
  DEFAULT_IDLE,
  WRONG_WAIT_MS,
  createThrottle,
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
  waitLeft,
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

test("wrong PIN: fixed 3 s block, no escalation, nothing persisted, right PIN after the wait", async () => {
  assert.equal(WRONG_WAIT_MS, 3000);
  const s = memStorage({ [ATTEMPTS_KEY]: JSON.stringify({ failures: 20, until: 10 ** 13 }) }); // left by an older version
  await setPin("9090", 4, { storage: s, iterations: FAST });
  assert.equal(s.getItem(ATTEMPTS_KEY), null, "setPin drops the legacy counter");
  s.setItem(ATTEMPTS_KEY, JSON.stringify({ failures: 20, until: 10 ** 13 }));
  const throttle = createThrottle();
  let t = 1_000_000;
  const now = () => t;
  for (let i = 0; i < 6; i++) {
    const r = await tryPin("0000", { storage: s, now, throttle });
    assert.deepEqual([r.ok, r.waitMs, !!r.throttled], [false, 3000, false], `try ${i + 1}: always 3 s`);
    // during the block even the right PIN is refused
    const blocked = await tryPin("9090", { storage: s, now, throttle });
    assert.deepEqual([blocked.ok, blocked.throttled], [false, true]);
    assert.equal(waitLeft(t, throttle), 3000);
    t += 1000;
    assert.equal(waitLeft(t, throttle), 2000);
    t += 2000;
    assert.equal(waitLeft(t, throttle), 0);
  }
  for (const k of s.map.keys()) assert.ok(k !== ATTEMPTS_KEY || s.getItem(k).includes("10000000000000"), "no attempt counter is written");
  assert.equal((await tryPin("9090", { storage: s, now, throttle })).ok, true);
  assert.equal(s.getItem(ATTEMPTS_KEY), null, "a right PIN removes the legacy key");
});

test("throttle never exceeds 3 s (clock set back) and clears", () => {
  const th = createThrottle();
  th.fail(10 ** 13);
  assert.equal(th.waitLeft(0), 3000);
  th.clear();
  assert.equal(th.waitLeft(0), 0);
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
