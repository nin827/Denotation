import test from "node:test";
import assert from "node:assert/strict";
import { sortOnly, sortDir, clearSort, hideColumn, duplicatePatch, rowLink } from "../../source/app/js/dbMenuLogic.js";

test("sort helpers", () => {
  const v = { sorts: [{ col: "a", dir: "asc" }, { col: "b", dir: "asc" }] };
  sortOnly(v, "c", "desc");
  assert.deepEqual(v.sorts, [{ col: "c", dir: "desc" }]);
  assert.equal(sortDir(v, "c"), "desc");
  assert.equal(sortDir(v, "x"), null);
  clearSort(v, "c");
  assert.deepEqual(v.sorts, []);
});
test("hideColumn never hides the first column or twice", () => {
  const cols = [{ id: "a" }, { id: "b" }];
  const v = { hidden: [] };
  assert.equal(hideColumn(v, cols, "a"), false);
  assert.equal(hideColumn(v, cols, "b"), true);
  assert.equal(hideColumn(v, cols, "b"), false);
  assert.deepEqual(v.hidden, ["b"]);
});
test("duplicatePatch deep-copies", () => {
  const row = { values: { a: { x: 1 } }, blocks: [{ id: "1" }] };
  const p = duplicatePatch(row);
  p.values.a.x = 2;
  assert.equal(row.values.a.x, 1);
  assert.equal(duplicatePatch({ values: {} }).blocks, null);
});
test("rowLink", () => {
  assert.equal(rowLink({ id: "r1" }, { origin: "https://x.io", pathname: "/app/", search: "" }), "https://x.io/app/#row-r1");
});
