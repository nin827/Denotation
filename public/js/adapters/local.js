// Browser cache adapter: localStorage keys "<prefix>:<collection>:<id>" holding JSON records.
// Optional encryption of the browser copy (keyring given, settings.browser "on" / "encrypting"): record values of
// the collections below are stored as envelopes (see ../crypto.js) with AAD "<collection>/<id>". Reads accept plain
// and encrypted values, so a half-finished migration is always readable. Prefs, the PIN record, locations config
// and other settings never go through this adapter and stay plain.
import { isEnvelope, encryptText, decryptText } from "../crypto.js";

/** Collections whose values are encrypted when the browser copy is encrypted. */
export const ENC_COLLECTIONS = ["pages", "rows", "tombstones"];
const encrypting = (keyring) => {
  const b = keyring?.settings().browser;
  return b === "on" || b === "encrypting";
};
function parse(raw) {
  return raw == null ? null : JSON.parse(raw);
}
/** Raw stored text -> record (decrypting an envelope with the keyring's key). */
async function decode(keyring, col, id, raw) {
  const v = parse(raw);
  if (!isEnvelope(v)) return v;
  if (!keyring?.key) throw Object.assign(new Error("The browser copy is encrypted and the app is locked."), { code: "locked" });
  return JSON.parse(await decryptText(keyring.key, col, id, v));
}

export function createLocalAdapter(storage = globalThis.localStorage, prefix = "denotion", { keyring = null } = {}) {
  if (!storage) throw new Error("localStorage is not available in this environment");
  try {
    storage.setItem(`${prefix}:__probe`, "1");
    storage.removeItem(`${prefix}:__probe`);
  } catch {
    throw new Error("browser storage is blocked here");
  }
  const keyOf = (col, id) => `${prefix}:${col}:${id}`;
  const keysOf = (col) => {
    const p = `${prefix}:${col}:`;
    const out = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(p)) out.push(k);
    }
    return out;
  };
  const matches = (item, filter) => Object.entries(filter || {}).every(([k, v]) => item[k] === v);
  return {
    name: "local",
    label: "this browser",
    auth: null,
    async list(col, filter) {
      const p = `${prefix}:${col}:`.length;
      const out = [];
      for (const k of keysOf(col)) {
        const item = await decode(keyring, col, k.slice(p), storage.getItem(k));
        if (item && matches(item, filter)) out.push(item);
      }
      return out;
    },
    async get(col, id) {
      return decode(keyring, col, id, storage.getItem(keyOf(col, id)));
    },
    async set(col, id, data) {
      const text = JSON.stringify(data);
      if (ENC_COLLECTIONS.includes(col) && encrypting(keyring)) {
        if (!keyring.key) throw Object.assign(new Error("The app is locked, so this change can't be saved."), { code: "locked" });
        storage.setItem(keyOf(col, id), JSON.stringify(await encryptText(keyring.key, keyring.kid, col, id, text)));
      } else storage.setItem(keyOf(col, id), text);
    },
    async remove(col, id) {
      storage.removeItem(keyOf(col, id));
    }
  };
}

/** Every record key of the encrypted collections: [{ key, col, id }]. */
export function recordKeys(storage = globalThis.localStorage, prefix = "denotion") {
  const out = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (!k) continue;
    for (const col of ENC_COLLECTIONS) {
      const p = `${prefix}:${col}:`;
      if (k.startsWith(p) && k.length > p.length) out.push({ key: k, col, id: k.slice(p.length) });
    }
  }
  return out;
}

/**
 * Encrypt (target "encrypted") or decrypt (target "plain") every browser record in place, one value at a time:
 * read -> transform -> write -> read back and verify (the original is put back if the check fails). Values already
 * in the target form are verified and skipped, so an interrupted run simply runs again. The caller keeps the
 * job marker (settings.browser "encrypting" / "decrypting") until this resolves.
 * -> { changed, skipped, failed: [{ key, error }] }   Throws on storage errors (e.g. quota); nothing is lost.
 */
export async function migrateBrowserCopy({ storage = globalThis.localStorage, prefix = "denotion", keyring, target, onProgress, signal } = {}) {
  const dek = keyring?.key;
  if (!dek) throw Object.assign(new Error("Unlock the app first."), { code: "locked" });
  const kid = keyring.kid;
  const list = recordKeys(storage, prefix);
  const result = { changed: 0, skipped: 0, failed: [] };
  let done = 0;
  for (const { key, col, id } of list) {
    if (signal?.aborted) throw Object.assign(new Error("Stopped."), { code: "aborted" });
    const raw = storage.getItem(key);
    onProgress?.({ done: done++, total: list.length });
    if (raw == null) continue;
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      result.failed.push({ key, error: "not JSON" });
      continue;
    }
    const enc = isEnvelope(v);
    let plainText;
    try {
      plainText = enc ? await decryptText(dek, col, id, v) : raw;
    } catch (e) {
      result.failed.push({ key, error: e.message });
      continue;
    }
    if ((target === "encrypted") === enc) {
      result.skipped++;
      continue;
    }
    const next = target === "encrypted" ? JSON.stringify(await encryptText(dek, kid, col, id, plainText)) : plainText;
    storage.setItem(key, next); // throws on quota: the old value is still there
    let ok = false;
    try {
      const back = storage.getItem(key);
      const pv = JSON.parse(back);
      const text = isEnvelope(pv) ? await decryptText(dek, col, id, pv) : back;
      ok = text === plainText && isEnvelope(pv) === (target === "encrypted");
    } catch {
      ok = false;
    }
    if (!ok) {
      storage.setItem(key, raw);
      throw new Error(`Couldn't verify ${key} after writing it; it was put back.`);
    }
    result.changed++;
  }
  onProgress?.({ done: list.length, total: list.length });
  return result;
}
