import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../../source/app/js/adapters/memory.js";
import { createFolderAdapter, SYNC_COOLDOWN_MS } from "../../source/app/js/adapters/folder.js";
import { createWorkspace } from "../../source/app/js/workspace.js";
import { createLocationRegistry, memoryHandles, LOCATIONS_KEY, SYNC_MODE_KEY, loadSyncSettings, saveSyncSettings, clampPushMinutes, loadWriterId, PUSH_MINUTES } from "../../source/app/js/adapters/locations.js";
import { importFiles } from "../../source/app/js/vault.js";

// Minimal stand-in for FileSystemDirectoryHandle / FileSystemFileHandle.
const err = (name) => Object.assign(new Error(name), { name });
function fakeFile(name, content = "", opts = {}) {
  const f = {
    kind: "file", name, content, writes: 0,
    async getFile() {
      return { text: async () => f.content };
    },
    async createWritable() {
      if (opts.deny?.()) throw err("NotAllowedError");
      let buf = "";
      return { write: async (t) => { buf += t; }, close: async () => { f.content = buf; f.writes++; } };
    }
  };
  return f;
}
function fakeDir(name, opts = {}) {
  const tree = new Map();
  const d = {
    kind: "directory", name, tree,
    async getDirectoryHandle(n, { create } = {}) {
      let e = tree.get(n);
      if (!e) {
        if (!create) throw err("NotFoundError");
        tree.set(n, (e = fakeDir(n, opts)));
      }
      if (e.kind !== "directory") throw err("TypeMismatchError");
      return e;
    },
    async getFileHandle(n, { create } = {}) {
      let e = tree.get(n);
      if (!e) {
        if (!create) throw err("NotFoundError");
        tree.set(n, (e = fakeFile(n, "", opts)));
      }
      if (e.kind !== "file") throw err("TypeMismatchError");
      return e;
    },
    async removeEntry(n) {
      if (!tree.has(n)) throw err("NotFoundError");
      tree.delete(n);
    },
    async *entries() {
      for (const [k, v] of [...tree]) yield [k, v];
    },
    put(path, text) {
      const parts = path.split("/");
      let at = d;
      for (const p of parts.slice(0, -1)) {
        if (!at.tree.has(p)) at.tree.set(p, fakeDir(p, opts));
        at = at.tree.get(p);
      }
      at.tree.set(parts.at(-1), fakeFile(parts.at(-1), text, opts));
    },
    read(path) {
      let at = d;
      for (const p of path.split("/")) at = at?.tree.get(p);
      return at?.kind === "file" ? at.content : undefined;
    }
  };
  return d;
}
const page = (id, title, updatedAt, extra = {}) => ({ id, type: "doc", title, parentId: null, createdAt: 1, updatedAt, blocks: [], ...extra });
const json = (r) => JSON.stringify(r);

test("connect merges per record, last write wins, and leaves other files alone", async () => {
  const cache = createMemoryAdapter();
  await cache.set("pages", "a", page("a", "A old", 100));
  await cache.set("pages", "b", page("b", "B new", 200));
  await cache.set("pages", "d", page("d", "only local", 10));
  await cache.set("rows", "r1", { id: "r1", dbId: "db", values: {}, createdAt: 5 });
  const dir = fakeDir("Vault");
  dir.put("pages/a.json", json(page("a", "A new", 300)));
  dir.put("pages/b.json", json(page("b", "B old", 150)));
  dir.put("pages/c.json", json(page("c", "only folder", 50)));
  dir.put("pages/broken.json", "{not json");
  dir.put("pages/notes.txt", "keep me");
  dir.put("rows/r1.json", json({ id: "r1", dbId: "db", values: { x: 1 }, createdAt: 5, updatedAt: 9 }));
  dir.put("README.md", "mine");
  const fs = createFolderAdapter(cache, { debounceMs: 10 });
  let remote = 0;
  fs.onRemoteChange(() => remote++);
  const counts = await fs.connect(dir);
  assert.deepEqual(counts, { pulled: 3, pushed: 2, deleted: 0 });
  assert.equal(remote, 1);
  assert.equal((await cache.get("pages", "a")).title, "A new");
  assert.equal((await cache.get("pages", "c")).title, "only folder");
  assert.deepEqual((await cache.get("rows", "r1")).values, { x: 1 });
  assert.equal(JSON.parse(dir.read("pages/b.json")).title, "B new");
  assert.equal(JSON.parse(dir.read("pages/d.json")).title, "only local");
  assert.equal(dir.read("pages/broken.json"), "{not json");
  assert.equal(dir.read("pages/notes.txt"), "keep me");
  assert.equal(dir.read("README.md"), "mine");
  assert.equal(JSON.parse(dir.read("denotation.json")).format, "json");
  assert.equal(fs.status().state, "synced");
  assert.equal(fs.label, 'folder "Vault"');
});

test("auto edits wait for the push (one write per record); removes delete only that file", async () => {
  const cache = createMemoryAdapter();
  const dir = fakeDir("V");
  const fs = createFolderAdapter(cache, { debounceMs: 30 });
  await fs.connect(dir);
  for (let i = 0; i < 5; i++) await fs.set("pages", "p", page("p", `v${i}`, i + 1));
  assert.equal(dir.read("pages/p.json"), undefined);
  await new Promise((r) => setTimeout(r, 80));
  await fs.flush();
  const file = (await dir.getDirectoryHandle("pages")).tree.get("p.json");
  assert.equal(file.writes, 1);
  assert.equal(JSON.parse(file.content).title, "v4");
  dir.put("pages/other.txt", "x");
  await fs.remove("pages", "p");
  await fs.flush();
  assert.equal(dir.read("pages/p.json"), undefined);
  assert.equal(dir.read("pages/other.txt"), "x");
  assert.deepEqual((await cache.list("tombstones")).map((t) => t.synced), [true]);
  assert.equal(JSON.parse(dir.read("tombstones/p.json")).collection, "pages");
});

test("a workspace on the folder adapter round-trips through the folder", async () => {
  const dir = fakeDir("V");
  const fs = createFolderAdapter(createMemoryAdapter(), { debounceMs: 5 });
  await fs.connect(dir);
  const ws = createWorkspace(fs);
  const db = await ws.createPage({ type: "database", title: "DB" });
  const row = await ws.createRow(db);
  row.values[db.columns[0].id] = "hello";
  await ws.saveRow(row);
  await fs.flush();
  const other = createFolderAdapter(createMemoryAdapter());
  await other.connect(dir);
  assert.equal((await other.get("rows", row.id)).values[db.columns[0].id], "hello");
  assert.equal((await other.get("pages", db.id)).title, "DB");
});

test("permission lapse keeps the cache working, reconnect catches up", async () => {
  let deny = false;
  const dir = fakeDir("V", { deny: () => deny });
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { debounceMs: 5 });
  await fs.connect(dir);
  deny = true;
  await fs.set("pages", "p", page("p", "offline edit", 10));
  await fs.flush();
  assert.equal(fs.status().state, "needs-permission");
  assert.equal((await fs.get("pages", "p")).title, "offline edit");
  deny = false;
  await fs.connect(dir);
  assert.equal(JSON.parse(dir.read("pages/p.json")).title, "offline edit");
  assert.equal(fs.status().state, "synced");
});

test("deletes made while disconnected are applied on connect via tombstones", async () => {
  const dir = fakeDir("V");
  dir.put("pages/x.json", json(page("x", "doomed", 10)));
  dir.put("pages/y.json", json(page("y", "edited elsewhere later", Date.now() + 60000)));
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache);
  await cache.set("pages", "x", page("x", "doomed", 10));
  await cache.set("pages", "y", page("y", "y", 10));
  fs.attach(dir); // remembered folder, permission not granted yet
  await fs.remove("pages", "x");
  await fs.remove("pages", "y");
  const counts = await fs.connect(dir);
  assert.equal(dir.read("pages/x.json"), undefined);
  assert.equal(counts.deleted, 1);
  assert.equal((await cache.get("pages", "y")).title, "edited elsewhere later"); // newer than the delete: kept
  assert.equal((await cache.list("tombstones")).filter((t) => !t.synced).length, 0);
  assert.ok(JSON.parse(dir.read("tombstones/x.json")).deletedAt > 10);
  assert.equal(dir.read("tombstones/y.json"), undefined);
});

test("attach without permission does not touch the folder; disconnect stops writes", async () => {
  const dir = fakeDir("V");
  const fs = createFolderAdapter(createMemoryAdapter(), { debounceMs: 5 });
  fs.attach(dir);
  assert.equal(fs.status().state, "needs-permission");
  await fs.set("pages", "p", page("p", "t", 1));
  await fs.flush();
  assert.equal(dir.tree.size, 0);
  await fs.connect(dir);
  fs.disconnect();
  await fs.set("pages", "q", page("q", "t", 1));
  await fs.flush();
  assert.equal(dir.read("pages/q.json"), undefined);
  assert.equal(fs.status().state, "off");
});

// ---------- sync modes, warnings, tombstones ----------
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const countWrites = (d) => {
  let n = 0;
  for (const e of d.tree.values()) n += e.kind === "file" ? e.writes : countWrites(e);
  return n;
};

test("auto mode: the periodic check pulls when another writer bumps the manifest stamp", async () => {
  const dir = fakeDir("V");
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { mode: "auto", pollMs: 30, cooldownMs: 0 });
  await fs.connect(dir);
  let remote = 0;
  fs.onRemoteChange(() => remote++);
  dir.put("pages/new.json", json(page("new", "from another device", Date.now())));
  await tick(120);
  assert.equal(await cache.get("pages", "new"), null, "unchanged stamp: no pull");
  const m = JSON.parse(dir.read("denotation.json"));
  dir.put("denotation.json", json({ ...m, rev: m.rev + 1, writer: "w-otherdevice1", updatedAt: Date.now() }));
  await tick(120);
  assert.equal((await cache.get("pages", "new"))?.title, "from another device");
  assert.ok(remote >= 1);
  await fs.disconnect();
});

test("manual mode: no writes and no local changes until Pull / Push; footer counts", async () => {
  const dir = fakeDir("V");
  dir.put("pages/f.json", json(page("f", "folder only", 50)));
  const cache = createMemoryAdapter();
  await cache.set("pages", "l", page("l", "local only", 60));
  const fs = createFolderAdapter(cache, { mode: "manual", pollMs: 10, debounceMs: 1 });
  const counts = await fs.connect(dir);
  assert.equal(counts.manual, true);
  await fs.set("pages", "e", page("e", "edited", 70));
  await fs.remove("pages", "l");
  await fs.flush();
  await tick(40);
  assert.equal(countWrites(dir), 0, "nothing written");
  assert.equal(await cache.get("pages", "f"), null, "nothing pulled");
  assert.equal(fs.status().incoming, 1);
  assert.equal(fs.status().unpushed, 2); // e (edited) and l (deleted; also seen by the check)
  const pushed = await fs.push();
  assert.equal(pushed.applied, false, "folder-only record makes push warn");
  assert.deepEqual(pushed.conflicts.newerRemote.map((c) => [c.id, c.reason]), [["f", "only-remote"]]);
  assert.equal(countWrites(dir), 0);
  const pulled = await fs.pull();
  assert.equal(pulled.applied, false, "local-only record makes pull warn");
  assert.deepEqual(pulled.conflicts.olderRemote.map((c) => [c.id, c.reason]), [["e", "only-local"]]);
  const forced = await fs.push({ force: true });
  assert.equal(forced.applied, true);
  assert.equal(JSON.parse(dir.read("pages/e.json")).title, "edited");
  assert.equal(dir.read("pages/f.json"), undefined);
  assert.ok(JSON.parse(dir.read("tombstones/f.json")).deletedAt > 50);
  assert.deepEqual([fs.status().unpushed, fs.status().incoming], [0, 0]);
});

test("manual pull applies folder state; warns when the folder copy is older", async () => {
  const dir = fakeDir("V");
  dir.put("pages/a.json", json(page("a", "folder newer", 200)));
  dir.put("pages/b.json", json(page("b", "folder older", 100)));
  const cache = createMemoryAdapter();
  await cache.set("pages", "a", page("a", "local", 150));
  await cache.set("pages", "b", page("b", "local newer", 300));
  const fs = createFolderAdapter(cache, { mode: "manual" });
  await fs.connect(dir);
  const first = await fs.pull();
  assert.equal(first.applied, false);
  const c = first.conflicts.olderRemote[0];
  assert.deepEqual([c.id, c.reason, c.localAt, c.remoteAt, c.local.title], ["b", "newer", 300, 100, "local newer"]);
  const r = await fs.pull({ force: true });
  assert.equal(r.counts.pulled, 2);
  assert.equal((await cache.get("pages", "b")).title, "folder older");
  assert.equal(countWrites(dir), 0, "pull never writes to the folder");
});

test("switching manual -> auto merges right away", async () => {
  const dir = fakeDir("V");
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { mode: "manual" });
  await fs.connect(dir);
  await fs.set("pages", "p", page("p", "x", 5));
  assert.equal(dir.read("pages/p.json"), undefined);
  await fs.setMode("auto");
  assert.equal(JSON.parse(dir.read("pages/p.json")).title, "x");
  assert.equal(fs.status().mode, "auto");
});

test("tombstones: another device's delete reaches this one; legacy rows/.deleted.json is honoured", async () => {
  const dir = fakeDir("V");
  const a = createMemoryAdapter();
  const b = createMemoryAdapter();
  const A = createFolderAdapter(a, { debounceMs: 1 });
  const B = createFolderAdapter(b, { debounceMs: 1 });
  await A.set("pages", "p", page("p", "shared", 10));
  await A.connect(dir);
  await B.connect(dir);
  assert.ok(await b.get("pages", "p"));
  await A.remove("pages", "p");
  await A.flush();
  assert.equal(dir.read("pages/p.json"), undefined);
  assert.equal(JSON.parse(dir.read("tombstones/p.json")).collection, "pages");
  await B.connect(); // B still has p: the tombstone removes it instead of writing it back
  assert.equal(await b.get("pages", "p"), null);
  assert.equal(dir.read("pages/p.json"), undefined);
  // legacy MCP delete log
  await b.set("rows", "r", { id: "r", dbId: "db", values: {}, createdAt: 5, updatedAt: 5 });
  dir.put("rows/.deleted.json", json({ deleted: { r: Date.now() } }));
  await B.connect();
  assert.equal(await b.get("rows", "r"), null);
  assert.equal(dir.read("rows/r.json"), undefined);
});

// ---------- storage locations: main + backups ----------
const memStorage = () => {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
};

test("backups get a copy after each main sync and never lose files the app didn't delete", async () => {
  const main = fakeDir("Main");
  const bak = fakeDir("Backup");
  bak.put("pages/foreign.json", json(page("foreign", "someone else's", 1)));
  bak.put("notes.txt", "keep");
  const cache = createMemoryAdapter();
  await cache.set("pages", "a", page("a", "A", 10));
  const storage = memStorage();
  const fs = createFolderAdapter(cache, { debounceMs: 1, storage, registry: createLocationRegistry({ storage, handles: memoryHandles() }) });
  await fs.connect(main);
  await fs.addLocation(bak, { role: "backup" });
  assert.equal(JSON.parse(bak.read("pages/a.json")).title, "A");
  assert.equal(JSON.parse(bak.read("denotation.json")).format, "json");
  await fs.set("pages", "b", page("b", "B", 20));
  await fs.remove("pages", "a");
  await fs.flush();
  await fs.syncNow();
  assert.equal(JSON.parse(bak.read("pages/b.json")).title, "B");
  assert.equal(bak.read("pages/a.json"), undefined, "deleted here: removed from the backup too");
  assert.ok(JSON.parse(bak.read("tombstones/a.json")).deletedAt > 0);
  assert.equal(JSON.parse(bak.read("pages/foreign.json")).title, "someone else's");
  assert.equal(bak.read("notes.txt"), "keep");
  // Backups are never read back
  bak.put("pages/z.json", json(page("z", "only in backup", Date.now())));
  await fs.syncNow();
  assert.equal(await cache.get("pages", "z"), null);
  const saved = JSON.parse(storage.getItem(LOCATIONS_KEY));
  assert.deepEqual(saved.map((l) => [l.name, l.role]), [["Main", "main"], ["Backup", "backup"]]);
  assert.ok(saved[1].lastSyncAt > 0);
});

test("make main: the backup becomes the main and syncs; the old main becomes a backup", async () => {
  const one = fakeDir("One");
  const two = fakeDir("Two");
  two.put("pages/t.json", json(page("t", "from two", 40)));
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { debounceMs: 1 });
  await fs.connect(one);
  const { id } = await fs.addLocation(two);
  assert.equal(await cache.get("pages", "t"), null, "a backup is not read");
  await fs.makeMain(id);
  assert.equal((await cache.get("pages", "t")).title, "from two");
  const st = fs.status();
  assert.equal(st.folderName, "Two");
  assert.deepEqual(st.locations.map((l) => [l.name, l.role]).sort(), [["One", "backup"], ["Two", "main"]]);
  assert.equal(JSON.parse(one.read("pages/t.json")).title, "from two", "old main now gets backup copies");
});

test("restore from a backup brings records back with a fresh timestamp", async () => {
  const bak = fakeDir("B");
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { backupDebounceMs: 1 });
  const ws = createWorkspace(fs);
  await fs.addLocation(bak);
  await fs.set("pages", "keep", page("keep", "Before", 100));
  await fs.flush();
  await fs.set("pages", "keep", page("keep", "Broken edit", 200));
  const { id } = fs.status().locations[0];
  bak.put("pages/keep.json", json(page("keep", "Before", 100))); // the backup still has the old copy
  const before = Date.now();
  const r = await fs.readBackup(id);
  assert.equal(r.newest, 100);
  assert.equal(r.count, 1);
  const res = await importFiles(ws, r.files);
  assert.equal(res.format, "json");
  const got = await cache.get("pages", "keep");
  assert.equal(got.title, "Before");
  assert.ok(got.updatedAt >= before);
});

test("migration: the old single remembered folder becomes the main location", async () => {
  const dir = fakeDir("Legacy");
  dir.put("pages/m.json", json(page("m", "migrated", 7)));
  const storage = memStorage();
  const handles = memoryHandles({ folder: dir });
  const registry = createLocationRegistry({ storage, handles });
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { registry, storage });
  const r = await fs.init();
  assert.deepEqual(r.needsPermission, []);
  assert.equal(fs.status().folderName, "Legacy");
  assert.equal(fs.status().state, "synced");
  assert.equal((await cache.get("pages", "m")).title, "migrated");
  assert.equal(handles.map.has("folder"), false);
  const saved = JSON.parse(storage.getItem(LOCATIONS_KEY));
  assert.equal(saved.length, 1);
  assert.equal(handles.map.get(`loc:${saved[0].id}`), dir);
  // A second boot reuses the config.
  const again = createFolderAdapter(createMemoryAdapter(), { registry: createLocationRegistry({ storage, handles }), storage });
  await again.init();
  assert.equal(again.status().locations.length, 1);
});

test("locations needing permission wait for one user gesture", async () => {
  let granted = false;
  const mk = (name) => Object.assign(fakeDir(name), {
    queryPermission: async () => (granted ? "granted" : "prompt"),
    requestPermission: async () => {
      granted = true;
      return "granted";
    }
  });
  const a = mk("A");
  const b = mk("B");
  const storage = memStorage();
  const handles = memoryHandles();
  const registry = createLocationRegistry({ storage, handles });
  registry.save([{ id: "loc-a", type: "folder", name: "A", role: "main" }, { id: "loc-b", type: "folder", name: "B", role: "backup" }]);
  await handles.put("loc:loc-a", a);
  await handles.put("loc:loc-b", b);
  const cache = createMemoryAdapter();
  await cache.set("pages", "p", page("p", "P", 1));
  const fs = createFolderAdapter(cache, { registry, storage });
  const r = await fs.init();
  assert.deepEqual(r.needsPermission.map((l) => l.name), ["A", "B"]);
  assert.equal(fs.status().state, "needs-permission");
  assert.equal(countWrites(a) + countWrites(b), 0);
  assert.deepEqual(await fs.requestPermissions(), []);
  assert.equal(fs.status().state, "synced");
  assert.equal(JSON.parse(a.read("pages/p.json")).title, "P");
  assert.equal(JSON.parse(b.read("pages/p.json")).title, "P");
});

// ---------- 1-minute cooldown (fake timers + fake window) ----------
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
const advance = async (ms) => {
  for (let left = ms; left > 0; ) {
    const step = Math.min(left, 1000);
    mock.timers.tick(step);
    await settle();
    left -= step;
  }
};
function fakeWin() {
  const L = {};
  const add = (k) => (n, f) => (L[`${k}${n}`] ??= []).push(f);
  const doc = { visibilityState: "visible", addEventListener: add("doc:") };
  return {
    document: doc,
    addEventListener: add(""),
    emit: (n, k = "") => (L[`${k}${n}`] ?? []).forEach((f) => f()),
    hide() {
      doc.visibilityState = "hidden";
      this.emit("visibilitychange", "doc:");
    }
  };
}
/** Counts how often the main's pages/ directory is listed, i.e. how many syncs / checks read it. */
async function countReads(dir) {
  const pages = await dir.getDirectoryHandle("pages", { create: true });
  const orig = pages.entries.bind(pages);
  const c = { n: 0 };
  pages.entries = () => {
    c.n++;
    return orig();
  };
  return c;
}
async function withClock(fn) {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_700_000_000_000 });
  try {
    await fn();
  } finally {
    mock.timers.reset();
  }
}
/** Counts reads of denotation.json (the cheap auto check); writes open it with create and are not counted. */
function countManifestReads(dir) {
  const orig = dir.getFileHandle.bind(dir);
  const c = { n: 0 };
  dir.getFileHandle = (n, opts = {}) => {
    if (n === "denotation.json" && !opts.create) c.n++;
    return orig(n, opts);
  };
  return c;
}
/** Another writer (device or MCP server) changed the folder: bump its manifest stamp. */
function bumpStamp(dir, writer = "w-otherdevice1") {
  const m = JSON.parse(dir.read("denotation.json") ?? "{}");
  dir.put("denotation.json", json({ ...m, app: "denotation", format: "json", version: 1, rev: (m.rev ?? 0) + 1, writer, updatedAt: Date.now() }));
}
const MIN = 60_000;

test("cooldown constant is 30 s", () => assert.equal(SYNC_COOLDOWN_MS, 30000));

test("manual mode: the focus check also runs at most once per window", () => withClock(async () => {
  const dir = fakeDir("V");
  const win = fakeWin();
  const fs = createFolderAdapter(createMemoryAdapter(), { win, mode: "manual" });
  await fs.connect(dir);
  const reads = await countReads(dir);
  await advance(10_000);
  win.emit("focus");
  await advance(10_000);
  assert.equal(reads.n, 0);
  await advance(10_000);
  assert.equal(reads.n, 1);
}));

test("Pull and Push share the cooldown with auto pulls and are refused while it runs", () => withClock(async () => {
  const dir = fakeDir("V");
  const fs = createFolderAdapter(createMemoryAdapter(), { win: fakeWin(), pollMs: 0 });
  await fs.connect(dir); // first sync runs at once and starts the cooldown
  assert.equal(fs.status().cooldownUntil, Date.now() + 30_000);
  await advance(5_000);
  for (const dir of ["pull", "push"]) {
    await assert.rejects(() => fs[dir]({ force: true }), (e) => e.code === "cooldown" && e.waitMs > 24_000 && e.waitMs <= 25_000);
  }
  await advance(25_000);
  assert.equal(fs.status().cooldownUntil, 0);
  assert.equal((await fs.pull({ force: true })).applied, true, "first Pull after a quiet period runs");
  assert.ok(fs.status().cooldownUntil > 0, "Pull started the cooldown");
  await assert.rejects(() => fs.push({ force: true }), { code: "cooldown" });
  await advance(30_000);
  assert.equal((await fs.push({ force: true })).applied, true);
}));

test("a Pull that only warns does not start the cooldown, so the forced retry runs", () => withClock(async () => {
  const dir = fakeDir("V");
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { win: fakeWin(), pollMs: 0, mode: "manual" });
  await fs.connect(dir);
  await cache.set("pages", "l", page("l", "local only", Date.now()));
  const first = await fs.pull();
  assert.equal(first.applied, false);
  assert.equal((await fs.pull({ force: true })).applied, true);
}));

test("a Pull in the window resets it for auto checks", () => withClock(async () => {
  const dir = fakeDir("V");
  const win = fakeWin();
  const fs = createFolderAdapter(createMemoryAdapter(), { win, pollMs: 0 });
  await fs.connect(dir);
  await advance(31_000);
  await fs.pull({ force: true });
  const checks = countManifestReads(dir);
  await advance(10_000);
  win.emit("focus");
  await advance(10_000);
  assert.equal(checks.n, 0);
  await advance(10_000);
  assert.equal(checks.n, 1, "trailing check when the Pull's window ended");
}));

test("hiding the page, pagehide and beforeunload flush pending writes immediately", () => withClock(async () => {
  for (const how of ["hide", "pagehide", "beforeunload"]) {
    const dir = fakeDir("V");
    const win = fakeWin();
    const fs = createFolderAdapter(createMemoryAdapter(), { win, pollMs: 0 });
    await fs.connect(dir);
    await fs.set("pages", "p", page("p", "v1", 1));
    await advance(100);
    assert.equal(dir.read("pages/p.json"), undefined, "still in the debounce");
    if (how === "hide") win.hide();
    else win.emit(how);
    await settle();
    assert.equal(JSON.parse(dir.read("pages/p.json")).title, "v1", how);
    await fs.disconnect();
  }
}));

test("disconnect and Pull / Push write pending edits first", () => withClock(async () => {
  const dir = fakeDir("V");
  const fs = createFolderAdapter(createMemoryAdapter(), { win: fakeWin(), pollMs: 0 });
  await fs.connect(dir);
  await advance(31_000);
  await fs.set("pages", "p", page("p", "v1", 1));
  await fs.push({ force: true });
  assert.equal(JSON.parse(dir.read("pages/p.json")).title, "v1");
  await advance(31_000);
  await fs.set("pages", "p", page("p", "v2", 2));
  await fs.disconnect();
  assert.equal(JSON.parse(dir.read("pages/p.json")).title, "v2");
}));


test("first connect pulls and stamps the manifest; the stamp is remembered per location", () => withClock(async () => {
  const dir = fakeDir("V");
  dir.put("pages/f.json", json(page("f", "in folder", 5)));
  const cache = createMemoryAdapter();
  const storage = memStorage();
  const fs = createFolderAdapter(cache, { win: fakeWin(), storage, writer: "w-thisdevice01", registry: createLocationRegistry({ storage, handles: memoryHandles() }) });
  await fs.addLocation(dir, { role: "main" });
  assert.equal((await cache.get("pages", "f")).title, "in folder");
  const m = JSON.parse(dir.read("denotation.json"));
  assert.deepEqual([m.app, m.format, m.version, m.rev, m.writer], ["denotation", "json", 1, 1, "w-thisdevice01"]);
  assert.ok(m.updatedAt > 0);
  const saved = JSON.parse(storage.getItem(LOCATIONS_KEY))[0];
  assert.deepEqual(saved.seen, { rev: 1, writer: "w-thisdevice01", updatedAt: m.updatedAt });
  // a later push bumps rev
  await fs.set("pages", "n", page("n", "N", 9));
  await fs.flush();
  assert.equal(JSON.parse(dir.read("denotation.json")).rev, 2);
  assert.equal(JSON.parse(storage.getItem(LOCATIONS_KEY))[0].seen.rev, 2);
}));

test("auto check runs every 30 s while visible and reads only the manifest", () => withClock(async () => {
  const dir = fakeDir("V");
  const win = fakeWin();
  const fs = createFolderAdapter(createMemoryAdapter(), { win });
  await fs.connect(dir);
  const scans = await countReads(dir);
  const checks = countManifestReads(dir);
  await advance(29_000);
  assert.equal(checks.n, 0);
  await advance(1_000);
  assert.equal(checks.n, 1);
  await advance(30_000);
  assert.equal(checks.n, 2);
  assert.equal(scans.n, 0, "unchanged stamp: no record reads");
  win.hide();
  await advance(60_000);
  assert.equal(checks.n, 2, "no checks while hidden");
  await fs.disconnect();
}));

test("focus with an unchanged manifest: no pull and no record reads", () => withClock(async () => {
  const dir = fakeDir("V");
  const win = fakeWin();
  const fs = createFolderAdapter(createMemoryAdapter(), { win, pollMs: 0 });
  await fs.connect(dir);
  const scans = await countReads(dir);
  const checks = countManifestReads(dir);
  dir.put("pages/x.json", json(page("x", "written without a stamp", Date.now())));
  await advance(31_000);
  win.emit("focus");
  await settle();
  assert.equal(checks.n, 1);
  assert.equal(scans.n, 0);
  assert.equal(await fs.get("pages", "x"), null);
}));

test("focus inside the window queues exactly one trailing check for the window end", () => withClock(async () => {
  const dir = fakeDir("V");
  const win = fakeWin();
  const fs = createFolderAdapter(createMemoryAdapter(), { win, pollMs: 0 });
  await fs.connect(dir);
  const checks = countManifestReads(dir);
  for (let i = 0; i < 3; i++) {
    await advance(6_000);
    win.emit("focus");
  }
  assert.equal(checks.n, 0, "inside the window: no check");
  await advance(11_000);
  assert.equal(checks.n, 0);
  await advance(1_000);
  assert.equal(checks.n, 1, "one trailing check at the window end");
  await advance(10_000);
  win.emit("focus");
  await advance(19_000);
  assert.equal(checks.n, 1, "a later focus waits for its own window (from the last check)");
  await advance(1_000);
  assert.equal(checks.n, 2);
}));

test("manifest bumped by another device or the MCP server: pulled on the next check", () => withClock(async () => {
  const dir = fakeDir("V");
  const win = fakeWin();
  const a = createMemoryAdapter();
  const A = createFolderAdapter(a, { win, pollMs: 0, writer: "w-devicea0001" });
  await A.connect(dir);
  // another device writes through its own adapter (stamps the manifest on push)
  const B = createFolderAdapter(createMemoryAdapter(), { win: fakeWin(), pollMs: 0, writer: "w-deviceb0001" });
  await B.connect(dir);
  await B.set("pages", "b", page("b", "from B", Date.now()));
  await B.flush();
  assert.equal(JSON.parse(dir.read("denotation.json")).writer, "w-deviceb0001");
  const scans = await countReads(dir);
  let remote = 0;
  A.onRemoteChange(() => remote++);
  await advance(31_000);
  win.emit("focus");
  await settle();
  assert.equal((await a.get("pages", "b")).title, "from B");
  assert.equal(scans.n, 1, "one full read for the pull");
  assert.equal(remote, 1);
  // an MCP-style write: record + bumped stamp
  dir.put("pages/m.json", json(page("m", "from MCP", Date.now())));
  bumpStamp(dir, "mcp-1234abcd");
  await advance(31_000);
  win.emit("focus");
  await settle();
  assert.equal((await a.get("pages", "m")).title, "from MCP");
  assert.equal(scans.n, 2);
}));

test("auto push runs only at the interval (5 min default); nothing is written in between", () => withClock(async () => {
  const dir = fakeDir("V");
  const fs = createFolderAdapter(createMemoryAdapter(), { win: fakeWin(), pollMs: 0 });
  await fs.connect(dir);
  assert.equal(fs.status().pushMinutes, 5);
  const start = Date.now();
  assert.equal(fs.status().nextPushAt, start + 5 * MIN);
  const before = countWrites(dir);
  await advance(1_000);
  await fs.set("pages", "p", page("p", "v1", 1));
  await fs.set("pages", "q", page("q", "q1", 1));
  assert.equal(fs.status().unpushed, 2);
  await advance(5 * MIN - 2_000);
  assert.equal(countWrites(dir), before, "no writes before the interval");
  await advance(1_000);
  assert.equal(JSON.parse(dir.read("pages/p.json")).title, "v1");
  assert.equal(JSON.parse(dir.read("pages/q.json")).title, "q1");
  assert.equal(fs.status().unpushed, 0);
  assert.equal(fs.status().nextPushAt, start + 10 * MIN);
  const after = countWrites(dir);
  await advance(5 * MIN);
  assert.equal(countWrites(dir), after, "no changes: nothing written at the next interval");
  await fs.set("pages", "p", page("p", "v2", 2));
  await advance(4 * MIN);
  assert.equal(JSON.parse(dir.read("pages/p.json")).title, "v1");
  await advance(1 * MIN);
  assert.equal(JSON.parse(dir.read("pages/p.json")).title, "v2");
}));

test("push interval setting: 10 min honoured, values below 5 clamp to 5, saved per device", () => withClock(async () => {
  const storage = memStorage();
  const dir = fakeDir("V");
  const fs = createFolderAdapter(createMemoryAdapter(), { win: fakeWin(), pollMs: 0, storage, registry: createLocationRegistry({ storage, handles: memoryHandles() }) });
  await fs.connect(dir);
  assert.equal(fs.setPushMinutes(10), 10);
  assert.deepEqual(JSON.parse(storage.getItem(SYNC_MODE_KEY)), { mode: "auto", pushMinutes: 10 });
  await fs.set("pages", "p", page("p", "v1", 1));
  await advance(9 * MIN);
  assert.equal(dir.read("pages/p.json"), undefined);
  await advance(1 * MIN);
  assert.equal(JSON.parse(dir.read("pages/p.json")).title, "v1");
  assert.equal(fs.setPushMinutes(1), 5);
  assert.equal(fs.setPushMinutes(0), 5);
  assert.equal(fs.setPushMinutes("abc"), 5);
  assert.equal(fs.setPushMinutes(45), 30);
  assert.equal(fs.setPushMinutes(999), 60);
  assert.equal(createFolderAdapter(createMemoryAdapter(), { pushMinutes: 2 }).pushMinutes, 5);
  assert.deepEqual(PUSH_MINUTES, [5, 10, 15, 30, 60]);
}));

test("auto push checks first: a newer folder is merged (pulled) before pushing, never overwritten", () => withClock(async () => {
  const dir = fakeDir("V");
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { win: fakeWin(), pollMs: 0 });
  await fs.connect(dir);
  await fs.set("pages", "s", page("s", "shared v1", 10));
  await advance(5 * MIN);
  assert.equal(JSON.parse(dir.read("pages/s.json")).title, "shared v1");
  // here: an older edit of s and a new page; elsewhere: a newer edit of s and another page, stamped
  await fs.set("pages", "s", page("s", "local older", 20));
  await fs.set("pages", "mine", page("mine", "mine", 20));
  dir.put("pages/s.json", json(page("s", "remote newer", 30)));
  dir.put("pages/theirs.json", json(page("theirs", "theirs", 30)));
  bumpStamp(dir);
  const scans = await countReads(dir);
  await advance(5 * MIN);
  assert.equal(scans.n, 1, "a full merge ran");
  assert.equal(JSON.parse(dir.read("pages/s.json")).title, "remote newer", "not overwritten");
  assert.equal((await cache.get("pages", "s")).title, "remote newer");
  assert.equal((await cache.get("pages", "theirs")).title, "theirs");
  assert.equal(JSON.parse(dir.read("pages/mine.json")).title, "mine");
  assert.equal(fs.status().unpushed, 0);
}));

test("hide pushes pending edits at once without moving the interval", () => withClock(async () => {
  for (const how of ["hide", "pagehide", "beforeunload"]) {
    const dir = fakeDir("V");
    const win = fakeWin();
    const fs = createFolderAdapter(createMemoryAdapter(), { win, pollMs: 0 });
    await fs.connect(dir);
    const next = fs.status().nextPushAt;
    await advance(2 * MIN);
    await fs.set("pages", "p", page("p", "v1", 1));
    if (how === "hide") win.hide();
    else win.emit(how);
    await settle();
    assert.equal(JSON.parse(dir.read("pages/p.json")).title, "v1", how);
    assert.equal(fs.status().nextPushAt, next, "interval unchanged");
    const w = countWrites(dir);
    win.emit(how === "hide" ? "pagehide" : how);
    await settle();
    assert.equal(countWrites(dir), w, "nothing pending: a hide writes nothing");
    await fs.disconnect();
  }
}));

test("switching to Manual, remove and make main push pending edits first", () => withClock(async () => {
  const one = fakeDir("One");
  const fs = createFolderAdapter(createMemoryAdapter(), { win: fakeWin(), pollMs: 0 });
  await fs.connect(one);
  await fs.set("pages", "a", page("a", "A", 1));
  await fs.setMode("manual");
  assert.equal(JSON.parse(one.read("pages/a.json")).title, "A");
  await fs.setMode("auto");
  const two = fakeDir("Two");
  const { id } = await fs.addLocation(two);
  await fs.set("pages", "b", page("b", "B", 2));
  await fs.makeMain(id);
  assert.equal(JSON.parse(one.read("pages/b.json")).title, "B", "old main got the pending edit before the switch");
  await fs.set("pages", "c", page("c", "C", 3));
  await fs.removeLocation(id);
  assert.equal(JSON.parse(two.read("pages/c.json")).title, "C");
}));

test("sync settings: the old mode string migrates to { mode, pushMinutes }", () => {
  const storage = memStorage();
  storage.setItem(SYNC_MODE_KEY, "manual");
  assert.deepEqual(loadSyncSettings(storage), { mode: "manual", pushMinutes: 5 });
  assert.equal(createFolderAdapter(createMemoryAdapter(), { storage }).mode, "manual");
  storage.setItem(SYNC_MODE_KEY, "auto");
  assert.deepEqual(loadSyncSettings(storage), { mode: "auto", pushMinutes: 5 });
  storage.setItem(SYNC_MODE_KEY, json({ mode: "manual", pushMinutes: 3 }));
  assert.deepEqual(loadSyncSettings(storage), { mode: "manual", pushMinutes: 5 });
  storage.setItem(SYNC_MODE_KEY, "{junk");
  assert.deepEqual(loadSyncSettings(storage), { mode: "auto", pushMinutes: 5 });
  storage.setItem(SYNC_MODE_KEY, "manual");
  saveSyncSettings({ pushMinutes: 15 }, storage);
  assert.deepEqual(JSON.parse(storage.getItem(SYNC_MODE_KEY)), { mode: "manual", pushMinutes: 15 });
  assert.equal(clampPushMinutes(4.9), 5);
  const empty = memStorage();
  const id = loadWriterId(empty);
  assert.match(id, /^w-[a-z0-9]{8,32}$/);
  assert.equal(loadWriterId(empty), id, "the writer id is stable per device");
});

test("backups: copied after each auto push of the main, and on hide", () => withClock(async () => {
  const main = fakeDir("M");
  const bak = fakeDir("B");
  const win = fakeWin();
  const fs = createFolderAdapter(createMemoryAdapter(), { win, pollMs: 0 });
  await fs.connect(main);
  await fs.addLocation(bak);
  await fs.set("pages", "p", page("p", "P1", 1));
  await advance(4 * MIN);
  assert.equal(bak.read("pages/p.json"), undefined);
  await advance(1 * MIN);
  assert.equal(JSON.parse(bak.read("pages/p.json")).title, "P1");
  await fs.set("pages", "p", page("p", "P2", 2));
  win.hide();
  await settle();
  assert.equal(JSON.parse(bak.read("pages/p.json")).title, "P2");
}));

test("backups with no main: copied on the push interval and on hide", () => withClock(async () => {
  const bak = fakeDir("B");
  const win = fakeWin();
  const fs = createFolderAdapter(createMemoryAdapter(), { win });
  await fs.addLocation(bak);
  await fs.set("pages", "p", page("p", "P1", 3));
  await advance(4 * MIN);
  assert.equal(bak.read("pages/p.json"), undefined);
  await advance(1 * MIN);
  assert.equal(JSON.parse(bak.read("pages/p.json")).title, "P1");
  const w = countWrites(bak);
  await advance(5 * MIN);
  assert.equal(countWrites(bak), w, "nothing changed: no copy");
  await fs.set("pages", "p", page("p", "P2", 4));
  await advance(1 * MIN);
  assert.equal(JSON.parse(bak.read("pages/p.json")).title, "P1");
  win.hide();
  await settle();
  assert.equal(JSON.parse(bak.read("pages/p.json")).title, "P2");
  assert.equal(fs.status().state, "off");
}));

// ---------- encryption ----------
import { createKeyFile, createKeyring, isEnvelope, unwrapWithPin, unwrapWithSecret, rewrapPin, decryptText, encryptRecord } from "../../source/app/js/crypto.js";
import { folderProvider } from "../../source/app/js/adapters/locations.js";

const FASTK = 1000;
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
async function encSetup({ pin = "1234", files = false } = {}) {
  const storage = memStorage();
  const keyring = createKeyring({ storage });
  const { file, dek, recovery } = await createKeyFile({ pin, iterations: FASTK });
  keyring.adopt(dek, file);
  if (files) keyring.saveSettings({ files: true });
  return { storage, keyring, dek, file, recovery };
}
/** A folder provider whose writes can fail: before the write ("before") or after it landed ("after"). */
function faulty(dir) {
  const p = folderProvider(dir);
  const ctl = { failAt: -1, writes: 0, when: "before" };
  const wrapped = {
    ...p,
    type: "folder",
    name: dir.name,
    handle: dir,
    permission: async () => "granted",
    async writeText(path, text) {
      const n = ctl.writes++;
      if (n === ctl.failAt && ctl.when === "before") throw new Error("disk went away");
      await p.writeText(path, text);
      if (n === ctl.failAt && ctl.when === "after") throw new Error("disk went away after writing");
    }
  };
  return { provider: wrapped, ctl };
}
function folderFiles(dir) {
  const out = {};
  const walk = (d, prefix) => {
    for (const [k, v] of d.tree) {
      if (v.kind === "directory") walk(v, `${prefix}${k}/`);
      else out[`${prefix}${k}`] = v.content;
    }
  };
  walk(dir, "");
  return out;
}
/** Every record file reads (plain or decrypted) as `expect` says. */
async function assertRecords(dir, dek, expect) {
  for (const [path, rec] of Object.entries(expect)) {
    const text = dir.read(path);
    assert.ok(text != null, `${path} missing`);
    const v = JSON.parse(text);
    const [d, f] = path.split("/");
    const got = isEnvelope(v) ? JSON.parse(await decryptText(dek, d, f.replace(/\.json$/, ""), v)) : v;
    assert.deepEqual(got, rec, path);
  }
}
const encCount = (dir) => Object.entries(folderFiles(dir)).filter(([p, t]) => /^(pages|rows|tombstones)\//.test(p) && isEnvelope(JSON.parse(t))).length;

async function seededFolder(n = 6) {
  const dir = fakeDir("Vault");
  const expect = {};
  for (let i = 0; i < n; i++) {
    const p = page(`p${i}`, `Page ${i}`, 100 + i);
    dir.put(`pages/p${i}.json`, json(p));
    expect[`pages/p${i}.json`] = p;
  }
  const row = { id: "r1", dbId: "p0", values: { a: 1 }, createdAt: 1, updatedAt: 2 };
  dir.put("rows/r1.json", json(row));
  expect["rows/r1.json"] = row;
  const t = { id: "gone", collection: "pages", deletedAt: Date.now() };
  dir.put("tombstones/gone.json", json(t));
  expect["tombstones/gone.json"] = t;
  dir.put("notes.txt", "mine");
  return { dir, expect };
}

test("encryption on: every record file becomes an envelope, manifest says so, keys.json opens with the PIN", async () => {
  const { storage, keyring, dek } = await encSetup();
  const { dir, expect } = await seededFolder();
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { storage, keyring, registry: createLocationRegistry({ storage, handles: memoryHandles() }) });
  await fs.connect(dir);
  const results = await fs.setEncryption(true);
  assert.equal(results[0].error, undefined);
  assert.equal(results[0].changed, 8);
  assert.equal(encCount(dir), 8);
  const m = JSON.parse(dir.read("denotation.json"));
  assert.equal(m.encrypted, true);
  assert.equal(m.keyId, keyring.kid);
  assert.equal(m.encryption, undefined, "marker cleared when done");
  assert.ok(await unwrapWithPin(JSON.parse(dir.read("keys.json")), "1234"));
  assert.equal(dir.read("notes.txt"), "mine");
  assert.ok(!JSON.stringify(folderFiles(dir)).includes("Page 3"), "no titles in clear");
  await assertRecords(dir, dek, expect);
  assert.equal(keyring.settings().files, true);
  // later writes are encrypted; the stamp keeps the encryption fields
  await fs.set("pages", "new", page("new", "Fresh secret", 999));
  await fs.flush();
  await fs.syncNow();
  assert.ok(isEnvelope(JSON.parse(dir.read("pages/new.json"))));
  assert.equal(JSON.parse(dir.read("denotation.json")).encrypted, true);
  // a fresh browser with the same key reads everything
  const cache2 = createMemoryAdapter();
  const fs2 = createFolderAdapter(cache2, { storage, keyring, registry: createLocationRegistry({ storage: memStorage(), handles: memoryHandles() }) });
  await fs2.connect(dir);
  assert.equal((await cache2.get("pages", "p3")).title, "Page 3");
  assert.equal((await cache2.get("pages", "new")).title, "Fresh secret");
});

test("encryption off: everything back to plain, keys.json deleted last, manifest plain", async () => {
  const { storage, keyring, dek } = await encSetup();
  const { dir, expect } = await seededFolder();
  const fs = createFolderAdapter(createMemoryAdapter(), { storage, keyring, registry: createLocationRegistry({ storage, handles: memoryHandles() }) });
  await fs.connect(dir);
  await fs.setEncryption(true);
  const r = await fs.setEncryption(false);
  assert.equal(r[0].error, undefined);
  assert.equal(encCount(dir), 0);
  assert.equal(dir.read("keys.json"), undefined);
  const m = JSON.parse(dir.read("denotation.json"));
  assert.equal(m.encrypted, undefined);
  assert.equal(m.keyId, undefined);
  await assertRecords(dir, dek, expect);
  assert.equal(keyring.settings().files, false);
});

for (const when of ["before", "after"]) {
  test(`interrupted encrypt / decrypt jobs (write fails ${when} landing, seeded) never lose or corrupt a record and resume`, async () => {
    const next = seeded(when === "before" ? 1234 : 99);
    for (let round = 0; round < 24; round++) {
      const { storage, keyring, dek } = await encSetup();
      const { dir, expect } = await seededFolder(5);
      const { provider, ctl } = faulty(dir);
      const cache = createMemoryAdapter();
      const fs = createFolderAdapter(cache, { storage, keyring, registry: createLocationRegistry({ storage, handles: memoryHandles() }) });
      await fs.connect(provider);
      for (const r of await cache.list("pages")) expect[`pages/${r.id}.json`] = r;
      const target = round % 3 === 2 ? "plain" : "encrypted";
      if (target === "plain") await fs.setEncryption(true);
      ctl.writes = 0;
      ctl.when = when;
      ctl.failAt = Math.floor(next() * 14);
      const res = await fs.setEncryption(target === "encrypted");
      ctl.failAt = -1;
      await assertRecords(dir, dek, expect); // mixed state: every record still reads
      const marker = JSON.parse(dir.read("denotation.json")).encryption;
      const doneAlready = encCount(dir) === (target === "encrypted" ? 7 : 0);
      if (res[0].error) assert.ok(marker || doneAlready || (target === "encrypted" && encCount(dir) === 0), "an unfinished job leaves its marker");
      // resume: a later sync (another browser session) finishes the job
      const fs2 = createFolderAdapter(createMemoryAdapter(), { storage, keyring, registry: createLocationRegistry({ storage: memStorage(), handles: memoryHandles() }) });
      await fs2.connect(provider);
      await assertRecords(dir, dek, expect);
      assert.equal(encCount(dir), target === "encrypted" ? 7 : 0, `round ${round}: finished as ${target} (fail at ${res[0].error ?? "-"}) ${JSON.stringify(Object.keys(folderFiles(dir)))} ${Object.entries(folderFiles(dir)).filter(([p, t]) => /^(pages|rows|tomb)/.test(p) && !isEnvelope(JSON.parse(t))).map(([p]) => p)}`);
      const m = JSON.parse(dir.read("denotation.json"));
      assert.equal(m.encryption, undefined, `round ${round}: marker cleared`);
      assert.equal(!!m.encrypted, target === "encrypted");
      if (target === "encrypted") assert.ok(dir.read("keys.json"));
      else if (!res[0].error) assert.equal(dir.read("keys.json"), undefined); // a stale one (failure after the last write) is harmless
      assert.equal(keyring.settings().files, target === "encrypted");
    }
  });
}

test("mixed plain and encrypted files read during a job; swapped or tampered envelopes are skipped, never deleted", async () => {
  const { storage, keyring, dek, file } = await encSetup();
  const dir = fakeDir("Mixed");
  const a = page("a", "Plain A", 10);
  const b = page("b", "Secret B", 11);
  const c = page("c", "Secret C", 12);
  dir.put("keys.json", json(file));
  dir.put("denotation.json", json({ app: "denotation", format: "json", version: 1, encrypted: true, keyId: file.kid, encryption: { state: "encrypting", startedAt: 1 } }));
  dir.put("pages/a.json", json(a));
  dir.put("pages/b.json", json(await encryptRecord(dek, file.kid, "pages", "b", b)));
  dir.put("pages/x.json", json(await encryptRecord(dek, file.kid, "pages", "c", c))); // c's envelope copied to x
  const tampered = await encryptRecord(dek, file.kid, "pages", "c", c);
  tampered.ct = tampered.ct.slice(0, -4) + (tampered.ct.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
  dir.put("pages/c.json", json(tampered));
  keyring.saveSettings({ files: true });
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { storage, keyring, registry: createLocationRegistry({ storage, handles: memoryHandles() }) });
  await fs.connect(dir);
  assert.equal((await cache.get("pages", "a")).title, "Plain A");
  assert.equal((await cache.get("pages", "b")).title, "Secret B");
  assert.equal(await cache.get("pages", "x"), null, "a swapped envelope does not decrypt");
  assert.equal(await cache.get("pages", "c"), null, "a tampered envelope does not decrypt");
  assert.ok(dir.read("pages/x.json"), "left alone");
  assert.ok(dir.read("pages/c.json"), "left alone");
  assert.equal(JSON.parse(dir.read("denotation.json")).encryption, undefined, "the resumed job finished");
  assert.ok(isEnvelope(JSON.parse(dir.read("pages/a.json"))));
});

test("without the key the location is locked: nothing read as data, nothing written", async () => {
  const owner = await encSetup();
  const { dir } = await seededFolder();
  const fsA = createFolderAdapter(createMemoryAdapter(), { storage: owner.storage, keyring: owner.keyring, registry: createLocationRegistry({ storage: owner.storage, handles: memoryHandles() }) });
  await fsA.connect(dir);
  await fsA.setEncryption(true);
  const before = JSON.stringify(folderFiles(dir));
  // another browser without the key, with its own pages
  const storage = memStorage();
  const keyring = createKeyring({ storage });
  const cache = createMemoryAdapter();
  await cache.set("pages", "mine", page("mine", "Only here", 5));
  const fs = createFolderAdapter(cache, { storage, keyring, registry: createLocationRegistry({ storage, handles: memoryHandles() }) });
  await assert.rejects(fs.connect(dir), (e) => e.code === "locked");
  assert.equal(fs.status().state, "locked");
  assert.match(fs.status().error, /unlock to sync/);
  assert.equal(fs.status().locations[0].encrypted, true);
  await fs.set("pages", "mine", page("mine", "Edited", 6));
  await fs.flush();
  assert.equal(JSON.stringify(folderFiles(dir)), before, "the encrypted folder was not touched");
  assert.equal((await cache.list("pages")).length, 1, "no envelopes in the cache");
  // a third browser holding a different key is refused too
  const other = await encSetup();
  const fs3 = createFolderAdapter(createMemoryAdapter(), { storage: other.storage, keyring: other.keyring, registry: createLocationRegistry({ storage: other.storage, handles: memoryHandles() }) });
  await assert.rejects(fs3.connect(dir), /different key/);
  assert.equal(JSON.stringify(folderFiles(dir)), before);
  // unlock with the folder's PIN, keep the key for this browser's own PIN, then sync
  const kf = await fs.locationKeyFile(fs.status().locations[0].id);
  assert.equal(await unwrapWithSecret(kf, "0000"), null, "wrong PIN");
  const { dek } = await unwrapWithSecret(kf, "1234");
  keyring.adopt(dek, await rewrapPin(kf, dek, "5555", { iterations: FASTK }));
  await fs.retryLocked();
  assert.equal(fs.status().state, "synced");
  assert.equal((await cache.get("pages", "p2")).title, "Page 2");
  assert.ok(isEnvelope(JSON.parse(dir.read("pages/mine.json"))), "its own pages go in encrypted");
  assert.equal(keyring.settings().files, true, "follows the main");
  assert.ok(await unwrapWithPin(keyring.file(), "5555"), "this browser opens the key with its own PIN");
});

test("unlocking with the recovery key works the same way", async () => {
  const owner = await encSetup();
  const { dir } = await seededFolder(2);
  const fsA = createFolderAdapter(createMemoryAdapter(), { storage: owner.storage, keyring: owner.keyring, registry: createLocationRegistry({ storage: owner.storage, handles: memoryHandles() }) });
  await fsA.connect(dir);
  await fsA.setEncryption(true);
  const kf = JSON.parse(dir.read("keys.json"));
  const r = await unwrapWithSecret(kf, owner.recovery);
  assert.equal(r.via, "recovery");
});

test("PIN change re-wraps the key file in every encrypted location", async () => {
  const { storage, keyring, dek } = await encSetup();
  const { dir } = await seededFolder(2);
  const backup = fakeDir("Backup");
  const fs = createFolderAdapter(createMemoryAdapter(), { storage, keyring, registry: createLocationRegistry({ storage, handles: memoryHandles() }) });
  await fs.connect(dir);
  await fs.addLocation(backup, { role: "backup" });
  await fs.setEncryption(true);
  keyring.saveFile(await rewrapPin(keyring.file(), dek, "246810", { iterations: FASTK, now: Date.now() + 1000 }));
  await fs.syncKeyFiles();
  for (const d of [dir, backup]) {
    const kf = JSON.parse(d.read("keys.json"));
    assert.equal(await unwrapWithPin(kf, "1234"), null, `${d.name}: old PIN no longer opens it`);
    assert.ok(await unwrapWithPin(kf, "246810"), `${d.name}: new PIN opens it`);
  }
});

test("backups follow: encrypted with the main, copies stay encrypted, decrypted when turned off", async () => {
  const { storage, keyring, dek } = await encSetup();
  const { dir } = await seededFolder(3);
  const backup = fakeDir("Backup");
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { storage, keyring, registry: createLocationRegistry({ storage, handles: memoryHandles() }) });
  await fs.connect(dir);
  await fs.addLocation(backup, { role: "backup" });
  const recFiles = (d) => Object.keys(folderFiles(d)).filter((p) => /^(pages|rows|tombstones)\//.test(p)).length;
  assert.equal(encCount(backup), 0);
  assert.ok(recFiles(backup) >= 4);
  const r = await fs.setEncryption(true);
  assert.deepEqual(r.map((x) => x.error), [undefined, undefined]);
  assert.equal(encCount(backup), recFiles(backup));
  await fs.set("pages", "later", page("later", "Later", 500));
  await fs.flush();
  await fs.syncNow();
  assert.ok(isEnvelope(JSON.parse(backup.read("pages/later.json"))));
  assert.equal(JSON.parse(backup.read("denotation.json")).encrypted, true);
  const back = await fs.readBackup(fs.status().locations.find((l) => l.role === "backup").id);
  assert.equal(back.count, 5);
  assert.ok(back.files.some((f) => f.data.includes("Later")), "restore decrypts");
  await fs.setEncryption(false);
  assert.equal(encCount(backup), 0);
  assert.equal(JSON.parse(backup.read("pages/later.json")).title, "Later");
  assert.equal(backup.read("keys.json"), undefined);
  void dek;
});

test("another device turning encryption on or off is followed; a new empty main follows this device", async () => {
  const a = await encSetup();
  const { dir } = await seededFolder(2);
  const reg = () => createLocationRegistry({ storage: memStorage(), handles: memoryHandles() });
  const fsA = createFolderAdapter(createMemoryAdapter(), { storage: a.storage, keyring: a.keyring, registry: reg() });
  await fsA.connect(dir);
  // B shares the key (adopted earlier) and has synced the plain folder
  const bStorage = memStorage();
  const bRing = createKeyring({ storage: bStorage });
  bRing.adopt(a.dek, a.keyring.file());
  const fsB = createFolderAdapter(createMemoryAdapter(), { storage: bStorage, keyring: bRing, registry: reg() });
  await fsB.connect(dir);
  await fsA.setEncryption(true);
  await fsB.syncNow();
  assert.equal(bRing.settings().files, true, "B follows A turning it on");
  await fsA.setEncryption(false);
  await fsB.syncNow();
  assert.equal(bRing.settings().files, false, "B follows A turning it off");
  assert.equal(encCount(dir), 0);
  // a brand-new folder as main on a device with encryption on is encrypted
  const fresh = fakeDir("Fresh");
  a.keyring.saveSettings({ files: true });
  const fsC = createFolderAdapter(createMemoryAdapter(), { storage: a.storage, keyring: a.keyring, registry: reg() });
  await fsC.set("pages", "z", page("z", "Zed", 1));
  await fsC.connect(fresh);
  assert.ok(isEnvelope(JSON.parse(fresh.read("pages/z.json"))));
  assert.equal(JSON.parse(fresh.read("denotation.json")).encrypted, true);
});

test("locked app (key dropped): automatic syncs wait, the folder is untouched", () => withClock(async () => {
  const { storage, keyring } = await encSetup();
  const { dir } = await seededFolder(2);
  const win = fakeWin();
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { storage, keyring, win, registry: createLocationRegistry({ storage, handles: memoryHandles() }) });
  await fs.connect(dir);
  await fs.setEncryption(true);
  await fs.set("pages", "q", page("q", "Q", Date.now()));
  keyring.lock();
  const before = JSON.stringify(folderFiles(dir));
  await advance(6 * MIN);
  win.emit("focus");
  await advance(31_000);
  assert.equal(JSON.stringify(folderFiles(dir)), before);
}));

// ---------- setMany passthrough ----------
const lsStub = () => {
  const m = new Map();
  let keys = null;
  return {
    get length() {
      return m.size;
    },
    key: (i) => (keys ??= [...m.keys()])[i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (!m.has(k)) keys = null;
      m.set(k, String(v));
    },
    removeItem: (k) => {
      if (m.delete(k)) keys = null;
    }
  };
};
const dirFiles = (dir) => {
  const out = {};
  for (const sub of ["pages", "rows"]) for (const [n, f] of dir.tree.get(sub)?.tree ?? []) out[`${sub}/${n}`] = f.content;
  return out;
};
for (const kind of ["local", "memory", "no-setMany"]) {
  test(`setMany marks every record dirty like N set() calls and pushes the same files (${kind} cache)`, () => withClock(async () => {
    const { createLocalAdapter } = await import("../../source/app/js/adapters/local.js");
    const makeCache = () => {
      if (kind === "local") return createLocalAdapter(lsStub(), "denotion", { win: null });
      const m = createMemoryAdapter();
      if (kind === "no-setMany") delete m.setMany;
      return m;
    };
    const run = async (batched) => {
      const dir = fakeDir("V");
      const fs = createFolderAdapter(makeCache(), { win: fakeWin(), pollMs: 0, storage: null });
      await fs.connect(dir);
      await advance(1_000);
      const rows = Array.from({ length: 30 }, (_, i) => ({ id: `r${i % 25}`, dbId: "db", createdAt: i, updatedAt: 100 + i, values: { a: i } }));
      if (batched) await fs.setMany("rows", rows);
      else for (const r of rows) await fs.set("rows", r.id, r);
      await fs.set("pages", "p", page("p", "P", 5));
      const unpushed = fs.status().unpushed;
      const listed = (await fs.list("rows", { dbId: "db" })).sort((a, b) => a.createdAt - b.createdAt);
      await advance(5 * MIN);
      return { unpushed, after: fs.status().unpushed, files: dirFiles(dir), listed };
    };
    const one = await run(false);
    const many = await run(true);
    assert.equal(one.unpushed, 26);
    assert.deepEqual(many, one);
    assert.equal(Object.keys(many.files).filter((k) => k.startsWith("rows/")).length, 25);
  }));
}
test("setMany in manual mode: every record counts as unpushed until Push", async () => {
  const dir = fakeDir("V");
  const fs = createFolderAdapter(createMemoryAdapter(), { win: fakeWin(), mode: "manual", pollMs: 0, cooldownMs: 0, storage: null });
  await fs.connect(dir);
  await fs.setMany("rows", [{ id: "a", dbId: "d", createdAt: 1, values: {} }, { id: "b", dbId: "d", createdAt: 2, values: {} }]);
  assert.equal(fs.status().unpushed, 2);
  assert.equal(dir.read("rows/a.json"), undefined, "manual mode writes nothing on its own");
});
test("setMany that fails part-way (quota) still queues the records it saved, and only those", async () => {
  const { createLocalAdapter } = await import("../../source/app/js/adapters/local.js");
  const s = lsStub();
  let n = 0;
  const set = s.setItem;
  s.setItem = (k, v) => {
    if (k.startsWith("denotion:rows:") && ++n > 3) throw new Error("QuotaExceededError");
    set(k, v);
  };
  const fs = createFolderAdapter(createLocalAdapter(s, "denotion", { win: null }), { win: fakeWin(), mode: "manual", pollMs: 0, cooldownMs: 0, storage: null });
  await fs.connect(fakeDir("V"));
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, dbId: "d", createdAt: i, values: {} }));
  await assert.rejects(fs.setMany("rows", rows), /Quota/);
  assert.equal(fs.status().unpushed, 3);
});
