import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../../source/app/js/adapters/memory.js";
import { createWorkspace } from "../../source/app/js/workspace.js";
import { newBlock, normalizeBlocks } from "../../source/app/js/blocks/model.js";
import { blocksToMarkdown } from "../../source/app/js/blocks/markdown.js";
import { buildToken, scanTokens } from "../../source/app/js/blocks/inline.js";
import { resolveValue } from "../../source/app/js/preview.js";
import { CATALOG } from "../../source/app/js/blocks/catalog.js";
import {
  sourceList, sourceLabel, tableData, tableSources, findTableSource, tableSourceId, isTableSourceId, isTableSource,
  resolveSource, setDataSource
} from "../../source/app/js/sources.js";

const db = (id, title, extra = {}) => ({ id, type: "database", title, parentId: "r", columns: [{ id: "n", name: "Name", type: "text" }], ...extra });
const doc = (id, title, blocks, extra = {}) => ({ id, type: "doc", title, parentId: "r", blocks, ...extra });
const repo = { id: "r", type: "repo", title: "Repo" };
const tbl = (cells, extra = {}) => ({ ...newBlock("table", { rows: cells.length, cols: cells[0].length }), cells, ...extra });

test("sourceList puts data sources first, keeps order inside each group, skips trashed and linked views", () => {
  const pages = [
    repo,
    db("a", "A"), db("b", "B", { dataSource: true }), db("c", "C"), db("d", "D", { dataSource: true }),
    db("t", "Trashed", { dataSource: true, trashedAt: 1 }),
    db("l", "Linked", { sourceId: "a" }),
    doc("x", "Doc", [])
  ];
  assert.deepEqual(sourceList(pages).map((p) => p.id), ["b", "d", "a", "c"]);
  assert.deepEqual(sourceList(pages, { linked: true }).map((p) => p.id), ["b", "d", "a", "c", "l"]);
  assert.deepEqual(sourceList([]), []);
  assert.deepEqual(sourceList(null), []);
});

test("sourceList does not accept a linked view as a data source", () => {
  const l = db("l", "L", { sourceId: "a", dataSource: true });
  assert.deepEqual(sourceList([repo, db("a", "A"), l]).map((p) => p.id), ["a"]);
  assert.equal(setDataSource(l, true).dataSource, true); // the flag helper only guards on type; pickers ignore linked views
  const p = db("z", "Z");
  setDataSource(p, true);
  assert.equal(p.dataSource, true);
  setDataSource(p, false);
  assert.equal("dataSource" in p, false);
});

test("table blocks: first row names the columns, duplicates and blanks are fixed, key column is clamped", () => {
  const b = tbl([["Item", "item", "", "Price"], ["Apple", "x", "y", "3"], ["Pear"]], { sourceKey: 9 });
  const t = tableData(b);
  assert.deepEqual(t.columns.map((c) => c.name), ["Item", "item 2", "Column 3", "Price"]);
  assert.deepEqual(t.columns.map((c) => c.id), ["c0", "c1", "c2", "c3"]);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[1].values.c3, "");
  assert.equal(t.keyIndex, 0);
  assert.equal(tableData({ cells: [["A", "B"], ["1", "2"]], sourceKey: 1 }).keyIndex, 1);
  assert.deepEqual(tableData({}).columns.map((c) => c.name), ["Column 1"]);
});

test("only a named, marked table block is a table source; ids are token-safe", () => {
  const ok = tbl([["A"], ["1"]], { dataSource: true, sourceName: "Prices" });
  assert.equal(isTableSource(ok), true);
  assert.equal(isTableSource({ ...ok, dataSource: false }), false);
  assert.equal(isTableSource({ ...ok, sourceName: "  " }), false);
  assert.equal(isTableSource({ ...ok, type: "p" }), false);
  const id = tableSourceId(ok.id);
  assert.equal(isTableSourceId(id), true);
  assert.equal(isTableSourceId("tbl-"), false);
  assert.equal(isTableSourceId("abc"), false);
  assert.ok(id.length <= 64);
  assert.ok(buildToken("value", [id, "Pear", "c1"]), "usable in a {{value}} chip");
});

test("tableSources and sourceList include virtual read-only databases after the real ones", () => {
  const t = tbl([["Item", "Price"], ["Apple", "3"], ["Pear", "5"]], { dataSource: true, sourceName: "Prices", sourceKey: 0 });
  const inner = newBlock("toggle", { text: "x" });
  const t2 = tbl([["K"], ["v"]], { dataSource: true, sourceName: "Nested" });
  inner.children = [t2];
  const pages = [repo, db("a", "A"), doc("d1", "Dash", [newBlock("p"), t, inner]), doc("d2", "Gone", [tbl([["Z"], ["1"]], { dataSource: true, sourceName: "Hidden" })], { trashedAt: 5 })];
  const ts = tableSources(pages.filter((p) => !p.trashedAt)); // callers pass live pages; sourceList filters for itself
  assert.deepEqual(ts.map((x) => x.title), ["Prices", "Nested"]);
  assert.equal(ts[0].virtual, true);
  assert.equal(ts[0].pageId, "d1");
  assert.equal(sourceLabel(ts[0]), "Table: Prices on Dash");
  assert.equal(sourceLabel(pages[1]), "A");
  const list = sourceList(pages);
  assert.deepEqual(list.map((p) => p.id), ["a", ts[0].id, ts[1].id]);
  assert.equal(findTableSource(pages, ts[0].id).rows.length, 2);
  assert.equal(findTableSource(pages, "tbl-nope"), null);
  assert.equal(findTableSource(pages, "a"), null);
  assert.deepEqual(sourceList(pages, { tables: false }).map((p) => p.id), ["a"]);
});

test("a table source resolves chips like a database: by key column", () => {
  const t = tbl([["Item", "Price"], ["Apple", "3"], ["Pear", "5"]], { dataSource: true, sourceName: "Prices" });
  const [v] = tableSources([doc("d", "Dash", [t])]);
  const r = resolveValue(v, v.rows, "pear", "c1");
  assert.equal(r.state, "ok");
  assert.equal(r.text, "5");
  const byPrice = tableSources([doc("d", "Dash", [{ ...t, sourceKey: 1 }])])[0];
  assert.equal(resolveValue(byPrice, byPrice.rows, "5", "c0").text, "Pear");
  assert.equal(resolveValue(v, v.rows, "nobody", "c1").state, "norow");
  assert.ok(scanTokens(`{{value:${v.id}|Pear|c1}}`).length === 1);
});

test("resolveSource: ok, linked view -> data page, trashed and missing", () => {
  const a = db("a", "A");
  const l = db("l", "L", { sourceId: "a" });
  const pages = [repo, a, l, db("tr", "T", { trashedAt: 1 }), db("l2", "L2", { sourceId: "tr" }), db("l3", "L3", { sourceId: "zzz" })];
  assert.deepEqual([resolveSource(pages, "a").state, resolveSource(pages, "a").data.id], ["ok", "a"]);
  const lr = resolveSource(pages, "l");
  assert.deepEqual([lr.state, lr.host.id, lr.data.id], ["ok", "l", "a"]);
  assert.equal(resolveSource(pages, "tr").state, "trashed");
  assert.equal(resolveSource(pages, "l2").state, "trashed");
  assert.equal(resolveSource(pages, "l3").state, "missing");
  assert.equal(resolveSource(pages, "nope").state, "missing");
  const t = tbl([["A"], ["1"]], { dataSource: true, sourceName: "T" });
  const d = doc("d", "D", [t]);
  assert.equal(resolveSource([repo, d], tableSourceId(t.id)).state, "ok");
  assert.equal(resolveSource([repo, { ...d, trashedAt: 1 }], tableSourceId(t.id)).state, "trashed");
  assert.equal(resolveSource([repo], tableSourceId(t.id)).state, "missing");
  assert.equal(resolveSource([repo, doc("d", "D", [{ ...t, dataSource: false }])], tableSourceId(t.id)).state, "missing");
});

test("view block: registered, normalised, exported as a link line", () => {
  const entry = CATALOG.find((e) => e.id === "dbview");
  assert.equal(entry.label, "Database view");
  const b = entry.make({});
  assert.equal(b.type, "dbview");
  assert.equal(b.sourceId, null);
  const list = normalizeBlocks([{ id: "1", type: "dbview", sourceId: 5, viewId: "", view: "nope" }, { id: "2", type: "dbview", sourceId: "a", viewId: "v1", view: { type: "board" } }]);
  assert.equal(list[0].type, "dbview");
  assert.equal(list[0].sourceId, null);
  assert.equal("viewId" in list[0], false);
  assert.equal("view" in list[0], false);
  assert.equal(list[1].viewId, "v1");
  assert.equal(list[1].view.type, "board");
  assert.ok(list[1].view.id && list[1].view.name);
  assert.equal(blocksToMarkdown([list[1]], { pageTitle: () => "People" }), "Database view: People");
  assert.equal(blocksToMarkdown([list[1]], { pageLink: (id) => `[P ${id}](p.md)` }), "Database view: [P a](p.md)");
  assert.equal(blocksToMarkdown([{ id: "3", type: "dbview", sourceId: "tbl-x" }], {}), "Database view: table data source");
  assert.equal(blocksToMarkdown([list[0]], {}), "");
});

test("table block data-source fields survive normalisation and are dropped when invalid", () => {
  const good = { id: "1", type: "table", cells: [["A", "B"], ["1", "2"]], dataSource: true, sourceName: "  Prices ", sourceKey: 1 };
  const bad = { id: "2", type: "table", cells: [["A"], ["1"]], dataSource: "yes", sourceName: 5, sourceKey: 3 };
  const [g, x] = normalizeBlocks([good, bad]);
  assert.deepEqual([g.dataSource, g.sourceName, g.sourceKey], [true, "Prices", 1]);
  assert.deepEqual(["dataSource" in x, "sourceName" in x, "sourceKey" in x], [false, false, false]);
});

test("convert a table to a real database: text columns, rows, key column as primary key", async () => {
  const ws = createWorkspace(createMemoryAdapter());
  const r = await ws.createPage({ type: "repo", title: "R" });
  const t = tbl([["Item", "Price", "Note"], ["Apple", "3", "a"], ["Pear", "5", "b"], ["Fig", "", ""]], { sourceKey: 1, sourceName: "Prices", dataSource: true });
  const { db: made, rows } = await ws.createDatabaseFromTable({ block: t, title: "Prices", parentId: r.id });
  assert.equal(rows, 3);
  assert.equal(made.type, "database");
  assert.equal(made.parentId, r.id);
  assert.deepEqual(made.columns.map((c) => [c.name, c.type]), [["Item", "text"], ["Price", "text"], ["Note", "text"]]);
  assert.equal(made.primaryKey, made.columns[1].id);
  const list = await ws.listRows(made.id);
  assert.deepEqual(list.map((x) => x.values[made.columns[0].id]), ["Apple", "Pear", "Fig"]);
  assert.deepEqual(list.map((x) => x.values[made.columns[1].id]), ["3", "5", ""]);
  const stored = await ws.getPage(made.id);
  assert.equal(stored.columns.length, 3);
  // a view block can now point at it
  assert.equal(resolveSource(await ws.listPages(), made.id).state, "ok");
});
