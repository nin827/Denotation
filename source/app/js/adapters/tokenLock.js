// Sign-in tokens (Google Drive / OneDrive) encrypted with the PIN while the PIN lock is on. Pure except for
// WebCrypto and the injected handle store (IndexedDB "handles" in the app, memoryHandles() in tests).
//
// Keys
//   TK   one random AES-256-GCM key for all stored tokens of this browser. It is only ever stored wrapped.
//   KEK  PBKDF2-SHA256(PIN, 16-byte salt, 600 000 iterations) -> AES-256-GCM (crypto.js pinKek); wraps TK.
//   Record "tokvault" in the handle store: { v: 1, kid, salt, iterations, iv, ct }, ct = wrap(TK), AAD below.
//   A token "tok:<provider>:<hex>" is then stored as { "denotation-tok": 1, kid, iv, ct },
//   ct = AES-GCM(TK, iv, JSON of the token record, AAD = "<kid>/<token key>"), so envelopes can't be swapped.
//
// States: "off" (no record: tokens are plain, PIN lock off), "locked" (record, TK not in memory: tokens can't be
// read or written, cloud sync pauses with code "locked"), "open" (TK in memory after the PIN was entered).
// The record is read on every token read/write, so another tab turning the PIN on or off is noticed.
//
// Lifecycle (driven by app.js and the PIN dialog in ui/security.js; the PIN must already be verified):
//   open(pin)    at unlock and when a PIN is set: opens TK, or creates it when there is no record, then encrypts
//                any plain token left over (written by an older version, or by a write interrupted mid-switch).
//                A record that the verified PIN can't open is out of step (damaged): its tokens are dropped
//                (cloud locations then ask to sign in again) and a fresh TK is made. Plain tokens never survive.
//   close()      when the app locks: TK leaves memory.
//   rekey(pin)   PIN change: TK wrapped for the new PIN (the record is overwritten; tokens stay as they are).
//   disable()    PIN removed: every token is decrypted in place, then the record is deleted.
//   discard()    no PIN but a record (localStorage was cleared): the unreadable tokens and the record are deleted.
import { pinKek, toB64, fromB64, KDF_ITERATIONS, KDF_MIN_ITERATIONS, KDF_MAX_ITERATIONS } from "../crypto.js";

export const VAULT_KEY = "tokvault";
export const TOK_TAG = "denotation-tok";
const AAD_WRAP = "denotation:token-key:pin:v1";
const TOKEN_KEY_RE = /^tok:(google|microsoft):[a-z0-9]{16,40}$/;
/** True for a stored token's key ("tok:<provider>:<hex>"). */
export const isTokenKey = (k) => typeof k === "string" && TOKEN_KEY_RE.test(k);
/** The error a token read / write throws while the tokens are locked (folder.js shows the location as "locked"). */
export const tokensLockedError = () => Object.assign(new Error("Locked – unlock the app to sync."), { code: "locked" });

const subtle = () => globalThis.crypto.subtle;
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const te = new TextEncoder();
const td = new TextDecoder();

/** A well-formed vault record, or null. */
export function sanitizeVault(r) {
  if (!r || typeof r !== "object" || r.v !== 1 || typeof r.kid !== "string" || !/^[a-f0-9]{16,64}$/.test(r.kid)) return null;
  const it = r.iterations;
  if (!Number.isInteger(it) || it < KDF_MIN_ITERATIONS || it > KDF_MAX_ITERATIONS) return null;
  if (!(fromB64(r.salt)?.length >= 16) || fromB64(r.iv)?.length !== 12 || !fromB64(r.ct)?.length) return null;
  return { v: 1, kid: r.kid, salt: r.salt, iterations: it, iv: r.iv, ct: r.ct };
}
/** True for an encrypted token value. */
export const isTokenEnvelope = (x) => !!x && typeof x === "object" && x[TOK_TAG] === 1 && typeof x.kid === "string" && typeof x.iv === "string" && typeof x.ct === "string";
const isPlainToken = (x) => !!x && typeof x === "object" && !isTokenEnvelope(x) && typeof x.accessToken === "string";

async function wrapRecord(tk, kid, pin, iterations) {
  const salt = rand(16);
  const iv = rand(12);
  const kek = await pinKek(pin, salt, iterations);
  const ct = new Uint8Array(await subtle().wrapKey("raw", tk, kek, { name: "AES-GCM", iv, additionalData: te.encode(AAD_WRAP) }));
  return { v: 1, kid, salt: toB64(salt), iterations, iv: toB64(iv), ct: toB64(ct) };
}
/** -> CryptoKey | null (wrong PIN or damaged record). */
async function unwrapRecord(rec, pin) {
  try {
    const kek = await pinKek(pin, fromB64(rec.salt), rec.iterations);
    return await subtle().unwrapKey("raw", fromB64(rec.ct), kek, { name: "AES-GCM", iv: fromB64(rec.iv), additionalData: te.encode(AAD_WRAP) }, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  } catch {
    return null;
  }
}
async function seal(open, name, value) {
  const iv = rand(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: te.encode(`${open.kid}/${name}`) }, open.tk, te.encode(JSON.stringify(value))));
  return { [TOK_TAG]: 1, kid: open.kid, iv: toB64(iv), ct: toB64(ct) };
}
/** -> the token record, or null when it doesn't decrypt (changed or damaged: treated as signed out). */
async function unseal(open, name, env) {
  try {
    const iv = fromB64(env.iv);
    if (!iv || iv.length !== 12) return null;
    const pt = await subtle().decrypt({ name: "AES-GCM", iv, additionalData: te.encode(`${open.kid}/${name}`) }, open.tk, fromB64(env.ct));
    const v = JSON.parse(td.decode(pt));
    return isPlainToken(v) ? v : null;
  } catch {
    return null;
  }
}

/** The token lock over one handle store. Use tokenLockFor() so every caller of a store shares the key in memory. */
export function createTokenLock(handles) {
  let open = null; // { kid, tk } while unlocked
  let chain = Promise.resolve();
  /** Reads, writes and switches run one at a time, so a token can't slip past a switch half done. */
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
  // A failed read must not look like "no record" (that would store the next token in plain text).
  const readVault = async () => {
    const raw = await (handles.strictGet ? handles.strictGet(VAULT_KEY) : handles.get(VAULT_KEY));
    return { present: raw != null, rec: sanitizeVault(raw) };
  };
  const tokenKeys = async () => {
    if (typeof handles.keys !== "function") throw new Error("This handle store can't list its keys.");
    return (await handles.keys()).filter(isTokenKey);
  };
  /** "off" | "locked" | "open" as stored now (another tab may have changed it). */
  async function state() {
    const { present, rec } = await readVault();
    if (!present) {
      open = null; // turned off elsewhere: the old key is useless
      return "off";
    }
    return open && rec && rec.kid === open.kid ? "open" : "locked";
  }
  async function create(pin) {
    const tk = await subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const kid = hex(rand(12));
    await handles.put(VAULT_KEY, await wrapRecord(tk, kid, pin, KDF_ITERATIONS));
    return { kid, tk };
  }
  /** Encrypt every plain token; drop envelopes of another key (unreadable for good). */
  async function sweep() {
    for (const k of await tokenKeys()) {
      const v = await handles.get(k);
      if (isPlainToken(v)) await handles.put(k, await seal(open, k, v));
      else if (isTokenEnvelope(v) && v.kid !== open.kid) await handles.delete(k);
    }
  }
  async function dropEncrypted() {
    for (const k of await tokenKeys()) if (isTokenEnvelope(await handles.get(k))) await handles.delete(k);
  }

  const lock = {
    state,
    isOpen: () => !!open,
    /** Open (or create) the token key with a verified PIN and encrypt any plain token. -> { created, discarded } */
    open: (pin) => serial(async () => {
      const { present, rec } = await readVault();
      let discarded = false;
      let created = false;
      const tk = rec ? await unwrapRecord(rec, pin) : null;
      if (tk) open = { kid: rec.kid, tk };
      else {
        if (present) {
          await dropEncrypted();
          discarded = true;
        }
        open = await create(pin);
        created = true;
      }
      await sweep();
      return { created, discarded };
    }),
    close() {
      open = null;
    },
    /** Wrap the open key for a new PIN. */
    rekey: (pin) => serial(async () => {
      const { rec } = await readVault();
      if (!open || !rec || rec.kid !== open.kid) throw tokensLockedError();
      await handles.put(VAULT_KEY, await wrapRecord(open.tk, open.kid, pin, KDF_ITERATIONS));
    }),
    /** Decrypt every token in place and remove the record (PIN turned off). Needs the key open. */
    disable: () => serial(async () => {
      const { present, rec } = await readVault();
      if (!present) {
        open = null;
        return;
      }
      if (!open || !rec || rec.kid !== open.kid) throw tokensLockedError();
      for (const k of await tokenKeys()) {
        const v = await handles.get(k);
        if (!isTokenEnvelope(v)) continue;
        const plain = v.kid === open.kid ? await unseal(open, k, v) : null;
        if (plain) await handles.put(k, plain);
        else await handles.delete(k);
      }
      await handles.delete(VAULT_KEY);
      open = null;
    }),
    /** No PIN any more but a record is left: delete what can't be read. */
    discard: () => serial(async () => {
      if (!(await readVault()).present) return false;
      await dropEncrypted();
      await handles.delete(VAULT_KEY);
      open = null;
      return true;
    }),
    /** A token record (null when missing or unreadable). Throws code "locked" while locked. */
    read: (name) => serial(async () => {
      const v = await handles.get(name);
      if (v == null) return null;
      const st = await state();
      if (st === "locked" && (isTokenEnvelope(v) || isPlainToken(v))) throw tokensLockedError();
      // An envelope of another key (or with the lock off) can never be read again: signed out.
      if (isTokenEnvelope(v)) return st === "open" && v.kid === open.kid ? unseal(open, name, v) : null;
      if (!isPlainToken(v)) return null;
      if (st === "open") await handles.put(name, await seal(open, name, v)); // left plain by an interrupted switch
      return v;
    }),
    /** Store a token record: encrypted while the lock is on (refused while locked), plain when it is off. */
    write: (name, value) => serial(async () => {
      const st = await state();
      if (st === "locked") throw tokensLockedError();
      await handles.put(name, st === "open" ? await seal(open, name, value) : value);
    }),
    remove: (name) => serial(() => handles.delete(name))
  };
  return lock;
}

const locks = new WeakMap();
/** The shared token lock of a handle store. */
export function tokenLockFor(handles) {
  let l = locks.get(handles);
  if (!l) {
    l = createTokenLock(handles);
    locks.set(handles, l);
  }
  return l;
}
