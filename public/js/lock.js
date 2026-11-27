// PIN lock logic: hashing, verification, wrong-attempt delays, idle setting and the reset key sweep.
// Pure except for WebCrypto (globalThis.crypto) and an injected Storage (localStorage by default), so Node
// tests can run it. The PIN itself is never stored: only a PBKDF2-SHA256 hash with a random salt.
//
// localStorage keys (all start with "denotion:", so a reset sweeps them):
//   denotion:pin           { v: 1, length: 4|6, salt: <base64 16 bytes>, iterations, hash: <base64 32 bytes> }
//   denotion:pin-attempts  { failures, until }   wrong tries in a row and the time the next try is allowed
//   denotion:lock-idle     minutes of inactivity before the app locks itself (0 = never)
//
// The verified PIN is handed to onUnlock() listeners and then dropped; a later step can derive an
// encryption key from it there. It is never persisted.

export const PIN_KEY = "denotion:pin";
export const ATTEMPTS_KEY = "denotion:pin-attempts";
export const IDLE_KEY = "denotion:lock-idle";
export const PIN_LENGTHS = [4, 6];
export const ITERATIONS = 600000;
export const IDLE_CHOICES = [0, 1, 5, 15, 60];
export const DEFAULT_IDLE = 5;
export const FREE_TRIES = 3;
export const MAX_DELAY_MS = 5 * 60 * 1000;
export const RESET_PREFIXES = ["denotion", "denotation"];
export const RESET_FLAG = "denotation:reset-pending";

const cryptoApi = () => globalThis.crypto;
const ls = () => globalThis.localStorage ?? null;

// ---------- encoding ----------
const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
function fromB64(s) {
  try {
    const bin = atob(String(s));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** True for a string of exactly `length` ASCII digits (length 4 or 6). */
export function validPin(pin, length) {
  return PIN_LENGTHS.includes(length) && typeof pin === "string" && pin.length === length && /^[0-9]+$/.test(pin);
}

/** Compares two byte arrays without stopping at the first difference. */
export function constantTimeEqual(a, b) {
  if (!a || !b) return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function derive(pin, salt, iterations) {
  const subtle = cryptoApi().subtle;
  const key = await subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

/** A new stored record for `pin` (fresh 16-byte salt). Throws on an invalid PIN. */
export async function createPinRecord(pin, length, { iterations = ITERATIONS } = {}) {
  if (!validPin(pin, length)) throw new Error(`The PIN must be ${length} digits.`);
  const salt = cryptoApi().getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, iterations);
  return { v: 1, length, salt: toB64(salt), iterations, hash: toB64(hash) };
}

/** A well-formed record, or null. */
export function sanitizeRecord(r) {
  if (!r || typeof r !== "object" || r.v !== 1 || !PIN_LENGTHS.includes(r.length)) return null;
  const salt = fromB64(r.salt);
  const hash = fromB64(r.hash);
  const iterations = Number(r.iterations);
  if (!salt || salt.length < 16 || !hash || hash.length !== 32 || !Number.isInteger(iterations) || iterations < 1) return null;
  return { v: 1, length: r.length, salt: r.salt, iterations, hash: r.hash };
}

/** True when `pin` matches the record. Always runs the full derivation for a valid-looking input. */
export async function verifyPin(pin, record) {
  const r = sanitizeRecord(record);
  if (!r || typeof pin !== "string" || !/^[0-9]{1,12}$/.test(pin)) return false;
  const got = await derive(pin, fromB64(r.salt), r.iterations);
  return constantTimeEqual(got, fromB64(r.hash)) && pin.length === r.length;
}

// ---------- stored state ----------
function readJson(storage, key) {
  try {
    const raw = storage?.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}
function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function removeKey(storage, key) {
  try {
    storage?.removeItem(key);
  } catch {
    // blocked storage: nothing to remove
  }
}

export const loadRecord = (storage = ls()) => sanitizeRecord(readJson(storage, PIN_KEY));
export const hasPin = (storage = ls()) => loadRecord(storage) !== null;
export function saveRecord(record, storage = ls()) {
  if (!sanitizeRecord(record)) throw new Error("Invalid PIN record.");
  if (!writeJson(storage, PIN_KEY, record)) throw new Error("This browser's storage is full or blocked, so the PIN was not saved.");
}
/** Sets a new PIN (and turns idle lock on at the default when it was never chosen). */
export async function setPin(pin, length, { storage = ls(), iterations } = {}) {
  const record = await createPinRecord(pin, length, { iterations });
  saveRecord(record, storage);
  clearAttempts(storage);
  if (readJson(storage, IDLE_KEY) === null) saveIdle(DEFAULT_IDLE, storage);
  return record;
}
export function removePin(storage = ls()) {
  removeKey(storage, PIN_KEY);
  removeKey(storage, ATTEMPTS_KEY);
}

// ---------- wrong attempts ----------
/** Wait after `failures` wrong tries in a row: none for the first FREE_TRIES - 1, then 2, 4, 8 ... s, capped at 5 min. */
export function delayMs(failures) {
  const n = Number(failures) || 0;
  if (n < FREE_TRIES) return 0;
  return Math.min(MAX_DELAY_MS, 2 ** (n - FREE_TRIES + 1) * 1000);
}
export function loadAttempts(storage = ls()) {
  const a = readJson(storage, ATTEMPTS_KEY);
  const failures = Math.max(0, Math.floor(Number(a?.failures) || 0));
  const until = Math.max(0, Number(a?.until) || 0);
  return { failures, until };
}
export function clearAttempts(storage = ls()) {
  removeKey(storage, ATTEMPTS_KEY);
}
/** Milliseconds until the next try is allowed (0 = now). A clock set back can't extend it past the cap. */
export function waitLeft(storage = ls(), now = Date.now()) {
  const { until } = loadAttempts(storage);
  return Math.max(0, Math.min(until - now, MAX_DELAY_MS));
}

/**
 * One try at the PIN: honours the wait, verifies, and records the result.
 * -> { ok: true } | { ok: false, waitMs, failures, throttled? }
 */
export async function tryPin(pin, { storage = ls(), now = () => Date.now() } = {}) {
  const record = loadRecord(storage);
  if (!record) return { ok: true, noPin: true };
  const left = waitLeft(storage, now());
  if (left > 0) return { ok: false, throttled: true, waitMs: left, failures: loadAttempts(storage).failures };
  const ok = await verifyPin(pin, record);
  if (ok) {
    clearAttempts(storage);
    return { ok: true };
  }
  const failures = loadAttempts(storage).failures + 1;
  const waitMs = delayMs(failures);
  writeJson(storage, ATTEMPTS_KEY, { failures, until: now() + waitMs });
  return { ok: false, waitMs, failures };
}

// ---------- idle ----------
export function loadIdle(storage = ls()) {
  const raw = readJson(storage, IDLE_KEY);
  return raw !== null && IDLE_CHOICES.includes(Number(raw)) ? Number(raw) : DEFAULT_IDLE;
}
export function saveIdle(minutes, storage = ls()) {
  const v = Number(minutes);
  writeJson(storage, IDLE_KEY, IDLE_CHOICES.includes(v) ? v : DEFAULT_IDLE);
}

// ---------- unlock hooks (session only) ----------
const unlockFns = new Set();
/** Called with the verified PIN on every unlock (e.g. to derive an encryption key). Returns an unsubscribe. */
export function onUnlock(fn) {
  unlockFns.add(fn);
  return () => unlockFns.delete(fn);
}
export async function runUnlockHooks(pin) {
  for (const fn of [...unlockFns]) await fn(pin);
}

// ---------- reset ----------
/** A uniformly random string of `digits` decimal digits (leading zeros allowed). */
export function randomCode(digits = 8) {
  const out = [];
  const buf = new Uint8Array(1);
  while (out.length < digits) {
    cryptoApi().getRandomValues(buf);
    if (buf[0] < 250) out.push(buf[0] % 10); // reject 250-255 so every digit is equally likely
  }
  return out.join("");
}
/** Keys in `storage` that a reset deletes (everything Denotation / Denotion wrote). */
export function resetKeys(storage = ls()) {
  const keys = [];
  if (!storage) return keys;
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && RESET_PREFIXES.some((p) => k.toLowerCase().startsWith(p))) keys.push(k);
  }
  return keys;
}
export function clearAppKeys(storage = ls()) {
  const keys = resetKeys(storage);
  for (const k of keys) removeKey(storage, k);
  return keys.length;
}
