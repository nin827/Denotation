import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../public/js/adapters/memory.js";
import { createFolderAdapter } from "../public/js/adapters/folder.js";
import { createWorkspace } from "../public/js/workspace.js";

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
  assert.equal((await cache.list("tombstones")).length, 0);
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
  assert.equal((await cache.list("tombstones")).length, 0);
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
