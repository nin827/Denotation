// Drives source/mcp/denotation-mcp.mjs over stdio (JSON-RPC 2.0, one message per line) against a temp folder.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../../source/mcp/denotation-mcp.mjs", import.meta.url));
const NOW = 1_700_000_000_000;

// Fixture: repo "Open repo" (readable) with doc "Shared notes" > child "Secret plans" (read: no),
// database "Groceries" (rows), and repo "Hidden repo" with "Diary" (no granular -> broad no).
function fixture(perms = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "denotation-mcp-"));
  fs.mkdirSync(path.join(dir, "pages"));
  fs.mkdirSync(path.join(dir, "rows"));
  fs.writeFileSync(path.join(dir, "denotation.json"), JSON.stringify({ app: "denotation", format: "json", version: 1 }));
  const page = (id, type, title, parentId, extra = {}) => ({ id, type, title, parentId, createdAt: NOW, updatedAt: NOW, ...extra });
  const block = (text) => ({ id: `b-${text.length}`, type: "p", text });
  const recs = [
    page("repo-open", "repo", "Open repo", null),
    page("doc-shared", "doc", "Shared notes", "repo-open", { blocks: [{ id: "h", type: "h1", text: "Hello" }, block("Shared body text")] }),
    page("doc-secret", "doc", "Secret plans", "doc-shared", { blocks: [block("Top secret body")] }),
    page("db-groc", "database", "Groceries", "repo-open", { columns: [{ id: "c-name", name: "Name", type: "text", config: {} }, { id: "c-qty", name: "Qty", type: "number", config: {} }, { id: "c-dbl", name: "Double", type: "formula", config: { expr: "[Qty]*2" } }] }),
    page("repo-hidden", "repo", "Hidden repo", null),
    page("doc-diary", "doc", "Diary", "repo-hidden", { blocks: [block("Dear diary")] }),
    page("doc-trashed", "doc", "Old trash", "repo-open", { trashedAt: NOW, blocks: [block("trashed text")] })
  ];
  for (const r of recs) fs.writeFileSync(path.join(dir, "pages", `${r.id}.json`), JSON.stringify(r));
  const rows = [
    { id: "row-milk", dbId: "db-groc", createdAt: NOW, updatedAt: NOW, values: { "c-name": "Milk", "c-qty": 1, "c-dbl": 2 } },
    { id: "row-eggs", dbId: "db-groc", createdAt: NOW + 1, updatedAt: NOW, values: { "c-name": "Eggs", "c-qty": 12, "c-dbl": 24 } }
  ];
  for (const r of rows) fs.writeFileSync(path.join(dir, "rows", `${r.id}.json`), JSON.stringify(r));
  fs.writeFileSync(path.join(dir, "outside.txt"), "do not touch");
  if (perms) fs.writeFileSync(path.join(dir, "permissions.json"), JSON.stringify(perms));
  return dir;
}
const PERMS = {
  version: 1,
  broad: { read: "no", create: "no", edit: "no", delete: "no" },
  pages: {
    "repo-open": { read: "yes", create: "yes", edit: "yes" },
    "doc-secret": { read: "no", edit: "no" },
    "db-groc": { delete: "yes" }
  },
  updatedAt: NOW
};

function startServer(dir, extra = []) {
  const child = spawn(process.execPath, [SERVER, "--folder", dir, ...extra], { stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  const lines = [];
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(line);
    const msg = JSON.parse(line); // stdout must be pure JSON-RPC
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  let next = 1;
  const send = (obj) => child.stdin.write(`${typeof obj === "string" ? obj : JSON.stringify(obj)}\n`);
  const request = (method, params, id = next++) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}\n${stderr}`)), 5000);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    send({ jsonrpc: "2.0", id, method, params });
  });
  const call = async (name, args = {}) => {
    const m = await request("tools/call", { name, arguments: args });
    assert.ok(m.result, `tools/call ${name} returned a protocol error: ${JSON.stringify(m.error)}`);
    const text = m.result.content[0].text;
    return { error: !!m.result.isError, text, data: m.result.isError ? null : JSON.parse(text) };
  };
  const stop = () => new Promise((r) => { child.on("exit", r); child.stdin.end(); });
  return { child, request, call, send, stop, lines, get stderr() { return stderr; } };
}

test("initialize, ping, tools/list and protocol errors", async (t) => {
  const dir = fixture(PERMS);
  const s = startServer(dir);
  t.after(() => s.stop());
  const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "denotation");
  assert.ok(init.result.capabilities.tools);
  s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.deepEqual((await s.request("ping")).result, {});
  const names = (await s.request("tools/list")).result.tools.map((x) => x.name).sort();
  assert.deepEqual(names, ["add_row", "create_page", "delete_page", "delete_row", "list_pages", "read_page", "search", "update_page", "update_row"]);
  for (const tool of (await s.request("tools/list")).result.tools) assert.equal(tool.inputSchema.type, "object");
  assert.equal((await s.request("nope/method")).error.code, -32601);
  assert.equal((await s.request("tools/call", { name: "rm_rf" })).error.code, -32602);
  const older = await s.request("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(older.result.protocolVersion, "2025-06-18");
});

test("reading: allowed vs denied, no title leaks, trash hidden", async (t) => {
  const dir = fixture(PERMS);
  const s = startServer(dir);
  t.after(() => s.stop());
  const list = await s.call("list_pages");
  const titles = list.data.pages.map((p) => p.title);
  assert.deepEqual(titles.sort(), ["Groceries", "Open repo", "Shared notes"]);
  assert.ok(!list.text.includes("Secret plans") && !list.text.includes("Diary") && !list.text.includes("Hidden repo") && !list.text.includes("Old trash"));
  assert.equal(list.data.canCreateRepository, false);
  assert.equal(list.data.pages.find((p) => p.id === "db-groc").can.delete, true);

  const doc = await s.call("read_page", { id: "doc-shared" });
  assert.match(doc.data.markdown, /# Hello/);
  assert.match(doc.data.markdown, /Shared body text/);
  assert.deepEqual(doc.data.children, [], "non-readable child is not listed");

  for (const id of ["doc-secret", "doc-diary", "repo-hidden"]) {
    const r = await s.call("read_page", { id });
    assert.equal(r.error, true);
    assert.match(r.text, /^Denotation: permission denied: read on page /);
    assert.ok(!/Secret|Diary|Hidden/.test(r.text), `no title in ${r.text}`);
  }
  const trashed = await s.call("read_page", { id: "doc-trashed" });
  assert.equal(trashed.error, true);
  assert.ok(!trashed.text.includes("Old trash"));

  const db = await s.call("read_page", { id: "db-groc" });
  assert.equal(db.data.kind, "database");
  assert.deepEqual(db.data.columns.map((c) => c.name), ["Name", "Qty", "Double"]);
  assert.deepEqual(db.data.rows.map((r) => r.values.Name), ["Milk", "Eggs"]);
  const row = await s.call("read_page", { id: "row-eggs" });
  assert.equal(row.data.values.Qty, 12);

  const hits = await s.call("search", { query: "secret" });
  assert.deepEqual(hits.data.results, []);
  const hits2 = await s.call("search", { query: "body" });
  assert.deepEqual(hits2.data.results.map((h) => h.id), ["doc-shared"]);
  const hits3 = await s.call("search", { query: "egg" });
  assert.deepEqual(hits3.data.results.map((h) => h.id), ["row-eggs"]);
});

test("no permissions.json: everything denied", async (t) => {
  const dir = fixture(null);
  const s = startServer(dir);
  t.after(() => s.stop());
  assert.deepEqual((await s.call("list_pages")).data.pages, []);
  assert.equal((await s.call("read_page", { id: "doc-shared" })).error, true);
  assert.equal((await s.call("create_page", { title: "X", parentId: "repo-open" })).error, true);
  assert.equal((await s.call("create_page", { title: "X", type: "repo" })).error, true);
  assert.equal(fs.readdirSync(path.join(dir, "pages")).length, 7);
});

test("writes with and without permission; permissions.json never modified", async (t) => {
  const dir = fixture(PERMS);
  const permFile = path.join(dir, "permissions.json");
  const before = fs.readFileSync(permFile, "utf8");
  const beforeStat = fs.statSync(permFile).mtimeMs;
  const s = startServer(dir);
  t.after(() => s.stop());

  // create
  const made = await s.call("create_page", { title: "From AI", parentId: "doc-shared", markdown: "# Title\n\n- one\n- [x] two" });
  assert.equal(made.error, false, made.text);
  // every write bumps the manifest stamp (format fields kept) so the app's cheap check notices it
  const manifest = () => JSON.parse(fs.readFileSync(path.join(dir, "denotation.json"), "utf8"));
  const m1 = manifest();
  assert.deepEqual([m1.app, m1.format, m1.version, m1.rev], ["denotation", "json", 1, 1]);
  assert.match(m1.writer, /^mcp-[0-9a-f]{10}$/);
  assert.ok(m1.updatedAt > NOW);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "pages", `${made.data.created.id}.json`), "utf8"));
  assert.equal(rec.parentId, "doc-shared");
  assert.equal(rec.type, "doc");
  assert.ok(rec.updatedAt > NOW && rec.createdAt > NOW);
  assert.deepEqual(rec.blocks.map((b) => b.type), ["h1", "bullet", "todo"]);
  assert.match(made.data.created.id, /^[A-Za-z0-9-]{1,100}$/);
  const deniedCreate = await s.call("create_page", { title: "Nope", parentId: "repo-hidden" });
  assert.equal(deniedCreate.error, true);
  assert.match(deniedCreate.text, /permission denied: create on page repo-hidden/);
  const db2 = await s.call("create_page", { title: "Tasks", parentId: "repo-open", type: "database", columns: [{ name: "Task" }, { name: "State", type: "select", options: ["Open", "Done"] }] });
  assert.equal(db2.error, false, db2.text);

  // update
  const upd = await s.call("update_page", { id: "doc-shared", title: "Shared notes v2", markdown: "New body" });
  assert.equal(upd.error, false, upd.text);
  const shared = JSON.parse(fs.readFileSync(path.join(dir, "pages", "doc-shared.json"), "utf8"));
  assert.equal(shared.title, "Shared notes v2");
  assert.equal(shared.blocks[0].text, "New body");
  assert.ok(shared.updatedAt > NOW);
  const deniedEdit = await s.call("update_page", { id: "doc-secret", title: "pwned" });
  assert.match(deniedEdit.text, /^Denotation: permission denied: edit on page doc-secret$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "pages", "doc-secret.json"), "utf8")).title, "Secret plans");

  // delete page: broad delete is no, and nothing under repo-open allows it except the database
  const deniedDelete = await s.call("delete_page", { id: "doc-shared" });
  assert.match(deniedDelete.text, /permission denied: delete on "Shared notes v2"/);

  // rows
  const added = await s.call("add_row", { databaseId: "db-groc", values: { name: "Bread", Qty: 3 }, markdown: "Whole wheat" });
  assert.equal(added.error, false, added.text);
  const row = JSON.parse(fs.readFileSync(path.join(dir, "rows", `${added.data.created.id}.json`), "utf8"));
  assert.deepEqual(row.values, { "c-name": "Bread", "c-qty": 3, "c-dbl": 6 });
  assert.equal(row.dbId, "db-groc");
  assert.equal((await s.call("add_row", { databaseId: "db-groc", values: { Qty: "lots" } })).error, true);
  assert.match((await s.call("add_row", { databaseId: "db-groc", values: { Nope: 1 } })).text, /No column "Nope"/);
  assert.match((await s.call("add_row", { databaseId: "db-groc", values: { Double: 1 } })).text, /formula/);
  const updRow = await s.call("update_row", { id: "row-milk", values: { Qty: 2 } });
  assert.equal(updRow.error, false, updRow.text);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "rows", "row-milk.json"), "utf8")).values["c-dbl"], 4);
  const delRow = await s.call("delete_row", { id: "row-eggs" });
  assert.equal(delRow.error, false, delRow.text);
  assert.ok(!fs.existsSync(path.join(dir, "rows", "row-eggs.json")));
  const tomb = JSON.parse(fs.readFileSync(path.join(dir, "tombstones", "row-eggs.json"), "utf8"));
  assert.equal(tomb.id, "row-eggs");
  assert.equal(tomb.collection, "rows");
  assert.ok(tomb.deletedAt > NOW);
  assert.ok(!fs.existsSync(path.join(dir, "rows", ".deleted.json")), "no legacy delete log is written");
  const m2 = manifest();
  assert.ok(m2.rev > m1.rev + 3, "writes and deletes bumped the stamp");
  assert.equal(m2.writer, m1.writer);

  // delete_page on the database is allowed (granular delete yes; rows inherit) and only trashes it
  const delDb = await s.call("delete_page", { id: "db-groc" });
  assert.equal(delDb.error, false, delDb.text);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "pages", "db-groc.json"), "utf8")).trashedAt > NOW);
  assert.equal((await s.call("read_page", { id: "db-groc" })).error, true, "trashed pages are hidden");
  assert.equal((await s.call("read_page", { id: "row-milk" })).error, true, "rows of trashed databases are hidden");

  assert.equal(fs.readFileSync(permFile, "utf8"), before);
  assert.equal(fs.statSync(permFile).mtimeMs, beforeStat);
  assert.equal(fs.readFileSync(path.join(dir, "outside.txt"), "utf8"), "do not touch");
  assert.ok(!fs.readdirSync(path.join(dir, "pages")).some((f) => f.endsWith(".tmp")), "no temp files left");
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), "no temp files left next to denotation.json");
  // denials and reads do not bump it
  const m3 = manifest();
  await s.call("update_page", { id: "doc-secret", title: "pwned" });
  await s.call("list_pages");
  assert.equal(manifest().rev, m3.rev);
});

test("path traversal and bad ids are rejected", async (t) => {
  const dir = fixture({ ...PERMS, broad: { read: "yes", create: "yes", edit: "yes", delete: "yes" } });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "denotation-outside-"));
  fs.writeFileSync(path.join(outside, "victim.json"), JSON.stringify({ id: "victim", type: "doc", title: "Outside", parentId: null }));
  // a symlinked page file pointing outside the folder must be ignored
  fs.symlinkSync(path.join(outside, "victim.json"), path.join(dir, "pages", "victim.json"));
  const s = startServer(dir);
  t.after(() => s.stop());
  for (const bad of ["../permissions", "../../etc/passwd", "a/b", "..", "x.json", "", "a".repeat(101), "id with space"]) {
    for (const [tool, args] of [["read_page", { id: bad }], ["update_page", { id: bad, title: "x" }], ["delete_row", { id: bad }], ["create_page", { title: "x", parentId: bad }], ["add_row", { databaseId: bad }]]) {
      const r = await s.call(tool, args);
      assert.equal(r.error, true, `${tool} ${bad}`);
    }
  }
  const list = await s.call("list_pages");
  assert.ok(!list.text.includes("Outside"), "symlinked file is not read");
  assert.equal((await s.call("update_page", { id: "victim", title: "pwned" })).error, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outside, "victim.json"), "utf8")).title, "Outside");
  assert.equal((await s.call("read_page", { id: 5 })).error, true);
  assert.equal((await s.call("update_page", { id: "doc-shared", title: 7 })).error, true);
  // symlinked rows/ directory is refused for writes
  fs.rmSync(path.join(dir, "rows"), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, "rows"));
  const r = await s.call("add_row", { databaseId: "db-groc", values: { Name: "x" } });
  assert.equal(r.error, true);
  assert.deepEqual(fs.readdirSync(outside), ["victim.json"]);
  assert.match(fs.readFileSync(path.join(dir, "permissions.json"), "utf8"), /"repo-open"/);
  // a symlinked denotation.json is never written through
  fs.writeFileSync(path.join(outside, "manifest.json"), "{}");
  fs.rmSync(path.join(dir, "denotation.json"));
  fs.symlinkSync(path.join(outside, "manifest.json"), path.join(dir, "denotation.json"));
  assert.equal((await s.call("update_page", { id: "doc-shared", title: "x" })).error, true);
  assert.equal(fs.readFileSync(path.join(outside, "manifest.json"), "utf8"), "{}");
});

test("--read-only hides and refuses write tools", async (t) => {
  const dir = fixture({ ...PERMS, broad: { read: "yes", create: "yes", edit: "yes", delete: "yes" } });
  const s = startServer(dir, ["--read-only"]);
  t.after(() => s.stop());
  const names = (await s.request("tools/list")).result.tools.map((x) => x.name).sort();
  assert.deepEqual(names, ["list_pages", "read_page", "search"]);
  const r = await s.request("tools/call", { name: "update_page", arguments: { id: "doc-shared", title: "x" } });
  assert.ok(r.error);
  assert.equal((await s.call("read_page", { id: "doc-diary" })).data.title, "Diary");
});

test("startup fails cleanly on a folder without a workspace", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "denotation-empty-"));
  const child = spawn(process.execPath, [SERVER, "--folder", dir], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 1);
  assert.equal(out, "");
  assert.match(err, /No Denotation workspace/);
});

// ---------- the app side: folder adapter over the real folder (a tiny FileSystemDirectoryHandle shim) ----------
function dirHandle(p) {
  const nf = () => Object.assign(new Error("NotFoundError"), { name: "NotFoundError" });
  const fileHandle = (fp) => ({
    kind: "file", name: path.basename(fp),
    getFile: async () => ({ text: async () => fs.readFileSync(fp, "utf8") }),
    createWritable: async () => {
      let buf = "";
      return { write: async (t) => { buf += t; }, close: async () => fs.writeFileSync(fp, buf) };
    }
  });
  return {
    kind: "directory", name: path.basename(p),
    async getDirectoryHandle(n, { create } = {}) {
      const q = path.join(p, n);
      if (!fs.existsSync(q)) { if (!create) throw nf(); fs.mkdirSync(q); }
      return dirHandle(q);
    },
    async getFileHandle(n, { create } = {}) {
      const q = path.join(p, n);
      if (!fs.existsSync(q)) { if (!create) throw nf(); fs.writeFileSync(q, ""); }
      return fileHandle(q);
    },
    async removeEntry(n) {
      const q = path.join(p, n);
      if (!fs.existsSync(q)) throw nf();
      fs.rmSync(q);
    },
    async *entries() {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) yield [e.name, e.isDirectory() ? dirHandle(path.join(p, e.name)) : fileHandle(path.join(p, e.name))];
    }
  };
}

test("end to end: the app's folder sync picks up MCP writes and deletes; app writes permissions.json", async (t) => {
  const { createMemoryAdapter } = await import("../../source/app/js/adapters/memory.js");
  const { createFolderAdapter } = await import("../../source/app/js/adapters/folder.js");
  const { savePermissions, syncPermissions } = await import("../../source/app/js/adapters/folderPermissions.js");
  const dir = fixture(null);
  const app = createFolderAdapter(createMemoryAdapter(), { debounceMs: 1 });
  await app.connect(dirHandle(dir));
  assert.equal((await app.list("rows")).length, 2);

  // The app saves permissions; the MCP server reads them.
  const saved = await savePermissions(app, PERMS);
  assert.equal(saved.folder, "saved");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "permissions.json"), "utf8")).pages["repo-open"].read, "yes");
  assert.equal((await syncPermissions(app)).updatedAt, saved.perms.updatedAt);

  const s = startServer(dir);
  t.after(() => s.stop());
  const made = await s.call("add_row", { databaseId: "db-groc", values: { Name: "Tea" } });
  assert.equal(made.error, false, made.text);
  assert.equal((await s.call("update_page", { id: "doc-shared", title: "Renamed by AI" })).error, false);
  assert.equal((await s.call("delete_row", { id: "row-milk" })).error, false);

  let remote = 0;
  app.onRemoteChange(() => remote++);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "denotation.json"), "utf8")).writer.startsWith("mcp-"), true);
  assert.deepEqual((await app.checkNow()).pulled, true, "the bumped stamp makes the app's check pull");
  assert.equal(remote, 1);
  assert.equal((await app.checkNow()).pulled, false, "unchanged stamp: no pull");
  assert.equal((await app.get("pages", "doc-shared")).title, "Renamed by AI");
  assert.ok(await app.get("rows", made.data.created.id));
  assert.equal(await app.get("rows", "row-milk"), null, "row deleted by the assistant is not pushed back");
  await app.flush();
  assert.ok(!fs.existsSync(path.join(dir, "rows", "row-milk.json")));
  // A row the app changed after the deletion wins and is written back.
  await app.set("rows", "row-eggs", { ...(await app.get("rows", "row-eggs")), updatedAt: Date.now() + 1000 });
  await app.flush();
  assert.ok(fs.existsSync(path.join(dir, "rows", "row-eggs.json")));
});

test("embedded images survive a read -> update round trip", async (t) => {
  const dir = fixture({ ...PERMS, broad: { read: "yes", create: "no", edit: "yes", delete: "no" } });
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const file = path.join(dir, "pages", "doc-diary.json");
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  rec.blocks.push({ id: "img-1", type: "image", src: png, caption: "Cat" });
  fs.writeFileSync(file, JSON.stringify(rec));
  const s = startServer(dir);
  t.after(() => s.stop());
  const read = await s.call("read_page", { id: "doc-diary" });
  assert.match(read.data.markdown, /!\[Cat\]\(embedded:img-1\)/);
  assert.ok(!read.text.includes("base64"));
  const upd = await s.call("update_page", { id: "doc-diary", markdown: `New first line\n\n${read.data.markdown}` });
  assert.equal(upd.error, false, upd.text);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  const img = after.blocks.find((b) => b.type === "image");
  assert.equal(img.src, png);
  assert.equal(img.caption, "Cat");
});

test("an encrypted folder is refused clearly; nothing is read as data or written", async (t) => {
  const dir = fixture({ ...PERMS, broad: { read: "yes", create: "yes", edit: "yes", delete: "yes" } });
  const s = startServer(dir);
  t.after(() => s.stop());
  const ok = await s.call("list_pages");
  assert.equal(ok.error, false, "plain folder works");
  // the app turns encryption on while the server runs: marker first, then envelopes
  const man = JSON.parse(fs.readFileSync(path.join(dir, "denotation.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "denotation.json"), JSON.stringify({ ...man, encrypted: true, keyId: "a".repeat(24), encryption: { state: "encrypting", startedAt: NOW } }));
  fs.writeFileSync(path.join(dir, "pages", "doc-shared.json"), JSON.stringify({ "denotation-enc": 1, kid: "a".repeat(24), iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" }));
  const snapshot = () => JSON.stringify(fs.readdirSync(dir, { recursive: true }).sort().map((f) => [f, fs.statSync(path.join(dir, f)).isFile() ? fs.readFileSync(path.join(dir, f), "utf8") : ""]));
  const before = snapshot();
  for (const [name, args] of [["list_pages", {}], ["search", { query: "Hello" }], ["read_page", { id: "doc-shared" }], ["create_page", { parentId: "repo-open", title: "Leak" }], ["update_row", { id: "row-milk", values: { Qty: 3 } }], ["delete_row", { id: "row-eggs" }]]) {
    const r = await s.call(name, args);
    assert.equal(r.error, true, name);
    assert.match(r.text, /folder is encrypted; the AI server can't read it/, name);
  }
  assert.equal(snapshot(), before, "nothing written");
  // marker cleared but still encrypted: still refused; an envelope without a manifest flag is never read as data
  fs.writeFileSync(path.join(dir, "denotation.json"), JSON.stringify({ ...man, encrypted: true }));
  assert.match((await s.call("list_pages")).text, /encrypted/);
  fs.writeFileSync(path.join(dir, "denotation.json"), JSON.stringify(man));
  assert.match((await s.call("list_pages")).text, /encrypted/);
});

test("archived pages are hidden from list_pages and search unless asked", async (t) => {
  const dir = fixture(PERMS);
  const rec = { id: "doc-arch", type: "doc", title: "Old plan", parentId: "repo-open", createdAt: NOW, updatedAt: NOW, archivedAt: NOW, props: [{ id: "p1", name: "Status", type: "text", value: "archived-status" }], blocks: [{ id: "b1", type: "p", text: "archived body" }] };
  fs.writeFileSync(path.join(dir, "pages", "doc-arch.json"), JSON.stringify(rec));
  const s = startServer(dir);
  t.after(() => s.stop());
  const list = await s.call("list_pages");
  assert.ok(!list.data.pages.some((p) => p.id === "doc-arch"));
  const all = await s.call("list_pages", { includeArchived: true });
  assert.equal(all.data.pages.find((p) => p.id === "doc-arch")?.archived, true);
  assert.deepEqual((await s.call("search", { query: "archived body" })).data.results, []);
  const hits = await s.call("search", { query: "archived-status", includeArchived: true });
  assert.deepEqual(hits.data.results.map((h) => [h.id, h.archived]), [["doc-arch", true]]);
  assert.equal((await s.call("list_pages", { includeArchived: "yes" })).error, true);
});
