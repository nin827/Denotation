// Function graphs (source/app/js/plot/plot.js): spec cleaning, sampling, discontinuities, ticks, path data, text and
// token round trips, plus seeded fuzz with random and hostile expressions (no throw, no NaN in path data, budget kept).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzz, record } from "./fixtures/fuzz.js";
import {
  cleanPlot, compileExpr, sampleFn, refineSamples, plotModel, niceTicks, tickLabel, clipSegment, serializePlot, parsePlot,
  plotToArg, plotFromArg, plotToken, starterPlot, MAX_FNS, MAX_POINTS, MAX_EXPR, MAX_EVALS, PLOT_ARG_MAX
} from "../../source/app/js/plot/plot.js";
import { FUNCTIONS } from "../../source/app/js/formula.js";

const dOk = (d) => !/NaN|Infinity|undefined/.test(d) && /^(?:[ML][-\d.]+ [-\d.]+|h0\.01)*$/.test(d);
const runs = (d) => (d.match(/M/g) || []).length;

test("cleanPlot: defaults, swaps, caps, hostile input", () => {
  const e = cleanPlot(null);
  assert.deepEqual(e, { fns: [], xmin: -10, xmax: 10, points: [], grid: true });
  assert.deepEqual(cleanPlot({ xmin: 5, xmax: -5 }).xmin, -5);
  assert.equal(cleanPlot({ xmin: 3, xmax: 3 }).xmax, 4);
  assert.equal(cleanPlot({ xmin: "a", xmax: 2 }).xmin, -10);
  assert.equal(cleanPlot({ xmin: 1e12, xmax: 2e12 }).xmax, 10);
  const y = cleanPlot({ ymin: 1, ymax: 0 });
  assert.ok(!("ymin" in y) && !("ymax" in y));
  assert.equal(cleanPlot({ ymin: -2, ymax: 2 }).ymax, 2);
  const many = cleanPlot({ fns: Array.from({ length: 30 }, (_, i) => ({ expr: `x+${i}`, hue: 211 })), points: Array.from({ length: 200 }, (_, i) => ({ x: i, y: i })) });
  assert.equal(many.fns.length, MAX_FNS);
  assert.equal(many.points.length, MAX_POINTS);
  assert.equal(many.fns[0].hue, 210); // snapped to the 12-hue set
  assert.equal(cleanPlot({ fns: [{ expr: "  " }, "x", { expr: "y".repeat(999) }] }).fns[1].expr.length, MAX_EXPR);
  assert.equal(cleanPlot({ fns: [{ expr: "x", hue: "grey" }, { expr: "x", hue: "pink" }] }).fns[1].hue, undefined);
  assert.equal(cleanPlot({ grid: false }).grid, false);
  assert.deepEqual(cleanPlot({ points: [{ x: 1, y: "2", label: "a\nb" }, { x: NaN, y: 1 }, null, { x: 1 }] }).points, [{ x: 1, y: 2, label: "a b" }]);
  for (const bad of [[], "x", 5, { fns: "x", points: 3 }, { __proto__: { fns: [{ expr: "x" }] } }]) cleanPlot(bad);
  assert.equal(({}).fns, undefined);
});

test("compileExpr: x, constants, implicit 2x, errors", () => {
  assert.equal(compileExpr("x^2 + 1").f(3), 10);
  assert.equal(compileExpr("2x + 1").f(4), 9);
  assert.equal(compileExpr("3.5x").f(2), 7);
  assert.ok(Math.abs(compileExpr("x*pi").f(1) - Math.PI) < 1e-9);
  assert.equal(compileExpr("rate * x", (n) => (n === "rate" ? 3 : undefined)).f(2), 6);
  assert.ok(Number.isNaN(compileExpr("1/x").f(0)));
  assert.ok(Number.isNaN(compileExpr("sqrt(x)").f(-1)));
  assert.ok(Number.isNaN(compileExpr('"abc"').f(1)));
  assert.ok(Number.isNaN(compileExpr("x>1").f(1)));
  assert.equal(compileExpr("a +").ok, false);
  assert.equal(compileExpr("").ok, false);
  const bad = compileExpr("nosuch(x)").f;
  assert.ok(Number.isNaN(bad(1)));
  assert.match(bad.lastError, /NAME/);
  assert.ok(typeof FUNCTIONS.SIN === "function" && Math.abs(compileExpr("sin(x)").f(Math.PI / 2) - 1) < 1e-9);
  // the engine cannot reach JavaScript
  for (const s of ["constructor", "globalThis", "process", "this", "window", "eval(1)", "Function(1)"]) assert.ok(Number.isNaN(compileExpr(s).f?.(1) ?? NaN), s);
});

test("sampleFn: n+1 samples, budget and eval cap stop it", () => {
  const s = sampleFn((x) => x, 0, 1, { n: 100 });
  assert.equal(s.xs.length, 101);
  assert.equal(s.xs[100], 1);
  assert.equal(s.truncated, false);
  const capped = sampleFn((x) => x, 0, 1, { n: 400, maxEvals: 50 });
  assert.equal(capped.evals, 50);
  assert.ok(capped.truncated);
  // a fake clock that advances 1 unit per call: the deadline is respected to within one check interval
  let t = 0;
  const slow = sampleFn(() => 1, 0, 1, { n: 400, now: () => t++, deadline: 40 });
  assert.ok(slow.truncated && slow.evals <= 340, `${slow.evals}`);
  assert.equal(sampleFn(() => { throw new Error("x"); }, 0, 1, { n: 5 }).ys.every(Number.isNaN), true);
});

test("tan(x) breaks at each asymptote, 1/x at the pole, sqrt(x) starts at 0", () => {
  const tan = plotModel({ fns: [{ expr: "tan(x)" }], xmin: -6.28, xmax: 6.28 }).series[0];
  assert.equal(runs(tan.d), 5, tan.d.slice(0, 80)); // asymptotes at +-pi/2 and +-3pi/2
  assert.ok(dOk(tan.d));
  const inv = plotModel({ fns: [{ expr: "1/x" }], xmin: -5, xmax: 5 }).series[0];
  assert.equal(runs(inv.d), 2);
  const sq = plotModel({ fns: [{ expr: "sqrt(x)" }], xmin: -4, xmax: 4, ymin: -1, ymax: 3 });
  assert.equal(runs(sq.series[0].d), 1);
  // the curve starts right at x = 0: its first pixel x is the axis position
  const first = Number(/^M([-\d.]+)/.exec(sq.series[0].d)[1]);
  assert.ok(Math.abs(first - sq.axisY) < 1, `${first} vs ${sq.axisY}`);
  // a steep but continuous curve is not cut
  const steep = plotModel({ fns: [{ expr: "x^5" }], xmin: -3, xmax: 3, ymin: -5, ymax: 5 }).series[0];
  assert.equal(runs(steep.d), 1);
  // a step function keeps a run per step side
  assert.ok(runs(plotModel({ fns: [{ expr: "INT(x)*10" }], xmin: -3, xmax: 3, ymin: -5, ymax: 5 }).series[0].d) >= 1);
});

test("refineSamples marks jumps and keeps continuous steep curves joined", () => {
  const xs = Array.from({ length: 21 }, (_, i) => -1 + i / 10);
  const f = (x) => (x < 0.05 ? -5 : 5);
  const pts = refineSamples(f, xs, xs.map(f), 4);
  assert.ok(pts.some((p) => p.brk && p.x > 0 && p.x < 0.1));
  const g = (x) => 50 * x;
  assert.ok(!refineSamples(g, xs, xs.map(g), 4).slice(1).some((p) => p.brk));
});

test("auto y range ignores poles; set range is kept; flat functions get a span", () => {
  const m = plotModel({ fns: [{ expr: "tan(x)" }], xmin: -6.28, xmax: 6.28 });
  assert.ok(m.view.ymax < 60 && m.view.ymax > 2, `${m.view.ymax}`);
  const k = plotModel({ fns: [{ expr: "4" }], xmin: 0, xmax: 1 });
  assert.ok(k.view.ymax > k.view.ymin);
  const r = plotModel({ fns: [{ expr: "x" }], xmin: 0, xmax: 1, ymin: -7, ymax: 9 });
  assert.deepEqual([r.view.ymin, r.view.ymax], [-7, 9]);
  const e = plotModel({ fns: [], xmin: 0, xmax: 1 });
  assert.ok(e.view.ymax > e.view.ymin);
  assert.ok(plotModel({ fns: [{ expr: "x" }], points: [{ x: 0.5, y: 100 }] }).view.ymax >= 100);
});

test("errors: unknown names and syntax show per function; partly defined functions are fine", () => {
  const m = plotModel({ fns: [{ expr: "nosuch(x)" }, { expr: "x +" }, { expr: "sqrt(x)" }], xmin: -2, xmax: 2 });
  assert.equal(m.errors.length, 2);
  assert.match(m.series[0].error, /NAME/);
  assert.ok(m.series[2].d && !m.series[2].error);
  assert.match(m.alt, /y = sqrt\(x\)/);
});

test("niceTicks and tickLabel", () => {
  assert.deepEqual(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(niceTicks(-1, 1, 4), [-1, -0.5, 0, 0.5, 1]);
  assert.deepEqual(niceTicks(0, 0.3, 3), [0, 0.1, 0.2, 0.3]);
  assert.deepEqual(niceTicks(5, 5), []);
  assert.deepEqual(niceTicks(NaN, 5), []);
  assert.deepEqual(niceTicks(Infinity, 5), []);
  assert.ok(niceTicks(0, 1e300, 6).length <= 61);
  assert.ok(niceTicks(0, 1e-300, 6).length <= 61);
  assert.equal(tickLabel(0.5, 0.5), "0.5");
  assert.equal(tickLabel(-0, 1), "0");
  assert.equal(tickLabel(2, 1), "2");
  assert.equal(tickLabel(2e7, 1e7), "2e7");
  assert.equal(tickLabel(0.1 + 0.2, 0.1), "0.3");
});

test("clipSegment", () => {
  assert.equal(clipSegment(0, 5, 1, 6, 0, 4), null);
  const c = clipSegment(0, -2, 2, 6, 0, 4);
  assert.deepEqual([c.a.y, c.b.y, c.ca, c.cb], [0, 4, true, true]);
  assert.deepEqual([c.a.x, c.b.x], [0.5, 1.5]);
  const inside = clipSegment(0, 1, 1, 2, 0, 4);
  assert.equal(inside.ca || inside.cb, false);
  assert.notEqual(clipSegment(0, 1, 1, 1, 0, 4), null);
});

test("text form and token argument round trip", () => {
  const spec = cleanPlot({
    fns: [{ expr: "sin(x)", hue: 210 }, { expr: "x^2/10" }, { expr: "x", hue: "grey" }], xmin: -3, xmax: 3.5, ymin: -2, ymax: 2,
    points: [{ x: 1, y: 0.5, label: "peak: here" }, { x: 2, y: 1 }], grid: false
  });
  assert.deepEqual(parsePlot(serializePlot(spec)), spec);
  assert.deepEqual(parsePlot("sin(x)\ny = 2*x @red\n"), cleanPlot({ fns: [{ expr: "sin(x)" }, { expr: "2*x", hue: 30 }] }));
  assert.deepEqual(plotFromArg(plotToArg(spec)), spec);
  assert.deepEqual(plotFromArg(plotToArg(starterPlot(true))), starterPlot(true));
  assert.equal(plotFromArg("not json"), null);
  assert.equal(plotFromArg("[1]"), null);
  assert.equal(plotFromArg('{"x":[1,2]}'), null);
  const huge = cleanPlot({ fns: Array.from({ length: 8 }, () => ({ expr: "x".repeat(150) })) });
  assert.equal(plotToArg(huge), null);
  assert.equal(plotToken(huge), null);
  // the token text escapes \ | } like every other token
  const tok = plotToken({ fns: [{ expr: 'IF(x>0, "a|b}", 1)' }] });
  assert.ok(tok.startsWith("{{plot:") && tok.endsWith("}}"));
  assert.ok(!/[^\\]\|/.test(tok.slice(7, -2)));
  assert.ok(plotToArg(starterPlot(true)).length < PLOT_ARG_MAX);
});

// ---------- seeded fuzz ----------
const ATOMS = ["x", "x", "x", "pi", "e", "2", "0", "-1", "0.5", "1e308", "1e-300", '"s"', "TRUE", "rate", "nosuch", "[Col]", "x.y", "constructor", "__proto__"];
const FNS = ["SIN", "COS", "TAN", "ABS", "SQRT", "LN", "EXP", "POWER", "MOD", "INT", "ROUND", "IF", "SUM", "MAX", "MIN", "FACT", "ATAN", "LOG", "PRODUCT", "NOSUCH", "TEXT", "LEN"];
const OPS = ["+", "-", "*", "/", "^", "&", "=", "<", ">"];
function gen(r, depth = 0) {
  if (depth > 4 || r.chance(0.25)) return r.pick(ATOMS);
  return r.pick([
    () => `${gen(r, depth + 1)} ${r.pick(OPS)} ${gen(r, depth + 1)}`,
    () => `${r.pick(FNS)}(${Array.from({ length: r.int(0, 3) }, () => gen(r, depth + 1)).join(", ")})`,
    () => `(${gen(r, depth + 1)})`,
    () => `-${gen(r, depth + 1)}`,
    () => `${gen(r, depth + 1)}%`
  ])();
}
const hostile = (r) => r.pick([
  () => r.text(40), () => "(".repeat(r.int(1, 3000)) + "x", () => "x" + "+x".repeat(r.int(1, 150)), () => `"${"a".repeat(300)}`,
  () => "x^".repeat(r.int(1, 90)) + "x", () => r.nasty(), () => "FACT(170)*FACT(170)*x", () => "1/(x-" + r.int(-3, 3) + ")",
  () => `TAN(x*${r.int(1, 99)})`, () => "SIN(1/x)", () => `x^${r.int(2, 300)}`, () => `${r.int(1, 9)}/(x^2-${r.int(0, 5)})`
])();

test("plotModel fuzz: random and hostile expressions never throw, path data has no NaN, work stays bounded", async () => {
  let worst = 0;
  let worstSrc = "";
  const n = await fuzz("plot-model", 700, (r) => {
    const fns = Array.from({ length: r.int(1, 3) }, () => ({ expr: r.chance(0.7) ? gen(r) : hostile(r), hue: r.chance(0.4) ? r.pick([0, 90, 210, "grey", 999, "x"]) : undefined }));
    const raw = {
      fns, xmin: r.pick([-10, -6.28, 0, -1e-3, -1e8, 1, "z", NaN]), xmax: r.pick([10, 6.28, 1e-3, 1e8, 1, 0, null]),
      ymin: r.chance(0.3) ? r.pick([-5, -1e6, 3, NaN]) : undefined, ymax: r.chance(0.3) ? r.pick([5, 1e6, 3, Infinity]) : undefined,
      points: r.chance(0.5) ? [{ x: r.int(-5, 5), y: r.float() * 10, label: r.text(8) }, { x: "q", y: 1 }] : [], grid: r.chance(0.5)
    };
    const t0 = performance.now();
    const m = plotModel(raw, { constant: (k) => (k === "rate" ? 2 : undefined), compact: r.chance(0.3) });
    const ms = performance.now() - t0;
    if (ms > worst) [worst, worstSrc] = [ms, fns.map((f) => f.expr).join(" | ").slice(0, 70)];
    for (const s of m.series) {
      assert.ok(dOk(s.d), `bad path data ${s.d.slice(0, 120)} for ${s.expr}`);
      assert.equal(typeof s.hue === "number" || s.hue === "grey", true);
    }
    for (const t of [...m.xticks, ...m.yticks]) assert.ok(Number.isFinite(t.v) && !/NaN|undefined/.test(t.label));
    for (const p of m.points) assert.ok(Number.isFinite(p.px) && Number.isFinite(p.py));
    assert.ok(m.view.xmax > m.view.xmin && m.view.ymax > m.view.ymin && Number.isFinite(m.view.ymin) && Number.isFinite(m.view.ymax));
    assert.ok(m.xticks.length <= 61 && m.yticks.length <= 61);
    assert.ok(m.series.length <= MAX_FNS);
    assert.equal(typeof m.alt, "string");
  });
  record(`plotModel worst of ${n} fuzz graphs`, worst, worstSrc);
  assert.ok(worst < 1500, `slowest graph took ${worst.toFixed(0)} ms: ${worstSrc}`);
});

test("budget: a slow function stops at its time share and an eval count is capped", () => {
  let calls = 0;
  const fake = { t: 0 };
  // time: every clock read costs 1 unit, budget 100 units split over two functions
  const m = plotModel({ fns: [{ expr: "x" }, { expr: "x*2" }], xmin: 0, xmax: 1 }, { now: () => fake.t++, budgetMs: 100 });
  assert.ok(m.series.every((s) => s.truncated !== undefined));
  assert.ok(m.series.some((s) => s.truncated), "a 100-unit budget cannot cover 800 samples");
  assert.ok(m.series.every((s) => dOk(s.d)));
  // evals: refinement never exceeds the cap
  const f = (x) => {
    calls++;
    return Math.tan(x * 50);
  };
  const s = sampleFn(f, -10, 10, { n: 400 });
  refineSamples(f, s.xs, s.ys, 0.001, { used: s.evals });
  assert.ok(calls <= MAX_EVALS + 2, `${calls} evaluations`);
  // a pathological but valid expression still finishes quickly with the default budget
  const t0 = performance.now();
  plotModel({ fns: Array.from({ length: 8 }, () => ({ expr: "FACT(170)*FACT(170)+SIN(x)*PRODUCT(1,2,3,4,5,6,7,8,9,10,x)" })), xmin: -50, xmax: 50 });
  assert.ok(performance.now() - t0 < 2500);
});

test("compact model draws no ticks but keeps path data and the text alternative", () => {
  const m = plotModel(starterPlot(true), { compact: true });
  assert.ok(m.series[0].d && m.alt.includes("sin(x)"));
  assert.equal(m.box.w, 96);
});
