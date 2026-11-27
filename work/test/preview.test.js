import test from "node:test";
import assert from "node:assert/strict";
import {
  normKey, cleanKeys, splitKeys, primaryKeyCol, matchKeys, cleanConfig, resolveConfig, columnSelection, toggleColumn,
  moveColumn, patchColumn, alignOf, layoutOf, cleanPresets, newPreset, presetNameTaken, countPresetUsers, cleanBlock,
  previewMarkdown, previewLine
} from "../../source/app/js/preview.js";
import { newBlock, normalizeBlocks } from "../../source/app/js/blocks/model.js";
import { blocksToMarkdown } from "../../source/app/js/blocks/markdown.js";

const cols = [
  { id: "n", name: "Name", type: "text" },
  { id: "a", name: "Age", type: "number" },
  { id: "t", name: "Tags", type: "array", config: { itemType: "text" } },
  { id: "o", name: "OK", type: "checkbox" },
  { id: "x", name: "Extra", type: "text" }
];
const db = { id: "db1", type: "database", columns: cols };
const rows = [
  { id: "r1", dbId: "db1", values: { n: "Ada Lovelace", a: 36, t: ["x", "y"], o: true } },
  { id: "r2", dbId: "db1", values: { n: "  grace hopper ", a: 85 } },
  { id: "r3", dbId: "db1", values: { n: "Ada Lovelace", a: 1 } },
  { id: "r4", dbId: "db1", values: { n: "", a: 2 } }
];

test("key normalisation and cleaning", () => {
  assert.equal(normKey("  AbC "), "abc");
  assert.deepEqual(cleanKeys([" a ", "A", "", null, "b", "B "]), ["a", "b"]);
  assert.deepEqual(cleanKeys("nope"), []);
  assert.deepEqual(splitKeys("a, b;c\n d"), ["a", "b", "c", "d"]);
});

test("primary key defaults to the first column and honours primaryKey", () => {
  assert.equal(primaryKeyCol(db).id, "n");
  assert.equal(primaryKeyCol({ ...db, primaryKey: "a" }).id, "a");
  assert.equal(primaryKeyCol({ ...db, primaryKey: "gone" }).id, "n");
  assert.equal(primaryKeyCol({ columns: [] }), null);
});

test("matching: case, trim, misses, duplicates", () => {
  const m = matchKeys(db, rows, ["ADA lovelace ", "Grace Hopper", "nobody"]);
  assert.equal(m.length, 3);
  assert.deepEqual(m[0].rows.map((r) => r.id), ["r1", "r3"]);
  assert.equal(m[0].duplicate, true);
  assert.equal(m[1].rows[0].id, "r2");
  assert.equal(m[1].duplicate, false);
  assert.equal(m[2].missing, true);
  assert.equal(matchKeys(db, rows, [""]).length, 0);
});

test("matching on another primary key uses displayed text", () => {
  const m = matchKeys({ ...db, primaryKey: "a" }, rows, ["36", "85.0"]);
  assert.equal(m[0].rows[0].id, "r1");
  assert.equal(m[1].missing, true);
  const bools = matchKeys({ ...db, primaryKey: "o" }, rows, ["TRUE"]);
  assert.equal(bools[0].rows[0].id, "r1");
});

test("config sanitisation", () => {
  const c = cleanConfig({
    layout: "weird",
    columns: [
      { id: "n", width: 5, wrap: "yes", align: "center", label: "  Who  " },
      { id: "n" },
      { id: "gone" },
      { id: "a", width: 5000, wrap: true, align: "left" },
      { id: "t", width: "abc" },
      "junk"
    ]
  }, cols);
  assert.equal(c.layout, null);
  assert.deepEqual(c.columns.map((x) => x.id), ["n", "a", "t"]);
  assert.deepEqual(c.columns[0], { id: "n", width: 40, wrap: false, align: null, label: "Who" });
  assert.equal(c.columns[1].width, 800);
  assert.equal(c.columns[1].align, "left");
  assert.equal(c.columns[2].width, null);
  const empty = cleanConfig({ columns: [{ id: "gone" }] }, cols);
  assert.deepEqual(empty.columns.map((x) => x.id), ["n", "a", "t", "o"]);
  assert.equal(cleanConfig({ layout: "card" }, cols).layout, "card");
  assert.deepEqual(cleanConfig(null).columns, []);
});

test("column selection, toggle, move, patch", () => {
  let cfg = cleanConfig({ columns: [{ id: "a" }, { id: "n" }] }, cols);
  const sel = columnSelection(cfg, cols);
  assert.deepEqual(sel.map((s) => [s.col.id, s.shown]), [["a", true], ["n", true], ["t", false], ["o", false], ["x", false]]);
  cfg = toggleColumn(cfg, "x", true);
  assert.deepEqual(cfg.columns.map((c) => c.id), ["a", "n", "x"]);
  cfg = moveColumn(cfg, "x", -1);
  assert.deepEqual(cfg.columns.map((c) => c.id), ["a", "x", "n"]);
  assert.equal(moveColumn(cfg, "a", -1), cfg);
  cfg = patchColumn(cfg, "a", { width: 120, wrap: true, align: "right", label: "Years" });
  assert.deepEqual(cfg.columns[0], { id: "a", width: 120, wrap: true, align: "right", label: "Years" });
  const one = { layout: null, columns: [{ id: "a", width: null, wrap: false, align: null, label: "" }] };
  assert.equal(toggleColumn(one, "a", false), one, "never removes the last column");
});

test("alignment and layout defaults", () => {
  assert.equal(alignOf({ align: null }, cols[1]), "right");
  assert.equal(alignOf({ align: null }, cols[0]), "left");
  assert.equal(alignOf({ align: "left" }, cols[1]), "left");
  assert.equal(layoutOf({ layout: null }, 1), "card");
  assert.equal(layoutOf({ layout: null }, 2), "table");
  assert.equal(layoutOf({ layout: "table" }, 1), "table");
});

test("preset resolution: preset, snapshot fallback, own, default", () => {
  const preset = newPreset(" Short ", { layout: "table", columns: [{ id: "a", width: 100 }] }, cols);
  const withPreset = { ...db, previewPresets: [preset] };
  const own = { layout: "card", columns: [{ id: "x" }] };
  const snap = { layout: null, columns: [{ id: "t" }] };
  let r = resolveConfig({ presetId: preset.id, config: own, snapshot: snap }, withPreset);
  assert.equal(r.source, "preset");
  assert.equal(r.config.columns[0].width, 100);
  assert.equal(preset.name, "Short");
  r = resolveConfig({ presetId: preset.id, snapshot: snap }, db);
  assert.equal(r.source, "snapshot");
  assert.equal(r.orphan, true);
  assert.deepEqual(r.config.columns.map((c) => c.id), ["t"]);
  r = resolveConfig({ presetId: "gone", config: own }, db);
  assert.equal(r.source, "own");
  assert.equal(r.orphan, true);
  r = resolveConfig({ config: own }, db);
  assert.equal(r.source, "own");
  assert.equal(r.config.layout, "card");
  r = resolveConfig({}, db);
  assert.equal(r.source, "default");
  assert.equal(r.config.columns.length, 4);
  assert.equal(resolveConfig({}, null).config.columns.length, 0);
});

test("presets: cleaning, names, usage count", () => {
  const list = cleanPresets([{ id: "p1", name: "  ", columns: [{ id: "n" }] }, { id: "p1" }, { name: "no id" }, { id: "p2", name: "B", layout: "card" }], cols);
  assert.deepEqual(list.map((p) => [p.id, p.name]), [["p1", "Preset"], ["p2", "B"]]);
  assert.equal(presetNameTaken(list, " b "), true);
  assert.equal(presetNameTaken(list, "b", "p2"), false);
  const blocks = [
    { type: "preview", presetId: "p1" },
    { type: "toggle", children: [{ type: "preview", presetId: "p1" }, { type: "preview", presetId: "p2" }] },
    { type: "p" }
  ];
  assert.equal(countPresetUsers([blocks, [{ type: "preview", presetId: "p1" }]], "p1"), 3);
});

test("block model: defaults and normalisation", () => {
  const b = newBlock("preview");
  assert.deepEqual([b.dbId, b.keys, b.presetId, b.config, b.snapshot], [null, [], null, null, null]);
  const bad = { id: "z", type: "preview", dbId: 5, keys: ["a", "A", " "], presetId: "", config: "x", snapshot: { columns: [{ id: "n", width: 1 }] } };
  const [clean] = normalizeBlocks([bad]);
  assert.deepEqual([clean.dbId, clean.keys, clean.presetId, clean.config], [null, ["a"], null, null]);
  assert.equal(clean.snapshot.columns[0].width, 40);
  assert.equal(cleanBlock({ dbId: "d" }).keys.length, 0);
});

test("markdown export", () => {
  const b = { type: "preview", dbId: "db1", keys: ["ada lovelace", "zed"], presetId: null, config: { columns: [{ id: "n", label: "Who" }, { id: "a" }, { id: "t" }, { id: "o" }] } };
  const md = previewMarkdown(b, db, rows);
  assert.match(md, /^\| Who \| Age \| Tags \| OK \|\n\| --- \| --- \| --- \| --- \|\n\| Ada Lovelace \| 36 \| \[x, y\] \| Yes \|\n\| Ada Lovelace \| 1 \|/);
  assert.match(md, /No row with key: zed$/);
  assert.equal(previewMarkdown(b, null, rows), null);
  assert.equal(previewMarkdown({ ...b, keys: [] }, db, rows), null);
  assert.equal(previewLine("People", ["a", "b"]), "Record preview: People (keys: a, b)");
  const out = blocksToMarkdown([{ id: "1", type: "preview", dbId: "db1", keys: ["a", "b"] }], { pageTitle: () => "People" });
  assert.equal(out, "Record preview: People (keys: a, b)");
  assert.equal(blocksToMarkdown([b], { recordPreview: () => "TABLE" }), "TABLE");
});

test("vault Markdown export resolves the block against rows", async () => {
  const { createMemoryAdapter } = await import("../../source/app/js/adapters/memory.js");
  const { createWorkspace } = await import("../../source/app/js/workspace.js");
  const { toMarkdownFiles, asText } = await import("../../source/app/js/vault.js");
  const ws = createWorkspace(createMemoryAdapter());
  const repo = await ws.createPage({ type: "repo", title: "R" });
  const d = await ws.createPage({ type: "database", title: "People", parentId: repo.id });
  const nameCol = d.columns[0];
  const row = await ws.createRow(d);
  row.values[nameCol.id] = "Ada";
  await ws.saveRow(row);
  const doc = await ws.createPage({ title: "Doc", parentId: repo.id });
  doc.blocks = [newBlock("preview", { dbId: d.id, keys: ["ada", "zed"] }), newBlock("preview", { dbId: "gone", keys: ["q"] })];
  await ws.savePage(doc);
  const files = toMarkdownFiles({ pages: await ws.listPages(), rows: await ws.listRows(d.id) });
  const text = asText(files.find((f) => /Doc\.md$/.test(f.path)).data);
  assert.match(text, /\| Name \|[^\n]*\n\| --- \|[^\n]*\n\| Ada \|/);
  assert.match(text, /No row with key: zed/);
  assert.match(text, /Record preview: Untitled \(keys: q\)/);
});
