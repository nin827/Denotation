// Storage locations as live storage: one optional main location plus any number of backups.
// Wraps a cache adapter (normally `local`): reads always come from the cache so the app stays fast and
// keeps working if access lapses. Locations are reached through providers (see locations.js); the
// folder (File System Access, Chromium only) is the first provider.
//
// Layout on every location (the Denotation JSON vault format):
//   denotation.json, pages/<id>.json, rows/<id>.json, tombstones/<id>.json, permissions.json
// Only those files are ever written or deleted; anything else in the folder is left alone.
// `rows/.deleted.json` (written by older versions of the MCP server) is read as extra tombstones, never written.
//
// Main location: two-way sync planned by ../sync.js.
//   auto (default): merge (per-record last write wins, tombstones honoured) on connect, on window focus
//     (at most every 5 s) and every ~30 s while visible; local edits are written debounced (~800 ms).
//   manual: nothing is applied automatically. pull() / push() overwrite in one direction and return
//     the conflicts first unless { force: true }. A read-only check on connect / focus counts what the
//     folder has that this browser doesn't (`incoming`) and what isn't pushed yet (`unpushed`).
// Backups: copy-only. After each sync of the main (or ~5 s after local saves when there is no main or
//   the main is in auto mode) the app writes changed records, tombstones and permissions.json to each
//   backup. A backup is never read back automatically and never loses a record file the app didn't delete.
//
// Deletions: the cache keeps tombstones ({ id: "<col>:<id>", col, rid, deletedAt, synced }). Unsynced
// ones are this device's deletes the main hasn't seen; synced ones mirror the main's tombstones so
// backups get them too. Tombstones older than 90 days are pruned.
import { validPage, validRow, MANIFEST } from "../vault.js";
import { PERMISSIONS_FILE } from "../permissions.js";
import { syncPermissions, loadLocalPermissions } from "./folderPermissions.js";
import { planSync, applyPlan, summarize, conflictCount, keyOf, stamp, isNoop, TOMBSTONE_TTL_MS } from "../sync.js";
import { createLocationRegistry, asProvider, loadSyncMode, saveSyncMode } from "./locations.js";

export { loadSyncMode, saveSyncMode } from "./locations.js";
export const folderSupported = () => typeof globalThis.showDirectoryPicker === "function";

const COLS = ["pages", "rows"];
const FILE_RE = /^([A-Za-z0-9-]{1,100})\.json$/;
const TOMBS = "tombstones"; // cache collection and folder directory
const LEGACY_TOMBS = "rows/.deleted.json";
const FOCUS_MERGE_MS = 5000;
const valid = (col, r) => (col === "pages" ? validPage(r) : validRow(r));
const isPermission = (e) => e?.name === "NotAllowedError" || e?.name === "SecurityError";
const recPath = (col, id) => `${col}/${id}.json`;
const tombPath = (id) => `${TOMBS}/${id}.json`;
const tombKey = (col, id) => `${col}:${id}`;
const fromCacheTomb = (t) => ({ collection: t.col, id: t.rid, deletedAt: Number(t.deletedAt) || 0 });
const manifestText = () => JSON.stringify({ app: "denotation", format: "json", version: 1, exportedAt: new Date().toISOString() }, null, 2);

// ---------- reading a location ----------
async function readRecords(p, col) {
  const out = new Map();
  for (const ent of await p.list(col)) {
    const m = FILE_RE.exec(ent.name);
    if (!m || ent.kind !== "file") continue;
    try {
      const rec = JSON.parse(await p.readText(recPath(col, m[1])));
      if (valid(col, rec) && rec.id === m[1]) out.set(rec.id, rec);
    } catch {
      // unreadable or not JSON: leave the file alone
    }
  }
  return out;
}
/** tombstones/<id>.json plus the legacy rows/.deleted.json ({ deleted: { <id>: deletedAt } }). */
async function readTombs(p, now = Date.now()) {
  const out = [];
  const legacyOnly = new Set();
  const cutoff = now - TOMBSTONE_TTL_MS;
  for (const ent of await p.list(TOMBS)) {
    const m = FILE_RE.exec(ent.name);
    if (!m || ent.kind !== "file") continue;
    try {
      const t = JSON.parse(await p.readText(tombPath(m[1])));
      if (t?.id === m[1] && COLS.includes(t.collection) && Number(t.deletedAt) > 0) out.push({ collection: t.collection, id: t.id, deletedAt: Number(t.deletedAt) });
    } catch {
      // ignore
    }
  }
  try {
    const data = JSON.parse((await p.readText(LEGACY_TOMBS)) ?? "null");
    for (const [id, at] of Object.entries(data?.deleted ?? {})) {
      if (!FILE_RE.test(`${id}.json`) || !(Number(at) > cutoff)) continue;
      if (!out.some((t) => t.collection === "rows" && t.id === id)) legacyOnly.add(keyOf("rows", id));
      out.push({ collection: "rows", id, deletedAt: Number(at) });
    }
  } catch {
    // missing or unreadable
  }
  return { tombs: out, legacyOnly };
}

export function createFolderAdapter(cache, {
  debounceMs = 800,
  backupDebounceMs = 5000,
  pollMs = 30000,
  mergeOnFocus = true,
  onConnected = syncPermissions,
  mode: initialMode,
  storage = globalThis.localStorage,
  registry = createLocationRegistry({ storage: storage ?? undefined })
} = {}) {
  let mode = initialMode ?? loadSyncMode(storage);
  const locs = []; // runtime locations
  const statusFns = new Set();
  const remoteFns = new Set();
  const timers = new Map(); // "col/id" -> timeout (auto-mode writes to the main)
  const pending = new Set(); // manual mode: keys edited here since the last sync
  let planUnpushed = new Set(); // manual mode: keys the last check found not pushed
  let incoming = 0; // manual mode: changes the last check found in the main
  let backupTimer = null;
  let pollTimer = null;
  let lock = Promise.resolve();
  let running = 0;
  let lastAutoSync = 0;

  const main = () => locs.find((l) => l.role === "main") ?? null;
  const backups = () => locs.filter((l) => l.role === "backup");
  const ready = (l) => !!l && l.state !== "needs-permission";
  const publicLoc = (l) => ({ id: l.id, type: l.type, name: l.name, role: l.role, state: l.state, error: l.error, addedAt: l.addedAt, lastSyncAt: l.lastSyncAt });
  const status = () => {
    const m = main();
    return {
      state: m ? m.state : "off",
      folderName: m?.name ?? "",
      error: m?.error ?? "",
      mode,
      unpushed: m ? new Set([...pending, ...planUnpushed]).size : 0,
      incoming: m ? incoming : 0,
      lastSyncAt: m?.lastSyncAt ?? 0,
      locations: locs.map(publicLoc)
    };
  };
  const notify = () => {
    for (const f of [...statusFns]) {
      try {
        f(status());
      } catch {
        // listener errors must not break storage
      }
    }
  };
  const setLoc = (l, state, error = "") => {
    if (l.state === state && l.error === error) return;
    l.state = state;
    l.error = error;
    notify();
  };
  const failLoc = (l, e) => {
    if (isPermission(e)) setLoc(l, "needs-permission");
    else setLoc(l, "error", e?.message ?? String(e));
  };
  const persist = () => registry.save(locs.map(({ id, type, name, role, addedAt, lastSyncAt }) => ({ id, type, name, role, addedAt, lastSyncAt })));
  const exclusive = (job) => {
    running++;
    const next = lock.then(job, job);
    lock = next.catch(() => {});
    return next.finally(() => running--);
  };
  const makeLoc = (cfg, provider, state) => ({ ...cfg, name: cfg.name || provider.name, provider, state, error: "", chains: new Map(), known: null, manifestOk: false, permsAt: 0 });

  // ---------- file IO on a location (serialised per file) ----------
  const serial = (l, path, job) => {
    const next = (l.chains.get(path) ?? Promise.resolve()).then(job, job);
    const tail = next.catch(() => {});
    l.chains.set(path, tail);
    tail.then(() => {
      if (l.chains.get(path) === tail) l.chains.delete(path);
    });
    return next;
  };
  const writeFile = (l, path, text) => serial(l, path, () => l.provider.writeText(path, text));
  const removeFile = (l, path) => serial(l, path, () => l.provider.remove(path));
  const writeRec = (l, col, rec) => writeFile(l, recPath(col, rec.id), JSON.stringify(rec, null, 2));
  const writeTomb = (l, t) => writeFile(l, tombPath(t.id), JSON.stringify({ id: t.id, collection: t.collection, deletedAt: t.deletedAt }, null, 2));
  const ensureManifest = async (l) => {
    if (l.manifestOk) return;
    if ((await l.provider.readText(MANIFEST)) == null) await writeFile(l, MANIFEST, manifestText());
    l.manifestOk = true;
  };

  // ---------- local tombstones ----------
  const localTombs = () => cache.list(TOMBS);
  /** After a main sync: mirror its tombstones locally (synced) and prune old ones. */
  async function recordKnownTombs(remoteTombs, plan, now = Date.now()) {
    const final = new Map(remoteTombs.map((t) => [keyOf(t.collection, t.id), t]));
    for (const t of plan.removeTombstones) final.delete(keyOf(t.collection, t.id));
    for (const t of plan.writeTombstones) final.set(keyOf(t.collection, t.id), t);
    const cutoff = now - TOMBSTONE_TTL_MS;
    const have = new Map((await localTombs()).map((t) => [keyOf(t.col, t.rid), t]));
    for (const [k, t] of final) {
      const cur = have.get(k);
      if (t.deletedAt < cutoff || (cur && (cur.deletedAt >= t.deletedAt || !cur.synced))) continue;
      await cache.set(TOMBS, tombKey(t.collection, t.id), { id: tombKey(t.collection, t.id), col: t.collection, rid: t.id, deletedAt: t.deletedAt, synced: true });
    }
    for (const [k, cur] of have) {
      if (cur.deletedAt < cutoff || (cur.synced && !final.has(k))) await cache.remove(TOMBS, cur.id);
    }
  }

  // ---------- main: snapshot, plan, apply ----------
  async function snapshot(l) {
    const local = {};
    const remote = {};
    for (const col of COLS) {
      local[col] = await cache.list(col);
      remote[col] = [...(await readRecords(l.provider, col)).values()];
    }
    const lt = await localTombs();
    const { tombs, legacyOnly } = await readTombs(l.provider);
    return { local, remote, localTombstones: lt.filter((t) => !t.synced).map(fromCacheTomb), remoteTombstones: tombs, legacyOnly };
  }
  const mainIo = (l, snap) => ({
    getLocal: (c, id) => cache.get(c, id),
    putLocal: (c, id, r) => cache.set(c, id, r),
    removeLocal: (c, id) => cache.remove(c, id),
    putRemote: (c, id, r) => writeRec(l, c, r),
    removeRemote: (c, id) => removeFile(l, recPath(c, id)),
    putTombstone: (t) => writeTomb(l, t),
    removeTombstone: (t) => (snap.legacyOnly.has(keyOf(t.collection, t.id)) ? null : removeFile(l, tombPath(t.id))),
    forgetLocalTombstone: async (t) => {
      const cur = await cache.get(TOMBS, tombKey(t.collection, t.id));
      if (cur && !cur.synced && Number(cur.deletedAt) === t.deletedAt) await cache.remove(TOMBS, cur.id);
    }
  });
  const clearTimers = () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };

  /** Run a merge / push / pull against the main. Returns { applied, plan, conflicts, counts }. */
  function runSync(direction, { force = false, quiet = false } = {}) {
    return exclusive(async () => {
      const l = main();
      if (!l) throw new Error("No main storage location.");
      if (!ready(l)) throw Object.assign(new Error(`No access to "${l.name}" yet. Reconnect it first.`), { code: "needs-permission" });
      if (!quiet) setLoc(l, "syncing");
      try {
        clearTimers(); // the snapshot already holds every pending local edit
        const snap = await snapshot(l);
        const plan = planSync({ ...snap, direction, now: Date.now() });
        if (direction !== "merge" && conflictCount(plan) && !force) {
          setLoc(l, "synced");
          return { applied: false, plan, conflicts: plan.conflicts, counts: summarize(plan) };
        }
        const done = await applyPlan(plan, mainIo(l, snap));
        if (direction !== "pull") await ensureManifest(l);
        await recordKnownTombs(snap.remoteTombstones, plan);
        l.lastSyncAt = Date.now();
        persist();
        pending.clear();
        planUnpushed = new Set();
        incoming = 0;
        setLoc(l, "synced");
        if (direction === "merge") lastAutoSync = Date.now();
        if (!quiet || !isNoop(plan)) notify();
        if (done.pulled || done.deletedLocal) for (const f of [...remoteFns]) f(done);
        await runBackups();
        return { applied: true, plan, conflicts: plan.conflicts, counts: done };
      } catch (e) {
        failLoc(l, e);
        throw e;
      }
    });
  }
  /** Read-only: how many changes each side has that the other doesn't (manual mode footer). */
  function check() {
    return exclusive(async () => {
      const l = main();
      if (!ready(l)) return { unpushed: 0, incoming: 0 };
      try {
        const snap = await snapshot(l);
        const plan = planSync({ ...snap, direction: "merge" });
        planUnpushed = new Set([...plan.toRemote, ...plan.deleteRemote].map((c) => keyOf(c.collection, c.id)));
        incoming = plan.toLocal.length + plan.deleteLocal.length;
        setLoc(l, "synced");
        notify();
        return { unpushed: status().unpushed, incoming };
      } catch (e) {
        failLoc(l, e);
        throw e;
      }
    });
  }

  // ---------- auto mode: single-record writes ----------
  const pushKey = async (col, id) => {
    const l = main();
    if (!ready(l) || mode !== "auto") return;
    try {
      const rec = await cache.get(col, id);
      if (rec) return void (await writeRec(l, col, rec));
      const t = await cache.get(TOMBS, tombKey(col, id));
      if (!t || t.synced) return;
      // Don't delete a copy edited in the main after this delete; the next merge pulls it back.
      let there = null;
      try {
        there = JSON.parse((await l.provider.readText(recPath(col, id))) ?? "null");
      } catch {
        there = null;
      }
      if (there && stamp(there) > t.deletedAt) return;
      await removeFile(l, recPath(col, id));
      await writeTomb(l, fromCacheTomb(t));
      await cache.set(TOMBS, t.id, { ...t, synced: true });
    } catch (e) {
      failLoc(l, e);
    }
  };
  const schedule = (col, id) => {
    const l = main();
    if (l && mode === "manual") {
      const before = status().unpushed;
      pending.add(keyOf(col, id));
      if (status().unpushed !== before) notify();
    } else if (l) {
      const key = `${col}/${id}`;
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        pushKey(col, id);
      }, debounceMs));
    }
    if (!l || mode === "auto") scheduleBackups();
  };

  // ---------- backups ----------
  const scheduleBackups = (ms = backupDebounceMs) => {
    if (!backups().some(ready)) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(() => {
      backupTimer = null;
      runBackups().catch(() => {});
    }, ms);
  };
  async function runBackups() {
    clearTimeout(backupTimer);
    backupTimer = null;
    for (const l of backups()) if (ready(l)) await runBackup(l).catch(() => {});
  }
  function runBackup(l) {
    l.busy = (l.busy ?? Promise.resolve()).then(() => backupOnce(l)).catch((e) => failLoc(l, e));
    return l.busy;
  }
  async function backupOnce(l) {
    if (l.role !== "backup" || !ready(l)) return;
    const now = Date.now();
    if (!l.known) {
      const records = new Map();
      for (const col of COLS) for (const r of (await readRecords(l.provider, col)).values()) records.set(keyOf(col, r.id), { collection: col, id: r.id, at: stamp(r) });
      const tombs = new Map((await readTombs(l.provider, now)).tombs.map((t) => [keyOf(t.collection, t.id), t]));
      l.known = { records, tombs };
    }
    if (!main()) for (const t of await localTombs()) if (t.deletedAt < now - TOMBSTONE_TTL_MS) await cache.remove(TOMBS, t.id);
    const remote = { pages: [], rows: [] };
    for (const r of l.known.records.values()) remote[r.collection].push({ id: r.id, updatedAt: r.at });
    const local = {};
    for (const col of COLS) local[col] = await cache.list(col);
    const plan = planSync({ local, remote, localTombstones: (await localTombs()).map(fromCacheTomb), remoteTombstones: [...l.known.tombs.values()], direction: "push", now });
    // Copy-only: never delete a record file this device has no delete for.
    const foreign = new Set(plan.conflicts.newerRemote.filter((c) => c.reason === "only-remote").map((c) => keyOf(c.collection, c.id)));
    plan.deleteRemote = plan.deleteRemote.filter((c) => !foreign.has(keyOf(c.collection, c.id)));
    plan.writeTombstones = plan.writeTombstones.filter((t) => !foreign.has(keyOf(t.collection, t.id)));
    plan.forgetLocalTombstones = [];
    await applyPlan(plan, {
      getLocal: (c, id) => cache.get(c, id),
      putRemote: async (c, id, r) => {
        await writeRec(l, c, r);
        l.known.records.set(keyOf(c, id), { collection: c, id, at: stamp(r) });
      },
      removeRemote: async (c, id) => {
        await removeFile(l, recPath(c, id));
        l.known.records.delete(keyOf(c, id));
      },
      putTombstone: async (t) => {
        await writeTomb(l, t);
        l.known.tombs.set(keyOf(t.collection, t.id), t);
      },
      removeTombstone: async (t) => {
        await removeFile(l, tombPath(t.id));
        l.known.tombs.delete(keyOf(t.collection, t.id));
      }
    });
    await ensureManifest(l);
    const perms = loadLocalPermissions();
    if (perms.updatedAt > 0 && l.permsAt !== perms.updatedAt) {
      await writeFile(l, PERMISSIONS_FILE, JSON.stringify(perms, null, 2));
      l.permsAt = perms.updatedAt;
    }
    const first = !l.lastSyncAt;
    l.lastSyncAt = now;
    persist();
    if (l.state !== "synced") setLoc(l, "synced");
    else if (first || !isNoop(plan)) notify();
  }

  // ---------- locations ----------
  const sameHandle = async (a, b) => {
    if (!a || !b) return false;
    if (a === b) return true;
    try {
      return typeof a.isSameEntry === "function" ? await a.isSameEntry(b) : false;
    } catch {
      return false;
    }
  };
  /** Insert a location synchronously (its handle is stored in the background). */
  function insertLoc(h, role, state) {
    const provider = asProvider(h);
    const l = makeLoc({ id: registry.newId(), type: provider.type, name: provider.name, role: "backup", addedAt: Date.now(), lastSyncAt: 0 }, provider, state);
    const saved = Promise.resolve(registry.putHandle(l.id, provider.handle ?? h)).catch(() => {});
    locs.push(l);
    if (role === "main") {
      const old = main();
      if (old) dropLoc(old);
      l.role = "main";
    }
    persist();
    notify();
    return { l, saved };
  }
  async function addLoc(h, role, state) {
    const provider = asProvider(h);
    for (const l of locs) if (await sameHandle(l.provider.handle ?? l.provider, provider.handle ?? provider)) throw new Error(`"${l.name}" is already connected.`);
    const { l, saved } = insertLoc(h, role, state);
    await saved;
    return l;
  }
  async function dropLoc(l) {
    const i = locs.indexOf(l);
    if (i < 0) return;
    if (l.role === "main") {
      clearTimers();
      pending.clear();
      planUnpushed = new Set();
      incoming = 0;
    }
    locs.splice(i, 1);
    await Promise.all([...l.chains.values()]);
    await registry.deleteHandle(l.id).catch(() => {});
    persist();
    notify();
  }
  const ensurePoll = () => {
    if (pollTimer || !pollMs) return;
    pollTimer = setInterval(() => {
      const l = main();
      if (!l || l.state !== "synced" || mode !== "auto" || running) return;
      if (globalThis.document?.visibilityState === "hidden") return;
      if (Date.now() - lastAutoSync < pollMs * 0.9) return;
      runSync("merge", { quiet: true }).catch(() => {});
    }, Math.max(10, Math.floor(pollMs / 3)));
    pollTimer.unref?.();
  };
  const plain = (r) => ({ pulled: r.counts.pulled, pushed: r.counts.pushed, deleted: r.counts.deleted });

  const adapter = {
    name: "folder",
    get label() {
      const m = main();
      return m ? `folder "${m.name}"` : cache.label;
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
      if (!COLS.includes(col) || !locs.length) return;
      await cache.set(TOMBS, tombKey(col, id), { id: tombKey(col, id), col, rid: id, deletedAt: Date.now(), synced: false });
      schedule(col, id);
    },
    status,
    get connected() {
      return !!main();
    },
    get mode() {
      return mode;
    },
    onStatus(fn) {
      statusFns.add(fn);
      return () => statusFns.delete(fn);
    },
    /** Called after a sync changed records in the cache (pulled or deleted). */
    onRemoteChange(fn) {
      remoteFns.add(fn);
      return () => remoteFns.delete(fn);
    },

    /** Boot: load the configured locations (migrating the old single folder), connect what has access. */
    async init() {
      const list = await registry.migrate();
      for (const cfg of list) {
        const h = await registry.getHandle(cfg.id).catch(() => null);
        if (!h) continue;
        const provider = asProvider(h);
        let perm = "prompt";
        try {
          perm = await provider.permission(false);
        } catch {
          // treat as prompt
        }
        locs.push(makeLoc(cfg, provider, perm === "granted" ? (cfg.role === "main" ? "syncing" : "synced") : "needs-permission"));
      }
      persist();
      notify();
      const m = main();
      if (ready(m)) await adapter.connect().catch(() => {});
      else await runBackups();
      return { needsPermission: locs.filter((l) => !ready(l)).map(publicLoc) };
    },
    /** Remember `handle` as the main without touching it (permission not granted yet). */
    attach(handle) {
      insertLoc(handle, "main", "needs-permission");
    },
    /** Use `handle` (permission granted) as the main, or reconnect the current main, then sync. */
    async connect(handle) {
      let m = main();
      if (handle !== undefined && !(m && (await sameHandle(m.provider.handle ?? m.provider, handle.handle ?? handle)))) {
        m = await addLoc(handle, "main", "syncing");
      }
      if (!m) throw new Error("No folder chosen.");
      if (m.state === "needs-permission") setLoc(m, "syncing");
      ensurePoll();
      let counts = { pulled: 0, pushed: 0, deleted: 0 };
      if (mode === "auto") counts = plain(await runSync("merge"));
      else {
        await check();
        counts.manual = true;
      }
      if (onConnected) await Promise.resolve(onConnected(adapter)).catch(() => {});
      return counts;
    },
    /** Two-way merge now (newest wins), in either mode. */
    syncNow: () => runSync("merge"),
    /** Overwrite the main with this browser. Without force, returns { applied: false, conflicts } if that would lose newer folder state. */
    push: (opts) => runSync("push", opts),
    /** Overwrite this browser with the main. Without force, returns { applied: false, conflicts } if that would lose newer local work. */
    pull: (opts) => runSync("pull", opts),
    check,
    async setMode(m) {
      const next = m === "manual" ? "manual" : "auto";
      if (next === mode) return;
      if (next === "manual") await adapter.flush();
      mode = next;
      saveSyncMode(mode, storage);
      pending.clear();
      notify();
      if (ready(main())) await (mode === "auto" ? runSync("merge") : check()).catch(() => {});
    },
    /** Stop using the main location (pages stay in this browser and in the folder). */
    async disconnect() {
      const m = main();
      if (m) await dropLoc(m);
    },
    /** Add a location. role "main" replaces the current main (which is removed) and syncs; "backup" copies to it. */
    async addLocation(handle, { role = "backup" } = {}) {
      let state = "synced";
      try {
        const p = await asProvider(handle).permission(false);
        if (p !== "granted") state = "needs-permission";
      } catch {
        state = "needs-permission";
      }
      if (role === "main") {
        const old = main();
        const l = await addLoc(handle, "backup", state);
        if (old) {
          old.role = "backup";
          old.known = null;
        }
        l.role = "main";
        persist();
        notify();
        if (ready(l)) return { id: l.id, counts: await adapter.connect() };
        return { id: l.id };
      }
      const l = await addLoc(handle, "backup", state);
      await runBackup(l);
      return { id: l.id };
    },
    /** Make a backup the main (the old main becomes a backup) and run a first sync in the current mode. */
    async makeMain(id) {
      const l = locs.find((x) => x.id === id);
      if (!l) throw new Error("Unknown storage location.");
      if (l.role === "main") return { id };
      await adapter.flush();
      const old = main();
      if (old) {
        clearTimers();
        old.role = "backup";
        old.known = null;
      }
      l.role = "main";
      l.known = null;
      pending.clear();
      planUnpushed = new Set();
      incoming = 0;
      persist();
      notify();
      if (!ready(l)) return { id, needsPermission: true };
      return { id, counts: await adapter.connect() };
    },
    async removeLocation(id) {
      const l = locs.find((x) => x.id === id);
      if (l) await dropLoc(l);
    },
    /** Ask for access to every location that needs it (call from a user gesture). Returns the names still without access. */
    async requestPermissions() {
      const failed = [];
      for (const l of locs.filter((x) => !ready(x))) {
        let p = "denied";
        try {
          p = await l.provider.permission(true);
        } catch {
          // stays without access
        }
        if (p !== "granted") {
          failed.push(l.name);
          continue;
        }
        if (l.role === "main") {
          setLoc(l, "syncing");
          await adapter.connect().catch(() => {});
        } else {
          setLoc(l, "synced");
          await runBackup(l);
        }
      }
      return failed;
    },
    /** Write every backup now. */
    backupNow: () => runBackups(),
    /**
     * Read a backup as vault JSON files for importFiles(). Records are restamped to now so they win
     * over newer copies on the next sync. Also returns the newest record date in the backup.
     */
    async readBackup(id, { restamp = true } = {}) {
      const l = locs.find((x) => x.id === id);
      if (!l) throw new Error("Unknown storage location.");
      const now = Date.now();
      const files = [{ path: MANIFEST, data: manifestText() }];
      let newest = 0;
      let count = 0;
      for (const col of COLS) {
        for (const r of (await readRecords(l.provider, col)).values()) {
          newest = Math.max(newest, stamp(r));
          count++;
          files.push({ path: recPath(col, r.id), data: JSON.stringify(restamp ? { ...r, updatedAt: now } : r) });
        }
      }
      return { files, newest, count, name: l.name };
    },
    /** Newest updatedAt (fallback createdAt) among this browser's records. */
    async localNewest() {
      let n = 0;
      for (const col of COLS) for (const r of await cache.list(col)) n = Math.max(n, stamp(r));
      return n;
    },
    /** Read permissions.json from the main: parsed JSON, or null if missing/unreadable/not connected. */
    async readPermissionsFile() {
      const m = main();
      if (!ready(m)) return null;
      try {
        return JSON.parse((await m.provider.readText(PERMISSIONS_FILE)) ?? "null");
      } catch {
        return null;
      }
    },
    /** Write permissions.json to the main (and to backups that have access). Throws if no main. */
    async writePermissionsFile(data) {
      const m = main();
      if (!ready(m)) throw new Error("Connect a folder first.");
      const text = JSON.stringify(data, null, 2);
      try {
        await writeFile(m, PERMISSIONS_FILE, text);
      } catch (e) {
        failLoc(m, e);
        throw e;
      }
      for (const b of backups().filter(ready)) {
        await writeFile(b, PERMISSIONS_FILE, text).then(() => {
          b.permsAt = Number(data?.updatedAt) || 0;
        }).catch((e) => failLoc(b, e));
      }
    },
    /** Write everything still waiting for its debounce (main writes and backups), and wait for all file writes. */
    async flush() {
      const due = [...timers.keys()];
      clearTimers();
      await Promise.all(due.map((k) => {
        const [col, id] = k.split("/");
        return pushKey(col, id);
      }));
      if (backupTimer) await runBackups();
      await Promise.all(locs.flatMap((l) => [...l.chains.values(), l.busy].filter(Boolean)));
    }
  };

  // Pick up changes made elsewhere (other devices, the AI assistant's MCP server) when the window
  // regains focus. Throttled. Auto: merge. Manual: only count them for the footer.
  let lastFocus = 0;
  const onFocus = () => {
    const l = main();
    if (!l || l.state !== "synced" || running || Date.now() - lastFocus < FOCUS_MERGE_MS) return;
    if (globalThis.document?.visibilityState === "hidden") return;
    lastFocus = Date.now();
    (mode === "auto" ? runSync("merge", { quiet: true }) : check()).catch(() => {});
  };
  if (mergeOnFocus && typeof globalThis.addEventListener === "function" && globalThis.document) {
    globalThis.addEventListener("focus", onFocus);
    globalThis.document.addEventListener?.("visibilitychange", onFocus);
  }
  return adapter;
}
