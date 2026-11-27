// Equivalence tests for the performance work: the optimised code must give the same results as the code it replaced.
// test/fixtures/dbviews.orig.js is a frozen copy of dbviews.js before the sort / group changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as now from "../public/js/dbviews.js";
import * as orig from "./fixtures/dbviews.orig.js";
import { isTrashed, ancestors, descendantIds } from "../public/js/workspace.js";

const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

test("visibleRows / groupRows match the original on seeded fuzz", () => {
  const rnd = rng(11);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const words = ["a", "B", "item 2", "item 10", "Item 1", "éa", "ea", "", "zz", " x"];
  const columns = [
    { id: "t", name: "T", type: "text", config: {} },
    { id: "n", name: "N", type: "number", config: {} },
    { id: "c", name: "C", type: "checkbox", config: {} },
    { id: "s", name: "S", type: "select", config: { options: ["x", "y", "z"] } },
    { id: "d", name: "D", type: "date", config: {} },
    { id: "a", name: "A", type: "array", config: {} },
    { id: "f", name: "F", type: "formula", config: { expr: "1" } }
  ];
  for (let round = 0; round < 300; round++) {
    const n = Math.floor(rnd() * 60);
    const rows = Array.from({ length: n }, (_, i) => ({
      id: `r${i}`,
      values: {
        t: rnd() < 0.1 ? null : pick(words),
        n: rnd() < 0.2 ? null : Math.floor(rnd() * 8) - 3,
        c: rnd() < 0.5,
        s: rnd() < 0.2 ? null : pick(["x", "y", "z", "w"]),
        d: rnd() < 0.2 ? null : `2026-0${1 + Math.floor(rnd() * 3)}-1${Math.floor(rnd() * 5)}`,
        a: rnd() < 0.3 ? [] : [pick(words), pick(words)].slice(0, 1 + Math.floor(rnd() * 2)),
        f: rnd() < 0.3 ? null : pick([1, 2, 10, "#N/A", "abc"])
      }
    }));
    const sorts = Array.from({ length: Math.floor(rnd() * 4) }, () => ({ col: pick(columns).id, dir: pick(["asc", "desc"]) }));
    const view = { filter: { op: "and", rules: rnd() < 0.5 ? [] : [{ col: "n", op: "gt", value: "0" }] }, sorts };
    const db = { columns };
    assert.deepEqual(now.visibleRows(db, view, rows).map((r) => r.id), orig.visibleRows(db, view, rows).map((r) => r.id));
    const g = pick(columns).id;
    const strip = (gs) => gs.map((x) => ({ key: x.key, label: x.label, ids: x.rows.map((r) => r.id) }));
    assert.deepEqual(strip(now.groupRows(rows, columns, g)), strip(orig.groupRows(rows, columns, g)));
  }
});

test("isTrashed / ancestors / descendantIds match a plain walk on random trees", () => {
  const rnd = rng(5);
  for (let round = 0; round < 200; round++) {
    const n = 1 + Math.floor(rnd() * 40);
    const pages = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, parentId: i && rnd() < 0.85 ? `p${Math.floor(rnd() * i)}` : rnd() < 0.1 ? "ghost" : null, trashedAt: rnd() < 0.1 ? 1 : undefined }));
    const byId = new Map(pages.map((p) => [p.id, p]));
    for (const p of pages) {
      let trashed = false;
      const chain = [];
      for (let q = p, k = 0; q && k < 100; q = byId.get(q.parentId), k++) {
        if (q.trashedAt) trashed = true;
        chain.unshift(q);
      }
      assert.equal(isTrashed(pages, p), trashed);
      assert.deepEqual(ancestors(pages, p.id).map((x) => x.id), chain.map((x) => x.id));
      const want = new Set([p.id]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const q of pages) if (q.parentId && want.has(q.parentId) && !want.has(q.id)) {
          want.add(q.id);
          grew = true;
        }
      }
      assert.deepEqual([...descendantIds(pages, p.id)].sort(), [...want].sort());
    }
    // in-place edits are seen; a list of a different length is re-indexed
    pages[0].trashedAt = 5;
    assert.equal(isTrashed(pages, pages[0]), true);
    pages.push({ id: "extra", parentId: "p0" });
    assert.equal(isTrashed(pages, pages.at(-1)), true);
  }
});
