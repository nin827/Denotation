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
const REMOVED = Symbol("removed");
const lockedRead = () => Object.assign(new Error("The browser copy is encrypted and the app is locked."), { code: "locked" });
const lockedWrite = () => Object.assign(new Error("The app is locked, so this change can't be saved."), { code: "locked" });
/** dbId of a record as the JSON text would give it back (rows always have a string dbId; anything odd is re-parsed). */
const dbIdOf = (data, text) => {
  const d = data?.dbId;
  if (typeof d === "string" || d === undefined || d === null) return d;
  const v = JSON.parse(text);
  return v && typeof v === "object" ? v.dbId : undefined;
};

/**
 * Parsed-record cache (in memory, per adapter):
 * - `cache`: storage key -> { raw, text, dbId } (decrypted records, and plain rows). `raw` is the stored string the entry was made from and is compared
 *   with storage on every read, so any change (this tab, another tab, migrateBrowserCopy) is seen at once. `text` is
 *   the record's plaintext JSON (=== raw when stored plain); readers get JSON.parse(text), a fresh object each time,
 *   because callers mutate what they get. With encryption, the cache only holds plaintext while unlocked: it is
 *   emptied whenever the keyring's key changes (lock, unlock, adopt) and by dropCache().
 * - `keySets`: collection -> Set of its storage keys, built by one scan on first use, kept up to date by this
 *   adapter's own writes, and thrown away (rebuilt lazily) on a `storage` event under our prefix or when
 *   storage.length differs from what this adapter last saw (a write that went around it).
 * - `index`: for "rows", dbId -> Set of keys (+ key -> dbId), built lazily from the cache, maintained the same way;
 *   every candidate is re-checked against its current value before it is returned.
 * Invariant: every record write in this tab goes through the adapter, migrateBrowserCopy (same keys, same records)
 * or a reset (which reloads the page).
 */
export function createLocalAdapter(storage = globalThis.localStorage, prefix = "denotion", { keyring = null, win = globalThis } = {}) {
  if (!storage) throw new Error("localStorage is not available in this environment");
  try {
    storage.setItem(`${prefix}:__probe`, "1");
    storage.removeItem(`${prefix}:__probe`);
  } catch {
    throw new Error("browser storage is blocked here");
  }
  const keyOf = (col, id) => `${prefix}:${col}:${id}`;
  const matches = (item, filter) => Object.entries(filter || {}).every(([k, v]) => item[k] === v);

  const cache = new Map();
  const keySets = new Map();
  let index = null; // { byDb: Map<dbId, Set<key>>, dbOf: Map<key, dbId> }
  let rowsGen = 0; // bumped by every change to the rows structure, so an index built across an await is only kept if nothing moved
  let knownLen = storage.length;
  let cacheKey = keyring?.key ?? null;
  // key -> the last queued write / remove of that key. Writes of one key land in call order even when encryption
  // makes an earlier one slower; with nothing queued, a plain write happens synchronously, as before.
  const tails = new Map();

  const dropStructure = () => {
    keySets.clear();
    index = null;
    rowsGen++;
  };
  const dropCache = () => {
    cache.clear();
    dropStructure();
  };
  /** Empty the cache when the key in memory is not the one the cache was filled with (lock / unlock / adopt). */
  const checkKey = () => {
    const k = keyring?.key ?? null;
    if (k !== cacheKey) {
      cache.clear();
      cacheKey = k;
    }
  };
  keyring?.onChange?.(checkKey);
  const checkLen = () => {
    if (storage.length !== knownLen) {
      dropStructure();
      knownLen = storage.length;
    }
  };
  if (typeof win?.addEventListener === "function") {
    win.addEventListener("storage", (e) => {
      if (e.storageArea && e.storageArea !== storage) return;
      if (e.key == null) return dropCache(); // clear()
      if (!e.key.startsWith(`${prefix}:`)) return;
      cache.delete(e.key);
      dropStructure();
    });
  }

  const keysOf = (col) => {
    checkLen();
    let set = keySets.get(col);
    if (!set) {
      const p = `${prefix}:${col}:`;
      set = new Set();
      for (let i = 0, n = storage.length; i < n; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(p)) set.add(k);
      }
      keySets.set(col, set);
    }
    return set;
  };
  /** Put `key` under `dbId` in a row index (REMOVED: take it out). */
  const indexPut = (idx, key, dbId) => {
    if (idx.dbOf.has(key)) idx.byDb.get(idx.dbOf.get(key))?.delete(key);
    if (dbId === REMOVED) return void idx.dbOf.delete(key);
    idx.dbOf.set(key, dbId);
    (idx.byDb.get(dbId) ?? idx.byDb.set(dbId, new Set()).get(dbId)).add(key);
  };
  /** A row read fresh from storage: if its dbId isn't the one the index has, move it (self-healing). */
  const indexSeen = (col, key, dbId) => {
    if (col === "rows" && index?.dbOf.has(key) && index.dbOf.get(key) !== dbId) indexPut(index, key, dbId);
  };
  /**
   * Bookkeeping right after this adapter wrote `key` (dbId given) or removed it (dbId === REMOVED). Call checkLen()
   * just before the storage call, in the same synchronous step, so only our own change is folded into knownLen.
   * `entry` (or null) becomes the cache entry.
   */
  const wrote = (col, key, dbId, entry) => {
    const gone = dbId === REMOVED;
    const set = keySets.get(col);
    if (gone) set?.delete(key);
    else set?.add(key);
    if (col === "rows") {
      rowsGen++;
      if (index) indexPut(index, key, dbId);
    }
    if (entry) cache.set(key, entry);
    else cache.delete(key);
    knownLen = storage.length;
  };

  /**
   * Cache entry for `key` holding `raw`. Returns { entry, obj? } (obj: a freshly parsed record when one had to be
   * parsed anyway), null for raw == null, or a Promise of that when an envelope must be decrypted. Synchronous
   * otherwise, so cache hits and plain values cost no promise each.
   */
  const entryFor = (col, id, key, raw) => {
    if (raw == null) {
      cache.delete(key);
      return null;
    }
    checkKey();
    const hit = cache.get(key);
    if (hit && hit.raw === raw) return { entry: hit };
    const v = JSON.parse(raw);
    if (!isEnvelope(v)) {
      const entry = { raw, text: raw, dbId: v && typeof v === "object" ? v.dbId : undefined };
      if (keepPlain(col)) cache.set(key, entry);
      indexSeen(col, key, entry.dbId);
      return { entry, obj: v };
    }
    const k = keyring?.key;
    if (!k) throw lockedRead();
    return decryptText(k, col, id, v).then((text) => {
      const obj = JSON.parse(text);
      const entry = { raw, text, dbId: obj && typeof obj === "object" ? obj.dbId : undefined };
      checkKey();
      if (keyring?.key === k) cache.set(key, entry); // locked meanwhile: hand it over but don't keep it
      indexSeen(col, key, entry.dbId);
      return { entry, obj };
    });
  };
  // A plain value is parsed on every read anyway (callers get fresh objects), so caching it only pays for rows, where
  // the index checks a candidate's dbId without parsing it. Plain pages / tombstones are not kept (saves memory).
  const keepPlain = (col) => col === "rows";
  const recordOf = (r) => (r.obj !== undefined ? r.obj : JSON.parse(r.entry.text));
  /** Entries for many keys of one collection; misses are decrypted in parallel. -> [{ key, r }] (r null = gone) */
  const entriesFor = async (col, keys) => {
    const p = `${prefix}:${col}:`.length;
    const out = [];
    const waits = [];
    try {
      for (const key of keys) {
        const o = { key, r: entryFor(col, key.slice(p), key, storage.getItem(key)) };
        if (typeof o.r?.then === "function") waits.push(o.r.then((r) => void (o.r = r)));
        out.push(o);
      }
    } finally {
      for (const w of waits) w.catch(() => {}); // a sync error above must not leave decrypts rejecting unhandled
    }
    await Promise.all(waits);
    return out;
  };

  const buildIndex = async () => {
    const keys = [...keysOf("rows")];
    const gen = rowsGen;
    const got = await entriesFor("rows", keys);
    const idx = { byDb: new Map(), dbOf: new Map() };
    for (const { key, r } of got) if (r) indexPut(idx, key, r.entry.dbId);
    // Only keep it if nothing changed the structure while we were decrypting.
    if (gen === rowsGen && storage.length === knownLen) index = idx;
    return idx;
  };

  /**
   * Run `step(value of ready)` for `key` after the key's previous queued step. With nothing queued and no `ready`,
   * runs it now and returns null; otherwise returns the queued promise.
   */
  const queue = (key, ready, step) => {
    const prev = tails.get(key);
    if (!prev && !ready) {
      step(null);
      return null;
    }
    const p = Promise.all([prev ? prev.catch(() => {}) : null, ready]).then(([, v]) => step(v));
    tails.set(key, p);
    const clear = () => {
      if (tails.get(key) === p) tails.delete(key);
    };
    p.then(clear, clear);
    return p;
  };
  /** The synchronous write step. k: the key `raw` was encrypted with (null = plain). */
  const put = (col, key, raw, text, dbId, k) => {
    checkLen();
    storage.setItem(key, raw); // throws on quota: nothing below runs and the old value stays
    checkKey();
    wrote(col, key, dbId, (k === null && keepPlain(col)) || (k !== null && keyring?.key === k) ? { raw, text, dbId } : null);
  };
  /** The key to encrypt col with now (null = store plain); throws when encryption is on but the app is locked. */
  const encKey = (col) => {
    if (!ENC_COLLECTIONS.includes(col) || !encrypting(keyring)) return null;
    if (!keyring.key) throw lockedWrite();
    return keyring.key;
  };
  const encrypt = (k, col, id, text) => encryptText(k, keyring.kid, col, id, text).then((env) => JSON.stringify(env));

  return {
    name: "local",
    label: "this browser",
    auth: null,
    async list(col, filter) {
      let keys;
      const useIndex = col === "rows" && filter && Object.prototype.hasOwnProperty.call(filter, "dbId");
      if (useIndex) {
        keysOf("rows");
        const idx = index ?? (await buildIndex());
        keys = [...(idx.byDb.get(filter.dbId) ?? [])];
      } else keys = [...keysOf(col)];
      const out = [];
      for (const { key, r } of await entriesFor(col, keys)) {
        if (!r) continue;
        if (useIndex && r.entry.dbId !== filter.dbId) continue; // changed meanwhile; the next build sees it
        const item = recordOf(r);
        if (item && matches(item, filter)) out.push(item);
      }
      return out;
    },
    async get(col, id) {
      const key = keyOf(col, id);
      const r = await entryFor(col, id, key, storage.getItem(key));
      return r ? recordOf(r) : null;
    },
    async set(col, id, data) {
      const key = keyOf(col, id);
      const text = JSON.stringify(data);
      const k = encKey(col);
      const dbId = dbIdOf(data, text);
      const p = queue(key, k ? encrypt(k, col, id, text) : null, (raw) => put(col, key, k ? raw : text, text, dbId, k));
      if (p) await p;
    },
    /**
     * Same result as set(col, r.id, r) for each record in order (a later duplicate id wins), but encryption runs in
     * parallel and nothing is written if any encryption fails. Writes happen in array order; the first failing write
     * (e.g. quota) stops the ones after it, as an awaited loop of set() would.
     */
    async setMany(col, records) {
      const k = encKey(col);
      const jobs = records.map((data) => {
        const text = JSON.stringify(data);
        return { id: data.id, key: keyOf(col, data.id), text, dbId: dbIdOf(data, text) };
      });
      const encAll = k ? Promise.all(jobs.map((j) => encrypt(k, col, j.id, j.text))) : null;
      let prev = encAll;
      const pending = [];
      jobs.forEach((j, i) => {
        const ready = prev ? prev.then(() => (encAll ? encAll.then((raws) => raws[i]) : null)) : null;
        const p = queue(j.key, ready, (raw) => put(col, j.key, k ? raw : j.text, j.text, j.dbId, k));
        if (p) {
          pending.push(p);
          prev = p;
        }
      });
      await Promise.all(pending);
    },
    async remove(col, id) {
      const key = keyOf(col, id);
      const p = queue(key, null, () => {
        checkLen();
        storage.removeItem(key);
        wrote(col, key, REMOVED, null);
      });
      if (p) await p;
    },
    /** Forget every cached record (e.g. on lock); the next reads parse / decrypt again. */
    dropCache,
    /** For tests: number of cached records. */
    get cacheSize() {
      return cache.size;
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
