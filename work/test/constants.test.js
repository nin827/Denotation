import test from "node:test";
import assert from "node:assert/strict";
import {
  parseInline, stripInline, buildToken, readToken, scanTokens, replaceTokens, tokenFallback, replaceNthToken
} from "../../source/app/js/blocks/inline.js";
import { blocksToMarkdown } from "../../source/app/js/blocks/markdown.js";
import {
  cleanConstants, cleanStatuses, statusList, findRepo, constantByName, constantResolver, constantValue, formatConstant,
  nameTaken, countTokenUsers, coerceValue, DEFAULT_STATUSES
} from "../../source/app/js/constants.js";
import { applyFormulas, evalExpression, formulaRefs, check, setConstantsProvider, lookupError } from "../../source/app/js/formula.js";

const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const ALPHA = ["a", "B", "7", " ", "|", "}", "{", "\\", ":", "*", "_", "`", "[", "]", "(", ")", "é", "-", "!", "#", "=", '"'];
const randStr = (r, n) => Array.from({ length: 1 + Math.floor(r() * n) }, () => ALPHA[Math.floor(r() * ALPHA.length)]).join("");

// ---------- tokens ----------
test("new token kinds parse", () => {
  assert.deepEqual(parseInline("{{const:c1}}")[0], { t: "inline", kind: "const", args: ["c1"] });
  assert.deepEqual(parseInline("{{page:p-2}}")[0], { t: "inline", kind: "page", args: ["p-2"] });
  assert.deepEqual(parseInline("{{status:todo}}")[0], { t: "inline", kind: "status", args: ["todo"] });
  assert.deepEqual(parseInline("{{check:1}}")[0].args, ["1"]);
  assert.deepEqual(parseInline("{{= 2030 - foundedyear}}")[0], { t: "inline", kind: "formula", args: ["2030 - foundedyear"] });
});
test("invalid new tokens stay literal", () => {
  for (const s of ["{{check:2}}", "{{check:}}", "{{check:1|0}}", "{{const:a b}}", "{{page:<x>}}", "{{status:}}", "{{=}}", "{{=   }}", "{{= 1+1}", "{{formula:1+1}}", "{{const:a|b}}"]) {
    const n = parseInline(s);
    assert.ok(n.every((x) => x.t === "text"), s);
    assert.equal(n.map((x) => x.v).join(""), s);
  }
});
test("formula token escapes } and \\, keeps | and : literal", () => {
  const expr = 'IF(a=1, "x}}y", "p|q:r\\")';
  const t = buildToken("formula", [expr]);
  assert.ok(t.startsWith("{{= "));
  const node = parseInline(`a ${t} b`)[1];
  assert.equal(node.kind, "formula");
  assert.equal(node.args[0], expr);
});
test("formula token inside code span and escaped stays text", () => {
  assert.equal(scanTokens("`{{= 1+1}}`").length, 0);
  assert.equal(scanTokens("\\{{= 1+1}}").length, 0);
});
test("fallback text and strip", () => {
  assert.equal(stripInline("a {{check:1}} b {{check:0}}"), "a [x] b [ ]");
  assert.equal(stripInline("x {{= 1+2}}"), "x 1+2");
  assert.equal(stripInline("{{const:c1}}", () => "2029"), "2029");
  assert.equal(tokenFallback({ kind: "status", args: ["x"] }), "Status");
});
test("markdown export uses ctx.inline for resolved text", () => {
  const blocks = [{ id: "a", type: "p", text: "Founded {{const:c1}} {{check:1}} {{status:s}} {{= 1+1}}" }];
  const md = blocksToMarkdown(blocks, { inline: (n) => n.kind === "const" ? "2029" : n.kind === "status" ? "Doing" : n.kind === "formula" ? "2" : null });
  assert.equal(md.trim(), "Founded 2029 [x] Doing 2");
});
test("replaceNthToken edits only the chosen token of a kind", () => {
  const s = "{{check:0}} a {{status:x}} {{check:0}} `{{check:0}}` {{check:1}}";
  assert.equal(replaceNthToken(s, "check", 1, "{{check:1}}"), "{{check:0}} a {{status:x}} {{check:1}} `{{check:0}}` {{check:1}}");
  assert.equal(replaceNthToken(s, "check", 2, "{{check:0}}"), "{{check:0}} a {{status:x}} {{check:0}} `{{check:0}}` {{check:0}}");
  assert.equal(replaceNthToken(s, "check", 3, "x"), null);
  assert.equal(replaceNthToken(s, "status", 0, "{{status:y}}").includes("{{status:y}}"), true);
});
test("seeded fuzz: build -> parse round trip for every new kind", () => {
  const r = rng(7);
  for (let i = 0; i < 600; i++) {
    const expr = randStr(r, 30).trim() || "1";
    const t = buildToken("formula", [expr]);
    if (!t) continue; // e.g. a lone backslash trimmed away
    const got = parseInline(`pre ${t} post`);
    const tok = got.find((n) => n.t === "inline");
    assert.ok(tok, `${JSON.stringify(expr)} -> ${t}`);
    assert.equal(tok.args[0], expr);
    assert.equal(got.filter((n) => n.t === "inline").length, 1);
  }
  const id = "Ab-9_" + "x".repeat(10);
  for (const kind of ["const", "page", "status"]) {
    const t = buildToken(kind, [id]);
    assert.deepEqual(parseInline(t)[0].args, [id]);
    assert.equal(buildToken(kind, ["bad id"]), null);
  }
  for (const v of ["0", "1"]) assert.equal(parseInline(buildToken("check", [v]))[0].args[0], v);
  assert.equal(buildToken("check", ["2"]), null);
});
test("seeded fuzz: random text never throws and tokens never overlap", () => {
  const r = rng(99);
  const pieces = ["{{= ", "{{check:1}}", "{{const:a}}", "}}", "{{", "`", "\\", "|", "{{status:s}}", "x", " ", "{{page:p}}"];
  for (let i = 0; i < 500; i++) {
    const s = Array.from({ length: 1 + Math.floor(r() * 14) }, () => pieces[Math.floor(r() * pieces.length)]).join("");
    const toks = scanTokens(s);
    let last = 0;
    for (const t of toks) {
      assert.ok(t.start >= last && t.end > t.start);
      last = t.end;
    }
    stripInline(s);
    replaceTokens(s, () => "·");
  }
});

// ---------- constants ----------
const repo = { id: "r", type: "repo", constants: [
  { id: "c1", name: "foundedyear", type: "number", value: 2029 },
  { id: "c2", name: "Launch", type: "date", value: "2030-03-04", format: { style: "long" } },
  { id: "c3", name: "motto", type: "text", value: "Be kind" },
  { id: "c4", name: "price", type: "number", value: 1234.5, format: { decimals: 2, thousands: true } }
] };
test("cleanConstants validates names, types and values", () => {
  const out = cleanConstants([
    { id: "a", name: "ok_1", type: "number", value: "12" },
    { id: "b", name: "OK_1", type: "text", value: "dup name (case-insensitive)" },
    { id: "c", name: "bad name", type: "text", value: "x" },
    { id: "a", name: "other", type: "text", value: "dup id" },
    { id: "d", name: "when", type: "date", value: "2026-02-30" },
    { id: "e", name: "t", type: "weird", value: 5 }
  ]);
  assert.deepEqual(out.map((c) => c.name), ["ok_1", "when", "t"]);
  assert.equal(out[0].value, 12);
  assert.equal(out[1].value, "");
  assert.equal(out[2].type, "text");
  assert.equal(nameTaken(out, "OK_1"), true);
  assert.equal(nameTaken(out, "ok_1", "a"), false);
});
test("typed values and formats", () => {
  assert.equal(constantValue(repo.constants[0]), 2029);
  assert.equal(formatConstant(repo.constants[0]), "2029"); // no thousands separator by default
  assert.equal(formatConstant(repo.constants[3]), "1,234.50");
  assert.match(formatConstant(repo.constants[1]), /March 2030/);
  assert.equal(constantValue(repo.constants[1]), "2030-03-04");
  assert.equal(coerceValue("number", "1,5"), 15);
  assert.equal(coerceValue("number", "abc"), null);
});
test("findRepo walks ancestors, rows (db id) and falls back to the first live repo", () => {
  const pages = [{ id: "r", type: "repo" }, { id: "r2", type: "repo", constants: [] }, { id: "d", type: "doc", parentId: "r2" }, { id: "x", type: "doc", parentId: "d" }, { id: "loose", type: "doc", parentId: null }];
  assert.equal(findRepo(pages, "x").id, "r2");
  assert.equal(findRepo(pages, "loose").id, "r");
  assert.equal(findRepo(pages, "nope").id, "r");
  assert.equal(findRepo([{ id: "q", type: "doc" }], "q"), null);
  assert.equal(findRepo([{ id: "r", type: "repo", trashedAt: 1 }], "r"), null);
});
test("statuses default and clean", () => {
  assert.deepEqual(statusList({}).map((s) => s.label), ["Todo", "Doing", "Done"]);
  assert.deepEqual(statusList({ statuses: [] }), []);
  const out = cleanStatuses([{ id: "a", label: " A ", hue: 31 }, { id: "a", label: "dup", hue: 0 }, { id: "b", label: "", hue: 0 }, { id: "c", label: "C", hue: "x" }]);
  assert.deepEqual(out, [{ id: "a", label: "A", hue: 30 }, { id: "c", label: "C", hue: 210 }]);
  assert.equal(DEFAULT_STATUSES.length, 3);
});
test("countTokenUsers counts nested blocks", () => {
  const blocks = [{ text: "{{const:c1}} {{const:c1}}", children: [{ text: "x {{const:c1}} {{const:c2}}" }] }, { text: "{{status:c1}}" }];
  assert.equal(countTokenUsers([blocks], "const", "c1"), 3);
  assert.equal(countTokenUsers([blocks], "status", "c1"), 1);
});

// ---------- formulas ----------
const env = () => ({ constant: constantResolver(repo) });
test("bare names and const() resolve constants, typed", () => {
  assert.equal(evalExpression("2030 - foundedyear", env()).value, 1);
  assert.equal(evalExpression("2030 - FoundedYear", env()).value, 1);
  assert.equal(evalExpression('const("foundedyear") + 1', env()).value, 2030);
  assert.equal(evalExpression('const("motto") & "!"', env()).value, "Be kind!");
  assert.equal(evalExpression("launch + 1", env()).value, "2030-03-05");
  assert.equal(evalExpression('const("my-const")', { constant: (n) => n === "my-const" ? 5 : void 0 }).value, 5);
});
test("unknown constants and bare words error with #NAME?", () => {
  const r = evalExpression("nope + 1", env());
  assert.equal(r.ok, false);
  assert.equal(r.error, "#NAME?");
  assert.match(r.detail, /nope/);
  assert.equal(evalExpression('const("nope")', env()).error, "#NAME?");
  assert.equal(evalExpression("foundedyear + 1", {}).error, "#NAME?"); // no repository
  assert.equal(evalExpression("TRUE").value, true);
});
test("expression errors are reported, not thrown", () => {
  assert.equal(evalExpression("1/0").error, "#DIV/0!");
  assert.equal(evalExpression("1 +").ok, false);
  assert.equal(evalExpression("[Col]").error, "#REF!");
  assert.equal(evalExpression("").ok, false);
});
test("value() and preset() lookups go through the env; VALUE(text) still converts", () => {
  const e = {
    value: (db, key, col) => {
      if (key === "none") throw lookupError("#N/A", "no row");
      return `${db}/${key}/${col}`.length;
    },
    preset: (name, key) => name === "Price" ? (key === "w" ? 10 : 0) : 0
  };
  assert.equal(evalExpression('value("d","k","c") * 2', e).value, 2 * "d/k/c".length);
  assert.equal(evalExpression('value("d","none","c")', e).error, "#N/A");
  assert.equal(evalExpression('preset("Price","w") + 1', e).value, 11);
  assert.equal(evalExpression('VALUE("12")', e).value, 12);
  assert.equal(evalExpression('value("d","k","c")', {}).error, "#NAME?");
  const refs = formulaRefs('value("d","k","c") + preset("P","x") + preset("Q")');
  assert.deepEqual(refs.values, [["d", "k", "c"]]);
  assert.deepEqual(refs.presets, [["P", "x"], ["Q", null]]);
  assert.equal(formulaRefs('value(a,"k","c")').nonLiteral, true);
});
test("no eval: dangerous looking input is just a syntax or name error", () => {
  for (const s of ["constructor", "__proto__", "this.constructor", 'const("constructor")', "process.exit()", "globalThis"]) {
    const r = evalExpression(s, env());
    assert.equal(r.ok, false, s);
  }
  assert.equal(check("a.b").ok, true); // parses; evaluates to #NAME?
});
test("database formulas resolve constants through the provider by dbId", () => {
  setConstantsProvider((dbId) => dbId === "db1" ? constantResolver(repo) : null);
  const columns = [{ id: "n", name: "N", type: "number" }, { id: "f", name: "Age", type: "formula", config: { expr: "foundedyear - [N]" } }, { id: "g", name: "Bad", type: "formula", config: { expr: "missing + 1" } }];
  const rows = [{ id: "r1", dbId: "db1", values: { n: 2000 } }];
  applyFormulas(columns, rows);
  assert.equal(rows[0].values.f, 29);
  assert.equal(rows[0].values.g, "#NAME?");
  const other = [{ id: "r2", dbId: "db2", values: { n: 2000 } }];
  applyFormulas(columns, other);
  assert.equal(other[0].values.f, "#NAME?");
  const viaOpts = [{ id: "r3", dbId: "db2", values: { n: 1 } }];
  applyFormulas(columns, viaOpts, { constants: (n) => n === "foundedyear" ? 5 : void 0 });
  assert.equal(viaOpts[0].values.f, 4);
  setConstantsProvider(null);
});
test("constantByName is case-insensitive", () => {
  assert.equal(constantByName(repo, "FOUNDEDYEAR").id, "c1");
  assert.equal(constantByName(repo, "zzz"), null);
});
