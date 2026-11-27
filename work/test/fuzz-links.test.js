// Seeded fuzz for page links, embeds and the graph feed: links.js (wiki syntax, extraction, embed resolution, loop
// detection, markdown export, editor helpers), graph/workspaceLinks.js (incremental link index vs a full rescan,
// rule / appearance / positions cleaning) and graph/model.js + graph/style.js (buildGraph, rule matching).
// Replay a failure with FUZZ_SEED=<n>; FUZZ_RUNS=<k> multiplies the case counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzz, rng, seedFor, XSS, UNICODE, MARKUP, protoSnapshot, assertNoPollution, PROTO_JSON, timeIt, record } from "./fixtures/fuzz.js";
import { buildToken, scanTokens, isTokenId } from "../../source/app/js/blocks/inline.js";
import {
  makeTitleResolver, parseWikiSyntax, extractLinks, uniqueEdges, parseEmbed, resolveEmbed, embedChain, detectCycle,
  embedCycleFrom, exportCtx, embedPlainText, wikiTrigger, rankPages, headingList, blockChoices, toWikiSyntax
} from "../../source/app/js/links.js";
import { blocksToMarkdown } from "../../source/app/js/blocks/markdown.js";
import { createWorkspaceLinks, graphNodes, cleanGraphRules, cleanAppearance, trimPositions, repoRules, RULES_MAX } from "../../source/app/js/graph/workspaceLinks.js";
import { buildGraph, createLinkIndex } from "../../source/app/js/graph/model.js";
import { matches, resolveStyle, styleGraph, normIcon, normColor } from "../../source/app/js/graph/style.js";

const LINK_KINDS = new Set(["link", "xlink", "embed"]);
const countLinkTokens = (s) => scanTokens(s).filter((t) => LINK_KINDS.has(t.node.kind)).length;

/** A small random workspace: pages with headings, paragraphs, nested children and random link / embed tokens. */
function randomPages(r, n = r.int(2, 12), { junk = true } = {}) {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const titles = ["Alpha", "alpha", "Beta", "Gamma Ray", "x", "A [b]", "Dup", "Dup", "", "{{link:p0}}", r.nasty(1)];
  const tok = () => {
    const to = r.chance(0.9) ? r.pick(ids) : r.id();
    return r.pick([
      () => buildToken("link", [to]),
      () => buildToken("xlink", [to]),
      () => buildToken("page", [to]),
      () => buildToken("embed", [to, "h", `h${r.int(0, 3)}`]),
      () => buildToken("embed", [to, "b", [...new Set(Array.from({ length: r.int(1, 3) }, () => `b${r.int(0, 4)}`))].join(",")]),
      () => `[x](#page-${to})`,
      () => `[[${r.pick(titles)}]]`,
      () => `![[${r.pick(titles)}][${r.pick(["One", "Two", "one"])}]]`,
      () => r.pick(MARKUP),
      () => r.nasty(1)
    ])() ?? "";
  };
  const text = () => Array.from({ length: r.int(0, 3) }, tok).join(r.pick([" ", "", "\n"]));
  return ids.map((id) => {
    const blocks = [];
    for (let k = 0; k < r.int(0, 6); k++) {
      const type = r.pick(["h1", "h2", "h3", "p", "p", "bullet", "toggle", "callout", "table", "code", "image"]);
      const b = { id: r.pick([`h${k}`, `b${k}`, `b${r.int(0, 4)}`]), type, text: text() };
      if (type === "table") b.cells = [[text(), text()], [text(), r.pick([null, 5, text()])]];
      if (r.chance(0.25)) b.children = [{ id: `b${r.int(0, 4)}`, type: "p", text: text() }, junk ? r.pick([null, 7, "x", { type: "p" }]) : { type: "p" }];
      blocks.push(b);
    }
    if (junk && r.chance(0.05)) blocks.push(null, "x", 3);
    return { id, title: r.pick(titles), blocks: junk && r.chance(0.05) ? r.pick([null, {}, "x"]) : blocks, updatedAt: r.int(1, 5) };
  });
}

test("parseWikiSyntax: never throws; every replacement is one valid link token; nothing changes without a replacement", async () => {
  await fuzz("wiki-parse", 400, (r) => {
    const pages = randomPages(r, r.int(2, 12), { junk: false }); // null blocks: pinned below

    const resolve = makeTitleResolver(pages);
    const pieces = ["[[Alpha]]", "x[[Beta]]", "![[Alpha]]", "![[Alpha][One]]", "![[Beta](b1, b2)]", "\\[[Alpha]]", "`[[Alpha]]`", "box[[Beta]]", "[[", "]]", "[[Dup]]", "[[nope]]", "{{link:p1}}", "[[A [b]]]", "[[\n]]"];
    const s = Array.from({ length: r.int(0, 8) }, () => (r.chance(0.6) ? r.pick(pieces) : r.nasty(1))).join(r.pick(["", " ", "\n"]));
    const choose = r.chance(0.3) ? (e) => r.pick(e.options).id : undefined;
    const res = parseWikiSyntax(s, resolve, { choose });
    assert.equal(typeof res.text, "string");
    assert.equal(countLinkTokens(res.text), countLinkTokens(s) + res.replaced, `replaced count ${res.replaced} for ${JSON.stringify(s)}`);
    if (!res.replaced) assert.equal(res.text, s);
    for (const e of [...res.ambiguous, ...res.unresolved]) assert.equal(res.text.slice(e.start, e.end), e.raw, "entry positions point at the raw text");
    for (const { node } of scanTokens(res.text)) if (LINK_KINDS.has(node.kind)) assert.ok(isTokenId(node.args[0]));
    // toWikiSyntax with the same resolver either returns the text unchanged or something that parses back exactly
    const typed = toWikiSyntax(res.text, pages, resolve);
    assert.equal(parseWikiSyntax(typed, resolve).text === res.text || typed === res.text, true);
  });
});

test("extractLinks: hostile block trees never throw; edges come from the page and point at valid ids", async () => {
  await fuzz("extract-links", 400, (r) => {
    for (const p of randomPages(r)) {
      const links = extractLinks(p);
      for (const l of links) {
        assert.equal(l.from, p.id);
        assert.ok(isTokenId(l.to), `bad target ${JSON.stringify(l.to)}`);
        assert.ok(["link", "embed"].includes(l.kind));
      }
      const u = uniqueEdges(links);
      assert.ok(u.length <= links.length);
    }
    for (const junk of [null, undefined, 5, "x", { id: 5 }, { id: "a", blocks: "x" }, { id: "a", blocks: [null, [], { children: 5 }] }]) assert.deepEqual(extractLinks(junk), []);
  });
});

test("embeds: resolution, chains and loop detection always terminate and agree with each other", async () => {
  await fuzz("embeds", 300, (r) => {
    const pages = randomPages(r, r.int(2, 12), { junk: false });
    for (const p of pages) {
      const chain = embedChain(pages, p.id);
      const cyc = detectCycle(pages, p.id);
      assert.equal(!!cyc, chain.cycles.length > 0, `detectCycle and embedChain disagree on ${p.id}`);
      for (const c of chain.cycles) assert.equal(c[0].key, c[c.length - 1].key, "a cycle is closed");
      assert.equal(new Set(chain.units.map((u) => u.key)).size, chain.units.length, "units are distinct");
      for (const { node } of scanTokens((Array.isArray(p.blocks) ? p.blocks : []).map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n"))) {
        if (node.kind !== "embed") continue;
        const e = parseEmbed(node);
        assert.ok(e, "a scanned embed token parses");
        const res = resolveEmbed(pages, node);
        assert.equal(typeof res.ok, "boolean");
        assert.ok(Array.isArray(res.blocks));
        embedCycleFrom(pages, node);
        assert.equal(typeof embedPlainText(pages, node), "string");
      }
    }
    for (const junk of [null, "", "{{embed:a|h}}", { kind: "embed", args: [] }, { pageId: 5 }, "{{embed:a|b|x,x}}"]) {
      assert.equal(parseEmbed(junk), null);
      assert.equal(resolveEmbed(pages, junk).ok, false);
    }
  });
});

test("markdown export of links / embeds never throws, terminates on loops and stays bounded", async () => {
  await fuzz("export-links", 200, (r) => {
    const pages = randomPages(r, r.int(2, 6), { junk: false });
    for (const p of pages) {
      const md = blocksToMarkdown(Array.isArray(p.blocks) ? p.blocks.filter((b) => b && typeof b === "object") : [], exportCtx(pages, {}, { style: r.pick(["wiki", undefined]), embeds: r.pick(["wiki", undefined]) }));
      assert.equal(typeof md, "string");
      assert.ok(md.length < 2_000_000, "export stays bounded");
    }
  });
});

test("embeds: a target page whose stored blocks hold null entries (pinned)", { todo: "BUG: links.js resolveWith uses blocks/model.js find(), which reads b.id / b.children of null entries; an imported or synced page with a null block (blocks are only normalised when opened in the editor) makes resolveEmbed / embedChain / embedCycleFrom / toWikiSyntax / markdown export throw, so the embed chip and the page export fail" }, () => {
  const pages = [{ id: "a", title: "A", blocks: [{ id: "e", type: "p", text: "{{embed:b|b|x}}" }] }, { id: "b", title: "B", blocks: [null, { id: "x", type: "p", text: "hi", children: [null] }] }];
  assert.doesNotThrow(() => embedChain(pages, "a"));
  assert.doesNotThrow(() => resolveEmbed(pages, "{{embed:b|b|x}}"));
  assert.doesNotThrow(() => blocksToMarkdown(pages[0].blocks, exportCtx(pages, {})));
  assert.doesNotThrow(() => toWikiSyntax("{{embed:b|b|x}}", pages, makeTitleResolver(pages)));
});

test("markdown export: embeds that fan out don't blow up exponentially", { todo: "BUG: links.js exportInline re-expands every embed occurrence (only a loop stack, no memo or budget): a chain of pages each embedding the next twice exports 2^depth copies (depth 16 = 330 KB; 3 embeds x 20 pages = hang). ui/linkChips.js embedChip renders the same tree into the DOM" }, async () => {
  const chain = (d, k) => Array.from({ length: d + 1 }, (_, i) => ({ id: `P${i}`, title: `P${i}`, blocks: [{ id: "b", type: "p", text: i < d ? Array(k).fill(`{{embed:P${i + 1}|b|b}}`).join(" ") : "leaf" }] }));
  const rows = [];
  for (const d of [8, 10, 12, 14]) {
    const pages = chain(d, 2);
    const t = await timeIt(() => blocksToMarkdown(pages[0].blocks, exportCtx(pages, {})));
    rows.push({ d, ms: t.ms, len: t.value.length });
    record(`exportInline doubling embeds depth=${d}`, t.ms, `${t.value.length} chars`);
  }
  // linear in the number of distinct embedded units would keep the output under ~100 chars per level
  assert.ok(rows.at(-1).len < 100 * 15, `output ${rows.at(-1).len} chars for 15 pages`);
});

test("wikiTrigger / rankPages / headingList / blockChoices: never throw; picker results are bounded and distinct", async () => {
  await fuzz("editor-helpers", 400, (r) => {
    const s = r.nasty(4) + r.pick(["[[", "x[[", "![[", "[[Al", "\\[[a", "`[[a", "{{link:[[a", "box[[a", ""]) + r.text(5);
    const t = wikiTrigger(s);
    if (t) {
      assert.ok(["link", "xlink", "embed"].includes(t.form));
      assert.ok(t.start >= 0 && t.start <= s.length);
      assert.equal(typeof t.query, "string");
    }
    const pages = randomPages(r);
    const limit = r.int(0, 10);
    const ranked = rankPages([...pages, null, { title: 5 }].filter((x) => r.chance(0.9)), r.pick([r.nasty(1), "a", "", "  dup "]), limit);
    assert.ok(ranked.length <= limit);
    assert.equal(new Set(ranked).size, ranked.length);
    for (const p of pages) {
      for (const h of headingList(p.blocks)) assert.ok(isTokenId(h.id) && h.level >= 1 && h.level <= 4);
      assert.ok(blockChoices(p.blocks, 5).length <= 5);
    }
  });
});

test("link tracker: random saves, deletes and syncs keep the index equal to a full rescan", async () => {
  await fuzz("link-tracker", 150, (r) => {
    const links = createWorkspaceLinks();
    let pages = randomPages(r, r.int(3, 10));
    let rows = [];
    const model = new Map(); // id -> record currently indexed in the app's view
    const rescan = () => {
      const want = new Map();
      for (const rec of model.values()) {
        const m = new Map();
        for (const e of extractLinks({ id: rec.id, blocks: rec.blocks })) m.set(e.to, m.has(e.to) ? m.get(e.to) && e.hidden : e.hidden);
        if (m.size) want.set(rec.id, m);
      }
      return want;
    };
    links.syncPages(pages);
    for (const p of pages) model.set(p.id, p);
    for (let step = 0; step < 30; step++) {
      const op = r.pick(["edit", "edit", "sync", "row", "remove", "rows", "noop"]);
      if (op === "edit" && pages.length) {
        const p = r.pick(pages);
        const fresh = randomPages(r, pages.length)[r.int(0, pages.length - 1)];
        const next = { ...p, blocks: fresh.blocks, updatedAt: p.updatedAt + 1 };
        pages = pages.map((q) => (q.id === p.id ? next : q));
        if (r.chance(0.7)) {
          links.updatePage(next);
          model.set(next.id, next);
        }
      } else if (op === "sync") {
        if (r.chance(0.3)) pages = pages.filter(() => r.chance(0.8));
        if (r.chance(0.3)) pages.push({ id: `n${step}`, title: "New", blocks: [{ id: "b", type: "p", text: `{{link:${r.pick(pages)?.id ?? "x"}}}` }], updatedAt: 1 });
        links.syncPages(pages);
        for (const id of [...model.keys()]) if (!rows.some((x) => x.id === id)) model.delete(id);
        for (const p of pages) model.set(p.id, p);
      } else if (op === "row") {
        const row = { id: `r${r.int(0, 4)}`, dbId: "db", blocks: [{ id: "b", type: "p", text: `{{link:${r.pick(pages)?.id ?? "x"}}} {{xlink:p0}}` }], updatedAt: step };
        rows = [...rows.filter((x) => x.id !== row.id), row];
        links.updateRow(row);
        model.set(row.id, row);
      } else if (op === "rows") {
        rows = rows.filter(() => r.chance(0.7));
        links.setRows(rows);
        for (const id of [...model.keys()]) if (!pages.some((p) => p.id === id) && !rows.some((x) => x.id === id)) model.delete(id);
        for (const x of rows) model.set(x.id, x);
      } else if (op === "remove") {
        const id = r.pick([...model.keys()]);
        if (id) {
          links.remove(id);
          model.delete(id);
          pages = pages.filter((p) => p.id !== id);
          rows = rows.filter((x) => x.id !== id);
        }
      }
      const want = rescan();
      const got = new Map();
      for (const l of links.index.links()) {
        if (!got.has(l.from)) got.set(l.from, new Map());
        got.get(l.from).set(l.to, l.hidden);
      }
      const fmt = (m) => JSON.stringify([...m].map(([k, v]) => [k, [...v].sort()]).sort());
      assert.equal(fmt(got), fmt(want), `step ${step} ${op}`);
      for (const [from, m] of want) for (const [to, hidden] of m) {
        const b = links.backlinks(to).find((x) => x.from === from);
        assert.ok(b && b.hidden === hidden, `backlink ${from} -> ${to}`);
      }
    }
  });
});

test("graph rules / appearance / positions: hostile input is cleaned to bounded plain data", async () => {
  const before = protoSnapshot();
  await fuzz("graph-clean", 400, (r) => {
    const SAFE_PROTO = PROTO_JSON.filter((j) => !j.includes("toString")); // objects whose toString is data: pinned below
    const val = () => r.pick([r.nasty(1), r.int(-1e6, 1e6), NaN, Infinity, -0, null, undefined, true, [], {}, "x".repeat(500), ...XSS.slice(0, 5), JSON.parse(r.pick(SAFE_PROTO))]);
    const cond = () => r.pick([null, 5, "x", { field: r.pick(["type", "title", "links", "tag", "repo", "__proto__", val()]), op: r.pick(["is", "contains", "gt", "nope", "empty", val()]), value: val() }, { prop: val(), op: "notEmpty" }, JSON.parse(r.pick(SAFE_PROTO))]);
    const rules = Array.from({ length: r.int(0, 60) }, () => r.pick([null, "x", { when: r.chance(0.5) ? cond() : Array.from({ length: r.int(0, 8) }, cond), icon: val(), color: val(), size: val() }, JSON.parse(r.pick(SAFE_PROTO))]));
    const clean = cleanGraphRules(rules);
    assert.ok(clean.length <= RULES_MAX);
    for (const rule of clean) {
      assert.ok(rule.when.length >= 1 && rule.when.length <= 4);
      assert.ok(rule.icon == null || (typeof rule.icon === "string" && rule.icon.length <= 64));
      assert.ok(rule.size == null || (rule.size >= 0.25 && rule.size <= 6));
      assert.ok(rule.color == null || typeof rule.color === "number" || rule.color.length <= 16);
      for (const w of rule.when) assert.ok(w.prop != null || ["type", "title", "links", "tag"].includes(w.field));
    }
    assert.deepEqual(cleanGraphRules(clean), clean, "cleaning is idempotent");
    const app = cleanAppearance(r.pick([{ icon: val(), color: val(), size: val() }, val()]));
    if (app) assert.ok(Object.keys(app).every((k) => ["icon", "color", "size"].includes(k)));
    const store = {};
    for (let i = 0; i < r.int(0, 10); i++) store[r.pick([`g${i}`, "constructor", "toString"])] = r.pick([{ t: r.int(0, 100), p: Object.fromEntries(Array.from({ length: r.int(0, 900) }, (_, j) => [`n${j}`, [r.float() * 1e4, r.pick([1, NaN, "x"])]])) }, null, 5]);
    const trimmed = trimPositions(store, { maxKeys: 3, maxEntries: 1000 });
    assert.ok(Object.keys(trimmed).length <= 3);
    assert.ok(Object.values(trimmed).reduce((n, g) => n + Object.keys(g.p).length, 0) <= 1000);
    for (const g of Object.values(trimmed)) for (const xy of Object.values(g.p)) assert.ok(Number.isInteger(xy[0]) && Number.isInteger(xy[1]));
  });
  assertNoPollution(before, "graph cleaning");
});

test("graph rules from a JSON import with a 'toString' key in a value don't crash cleaning or styling (pinned)", { todo: "BUG (low): cleanGraphRules / cleanAppearance call Number(size) and String(...) and graph/style.js normSize / lc call String() on raw values; a JSON value like {\"toString\":\"x\"} throws TypeError (repo.graphRules / page.graph are used uncleaned when imported, so the graph view fails)" }, () => {
  const bad = JSON.parse('{"toString":"x","valueOf":1}');
  assert.doesNotThrow(() => cleanGraphRules([{ when: { field: "type", op: "is", value: "page" }, size: bad }]));
  assert.doesNotThrow(() => cleanAppearance({ size: bad, icon: bad }));
  assert.doesNotThrow(() => resolveStyle({ kind: "page" }, [{ when: { field: "type", op: "is", value: bad }, size: bad }]));
});

test("trimPositions: a graph or node key named __proto__ stays data (pinned)", { todo: "BUG (low): trimPositions writes out[k] / p[id] on plain objects, so a stored key '__proto__' replaces the result's prototype and the entry is lost (no global pollution)" }, () => {
  const t = trimPositions(JSON.parse('{"__proto__":{"t":5,"p":{"a":[1,2]}},"g":{"t":1,"p":{"__proto__":[3,4]}}}'));
  assert.equal(Object.getPrototypeOf(t), Object.prototype);
  assert.equal(Object.getPrototypeOf(t.g.p), Object.prototype);
});

test("graph rules on a property named like an Object member match only real properties (pinned)", { todo: "BUG (low): graph/style.js fieldValue reads node.props[c.prop] without an own-property check and graphNodes' propValues assigns props by name, so a rule on 'constructor' / 'toString' matches every node and a property named '__proto__' is swallowed" }, () => {
  const [node] = graphNodes([{ id: "a", type: "doc", title: "A", props: [{ id: "x", name: "__proto__", type: "text", value: "v" }] }]);
  assert.equal(matches(node, { prop: "constructor", op: "notEmpty" }), false);
  assert.equal(matches(node, { prop: "toString", op: "contains", value: "native" }), false);
  assert.equal(Object.getPrototypeOf(node.props), Object.prototype);
});

test("graphNodes + buildGraph + styleGraph: random workspaces, filters and rules never throw; the graph is well formed", async () => {
  await fuzz("graph-build", 200, (r) => {
    const pages = randomPages(r, r.int(1, 25)).map((p, i) => ({
      ...p,
      type: r.pick(["doc", "doc", "database", "repo", "sync", r.nasty(1)]),
      parentId: r.chance(0.7) ? `p${r.int(0, 24)}` : null,
      trashedAt: r.chance(0.1) ? 1 : undefined,
      archivedAt: r.chance(0.1) ? 1 : undefined,
      template: r.chance(0.05),
      props: r.pick([undefined, [], [{ name: "tags", value: [r.nasty(1), "a"] }, { name: "n", value: r.int(0, 9) }], [null, 5, { name: 5 }]]),
      graph: r.pick([undefined, { icon: r.nasty(1), color: r.pick(["red", "#fff", 400, "javascript:x"]), size: r.pick([0, 9, "x"]) }]),
      columns: r.chance(0.3) ? [{ id: "c", name: "Name" }, null] : undefined,
      id: i % 7 === 6 ? r.pick(["__proto__", "constructor", "p0"]) : p.id
    }));
    const rows = Array.from({ length: r.int(0, 10) }, (_, i) => ({ id: `r${i}`, dbId: r.pick(pages).id, values: { c: r.pick([r.nasty(1), 5, ["a"], { a: 1 }, null]) } }));
    const nodes = graphNodes(pages, rows);
    for (const n of nodes) assert.equal(typeof n.title, "string");
    const linkList = [];
    for (const rec of [...pages, ...rows]) for (const l of extractLinks(rec)) linkList.push(l);
    const index = createLinkIndex(linkList);
    const rules = repoRules(pages.filter((p) => p.type === "repo").map((p) => ({ ...p, graphRules: cleanGraphRules([{ when: { field: "tag", op: "contains", value: "a" }, color: "red" }, { when: { prop: "n", op: "gt", value: "3" }, size: 2 }]) })));
    const filter = {
      repo: r.pick([null, "p0", ["p1", "p2"], [], ""]),
      includeDbs: r.chance(0.5) ? pages.map((p) => p.id) : [],
      orphans: r.chance(0.5),
      search: r.pick(["", "a", r.nasty(1)]),
      kinds: r.pick([null, ["page"], ["row", "database"], []]),
      where: r.pick([null, { field: "type", op: "is", value: "page" }, [{ prop: "n", op: "lt", value: "5" }], { field: "nope" }]),
      focus: r.pick([null, "p0", "zz", ""]),
      depth: r.pick([0, 1, 3, 99, -1, "x"])
    };
    const g = buildGraph(r.chance(0.5) ? { pages: nodes, linkIndex: index } : { pages: nodes, links: linkList }, filter);
    assert.equal(g.nodes.length, g.index.size);
    assert.equal(g.source.length, g.edgeCount);
    for (let e = 0; e < g.edgeCount; e++) assert.ok(g.source[e] < g.nodes.length && g.target[e] < g.nodes.length && g.source[e] !== g.target[e]);
    assert.equal(g.adjOffset[g.nodes.length], 2 * g.edgeCount);
    assert.ok(g.focus >= -1 && g.focus < g.nodes.length);
    const st = styleGraph(g, rules);
    for (let i = 0; i < g.nodes.length; i++) {
      assert.ok(Number.isFinite(st.radius[i]) && st.radius[i] > 0);
      assert.ok(st.icon[i] == null || (typeof st.icon[i] === "string" && (st.icon[i].startsWith("icon:") || [...st.icon[i]].length <= 2)));
      const c = st.color[i];
      assert.ok(c == null || c.grey || Number.isFinite(c.hue) || /^#[0-9a-f]{3,6}$/.test(c.hex));
    }
    resolveStyle(null, [null, { when: null }]);
    normIcon(r.nasty(1));
    normColor(r.nasty(1));
  });
});

test("seeded helpers: the same seed gives the same workspace", () => {
  const a = JSON.stringify(randomPages(rng(seedFor("same")), 5));
  const b = JSON.stringify(randomPages(rng(seedFor("same")), 5));
  assert.equal(a, b);
  assert.ok(UNICODE.length > 0);
});
