import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceLinks, graphNodes, propValues, repoRules, cleanGraphRules, cleanAppearance, trimPositions } from "../../source/app/js/graph/workspaceLinks.js";
import { buildGraph } from "../../source/app/js/graph/model.js";
import { styleGraph } from "../../source/app/js/graph/style.js";
import { createMemoryAdapter } from "../../source/app/js/adapters/memory.js";
import { createWorkspace } from "../../source/app/js/workspace.js";

const B = (id, text) => ({ id, type: "p", text });
const P = (id, title, texts = [], extra = {}) => ({ id, title, type: "doc", updatedAt: 1, blocks: texts.map((t, i) => B(`${id}b${i}`, t)), ...extra });

test("link tracker: syncPages indexes once, re-reads only changed pages, drops removed ones", () => {
  const L = createWorkspaceLinks();
  const pages = [P("a", "A", ["{{link:b}} {{xlink:c}}"]), P("b", "B", ["{{link:a}}"]), P("c", "C")];
  assert.equal(L.syncPages(pages), 2);
  assert.deepEqual(L.backlinks("c"), [{ from: "a", hidden: true }]);
  assert.deepEqual(L.backlinks("a"), [{ from: "b", hidden: false }]);
  assert.equal(L.syncPages(pages), 0, "unchanged stamps: nothing re-read");
  // an edit that did not bump updatedAt is not seen by sync (saves call updatePage directly)
  pages[0].blocks[0].text = "{{link:c}}";
  assert.equal(L.syncPages(pages), 0);
  pages[0].updatedAt = 2;
  assert.equal(L.syncPages(pages), 1);
  assert.deepEqual(L.backlinks("c"), [{ from: "a", hidden: false }]);
  assert.deepEqual(L.backlinks("b"), []);
  assert.equal(L.syncPages(pages.slice(1)), 1, "a is gone: its outgoing links are dropped");
  assert.deepEqual(L.backlinks("c"), []);
});
test("link tracker: rows are separate and lazy", () => {
  const L = createWorkspaceLinks();
  L.syncPages([P("a", "A")]);
  assert.equal(L.rowsReady, false);
  L.setRows([{ id: "r1", dbId: "d", updatedAt: 1, blocks: [B("x", "see {{link:a}}")] }]);
  assert.equal(L.rowsReady, true);
  assert.ok(L.isRow("r1"));
  assert.deepEqual(L.backlinks("a"), [{ from: "r1", hidden: false }]);
  // pages sync never drops rows
  L.syncPages([P("a", "A")]);
  assert.deepEqual(L.backlinks("a"), [{ from: "r1", hidden: false }]);
  L.invalidateRows();
  assert.equal(L.rowsReady, false);
  L.setRows([]);
  assert.deepEqual(L.backlinks("a"), []);
});
test("workspace keeps ws.links current on save, delete and list", async () => {
  const ws = createWorkspace(createMemoryAdapter());
  const a = await ws.createPage({ title: "A" });
  const b = await ws.createPage({ title: "B" });
  a.blocks = [B("x1", `go {{link:${b.id}}}`)];
  await ws.savePage(a);
  assert.deepEqual(ws.links.backlinks(b.id), [{ from: a.id, hidden: false }]);
  const db = await ws.createPage({ type: "database", title: "D" });
  const row = await ws.createRow(db);
  row.blocks = [B("x2", `{{xlink:${b.id}}}`)];
  await ws.saveRow(row);
  assert.deepEqual(ws.links.backlinks(b.id).map((l) => l.from).sort(), [a.id, row.id].sort());
  await ws.deleteRow(row.id);
  assert.deepEqual(ws.links.backlinks(b.id), [{ from: a.id, hidden: false }]);
  await ws.deletePage(a.id);
  assert.deepEqual(ws.links.backlinks(b.id), []);
  await ws.ensureLinkRows();
  assert.equal(ws.links.rowsReady, true);
});

test("graphNodes: live pages with repo, props, tags and appearance; rows by column name", () => {
  const pages = [
    { id: "r", type: "repo", title: "Repo", parentId: null },
    { id: "p", type: "doc", title: "P", parentId: "r", props: [{ name: "Status", type: "select", value: "Done" }, { name: "Tags", type: "multi", value: ["x", "y"] }], graph: { color: "green" } },
    { id: "t", type: "doc", title: "Trashed", parentId: "r", trashedAt: 5 },
    { id: "tk", type: "doc", title: "Kid of trashed", parentId: "t" },
    { id: "tp", type: "doc", title: "Template", parentId: "r", template: true },
    { id: "s", type: "sync", title: "" },
    { id: "d", type: "database", title: "D", parentId: "r", columns: [{ id: "c1", name: "Name" }, { id: "c2", name: "Kind" }] }
  ];
  const rows = [{ id: "row1", dbId: "d", values: { c1: "Ada", c2: "Person" } }, { id: "orphan", dbId: "gone", values: {} }];
  const n = graphNodes(pages, rows);
  assert.deepEqual(n.map((x) => x.id), ["r", "p", "d", "row1"]);
  const p = n.find((x) => x.id === "p");
  assert.equal(p.repo, "r");
  assert.deepEqual(p.props, { Status: "Done", Tags: ["x", "y"] });
  assert.deepEqual(p.tags, ["x", "y"]);
  assert.deepEqual(p.graph, { color: "green" });
  const r = n.find((x) => x.id === "row1");
  assert.deepEqual(r, { id: "row1", title: "Ada", kind: "row", repo: "r", db: "d", props: { Name: "Ada", Kind: "Person" } });
  assert.deepEqual(propValues(null), { props: {}, tags: null });
});
test("rows join the graph only through normal links, x-links do not count", () => {
  const pages = [{ id: "a", type: "doc", title: "A" }, { id: "d", type: "database", title: "D", columns: [{ id: "c", name: "Name" }] }];
  const rows = [{ id: "r1", dbId: "d", values: { c: "one" }, blocks: [B("q", "{{link:a}}")] }, { id: "r2", dbId: "d", values: { c: "two" }, blocks: [B("q2", "{{xlink:a}}")] }, { id: "r3", dbId: "d", values: { c: "three" } }];
  const L = createWorkspaceLinks();
  L.syncPages(pages);
  L.setRows(rows);
  const data = { pages: graphNodes(pages, rows), linkIndex: L.index };
  assert.deepEqual(buildGraph(data, {}).nodes.map((x) => x.id).sort(), ["a", "d", "r1"]);
  assert.deepEqual(buildGraph(data, { includeDbs: ["d"] }).nodes.map((x) => x.id).sort(), ["a", "d", "r1", "r2", "r3"]);
});
test("repo rules apply to their own repository only; appearance beats rules", () => {
  const repos = [{ id: "r1", graphRules: [{ when: [{ prop: "Status", op: "is", value: "Done" }], color: "green" }] }, { id: "r2", graphRules: [{ when: { field: "type", op: "is", value: "page" }, icon: "user", size: 2 }] }];
  const rules = repoRules(repos);
  assert.equal(rules.length, 2);
  const g = {
    nodes: [
      { id: "a", kind: "page", repo: "r1", props: { Status: "Done" } },
      { id: "b", kind: "page", repo: "r2", props: { Status: "Done" } },
      { id: "c", kind: "page", repo: "r1", props: { Status: "Done" }, graph: { color: "red" } }
    ],
    degree: new Uint32Array(3)
  };
  const s = styleGraph(g, rules);
  assert.deepEqual(s.color[0], { hue: 145 });
  assert.equal(s.icon[1], "icon:user");
  assert.equal(s.color[1], null);
  assert.deepEqual(s.color[2], { hue: 25 });
});
test("cleanGraphRules / cleanAppearance keep only valid, bounded settings", () => {
  const out = cleanGraphRules([
    { when: { prop: " Status ", op: "is", value: "Done" }, color: "green", icon: "check" },
    { when: { field: "nope" }, color: "red" },
    { when: { field: "type", op: "bogus", value: "page" }, size: 99 },
    { when: { field: "title", op: "empty", value: "ignored" } },
    null,
    "x"
  ]);
  assert.deepEqual(out, [
    { when: [{ prop: "Status", op: "is", value: "Done" }], icon: "check", color: "green" },
    { when: [{ field: "type", op: "is", value: "page" }], size: 6 }
  ]);
  assert.equal(cleanGraphRules(Array.from({ length: 60 }, () => ({ when: { field: "type", value: "page" }, color: "red" }))).length, 40);
  assert.deepEqual(cleanAppearance({ icon: " star ", color: 300, size: "1" }), { icon: "star", color: 300 });
  assert.equal(cleanAppearance({ icon: "", color: "", size: null }), null);
  assert.equal(cleanAppearance(null), null);
});
test("trimPositions keeps the newest graphs within the budgets, rounded", () => {
  const store = {};
  for (let k = 0; k < 10; k++) {
    const p = {};
    for (let i = 0; i < 1000; i++) p[`n${i}`] = [i + 0.4, -i - 0.6];
    store[`g${k}`] = { t: k, p };
  }
  store.bad = "x";
  const t = trimPositions(store, { maxKeys: 6, maxEntries: 2500 });
  assert.deepEqual(Object.keys(t), ["g9", "g8", "g7"]);
  assert.equal(Object.keys(t.g9.p).length, 1000);
  assert.equal(Object.keys(t.g7.p).length, 500);
  assert.deepEqual(t.g9.p.n3, [3, -4]);
});
test("perf: 1500 pages x 20 links index fast; one save re-reads one page", () => {
  const N = 1500;
  const pages = Array.from({ length: N }, (_, i) => P(`p${i}`, `Page ${i}`, Array.from({ length: 4 }, (_, j) => Array.from({ length: 5 }, (_, k) => `{{link:p${(i * 7 + j * 5 + k * 13 + 1) % N}}} text`).join(" "))));
  const L = createWorkspaceLinks();
  let t = performance.now();
  L.syncPages(pages);
  const full = performance.now() - t;
  t = performance.now();
  for (let r = 0; r < 20; r++) L.syncPages(pages);
  const resync = (performance.now() - t) / 20;
  t = performance.now();
  for (let r = 0; r < 100; r++) {
    pages[r].blocks[0].text += ` {{link:p${r + 1}}}`;
    pages[r].updatedAt = 10 + r;
    L.updatePage(pages[r]);
  }
  const save = (performance.now() - t) / 100;
  t = performance.now();
  const g = buildGraph({ pages: graphNodes(pages), linkIndex: L.index }, {});
  const build = performance.now() - t;
  assert.equal(g.nodes.length, N);
  assert.ok(full < 1500, `full index ${full.toFixed(0)} ms`);
  assert.ok(resync < 15, `unchanged re-sync ${resync.toFixed(2)} ms`);
  assert.ok(save < 2, `one save ${save.toFixed(3)} ms`);
  assert.ok(build < 400, `graph build ${build.toFixed(0)} ms`);
});

test("vault Markdown: links export as [[Title]] / x[[Title]] and import back as link tokens", async () => {
  const { toMarkdownFiles, importFiles } = await import("../../source/app/js/vault.js");
  const ws = createWorkspace(createMemoryAdapter());
  const repo = await ws.createPage({ type: "repo", title: "R" });
  const b = await ws.createPage({ title: "Beta", parentId: repo.id });
  b.blocks = [{ id: "hb", type: "h2", text: "Part" }, B("pb", "body")];
  await ws.savePage(b);
  const a = await ws.createPage({ title: "Alpha", parentId: repo.id });
  a.blocks = [B("x1", `see {{link:${b.id}}} and {{xlink:${b.id}}}`), B("x2", `{{embed:${b.id}|h|hb}}`)];
  await ws.savePage(a);
  const files = toMarkdownFiles({ pages: await ws.listPages(), rows: [] });
  const md = files.find((f) => f.path.endsWith("Alpha.md")).data;
  assert.ok(md.includes("see [[Beta]] and x[[Beta]]"), md);
  assert.ok(md.includes("![[Beta#Part]]"), md);
  const ws2 = createWorkspace(createMemoryAdapter());
  await importFiles(ws2, files, { name: "Back" });
  const pages = await ws2.listPages();
  const beta = pages.find((p) => p.title === "Beta");
  const alpha = pages.find((p) => p.title === "Alpha");
  assert.equal(alpha.blocks[0].text, `see {{link:${beta.id}}} and {{xlink:${beta.id}}}`);
  assert.equal(alpha.blocks[1].text, `{{link:${beta.id}}}`);
  assert.deepEqual(ws2.links.backlinks(beta.id), [{ from: alpha.id, hidden: false }]);
});
