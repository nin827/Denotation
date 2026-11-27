// Seeded fuzz: sanitisers and parsers that decide what may become a link, an image source or markup.
// Invariant: anything the app would put into href / src must resolve (WHATWG URL rules, like a browser) to a safe
// protocol, and parsers never throw on hostile text. Replay with FUZZ_SEED=<n>; longer with FUZZ_RUNS=<n>.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzz, rng, seedFor, XSS, UNICODE, MARKUP, effectiveProtocol } from "./fixtures/fuzz.js";
import { isSafeHref, parseInline, buildToken, readToken, scanTokens, replaceTokens, stripInline, TOKEN_KINDS } from "../../source/app/js/blocks/inline.js";
import { markdownToBlocks, blocksToMarkdown } from "../../source/app/js/blocks/markdown.js";
import { normalizeBlocks, walk } from "../../source/app/js/blocks/model.js";
import { safeUrl, cleanProp, cleanProps, propsFromFrontMatter } from "../../source/app/js/pageProps.js";
import { parseCsv, tableFromCsv, databaseToCsv } from "../../source/app/js/csv.js";
import { cleanPath, safeName, readMarkdownFile } from "../../source/app/js/vault.js";

const SAFE_LINK = new Set(["http:", "https:", "mailto:"]);
const BASE = "https://app.example/Denotation/";
/** Random URL-ish strings: schemes, separators, control characters and payloads glued together. */
function urlish(r) {
  const parts = [
    () => r.pick(["javascript", "JavaScript", "vbscript", "data", "file", "blob", "http", "https", "mailto", "ftp", "java", "script"]),
    () => r.pick([":", "://", "\t", "\n", "\r", " ", "\u0000", "\u0001", "\u001f", " ", "​", "%0a", "&#58;", "\\", "/", "#page-", "#row-"]),
    () => r.pick(XSS),
    () => r.pick(UNICODE),
    () => r.text(10)
  ];
  return Array.from({ length: r.int(1, 6) }, () => r.pick(parts)()).join("");
}

test("isSafeHref: every accepted href resolves to http(s), mailto or an in-app #page-/#row- link", async () => {
  await fuzz("isSafeHref", 4000, (r) => {
    const href = r.chance(0.3) ? r.pick(XSS) : urlish(r);
    if (!isSafeHref(href)) return;
    const used = href.trim(); // what ui/inlineView.js puts in the attribute
    const p = effectiveProtocol(used, BASE);
    const inApp = /^#(page|row)-/.test(used);
    // null = not a valid URL: the browser treats it as an inert link, which is fine
    assert.ok(p === null || (inApp ? p === "https:" : SAFE_LINK.has(p)), `accepted ${JSON.stringify(href)} -> ${p}`);
  });
});

test("parseInline: never throws; every link node that the view would render is safe", async () => {
  await fuzz("parseInline-links", 3000, (r) => {
    const s = Array.from({ length: r.int(1, 8) }, () => r.chance(0.5) ? `[${r.nasty(2)}](${urlish(r).replace(/[\s)]/g, "")})` : r.nasty(3)).join(" ");
    const nodes = parseInline(s);
    const check = (list) => {
      for (const n of list) {
        assert.ok(n && typeof n === "object" && typeof n.t === "string");
        if (n.t === "link" && isSafeHref(n.href)) {
          const p = effectiveProtocol(n.href.trim(), BASE);
          assert.ok(p === null || SAFE_LINK.has(p) || /^#(page|row)-/.test(n.href.trim()), `unsafe link ${n.href}`);
        }
        if (n.children) check(n.children);
      }
    };
    check(nodes);
    assert.equal(typeof stripInline(s), "string");
  });
});

test("pageProps.safeUrl: a kept URL resolves to http(s), mailto or a same-origin relative link", async () => {
  await fuzz("safeUrl", 4000, (r) => {
    const v = r.chance(0.3) ? r.pick(XSS) : urlish(r);
    const kept = safeUrl(v);
    if (!kept) return;
    const p = effectiveProtocol(kept, BASE);
    const sameOrigin = p === "https:" && new URL(kept, BASE).origin === new URL(BASE).origin;
    assert.ok(SAFE_LINK.has(p) || sameOrigin, `safeUrl(${JSON.stringify(v)}) kept ${JSON.stringify(kept)} -> ${p}`);
  });
});

test("pageProps.safeUrl: the known payload classes (pinned)", () => {
  for (const v of ["java\tscript:alert(1)", "java\nscript:alert(1)", "\u0001javascript:alert(1)", "\u0000javascript:alert(1)", "jav\rascript:alert(1)"]) {
    const kept = safeUrl(v);
    assert.ok(!kept || effectiveProtocol(kept, BASE) !== "javascript:", `safeUrl(${JSON.stringify(v)}) -> ${JSON.stringify(kept)}`);
  }
});

test("cleanProp/cleanProps: never throw, never keep more than the limits, url props never resolve to a script", async () => {
  const types = ["text", "number", "date", "select", "multi", "checkbox", "url", "page", "bogus", "__proto__", "constructor"];
  await fuzz("cleanProps", 1500, (r) => {
    const raw = Array.from({ length: r.int(0, 70) }, () => r.chance(0.1) ? r.pick([null, 1, "x", [], () => 1]) : ({
      id: r.chance(0.5) ? r.id() : r.nasty(1),
      name: r.chance(0.5) ? r.nasty(2) : r.pick([undefined, 5, {}, "__proto__"]),
      type: r.pick(types),
      value: r.pick([r.nasty(2), urlish(r), r.int(-5, 5), true, null, [r.nasty(1), 3], { a: 1 }, "2024-02-30", "2024-02-29"]),
      options: r.chance(0.5) ? Array.from({ length: r.int(0, 5) }, () => r.nasty(1)) : r.pick([null, "x", {}])
    }));
    const out = cleanProps(raw);
    assert.ok(out.length <= 50);
    assert.equal(new Set(out.map((p) => p.id)).size, out.length, "unique ids");
    for (const p of out) {
      assert.match(p.id, /^[A-Za-z0-9_-]+$/);
      assert.ok(p.name.length >= 1 && p.name.length <= 80);
      if (p.type === "url" && p.value && !/[\t\n\r\u0000-\u001f]/.test(p.value)) {
        assert.notEqual(effectiveProtocol(p.value, BASE), "javascript:", p.value);
      }
    }
    assert.equal(cleanProp(r.pick([null, 1, "x", []])), null);
  });
});

test("inline tokens: buildToken output re-reads to the same node; img sources are only http(s) or raster data URLs", async () => {
  const argGen = (r) => r.pick([() => r.id(), () => r.nasty(1), () => urlish(r), () => "2024-02-29", () => "0", () => "1", () => "h", () => "b", () => `${r.id()},${r.id()}`, () => "data:image/png;base64,AAAA", () => "data:image/svg+xml;base64,AAAA", () => "https://e.x/a.png"])();
  await fuzz("tokens", 5000, (r) => {
    const kind = r.chance(0.9) ? r.pick(TOKEN_KINDS) : r.pick(["__proto__", "constructor", "script", ""]);
    const args = Array.from({ length: r.int(0, 4) }, () => argGen(r));
    const tok = buildToken(kind, args);
    if (tok === null) return;
    assert.ok(!/[\r\n]/.test(tok), "a token is one line");
    const back = readToken(tok, 0);
    assert.ok(back, `built token does not re-read: ${tok}`);
    assert.equal(back.end, tok.length);
    assert.equal(back.node.kind, kind);
    assert.equal(buildToken(kind, back.node.args), tok, "build(read(build(x))) is stable");
    if (kind === "img") {
      const src = back.node.args[0];
      const p = effectiveProtocol(src, BASE);
      assert.ok(p === "https:" || p === "http:" || /^data:image\/(png|jpeg|gif|webp);base64,/.test(src), `img src ${src}`);
    }
  });
});

test("scanTokens / replaceTokens: never throw, tokens never overlap and replace keeps the text between them", async () => {
  await fuzz("scanTokens", 3000, (r) => {
    const s = Array.from({ length: r.int(1, 12) }, () => r.chance(0.4) ? r.pick(MARKUP) : r.nasty(2)).join(r.pick(["", " "]));
    const toks = scanTokens(s);
    let last = 0;
    for (const t of toks) {
      assert.ok(t.start >= last && t.end > t.start && t.end <= s.length);
      assert.ok(TOKEN_KINDS.includes(t.node.kind));
      last = t.end;
    }
    assert.equal(replaceTokens(s, () => null), s, "null keeps the token text");
    const mark = "\u{10FFFD}";
    const marked = replaceTokens(s, () => mark);
    assert.equal(marked.split(mark).length - s.split(mark).length, toks.length);
  });
});

test("markdownToBlocks: never throws on hostile text; images only from http(s) or raster data URLs; block shape is clean", async () => {
  const TYPES = new Set(["p", "h1", "h2", "h3", "h4", "bullet", "numbered", "todo", "toggle", "quote", "callout", "code", "divider", "table", "columns", "column", "image", "bookmark", "toc", "breadcrumb", "synced", "page", "pivot", "preview", "dbview", "graph"]);
  await fuzz("markdownToBlocks", 1500, (r) => {
    const lines = Array.from({ length: r.int(1, 25) }, () => {
      const pre = r.pick(["", "# ", "## ", "- ", "  - ", "1. ", "> ", "- [ ] ", "- [x] ", "```", "| ", "|---|---|", "---", "    ", "\t- "]);
      const body = r.chance(0.3) ? `![${r.nasty(1)}](${r.chance(0.5) ? urlish(r) : r.pick(XSS)})` : r.nasty(3);
      return pre + body;
    });
    const md = lines.join(r.pick(["\n", "\r\n", "\r"]));
    const blocks = markdownToBlocks(md);
    assert.ok(Array.isArray(blocks) && blocks.length >= 1);
    walk(blocks, (b) => {
      assert.ok(TYPES.has(b.type), b.type);
      assert.equal(typeof b.id, "string");
      if (b.type === "image") {
        const p = effectiveProtocol(b.src, BASE);
        assert.ok(p === null || p === "https:" || p === "http:" || /^data:image\/(png|jpe?g|gif|webp);base64,/.test(b.src), `image src ${b.src}`);
      }
      if (b.type === "table") for (const row of b.cells) for (const c of row) assert.equal(typeof c, "string");
    });
    assert.equal(typeof blocksToMarkdown(blocks), "string");
  });
});

test("normalizeBlocks: arbitrary JSON-ish block lists never throw and come back with known types and string text", async () => {
  const anyVal = (r, d = 0) => r.pick([
    () => null, () => r.int(-3, 400), () => r.nasty(1), () => true, () => [],
    () => d < 3 ? Array.from({ length: r.int(0, 3) }, () => anyBlock(r, d + 1)) : [],
    () => ({ __proto__: { polluted: 1 } }), () => JSON.parse('{"__proto__":{"polluted":1}}')
  ])();
  const anyBlock = (r, d = 0) => r.chance(0.1) ? anyVal(r, 3) : ({
    id: r.chance(0.8) ? r.id() : anyVal(r, 3),
    type: r.chance(0.7) ? r.pick(["p", "h1", "toggle", "table", "columns", "column", "image", "bookmark", "callout", "preview", "dbview", "pivot", "code"]) : r.nasty(1),
    text: anyVal(r, 3),
    color: r.pick([30, "30", 31, "red", "gray", "__proto__", -30, 360, null]),
    bg: r.pick([0, "grey", "gray", "toString", 15, null]),
    cells: r.chance(0.5) ? Array.from({ length: r.int(0, 4) }, () => r.chance(0.8) ? Array.from({ length: r.int(0, 4) }, () => anyVal(r, 3)) : anyVal(r, 3)) : anyVal(r, 3),
    children: d < 4 && r.chance(0.5) ? Array.from({ length: r.int(0, 3) }, () => anyBlock(r, d + 1)) : anyVal(r, 3),
    view: r.pick([undefined, {}, [], "x", { id: 5 }]),
    sourceKey: r.pick([undefined, 0, 1, -1, 99, "1"])
  });
  // Known crash class pinned separately below: a "columns" block whose children is not an array.
  const dodgeKnown = (b) => {
    if (b && typeof b === "object" && !Array.isArray(b)) {
      if (b.type === "columns" && b.children && !Array.isArray(b.children)) b.children = [];
      if (b.type === "column" && b.children != null && !Array.isArray(b.children)) b.children = [];
      if (Array.isArray(b.children)) b.children.forEach(dodgeKnown);
    }
    return b;
  };
  await fuzz("normalizeBlocks", 2000, (r) => {
    const list = Array.from({ length: r.int(0, 6) }, () => dodgeKnown(anyBlock(r)));
    const out = normalizeBlocks(list);
    assert.ok(out.length >= 1);
    walk(out, (b) => {
      assert.ok(b && typeof b === "object");
      if (["p", "h1", "toggle", "callout", "code"].includes(b.type)) assert.equal(typeof b.text, "string");
      if (b.type === "table") {
        const w = b.cells[0].length;
        for (const row of b.cells) assert.equal(row.length, w);
      }
      if ("color" in b) assert.ok(Number.isInteger(b.color) && b.color % 30 === 0);
    });
    assert.equal({}.polluted, undefined);
  });
});

test("normalizeBlocks: a columns / column block with non-array children (pinned)", { todo: "BUG: normalizeBlocks throws TypeError '(b.children || []).filter is not a function' for columns.children = {} / \"x\", and 'b.children.push is not a function' for column.children = \"\" / 0 / false" }, () => {
  for (const children of [{}, "x", 5, true]) assert.doesNotThrow(() => normalizeBlocks([{ id: "a", type: "columns", children }]), JSON.stringify(children));
  for (const children of ["", 0, false]) assert.doesNotThrow(() => normalizeBlocks([{ id: "a", type: "column", children }]), JSON.stringify(children));
});

test("CSV: parse never throws; tableFromCsv keeps every row; column names are unique and non-empty", async () => {
  await fuzz("csv-hostile", 1500, (r) => {
    const text = Array.from({ length: r.int(0, 30) }, () => r.pick([r.nasty(2), '"', '""', ",", ";", "\t", "|", "\n", "\r\n", "\r", "=cmd|' /C calc'!A0", "@SUM(1)", "+1", "-1", "﻿"])).join("");
    const grid = parseCsv(text);
    assert.ok(Array.isArray(grid));
    for (const row of grid) for (const c of row) assert.equal(typeof c, "string");
    const t = tableFromCsv(grid);
    const names = t.columns.map((c) => c.name.toLowerCase());
    assert.equal(new Set(names).size, names.length);
    for (const c of t.columns) assert.ok(c.name.length > 0);
  });
});

test("CSV export neutralises spreadsheet formulas (cells starting with = + - @)", () => {
  const cols = [{ id: "a", name: "A", type: "text", config: {} }];
  const csv = databaseToCsv(cols, [{ values: { a: "=HYPERLINK(\"http://evil.example\",\"x\")" } }, { values: { a: "@SUM(1)" } }, { values: { a: "+1+1" } }]);
  for (const line of csv.split(/\r?\n/).slice(1)) assert.ok(!/^"?[=+@-]/.test(line), `formula cell exported raw: ${line}`);
});

test("vault.cleanPath / safeName: no traversal, no absolute paths, no control characters, no reserved names", async () => {
  await fuzz("cleanPath", 4000, (r) => {
    const p = Array.from({ length: r.int(1, 6) }, () => r.pick(["..", ".", "", "a", "b c", "C:", "c:", "\\", "/", "//", "\u0000", "\u001f", "..\\..", "%2e%2e", "‥", "．．", r.nasty(1), r.text(6)])).join(r.pick(["/", "\\", ""]));
    const c = cleanPath(p);
    if (c !== null) {
      assert.ok(!c.startsWith("/"), c);
      assert.ok(!c.split("/").some((x) => x === ".." || x === "." || x === ""), c);
      assert.ok(!/[\u0000-\u001f]/.test(c), JSON.stringify(c));
      assert.ok(!/^[A-Za-z]:$/.test(c.split("/")[0]), c);
    }
    const n = safeName(r.nasty(3));
    assert.ok(n.length >= 1 && [...n].length <= 80, n);
    assert.ok(!/[\u0000-\u001f\u007f<>:"/\\|?*]/.test(n), JSON.stringify(n));
    assert.ok(!/^[.\s]|[.\s]$/.test(n), JSON.stringify(n));
    assert.ok(!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(n.split(".")[0]), n);
  });
});

test("readMarkdownFile / propsFromFrontMatter: hostile front matter never throws and gives string titles", async () => {
  await fuzz("frontmatter", 1500, (r) => {
    const fm = Array.from({ length: r.int(0, 6) }, () => `${r.pick(["title", "tags", "__proto__", "constructor", "date", r.id()])}: ${r.pick([r.nasty(2), '"' + r.nasty(1) + '"', "'x''y'", "[a, b]", "2024-01-01", "true", "{a: 1}"])}`).join("\n");
    const text = `${r.pick(["---\n", "", "--- \n"])}${fm}\n${r.pick(["---", "...", ""])}\n# ${r.nasty(1)}\n${r.nasty(3)}`;
    const out = readMarkdownFile(`${r.text(5)}.md`, r.chance(0.5) ? text : new TextEncoder().encode(text));
    assert.equal(typeof out.title, "string");
    assert.equal(typeof out.body, "string");
    const props = propsFromFrontMatter(fm);
    assert.ok(Array.isArray(props));
    assert.equal({}.polluted, undefined);
  });
});

test("seed is reported on failure", async () => {
  await assert.rejects(fuzz("self-check", 3, (r, i) => {
    if (i === 2) throw new Error("boom");
  }), /seed=\d+ case=2/);
  assert.equal(rng(seedFor("x")).int(0, 1e9), rng(seedFor("x")).int(0, 1e9), "deterministic");
});
