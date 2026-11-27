// Flowchart engine (js/flow/layout.js): cleaning, quick syntax round trip, layouts (seeded fuzz).
// Replay a failure with FUZZ_SEED=<n>; FUZZ_RUNS=<k> multiplies the case counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzz, XSS, UNICODE, MARKUP } from "./fixtures/fuzz.js";
import {
  LIMITS, SHAPES, LAYOUTS, DIRS, SPACINGS, TURNS, FLOW_HUES, cleanFlow, parseFlow, serializeFlow, layoutFlow, wrapLines, shapeGeometry, nextNodeId
} from "../../source/app/js/flow/layout.js";

const hostileText = (r) => r.pick([r.nasty(3), r.text(60), "", "   ", "x".repeat(r.int(150, 400)), ...XSS.slice(0, 6), ...UNICODE, ...MARKUP.slice(0, 12), "A -> B", "[diamond] x", "\n\nx\ty"]);
const randomFlow = (r, { acyclic = false, max = 24 } = {}) => {
  const n = r.int(0, max);
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`, text: r.chance(0.7) ? r.pick(["Start", "Is it ok?", "Do the thing", "x", "A fairly long label that needs wrapping across lines"]) : hostileText(r),
    shape: r.pick(SHAPES), ...(r.chance(0.3) ? { hue: r.pick([...FLOW_HUES.map((x) => x[0]), "grey"]) } : {}), ...(r.chance(0.1) ? { bg: r.pick(FLOW_HUES)[0] } : {})
  }));
  const edges = [];
  if (n) for (let i = 0, m = r.int(0, n * 2); i < m; i++) {
    let a = r.int(0, n - 1);
    let b = r.int(0, n - 1);
    if (acyclic) {
      if (a === b) continue;
      if (a > b) [a, b] = [b, a];
    }
    edges.push({ from: `n${a}`, to: `n${b}`, ...(r.chance(0.3) ? { label: r.pick(["yes", "no", hostileText(r)]) } : {}), ...(r.chance(0.2) ? { style: "dashed" } : {}), ...(r.chance(0.2) ? { arrow: r.pick(["none", "both"]) } : {}) });
  }
  return { type: "flow", layout: r.pick(LAYOUTS), dir: r.pick(DIRS), rotate: r.pick([0, 45, 90, 200]), turn: r.pick(TURNS), spacing: r.pick(SPACINGS), nodes, edges };
};
const finite = (...v) => v.every((x) => Number.isFinite(x));

test("cleanFlow repairs hostile data and is idempotent", async () => {
  await fuzz("flow-clean", 300, (r) => {
    const raw = r.pick([null, undefined, 5, "x", [], {}, { nodes: "x", edges: 5 }, {
      layout: r.pick(["flow", "zzz", 5, null]), dir: r.pick(["down", "x", {}]), rotate: r.pick([0, -90, 725, NaN, "x", 1e9, 12.6]), turn: r.pick(["cw", "x"]), spacing: r.pick(["roomy", 3]),
      nodes: Array.from({ length: r.int(0, 30) }, () => r.pick([null, 4, "x", [], { id: r.pick(["a", "a", "b c", "__proto__", "", 5, "é1", r.nasty(1)]), text: hostileText(r), shape: r.pick([...SHAPES, "hexagon", 3, null]), hue: r.pick([30, 31, "grey", "blue", "x", -30, 360, null]), bg: r.pick([60, "gray", 7]) }])),
      edges: Array.from({ length: r.int(0, 40) }, () => r.pick([null, 1, { from: "a", to: "b" }, { from: "a", to: "zz" }, { from: "b", to: "b", label: hostileText(r), style: r.pick(["dashed", "x"]), arrow: r.pick(["none", "both", "end", 3]) }, { from: r.nasty(1), to: "a" }]))
    }]);
    const c = cleanFlow(raw);
    assert.deepEqual(cleanFlow(c), c);
    assert.equal(c.type, "flow");
    assert.ok(LAYOUTS.includes(c.layout) && DIRS.includes(c.dir) && TURNS.includes(c.turn) && SPACINGS.includes(c.spacing));
    assert.ok(Number.isInteger(c.rotate) && c.rotate >= 0 && c.rotate < 360);
    const ids = new Set();
    for (const n of c.nodes) {
      assert.match(n.id, /^[\p{L}\p{N}_]{1,32}$/u);
      assert.ok(!ids.has(n.id));
      ids.add(n.id);
      assert.ok(SHAPES.includes(n.shape));
      assert.ok([...n.text].length <= LIMITS.text && n.text === n.text.trim() && !/[\u0000-\u001f]/.test(n.text));
    }
    for (const e of c.edges) assert.ok(ids.has(e.from) && ids.has(e.to));
    assert.ok(c.nodes.length <= LIMITS.nodes && c.edges.length <= LIMITS.edges);
    assert.equal(Object.getPrototypeOf(c), Object.prototype);
  });
});

test("cleanFlow applies the node and edge limits and keeps hostile text as data", () => {
  const nodes = Array.from({ length: 300 }, (_, i) => ({ id: `n${i}`, text: "t" }));
  const edges = Array.from({ length: 900 }, (_, i) => ({ from: `n${i % 300}`, to: "n0" })).filter((e) => nodes.some((n) => n.id === e.from));
  const c = cleanFlow({ nodes, edges });
  assert.equal(c.nodes.length, 200);
  assert.ok(c.edges.length <= 400 && c.edges.every((e) => Number(e.from.slice(1)) < 200));
  for (const p of [...XSS, ...MARKUP]) {
    const one = cleanFlow({ nodes: [{ id: "a", text: p }] }).nodes[0].text;
    assert.ok(typeof one === "string");
    if (!/[\u0000-\u001f]/.test(p) && p.length < 200 && p === p.trim()) assert.equal(one, p);
  }
  assert.equal(cleanFlow({ nodes: [{ id: "a", text: "<img src=x onerror=1>" }] }).nodes[0].text, "<img src=x onerror=1>");
  assert.equal(nextNodeId([{ id: "n1" }, { id: "n3" }]), "n2");
});

test("quick syntax: documented forms parse", () => {
  const p = parseFlow([
    "# comment", "// another", "",
    "Start [pill green]: Begin here", "Ok [diamond] Is it ok?", "Z: just text", "Q [bg=red circle]",
    "Start -> Ok", "Ok -> Done: yes", "Ok -.-> Retry: no", "Done -- Start", "Done <-> Retry: both", "Retry <- Ok", "Z -.- Ok", "Z <-.-> Q"
  ].join("\n"));
  assert.deepEqual(p.errors, []);
  const node = (id) => p.nodes.find((n) => n.id === id);
  assert.deepEqual(node("Start"), { id: "Start", text: "Begin here", shape: "pill", hue: 150 });
  assert.deepEqual(node("Ok"), { id: "Ok", text: "Is it ok?", shape: "diamond" });
  assert.deepEqual(node("Q"), { id: "Q", text: "Q", shape: "circle", bg: 30 });
  assert.equal(node("Done").text, "Done");
  assert.deepEqual(p.edges, [
    { from: "Start", to: "Ok" }, { from: "Ok", to: "Done", label: "yes" }, { from: "Ok", to: "Retry", label: "no", style: "dashed" },
    { from: "Done", to: "Start", arrow: "none" }, { from: "Done", to: "Retry", label: "both", arrow: "both" }, { from: "Ok", to: "Retry", arrow: undefined },
    { from: "Z", to: "Ok", style: "dashed", arrow: "none" }, { from: "Z", to: "Q", style: "dashed", arrow: "both" }
  ].map((e) => JSON.parse(JSON.stringify(e))));
  assert.equal(parseFlow("A: ").nodes[0].text, "");
  assert.ok(parseFlow("!!! ???").errors.length > 0);
  assert.ok(parseFlow("A [wobbly]").errors.length > 0);
});

test("quick syntax round trip (seeded fuzz)", async () => {
  await fuzz("flow-syntax", 300, (r) => {
    const f = cleanFlow(randomFlow(r));
    const back = parseFlow(serializeFlow(f));
    assert.deepEqual(back.errors, []);
    const again = cleanFlow({ nodes: back.nodes, edges: back.edges });
    assert.deepEqual(again.nodes, f.nodes);
    assert.deepEqual(again.edges, f.edges);
    assert.equal(serializeFlow(again), serializeFlow(f));
  });
});

test("parseFlow never throws on garbage and stays bounded", async () => {
  await fuzz("flow-parse-garbage", 300, (r) => {
    const text = Array.from({ length: r.int(0, 30) }, () => r.pick([r.text(40), r.nasty(3), "A -> B", "A->B: x", "->", "- -", "[]", ":", "A [", "A ]", "<-> <->", ...XSS.slice(0, 4)])).join(r.pick(["\n", "\r\n", "\r"]));
    const p = parseFlow(text);
    assert.ok(Array.isArray(p.nodes) && Array.isArray(p.edges) && Array.isArray(p.errors));
    const c = cleanFlow({ nodes: p.nodes, edges: p.edges });
    layoutFlow(c);
  });
  const big = parseFlow(Array.from({ length: 5000 }, (_, i) => `a${i} -> b${i}`).join("\n"));
  assert.ok(big.edges.length <= LIMITS.lines);
  assert.ok(cleanFlow({ nodes: big.nodes, edges: big.edges }).nodes.length <= LIMITS.nodes);
});

function checkLayout(lay, flow, label) {
  const c = cleanFlow(flow);
  assert.ok(finite(lay.width, lay.height), `${label}: size`);
  assert.equal(lay.nodes.length, c.nodes.length, `${label}: all nodes placed`);
  assert.deepEqual(lay.nodes.map((n) => n.id), c.nodes.map((n) => n.id));
  assert.equal(lay.edges.length, c.edges.length, `${label}: edges`);
  for (const n of lay.nodes) {
    assert.ok(finite(n.x, n.y, n.w, n.h, n.cx, n.cy), `${label}: node numbers`);
    assert.ok(n.x >= -0.01 && n.y >= -0.01 && n.x + n.w <= lay.width + 0.01 && n.y + n.h <= lay.height + 0.01, `${label}: inside canvas`);
    assert.ok(n.lines.length >= 1);
  }
  const L = lay.nodes;
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
    const a = L[i];
    const b = L[j];
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    assert.ok(!(ox > 0.01 && oy > 0.01), `${label}: ${a.id} overlaps ${b.id}`);
  }
  for (const e of lay.edges) {
    assert.ok(typeof e.d === "string" && /^M/.test(e.d) && !/NaN|undefined|Infinity/.test(e.d), `${label}: path ${e.d}`);
    assert.ok(finite(e.mid.x, e.mid.y, e.lw, e.lh));
  }
}

test("every layout x direction places all nodes without overlap (seeded fuzz)", async () => {
  await fuzz("flow-layout", 400, (r) => {
    const flow = randomFlow(r, { max: 30 });
    for (const layout of LAYOUTS) for (const dir of DIRS) {
      const f = { ...flow, layout, dir };
      checkLayout(layoutFlow(f), f, `${layout}/${dir}`);
    }
  });
});

test("flow layout respects the direction on acyclic graphs", async () => {
  await fuzz("flow-direction", 300, (r) => {
    const flow = randomFlow(r, { acyclic: true, max: 20 });
    for (const dir of DIRS) {
      const f = { ...flow, layout: "flow", dir };
      const lay = layoutFlow(f);
      const at = new Map(lay.nodes.map((n) => [n.id, n]));
      for (const e of cleanFlow(f).edges) {
        const a = at.get(e.from);
        const b = at.get(e.to);
        if (dir === "down") assert.ok(a.cy < b.cy, `down ${e.from}->${e.to}`);
        if (dir === "up") assert.ok(a.cy > b.cy, `up ${e.from}->${e.to}`);
        if (dir === "right") assert.ok(a.cx < b.cx, `right ${e.from}->${e.to}`);
        if (dir === "left") assert.ok(a.cx > b.cx, `left ${e.from}->${e.to}`);
      }
    }
  });
});

test("flow layout copes with cycles, self loops and parallel edges", () => {
  const nodes = ["a", "b", "c", "d"].map((id) => ({ id, text: id.toUpperCase() }));
  const edges = [["a", "b"], ["b", "c"], ["c", "a"], ["c", "c"], ["b", "a"], ["a", "b"], ["d", "d"]].map(([from, to]) => ({ from, to }));
  for (const layout of LAYOUTS) {
    const f = { layout, nodes, edges };
    checkLayout(layoutFlow(f), f, layout);
  }
  const lay = layoutFlow({ layout: "flow", nodes, edges });
  const at = new Map(lay.nodes.map((n) => [n.id, n]));
  assert.ok(at.get("a").cy < at.get("b").cy && at.get("b").cy < at.get("c").cy, "back edge c->a does not reverse the ranks");
});

test("cycle layout: rotation moves the first node, turn flips the order, ring does not overlap", () => {
  const nodes = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, text: `Step ${i}` }));
  const first = (o) => layoutFlow({ layout: "cycle", nodes, edges: [], ...o });
  const a = first({});
  const top = a.nodes[0];
  assert.ok(top.cy < a.nodes[3].cy, "first node at the top");
  const cw = first({ turn: "cw" });
  const ccw = first({ turn: "ccw" });
  assert.ok(cw.nodes[1].cx > cw.nodes[0].cx && ccw.nodes[1].cx < ccw.nodes[0].cx, "cw goes right first, ccw left");
  const turned = first({ rotate: 90 });
  assert.ok(turned.nodes[0].cx > turned.nodes[3].cx, "rotate 90 puts the first node on the right");
  for (const n of [1, 2, 3, 7, 12, 40]) {
    const f = { layout: "cycle", nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, text: "Some text here", shape: SHAPES[i % SHAPES.length] })), edges: [{ from: "n0", to: `n${n - 1}` }] };
    checkLayout(layoutFlow(f), f, `ring ${n}`);
  }
});

test("empty and tiny flows", () => {
  assert.deepEqual(layoutFlow({}), { width: 0, height: 0, nodes: [], edges: [] });
  for (const layout of LAYOUTS) {
    const f = { layout, nodes: [{ id: "a", text: "" }] };
    checkLayout(layoutFlow(f), f, layout);
  }
});

test("large flows lay out quickly", () => {
  const nodes = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, text: `Node ${i}` }));
  const edges = Array.from({ length: 400 }, (_, i) => ({ from: `n${i % 200}`, to: `n${(i * 7 + 3) % 200}` }));
  for (const layout of LAYOUTS) {
    const t = performance.now();
    const f = { layout, nodes, edges };
    checkLayout(layoutFlow(f), f, layout);
    assert.ok(performance.now() - t < 3000, `${layout} took ${Math.round(performance.now() - t)} ms`);
  }
});

test("text wrapping and shape geometry", async () => {
  await fuzz("flow-wrap", 200, (r) => {
    const lines = wrapLines(hostileText(r));
    assert.ok(lines.length >= 1 && lines.length <= 8);
  });
  for (const s of SHAPES) {
    const g = shapeGeometry(s, 10, 20, 100, 50);
    assert.ok(g.tag && g.attrs && !JSON.stringify(g).match(/NaN|undefined/), s);
  }
  assert.equal(shapeGeometry("nope", 0, 0, 10, 10).tag, "rect");
});

test("markdown: a flow block exports as a fenced flow block and imports back unchanged", async () => {
  const { blocksToMarkdown, markdownToBlocks } = await import("../../source/app/js/blocks/markdown.js");
  const { nodes, edges } = parseFlow("A [diamond blue]: Is it <b>ok</b>?\nA -> B: yes\nA -.-> C\nB <-> C");
  const b = { id: "x1", type: "flow", layout: "cycle", dir: "right", rotate: 90, turn: "ccw", spacing: "roomy", nodes, edges };
  const md = blocksToMarkdown([b]);
  assert.match(md, /^```flow\n# layout: cycle/);
  const back = markdownToBlocks(md);
  assert.equal(back[0].type, "flow");
  assert.equal(blocksToMarkdown(back), md);
});
