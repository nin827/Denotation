// Performance guard rails (seeded inputs, generous limits, printed timings). Each guard runs fn at doubling sizes and
// checks the growth exponent between neighbours (1 = linear, 2 = quadratic): "time x4 when input x2" is a smell.
// Default sizes keep `npm test` quick; FUZZ_HEAVY=1 runs the big sizes from the brief (5k-row recompute, 20k-record
// sync plans, 1000-deep trees, ...). Known superlinear cases are pinned as todo tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rng, seedFor, growth, record, timeIt, HEAVY } from "./fixtures/fuzz.js";
import { parseInline, scanTokens, buildToken } from "../../source/app/js/blocks/inline.js";
import { markdownToBlocks, blocksToMarkdown } from "../../source/app/js/blocks/markdown.js";
import { newBlock, normalizeBlocks, walk, MAX_DEPTH } from "../../source/app/js/blocks/model.js";
import { applyFormulas, evalExpression } from "../../source/app/js/formula.js";
import { planSync } from "../../source/app/js/sync.js";
import { buildGraph } from "../../source/app/js/graph/model.js";
import { parseCsv, tableFromCsv } from "../../source/app/js/csv.js";
import { parseType } from "../../source/app/js/typespec.js";
import { makeResolver } from "../../source/app/js/permissions.js";
import { extractLinks, parseWikiSyntax, makeTitleResolver } from "../../source/app/js/links.js";
import { createWorkspace, isHidden, ancestors, descendantIds } from "../../source/app/js/workspace.js";
import { createWorkspaceLinks, graphNodes } from "../../source/app/js/graph/workspaceLinks.js";
import { createMemoryAdapter } from "../../source/app/js/adapters/memory.js";

const S = (light, heavy) => (HEAVY ? heavy : light);
/**
 * Run a growth check, print the table, assert the exponent and the largest timing. Timing noise (GC, other test files
 * running in parallel under `npm test`) can fake growth once; a real superlinear cost fails every attempt, so a guard
 * passes if any of `attempts` measurements is within limits.
 */
async function guard(label, sizes, fn, { maxExp = 1.6, maxMs = 5000, reps = 3, attempts = 3 } = {}) {
  let g;
  for (let k = 0; k < attempts; k++) {
    g = await growth(sizes, fn, { reps });
    if (g.exponent <= maxExp && g.rows.at(-1).ms <= maxMs) break;
  }
  for (const row of g.rows) record(`${label} n=${row.size}`, row.ms);
  console.log(`  [growth] ${label}: exponent ${g.exponent.toFixed(2)} (1 = linear, 2 = quadratic)`);
  assert.ok(g.exponent <= maxExp, `${label}: growth exponent ${g.exponent.toFixed(2)} > ${maxExp}`);
  assert.ok(g.rows.at(-1).ms <= maxMs, `${label}: ${g.rows.at(-1).ms.toFixed(0)} ms > ${maxMs} ms`);
  return g;
}
const r0 = rng(seedFor("perf"));
const words = (n) => Array.from({ length: n }, () => r0.pick(["lorem", "ipsum", "dolor", "**bold**", "*it*", "`code`", "[l](https://e.x)", "sit", "amet,", "{{date:2024-01-02}}"])).join(" ");

test("parseInline: long ordinary text and thousands of tokens scale linearly", async () => {
  await guard("parseInline ordinary text (words)", S([5000, 10000, 20000], [20000, 40000, 80000]), (n) => parseInline(words(n)));
  await guard("parseInline n tokens", S([1000, 2000, 4000], [5000, 10000, 20000]), (n) => parseInline(Array.from({ length: n }, (_, i) => buildToken("link", [`p${i}`])).join(" x ")));
  await guard("scanTokens n tokens", S([2000, 4000, 8000], [10000, 20000, 40000]), (n) => scanTokens(Array.from({ length: n }, (_, i) => `{{check:${i % 2}}} a`).join("")));
});

test("parseInline: unmatched emphasis markers stay linear", async () => {
  await guard("parseInline '*a _b ' repeated", [1500, 3000, 6000], (n) => parseInline("*a _b ".repeat(n)), { maxExp: 1.4, reps: 1, attempts: 1 });
  await guard("parseInline '**a ' nested", [500, 1000, 2000], (n) => parseInline("**a ".repeat(n) + "b" + " a**".repeat(n)), { maxExp: 1.4, reps: 1, attempts: 1 });
});

test("inline: unterminated {{img: openers stay linear", async () => {
  await guard("scanTokens n unterminated '{{img:' openers", [700, 1400, 2800], (n) => scanTokens("{{img:https://a".repeat(n)), { maxExp: 1.4, reps: 1, attempts: 1 });
});

test("inline: unterminated ordinary tokens are bounded by TOKEN_MAX (linear)", async () => {
  await guard("parseInline n unterminated '{{link:' openers", S([2000, 4000, 8000], [10000, 20000, 40000]), (n) => parseInline("{{link:a".repeat(n)));
});

test("markdown: a big page converts both ways linearly", async () => {
  const page = (n) => Array.from({ length: n }, (_, i) => newBlock(r0.pick(["p", "h2", "bullet", "todo", "quote", "numbered"]), { text: `${words(8)} ${i}` }));
  await guard("blocksToMarkdown n blocks", S([2000, 4000, 8000], [10000, 20000, 40000]), (n) => blocksToMarkdown(page(n)));
  const mds = new Map();
  for (const n of S([2000, 4000, 8000], [10000, 20000, 40000])) mds.set(n, blocksToMarkdown(page(n)));
  await guard("markdownToBlocks n blocks", [...mds.keys()], (n) => markdownToBlocks(mds.get(n)));
  await guard("normalizeBlocks n blocks", S([5000, 10000, 20000], [20000, 40000, 80000]), (n) => normalizeBlocks(page(n)));
});

test("markdown: a whitespace-heavy line after a '|' line doesn't backtrack quadratically", async () => {
  await guard("markdownToBlocks 'a|b' + n spaces + 'x'", [6000, 12000, 24000], (n) => markdownToBlocks(`a|b\n${" ".repeat(n)}x`), { maxExp: 1.4, reps: 1, attempts: 1 });
});

test("markdown: a huge table doesn't overflow the stack", () => {
  assert.doesNotThrow(() => markdownToBlocks("|a|b|\n|---|---|\n" + "|x|y|\n".repeat(200000)));
});

test("markdown: deeply nested blocks don't overflow the stack", () => {
  let b = { id: "x", type: "p", text: "" };
  for (let i = 0; i < 6000; i++) b = { id: `t${i}`, type: "toggle", text: "", children: [b] };
  assert.doesNotThrow(() => blocksToMarkdown([b]));
  assert.doesNotThrow(() => normalizeBlocks([b]));
});

test("markdown: nesting deeper than MAX_DEPTH is hoisted, keeping every block's text in order", () => {
  const N = 6000;
  let b = { id: "leaf", type: "p", text: "leaf" };
  for (let i = N - 1; i >= 0; i--) b = { id: `t${i}`, type: "toggle", text: `T${i}`, children: [b, { id: `s${i}`, type: "p", text: `S${i}` }] };
  // pre-order of the original tree (built directly: walk() itself would recurse 6000 deep)
  const wantOrder = [...Array.from({ length: N }, (_, i) => `T${i}`), "leaf", ...Array.from({ length: N }, (_, i) => `S${N - 1 - i}`)];
  const md = blocksToMarkdown([b]);
  let at = -1;
  for (const t of ["T0", `T${MAX_DEPTH}`, `T${N - 1}`, "leaf", `S${N - 1}`, `S${MAX_DEPTH}`, "S0"]) {
    const j = md.indexOf(t + (t.startsWith("T") ? "<" : ""));
    assert.ok(j > at, `markdown keeps ${t} in order`);
    at = j;
  }
  const list = normalizeBlocks([b]);
  let maxDepth = 0;
  const got = [];
  walk(list, (x, d) => {
    maxDepth = Math.max(maxDepth, d);
    got.push(x.text);
  });
  assert.ok(maxDepth < MAX_DEPTH, `depth ${maxDepth} is capped`);
  assert.deepEqual(got, wantOrder, "no block lost or reordered");
});

test("formulas: recompute over thousands of rows is linear (row formulas and ALL() aggregates)", async () => {
  const columns = [
    { id: "q", name: "Qty", type: "number", config: {} },
    { id: "n", name: "Name", type: "text", config: {} },
    { id: "f1", name: "Double", type: "formula", config: { expr: "[Qty]*2 + LEN([Name])" } },
    { id: "f2", name: "Share", type: "formula", config: { expr: "[Qty] / SUM(ALL([Qty]))" } },
    { id: "f3", name: "Rank", type: "formula", config: { expr: "COUNTIF(ALL([Qty]), \">\" & [Qty])" } }
  ];
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, values: { q: (i * 7919) % 1000, n: `row ${i}` } }));
  // f3 is O(n) per row by nature (n^2 total): measured separately with a looser limit.
  await guard("applyFormulas row + SUM(ALL) n rows", S([1250, 2500, 5000], [5000, 10000, 20000]), (n) => applyFormulas(columns.slice(0, 4), rows(n)));
  await guard("applyFormulas COUNTIF(ALL()) per row n rows (n^2 expected)", S([400, 800, 1600], [1250, 2500, 5000]), (n) => applyFormulas([columns[0], columns[4]], rows(n)), { maxExp: 2.3, maxMs: 20000, reps: 1 });
  const t = await timeIt(() => applyFormulas(columns.slice(0, 4), rows(5000)));
  record("applyFormulas 5000 rows x 2 formulas", t.ms);
  assert.ok(t.ms < 3000);
});

test("formula and type parsers: long inputs scale linearly", async () => {
  await guard("evalExpression long sum (n terms, < stack limit)", [1000, 2000, 4000], (n) => evalExpression(Array.from({ length: n }, (_, i) => String(i)).join("+")));
  await guard("parseType struct with n keys", S([1000, 2000, 4000], [5000, 10000, 20000]), (n) => parseType(`Dictionary{${Array.from({ length: n }, (_, i) => `k${i}: int(0..${i})`).join(", ")}}`));
  await guard("parseCsv n lines", S([5000, 10000, 20000], [50000, 100000, 200000]), (n) => tableFromCsv(parseCsv(Array.from({ length: n }, (_, i) => `${i},"a,b",${i % 2 ? "true" : "false"},2024-01-0${1 + (i % 9)}`).join("\n"))));
});

test("sync: planning thousands of records is linear", async () => {
  const world = (n) => {
    const local = [];
    const remote = [];
    const tombs = [];
    for (let i = 0; i < n; i++) {
      const s = 1 + (i % 50);
      if (i % 3) local.push({ id: `r${i}`, updatedAt: s });
      if (i % 4) remote.push({ id: `r${i}`, updatedAt: s + (i % 2) });
      if (i % 17 === 0) tombs.push({ collection: "rows", id: `r${i}`, deletedAt: s + 1 });
    }
    return { local: { rows: local }, remote: { rows: remote }, remoteTombstones: tombs, now: 100 };
  };
  const worlds = new Map(S([5000, 10000, 20000], [20000, 40000, 80000]).map((n) => [n, world(n)]));
  await guard("planSync merge n records", [...worlds.keys()], (n) => planSync({ ...worlds.get(n), direction: "merge" }));
  await guard("planSync push n records", [...worlds.keys()], (n) => planSync({ ...worlds.get(n), direction: "push" }));
});

test("graph, links and permissions over big workspaces are near-linear", async () => {
  const pagesN = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, title: `Page ${i}`, kind: "page", repo: `r${i % 3}`, parentId: i ? `p${Math.floor((i - 1) / 4)}` : null }));
  const linksN = (n) => Array.from({ length: n * 3 }, (_, e) => ({ from: `p${e % n}`, to: `p${(e * 7919) % n}`, hidden: e % 50 === 0 }));
  await guard("buildGraph n pages / 3n links", S([1000, 2000, 4000], [2500, 5000, 10000]), (n) => buildGraph({ pages: pagesN(n), links: linksN(n) }));
  await guard("makeResolver + resolve every page", S([2500, 5000, 10000], [10000, 20000, 40000]), (n) => {
    const pages = pagesN(n);
    const can = makeResolver({ broad: { read: "yes" }, pages: { p3: { read: "no" } } }, pages, []);
    for (const p of pages) can(p.id, "read");
  });
  await guard("extractLinks page with n tokens", S([1000, 2000, 4000], [5000, 10000, 20000]), (n) => extractLinks({ id: "src", blocks: [{ id: "b", type: "p", text: Array.from({ length: n }, (_, i) => `{{link:p${i}}}`).join(" ") }] }));
  const titled = Array.from({ length: 2000 }, (_, i) => ({ id: `p${i}`, title: `Note ${i}` }));
  const resolve = makeTitleResolver(titled);
  await guard("parseWikiSyntax n [[links]]", S([1000, 2000, 4000], [5000, 10000, 20000]), (n) => parseWikiSyntax(Array.from({ length: n }, (_, i) => `see [[Note ${i % 2000}]]`).join(", "), resolve));
});

test("link index: 1500+ pages sync linearly, one save costs one page, graph nodes and a 5000-node graph build fast", async () => {
  const pagesN = (n, stamp = 1) => Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, title: `Page ${i}`, type: "doc", parentId: i ? `p${Math.floor((i - 1) / 8)}` : null, updatedAt: stamp,
    blocks: [{ id: "b", type: "p", text: Array.from({ length: 20 }, (_, k) => `{{link:p${(i * 31 + k * 7) % n}}}`).join(" ") }]
  }));
  await guard("link tracker syncPages n pages x 20 links", S([1500, 3000, 6000], [6000, 12000, 24000]), (n) => createWorkspaceLinks().syncPages(pagesN(n)));
  const n = S(1500, 6000);
  const links = createWorkspaceLinks();
  const pages = pagesN(n);
  links.syncPages(pages);
  const one = await timeIt(() => { for (let k = 0; k < 200; k++) links.updatePage({ ...pages[k], updatedAt: 2 + k, blocks: [{ id: "b", type: "p", text: `{{link:p${k + 1}}}` }] }); });
  record(`link tracker 200 single-page saves (${n} pages indexed)`, one.ms);
  assert.ok(one.ms < 500, "a save re-reads one page, not the workspace");
  const resync = await timeIt(() => links.syncPages(pages));
  record(`link tracker re-sync ${n} unchanged pages`, resync.ms);
  await guard("graphNodes n pages (tree)", S([2500, 5000, 10000], [10000, 20000, 40000]), (k) => graphNodes(pagesN(k)));
  const big = pagesN(5000);
  const idx = createWorkspaceLinks();
  idx.syncPages(big);
  const t = await timeIt(() => buildGraph({ pages: graphNodes(big), linkIndex: idx.index }));
  record("buildGraph 5000 nodes / ~100k links (from the link index)", t.ms, `${t.value.edgeCount} edges`);
  assert.ok(t.ms < 3000);
});

test("page trees: 1000-deep chains and 5000-wide repositories stay fast in the tree helpers and workspace ops", async () => {
  const chain = (n) => Array.from({ length: n }, (_, i) => ({ id: `d${i}`, parentId: i ? `d${i - 1}` : null, ...(i === 0 ? { archivedAt: 1 } : {}) }));
  await guard("isHidden over every page of an n-deep chain", S([250, 500, 1000], [1000, 2000, 4000]), (n) => {
    const pages = chain(n);
    for (const p of pages) isHidden(pages, p);
  }, { maxExp: 2.1 });
  await guard("ancestors + descendantIds n-deep chain", S([250, 500, 1000], [1000, 2000, 4000]), (n) => {
    const pages = chain(n);
    ancestors(pages, `d${n - 1}`);
    descendantIds(pages, "d0");
  });
  const deep = S(300, 1000);
  const ws = createWorkspace(createMemoryAdapter());
  let parent = (await ws.createPage({ type: "repo", title: "R" })).id;
  const root = parent;
  for (let i = 0; i < deep; i++) parent = (await ws.createPage({ type: "doc", title: `deep ${i}`, parentId: parent })).id;
  for (let i = 0; i < S(1000, 5000); i++) await ws.createPage({ type: "doc", title: `wide ${i}`, parentId: root });
  for (const [label, fn] of [
    ["search over the tree", () => ws.search("deep")],
    ["listTrash", () => ws.listTrash()],
    ["trash + restore the chain root", async () => { const first = (await ws.listPages()).find((p) => p.title === "deep 0"); await ws.trashPage(first.id); await ws.restorePage(first.id); }],
    ["duplicate the deep chain", async () => { const first = (await ws.listPages()).find((p) => p.title === "deep 0"); await ws.duplicatePage(first.id); }],
    ["move the deepest page to the root", async () => ws.movePage(parent, root)]
  ]) {
    const t = await timeIt(fn);
    record(`workspace ${label} (${deep}-deep + ${S(1000, 5000)}-wide)`, t.ms);
    assert.ok(t.ms < 10000, label);
  }
});
