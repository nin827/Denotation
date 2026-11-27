// Layout benchmark (kept fast): ticks-to-settle, time per tick and scaling. Prints a table; asserts settled-ness
// and roughly O(n log n) growth of the per-tick cost. Full numbers: GRAPH_BENCH=full node --test test/graph-bench.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLayout, rng } from "../public/js/graph/layout.js";
import { buildGraph } from "../public/js/graph/model.js";

function synth(n, m, seed = 3) {
  const r = rng(seed), s = [], t = [], seen = new Set();
  for (let i = 1; i < n; i++) { const j = Math.floor(r() * i); s.push(i); t.push(j); seen.add(i * n + j); }
  while (s.length < m) {
    const a = Math.floor(r() * n), b = r() < 0.7 ? Math.min(n - 1, Math.max(0, a + Math.floor((r() - 0.5) * 40))) : Math.floor(r() * n);
    if (a === b || seen.has(a * n + b) || seen.has(b * n + a)) continue;
    seen.add(a * n + b); s.push(a); t.push(b);
  }
  return { s, t };
}
function settle(n, m) {
  const { s, t } = synth(n, m);
  const L = createLayout({ n, source: s, target: t, seed: 1 });
  L.step(3); // JIT warm-up
  const L2 = createLayout({ n, source: s, target: t, seed: 1 });
  const t0 = performance.now();
  let ticks = 0;
  while (!L2.isSettled() && ticks < 1000) { L2.step(); ticks++; }
  const ms = performance.now() - t0;
  return { n, m, ticks, ms, perTick: ms / ticks, settled: L2.isSettled() };
}

const full = process.env.GRAPH_BENCH === "full";
const sizes = full ? [[250, 750], [1000, 3000], [2000, 6000], [5000, 15000]] : [[200, 600], [800, 2400]];

test("layout settles and per-tick cost grows ~n log n", () => {
  const rows = sizes.map(([n, m]) => settle(n, m));
  console.log("  n      edges  ticks  settle ms  ms/tick");
  for (const r of rows) console.log(`  ${String(r.n).padEnd(6)} ${String(r.m).padEnd(6)} ${String(r.ticks).padEnd(6)} ${r.ms.toFixed(0).padStart(9)}  ${r.perTick.toFixed(2)}`);
  for (const r of rows) assert.ok(r.settled && r.ticks < 400, `${r.n} nodes settled in ${r.ticks} ticks`);
  const [a, b] = [rows[0], rows[rows.length - 1]];
  const ratio = b.perTick / a.perTick, nlogn = (b.n * Math.log2(b.n)) / (a.n * Math.log2(a.n)), quad = (b.n / a.n) ** 2;
  console.log(`  per-tick ratio ${ratio.toFixed(1)}x (n log n predicts ${nlogn.toFixed(1)}x, n² would be ${quad.toFixed(0)}x)`);
  assert.ok(ratio < Math.sqrt(nlogn * quad), "per-tick cost grows well below quadratic");
  if (full) assert.ok(rows.find((r) => r.n === 1000).ms < 1000, "1000 nodes settle in under 1 s");
});

test("building the graph from 5000 pages / 15000 links is fast", () => {
  const n = 5000, { s, t } = synth(n, 15000);
  const pages = Array.from({ length: n }, (_, i) => ({ id: "p" + i, title: "Page " + i, kind: "page", repo: "r" + (i % 3) }));
  const links = s.map((a, e) => ({ from: "p" + a, to: "p" + t[e], hidden: e % 50 === 0 }));
  const t0 = performance.now();
  const g = buildGraph({ pages, links });
  const ms = performance.now() - t0;
  console.log(`  buildGraph 5000/15000: ${ms.toFixed(1)} ms, ${g.edgeCount} edges`);
  assert.equal(g.nodes.length, n);
  assert.ok(ms < 500);
});
