import test from "node:test";
import assert from "node:assert/strict";
import { parseSize, formatSize, clampSize, normSize, normSizeOrConst, normSizeList, resolveSize, parseSizeField, sizeFieldText, SIZE_RANGES } from "../../source/app/js/sizes.js";

const consts = [
  { id: "w1", name: "photoWidth", type: "number", value: 320 },
  { id: "w2", name: "wide", type: "text", value: "20em" },
  { id: "w3", name: "bad", type: "text", value: "big" },
  { id: "w4", name: "day", type: "date", value: "2029-03-04" },
  { id: "w5", name: "empty", type: "number", value: null }
];
const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

test("parseSize accepts px, em, rem and bare numbers", () => {
  assert.deepEqual(parseSize("320"), { n: 320, unit: "px" });
  assert.deepEqual(parseSize(" 12.5 REM "), { n: 12.5, unit: "rem" });
  assert.deepEqual(parseSize("20em"), { n: 20, unit: "em" });
  assert.deepEqual(parseSize(48), { n: 48, unit: "px" });
});
test("parseSize rejects %, negatives, junk and zero", () => {
  for (const v of ["50%", "-3px", "0", "0px", "abc", "1e3", "12pt", "", " ", null, undefined, NaN, Infinity, {}, [], "1px 2px", "calc(1px)", "10vw"]) assert.equal(parseSize(v), null, String(v));
});
test("formatSize and normSize", () => {
  assert.equal(formatSize({ n: 320, unit: "px" }), "320px");
  assert.equal(formatSize(null), "");
  assert.equal(normSize("320"), "320px");
  assert.equal(normSize("1px"), "8px"); // clamped up
  assert.equal(normSize("99999"), "4000px");
  assert.equal(normSize("1em", SIZE_RANGES.column), "2.5em");
  assert.equal(normSize("bad"), null);
});
test("normSizeOrConst keeps a constant reference", () => {
  assert.deepEqual(normSizeOrConst({ const: "w1" }), { const: "w1" });
  assert.equal(normSizeOrConst({ const: "bad id!" }), null);
  assert.equal(normSizeOrConst({}), null);
  assert.equal(normSizeOrConst("20em"), "20em");
});
test("normSizeList aligns to the length", () => {
  assert.deepEqual(normSizeList(["100", null, "x"], 4, SIZE_RANGES.column), ["100px", null, null, null]);
  assert.equal(normSizeList([null, "x"], 2), null);
  assert.equal(normSizeList("no", 2), null);
});
test("resolveSize: sizes, constants by id and by name", () => {
  assert.deepEqual(resolveSize("320", consts), { css: "320px", reason: null });
  assert.deepEqual(resolveSize({ const: "w1" }, consts), { css: "320px", reason: null });
  assert.deepEqual(resolveSize("photoWidth", consts), { css: "320px", reason: null });
  assert.deepEqual(resolveSize("WIDE", consts), { css: "20em", reason: null });
  assert.deepEqual(resolveSize(null, consts), { css: null, reason: null });
});
test("resolveSize falls back to auto with a reason", () => {
  for (const v of [{ const: "nope" }, { const: "w3" }, { const: "w4" }, { const: "w5" }, "missingName", "50%", { x: 1 }]) {
    const r = resolveSize(v, consts);
    assert.equal(r.css, null);
    assert.ok(r.reason, JSON.stringify(v));
  }
});
test("constant sizes are clamped too", () => {
  assert.equal(resolveSize({ const: "w1" }, [{ id: "w1", name: "a", type: "number", value: 99999 }]).css, "4000px");
});
test("parseSizeField", () => {
  assert.deepEqual(parseSizeField("", {}), { value: null, error: null });
  assert.deepEqual(parseSizeField("200", {}), { value: "200px", error: null });
  assert.deepEqual(parseSizeField("photoWidth", { constants: consts, allowConst: true }), { value: { const: "w1" }, error: null });
  assert.ok(parseSizeField("photoWidth", { constants: consts }).error);
  assert.ok(parseSizeField("nope", { constants: consts, allowConst: true }).error);
  assert.equal(sizeFieldText({ const: "w1" }, consts), "photoWidth");
  assert.equal(sizeFieldText("20em", consts), "20em");
});
test("clampSize with em", () => {
  assert.deepEqual(clampSize({ n: 1000, unit: "em" }, [8, 4000]), { n: 250, unit: "em" });
});
test("seeded fuzz: never throws, css is always a safe size or null", () => {
  const r = rng(42);
  const pool = ["px", "em", "rem", "%", "vw", "", " ", "e", "-", ".", "{", "}", "const", "\n", ";", "url(x)", "0", "1", "9", "99999", "photoWidth", "wide", "bad", "day"];
  const safe = /^\d+(\.\d+)?(px|em|rem)$/;
  for (let i = 0; i < 3000; i++) {
    let s = "";
    for (let k = Math.floor(r() * 5); k >= 0; k--) s += pool[Math.floor(r() * pool.length)];
    const value = r() < 0.15 ? { const: s } : r() < 0.1 ? Number(s) : s;
    const out = resolveSize(value, consts);
    assert.ok(out.css === null || safe.test(out.css), `${JSON.stringify(value)} -> ${out.css}`);
    const p = parseSize(s);
    if (p) assert.equal(parseSize(formatSize(p)).unit, p.unit);
    const f = parseSizeField(s, { constants: consts, allowConst: true });
    assert.ok(f.value === null || f.value === undefined || typeof f.value === "string" || typeof f.value.const === "string");
  }
});

import { rowHeightInfo, rowHeightAttrs } from "../../source/app/js/sizes.js";
test("row height presets and sizes", () => {
  assert.deepEqual(rowHeightInfo({ rowHeight: "tall" }), { mode: "tall", css: null });
  assert.deepEqual(rowHeightInfo({ rowHeight: "50" }), { mode: "custom", css: "50px" });
  assert.deepEqual(rowHeightInfo({ rowHeight: "3em" }), { mode: "custom", css: "3em" });
  assert.deepEqual(rowHeightInfo({ rowHeight: "50%" }), { mode: "normal", css: null });
  assert.deepEqual(rowHeightInfo({}), { mode: "normal", css: null });
  assert.deepEqual(rowHeightAttrs({ rowHeight: "compact" }), { cls: " rh-compact", style: "" });
  assert.deepEqual(rowHeightAttrs({ rowHeight: "40px" }), { cls: " rh-custom", style: "--db-rh:40px;" });
  assert.deepEqual(rowHeightAttrs({}), { cls: "", style: "" });
});
