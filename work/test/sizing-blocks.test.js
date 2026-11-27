import test from "node:test";
import assert from "node:assert/strict";
import { newBlock, normalizeBlocks, tableResize } from "../../source/app/js/blocks/model.js";
import { blocksToMarkdown, markdownToBlocks } from "../../source/app/js/blocks/markdown.js";

test("legacy table header flag becomes headerRow", () => {
  const [on, off] = normalizeBlocks([
    { id: "a", type: "table", cells: [["a", "b"], ["c", "d"]], header: true, headerCol: true },
    { id: "b", type: "table", cells: [["a"]] }
  ]);
  assert.equal(on.headerRow, true);
  assert.equal(on.headerCol, true);
  assert.equal("header" in on, false);
  assert.equal(off.headerRow, false);
  assert.equal(off.headerCol, false);
});
test("new tables have a header row and no sizes", () => {
  const t = newBlock("table", { rows: 2, cols: 2 });
  assert.equal(t.headerRow, true);
  assert.equal(t.colWidths, undefined);
});
test("colWidths and rowHeights are cleaned and aligned to the grid", () => {
  const [t] = normalizeBlocks([{ id: "a", type: "table", cells: [["a", "b", "c"], ["d", "e", "f"]], colWidths: ["120", "50%", null, "9em"], rowHeights: ["bad", "3em"] }]);
  assert.deepEqual(t.colWidths, ["120px", null, null]);
  assert.deepEqual(t.rowHeights, [null, "3em"]);
  const [u] = normalizeBlocks([{ id: "a", type: "table", cells: [["a"]], colWidths: [null], rowHeights: "x" }]);
  assert.equal("colWidths" in u, false);
  assert.equal("rowHeights" in u, false);
});
test("tableResize keeps the size lists aligned", () => {
  const t = newBlock("table", { rows: 2, cols: 3 });
  t.colWidths = ["100px", null, "20em"];
  t.rowHeights = [null, "40px"];
  tableResize(t, 3, 2);
  assert.deepEqual(t.colWidths, ["100px", null]);
  assert.deepEqual(t.rowHeights, [null, "40px", null]);
  tableResize(t, 1, 1);
  assert.deepEqual(t.colWidths, ["100px"]);
  assert.equal("rowHeights" in t, false);
});
test("image sizes: sizes and constant references survive, junk is dropped", () => {
  const out = normalizeBlocks([
    { id: "a", type: "image", src: "", caption: "", width: "320", height: { const: "k1" }, align: "center" },
    { id: "b", type: "image", src: "", caption: "", width: "50%", height: { x: 1 }, align: "diagonal" },
    { id: "c", type: "image", src: "", caption: "", align: "left", width: { const: "bad id" } }
  ]);
  assert.equal(out[0].width, "320px");
  assert.deepEqual(out[0].height, { const: "k1" });
  assert.equal(out[0].align, "center");
  for (const k of ["width", "height", "align"]) assert.equal(k in out[1], false, k);
  assert.equal("align" in out[2], false);
  assert.equal("width" in out[2], false);
});
test("markdown: image size is dropped; headerless tables get an empty header row and round trip", () => {
  const img = newBlock("image", { src: "https://example.com/a.png", caption: "Alt" });
  img.width = "320px";
  assert.equal(blocksToMarkdown([img]), "![Alt](https://example.com/a.png)");
  const t = newBlock("table", { rows: 2, cols: 2 });
  t.cells = [["a", "b"], ["c", "d"]];
  assert.equal(blocksToMarkdown([t]), "| a | b |\n| --- | --- |\n| c | d |");
  t.headerRow = false;
  const md = blocksToMarkdown([t]);
  assert.equal(md, "|  |  |\n| --- | --- |\n| a | b |\n| c | d |");
  const [back] = markdownToBlocks(md);
  assert.deepEqual(back.cells, [["a", "b"], ["c", "d"]]);
  assert.equal(back.headerRow, false);
});
test("markdown: an inline image keeps alt and url, never the size", () => {
  const p = newBlock("p", { text: "x {{img:https://example.com/a.png|10em|photoWidth|Alt [t]}} y" });
  assert.equal(blocksToMarkdown([p]), "x ![Alt t](https://example.com/a.png) y");
});
