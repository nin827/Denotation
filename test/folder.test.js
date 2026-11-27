import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../public/js/adapters/memory.js";
import { createFolderAdapter } from "../public/js/adapters/folder.js";
import { createWorkspace } from "../public/js/workspace.js";
import { createLocationRegistry, memoryHandles, LOCATIONS_KEY } from "../public/js/adapters/locations.js";
import { importFiles } from "../public/js/vault.js";

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

test("writes are debounced and serialised per file; removes delete only that file", async () => {
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

test("auto mode: the periodic poll merges changes made in the folder", async () => {
  const dir = fakeDir("V");
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { mode: "auto", pollMs: 30, debounceMs: 5 });
  await fs.connect(dir);
  let remote = 0;
  fs.onRemoteChange(() => remote++);
  dir.put("pages/new.json", json(page("new", "from another device", Date.now())));
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

test("with no main, local saves are copied to backups (debounced)", async () => {
  const bak = fakeDir("B");
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { backupDebounceMs: 10 });
  await fs.addLocation(bak);
  await fs.set("pages", "p", page("p", "P", 3));
  assert.equal(bak.read("pages/p.json"), undefined);
  await tick(50);
  assert.equal(JSON.parse(bak.read("pages/p.json")).title, "P");
  assert.equal(fs.status().state, "off");
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
