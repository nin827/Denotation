// Graph engine: model rules (hidden / one-way / two-way edges, database rows, filters, link index),
// style resolution, and layout determinism, pinning and warm start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, createLinkIndex, normalizeFilter, neighbours } from "../../source/app/js/graph/model.js";
import { resolveStyle, matches, normIcon, normColor, baseRadius, styleGraph, SIZE } from "../../source/app/js/graph/style.js";
import { createLayout, importPositions, rng } from "../../source/app/js/graph/layout.js";

const P = (id, extra = {}) => ({ id, title: id.toUpperCase(), kind: "page", repo: "r1", ...extra });
const edgesOf = (g) => {
  const out = [];
  for (let e = 0; e < g.edgeCount; e++) out.push(`${g.nodes[g.source[e]].id}${g.twoWay[e] ? "<->" : "->"}${g.nodes[g.target[e]].id}`);
  return out.sort();
};
const ids = (g) => g.nodes.map((p) => p.id).sort();

test("mutual normal links draw one two-way edge; a single link is one-way", () => {
  const g = buildGraph({ pages: [P("a"), P("b"), P("c")], links: [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "a", to: "c" }] });
  assert.deepEqual(edgesOf(g), ["a->c", "a<->b"]);
});

test("hidden links draw no edge; hidden A→B with normal B→A is one-way B→A", () => {
  const pages = [P("a"), P("b"), P("c")];
  let g = buildGraph({ pages, links: [{ from: "a", to: "b", hidden: true }] });
  assert.equal(g.edgeCount, 0);
  g = buildGraph({ pages, links: [{ from: "a", to: "b", hidden: true }, { from: "b", to: "a" }] });
  assert.deepEqual(edgesOf(g), ["b->a"]);
  g = buildGraph({ pages, links: [{ from: "a", to: "b", hidden: true }, { from: "b", to: "a", hidden: true }] });
  assert.equal(g.edgeCount, 0);
});

test("a normal link beats a hidden duplicate; self links and links to missing pages are ignored", () => {
  const g = buildGraph({ pages: [P("a"), P("b")], links: [{ from: "a", to: "b", hidden: true }, { from: "a", to: "b" }, { from: "a", to: "a" }, { from: "a", to: "zz" }] });
  assert.deepEqual(edgesOf(g), ["a->b"]);
});

test("database rows: hidden by default, shown when their database is included or a page links them normally", () => {
  const pages = [P("a"), P("db", { kind: "database" }), P("r1", { kind: "row", db: "db" }), P("r2", { kind: "row", db: "db" }), P("r3", { kind: "row", db: "db" }), P("r4", { kind: "row", db: "db" })];
  const links = [
    { from: "a", to: "r1" },                // page → row: shown
    { from: "r2", to: "a" },                // row → page: shown
    { from: "a", to: "r3", hidden: true },  // hidden link does not count
    { from: "r1", to: "r4" }                // row → row does not count
  ];
  let g = buildGraph({ pages, links });
  assert.deepEqual(ids(g), ["a", "db", "r1", "r2"]);
  assert.deepEqual(edgesOf(g), ["a->r1", "r2->a"]);
  g = buildGraph({ pages, links }, { includeDbs: ["db"] });
  assert.deepEqual(ids(g), ["a", "db", "r1", "r2", "r3", "r4"]);
  assert.deepEqual(edgesOf(g), ["a->r1", "r1->r4", "r2->a"]);
});

test("a row linked only from a page outside the repository filter stays hidden", () => {
  const pages = [P("a", { repo: "r2" }), P("b"), P("row", { kind: "row", db: "db", repo: "r1" })];
  const g = buildGraph({ pages, links: [{ from: "a", to: "row" }] }, { repo: "r1" });
  assert.deepEqual(ids(g), ["b"]);
});

test("filters: repository, orphans, search, kinds, where", () => {
  const pages = [P("a"), P("b"), P("c", { repo: "r2" }), P("lonely", { tags: ["x"] }), P("repo1", { kind: "repo" })];
  const links = [{ from: "a", to: "b" }, { from: "b", to: "c" }];
  assert.deepEqual(ids(buildGraph({ pages, links })), ["a", "b", "c", "lonely"]); // repos are not nodes by default
  assert.deepEqual(ids(buildGraph({ pages, links }, { repo: "r1" })), ["a", "b", "lonely"]);
  assert.deepEqual(ids(buildGraph({ pages, links }, { repo: ["r1", "r2"], orphans: false })), ["a", "b", "c"]);
  assert.deepEqual(ids(buildGraph({ pages, links }, { search: "LON" })), ["lonely"]);
  assert.deepEqual(ids(buildGraph({ pages, links }, { kinds: ["repo"] })), ["repo1"]);
  assert.deepEqual(ids(buildGraph({ pages, links }, { where: { field: "tag", op: "is", value: "X" } })), ["lonely"]);
});

test("local graph: depth N from the focus node over undirected edges", () => {
  const pages = ["a", "b", "c", "d", "e"].map((x) => P(x));
  const links = [{ from: "a", to: "b" }, { from: "c", to: "b" }, { from: "c", to: "d" }, { from: "d", to: "e" }];
  const at = (depth) => ids(buildGraph({ pages, links }, { focus: "b", depth }));
  assert.deepEqual(at(0), ["b"]);
  assert.deepEqual(at(1), ["a", "b", "c"]);
  assert.deepEqual(at(2), ["a", "b", "c", "d"]);
  assert.deepEqual(at(3), ["a", "b", "c", "d", "e"]);
  const g = buildGraph({ pages, links }, { focus: "b", depth: 1, orphans: false, search: "zzz" });
  assert.deepEqual(ids(g), ["b"], "the focus node survives search and orphan filters");
  assert.equal(g.nodes[g.focus].id, "b");
  assert.equal(buildGraph({ pages, links }, { focus: "missing" }).nodes.length, 0);
});

test("adjacency and degree", () => {
  const g = buildGraph({ pages: ["a", "b", "c"].map((x) => P(x)), links: [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "c", to: "a" }] });
  const a = g.index.get("a");
  assert.equal(g.degree[a], 2);
  assert.deepEqual(neighbours(g, a).map((i) => g.nodes[i].id).sort(), ["b", "c"]);
});

test("link index: incremental update matches a rebuild from all links", () => {
  const rnd = rng(7);
  const pages = Array.from({ length: 40 }, (_, i) => P("p" + i));
  const idx = createLinkIndex();
  const truth = new Map();
  for (let round = 0; round < 400; round++) {
    const from = "p" + Math.floor(rnd() * 40);
    const links = Array.from({ length: Math.floor(rnd() * 5) }, () => ({ to: "p" + Math.floor(rnd() * 40), hidden: rnd() < 0.3 }));
    idx.update(from, links);
    truth.set(from, links);
    if (rnd() < 0.05) { idx.remove(from); truth.delete(from); }
  }
  const all = [...truth].flatMap(([from, ls]) => ls.map((l) => ({ from, ...l })));
  assert.deepEqual(edgesOf(buildGraph({ pages, linkIndex: idx })), edgesOf(buildGraph({ pages, links: all })));
  const someTo = all[0]?.to;
  if (someTo) assert.deepEqual(idx.incoming(someTo).sort(), [...new Set(all.filter((l) => l.to === someTo).map((l) => l.from))].sort());
});

test("link index: update returns false when nothing changed and bumps version otherwise", () => {
  const idx = createLinkIndex([{ from: "a", to: "b" }]);
  assert.equal(idx.version, 0);
  assert.equal(idx.update("a", [{ to: "b" }]), false);
  assert.equal(idx.update("a", [{ to: "b", hidden: true }]), true);
  assert.equal(idx.version, 1);
  assert.equal(idx.outgoing("a").get("b"), true);
  assert.equal(idx.size, 1);
  assert.equal(idx.update("a", ["c", "c"]), true, "string targets are accepted");
  assert.deepEqual([...idx.links()], [{ from: "a", to: "c", hidden: false }]);
  assert.deepEqual(idx.incoming("b"), []);
});

test("normalizeFilter defaults", () => {
  assert.deepEqual(normalizeFilter(), { repo: null, includeDbs: [], orphans: true, search: "", kinds: null, where: [], focus: null, depth: 1 });
  assert.equal(normalizeFilter({ depth: 99 }).depth, 10);
});

// ---------- style ----------
test("style: explicit per-page setting beats rules; first matching rule wins", () => {
  const rules = [
    { when: { prop: "Status", op: "is", value: "done" }, color: "green", icon: "check" },
    { when: { prop: "Type", op: "is", value: "Person" }, icon: "user", size: 2 },
    { when: { field: "type", op: "is", value: "page" }, color: "blue" }
  ];
  const s1 = resolveStyle({ kind: "page", props: { Status: "Done", Type: "Person" } }, rules, { degree: 0 });
  assert.equal(s1.rule, 0);
  assert.deepEqual(s1.color, { hue: 145 });
  assert.equal(s1.icon, "icon:check");
  assert.equal(s1.size, 1);
  const s2 = resolveStyle({ kind: "page", props: { Type: "Person" }, graph: { color: "#f00", size: "3x" } }, rules, { degree: 0 });
  assert.equal(s2.rule, 1);
  assert.deepEqual(s2.color, { hex: "#f00" });
  assert.equal(s2.icon, "icon:user", "rule icon kept where the explicit setting has none");
  assert.equal(s2.size, 3);
  assert.equal(s2.radius, SIZE.min * 3);
  const s3 = resolveStyle({ kind: "row" }, rules);
  assert.equal(s3.rule, -1);
  assert.equal(s3.color, null);
});

test("style: condition operators", () => {
  const node = { kind: "page", title: "Alpha", repo: "r1", tags: ["Work", "urgent"], props: { N: 5, S: "Doing", M: ["a", "b"], E: "" } };
  const t = (when, degree = 3) => matches(node, when, { degree });
  assert.ok(t({ prop: "S", op: "is", value: "doing" }));
  assert.ok(t({ prop: "S", op: "isNot", value: "done" }));
  assert.ok(t({ prop: "S", op: "contains", value: "oin" }));
  assert.ok(t({ prop: "N", op: "gt", value: "4" }) && !t({ prop: "N", op: "gt", value: "5" }) && t({ prop: "N", op: "gte", value: 5 }));
  assert.ok(t({ prop: "N", op: "lt", value: 6 }) && t({ prop: "N", op: "lte", value: 5 }) && t({ prop: "N", op: "is", value: "5" }));
  assert.ok(t({ prop: "M", op: "is", value: "B" }) && !t({ prop: "M", op: "isNot", value: "a" }) && t({ prop: "M", op: "notContains", value: "z" }));
  assert.ok(t({ prop: "E", op: "empty" }) && t({ prop: "Missing", op: "empty" }) && t({ prop: "S", op: "notEmpty" }));
  assert.ok(t({ field: "tag", op: "is", value: "work" }));
  assert.ok(t({ field: "links", op: "gte", value: 3 }) && !t({ field: "links", op: "gte", value: 3 }, 2));
  assert.ok(t({ field: "repo", op: "in", value: ["r0", "r1"] }) && t({ field: "repo", op: "in", value: "r0, r1" }));
  assert.ok(t({ field: "title", op: "contains", value: "ALP" }));
  assert.ok(t([{ field: "type", op: "is", value: "page" }, { prop: "S", op: "is", value: "Doing" }]));
  assert.ok(!t([{ field: "type", op: "is", value: "page" }, { prop: "S", op: "is", value: "Done" }]));
  assert.ok(!t({ field: "nope", op: "is", value: "x" }));
});

test("style: icon, colour and size normalisation", () => {
  assert.equal(normIcon("check"), "icon:check");
  assert.equal(normIcon("icon:circle-check"), "icon:circle-check");
  assert.equal(normIcon("icon:<script>"), null);
  assert.equal(normIcon("✅"), "✅");
  assert.equal(normIcon("too long text"), null);
  assert.deepEqual(normColor("Green"), { hue: 145 });
  assert.deepEqual(normColor("grey"), { grey: true });
  assert.deepEqual(normColor(400), { hue: 40 });
  assert.deepEqual(normColor("#ABC"), { hex: "#abc" });
  assert.equal(normColor("url(x)"), null);
  assert.equal(normColor("red; background:x"), null);
});

test("style: size follows link count (sqrt, clamped) or is fixed", () => {
  assert.equal(baseRadius(0), SIZE.min);
  assert.ok(baseRadius(4) > baseRadius(1));
  assert.ok(baseRadius(16) - baseRadius(9) < baseRadius(9) - baseRadius(4) + 1e-9, "sub-linear");
  assert.equal(baseRadius(1e6), SIZE.max);
  assert.equal(baseRadius(50, "fixed"), SIZE.fixed);
  const g = buildGraph({ pages: ["a", "b", "c"].map((x) => P(x)), links: [{ from: "a", to: "b" }, { from: "a", to: "c" }] });
  const st = styleGraph(g, [], {});
  assert.ok(st.radius[g.index.get("a")] > st.radius[g.index.get("b")]);
});

// ---------- layout ----------
function synth(n, m, seed = 3) {
  const r = rng(seed), s = [], t = [], seen = new Set();
  for (let i = 1; i < n; i++) { const j = Math.floor(r() * i); s.push(i); t.push(j); seen.add(i + "," + j); }
  while (s.length < m) {
    const a = Math.floor(r() * n), b = r() < 0.7 ? Math.min(n - 1, Math.max(0, a + Math.floor((r() - 0.5) * 40))) : Math.floor(r() * n);
    if (a === b || seen.has(a + "," + b) || seen.has(b + "," + a)) continue;
    seen.add(a + "," + b); s.push(a); t.push(b);
  }
  return { s, t };
}

test("layout: deterministic for the same seed, different for another", () => {
  const { s, t } = synth(150, 400);
  const run = (seed) => { const L = createLayout({ n: 150, source: s, target: t, seed }); while (!L.isSettled()) L.step(); return L.positions(); };
  assert.deepEqual(run(5), run(5));
  // seed only affects jitter; positions still differ somewhere
  const a = run(5), b = createLayout({ n: 150, source: s, target: t, seed: 6, options: { charge: -41 } }).step(50).positions();
  assert.notDeepEqual(a, b);
});

test("layout: settles, separates nodes and keeps linked nodes closer than unlinked ones", () => {
  const { s, t } = synth(300, 900);
  const L = createLayout({ n: 300, source: s, target: t, seed: 1 });
  let k = 0;
  while (!L.isSettled() && k < 2000) { L.step(); k++; }
  assert.ok(L.isSettled(), "settled");
  assert.ok(k < 400, `settled in ${k} ticks`);
  const d = (i, j) => Math.hypot(L.x[i] - L.x[j], L.y[i] - L.y[j]);
  let linked = 0;
  for (let e = 0; e < s.length; e++) linked += d(s[e], t[e]);
  linked /= s.length;
  const r = rng(9);
  let rand = 0;
  for (let q = 0; q < 2000; q++) rand += d(Math.floor(r() * 300), Math.floor(r() * 300));
  rand /= 2000;
  assert.ok(linked < rand * 0.6, `linked ${linked.toFixed(1)} vs random ${rand.toFixed(1)}`);
  for (let i = 0; i < 300; i++) assert.ok(Number.isFinite(L.x[i]) && Number.isFinite(L.y[i]));
  // no two nodes collapsed onto each other
  let close = 0;
  for (let i = 0; i < 300; i++) for (let j = i + 1; j < 300; j++) if (d(i, j) < 0.5) close++;
  assert.ok(close <= 2, `${close} overlapping pairs`);
});

test("layout: pinned nodes stay put while the rest moves", () => {
  const { s, t } = synth(60, 120);
  const L = createLayout({ n: 60, source: s, target: t, seed: 2 });
  L.step(20);
  L.pin(0, 500, -300);
  const before = L.positions();
  L.reheat(0.5).step(30);
  assert.equal(L.x[0], 500);
  assert.equal(L.y[0], -300);
  assert.ok(L.isPinned(0));
  const after = L.positions();
  let movedOthers = 0;
  for (let i = 1; i < 60; i++) if (Math.abs(after[2 * i] - before[2 * i]) > 1e-3) movedOthers++;
  assert.ok(movedOthers > 30);
  L.unpin(0).step(30);
  assert.notEqual(L.x[0], 500);
});

test("layout: warm start from cached positions is instant; partial caches place new nodes near neighbours", () => {
  const { s, t } = synth(200, 500);
  const names = Array.from({ length: 200 }, (_, i) => "n" + i);
  const L = createLayout({ n: 200, source: s, target: t, seed: 1 });
  while (!L.isSettled()) L.step();
  const cache = JSON.parse(JSON.stringify(L.exportPositions(names)));
  const full = importPositions(names, cache);
  assert.equal(full.count, 200);
  const L2 = createLayout({ n: 200, source: s, target: t, seed: 1, positions: full.positions, known: full.known });
  assert.ok(L2.isSettled(), "everything known: nothing to do");
  assert.ok(Math.abs(L2.x[17] - L.x[17]) < 0.06);
  // drop 5 nodes from the cache: short settle, those nodes start near a neighbour
  for (const i of [3, 50, 99, 150, 199]) delete cache[names[i]];
  const part = importPositions(names, cache);
  assert.equal(part.count, 195);
  const L3 = createLayout({ n: 200, source: s, target: t, seed: 1, positions: part.positions, known: part.known });
  assert.ok(!L3.isSettled() && L3.alpha <= 0.12);
  let k = 0;
  while (!L3.isSettled()) { L3.step(); k++; }
  assert.ok(k < 120, `warm settle took ${k} ticks`);
  assert.deepEqual(importPositions(["x"], { x: ["a", 1] }), { positions: null, known: null, count: 0 });
});

test("layout: tiny graphs (0, 1, 2 nodes, coincident points) stay finite", () => {
  for (const n of [0, 1, 2]) {
    const L = createLayout({ n, source: n === 2 ? [0] : [], target: n === 2 ? [1] : [] });
    L.step(50);
    for (let i = 0; i < n; i++) assert.ok(Number.isFinite(L.x[i]));
  }
  const pos = new Float32Array(20); // 10 nodes all at the origin
  const L = createLayout({ n: 10, source: [], target: [], positions: pos, alpha: 1 });
  L.step(100);
  const seen = new Set();
  for (let i = 0; i < 10; i++) { assert.ok(Number.isFinite(L.x[i])); seen.add(L.x[i].toFixed(3) + "," + L.y[i].toFixed(3)); }
  assert.equal(seen.size, 10, "coincident nodes pushed apart");
});
