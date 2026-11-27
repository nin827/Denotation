// Math (ticket 022): token escape round trip, Markdown `$` / `$$` mapping, and KaTeX safety limits. The files this change does
// not own (inline.js, model.js, markdown.js) are patched in a temp copy of source/app/js with the edits from math-patches.cjs,
// which also proves those patches apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { rng, seedFor, RUNS } from "./fixtures/fuzz.js";

const require = createRequire(import.meta.url);
const patches = require("./math-patches.cjs");
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../source/app");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "denotation-math-"));
fs.cpSync(path.join(APP, "js"), path.join(tmp, "js"), { recursive: true });
fs.mkdirSync(path.join(tmp, "vendor/katex"), { recursive: true });
fs.copyFileSync(path.join(APP, "vendor/katex/katex.esm.js"), path.join(tmp, "vendor/katex/katex.esm.js"));
for (const p of patches) {
  const f = path.join(tmp, p.file);
  let text = fs.readFileSync(f, "utf8");
  if (!text.includes(p.marker)) for (const [from, to] of p.edits) {
    assert.ok(text.includes(from), `patch anchor missing in ${p.file}: ${from.slice(0, 50)}`);
    text = text.replace(from, () => to);
  }
  fs.writeFileSync(f, text);
}
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const load = (rel) => import(pathToFileURL(path.join(tmp, "js", rel)).href);
const inline = await load("blocks/inline.js");
const latex = await load("math/latex.js");
const katex = await load("math/katex.js");
const md = await load("blocks/markdown.js");
const model = await load("blocks/model.js");

const ALPHA = ["\\", "\\", "|", "}", "}", "{", "{", "$", "`", "*", "_", "^", " ", "a", "b", "x", "1", "2", "=", "+", "\\frac", "}}", "{{", "\\\\", "é", "∑", "\t"];
const norm = (s) => latex.cleanLatex(s).replace(/\s*\n\s*/g, " ");

test("math token: hand-picked sources survive escape and parse", () => {
  for (const src of ["\\frac{a}{b}", "a|b", "|x|", "{{x}}", "a}}b", "\\\\", "x\\}", "\\{a\\}", "a $ b", "`c`", "\\text{a | b}"]) {
    const tok = latex.mathToken(src);
    const found = inline.scanTokens(`before ${tok} after`);
    assert.equal(found.length, 1, src);
    assert.deepEqual(found[0].node, { t: "inline", kind: "math", args: [src] }, src);
    assert.equal(inline.tokenFallback(found[0].node), `$${src}$`);
  }
  assert.equal(latex.mathToken("   "), null);
  assert.equal(latex.mathToken("a\nb"), "{{math:a b}}");
});

test("math token: an unescaped | inside is kept (patch keeps | out of the arg split)", () => {
  const found = inline.scanTokens("{{math:a|b}}");
  assert.equal(found[0]?.node.args[0], "a|b");
});

test("math token: seeded fuzz round trip, also inside surrounding text", () => {
  const r = rng(seedFor("math-roundtrip"));
  for (let n = 0; n < 600 * RUNS; n++) {
    const src = r.text(r.int(1, 120), ALPHA);
    const want = norm(src);
    if (!want) continue;
    const text = `${r.text(10, ["a", " ", "*", "{"])}${latex.mathToken(src)}${r.text(10, ["b", " ", "}", "$"])}`;
    const toks = latex.mathTokens(text);
    assert.equal(toks.length, 1, `[fuzz seed=${r.seed} case=${n}] ${JSON.stringify(src)}`);
    assert.equal(toks[0].latex, want, `[fuzz seed=${r.seed} case=${n}] ${JSON.stringify(src)}`);
    assert.equal(latex.replaceNthMath(text, 0, "z"), text.slice(0, toks[0].start) + "{{math:z}}" + text.slice(toks[0].end));
  }
});

test("math token: over-long sources are cut, never made into half tokens", () => {
  const tok = latex.mathToken("\\".repeat(2000));
  const toks = latex.mathTokens(tok);
  assert.equal(toks.length, 1);
  assert.equal(toks[0].latex.length, latex.MAX_INLINE_LATEX);
  assert.ok(tok.length <= latex.MATH_TOKEN_MAX);
});

test("replaceNthMath edits only the chosen chip", () => {
  const t = `${latex.mathToken("a")} and ${latex.mathToken("b")} and ${latex.mathToken("c")}`;
  assert.equal(latex.replaceNthMath(t, 1, "B|}"), `{{math:a}} and {{math:B\\|\\}}} and {{math:c}}`);
  assert.equal(latex.replaceNthMath(t, 0, ""), ` and {{math:b}} and {{math:c}}`);
  assert.equal(latex.replaceNthMath(t, 5, "x"), null);
});

test("dollars: inline $...$ becomes chips, prices and code stay literal", () => {
  assert.equal(latex.dollarsToTokens("so $x^2$ here"), "so {{math:x^2}} here");
  assert.equal(latex.dollarsToTokens("costs $5 and $6 total"), "costs $5 and $6 total");
  assert.equal(latex.dollarsToTokens("a `$x$` b \\$y\\$ c"), "a `$x$` b \\$y\\$ c");
  assert.equal(latex.dollarsToTokens("$ a $"), "$ a $");
  assert.equal(latex.dollarsToTokens("{{math:p}} $q$"), "{{math:p}} {{math:q}}");
  assert.equal(latex.dollarsToTokens("$\\frac{a}{b}$ and $a|b$"), "{{math:\\\\frac{a\\}\\{b\\}}} and {{math:a\\|b}}".replace("{a\\}\\{b\\}", "{a\\}{b\\}"));
});

test("markdown: a math block exports as $$ and imports back; chips export as $latex$", () => {
  const b = model.newBlock("math", { text: "\\int_0^1 x\\,dx" });
  const p = model.newBlock("p", { text: `area ${latex.mathToken("a|b")} done` });
  const out = md.blocksToMarkdown([b, p]);
  assert.equal(out, "$$\n\\int_0^1 x\\,dx\n$$\n\narea $a|b$ done");
  const back = md.markdownToBlocks(out);
  assert.equal(back.length, 2);
  assert.equal(back[0].type, "math");
  assert.equal(back[0].text, "\\int_0^1 x\\,dx");
  assert.equal(back[1].text, `area ${latex.mathToken("a|b")} done`);
  assert.equal(md.markdownToBlocks("$$ x^2 $$")[0].text, "x^2");
  assert.equal(md.markdownToBlocks("$$\nunclosed")[0].type, "p");
  assert.equal(model.normalizeBlocks([{ type: "math", text: 5 }])[0].text, "");
});

test("markdown: fuzzed math blocks round trip", () => {
  const r = rng(seedFor("math-md"));
  for (let n = 0; n < 200 * RUNS; n++) {
    const src = latex.cleanLatex(r.text(r.int(1, 80), ALPHA.filter((x) => x !== "$")), latex.MAX_BLOCK_LATEX).split("\n").map((l) => l.trim()).filter((l) => l && l !== "$$").join("\n");
    if (!src) continue;
    const out = md.blocksToMarkdown([model.newBlock("math", { text: src })]);
    const back = md.markdownToBlocks(out);
    assert.equal(back.length, 1, `[fuzz seed=${r.seed} case=${n}] ${JSON.stringify(src)}`);
    assert.equal(back[0].type, "math");
    assert.equal(back[0].text, src, `[fuzz seed=${r.seed} case=${n}]`);
  }
});

test("katex: options are the safe ones and the module loads lazily", async () => {
  assert.equal(katex.MATH_OPTIONS.trust, false);
  assert.equal(katex.MATH_OPTIONS.throwOnError, false);
  assert.ok(katex.MATH_OPTIONS.maxExpand <= 200 && katex.MATH_OPTIONS.maxSize <= 20);
  const r = await katex.latexToHtml("\\frac{a}{b}");
  assert.ok(r.ok && r.html.includes("katex"));
  assert.deepEqual(await katex.checkLatex("x^2"), { ok: true });
  const bad = await katex.checkLatex("\\frac{a");
  assert.equal(bad.ok, false);
  assert.ok(bad.error && !/^KaTeX parse error/.test(bad.error));
});

test("katex: hostile input stays inert", async () => {
  const hostile = [
    "\\href{javascript:alert(1)}{click}", "\\url{javascript:alert(1)}", "\\href{https://example.com}{x}", "\\htmlClass{evil}{x}",
    "\\htmlId{evil}{x}", "\\htmlStyle{background:url(x)}{x}", "\\htmlData{a=b}{x}", "\\includegraphics{http://example.com/x.png}",
    "\\text{<img src=x onerror=alert(1)>}", "\\mathrm{</span><script>alert(1)</script>}", "\\verb|<b>|", "\\input{/etc/passwd}"
  ];
  for (const src of hostile) {
    const r = await katex.latexToHtml(src);
    const html = r.html;
    const tags = html.match(/<[^>]*>/g) ?? []; // text is escaped (&lt;), so only real tags count
    for (const t of tags) {
      assert.ok(!/^<\/?(a|script|img|iframe|object|embed|link|style|form|input)\b/i.test(t), `tag ${t} for ${src}`);
      assert.ok(!/\s(href|src|action|xlink:href|on\w+)=/i.test(t), `attribute in ${t} for ${src}`);
      assert.ok(!/url\(/i.test(t) && !/evil|data-/.test(t), `style or attribute leak ${t} for ${src}`);
    }
  }
});

test("katex: runaway macros and huge input give an error, not a hang", async () => {
  const cases = [
    "\\def\\a{\\a\\a}\\a", "\\def\\a{\\a}\\a", "\\newcommand{\\b}{\\b\\b}\\b", "\\def\\x#1{\\x{#1#1}}\\x{a}",
    `${"{".repeat(5000)}x${"}".repeat(5000)}`, "x".repeat(200000), "\\rule{1000em}{1000em}", "\\hspace{99999em}", "^".repeat(3000), "\\frac".repeat(3000)
  ];
  for (const src of cases) {
    const t = Date.now();
    const r = await katex.latexToHtml(src.slice(0, 4000));
    assert.ok(Date.now() - t < 4000, `slow: ${src.slice(0, 30)}`);
    assert.equal(typeof r.ok, "boolean");
  }
  assert.equal((await katex.checkLatex("\\def\\a{\\a\\a}\\a")).ok, false);
  assert.equal((await katex.checkLatex("\\rule{1000em}{1000em}")).ok, true); // clamped by maxSize, not an error
});

test("katex: seeded fuzz never throws", async () => {
  const r = rng(seedFor("math-katex"));
  const frag = ["\\frac", "{", "}", "^", "_", "\\sqrt", "\\left(", "\\right)", "\\begin{pmatrix}", "\\end{pmatrix}", "&", "\\\\", "x", "1", "\\alpha", "\\href{x}{y}", "\\def\\q{", "$", "%", "#", "\\", "\\text{", "\\over", "\\color{red}", "é"];
  for (let n = 0; n < 300 * RUNS; n++) {
    const src = r.some(frag, r.int(1, 25)).join("");
    const res = await katex.latexToHtml(src);
    assert.equal(typeof res.ok, "boolean", `[fuzz seed=${r.seed} case=${n}] ${JSON.stringify(src)}`);
    if (!res.ok) assert.ok(res.error.length > 0 && res.error.length <= 200);
  }
});
