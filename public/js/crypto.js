// Encryption keys and envelopes (WebCrypto only, no dependencies). Pure except for globalThis.crypto and an
// injected Storage, so Node tests can run it.
//
// Key hierarchy
//   DEK  one random AES-256-GCM data key per workspace. It encrypts every record (folder files and, when turned
//        on, the browser copy). It never leaves memory unwrapped and is dropped when the app locks.
//   KEK  PBKDF2-SHA256(PIN, 16-byte salt, 600 000 iterations) -> AES-256-GCM; wraps the DEK ("pinWrap").
//   RK   recovery key: 20 random bytes (160 bits) shown once as 8 groups of 4 base32 characters.
//        HKDF-SHA256(RK, 16-byte salt, "denotation recovery v1") -> AES-256-GCM; wraps the DEK ("recoveryWrap").
//   savedRecovery (optional): the recovery key text encrypted with the DEK, so Settings can show it again.
//
// Key file (keys.json in each encrypted location; the same shape in localStorage["denotion:keys"]):
//   { v: 1, alg: "AES-256-GCM", kid, kdf: { name: "PBKDF2-SHA256", salt, iterations },
//     pinWrap: { iv, ct }, recoveryWrap: { kdf: "HKDF-SHA256", salt, iv, ct }, savedRecovery?: { iv, ct },
//     createdAt, updatedAt }
//   kid: random id of the DEK (tells "same key" from "another workspace's key" without trying to decrypt).
//   All wraps are AES-GCM with a fresh 96-bit IV and a fixed AAD per purpose, so a wrong PIN fails authentication.
//
// Envelope (an encrypted record file / browser value):
//   { "denotation-enc": 1, kid, iv, ct }   ct = AES-256-GCM(DEK, iv, JSON text, AAD = "<collection>/<id>")
//   The AAD binds a record to its place: a file copied over another record's file fails to decrypt.

export const ENC_TAG = "denotation-enc";
export const KEYS_FILE = "keys.json";
export const KDF_ITERATIONS = 600000;
export const LOCAL_KEYS = "denotion:keys";
export const ENC_SETTINGS = "denotion:encryption";
const ALG = "AES-256-GCM";
const AAD_PIN = "denotation:dek:pin:v1";
const AAD_RECOVERY = "denotation:dek:recovery:v1";
const AAD_SAVED = "denotation:recovery-key:v1";
const HKDF_INFO = "denotation recovery v1";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const RECOVERY_BYTES = 20;

const subtle = () => globalThis.crypto.subtle;
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const te = new TextEncoder();
const td = new TextDecoder();

// ---------- encoding ----------
export function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s) {
  try {
    if (typeof s !== "string") return null;
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---------- recovery key text ----------
export function encodeRecovery(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join("-");
}
/** Parse typed recovery key text (any case, spaces / dashes ignored, 0/1/8 read as O/I/B). -> 20 bytes | null */
export function parseRecovery(text) {
  if (typeof text !== "string") return null;
  const s = text.toUpperCase().replace(/[\s-]/g, "").replace(/0/g, "O").replace(/1/g, "I").replace(/8/g, "B");
  if (s.length !== 32 || /[^A-Z2-7]/.test(s)) return null;
  const out = new Uint8Array(RECOVERY_BYTES);
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const c of s) {
    value = ((value << 5) | B32.indexOf(c)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[o++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}
/** A new recovery key as text: "ABCD-EFGH-…" (8 groups of 4, 160 bits). */
export const newRecoveryKey = () => encodeRecovery(rand(RECOVERY_BYTES));
/** True when `text` looks like a recovery key rather than a PIN. */
export const looksLikeRecovery = (text) => parseRecovery(text) !== null;

// ---------- keys ----------
/** A new random data key (extractable so it can be re-wrapped for a PIN change). */
export const generateDek = () => subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
const WRAP_USES = ["wrapKey", "unwrapKey", "encrypt", "decrypt"];
export async function pinKek(pin, salt, iterations = KDF_ITERATIONS) {
  const base = await subtle().importKey("raw", te.encode(String(pin)), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, WRAP_USES);
}
export async function recoveryKek(bytes, salt) {
  const base = await subtle().importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: te.encode(HKDF_INFO) }, base, { name: "AES-GCM", length: 256 }, false, WRAP_USES);
}
async function wrap(dek, kek, aad) {
  const iv = rand(12);
  const ct = new Uint8Array(await subtle().wrapKey("raw", dek, kek, { name: "AES-GCM", iv, additionalData: te.encode(aad) }));
  return { iv: toB64(iv), ct: toB64(ct) };
}
/** -> CryptoKey | null (wrong key or damaged wrap). */
async function unwrap(w, kek, aad) {
  const iv = fromB64(w?.iv);
  const ct = fromB64(w?.ct);
  if (!iv || iv.length !== 12 || !ct) return null;
  try {
    return await subtle().unwrapKey("raw", ct, kek, { name: "AES-GCM", iv, additionalData: te.encode(aad) }, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  } catch {
    return null;
  }
}
async function sealText(key, text, aad) {
  const iv = rand(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, te.encode(text)));
  return { iv: toB64(iv), ct: toB64(ct) };
}
async function openText(key, box, aad) {
  const iv = fromB64(box?.iv);
  const ct = fromB64(box?.ct);
  if (!iv || iv.length !== 12 || !ct) throw new Error("Damaged encrypted data.");
  try {
    return td.decode(await subtle().decrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, ct));
  } catch {
    throw Object.assign(new Error("This data can't be decrypted with this key (wrong key, or the file was changed)."), { code: "decrypt" });
  }
}

const okWrap = (w) => !!w && typeof w === "object" && fromB64(w.iv)?.length === 12 && !!fromB64(w.ct)?.length;
/** A well-formed key file, or null. */
export function sanitizeKeyFile(f) {
  if (!f || typeof f !== "object" || f.v !== 1 || f.alg !== ALG || typeof f.kid !== "string" || !/^[a-f0-9]{16,64}$/.test(f.kid)) return null;
  const k = f.kdf;
  const iterations = Number(k?.iterations);
  if (!k || k.name !== "PBKDF2-SHA256" || !(fromB64(k.salt)?.length >= 16) || !Number.isInteger(iterations) || iterations < 1) return null;
  if (!okWrap(f.pinWrap) || !okWrap(f.recoveryWrap) || f.recoveryWrap.kdf !== "HKDF-SHA256" || !(fromB64(f.recoveryWrap.salt)?.length >= 16)) return null;
  const out = {
    v: 1, alg: ALG, kid: f.kid,
    kdf: { name: "PBKDF2-SHA256", salt: k.salt, iterations },
    pinWrap: { iv: f.pinWrap.iv, ct: f.pinWrap.ct },
    recoveryWrap: { kdf: "HKDF-SHA256", salt: f.recoveryWrap.salt, iv: f.recoveryWrap.iv, ct: f.recoveryWrap.ct },
    createdAt: Number(f.createdAt) || 0,
    updatedAt: Number(f.updatedAt) || Number(f.createdAt) || 0
  };
  if (okWrap(f.savedRecovery)) out.savedRecovery = { iv: f.savedRecovery.iv, ct: f.savedRecovery.ct };
  return out;
}

/**
 * A new key file for `dek` (or a fresh one). -> { file, dek, recovery } where recovery is the text to show once.
 * keepRecovery: also store the recovery key encrypted with the DEK (savedRecovery).
 */
export async function createKeyFile({ pin, dek = null, kid = null, recovery = null, keepRecovery = false, iterations = KDF_ITERATIONS, now = Date.now() } = {}) {
  if (typeof pin !== "string" || !/^[0-9]{4,12}$/.test(pin)) throw new Error("A PIN is needed to protect the key.");
  const key = dek ?? (await generateDek());
  const rk = recovery ?? newRecoveryKey();
  const salt = rand(16);
  const rsalt = rand(16);
  const file = {
    v: 1, alg: ALG, kid: kid ?? hex(rand(12)),
    kdf: { name: "PBKDF2-SHA256", salt: toB64(salt), iterations },
    pinWrap: await wrap(key, await pinKek(pin, salt, iterations), AAD_PIN),
    recoveryWrap: { kdf: "HKDF-SHA256", salt: toB64(rsalt), ...(await wrap(key, await recoveryKek(parseRecovery(rk), rsalt), AAD_RECOVERY)) },
    createdAt: now,
    updatedAt: now
  };
  if (keepRecovery) file.savedRecovery = await sealText(key, rk, AAD_SAVED);
  return { file, dek: key, recovery: rk };
}
/** The DEK from a key file and a PIN, or null for a wrong PIN / bad file. Takes ~0.5 s (600k iterations). */
export async function unwrapWithPin(file, pin) {
  const f = sanitizeKeyFile(file);
  if (!f || typeof pin !== "string" || !/^[0-9]{1,12}$/.test(pin)) return null;
  return unwrap(f.pinWrap, await pinKek(pin, fromB64(f.kdf.salt), f.kdf.iterations), AAD_PIN);
}
/** The DEK from a key file and recovery key text, or null. */
export async function unwrapWithRecovery(file, text) {
  const f = sanitizeKeyFile(file);
  const bytes = parseRecovery(text);
  if (!f || !bytes) return null;
  return unwrap(f.recoveryWrap, await recoveryKek(bytes, fromB64(f.recoveryWrap.salt)), AAD_RECOVERY);
}
/** PIN or recovery key, whichever `secret` looks like. -> { dek, via: "pin"|"recovery" } | null */
export async function unwrapWithSecret(file, secret) {
  const s = String(secret ?? "").trim();
  if (/^[0-9]{4,12}$/.test(s)) {
    const dek = await unwrapWithPin(file, s);
    return dek ? { dek, via: "pin" } : null;
  }
  const dek = await unwrapWithRecovery(file, s);
  return dek ? { dek, via: "recovery" } : null;
}
/** Same key file with the DEK wrapped for a new PIN (fresh salt). */
export async function rewrapPin(file, dek, pin, { iterations = KDF_ITERATIONS, now = Date.now() } = {}) {
  const f = sanitizeKeyFile(file);
  if (!f) throw new Error("Invalid key file.");
  if (typeof pin !== "string" || !/^[0-9]{4,12}$/.test(pin)) throw new Error("Invalid PIN.");
  const salt = rand(16);
  return { ...f, kdf: { name: "PBKDF2-SHA256", salt: toB64(salt), iterations }, pinWrap: await wrap(dek, await pinKek(pin, salt, iterations), AAD_PIN), updatedAt: now };
}
/** Replace the recovery key (the old one stops opening this file). keep: also store it with the DEK. */
export async function replaceRecovery(file, dek, { keep = false, now = Date.now() } = {}) {
  const f = sanitizeKeyFile(file);
  if (!f) throw new Error("Invalid key file.");
  const rk = newRecoveryKey();
  const rsalt = rand(16);
  const next = { ...f, recoveryWrap: { kdf: "HKDF-SHA256", salt: toB64(rsalt), ...(await wrap(dek, await recoveryKek(parseRecovery(rk), rsalt), AAD_RECOVERY)) }, updatedAt: now };
  delete next.savedRecovery;
  if (keep) next.savedRecovery = await sealText(dek, rk, AAD_SAVED);
  return { file: next, recovery: rk };
}
/** Keep (text given) or forget (null) the recovery key inside the file. Verifies the text opens the file first. */
export async function setSavedRecovery(file, dek, text, { now = Date.now() } = {}) {
  const f = sanitizeKeyFile(file);
  if (!f) throw new Error("Invalid key file.");
  const next = { ...f, updatedAt: now };
  delete next.savedRecovery;
  if (text != null) {
    if (!(await unwrapWithRecovery(f, text))) throw new Error("That recovery key doesn't belong to this key.");
    next.savedRecovery = await sealText(dek, encodeRecovery(parseRecovery(text)), AAD_SAVED);
  }
  return next;
}
/** The kept recovery key text, or null. */
export async function readSavedRecovery(file, dek) {
  const f = sanitizeKeyFile(file);
  if (!f?.savedRecovery || !dek) return null;
  try {
    return await openText(dek, f.savedRecovery, AAD_SAVED);
  } catch {
    return null;
  }
}

// ---------- envelopes ----------
export const aadFor = (col, id) => `${col}/${id}`;
export const isEnvelope = (x) => !!x && typeof x === "object" && x[ENC_TAG] === 1 && typeof x.iv === "string" && typeof x.ct === "string";
/** Quick check on raw text without parsing everything (both forms are JSON). */
export const looksEncrypted = (text) => typeof text === "string" && text.includes(`"${ENC_TAG}"`) && isEnvelope(safeParse(text));
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
/** Encrypt JSON text for <col>/<id>. -> envelope object */
export async function encryptText(dek, kid, col, id, text) {
  return { [ENC_TAG]: 1, kid, ...(await sealText(dek, text, aadFor(col, id))) };
}
/** Decrypt an envelope for <col>/<id> -> JSON text. Throws (code "decrypt") on a wrong key, a swap or tampering. */
export async function decryptText(dek, col, id, env) {
  if (!isEnvelope(env)) throw new Error("Not an encrypted record.");
  if (!dek) throw Object.assign(new Error("Encrypted data is locked."), { code: "locked" });
  return openText(dek, env, aadFor(col, id));
}
export const encryptRecord = (dek, kid, col, id, rec) => encryptText(dek, kid, col, id, JSON.stringify(rec));
export const decryptRecord = async (dek, col, id, env) => JSON.parse(await decryptText(dek, col, id, env));

// ---------- manifest fields ----------
/** Encryption fields of a manifest (bumpManifest keeps these too, as unknown fields). */
export function encFields(m) {
  const out = {};
  if (!m || typeof m !== "object") return out;
  if (m.encrypted === true) out.encrypted = true;
  if (typeof m.keyId === "string" && /^[a-f0-9]{16,64}$/.test(m.keyId)) out.keyId = m.keyId;
  const st = m.encryption?.state;
  if (st === "encrypting" || st === "decrypting") out.encryption = { state: st, startedAt: Number(m.encryption.startedAt) || 0 };
  return out;
}
/** Does this manifest describe an encrypted (or half-encrypted) location? */
export const manifestEncrypted = (m) => {
  const f = encFields(m);
  return f.encrypted === true || !!f.encryption;
};

// ---------- keyring (this browser's session) ----------
const BROWSER_STATES = ["off", "on", "encrypting", "decrypting"];
export function sanitizeSettings(s) {
  return {
    files: s?.files === true,
    filesJob: s?.filesJob === true,
    browser: BROWSER_STATES.includes(s?.browser) ? s.browser : "off"
  };
}
const readJson = (storage, key) => {
  try {
    const raw = storage?.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * The key state of this browser: the local key file (localStorage["denotion:keys"], wrapped by this device's PIN),
 * the encryption settings (localStorage["denotion:encryption"] = { files, browser }) and the DEK in memory while
 * unlocked. Plain settings, PIN record, prefs and locations stay plain.
 */
export function createKeyring({ storage = globalThis.localStorage } = {}) {
  let dek = null;
  let error = "";
  const fns = new Set();
  const notify = () => {
    for (const f of [...fns]) {
      try {
        f();
      } catch {
        // listeners must not break key handling
      }
    }
  };
  const file = () => sanitizeKeyFile(readJson(storage, LOCAL_KEYS));
  const ring = {
    file,
    settings: () => sanitizeSettings(readJson(storage, ENC_SETTINGS)),
    saveSettings(patch) {
      const next = sanitizeSettings({ ...ring.settings(), ...patch });
      storage.setItem(ENC_SETTINGS, JSON.stringify(next));
      notify();
      return next;
    },
    saveFile(f) {
      const clean = sanitizeKeyFile(f);
      if (!clean) throw new Error("Invalid key file.");
      storage.setItem(LOCAL_KEYS, JSON.stringify(clean));
      notify();
      return clean;
    },
    removeFile() {
      try {
        storage.removeItem(LOCAL_KEYS);
      } catch {
        // nothing stored
      }
      notify();
    },
    get kid() {
      return file()?.kid ?? null;
    },
    /** The DEK while unlocked, else null. */
    get key() {
      return dek;
    },
    get error() {
      return error;
    },
    unlocked: () => !!dek,
    /** Encryption is in use on this device (a key file or a setting that needs one). */
    inUse() {
      const s = ring.settings();
      return !!file() || s.files || s.browser !== "off";
    },
    /** Encryption in use but the key isn't in memory: storage work must wait. */
    paused: () => ring.inUse() && !dek,
    /** At unlock: open the local key file with the PIN. -> true | false (no file: true) */
    async unlock(pin) {
      const f = file();
      if (!f) {
        error = "";
        return true;
      }
      dek = await unwrapWithPin(f, pin);
      error = dek ? "" : "The encryption key couldn't be opened with this PIN.";
      notify();
      return !!dek;
    },
    /** Drop the DEK from memory (app locked). */
    lock() {
      dek = null;
      notify();
    },
    /** Use `key` from now on and keep it on this device, wrapped by `f` (a key file for this device's PIN). */
    adopt(key, f) {
      const clean = ring.saveFile(f);
      dek = key;
      error = "";
      notify();
      return clean;
    },
    /** For tests / the recovery path: set the in-memory key without touching storage. */
    setKey(key) {
      dek = key;
      notify();
    },
    onChange(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    }
  };
  return ring;
}
