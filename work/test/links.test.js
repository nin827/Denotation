import test from "node:test";
import assert from "node:assert/strict";
import { parseInline, stripInline, buildToken, readToken, scanTokens, tokenFallback } from "../../source/app/js/blocks/inline.js";
import { blocksToMarkdown } from "../../source/app/js/blocks/markdown.js";
import {
  normTitle, makeTitleResolver, parseWikiSyntax, toWikiSyntax, extractLinks, uniqueEdges, parseEmbed, embedKey,
  resolveEmbed, embedChain, detectCycle, embedCycleFrom, exportInline, exportCtx, embedMarkdown, embedPlainText, linkMarkdown,
  wikiTrigger, rankPages, headingList, blockChoices
} from "../../source/app/js/links.js";

const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const pick = (r, a) => a[Math.floor(r() * a.length)];
const B = (id, type, text, extra = {}) => ({ id, type, text, ...extra });
const P = (id, title, blocks = []) => ({ id, title, blocks });

// ---------- token grammar ----------
test("link / xlink tokens build, read and fall back", () => {
  assert.equal(buildToken("link", ["abc-1"]), "{{link:abc-1}}");
  assert.equal(buildToken("xlink", ["abc_1"]), "{{xlink:abc_1}}");
  assert.deepEqual(parseInline("a {{link:p1}} b")[1], { t: "inline", kind: "link", args: ["p1"] });
  assert.equal(tokenFallback({ kind: "link", args: ["p1"] }), "Page");
  assert.equal(tokenFallback({ kind: "xlink", args: ["p1"] }), "Page");
  assert.equal(stripInline("see {{link:p1}}"), "see Page");
  assert.equal(buildToken("link", ["a b"]), null);
  assert.equal(buildToken("link", ["a".repeat(65)]), null);
  assert.equal(buildToken("link", ["a".repeat(64)]).length, 7 + 64 + 2);
  for (const bad of ["{{link:}}", "{{link:a|b}}", "{{link:a b}}", "{{xlink:<x>}}", "{{link:a", "{{link}}"]) {
    assert.ok(parseInline(bad).every((n) => n.t === "text"), bad);
  }
});
test("embed tokens: heading and block forms, validation", () => {
  assert.equal(buildToken("embed", ["p1", "h", "b1"]), "{{embed:p1|h|b1}}");
  assert.equal(buildToken("embed", ["p1", "b", "b1,b2,b3"]), "{{embed:p1|b|b1,b2,b3}}");
  assert.deepEqual(readToken("{{embed:p1|b|b1,b2}}", 0).node.args, ["p1", "b", "b1,b2"]);
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  assert.ok(buildToken("embed", [uuid, "b", Array(12).fill(uuid).map((u, i) => u.slice(0, -2) + String(10 + i)).join(",")]));
  assert.equal(buildToken("embed", ["p", "b", Array(13).fill("a").map((x, i) => x + i).join(",")]), null);
  for (const args of [["p", "h"], ["p", "x", "b"], ["p", "h", "a,b"], ["p", "b", ""], ["p", "b", "a,,b"], ["p", "b", "a,a"], ["p q", "h", "b"], ["p", "h", "b", "c"], ["p", "b", "a b"]]) {
    assert.equal(buildToken("embed", args), null, JSON.stringify(args));
  }
  // every token read from text stays inside the length limit the reader enforces
  const long = buildToken("embed", [uuid, "b", Array.from({ length: 12 }, (_, i) => `${uuid.slice(0, -2)}${10 + i}`).join(",")]);
  assert.ok(long.length < 600);
  assert.equal(readToken(long, 0).end, long.length);
  assert.equal(stripInline("x {{embed:p|h|b}} y"), "x Embed y");
});
test("old forms still work next to the new ones", () => {
  const n = parseInline("[Mention](#page-p1) {{page:p1}} {{link:p1}}");
  assert.deepEqual(n.map((x) => x.t), ["link", "text", "inline", "text", "inline"]);
  assert.equal(n[0].href, "#page-p1");
});
test("tokens inside code spans and after a backslash are not links", () => {
  assert.equal(scanTokens("`{{link:p1}}` \\{{link:p1}}").length, 0);
});

// ---------- typed syntax ----------
const PAGES = [
  P("a1", "Alpha", [B("h-intro", "h2", "Intro"), B("p1", "p", "x"), B("h-sub", "h3", "Intro"), B("t1", "toggle", "T", { children: [B("c1", "p", "kid")] })]),
  P("b1", "Beta Page"),
  P("d1", "Dup"),
  P("d2", "dup ", [B("hh", "h1", "One"), B("hh2", "h2", "One")]),
  P("e1", "Heads", [B("e-h1", "h1", "Same"), B("e-h2", "h1", "same")])
];
const R = makeTitleResolver(PAGES);
const conv = (s) => parseWikiSyntax(s, R);

test("[[Title]] resolves case-insensitively, trimmed and whitespace-collapsed", () => {
  assert.equal(conv("see [[alpha]]!").text, "see {{link:a1}}!");
  assert.equal(conv("[[  BETA   page ]]").text, "{{link:b1}}");
  assert.equal(normTitle("  A  B\n"), "a b");
});
test("x[[Title]] is a hidden link at a word boundary; elsewhere the x is text", () => {
  assert.equal(conv("x[[Alpha]]").text, "{{xlink:a1}}");
  assert.equal(conv("see x[[Alpha]]").text, "see {{xlink:a1}}");
  assert.equal(conv("(x[[Alpha]])").text, "({{xlink:a1}})");
  assert.equal(conv("box[[Alpha]]").text, "box{{link:a1}}");
  assert.equal(conv("xx[[Alpha]]").text, "xx{{link:a1}}");
  assert.equal(conv("éx[[Alpha]]").text, "éx{{link:a1}}");
  assert.equal(conv("x_[[Alpha]]").text, "x_{{link:a1}}");
  assert.equal(conv("X[[Alpha]]").text, "X{{link:a1}}"); // only a lowercase x is the marker
});
test("![[Title]] is a plain link", () => {
  assert.equal(conv("![[Alpha]]").text, "{{link:a1}}");
});
test("![[Title][Heading]] and ![[Title](blocks)]", () => {
  assert.equal(conv("![[Alpha][ intro ]]").text, "![[Alpha][ intro ]]"); // two headings named Intro: ambiguous
  assert.equal(conv("![[Alpha][Intro]]").ambiguous[0].what, "heading");
  const one = parseWikiSyntax("![[Heads][nothing]] ![[Beta Page][x]]", R);
  assert.equal(one.text, "![[Heads][nothing]] ![[Beta Page][x]]");
  assert.deepEqual(one.unresolved.map((u) => u.what), ["heading", "heading"]);
  assert.equal(parseWikiSyntax("![[Dup][One]]", () => PAGES[3]).ambiguous[0].what, "heading");
  const pages = [P("p", "Doc", [B("h1id", "h1", "Top"), B("kid", "p", "q")])];
  assert.equal(parseWikiSyntax("![[Doc][top]]", makeTitleResolver(pages)).text, "{{embed:p|h|h1id}}");
  assert.equal(parseWikiSyntax("![[Doc](kid, h1id)]", makeTitleResolver(pages)).text, "{{embed:p|b|kid,h1id}}");
  assert.equal(parseWikiSyntax("![[Doc](kid,kid)]", makeTitleResolver(pages)).text, "{{embed:p|b|kid}}");
  const miss = parseWikiSyntax("![[Doc](kid,nope)]", makeTitleResolver(pages));
  assert.equal(miss.text, "![[Doc](kid,nope)]");
  assert.equal(miss.unresolved[0].what, "block");
  // an embed needs the page's blocks from the resolver
  assert.equal(parseWikiSyntax("![[Doc][Top]]", () => ({ id: "p", title: "Doc" })).replaced, 0);
});
test("ambiguous titles are reported with candidates and stay as typed", () => {
  const r = conv("a [[dup]] b");
  assert.equal(r.text, "a [[dup]] b");
  assert.equal(r.replaced, 0);
  assert.equal(r.ambiguous.length, 1);
  assert.deepEqual(r.ambiguous[0].options.map((o) => o.id), ["d1", "d2"]);
  assert.equal(r.text.slice(r.ambiguous[0].start, r.ambiguous[0].end), "[[dup]]");
  // positions refer to the returned text even after earlier conversions shorten it
  const r2 = conv("[[Alpha]] and [[dup]]");
  assert.equal(r2.text.slice(r2.ambiguous[0].start, r2.ambiguous[0].end), "[[dup]]");
  // a picker answer settles it
  const r3 = parseWikiSyntax("[[dup]]", R, { choose: () => "d2" });
  assert.equal(r3.text, "{{link:d2}}");
  assert.equal(r3.ambiguous.length, 0);
  assert.equal(parseWikiSyntax("[[dup]]", R, { choose: () => "nope" }).text, "[[dup]]");
  const h = parseWikiSyntax("![[Dup][one]]", (t) => (normTitle(t) === "dup" ? PAGES[3] : null), { choose: (e) => (e.what === "heading" ? "hh2" : null) });
  assert.equal(h.text, "{{embed:d2|h|hh2}}");
});
test("unknown titles stay typed and are reported", () => {
  const r = conv("[[Nowhere]] [[Alpha]]");
  assert.equal(r.text, "[[Nowhere]] {{link:a1}}");
  assert.equal(r.unresolved.length, 1);
  assert.equal(r.text.slice(r.unresolved[0].start, r.unresolved[0].end), "[[Nowhere]]");
});
test("escapes, code spans, existing tokens and look-alikes are left alone", () => {
  for (const s of ["\\[[Alpha]]", "`[[Alpha]]`", "{{date:2026-01-01}} `a` [ [Alpha] ]", "[[]]", "[[ ]]", "[[Alpha]", "[Alpha]]", "[[Al[pha]]", "[[Alpha\nBeta]]", "[[Alpha{x}]]"]) {
    assert.equal(conv(s).text, s, s);
  }
  assert.equal(conv("\\\\[[Alpha]]").text, "\\\\{{link:a1}}"); // escaped backslash, live link
  assert.equal(conv("`a` [[Alpha]] `b`").text, "`a` {{link:a1}} `b`");
  assert.equal(conv("{{value:db|[[Alpha]]|c}}").text, "{{value:db|[[Alpha]]|c}}");
  assert.equal(conv("[[Alpha]][[Beta Page]]").text, "{{link:a1}}{{link:b1}}");
  assert.equal(conv("[[[Alpha]]]").text, "[{{link:a1}}]");
  assert.equal(conv("!!![[Alpha]]").text, "!!{{link:a1}}");
  assert.equal(conv("").text, "");
  assert.equal(parseWikiSyntax(null, R).text, "");
  assert.equal(parseWikiSyntax("[[Alpha]]", null).text, "[[Alpha]]");
});
test("a stored link keeps pointing at the page after a rename", () => {
  const s = conv("[[Alpha]]").text;
  const renamed = makeTitleResolver([P("a1", "Renamed")]);
  assert.equal(toWikiSyntax(s, [P("a1", "Renamed")], renamed), "[[Renamed]]");
  assert.equal(s, "{{link:a1}}");
});

test("toWikiSyntax writes current titles and keeps what it cannot write safely", () => {
  assert.equal(toWikiSyntax("a {{link:a1}} b {{xlink:b1}}", PAGES, R), "a [[Alpha]] b x[[Beta Page]]");
  assert.equal(toWikiSyntax("{{embed:a1|h|h-intro}}", PAGES, R), "{{embed:a1|h|h-intro}}"); // "Intro" is ambiguous in a1
  assert.equal(toWikiSyntax("{{embed:e1|h|e-h1}}", PAGES, R), "{{embed:e1|h|e-h1}}");
  assert.equal(toWikiSyntax("{{embed:a1|b|p1,c1}}", PAGES, R), "![[Alpha](p1,c1)]");
  assert.equal(toWikiSyntax("{{embed:a1|b|p1,zz}}", PAGES, R), "{{embed:a1|b|p1,zz}}");
  assert.equal(toWikiSyntax("{{link:d1}}", PAGES, R), "{{link:d1}}"); // ambiguous title
  assert.equal(toWikiSyntax("{{link:gone}}", PAGES, R), "{{link:gone}}");
  assert.equal(toWikiSyntax("{{link:a1}}", [P("a1", "Bad [title]")], null), "{{link:a1}}");
  assert.equal(toWikiSyntax("{{link:a1}}", [P("a1", "Has `tick`")], null), "{{link:a1}}");
  assert.equal(toWikiSyntax("{{link:a1}}", [P("a1", "   ")], null), "{{link:a1}}");
  assert.equal(toWikiSyntax("`{{link:a1}}`", PAGES, R), "`{{link:a1}}`");
  const pages = [P("p", "Doc", [B("hd", "h1", "Top"), B("k", "p", "q")])];
  const rs = makeTitleResolver(pages);
  assert.equal(toWikiSyntax("{{embed:p|h|hd}}", pages, rs), "![[Doc][Top]]");
  // neighbours that would change the meaning of the typed form
  assert.equal(toWikiSyntax("!{{link:p}}", pages, rs), "!{{link:p}}");
  assert.equal(toWikiSyntax("x{{link:p}}", pages, rs), "x{{link:p}}");
  assert.equal(toWikiSyntax("ox{{link:p}}", pages, rs), "ox[[Doc]]");
  assert.equal(toWikiSyntax("ax{{xlink:p}}", pages, rs), "ax{{xlink:p}}");
  assert.equal(toWikiSyntax("a {{xlink:p}}", pages, rs), "a x[[Doc]]");
  assert.equal(toWikiSyntax("{{link:p}}x{{link:p}}", pages, rs), "[[Doc]]x{{link:p}}");
});

// A random page set with unique titles, then random text of tokens and look-alike junk.
const JUNK = ["x", "!", "[", "]", "[[", "]]", "(", ")", "{", "}", "{{", "}}", "`", "\\", " ", "ab", "é", "_", "|", ":", "Doc", "*", "\n", "[[Nope]]", "x[[Nope]]", "![[Nope][h]]", "{{date:2026-01-01}}", "{{=", "{{value:a|", "|c}}"];
test("seeded fuzz: toWikiSyntax then parseWikiSyntax restores the exact text", () => {
  const r = rng(20260301);
  let converted = 0;
  let kept = 0;
  for (let n = 0; n < 4000; n++) {
    const pages = [
      P("p1", "Alpha", [B("h1", "h1", "Top"), B("b1", "p", "one"), B("b2", "p", "two", { children: [B("b3", "p", "three")] })]),
      P("p2", "Beta two", [B("h2", "h2", "Sub"), B("h3", "h3", "Sub 2")]),
      P("p3", "Gamma", [])
    ];
    const resolve = makeTitleResolver(pages);
    const toks = ["{{link:p1}}", "{{link:p2}}", "{{xlink:p3}}", "{{xlink:p1}}", "{{embed:p1|h|h1}}", "{{embed:p2|h|h2}}", "{{embed:p1|b|b1,b3}}", "{{embed:p2|b|h3}}", "{{link:gone}}", "{{embed:p1|h|nope}}"];
    const text = Array.from({ length: 1 + Math.floor(r() * 7) }, () => (r() < 0.45 ? pick(r, toks) : pick(r, JUNK))).join("");
    const typed = toWikiSyntax(text, pages, resolve);
    const back = parseWikiSyntax(typed, resolve).text;
    assert.equal(back, text, `${JSON.stringify(text)} -> ${JSON.stringify(typed)}`);
    if (typed !== text) converted++;
    else if (/\{\{(x?link|embed)/.test(text)) kept++;
    // idempotence of both directions
    assert.equal(parseWikiSyntax(back, resolve).text, back);
    assert.equal(toWikiSyntax(typed, pages, resolve), typed);
  }
  assert.ok(converted > 1500, `only ${converted} conversions exercised`);
  assert.ok(kept > 100);
});
test("seeded fuzz: parseWikiSyntax never throws, output keeps untouched text, results are valid tokens", () => {
  const r = rng(77);
  const resolve = makeTitleResolver(PAGES);
  const bits = ["[[Alpha]]", "x[[Alpha]]", "![[Alpha]]", "![[Alpha][Intro]]", "![[Heads][same]]", "![[Alpha](p1)]", "[[dup]]", "[[zzz]]", ...JUNK];
  for (let n = 0; n < 3000; n++) {
    const text = Array.from({ length: 1 + Math.floor(r() * 8) }, () => pick(r, bits)).join("");
    const out = parseWikiSyntax(text, resolve);
    assert.equal(typeof out.text, "string");
    for (const e of [...out.ambiguous, ...out.unresolved]) assert.equal(out.text.slice(e.start, e.end), e.raw);
    for (const t of scanTokens(out.text)) assert.ok(buildToken(t.node.kind, t.node.args), out.text);
    assert.equal(parseWikiSyntax(out.text, resolve).replaced, 0, `not idempotent: ${JSON.stringify(text)} -> ${JSON.stringify(out.text)}`);
    if (out.replaced === 0) assert.equal(out.text, text);
  }
});

// ---------- extractLinks ----------
test("extractLinks walks nested blocks, cells, callouts, toggles; counts chips and markdown links", () => {
  const page = {
    id: "src",
    blocks: [
      B("b1", "p", "a {{link:t1}} b {{xlink:t2}} {{page:t3}} [md](#page-t4) [web](https://x.y) [row](#row-r1)"),
      B("b2", "toggle", "{{link:t5}}", { children: [B("b3", "callout", "{{embed:t6|h|hx}}", { children: [B("b4", "bullet", "**[bold](#page-t7)**")] })] }),
      { id: "b5", type: "columns", children: [{ id: "c1", type: "column", children: [B("b6", "p", "{{link:t8}}")] }, { id: "c2", type: "column", children: [B("b7", "p", "{{embed:t9|b|q1,q2}}")] }] },
      { id: "b8", type: "table", cells: [["h", "{{link:t10}}"], ["[x](#page-t11)", ""]] },
      B("b9", "code", "{{link:no}} [x](#page-no)"),
      B("b10", "p", "`{{link:no2}}` \\{{link:no3}} \\[x](#page-no4)"),
      { id: "b11", type: "page", ref: "sub" }
    ]
  };
  const l = extractLinks(page);
  const key = (x) => `${x.to}:${x.kind}:${x.hidden ? "h" : "n"}:${x.via}:${x.blockId}`;
  assert.deepEqual(l.map(key), [
    "t1:link:n:link:b1", "t2:link:h:xlink:b1", "t3:link:n:chip:b1", "t4:link:n:md:b1",
    "t5:link:n:link:b2", "t6:embed:n:embed:b3", "t7:link:n:md:b4", "t8:link:n:link:b6", "t9:embed:n:embed:b7",
    "t10:link:n:link:b8", "t11:link:n:md:b8"
  ]);
  assert.ok(l.every((x) => x.from === "src"));
  assert.deepEqual(extractLinks(null), []);
  assert.deepEqual(extractLinks({ id: "x" }), []);
  assert.deepEqual(extractLinks({ id: "x", blocks: [null, 5, { id: "q", type: "p", text: 4 }, { id: "z", type: "table", cells: "no" }] }), []);
});
test("uniqueEdges: hidden only if every occurrence is hidden", () => {
  const e = uniqueEdges(extractLinks({ id: "s", blocks: [B("a", "p", "x[[A]]"), B("b", "p", "{{xlink:t}} {{xlink:t}}"), B("c", "p", "{{xlink:u}} {{link:u}} {{embed:t|h|z}}")] }));
  const m = Object.fromEntries(e.map((x) => [`${x.to}:${x.kind}`, x]));
  assert.equal(m["t:link"].hidden, true);
  assert.equal(m["t:link"].count, 2);
  assert.equal(m["u:link"].hidden, false);
  assert.equal(m["t:embed"].kind, "embed");
});
test("extractLinks is consistent with the typed syntax", () => {
  const p = P("src", "S", [B("a", "p", parseWikiSyntax("x[[Alpha]] [[Beta Page]] ![[Alpha](p1)]", R).text)]);
  assert.deepEqual(extractLinks(p).map((x) => [x.to, x.hidden, x.kind]), [["a1", true, "link"], ["b1", false, "link"], ["a1", false, "embed"]]);
});

// ---------- resolveEmbed ----------
const DOC = P("doc", "Doc", [
  B("i1", "p", "intro"),
  B("h1a", "h1", "A"),
  B("a1", "p", "a1"),
  B("h2a", "h2", "A.1"),
  B("a2", "p", "a2"),
  B("h3a", "h3", "A.1.1"),
  B("a3", "p", "a3"),
  B("h2b", "h2", "A.2"),
  B("a4", "p", "a4"),
  B("h1b", "h1", "B"),
  B("b1", "p", "b1"),
  B("th", "h2", "Fold", { fold: true, open: true, children: [B("k1", "p", "k1"), B("k2", "h1", "inner h1")] }),
  B("after", "p", "after fold"),
  B("tg", "toggle", "T", { children: [B("hh", "h2", "nested"), B("n1", "p", "n1"), B("hh2", "h2", "nested 2"), B("n2", "p", "n2")] })
]);
const ids = (r) => r.blocks.map((b) => b.id);
test("heading section: following blocks until a heading of the same or higher level", () => {
  const sec = (hid) => resolveEmbed([DOC], `{{embed:doc|h|${hid}}}`);
  assert.deepEqual(ids(sec("h1a")), ["h1a", "a1", "h2a", "a2", "h3a", "a3", "h2b", "a4"]);
  assert.deepEqual(ids(sec("h2a")), ["h2a", "a2", "h3a", "a3"]);
  assert.deepEqual(ids(sec("h3a")), ["h3a", "a3"]);
  assert.deepEqual(ids(sec("h2b")), ["h2b", "a4"]);
  assert.deepEqual(ids(sec("h1b")), ["h1b", "b1", "th", "after", "tg"]);
  assert.equal(sec("h1a").ok, true);
  assert.equal(sec("h1a").error, null);
});
test("toggle heading keeps its children; nested headings section within their own list", () => {
  const r = resolveEmbed([DOC], "{{embed:doc|h|th}}");
  assert.deepEqual(ids(r), ["th", "after", "tg"].slice(0, 3));
  assert.deepEqual(r.blocks[0].children.map((c) => c.id), ["k1", "k2"]);
  assert.deepEqual(ids(resolveEmbed([DOC], "{{embed:doc|h|hh}}")), ["hh", "n1"]);
  assert.deepEqual(ids(resolveEmbed([DOC], "{{embed:doc|h|hh2}}")), ["hh2", "n2"]);
  assert.deepEqual(ids(resolveEmbed([DOC], "{{embed:doc|h|k2}}")), ["k2"]);
});
test("chosen blocks keep the chosen order, any block can be picked", () => {
  assert.deepEqual(ids(resolveEmbed(new Map([["doc", DOC]]), "{{embed:doc|b|b1,i1,k1,tg}}")), ["b1", "i1", "k1", "tg"]);
  assert.deepEqual(ids(resolveEmbed({ doc: DOC }, { kind: "embed", args: ["doc", "b", "a2"] })), ["a2"]);
  assert.deepEqual(ids(resolveEmbed((id) => (id === "doc" ? DOC : null), "{{embed:doc|b|a2}}")), ["a2"]);
});
test("typed errors", () => {
  assert.equal(resolveEmbed([DOC], "{{embed:nope|h|x}}").error.code, "no-page");
  assert.equal(resolveEmbed([DOC], "{{embed:doc|h|zzz}}").error.code, "no-heading");
  assert.equal(resolveEmbed([DOC], "{{embed:doc|h|a1}}").error.code, "not-heading");
  const r = resolveEmbed([DOC], "{{embed:doc|b|a1,zz,a2,yy}}");
  assert.equal(r.error.code, "no-block");
  assert.deepEqual(r.error.missing, ["zz", "yy"]);
  assert.deepEqual(ids(r), ["a1", "a2"]);
  assert.equal(r.ok, false);
  for (const bad of ["x", "{{link:a}}", null, undefined, {}, "{{embed:doc|h|a}} extra"]) assert.equal(resolveEmbed([DOC], bad).error.code, "bad-token");
  assert.equal(resolveEmbed([{ id: "z", title: "z" }], "{{embed:z|h|a}}").error.code, "no-heading");
  assert.deepEqual(parseEmbed("{{embed:p|b|a,b}}"), { pageId: "p", mode: "b", ids: ["a", "b"] });
  assert.equal(embedKey(parseEmbed("{{embed:p|b|a,b}}")), "p|b|a,b");
});

// ---------- cycles ----------
const E = (page, hid) => `{{embed:${page}|h|${hid}}}`;
test("no embeds, plain embeds and shared (diamond) embeds are not cycles", () => {
  assert.equal(detectCycle([P("a", "A", [B("x", "p", "t")])], "a"), null);
  assert.equal(detectCycle([], "missing"), null);
  const pages = [
    P("a", "A", [B("e1", "p", `${E("b", "hb")} ${E("c", "hc")}`)]),
    P("b", "B", [B("hb", "h1", "b"), B("x", "p", E("d", "hd"))]),
    P("c", "C", [B("hc", "h1", "c"), B("x", "p", E("d", "hd"))]),
    P("d", "D", [B("hd", "h1", "d"), B("x", "p", "leaf")])
  ];
  assert.equal(detectCycle(pages, "a"), null);
  const chain = embedChain(pages, "a");
  assert.equal(chain.units.length, 3);
  assert.deepEqual(chain.cycles, []);
});
test("self, two-page and section loops are reported with their path", () => {
  const self = [P("a", "A", [B("h", "h1", "H"), B("e", "p", E("a", "h"))])];
  const c1 = detectCycle(self, "a");
  assert.deepEqual(c1.keys, ["a|h|h", "a|h|h"]);
  assert.deepEqual(c1.pageIds, ["a", "a"]);
  const two = [
    P("a", "A", [B("h", "h1", "H"), B("e", "p", E("b", "k"))]),
    P("b", "B", [B("k", "h1", "K"), B("e2", "p", E("a", "h"))])
  ];
  const c2 = detectCycle(two, "a");
  assert.deepEqual(c2.keys, ["b|h|k", "a|h|h", "b|h|k"]);
  assert.equal(detectCycle(two, "b").keys.length, 3);
  assert.ok(embedCycleFrom(two, E("b", "k")));
  assert.ok(embedCycleFrom(two, E("a", "h")));
  // an embed of a section that does NOT contain the embed is fine
  const ok = [P("a", "A", [B("h", "h1", "H"), B("x", "p", "text"), B("h2", "h1", "H2"), B("e", "p", E("a", "h"))])];
  assert.equal(detectCycle(ok, "a"), null);
  assert.equal(embedCycleFrom(ok, E("a", "h")), null);
  // block embeds loop through children too
  const blk = [P("a", "A", [B("p", "p", "x", { children: [B("kid", "p", "{{embed:a|b|p}}")] })])];
  assert.deepEqual(detectCycle(blk, "a").keys, ["a|b|p", "a|b|p"]);
  // a chain leading into a loop is reported, the entry is not part of it
  const lead = [P("s", "S", [B("e", "p", E("a", "h"))]), ...two];
  assert.deepEqual(detectCycle(lead, "s").keys, ["a|h|h", "b|h|k", "a|h|h"]);
  assert.equal(embedCycleFrom(lead, E("a", "h")).keys.length, 3);
  assert.equal(embedCycleFrom([P("a", "A", [B("h", "h1", "H")])], "garbage"), null);
});
test("embedChain reports unresolved targets", () => {
  const ch = embedChain([P("a", "A", [B("e", "p", `${E("nope", "h")} ${E("a", "gone")}`)])], "a");
  assert.deepEqual(ch.errors.map((e) => e.error.code).sort(), ["no-heading", "no-page"]);
  assert.deepEqual(ch.cycles, []);
});
test("a long embed chain does not overflow the stack", () => {
  const pages = [];
  const N = 20000;
  for (let i = 0; i < N; i++) pages.push(P(`p${i}`, "T", [B("h", "h1", "H"), B("e", "p", i + 1 < N ? E(`p${i + 1}`, "h") : "end")]));
  assert.equal(detectCycle(pages, "p0"), null);
  pages[N - 1].blocks[1].text = E("p0", "h");
  assert.equal(detectCycle(pages, "p0").keys.length, N + 1);
});
test("seeded fuzz: random embed graphs terminate and agree with a brute-force reference", () => {
  const r = rng(424242);
  let cyclic = 0;
  for (let n = 0; n < 600; n++) {
    const np = 1 + Math.floor(r() * 5);
    const pages = [];
    const headingIds = [];
    for (let i = 0; i < np; i++) {
      const blocks = [];
      const len = Math.floor(r() * 7);
      for (let j = 0; j < len; j++) {
        const id = `p${i}b${j}`;
        const roll = r();
        if (roll < 0.3) {
          blocks.push(B(id, `h${1 + Math.floor(r() * 3)}`, "H"));
          headingIds.push([`p${i}`, id]);
        } else {
          const toks = [];
          const k = Math.floor(r() * 3);
          for (let q = 0; q < k; q++) {
            const tp = `p${Math.floor(r() * (np + 1))}`; // sometimes a page that does not exist
            if (r() < 0.5) toks.push(E(tp, `${tp}b${Math.floor(r() * 7)}`));
            else toks.push(`{{embed:${tp}|b|${tp}b${Math.floor(r() * 7)},${tp}b${Math.floor(r() * 7)}}}`.replace(/(b\d),(\w+)b(\d)/, (m, a, c, d) => (a === `b${d}` ? a : m)));
          }
          const blk = B(id, pick(r, ["p", "toggle", "bullet"]), toks.join(" "));
          if (r() < 0.2) blk.children = [B(`${id}c`, "p", pick(r, [E(`p${Math.floor(r() * np)}`, `p0b${Math.floor(r() * 7)}`), "x"]))];
          blocks.push(blk);
        }
      }
      pages.push(P(`p${i}`, `P${i}`, blocks));
    }
    // reference: plain recursion with a path set, built only on resolveEmbed + scanTokens
    const embedsOf = (blocks) => {
      const out = [];
      const visit = (bs) => {
        for (const b of bs) {
          for (const t of scanTokens(b.text ?? "")) if (t.node.kind === "embed") out.push(t.node);
          visit(b.children ?? []);
        }
      };
      visit(blocks);
      return out;
    };
    const refCycle = (node, path) => {
      const key = embedKey(parseEmbed(node));
      if (path.includes(key)) return true;
      const res = resolveEmbed(pages, node);
      return embedsOf(res.blocks).some((c) => refCycle(c, [...path, key]));
    };
    for (const p of pages) {
      const expect = embedsOf(p.blocks).some((e) => refCycle(e, []));
      const got = detectCycle(pages, p.id);
      assert.equal(got !== null, expect, `page ${p.id} seed iteration ${n}`);
      if (got) cyclic++;
      const all = embedChain(pages, p.id);
      assert.equal(all.cycles.length > 0, expect);
      if (got) {
        assert.equal(got.keys[0], got.keys.at(-1));
        for (let i = 0; i + 1 < got.cycle.length; i++) {
          const kids = embedsOf(resolveEmbed(pages, got.cycle[i]).blocks).map((e) => embedKey(parseEmbed(e)));
          assert.ok(kids.includes(got.keys[i + 1]), "reported step is not an edge");
        }
      }
      for (const c of all.cycles) assert.equal(c[0].key, c.at(-1).key);
    }
    for (const [pid, hid] of headingIds) embedCycleFrom(pages, E(pid, hid));
  }
  assert.ok(cyclic > 50, `only ${cyclic} cyclic cases exercised`);
});

// ---------- markdown export ----------
const XP = [
  P("a", "Alpha [x]", [B("h", "h2", "Sec"), B("l1", "p", "para {{link:b}}"), B("h2", "h2", "Next"), B("l2", "p", "other")]),
  P("b", "Beta", [B("m", "p", `before\n\n${E("a", "h")}`.split("\n\n")[0]), B("e", "p", E("a", "h")), B("e2", "p", "{{embed:a|b|l2,l1}}")])
];
test("link export: wiki style, relative via ctx.pageLink, hidden flag, missing pages", () => {
  assert.equal(linkMarkdown(XP, "{{link:a}}"), "[[Alpha x]]");
  assert.equal(linkMarkdown(XP, "{{xlink:a}}"), "x[[Alpha x]]");
  assert.equal(linkMarkdown(XP, "{{link:gone}}"), "(deleted page)");
  assert.equal(linkMarkdown(XP, "{{page:a}}"), null);
  const rel = { pageLink: (id) => `[T](../${id}.md)` };
  assert.equal(blocksToMarkdown([B("x", "p", "see {{link:a}} {{xlink:b}}")], exportCtx(XP, rel)), "see [T](../a.md) [T](../b.md)");
  assert.equal(blocksToMarkdown([B("x", "p", "{{xlink:a}}")], exportCtx(XP, rel, { style: "wiki" })), "x[[Alpha x]]");
  assert.equal(blocksToMarkdown([B("x", "p", "{{link:a}}")], exportCtx(XP)), "[[Alpha x]]");
  // other inline kinds still go through the original ctx.inline / fallback
  assert.equal(blocksToMarkdown([B("x", "p", "{{date:2026-02-03}} {{status:s}}")], exportCtx(XP, { inline: (n) => (n.kind === "status" ? "OK" : null) })), "2026-02-03 OK");
});
test("embed export flattens the embedded blocks to markdown", () => {
  assert.equal(embedMarkdown(XP, E("a", "h")), "## Sec\n\npara [[Beta]]");
  assert.equal(embedMarkdown(XP, "{{embed:a|b|l2,l1}}"), "other\n\npara [[Beta]]");
  assert.equal(embedMarkdown(XP, E("a", "zz")), "");
  assert.equal(embedPlainText(XP, E("a", "h")), "Sec\npara Page");
  assert.equal(blocksToMarkdown(XP[1].blocks.slice(1, 2), exportCtx(XP)), "## Sec\n\npara [[Beta]]");
  assert.equal(blocksToMarkdown([B("x", "p", E("nope", "h"))], exportCtx(XP)), "(embedded content unavailable)");
});
test("recursive embeds export a note instead of looping", () => {
  const pages = [P("a", "A", [B("h", "h1", "H"), B("e", "p", E("a", "h"))])];
  const md = blocksToMarkdown(pages[0].blocks, exportCtx(pages));
  assert.equal(md, "# H\n\n# H\n\n(recursive embed omitted)");
  const two = [P("a", "A", [B("h", "h1", "H"), B("e", "p", E("b", "k"))]), P("b", "B", [B("k", "h1", "K"), B("e2", "p", E("a", "h"))])];
  assert.ok(blocksToMarkdown(two[0].blocks, exportCtx(two)).includes("(recursive embed omitted)"));
  assert.equal(typeof exportInline(two), "function");
});

test("heading embeds export as ![[Title#Heading]] with embeds: wiki; block embeds stay text", () => {
  const ctx = exportCtx(XP, {}, { style: "wiki", embeds: "wiki" });
  assert.equal(blocksToMarkdown([B("x", "p", E("a", "h"))], ctx), "![[Alpha x#Sec]]");
  assert.equal(blocksToMarkdown([B("x", "p", "{{embed:a|b|l2,l1}}")], ctx), "other\n\npara [[Beta]]");
  assert.equal(blocksToMarkdown([B("x", "p", E("nope", "h"))], ctx), "(embedded content unavailable)");
});

// ---------- editor helpers ----------
test("wikiTrigger: [[, x[[ and ![[ before the caret, with the typed query", () => {
  assert.deepEqual(wikiTrigger("see [[Al"), { start: 4, form: "link", query: "Al" });
  assert.deepEqual(wikiTrigger("a x[[B c"), { start: 2, form: "xlink", query: "B c" });
  assert.deepEqual(wikiTrigger("x[["), { start: 0, form: "xlink", query: "" });
  assert.deepEqual(wikiTrigger("box[[A"), { start: 3, form: "link", query: "A" }, "x inside a word is text");
  assert.deepEqual(wikiTrigger("![[Pa"), { start: 0, form: "embed", query: "Pa" });
  for (const no of ["[[a]] b", "`[[a", "\\[[a", "{{value:[[a", "[a", "[[a\nb", "[[" + "x".repeat(61), ""]) assert.equal(wikiTrigger(no), null, JSON.stringify(no));
  assert.deepEqual(wikiTrigger("`code` [[a"), { start: 7, form: "link", query: "a" });
  assert.deepEqual(wikiTrigger("{{link:p1}} [[a"), { start: 12, form: "link", query: "a" });
});
test("rankPages: exact, prefix, word prefix, substring; bounded", () => {
  const pages = ["Beta alpha", "Alphabet", "alpha", "Zalpha", "Other", "ALPHA team"].map((title, i) => ({ id: `p${i}`, title }));
  assert.deepEqual(rankPages(pages, " Alpha ").map((p) => p.title), ["alpha", "Alphabet", "ALPHA team", "Beta alpha", "Zalpha"]);
  assert.deepEqual(rankPages(pages, "", 2).map((p) => p.id), ["p0", "p1"]);
  assert.deepEqual(rankPages(pages, "zzz"), []);
  assert.equal(rankPages(Array.from({ length: 50 }, (_, i) => ({ id: `q${i}`, title: "same" })), "same", 8).length, 8);
  assert.deepEqual(rankPages(null, "a"), []);
});
test("headingList / blockChoices: document order, any depth, columns flattened", () => {
  const blocks = [
    B("h1", "h1", "Top **bold**"),
    B("t", "toggle", "T", { children: [B("h3", "h3", "Inner"), B("k", "p", "kid")] }),
    { id: "cols", type: "columns", children: [{ id: "c1", type: "column", children: [B("l", "p", "left")] }] },
    B("bad id", "h2", "skipped")
  ];
  assert.deepEqual(headingList(blocks), [{ id: "h1", level: 1, text: "Top bold" }, { id: "h3", level: 3, text: "Inner" }]);
  assert.deepEqual(blockChoices(blocks).map((c) => [c.id, c.depth]), [["h1", 0], ["t", 0], ["h3", 1], ["k", 1], ["cols", 0], ["l", 0]]);
  assert.equal(blockChoices(Array.from({ length: 10 }, (_, i) => B(`b${i}`, "p", "x")), 3).length, 3);
});
test("fuzz: wikiTrigger never throws and its start points at the typed syntax", () => {
  const r = rng(42);
  const parts = ["[[", "x[[", "![[", "a", " ", "`", "\\", "{{", "}}", "]]", "Title", "\n", "x"];
  for (let i = 0; i < 3000; i++) {
    let s = "";
    for (let j = 0, n = Math.floor(r() * 8); j < n; j++) s += pick(r, parts);
    const t = wikiTrigger(s);
    if (!t) continue;
    const open = t.start + (t.form === "link" ? 0 : 1);
    assert.equal(s.slice(open, open + 2), "[[", s);
    assert.equal(s.slice(open + 2), t.query, s);
    if (t.form === "embed") assert.equal(s[t.start], "!");
    if (t.form === "xlink") assert.equal(s[t.start], "x");
  }
});
