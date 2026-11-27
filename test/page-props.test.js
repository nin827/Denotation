import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanProps, cleanProp, cleanValue, convertProp, propText, propsFromRow, valuesFromProps, frontMatter, propsFromFrontMatter, newProp, safeUrl, PROPS_MAX
} from "../public/js/pageProps.js";

test("cleanProps keeps good props, fixes bad ones, never throws", () => {
  const out = cleanProps([
    { id: "a", name: "  Status ", type: "select", options: ["Draft", "Done", "Draft", ""], value: "Draft" },
    { id: "a", name: "", type: "nope", value: { x: 1 } },
    null, 7, "x",
    { id: "n", name: "Count", type: "number", value: "12.5" },
    { id: "d", name: "Due", type: "date", value: "2026-02-30" },
    { id: "m", name: "Tags", type: "multi", options: ["a"], value: ["a", "b", "a"] },
    { id: "u", name: "Link", type: "url", value: "javascript:alert(1)" },
    { id: "p", name: "Ref", type: "page", value: "bad id!" },
    { id: "c", name: "Done", type: "checkbox", value: "true" }
  ]);
  assert.equal(out.length, 8);
  assert.deepEqual(out[0], { id: "a", name: "Status", type: "select", options: ["Draft", "Done"], value: "Draft" });
  assert.equal(out[1].type, "text");
  assert.equal(out[1].name, "Property");
  assert.notEqual(out[1].id, "a", "duplicate ids get a fresh one");
  assert.equal(out[1].value, '{"x":1}');
  assert.equal(out[2].value, 12.5);
  assert.equal(out[3].value, null, "invalid date dropped");
  assert.deepEqual(out[4].options, ["a", "b"], "a value without an option becomes an option");
  assert.deepEqual(out[4].value, ["a", "b"]);
  assert.equal(out[5].value, "", "unsafe URL scheme dropped");
  assert.equal(out[6].value, null);
  assert.equal(out[7].value, true);
  assert.deepEqual(cleanProps("nope"), []);
  assert.equal(cleanProps(Array.from({ length: 80 }, (_, i) => ({ name: `p${i}` }))).length, PROPS_MAX);
});

test("seeded fuzz: cleanProp always yields a valid property", () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pool = [null, undefined, "", "x", 0, 1, -3.5, true, false, [], ["a"], {}, { a: 1 }, "2026-01-05", "https://x.y", NaN];
  const types = ["text", "number", "date", "select", "multi", "checkbox", "url", "page", "bogus", null];
  for (let i = 0; i < 500; i++) {
    const p = cleanProp({ id: rnd() < 0.5 ? "ok-id" : pool[Math.floor(rnd() * pool.length)], name: pool[Math.floor(rnd() * pool.length)], type: types[Math.floor(rnd() * types.length)], value: pool[Math.floor(rnd() * pool.length)], options: rnd() < 0.5 ? ["a", "x"] : pool[Math.floor(rnd() * pool.length)] });
    assert.ok(p && typeof p.id === "string" && typeof p.name === "string" && p.name.length);
    assert.deepEqual(cleanProp(p), p, "cleaning is idempotent");
  }
});

test("convert, text, safe URLs", () => {
  const t = newProp("Tags", "text");
  t.value = "red, blue";
  const m = convertProp(t, "multi");
  assert.deepEqual(m.value, ["red", "blue"]);
  assert.deepEqual(m.options, ["red", "blue"]);
  assert.equal(propText(m), "red, blue");
  assert.equal(convertProp(m, "text").value, "red, blue");
  assert.equal(convertProp({ ...t, value: "yes" }, "checkbox").value, true);
  assert.equal(propText({ type: "page", value: "abc" }, (id) => `T-${id}`), "T-abc");
  assert.equal(safeUrl("mailto:a@b.c"), "mailto:a@b.c");
  assert.equal(safeUrl("data:text/html,x"), "");
  assert.equal(safeUrl("notes/page.md"), "notes/page.md");
  assert.equal(cleanValue("number", "abc"), null);
});

test("row values -> properties, and template properties -> row values", () => {
  const cols = [
    { id: "n", name: "Name", type: "text" },
    { id: "s", name: "Status", type: "select", config: { options: ["Open", "Done"] } },
    { id: "q", name: "Qty", type: "number" },
    { id: "t", name: "Tags", type: "array", config: { itemType: "text" } },
    { id: "f", name: "Twice", type: "formula" }
  ];
  const row = { values: { n: "Milk", s: "Open", q: 2, t: ["a", "b"], f: 4 } };
  const props = propsFromRow(cols, row, (c, v) => (Array.isArray(v) ? v.join("|") : String(v)));
  assert.deepEqual(props.map((p) => [p.name, p.type, p.value]), [["Status", "select", "Open"], ["Qty", "number", 2], ["Tags", "text", "a|b"], ["Twice", "text", "4"]]);
  const vals = valuesFromProps(cols, [{ name: "status", type: "select", value: "Done" }, { name: "Name", type: "text", value: "Eggs" }, { name: "Twice", type: "number", value: 9 }]);
  assert.deepEqual(vals, { n: "Eggs", s: "Done" });
});

test("front matter round trip", () => {
  const props = cleanProps([
    { name: "Status", type: "select", options: ["Draft"], value: "Draft" },
    { name: "Due date", type: "date", value: "2026-03-01" },
    { name: "Count", type: "number", value: 3 },
    { name: "Done", type: "checkbox", value: false },
    { name: "Tags", type: "multi", options: ["a b", "c"], value: ["a b", "c"] },
    { name: "Note", type: "text", value: "has: colon" },
    { name: "Site", type: "url", value: "https://example.com/x" },
    { name: "Empty", type: "text", value: "" }
  ]);
  const fm = frontMatter("My page", props);
  assert.match(fm, /^title: "My page"\n/);
  assert.match(fm, /Note: "has: colon"/);
  const back = propsFromFrontMatter(fm);
  assert.deepEqual(back.map((p) => [p.name, p.type, p.value]), [
    ["Status", "text", "Draft"], ["Due date", "date", "2026-03-01"], ["Count", "number", 3], ["Done", "checkbox", false],
    ["Tags", "multi", ["a b", "c"]], ["Note", "text", "has: colon"], ["Site", "url", "https://example.com/x"], ["Empty", "text", ""]
  ]);
});
