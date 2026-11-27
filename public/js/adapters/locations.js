// Storage locations: where the workspace is mirrored besides this browser's cache.
// - Config per device in localStorage["denotion:storage-locations"]:
//     [{ id, type: "folder", name, role: "main" | "backup", addedAt, lastSyncAt }]
// - Directory handles in IndexedDB (db "denotation", store "handles"), keyed "loc:<id>". The old single
//   handle (key "folder", before locations existed) is migrated to a main location on first load.
// - A provider is the file-level interface the sync code talks to, so Google Drive / OneDrive can plug in
//   later with the same shape:
//     { type, name, handle?, permission(request) -> "granted"|"prompt"|"denied",
//       readText(path) -> string|null, writeText(path, text), remove(path), list(dir) -> [{ name, kind }] }
//   Paths are "<dir>/<file>" or "<file>" relative to the location root.

export const LOCATIONS_KEY = "denotion:storage-locations";
export const SYNC_MODE_KEY = "denotion:folder-sync";
export const LOCATION_TYPES = [
  { type: "folder", label: "Folder", available: true },
  { type: "gdrive", label: "Google Drive", available: false },
  { type: "onedrive", label: "OneDrive", available: false }
];
const ID_RE = /^loc-[A-Za-z0-9-]{1,40}$/;
const newId = () => `loc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Per-device sync mode for the main location: "auto" (default) or "manual". */
export function loadSyncMode(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(SYNC_MODE_KEY) === "manual" ? "manual" : "auto";
  } catch {
    return "auto";
  }
}
export function saveSyncMode(mode, storage = globalThis.localStorage) {
  try {
    storage?.setItem(SYNC_MODE_KEY, mode === "manual" ? "manual" : "auto");
  } catch {
    // private mode etc.: the choice lasts for this session only
  }
}

/** Keep only well-formed entries; at most one main (the first one wins). */
export function sanitizeLocations(list) {
  const out = [];
  let main = false;
  for (const l of Array.isArray(list) ? list : []) {
    if (!l || typeof l !== "object" || !ID_RE.test(String(l.id)) || l.type !== "folder") continue;
    if (out.some((x) => x.id === l.id)) continue;
    const role = l.role === "main" && !main ? "main" : "backup";
    if (role === "main") main = true;
    out.push({ id: l.id, type: l.type, name: String(l.name ?? "").slice(0, 200), role, addedAt: Number(l.addedAt) || 0, lastSyncAt: Number(l.lastSyncAt) || 0 });
  }
  return out;
}

// ---------- handle store (IndexedDB) ----------
const DB = "denotation";
const STORE = "handles";
const LEGACY_KEY = "folder";
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
/** Handle store over IndexedDB: get/put/delete by key. */
export const idbHandles = () => ({
  get: (key) => tx("readonly", (s) => s.get(key)).catch(() => null),
  put: (key, h) => tx("readwrite", (s) => s.put(h, key)),
  delete: (key) => tx("readwrite", (s) => s.delete(key)).catch(() => {})
});
/** In-memory handle store (tests, and browsers without IndexedDB). */
export const memoryHandles = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { map: m, get: async (k) => m.get(k) ?? null, put: async (k, h) => void m.set(k, h), delete: async (k) => void m.delete(k) };
};
const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
};

/** Config + handles for this device. */
export function createLocationRegistry({ storage, handles } = {}) {
  const store = storage ?? (globalThis.localStorage ? globalThis.localStorage : memoryStorage());
  const hs = handles ?? (globalThis.indexedDB ? idbHandles() : memoryHandles());
  const read = () => {
    try {
      const raw = store.getItem(LOCATIONS_KEY);
      return raw == null ? null : sanitizeLocations(JSON.parse(raw));
    } catch {
      return [];
    }
  };
  const write = (list) => {
    try {
      store.setItem(LOCATIONS_KEY, JSON.stringify(sanitizeLocations(list)));
    } catch {
      // storage full or blocked: config lasts for this session
    }
  };
  return {
    newId,
    list: () => read() ?? [],
    save: write,
    getHandle: (id) => hs.get(`loc:${id}`),
    putHandle: (id, h) => hs.put(`loc:${id}`, h),
    deleteHandle: (id) => hs.delete(`loc:${id}`),
    /** First run with locations: turn the old single remembered folder into the main location. */
    async migrate(now = Date.now()) {
      const current = read();
      if (current) return current;
      const legacy = await hs.get(LEGACY_KEY).catch(() => null);
      const list = [];
      if (legacy) {
        const id = newId();
        await hs.put(`loc:${id}`, legacy);
        list.push({ id, type: "folder", name: legacy.name ?? "Folder", role: "main", addedAt: now, lastSyncAt: 0 });
        await hs.delete(LEGACY_KEY);
      }
      write(list);
      return list;
    }
  };
}

// ---------- folder provider (File System Access) ----------
const notFound = (e) => e?.name === "NotFoundError" || e?.name === "TypeMismatchError";

/** Wrap a FileSystemDirectoryHandle in the provider interface. */
export function folderProvider(dir) {
  const sub = async (name, create) => dir.getDirectoryHandle(name, { create });
  const split = (path) => {
    const i = path.lastIndexOf("/");
    return i < 0 ? [null, path] : [path.slice(0, i), path.slice(i + 1)];
  };
  const parent = async (path, create) => {
    const [d, f] = split(path);
    return [d ? await sub(d, create) : dir, f];
  };
  return {
    type: "folder",
    get name() {
      return dir.name ?? "";
    },
    handle: dir,
    async permission(request = false) {
      const fn = request ? dir.requestPermission : dir.queryPermission;
      if (typeof fn !== "function") return "granted"; // test doubles and older handles
      return fn.call(dir, { mode: "readwrite" });
    },
    async readText(path) {
      try {
        const [d, f] = await parent(path, false);
        return await (await (await d.getFileHandle(f)).getFile()).text();
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async writeText(path, text) {
      const [d, f] = await parent(path, true);
      const fh = await d.getFileHandle(f, { create: true });
      const w = await fh.createWritable();
      try {
        await w.write(text);
      } finally {
        await w.close();
      }
    },
    async remove(path) {
      try {
        const [d, f] = await parent(path, false);
        await d.removeEntry(f);
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    },
    async list(path) {
      let d;
      try {
        d = await sub(path, false);
      } catch (e) {
        if (notFound(e)) return [];
        throw e;
      }
      const out = [];
      for await (const [name, h] of d.entries()) out.push({ name, kind: h.kind });
      return out;
    }
  };
}
export const asProvider = (x) => (x && typeof x.readText === "function" ? x : folderProvider(x));
