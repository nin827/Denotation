import test from "node:test";
import assert from "node:assert/strict";
import { parseInline, stripInline, buildToken, readToken, scanTokens, replaceTokens, isIsoDate, tokenFallback } from "../public/js/blocks/inline.js";
import { blocksToMarkdown } from "../public/js/blocks/markdown.js";
import { resolveValue, keyList } from "../public/js/preview.js";

const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const ALPHA = ["a", "B", "7", " ", "|", "}", "{", "\\", ":", "*", "_", "`", "[", "]", "(", ")", "é", "-", "!", "#"];
const randStr = (r, n) => Array.from({ length: 1 + Math.floor(r() * n) }, () => ALPHA[Math.floor(r() * ALPHA.length)]).join("");

test("value token parses to an inline node", () => {
  const n = parseInline("Price {{value:db1|Widget|c-2}}!");
  assert.deepEqual(n.map((x) => x.t), ["text", "inline", "text"]);
  assert.deepEqual(n[1], { t: "inline", kind: "value", args: ["db1", "Widget", "c-2"] });
});
test("date token", () => {
  assert.deepEqual(parseInline("{{date:2026-02-28}}")[0].args, ["2026-02-28"]);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(parseInline("{{date:2026-02-30}}")[0].t, "text");
});
test("unknown kinds and malformed tokens stay literal", () => {
  for (const s of ["{{nope:x}}", "{{value:a|b}}", "{{value:a b|k|c}}", "{{value:db|k|c}", "{{value:db|k|c", "{{}}", "{{:x}}", "{{value:db|k\n|c}}", "{{value:db||c}}", "{{value:<img>|k|c}}"]) {
    const n = parseInline(s);
    assert.ok(n.every((x) => x.t === "text"), s);
    assert.equal(n.map((x) => x.v).join(""), s);
  }
});
test("backslash escapes a token", () => {
  const n = parseInline("\\{{date:2026-01-01}}");
  assert.ok(n.every((x) => x.t === "text"));
  assert.equal(n.map((x) => x.v).join(""), "{{date:2026-01-01}}");
});
test("tokens inside code spans stay code", () => {
  assert.deepEqual(parseInline("`{{date:2026-01-01}}`"), [{ t: "code", v: "{{date:2026-01-01}}" }]);
  assert.equal(scanTokens("`{{date:2026-01-01}}`").length, 0);
});
test("tokens work inside bold and links", () => {
  const n = parseInline("**{{date:2026-01-01}}** [a {{date:2026-01-02}}](https://x.y)");
  assert.equal(n[0].children[0].kind, "date");
  assert.equal(n[2].children[1].kind, "date");
});
test("stripInline and replaceTokens", () => {
  assert.equal(stripInline("x {{date:2026-01-01}} y"), "x 2026-01-01 y");
  assert.equal(stripInline("{{value:d|Key|c}}"), "Key");
  assert.equal(replaceTokens("a {{date:2026-01-01}} `{{date:2026-01-01}}` b", () => "Z"), "a Z `{{date:2026-01-01}}` b");
  assert.equal(replaceTokens("{{date:2026-01-01}}", () => null), "{{date:2026-01-01}}");
});
test("buildToken validates", () => {
  assert.equal(buildToken("value", ["a/b", "k", "c"]), null);
  assert.equal(buildToken("value", ["a", "", "c"]), null);
  assert.equal(buildToken("zzz", []), null);
  assert.equal(buildToken("date", ["2026-13-01"]), null);
  assert.equal(buildToken("date", ["2026-12-01"]), "{{date:2026-12-01}}");
});
test("fuzz: build then parse round-trips any key", () => {
  const r = rng(42);
  for (let i = 0; i < 2000; i++) {
    const key = randStr(r, 20);
    const tok = buildToken("value", ["db-1", key, "col_9"]);
    if (key.trim() === "") { assert.equal(tok, null); continue; }
    assert.ok(tok, key);
    const pre = randStr(r, 6).replace(/[\\`]/g, "");
    const text = `${pre}${tok}${randStr(r, 6).replace(/[\\`]/g, "")}`;
    const hit = scanTokens(text).find((t) => t.node.kind === "value");
    assert.ok(hit, JSON.stringify([key, text]));
    assert.deepEqual(hit.node.args, ["db-1", key.trim(), "col_9"]);
    assert.equal(hit.end - hit.start, tok.length);
    assert.equal(readToken(tok, 0).end, tok.length);
  }
});
test("fuzz: parse never throws and keeps all text", () => {
  const r = rng(7);
  const pieces = ["{{", "}}", "value:", "date:", "db1", "|", "2026-01-01", "k", "\\", "`", "*", "[", "](x)", "\n", ":"];
  for (let i = 0; i < 3000; i++) {
    const s = Array.from({ length: Math.floor(r() * 14) }, () => pieces[Math.floor(r() * pieces.length)]).join("");
    const nodes = parseInline(s);
    assert.ok(Array.isArray(nodes));
    stripInline(s);
    replaceTokens(s, tokenFallback);
  }
});
test("markdown export writes plain values and dates", () => {
  const blocks = [{ id: "1", type: "p", text: "On {{date:2026-03-04}} it was {{value:d|Key|c}} and **{{value:d|Key|c}}**" }, { id: "2", type: "bullet", text: "{{value:d|Gone|c}}" }];
  const inline = (n) => n.kind === "date" ? n.args[0] : n.args[1] === "Key" ? "42" : null;
  assert.equal(blocksToMarkdown(blocks, { inline }), "On 2026-03-04 it was 42 and **42**\n\n- Gone");
  assert.equal(blocksToMarkdown(blocks), "On 2026-03-04 it was Key and **Key**\n\n- Gone");
});
test("resolveValue and keyList", () => {
  const db = { type: "database", columns: [{ id: "n", name: "Name", type: "text" }, { id: "p", name: "Price", type: "number" }, { id: "o", name: "Ok", type: "checkbox" }] };
  const rows = [{ id: "r1", values: { n: "Widget", p: 5, o: true } }, { id: "r2", values: { n: "widget ", p: 9 } }, { id: "r3", values: { n: "Gadget", p: 7 } }, { id: "r4", values: {} }];
  assert.deepEqual(keyList(db, rows), ["Widget", "Gadget"]);
  assert.equal(resolveValue(db, rows, "WIDGET", "p").text, "5");
  assert.equal(resolveValue(db, rows, "Widget", "o").text, "Yes");
  assert.equal(resolveValue(db, rows, "Gadget", "o").text, "No");
  assert.equal(resolveValue(db, rows, "Nope", "p").state, "norow");
  assert.equal(resolveValue(db, rows, "Gadget", "zz").state, "nocol");
  assert.equal(resolveValue(null, rows, "Gadget", "p").state, "nodb");
});

// ---------- preset chips ----------
import { cleanChipPresets, newChipPreset, listChipPresets, findChipPreset, resolvePreset, countChipPresetUsers, presetKey } from "../public/js/preview.js";
import { presetEntries, CATALOG, filterCatalog } from "../public/js/blocks/catalog.js";

test("preset token with and without key", () => {
  assert.deepEqual(parseInline("{{preset:p-1|Widget}}")[0], { t: "inline", kind: "preset", args: ["p-1", "Widget"] });
  assert.deepEqual(parseInline("{{preset:p-1}}")[0], { t: "inline", kind: "preset", args: ["p-1"] });
  assert.equal(buildToken("preset", ["p-1"]), "{{preset:p-1}}");
  assert.equal(buildToken("preset", ["p-1", " A|B "]), "{{preset:p-1|A\\|B}}");
  for (const s of ["{{preset:}}", "{{preset:a b}}", "{{preset:a|}}", "{{preset:a|k|x}}", "{{preset:a/b|k}}", "{{preset:a|k\n}}"]) {
    assert.ok(parseInline(s).every((x) => x.t === "text"), s);
  }
  assert.equal(buildToken("preset", ["bad id", "k"]), null);
});
test("preset fallback and stripInline", () => {
  assert.equal(stripInline("{{preset:p|Key}}"), "Key");
  assert.equal(stripInline("{{preset:p}}"), "Preset");
  assert.equal(tokenFallback({ kind: "preset", args: ["p"] }), "Preset");
});
test("fuzz: preset token round-trips any key", () => {
  const r = rng(99);
  for (let i = 0; i < 2000; i++) {
    const key = randStr(r, 20);
    const tok = buildToken("preset", ["pid-1", key]);
    if (key.trim() === "") { assert.equal(tok, null); continue; }
    const hit = scanTokens(`x${tok}y`)[0];
    assert.ok(hit, key);
    assert.deepEqual(hit.node.args, ["pid-1", key.trim()]);
  }
  const pieces = ["{{", "}}", "preset:", "p1", "|", "k", "\\", "`", ":"];
  for (let i = 0; i < 2000; i++) {
    const s = Array.from({ length: Math.floor(r() * 12) }, () => pieces[Math.floor(r() * pieces.length)]).join("");
    stripInline(s);
    replaceTokens(s, tokenFallback);
  }
});
const pdb = () => ({
  id: "db1", type: "database", title: "Products",
  columns: [{ id: "n", name: "Name", type: "text" }, { id: "p", name: "Price", type: "number" }, { id: "s", name: "Stock", type: "number" }],
  chipPresets: [{ id: "pr1", name: "Price", colId: "p" }, { id: "pr2", name: "Widget stock", colId: "s", key: "Widget" }]
});
const prows = [{ id: "r1", values: { n: "Widget", p: 5, s: 3 } }, { id: "r2", values: { n: "Gadget", p: 7, s: 0 } }];
test("resolve via preset, fixed key and column edits", () => {
  const db = pdb();
  const pages = [db, { id: "x", type: "doc" }];
  const hit = findChipPreset(pages, "pr1");
  assert.equal(hit.db.id, "db1");
  const node = (args) => ({ kind: "preset", args });
  assert.equal(resolvePreset(db, hit.preset, prows, node(["pr1", "gadget"])).text, "7");
  const fixed = findChipPreset(pages, "pr2");
  assert.equal(presetKey(node(["pr2"]), fixed.preset), "Widget");
  assert.equal(resolvePreset(db, fixed.preset, prows, node(["pr2"])).text, "3");
  assert.equal(resolvePreset(db, hit.preset, prows, node(["pr1"])).state, "norow");
  assert.equal(resolvePreset(db, hit.preset, prows, node(["pr1", "Nope"])).state, "norow");
  hit.preset.colId = "s"; // editing the preset changes every chip
  assert.equal(resolvePreset(db, hit.preset, prows, node(["pr1", "Widget"])).text, "3");
  hit.preset.colId = "gone";
  assert.equal(resolvePreset(db, hit.preset, prows, node(["pr1", "Widget"])).state, "nocol");
  assert.equal(findChipPreset(pages, "deleted"), null);
  assert.equal(resolvePreset(null, null, prows, node(["pr1", "k"])).state, "nodb");
});
test("cleanChipPresets and newChipPreset", () => {
  const cols = pdb().columns;
  const out = cleanChipPresets([{ id: "a", name: "  ", colId: "p" }, { id: "a", name: "dup", colId: "p" }, { id: "b c", colId: "p" }, { id: "d", name: "D", colId: "zz" }, { id: "e", name: "E", colId: "n", key: " K " }, null, "x"], cols);
  assert.deepEqual(out, [{ id: "a", name: "Preset", colId: "p" }, { id: "e", name: "E", colId: "n", key: "K" }]);
  const p = newChipPreset("  My ", "p", "");
  assert.equal(p.name, "My");
  assert.ok(!("key" in p));
  assert.match(p.id, /^[A-Za-z0-9_-]+$/);
  assert.equal(listChipPresets([pdb(), { ...pdb(), id: "v", sourceId: "db1" }]).length, 2);
});
test("counting preset users across nested blocks", () => {
  const a = [{ id: "1", type: "p", text: "{{preset:pr1|A}} and {{preset:pr1|B}} {{preset:pr2}}" }, { id: "2", type: "toggle", text: "", children: [{ id: "3", type: "p", text: "{{preset:pr1|C}} `{{preset:pr1|D}}` \\{{preset:pr1|E}}" }] }];
  const b = [{ id: "4", type: "p", text: "{{value:db1|k|p}}" }];
  assert.equal(countChipPresetUsers([a, b], "pr1"), 3);
  assert.equal(countChipPresetUsers([a, b], "pr2"), 1);
  assert.equal(countChipPresetUsers([a, b], "none"), 0);
});
test("preset slash entries are inline-only and searchable", () => {
  const es = presetEntries(listChipPresets([pdb()]));
  assert.equal(es.length, 2);
  assert.ok(es.every((e) => e.inline === "preset" && e.label.startsWith("Preset: ")));
  assert.ok(!CATALOG.some((e) => e.presetId));
  assert.deepEqual(filterCatalog("widget", [...CATALOG, ...es]).map((e) => e.presetId), ["pr2"]);
  assert.ok(filterCatalog("preset", [...CATALOG, ...es]).length >= 2);
});
test("markdown export of preset chips", () => {
  const blocks = [{ id: "1", type: "p", text: "A {{preset:pr1|Widget}} B {{preset:pr2}} C {{preset:gone}}" }];
  const inline = (n) => n.kind === "preset" ? (n.args[0] === "pr1" ? "5" : null) : null;
  assert.equal(blocksToMarkdown(blocks, { inline }), "A 5 B Preset C Preset");
  assert.equal(blocksToMarkdown(blocks), "A Widget B Preset C Preset");
});
