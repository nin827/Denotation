// Local folder as live storage (File System Access API, Chromium only).
// Wraps a cache adapter (normally `local`): reads always come from the cache so the app stays fast
// and keeps working if folder permission lapses; writes go to the cache at once and to the folder
// debounced (~800 ms) and serialised per file. The folder holds the JSON vault format:
//   denotation.json, pages/<id>.json, rows/<id>.json
// Only those files are ever written or deleted; anything else in the folder is left alone.
import { validPage, validRow, MANIFEST } from "../vault.js";

export const folderSupported = () => typeof globalThis.showDirectoryPicker === "function";

const COLS = ["pages", "rows"];
const FILE_RE = /^([A-Za-z0-9-]{1,100})\.json$/;
const TOMBS = "tombstones";
const stamp = (r) => Number(r?.updatedAt ?? r?.createdAt ?? 0) || 0;
const valid = (col, r) => (col === "pages" ? validPage(r) : validRow(r));
const isPermission = (e) => e?.name === "NotAllowedError" || e?.name === "SecurityError";

export function createFolderAdapter(cache, { debounceMs = 800 } = {}) {
  let dir = null;
  let state = "off"; // off | syncing | synced | needs-permission | error
  let error = "";
  let folderName = "";
  const statusFns = new Set();
  const remoteFns = new Set();
  const timers = new Map(); // "col/id" -> timeout
  const chains = new Map(); // file path -> promise (serialises writes per file)

  const setState = (s, e = "") => {
    state = s;
    error = e;
    for (const f of [...statusFns]) {
      try {
        f(status());
      } catch {
        // listener errors must not break storage
      }
    }
  };
  const status = () => ({ state, folderName, error });
  const fail = (e) => {
    if (isPermission(e)) setState("needs-permission");
    else setState("error", e?.message ?? String(e));
  };

  const serial = (path, job) => {
    const next = (chains.get(path) ?? Promise.resolve()).then(job, job);
    const tail = next.catch(() => {});
    chains.set(path, tail);
    tail.then(() => {
      if (chains.get(path) === tail) chains.delete(path);
    });
    return next;
  };
  const sub = (col) => dir.getDirectoryHandle(col, { create: true });
  const writeText = async (handle, name, text) => {
    const fh = await handle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(text);
    } finally {
      await w.close();
    }
  };
  const writeRecord = (col, rec) => serial(`${col}/${rec.id}`, async () => writeText(await sub(col), `${rec.id}.json`, JSON.stringify(rec, null, 2)));
  const deleteRecord = (col, id) => serial(`${col}/${id}`, async () => {
    try {
      await (await sub(col)).removeEntry(`${id}.json`);
    } catch (e) {
      if (e?.name !== "NotFoundError") throw e;
    }
  });
  const tombKey = (col, id) => `${col}:${id}`;

  // Push one record's current cache state to the folder (write it, or delete its file if gone).
  const pushKey = async (col, id) => {
    if (!dir || state === "needs-permission") return;
    try {
      const rec = await cache.get(col, id);
      if (rec) await writeRecord(col, rec);
      else {
        await deleteRecord(col, id);
        await cache.remove(TOMBS, tombKey(col, id));
      }
    } catch (e) {
      fail(e);
    }
  };
  const schedule = (col, id) => {
    if (!dir) return;
    const key = `${col}/${id}`;
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      pushKey(col, id);
    }, debounceMs));
  };

  async function readFolder(col) {
    const out = new Map();
    const handle = await sub(col);
    for await (const [name, h] of handle.entries()) {
      const m = FILE_RE.exec(name);
      if (!m || h.kind !== "file") continue;
      try {
        const rec = JSON.parse(await (await h.getFile()).text());
        if (valid(col, rec) && rec.id === m[1]) out.set(rec.id, rec);
      } catch {
        // unreadable or not JSON: leave the file alone
      }
    }
    return out;
  }
  /** Two-way merge: per record, last write wins by updatedAt (fallback createdAt); then write back. */
  async function merge() {
    const counts = { pulled: 0, pushed: 0, deleted: 0 };
    const tombs = new Map((await cache.list(TOMBS)).map((t) => [tombKey(t.col, t.rid), t]));
    for (const col of COLS) {
      const files = await readFolder(col);
      const local = new Map((await cache.list(col)).map((r) => [r.id, r]));
      for (const [id, rec] of files) {
        const t = tombs.get(tombKey(col, id));
        const mine = local.get(id);
        if (t && !mine && stamp(rec) <= t.deletedAt) {
          await deleteRecord(col, id);
          await cache.remove(TOMBS, tombKey(col, id));
          counts.deleted++;
        } else if (!mine || stamp(rec) > stamp(mine)) {
          await cache.set(col, id, rec);
          if (t) await cache.remove(TOMBS, tombKey(col, id));
          counts.pulled++;
        } else if (stamp(mine) > stamp(rec)) {
          await writeRecord(col, mine);
          counts.pushed++;
        }
      }
      for (const [id, mine] of local) {
        if (files.has(id)) continue;
        await writeRecord(col, mine);
        counts.pushed++;
      }
    }
    for (const t of tombs.values()) await cache.remove(TOMBS, tombKey(t.col, t.rid)).catch(() => {});
    let hasManifest = true;
    try {
      await dir.getFileHandle(MANIFEST);
    } catch {
      hasManifest = false;
    }
    if (!hasManifest) {
      await serial(MANIFEST, () => writeText(dir, MANIFEST, JSON.stringify({ app: "denotation", format: "json", version: 1, exportedAt: new Date().toISOString() }, null, 2)));
    }
    return counts;
  }

  const adapter = {
    name: "folder",
    get label() {
      return dir ? `folder "${folderName}"` : cache.label;
    },
    auth: cache.auth ?? null,
    note: cache.note,
    cache,
    list: (col, filter) => cache.list(col, filter),
    get: (col, id) => cache.get(col, id),
    async set(col, id, data) {
      await cache.set(col, id, data);
      if (COLS.includes(col)) schedule(col, id);
    },
    async remove(col, id) {
      await cache.remove(col, id);
      if (!COLS.includes(col) || !dir) return;
      await cache.set(TOMBS, tombKey(col, id), { id: tombKey(col, id), col, rid: id, deletedAt: Date.now() });
      schedule(col, id);
    },
    status,
    get connected() {
      return !!dir;
    },
    onStatus(fn) {
      statusFns.add(fn);
      return () => statusFns.delete(fn);
    },
    /** Called after a merge pulled changes from the folder into the cache. */
    onRemoteChange(fn) {
      remoteFns.add(fn);
      return () => remoteFns.delete(fn);
    },
    /** Remember the folder without touching it (permission not granted yet). */
    attach(handle) {
      dir = handle;
      folderName = handle?.name ?? "";
      setState("needs-permission");
    },
    /** Use `handle` (permission already granted) and merge both ways. */
    async connect(handle = dir) {
      if (!handle) throw new Error("No folder chosen.");
      dir = handle;
      folderName = handle.name ?? "";
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      setState("syncing");
      try {
        const counts = await merge();
        setState("synced");
        if (counts.pulled) for (const f of [...remoteFns]) f(counts);
        return counts;
      } catch (e) {
        fail(e);
        throw e;
      }
    },
    disconnect() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      dir = null;
      folderName = "";
      setState("off");
    },
    /** Write everything still waiting for its debounce, and wait for all file writes. */
    async flush() {
      const due = [...timers.keys()];
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      await Promise.all(due.map((k) => {
        const [col, id] = k.split("/");
        return pushKey(col, id);
      }));
      await Promise.all([...chains.values()]);
    }
  };
  return adapter;
}

// ---------- directory handle persistence (IndexedDB db "denotation", store "handles") ----------
const DB = "denotation";
const STORE = "handles";
const KEY = "folder";
function openDb(version) {
  return new Promise((resolve, reject) => {
    const req = version ? indexedDB.open(DB, version) : indexedDB.open(DB);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("The handle database is busy in another tab."));
  });
}
async function handleDb() {
  const db = await openDb();
  if (db.objectStoreNames.contains(STORE)) return db;
  const v = db.version + 1; // the database exists without our store: add it
  db.close();
  return openDb(v);
}
async function tx(mode, run) {
  const db = await handleDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}
export const saveHandle = (handle) => tx("readwrite", (s) => s.put(handle, KEY));
export const loadHandle = () => tx("readonly", (s) => s.get(KEY)).catch(() => null);
export const clearHandle = () => tx("readwrite", (s) => s.delete(KEY));
