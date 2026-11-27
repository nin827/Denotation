import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanGroups, orderColumns, applyGroups, gridColumns, headerRows, sectionColumns, makeGroup, addToGroup, ungroup,
  toggleCollapsed, resolveDisplay, setViewDisplay, columnsToJson, parseColumnsJson, groupIndex
} from "../public/js/columns.js";
import { visibleRows, ensureViews, colWidth, isWrapped } from "../public/js/dbviews.js";
import { validate, validateColumn, summarize } from "../public/js/schema.js";
import { databaseToCsv } from "../public/js/csv.js";

const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const col = (id, name = id, type = "text", extra = {}) => ({ id, name, type, config: {}, ...extra });

function checkInvariants(columns, groups) {
  const gs = cleanGroups(columns, groups);
  const ids = new Set(columns.map((c) => c.id));
  const seen = new Set();
  for (const g of gs) {
    for (const id of g.colIds) {
      assert.ok(ids.has(id));
      assert.ok(!seen.has(id), "a column is in one group at most");
      seen.add(id);
    }
    if (g.parentId) {
      const p = gs.find((x) => x.id === g.parentId);
      assert.ok(p, "parent exists");
      assert.ok(!p.parentId, "two levels at most");
    }
  }
  const out = orderColumns(columns, gs);
  assert.deepEqual([...out].map((c) => c.id).sort(), columns.map((c) => c.id).sort(), "a permutation");
  assert.deepEqual(orderColumns(out, gs).map((c) => c.id), out.map((c) => c.id), "idempotent");
  if (columns.length) assert.equal(out[0].id, columns[0].id, "the title column stays first");
  // every group (and every subgroup) is one contiguous run
  const { ofCol } = groupIndex(gs);
  for (const g of gs) {
    const pos = out.map((c, i) => [c, i]).filter(([c]) => ofCol.get(c.id)?.top.id === g.id || ofCol.get(c.id)?.sub?.id === g.id).map(([, i]) => i);
    if (pos.length) assert.equal(pos[pos.length - 1] - pos[0] + 1, pos.length, `group ${g.label} is contiguous`);
  }
  // ungrouped columns keep their relative order
  const free = (list) => list.filter((c) => !ofCol.has(c.id)).map((c) => c.id);
  assert.deepEqual(free(out), free(columns));
  return { gs, out };
}

test("column-group ordering invariants hold on seeded fuzz", () => {
  const rnd = rng(5);
  for (let round = 0; round < 800; round++) {
    const n = 1 + Math.floor(rnd() * 9);
    const columns = Array.from({ length: n }, (_, i) => col(`c${i}`));
    const groups = Array.from({ length: Math.floor(rnd() * 5) }, (_, g) => ({
      id: `g${g}`,
      label: rnd() < 0.1 ? "" : `G${g}`,
      parentId: rnd() < 0.4 ? `g${Math.floor(rnd() * 5)}` : undefined,
      colIds: Array.from({ length: Math.floor(rnd() * 4) }, () => rnd() < 0.1 ? "missing" : `c${Math.floor(rnd() * n)}`)
    }));
    const { gs, out } = checkInvariants(columns, groups);
    // header rows span exactly the shown columns
    const view = { collapsedGroups: gs.filter(() => rnd() < 0.3).map((g) => g.id) };
    const grid = gridColumns(out, gs, view);
    for (const row of headerRows(grid, gs)) assert.equal(row.reduce((s, c) => s + c.span, 0), grid.length);
    assert.equal(grid[0].id, out[0].id, "the title column is never folded");
    assert.equal(sectionColumns(out, gs).reduce((s, x) => s + x.cols.length, 0), out.length);
    // the JSON round trip keeps the setup
    const back = parseColumnsJson(columnsToJson(out, gs));
    assert.ok(back.ok, back.error);
    assert.deepEqual(back.columns.map((c) => c.id), out.map((c) => c.id));
    assert.deepEqual(back.columnGroups, gs);
  }
});

test("groups: make, move, ungroup, collapse", () => {
  const columns = ["a", "b", "c", "d", "e"].map((x) => col(x));
  let { groups, group } = makeGroup([], "Stats", ["e", "b"]);
  let r = applyGroups(columns, groups);
  assert.deepEqual(r.columns.map((c) => c.id), ["a", "b", "e", "c", "d"], "grouped columns move beside each other");
  ({ groups } = makeGroup(r.columnGroups, "Sub", ["e"], group.id));
  r = applyGroups(r.columns, groups);
  assert.deepEqual(r.columnGroups.map((g) => [g.label, g.colIds, g.parentId ?? null]), [["Stats", ["b"], null], ["Sub", ["e"], group.id]]);
  const rows = headerRows(r.columns, r.columnGroups);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].map((c) => [c.group?.label ?? null, c.span]), [[null, 1], ["Stats", 2], [null, 2]]);
  assert.deepEqual(rows[1].map((c) => [c.group?.label ?? null, c.span]), [[null, 2], ["Sub", 1], [null, 2]]);
  const view = {};
  toggleCollapsed(view, group.id);
  const grid = gridColumns(r.columns, r.columnGroups, view);
  assert.deepEqual(grid.map((c) => c.stub ? c.name : c.id), ["a", "Stats (2)", "c", "d"]);
  assert.deepEqual(headerRows(grid, r.columnGroups)[0].map((c) => c.group?.label ?? null), [null, "Stats", null]);
  groups = addToGroup(r.columnGroups, group.id, ["d"]);
  assert.deepEqual(applyGroups(r.columns, groups).columns.map((c) => c.id), ["a", "b", "e", "d", "c"]);
  assert.deepEqual(ungroup(groups, group.id), [], "ungrouping a top group drops its subgroups too");
  assert.deepEqual(cleanGroups(columns, [{ id: "x", label: "X", colIds: [] }]), [], "empty groups go");
  assert.deepEqual(cleanGroups(columns, undefined), []);
});

test("display resolution: view override > legacy wrap > column default", () => {
  const c = col("a", "A", "text", { display: "obfuscate" });
  const plain = col("b");
  assert.equal(resolveDisplay({}, plain), "clip");
  assert.equal(resolveDisplay({}, c), "obfuscate");
  assert.equal(resolveDisplay({ wrapAll: true }, plain), "wrap");
  assert.equal(resolveDisplay({ wrapAll: true }, c), "obfuscate");
  assert.equal(resolveDisplay({ wrap: { b: true } }, plain), "wrap");
  assert.equal(resolveDisplay({ wrapAll: true, wrap: { b: false } }, plain), "clip");
  const v = { wrap: { b: true } };
  setViewDisplay(v, "b", "marquee");
  assert.equal(resolveDisplay(v, plain), "marquee");
  assert.equal("b" in v.wrap, false);
  setViewDisplay(v, "b", null);
  assert.equal(resolveDisplay(v, plain), "clip");
  assert.equal(resolveDisplay({ display: { b: "bogus" } }, plain), "clip");
  assert.equal(colWidth({ display: { b: "hide" }, widths: { b: 300 } }, plain), 44);
  assert.equal(isWrapped({ display: { b: "wrap" } }, plain), true);
});

test("columns JSON: validation messages", () => {
  const bad = (obj, re) => {
    const r = parseColumnsJson(typeof obj === "string" ? obj : JSON.stringify(obj));
    assert.equal(r.ok, false);
    assert.match(r.error, re, r.error);
  };
  bad("{ nope", /Not valid JSON/);
  bad([], /Expected an object/);
  bad({ columns: [] }, /at least one column/);
  bad({ columns: [{ id: "a", name: "A", type: "text" }], extra: 1 }, /Unknown top-level field "extra"/);
  bad({ columns: [{ id: "a", name: "A", type: "nope" }] }, /columns\[0\] \("A"\): unknown type "nope"/);
  bad({ columns: [{ id: "a", name: "A", type: "text", typetext: "" }] }, /unknown field "typetext"/);
  bad({ columns: [{ id: "a", name: "A", type: "text" }, { id: "a", name: "B", type: "text" }] }, /used twice/);
  bad({ columns: [{ id: "a", name: "A", type: "text" }, { id: "b", name: "a", type: "text" }] }, /already called/);
  bad({ columns: [{ id: "a", name: "A", type: "json", typeText: "Dictionary{a: Foo}" }] }, /Type: Unknown type "Foo"/);
  bad({ columns: [{ id: "a", name: "A", type: "text", display: "blink" }] }, /"display" must be one of/);
  bad({ columns: [{ id: "a", name: "A", type: "text" }], columnGroups: [{ label: "G", colIds: ["zz"] }] }, /no column has the id "zz"/);
  bad({ columns: [{ id: "a", name: "A", type: "text" }], columnGroups: [{ label: "G", colIds: ["a"] }, { label: "H", colIds: ["a"] }] }, /already in group "G"/);
  bad({ columns: [{ id: "a", name: "A", type: "text" }, { id: "b", name: "B", type: "text" }], columnGroups: [{ id: "1", label: "G", colIds: [] }, { id: "2", label: "H", parentId: "1", colIds: ["a"] }, { id: "3", label: "I", parentId: "2", colIds: ["b"] }] }, /two levels at most/);
  const ok = parseColumnsJson(JSON.stringify({ columns: [{ id: "a", name: " A ", type: "json", typeText: "Dictionary{hp: int}", display: "wrap" }, { name: "New", type: "number" }] }));
  assert.ok(ok.ok, ok.error);
  assert.equal(ok.columns[0].name, "A");
  assert.equal(ok.columns[0].display, "wrap");
  assert.ok(ok.columns[1].id, "a column without an id gets one");
});

test("JSON columns: stored as written, filters and sorts by dotted path, CSV writes JSON", () => {
  const j = col("j", "Hero", "json", { typeText: "Dictionary{name: String, stats: Dictionary{hp: int(0..100)}}" });
  assert.equal(validateColumn(j), null);
  assert.match(validateColumn({ ...j, typeText: "Dictionary{" }), /^Type:/);
  assert.deepEqual(validate(j, { anything: true }), { ok: true, value: { anything: true } }, "mismatches are kept");
  const rows = [
    { id: "1", values: { j: { name: "Ava", stats: { hp: 40 } } } },
    { id: "2", values: { j: { name: "Bo", stats: { hp: 90 } } } },
    { id: "3", values: { j: null } },
    { id: "4", values: { j: { name: "Cy", stats: { hp: 5 } } } }
  ];
  const db = { columns: [col("t"), j] };
  const ids = (view) => visibleRows(db, { filter: { op: "and", rules: [] }, sorts: [], ...view }, rows).map((r) => r.id);
  assert.deepEqual(ids({ filter: { op: "and", rules: [{ col: "j", path: "stats.hp", op: "gt", value: "30" }] } }), ["1", "2"]);
  assert.deepEqual(ids({ filter: { op: "and", rules: [{ col: "j", op: "contains", value: "bo" }] } }), ["2"]);
  assert.deepEqual(ids({ filter: { op: "and", rules: [{ col: "j", op: "empty" }] } }), ["3"]);
  assert.deepEqual(ids({ sorts: [{ col: "j", path: "stats.hp", dir: "desc" }] }), ["2", "1", "4", "3"], "empty sorts last");
  assert.deepEqual(ids({ sorts: [{ col: "j", path: "name", dir: "asc" }] }), ["1", "2", "4", "3"]);
  assert.equal(summarize(j, rows[0].values.j), "{name: Ava, stats: {hp: 40}}");
  const csv = databaseToCsv([j], rows.slice(0, 1));
  assert.equal(csv.split(/\r?\n/)[1], '"{""name"":""Ava"",""stats"":{""hp"":40}}"');
  const v = { filter: { op: "and", rules: [{ col: "j", path: "stats.hp", op: "gt", value: "1" }] }, sorts: [{ col: "j", path: "name", dir: "asc" }], hidden: [], display: { j: "marquee", gone: "wrap", t: "nope" }, collapsedGroups: ["x"] };
  ensureViews({ columns: db.columns, columnGroups: [], views: [v] });
  assert.equal(v.filter.rules[0].path, "stats.hp", "paths survive ensureViews");
  assert.deepEqual(v.display, { j: "marquee" });
  assert.equal(v.collapsedGroups, undefined);
});
