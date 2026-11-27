// Seeded fuzz: round trips and their invariants. Markdown blocks -> md -> blocks (idempotent after one
// normalisation), CSV export -> parse (lossless for text), inline tokens, wiki syntax <-> link tokens, Custom-column
// type text (parseType/formatType) and values (validate/clamp/defaultFor), cell text (toText/fromText).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzz, XSS, UNICODE, MARKUP } from "./fixtures/fuzz.js";
import { markdownToBlocks, blocksToMarkdown } from "../../source/app/js/blocks/markdown.js";
import { newBlock, plainText } from "../../source/app/js/blocks/model.js";
import { parseCsv, databaseToCsv, tableFromCsv, csvSafeCell } from "../../source/app/js/csv.js";
import { buildToken, scanTokens, stripInline, parseInline } from "../../source/app/js/blocks/inline.js";
import { parseWikiSyntax, toWikiSyntax, makeTitleResolver, extractLinks } from "../../source/app/js/links.js";
import { parseType, formatType, validate, clamp, defaultFor, specAt, leafPaths, summary } from "../../source/app/js/typespec.js";
import { toText, fromText } from "../../source/app/js/dbviews.js";

const plainish = (r, max = 30) => r.text(max, [..."abc XYZ 123 ,.;:!?-'\"()é☃"]);

/** A random block tree that markdown can express. */
function randomBlocks(r, depth = 0) {
  return Array.from({ length: r.int(1, 6) }, () => {
    const type = r.pick(["p", "h1", "h2", "h3", "h4", "bullet", "numbered", "todo", "quote", "code", "divider", "table"]);
    // Leading block markers are pinned separately (they are not escaped on export): keep them out of the text here.
    const text = (r.chance(0.7) ? plainish(r) : r.nasty(2)).replace(/^[\s>#*+\-\d.|`"]+/, "").replace(/\n[\s>#*+\-\d.|`]*/g, " ").replace(/[\u2028\u2029]/g, "");
    if (type === "table") {
      const b = newBlock("table", { rows: r.int(1, 4), cols: r.int(1, 4) });
      b.cells = b.cells.map((row) => row.map(() => plainish(r, 8)));
      return b;
    }
    const b = newBlock(type, type === "divider" ? {} : { text, ...(type === "todo" ? { checked: r.chance(0.5) } : {}) });
    if (depth < 2 && ["bullet", "numbered", "todo"].includes(type) && r.chance(0.3)) {
      b.children = randomBlocks(r, depth + 1).filter((c) => ["bullet", "numbered", "todo"].includes(c.type));
    }
    return b;
  });
}
const strip = (blocks) => JSON.parse(JSON.stringify(blocks, (k, v) => (k === "id" ? undefined : v)));

test("markdown: md -> blocks -> md is idempotent after one normalisation (random block trees)", async () => {
  await fuzz("md-idempotent", 800, (r) => {
    const md1 = blocksToMarkdown(randomBlocks(r));
    const b2 = markdownToBlocks(md1);
    const md2 = blocksToMarkdown(b2);
    const b3 = markdownToBlocks(md2);
    const md3 = blocksToMarkdown(b3);
    assert.equal(md3, md2, `not stable:\n--- md1\n${JSON.stringify(md1)}\n--- b2\n${JSON.stringify(b2.map((b) => [b.type, b.text, b.children?.length]))}\n--- md2\n${md2}\n--- md3\n${md3}`);
    assert.deepEqual(strip(b3), strip(b2));
  });
});

test("markdown: hostile text is idempotent after one normalisation too", { todo: "BUG (low): blocksToMarkdown doesn't escape block markers ('>', '#', '- ', '1. ') at the start of paragraph text and markdownToBlocks trims indentation, so md -> blocks -> md changes block types on the second pass" }, async () => {
  await fuzz("md-idempotent-hostile", 800, (r) => {
    const md0 = Array.from({ length: r.int(1, 12) }, () => r.pick(["", "# ", "- ", "  - ", "1. ", "> ", "- [ ] ", "| ", "    "]) + (r.chance(0.5) ? r.pick(MARKUP) : r.nasty(2))).join("\n");
    const md1 = blocksToMarkdown(markdownToBlocks(md0));
    const md2 = blocksToMarkdown(markdownToBlocks(md1));
    assert.equal(md2, md1, `not stable:\n--- md0\n${md0}\n--- md1\n${md1}\n--- md2\n${md2}`);
  });
});

test("markdown: plain paragraph text survives (no silent data loss for ordinary words)", async () => {
  await fuzz("md-paragraph", 1500, (r) => {
    const words = Array.from({ length: r.int(1, 8) }, () => r.text(8, [..."abcdefgXYZ0123é"])).filter(Boolean);
    if (!words.length) return;
    const text = words.join(" ");
    const back = markdownToBlocks(blocksToMarkdown([newBlock("p", { text })]));
    assert.equal(plainText(back).trim(), text);
  });
});

test("markdown: a paragraph that starts with a block marker stays a paragraph (pinned)", { todo: "BUG (low): '> x' / '# x' / '1. x' paragraph text becomes a quote / heading / list after export + import" }, () => {
  for (const text of ["> not a quote", "# not a heading", "1. not a list", "- not a bullet", "---"]) {
    const back = markdownToBlocks(blocksToMarkdown([newBlock("p", { text })]));
    assert.deepEqual(back.map((b) => [b.type, b.text]), [["p", text]], text);
  }
});

test("markdown: list items and headings whose text holds U+2028/U+2029 keep their type (pinned)", { todo: "BUG (low): markdownToBlocks list/heading regexes use (.*)$ and '.' stops at U+2028/U+2029, so '1. a\u2028' imports as a paragraph" }, () => {
  for (const [md, type] of [["1. a\u2028b", "numbered"], ["- a\u2029", "bullet"], ["## a\u2028", "h2"]]) {
    assert.equal(markdownToBlocks(md)[0].type, type, JSON.stringify(md));
  }
});

test("CSV: text tables survive export -> parse exactly (quotes, delimiters, newlines, leading spaces)", async () => {
  await fuzz("csv-roundtrip", 1500, (r) => {
    const w = r.int(1, 5);
    const cols = Array.from({ length: w }, (_, i) => ({ id: `c${i}`, name: `Col ${i}`, type: "text", config: {} }));
    const cell = () => r.pick([plainish(r, 12), '"', '""', ",", ";", "\t", "|", "a\nb", " lead", "trail ", "", "=1+1", r.pick(XSS), r.pick(UNICODE).replace(/\r/g, "")]);
    const rows = Array.from({ length: r.int(0, 8) }, () => ({ values: Object.fromEntries(cols.map((c) => [c.id, cell()])) }));
    const csv = databaseToCsv(cols, rows);
    const grid = parseCsv(csv, ",");
    // cells a spreadsheet would run as a formula are exported with a leading ' (see fuzz-xss)
    const want = [cols.map((c) => c.name), ...rows.map((x) => cols.map((c) => csvSafeCell(x.values[c.id])))];
    // a row that is one empty cell is written as "" and reads back as [""]
    assert.deepEqual(grid, want.map((row) => (row.length === 1 && row[0] === "" ? [""] : row)));
  });
});

test("CSV: a lone carriage return inside a quoted cell survives", { todo: "BUG (low): parseCsv turns \\r inside quoted cells into \\n (whole-text \\r\\n? -> \\n before parsing)" }, () => {
  const cols = [{ id: "a", name: "A", type: "text", config: {} }];
  const csv = databaseToCsv(cols, [{ values: { a: "x\ry" } }]);
  assert.deepEqual(parseCsv(csv, ","), [["A"], ["x\ry"]]);
});

test("CSV: the delimiter sniffer and type guesser never lose cells", async () => {
  await fuzz("csv-sniff", 800, (r) => {
    const d = r.pick([",", ";", "\t", "|"]);
    const w = r.int(2, 5);
    const lines = Array.from({ length: r.int(2, 10) }, () => Array.from({ length: w }, () => r.pick([String(r.int(-99, 99)), "true", "2024-01-31", plainish(r, 6).replace(/[,;\t|"\n]/g, "")])).join(d));
    const grid = parseCsv(lines.join("\n"));
    assert.equal(grid.length, lines.length);
    for (const row of grid) assert.equal(row.length, w, `sniffed the wrong delimiter for ${JSON.stringify(d)}`);
    const t = tableFromCsv(grid);
    const nonBlank = grid.filter((row) => row.some((c) => c.trim() !== ""));
    assert.equal(t.rows.length, Math.max(0, nonBlank.length - 1), "blank lines are dropped, nothing else");
  });
});

test("inline tokens inside text: build -> scan finds each token exactly once and strip never throws", async () => {
  const kinds = [["date", () => ["2024-02-29"]], ["check", (r) => [r.pick(["0", "1"])]], ["link", (r) => [r.id()]], ["value", (r) => [r.id(), r.nasty(1).slice(0, 50).replace(/[\r\n]/g, " ").trim() || "k", r.id()]], ["formula", (r) => [r.pick(["1+1", "SUM(1,2)", "\"}}\"", "a\\b"])]], ["embed", (r) => [r.id(), "b", `${r.id()},${r.id()}x`]]];
  await fuzz("tokens-in-text", 2000, (r) => {
    const built = [];
    let s = "";
    for (let i = 0; i < r.int(1, 6); i++) {
      const [kind, args] = r.pick(kinds);
      const tok = buildToken(kind, args(r));
      if (tok) built.push(tok);
      // filler that cannot start or swallow a token: no braces, backticks or backslashes
      s += plainish(r, 10).replace(/[{}`\\]/g, "") + (tok ?? "");
    }
    const found = scanTokens(s).map((t) => s.slice(t.start, t.end));
    assert.deepEqual(found, built);
    assert.equal(typeof stripInline(s), "string");
  });
});

test("inline tokens: the renderer (parseInline) sees every token scanTokens sees, whatever emphasis surrounds it", async () => {
  // Emphasis markers in the filler, but none inside a token: this part holds today.
  await fuzz("tokens-vs-render", 1500, (r) => {
    const toks = [buildToken("date", ["2024-02-29"]), buildToken("link", [r.id().replace(/_/g, "x")]), buildToken("check", ["1"]), buildToken("formula", ["1+1"])];
    const s = Array.from({ length: r.int(1, 6) }, () => r.pick(["*", "**", "_", "~~", " ", "a", "b ", "[x](https://e.x) ", ...toks])).join("");
    const flat = (ns) => ns.flatMap((x) => [x, ...flat(x.children ?? [])]);
    const rendered = flat(parseInline(s)).filter((n) => n.t === "inline").length;
    const scanned = scanTokens(s).length;
    assert.equal(rendered, scanned, JSON.stringify(s));
  });
});

test("inline tokens: emphasis markers inside a token don't close emphasis opened before it (pinned)", { todo: "BUG (medium-low): blocks/inline.js findClose doesn't skip {{…}} tokens or code spans, so '*note {{= 2*3}} x' renders the formula as broken text ('note {{= 2' in italics) while scanTokens / search / extractLinks still see the token; same for '_' in token args ('x _y {{value:db|a_ b|c}}', ids like a_)" }, () => {
  for (const s of ["*note: {{= 2*3}} and more", "x _y {{value:db|a_ b|c}}", "~~a {{= \"~~\"}}", "*a `b*` c*"]) {
    const flat = (ns) => ns.flatMap((x) => [x, ...flat(x.children ?? [])]);
    const nodes = flat(parseInline(s));
    assert.equal(nodes.filter((n) => n.t === "inline" || n.t === "code").length, scanTokens(s).length + (s.includes("`") ? 1 : 0), s);
  }
});

test("wiki syntax: toWikiSyntax output parses back to exactly the stored tokens (with a resolver)", async () => {
  await fuzz("wiki-roundtrip", 800, (r) => {
    const pages = Array.from({ length: r.int(1, 8) }, (_, i) => ({
      id: `pg${i}${r.id(3)}`,
      title: r.pick([plainish(r, 12), `Same`, `same `, r.nasty(1), "a|b", "x]y", "{{z}}", "Title"]),
      blocks: [{ id: `h${i}`, type: "h2", text: r.pick(["Intro", "Intro", plainish(r, 8)]) }, { id: `b${i}`, type: "p", text: "body" }]
    }));
    const resolve = makeTitleResolver(pages);
    const parts = Array.from({ length: r.int(1, 6) }, () => {
      const p = r.pick(pages);
      const tok = r.pick([
        () => buildToken("link", [p.id]),
        () => buildToken("xlink", [p.id]),
        () => buildToken("embed", [p.id, "h", `h${pages.indexOf(p)}`]),
        () => buildToken("embed", [p.id, "b", `b${pages.indexOf(p)}`])
      ])();
      return r.pick(["", " ", "x", "!", "word ", "\n"]) + tok + r.pick(["", " ", ".", "]]"]);
    });
    const stored = parts.join("");
    const typed = toWikiSyntax(stored, pages, resolve);
    const back = parseWikiSyntax(typed, resolve);
    assert.equal(back.text, stored, `typed: ${typed}`);
    // extractLinks sees every page reference
    const links = extractLinks({ id: "src", blocks: [{ id: "x", type: "p", text: stored }] });
    assert.equal(links.length, scanTokens(stored).length);
  });
});

test("wiki syntax: typed text with unknown or ambiguous titles is left exactly as typed", async () => {
  await fuzz("wiki-unresolved", 1500, (r) => {
    const pages = [{ id: "a1", title: "Dup" }, { id: "a2", title: "dup" }, { id: "b1", title: "Solo", blocks: [{ id: "h1", type: "h1", text: "H" }] }];
    const text = Array.from({ length: r.int(1, 6) }, () => r.pick(["[[Dup]]", "[[Nope]]", "![[Solo][Nope]]", "![[Solo](zz)]", "x[[Dup]]", "[[", "]]", "[[Solo]]", r.nasty(1)])).join(r.pick(["", " "]));
    const res = parseWikiSyntax(text, makeTitleResolver(pages));
    const unresolvedLeft = res.text.replace(/\{\{(x?link|embed):[^}]*\}\}/g, "");
    assert.ok(!/\{\{(x?link|embed):(a1|a2)\b/.test(res.text), "an ambiguous title was resolved without a choice");
    assert.equal(typeof unresolvedLeft, "string");
    for (const e of [...res.ambiguous, ...res.unresolved]) assert.equal(res.text.slice(e.start, e.end), e.raw);
  });
});

/** A random type spec, built as text so it is exactly what a user could type. */
function randomType(r, depth = 0) {
  const leaf = () => r.pick(["String", "bool", "int", "float", "any", "int(0..10)", "float(-1.5..2.5)", "int(..5)", "float(3..)", `("a", "b c", "d\\"e")`, "Dictionary", "Array"]);
  if (depth > 2 || r.chance(0.4)) return leaf();
  return r.pick([
    () => `Array[${randomType(r, depth + 1)}]`,
    () => `Dictionary[${randomType(r, depth + 1)}]`,
    () => `Dictionary{${[...new Set(Array.from({ length: r.int(1, 3) }, () => r.pick(["name", "hp", "x-y", "\"with space\"", "__proto__", "n2"])))].map((k) => `${k}: ${randomType(r, depth + 1)}`).join(", ")}}`,
    () => [...new Set(Array.from({ length: r.int(2, 3) }, () => r.pick(["String", "int", "bool", "Array[int]", "Dictionary{a: int}"])))].join(" | ")
  ])();
}
const randomValue = (r, depth = 0) => r.pick([
  () => null, () => r.int(-20, 20), () => r.float() * 10 - 5, () => r.pick(["a", "b c", "", "x"]), () => r.chance(0.5),
  () => (depth < 3 ? Array.from({ length: r.int(0, 3) }, () => randomValue(r, depth + 1)) : []),
  () => (depth < 3 ? Object.fromEntries(Array.from({ length: r.int(0, 3) }, () => [r.pick(["name", "hp", "x-y", "with space", "n2", "zz"]), randomValue(r, depth + 1)])) : {})
])();

test("typespec: parseType(formatType(spec)) gives the same spec; formatType is canonical", async () => {
  await fuzz("typespec-roundtrip", 1500, (r) => {
    const text = randomType(r);
    const p = parseType(text);
    if (!p.ok) return; // e.g. a union that repeats an alternative
    const canon = formatType(p.spec);
    const q = parseType(canon);
    assert.ok(q.ok, `canonical text does not parse: ${canon} (${q.error})`);
    assert.deepEqual(q.spec, p.spec, canon);
    assert.equal(formatType(q.spec), canon);
  });
});

test("typespec: defaults validate, clamp is idempotent and never adds issues, summaries are short", async () => {
  await fuzz("typespec-values", 2500, (r) => {
    const p = parseType(randomType(r));
    if (!p.ok) return;
    const spec = p.spec;
    assert.deepEqual(validate(spec, defaultFor(spec)), [], formatType(spec));
    const v = randomValue(r);
    const c = clamp(spec, v);
    assert.deepEqual(clamp(spec, c), c, "clamp is idempotent");
    assert.ok(validate(spec, c).length <= validate(spec, v).length, "clamp never adds issues");
    assert.ok(summary(spec, v, 60).length <= 60);
    for (const { path, spec: s } of leafPaths(spec)) assert.ok(specAt(spec, path), `${path} -> ${s?.kind}`);
  });
});

test("typespec: garbage type text returns { ok: false } and never throws", async () => {
  await fuzz("typespec-garbage", 3000, (r) => {
    const text = Array.from({ length: r.int(0, 12) }, () => r.pick(["Array", "[", "]", "{", "}", "(", ")", "..", ",", ":", "|", "\"", "'", "int", "Dictionary", "a", " ", "\\", "-1", "1e999", r.nasty(1)])).join("");
    const p = parseType(text);
    assert.equal(typeof p.ok, "boolean");
    if (!p.ok) assert.equal(typeof p.error, "string");
  });
});

test("typespec: deeply nested type text returns { ok: false } instead of throwing RangeError", { todo: "BUG: parseType only catches its own errors; 'Array[' x 20000 throws RangeError (stack overflow) to the caller (specOf in views/filters)" }, () => {
  const text = "Array[".repeat(20000) + "int" + "]".repeat(20000);
  assert.doesNotThrow(() => parseType(text));
});

test("cell text: fromText(toText(v)) gives v back for valid scalar cells", async () => {
  await fuzz("cell-text", 3000, (r) => {
    const type = r.pick(["text", "checkbox", "date", "select", "array"]);
    const col = { id: "c", name: "C", type, config: { options: ["a", "b"] } };
    const v = {
      text: () => r.nasty(2),
      checkbox: () => r.chance(0.5),
      date: () => r.pick(["2024-01-31", "1999-12-31", null]),
      select: () => r.pick(["a", "b", null]),
      array: () => Array.from({ length: r.int(1, 3) }, () => plainish(r, 5).replace(/,/g, "").trim()).filter(Boolean)
    }[type]();
    if (Array.isArray(v) && !v.length) return;
    const back = fromText(col, toText(col, v));
    assert.deepEqual(back, v ?? (type === "text" ? "" : null), `${type}: ${JSON.stringify(v)}`);
  });
});
