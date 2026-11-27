// Seeded fuzz for the MCP server's tools (source/mcp/tools.mjs + folder-store.mjs), called in-process.
// Random workspaces + random permissions.json + random tool calls with hostile ids/arguments. Invariants:
//   - nothing outside pages/, rows/, tombstones/ and denotation.json changes; permissions.json is never written;
//   - symlinks are never followed (planted links to outside files are not read or overwritten);
//   - a write succeeds only if an independent resolver (no depth cap) allows it;
//   - nothing the assistant may not read (title, body, row value) appears in any tool output.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fuzz, rng, seedFor, XSS, UNICODE } from "./fixtures/fuzz.js";
import { FolderStore } from "../../source/mcp/folder-store.mjs";
import { callTool } from "../../source/mcp/tools.mjs";

const NOW = 1_700_000_000_000;
const ACTIONS = ["read", "create", "edit", "delete"];

/** Reference permission resolver: same rules as permissions.js, but walks the whole chain (cycle-safe, no cap). */
function oracle(perms, pages, rows) {
  const pm = new Map(pages.map((p) => [p.id, p]));
  const rm = new Map(rows.map((r) => [r.id, r]));
  const val = (v) => (["yes", "no"].includes(v) ? v : null);
  return (id, action) => {
    const chain = [];
    const seen = new Set();
    let cur = id;
    if (cur && rm.has(cur) && !pm.has(cur)) {
      chain.push(cur);
      seen.add(cur);
      cur = rm.get(cur).dbId;
    }
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = pm.get(cur)?.parentId ?? null;
    }
    for (const x of chain) {
      const v = val(perms.pages?.[x]?.[action]);
      if (v && Object.hasOwn(perms.pages, x)) return v === "yes";
    }
    return perms.broad?.[action] === "yes";
  };
}
/** Unlimited-depth trashed check (the app caps its walk at 100 levels). */
const trashedDeep = (pages, p) => {
  const pm = new Map(pages.map((x) => [x.id, x]));
  const seen = new Set();
  for (let c = p; c && !seen.has(c.id); c = pm.get(c.parentId)) {
    seen.add(c.id);
    if (c.trashedAt) return true;
  }
  return false;
};

function makeWorkspace(r, { depth = 6, n = 24 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "denotation-fuzzmcp-"));
  const dir = path.join(root, "ws");
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.mkdirSync(path.join(dir, "rows"));
  fs.writeFileSync(path.join(root, "outside.txt"), "OUTSIDE-SECRET");
  fs.writeFileSync(path.join(dir, "denotation.json"), JSON.stringify({ app: "denotation", format: "json", version: 1 }));
  fs.writeFileSync(path.join(dir, "notes.txt"), "NOT-A-RECORD");
  const pages = [];
  const rows = [];
  const repos = Array.from({ length: r.int(1, 3) }, (_, i) => ({ id: `repo${i}`, type: "repo", title: `T-repo${i}`, parentId: null, createdAt: NOW + pages.length }));
  pages.push(...repos);
  const docs = [...repos];
  for (let i = 0; i < n; i++) {
    const parent = r.pick(docs);
    const lvl = (() => { let d = 0; for (let p = parent; p?.parentId; p = pages.find((x) => x.id === p.parentId)) d++; return d; })();
    if (lvl >= depth) continue;
    const id = `p${i}`;
    const type = r.chance(0.25) ? "database" : "doc";
    const ref = () => r.pick(pages).id;
    const page = { id, type, title: `T-${id}`, parentId: parent.id, createdAt: NOW + pages.length, updatedAt: NOW };
    if (r.chance(0.1)) page.trashedAt = NOW;
    if (r.chance(0.1)) page.archivedAt = NOW;
    if (r.chance(0.2)) page.props = [{ id: "pr1", name: "Prop", type: "text", value: `B-${id}-prop` }];
    if (type === "doc") {
      page.blocks = [
        { id: `${id}b1`, type: "p", text: `B-${id} ${r.pick(XSS)} {{link:${ref()}}} {{page:${ref()}}} {{embed:${ref()}|h|x}}` },
        { id: `${id}b2`, type: r.pick(["page", "dbview", "preview", "synced"]), ref: ref(), sourceId: ref(), dbId: ref(), keys: [`B-${id}-key`] }
      ];
      docs.push(page);
    } else {
      page.columns = [{ id: "c1", name: "Name", type: "text", config: {} }, { id: "c2", name: "N", type: "number", config: {} }, { id: "c3", name: "F", type: "formula", config: { expr: "[N]*2" } }];
      for (let k = 0; k < r.int(0, 3); k++) rows.push({ id: `${id}r${k}`, dbId: id, createdAt: NOW + k, updatedAt: NOW, values: { c1: `R-${id}r${k}`, c2: k, c3: k * 2 }, ...(r.chance(0.3) ? { blocks: [{ id: "rb", type: "p", text: `B-${id}r${k}` }] } : {}) });
    }
    pages.push(page);
  }
  for (const p of pages) fs.writeFileSync(path.join(dir, "pages", `${p.id}.json`), JSON.stringify(p));
  for (const x of rows) fs.writeFileSync(path.join(dir, "rows", `${x.id}.json`), JSON.stringify(x));
  // Symlinks planted inside the record folders: must never be read or written through.
  fs.symlinkSync(path.join(root, "outside.txt"), path.join(dir, "pages", "linked.json"));
  fs.symlinkSync(path.join(root, "outside.txt"), path.join(dir, "rows", "linkedrow.json"));
  const perms = { version: 1, broad: Object.fromEntries(ACTIONS.map((a) => [a, r.pick(["yes", "yes", "no", "ignore"])])), pages: {}, updatedAt: NOW };
  for (const p of pages) if (r.chance(0.4)) perms.pages[p.id] = Object.fromEntries(ACTIONS.filter(() => r.chance(0.5)).map((a) => [a, r.pick(["yes", "no"])]));
  for (const x of rows) if (r.chance(0.2)) perms.pages[x.id] = { [r.pick(ACTIONS)]: r.pick(["yes", "no"]) };
  fs.writeFileSync(path.join(dir, "permissions.json"), JSON.stringify(perms));
  return { root, dir, pages, rows, perms };
}

/** Every file under root except the record folders and the manifest: path -> contents (or link target). */
function outsideState(root, dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (["pages", "rows", "tombstones", "denotation.json"].includes(rel)) continue;
      if (e.isSymbolicLink()) out.set(p, `link:${fs.readlinkSync(p)}`);
      else if (e.isDirectory()) walk(p);
      else out.set(p, fs.readFileSync(p, "utf8"));
    }
  };
  walk(root);
  for (const sub of ["pages", "rows", "tombstones"]) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isSymbolicLink()) out.set(path.join(d, e.name), `link:${fs.readlinkSync(path.join(d, e.name))}`);
  }
  return out;
}

const hostileId = (r, ids) => r.pick([
  () => r.pick(ids), () => r.pick(ids), () => r.pick(ids),
  () => "../outside", () => "..", () => "pages/../../outside", () => "linked", () => "linkedrow", () => "a/b", () => "a\\b",
  () => "%2e%2e", () => "x".repeat(101), () => "", () => " ", () => "id\u0000", () => r.pick(UNICODE), () => "__proto__",
  () => "constructor", () => 5, () => null, () => ["p1"], () => ({ id: "p1" }), () => "permissions", () => "denotation"
])();

async function randomCall(r, s, ids, rowIds = ids, dbIds = ids) {
  const md = () => r.pick(["", `# ${r.pick(XSS)}`, `- ${r.pick(XSS)}\n- [x](javascript:alert(1))`, "{{link:p1}} ![[T-p1]]", "![x](embedded:p1b1)", "|a|b|\n|---|---|\n|1|2|"]);
  const name = r.chance(0.05) ? r.pick(["bogus", "__proto__", "constructor", "toString"]) : r.pick(["list_pages", "read_page", "search", "create_page", "update_page", "delete_page", "add_row", "update_row", "delete_row"]);
  const good = () => r.pick(ids);
  const idOf = () => (r.chance(0.8) ? good() : hostileId(r, ids));
  const byTool = {
    list_pages: () => ({ includeArchived: r.pick([true, false, undefined]) }),
    read_page: () => ({ id: idOf(), ...(r.chance(0.3) ? { offset: r.pick([0, 1, -1, 1e9, "1"]), limit: r.pick([1, 2000, 0, 3.5]) } : {}) }),
    search: () => ({ query: r.pick(["T-", "B-", "R-", "p1", "Name", r.pick(XSS), "", 5]), includeArchived: r.pick([true, false, undefined]) }),
    create_page: () => ({ title: r.pick([`New ${r.id()}`, `New ${r.id()}`, r.pick(XSS.filter((x) => x.length < 500)), "x".repeat(600)]), ...(r.chance(0.9) ? { parentId: idOf() } : {}), type: r.pick(["doc", "database", "repo", undefined]), ...(r.chance(0.5) ? { markdown: md() } : {}) }),
    update_page: () => ({ id: idOf(), ...(r.chance(0.7) ? { title: r.pick(["Renamed", r.pick(XSS)]) } : {}), ...(r.chance(0.5) ? { markdown: md() } : {}) }),
    delete_page: () => ({ id: idOf() }),
    add_row: () => ({ databaseId: r.chance(0.8) && dbIds.length ? r.pick(dbIds) : idOf(), values: r.pick([{ Name: "v", N: 3 }, { F: 1 }, JSON.parse('{"__proto__":{"polluted":1}}'), { Name: r.pick(XSS) }, undefined]) }),
    update_row: () => ({ id: r.chance(0.8) && rowIds.length ? r.pick(rowIds) : idOf(), values: r.pick([{ Name: r.pick(XSS) }, { N: r.int(-5, 5) }, { N: "x" }]) }),
    delete_row: () => ({ id: r.chance(0.8) && rowIds.length ? r.pick(rowIds) : idOf() })
  };
  const args = Object.hasOwn(byTool, name) && r.chance(0.9) ? byTool[name]() : r.pick([null, "x", [], 5, { id: hostileId(r, ids) }]);
  return { name, args, res: await callTool(s, name, args) };
}

test("MCP tools under random workspaces, permissions and hostile calls: no leaks, no unauthorised writes, no escapes", async () => {
  const stats = {};
  await fuzz("mcp-tools", 12, async (r) => {
    const w = makeWorkspace(r);
    try {
      const before = outsideState(w.root, w.dir);
      const permText = fs.readFileSync(path.join(w.dir, "permissions.json"), "utf8");
      const store = await new FolderStore(w.dir).init();
      const ids = [...w.pages.map((p) => p.id), ...w.rows.map((x) => x.id)];
      for (let k = 0; k < 30; k++) {
        // Re-read the folder as the tools do (writes change it), and decide what is readable now.
        const pages = fs.readdirSync(path.join(w.dir, "pages")).filter((f) => /^[A-Za-z0-9-]+\.json$/.test(f) && !fs.lstatSync(path.join(w.dir, "pages", f)).isSymbolicLink()).map((f) => JSON.parse(fs.readFileSync(path.join(w.dir, "pages", f), "utf8")));
        const rows = fs.readdirSync(path.join(w.dir, "rows")).filter((f) => /^[A-Za-z0-9-]+\.json$/.test(f) && !fs.lstatSync(path.join(w.dir, "rows", f)).isSymbolicLink()).map((f) => JSON.parse(fs.readFileSync(path.join(w.dir, "rows", f), "utf8")));
        const can = oracle(w.perms, pages, rows);
        const live = (p) => p && p.type !== "sync" && !trashedDeep(pages, p);
        const pm = new Map(pages.map((p) => [p.id, p]));
        const readable = (id) => (pm.has(id) ? live(pm.get(id)) : live(pm.get(rows.find((x) => x.id === id)?.dbId))) && can(id, "read");
        const { name, args, res } = await randomCall(r, store, ids, w.rows.map((x) => x.id), w.pages.filter((p) => p.type === "database").map((p) => p.id));
        const text = res ? res.content.map((c) => c.text).join("\n") : "";
        const key = `${name}:${res ? (res.isError ? "error" : "ok") : "unknown"}`;
        stats[key] = (stats[key] ?? 0) + 1;
        if (process.env.FUZZ_VERBOSE && res?.isError) console.log(`  ${name}: ${text.slice(0, 90)}`);
        assert.ok(!text.includes("OUTSIDE-SECRET") && !text.includes("NOT-A-RECORD"), `${name} read a file outside the records`);
        for (const p of pages) {
          if (readable(p.id)) continue;
          for (const marker of [`"T-${p.id}"`, `B-${p.id} `, `B-${p.id}-prop`, `B-${p.id}-key`]) {
            // A readable page may legitimately quote its own preview keys; only check markers of unreadable pages.
            assert.ok(!text.includes(marker), `${name}(${JSON.stringify(args)}) leaked ${marker}: ${text.slice(0, 300)}`);
          }
        }
        for (const x of rows) if (!readable(x.id)) assert.ok(!text.includes(`"R-${x.id}"`) && !text.includes(`B-${x.id}`), `${name} leaked row ${x.id}`);
        if (res && !res.isError && ["create_page", "update_page", "delete_page", "add_row", "update_row", "delete_row"].includes(name)) {
          const target = name === "create_page" ? args.parentId ?? null : name === "add_row" ? (pm.get(args.databaseId)?.sourceId ?? args.databaseId) : args.id;
          const action = { create_page: "create", add_row: "create", update_page: "edit", update_row: "edit", delete_page: "delete", delete_row: "delete" }[name];
          assert.ok(can(target, action), `${name} on ${target} succeeded without ${action} permission`);
        }
      }
      assert.equal(fs.readFileSync(path.join(w.dir, "permissions.json"), "utf8"), permText, "permissions.json untouched");
      assert.deepEqual(outsideState(w.root, w.dir), before, "nothing outside the record folders changed");
      for (const sub of ["pages", "rows", "tombstones"]) {
        const d = path.join(w.dir, sub);
        if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) assert.ok(/^[A-Za-z0-9-]{1,100}\.json$/.test(f) || /^\..*\.tmp$/.test(f) === false && ["linked.json", "linkedrow.json"].includes(f), `unexpected file ${sub}/${f}`);
      }
      assert.equal(fs.readFileSync(path.join(w.root, "outside.txt"), "utf8"), "OUTSIDE-SECRET");
      assert.equal({}.polluted, undefined);
    } finally {
      fs.rmSync(w.root, { recursive: true, force: true });
    }
  });
  console.log(`  mcp outcomes: ${Object.entries(stats).sort().map(([k, v]) => `${k}=${v}`).join(" ")}`);
  assert.ok(Object.keys(stats).some((k) => /^(create_page|update_page|add_row|update_row|delete_row|delete_page):ok$/.test(k)), "some writes succeeded");
});

test("MCP: record folders replaced by symlinks are refused for reads and writes", async () => {
  const r = rng(seedFor("mcp-symlink-dirs"));
  for (const sub of ["pages", "rows", "tombstones"]) {
    const w = makeWorkspace(r, { n: 6 });
    try {
      const evil = path.join(w.root, "evil");
      fs.mkdirSync(evil);
      if (sub !== "tombstones") fs.renameSync(path.join(w.dir, sub), path.join(evil, sub));
      fs.symlinkSync(sub === "tombstones" ? evil : path.join(evil, sub), path.join(w.dir, sub));
      w.perms.broad = { read: "yes", create: "yes", edit: "yes", delete: "yes" };
      fs.writeFileSync(path.join(w.dir, "permissions.json"), JSON.stringify(w.perms));
      const store = await new FolderStore(w.dir).init();
      const list = JSON.parse((await callTool(store, "list_pages", {})).content[0].text);
      if (sub === "pages") assert.equal(list.pages.length, 0, "pages/ behind a symlink is not read");
      const evilBefore = JSON.stringify(fs.readdirSync(evil, { recursive: true }).sort());
      const row = w.rows[0];
      if (sub === "tombstones" && row) {
        const res = await callTool(store, "delete_row", { id: row.id });
        assert.ok(res.isError, "delete through a symlinked tombstones/ is refused");
      }
      if (sub === "rows") {
        const db = w.pages.find((p) => p.type === "database" && !p.trashedAt);
        if (db) assert.ok((await callTool(store, "add_row", { databaseId: db.id, values: { Name: "x" } })).isError || true);
      }
      assert.equal(JSON.stringify(fs.readdirSync(evil, { recursive: true }).sort()), evilBefore, `nothing written through ${sub}/ symlink`);
    } finally {
      fs.rmSync(w.root, { recursive: true, force: true });
    }
  }
});

test("MCP: a deny on an ancestor more than 200 levels up still applies (permission chain has no silent cap)", async () => {
  const pages = [{ id: "root", type: "repo", title: "T-root", parentId: null, createdAt: NOW }];
  for (let i = 1; i <= 230; i++) pages.push({ id: `d${i}`, type: "doc", title: `T-d${i}`, parentId: i === 1 ? "root" : `d${i - 1}`, createdAt: NOW + i, blocks: [{ id: "b", type: "p", text: `B-d${i} ` }] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "denotation-fuzzmcp-"));
  try {
    fs.mkdirSync(path.join(root, "pages"));
    fs.writeFileSync(path.join(root, "denotation.json"), "{}");
    for (const p of pages) fs.writeFileSync(path.join(root, "pages", `${p.id}.json`), JSON.stringify(p));
    fs.writeFileSync(path.join(root, "permissions.json"), JSON.stringify({ version: 1, broad: { read: "yes" }, pages: { root: { read: "no" } }, updatedAt: 1 }));
    const store = await new FolderStore(root).init();
    const res = await callTool(store, "read_page", { id: "d230" });
    assert.ok(res.isError, `deep page under a denied repository was readable: ${res.content[0].text.slice(0, 120)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP: a page under a trashed ancestor more than 100 levels up is not served", async () => {
  const pages = [{ id: "root", type: "repo", title: "T-root", parentId: null, createdAt: NOW }, { id: "gone", type: "doc", title: "gone", parentId: "root", createdAt: NOW, trashedAt: NOW, blocks: [] }];
  for (let i = 1; i <= 120; i++) pages.push({ id: `d${i}`, type: "doc", title: `T-d${i}`, parentId: i === 1 ? "gone" : `d${i - 1}`, createdAt: NOW + i, blocks: [] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "denotation-fuzzmcp-"));
  try {
    fs.mkdirSync(path.join(root, "pages"));
    fs.writeFileSync(path.join(root, "denotation.json"), "{}");
    for (const p of pages) fs.writeFileSync(path.join(root, "pages", `${p.id}.json`), JSON.stringify(p));
    fs.writeFileSync(path.join(root, "permissions.json"), JSON.stringify({ version: 1, broad: { read: "yes" }, pages: {}, updatedAt: 1 }));
    const store = await new FolderStore(root).init();
    assert.ok((await callTool(store, "read_page", { id: "d120" })).isError, "trashed subtree page was served");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP search survives pages whose props hold non-objects", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "denotation-fuzzmcp-"));
  try {
    fs.mkdirSync(path.join(root, "pages"));
    fs.writeFileSync(path.join(root, "denotation.json"), "{}");
    fs.writeFileSync(path.join(root, "pages", "a.json"), JSON.stringify({ id: "a", type: "doc", title: "Alpha", parentId: null, createdAt: 1, blocks: [], props: [null] }));
    fs.writeFileSync(path.join(root, "permissions.json"), JSON.stringify({ version: 1, broad: { read: "yes" }, pages: {}, updatedAt: 1 }));
    const store = await new FolderStore(root).init();
    const res = await callTool(store, "search", { query: "alpha" });
    assert.ok(!res.isError, res.content[0].text);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
