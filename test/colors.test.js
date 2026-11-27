import test from "node:test";
import assert from "node:assert/strict";
import { normColor, normBg, normalizeBlocks, newBlock, HUES, LEGACY_HUES } from "../public/js/blocks/model.js";

test("hues are 12 steps of 30 degrees", () => {
  assert.deepEqual(HUES.map((h) => h[0]), Array.from({ length: 12 }, (_, i) => i * 30));
});
test("hue numbers pass through (numeric strings too)", () => {
  for (const [deg] of HUES) {
    assert.equal(normColor(deg), deg);
    assert.equal(normBg(deg), deg);
  }
  assert.equal(normColor("120"), 120);
});
test("legacy names map to the nearest hue", () => {
  const table = { brown: 30, orange: 60, yellow: 90, green: 150, blue: 240, purple: 300, pink: 0, red: 30 };
  assert.deepEqual(LEGACY_HUES, table);
  for (const [name, hue] of Object.entries(table)) {
    assert.equal(normColor(name), hue);
    assert.equal(normBg(name), hue);
  }
});
test("legacy gray: default text, grey background", () => {
  assert.equal(normColor("gray"), null);
  assert.equal(normBg("gray"), "grey");
  assert.equal(normBg("grey"), "grey");
  assert.equal(normColor("grey"), null); // grey is background-only
});
test("invalid values are default", () => {
  for (const v of [undefined, null, "", "default", "pink2", "__proto__", "constructor", 45, -30, 360, 1.5, NaN, {}, [], true, "#f00"]) {
    assert.equal(normColor(v), null, String(v));
    assert.equal(normBg(v), null, String(v));
  }
});
test("normalizeBlocks cleans colours, recursively", () => {
  const blocks = normalizeBlocks([
    { id: "a", type: "p", text: "x", color: "red", bg: "gray" },
    { id: "b", type: "toggle", text: "y", color: "gray", bg: "nope", children: [{ id: "c", type: "p", text: "z", color: 210, bg: "grey" }] },
    { id: "d", type: "p", text: "w", color: "default" }
  ]);
  assert.equal(blocks[0].color, 30);
  assert.equal(blocks[0].bg, "grey");
  assert.ok(!("color" in blocks[1]) && !("bg" in blocks[1]));
  assert.equal(blocks[1].children[0].color, 210);
  assert.equal(blocks[1].children[0].bg, "grey");
  assert.ok(!("color" in blocks[2]));
});
test("callouts default to a grey background", () => {
  assert.equal(newBlock("callout").bg, "grey");
});
test("seeded fuzz: output is always a valid value", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pool = [...HUES.map((h) => h[0]), ...Object.keys(LEGACY_HUES), "gray", "grey", "x", 17, null, undefined, "7", -1];
  for (let i = 0; i < 500; i++) {
    const v = pool[Math.floor(rnd() * pool.length)];
    const c = normColor(v);
    const bg = normBg(v);
    assert.ok(c === null || HUES.some((h) => h[0] === c));
    assert.ok(bg === null || bg === "grey" || HUES.some((h) => h[0] === bg));
  }
});
