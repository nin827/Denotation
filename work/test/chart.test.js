// Chart engine (js/chart/chart.js): spec cleaning, data sources, geometry, text alternative, token and Markdown round trips
// (seeded fuzz). Replay a failure with FUZZ_SEED=<n>; FUZZ_RUNS=<k> multiplies the case counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzz, XSS, UNICODE, MARKUP } from "./fixtures/fuzz.js";
import {
  KINDS, AGGS, SIZES, HUES, LIMITS, cleanSpec, specJson, specFromJson, sourceOf, parseNumbers, toNum, downsample, stats, fmtNum,
  dataFromRows, dataFromFormula, literalData, describe, plainText, specToLines, specFromLines, fenceText, sparkGeometry, barGeometry,
  pieGeometry, progressGeometry, progressMax, sliceHue, cellNumber
} from "../../source/app/js/chart/chart.js";
import { buildToken, scanTokens } from "../../source/app/js/blocks/inline.js";
import { blocksToMarkdown, markdownToBlocks } from "../../source/app/js/blocks/markdown.js";
import { newBlock } from "../../source/app/js/blocks/model.js";

const hostile = (r) => r.pick([r.nasty(3), r.text(60), "", "   ", "x".repeat(r.int(60, 200)), ...XSS.slice(0, 6), ...UNICODE, ...MARKUP.slice(0, 14), "a,b", "kind: bar", "}}", "{{", "|", "\\"]);
const hugeNum = (r) => r.pick([0, 1, -1, 3.14159, 1e15, -1e15, 1e300, -1e300, Number.MAX_VALUE, Number.MIN_VALUE, NaN, Infinity, -Infinity, "12", "x", "", null, undefined, true, {}, [], "1e400", r.int(-1000, 1000), r.float() * 1e6]);
const randomRaw = (r) => r.pick([null, undefined, 5, "x", [], {}, {
  k: r.pick([...KINDS.map((x) => x.id), "zzz", 5, null]),
  s: r.pick(["n", "d", "f", "x", undefined]),
  n: r.pick([undefined, "x", Array.from({ length: r.int(0, 40) }, () => hugeNum(r))]),
  l: r.pick([undefined, "x", Array.from({ length: r.int(0, 30) }, () => hostile(r))]),
  d: r.pick([undefined, "db1", "bad id!", r.id(), 5]), c: r.pick([undefined, "c1", "", r.id()]), v: r.pick([undefined, "v1", "x y"]), a: r.pick([...AGGS.map((x) => x.id), "zz"]),
  f: r.pick([undefined, "1+1", hostile(r), 5]),
  h: r.pick([...HUES.map((x) => x[0]), "grey", "gray", "240", 45, -30, 360, "x", null]),
  t: r.pick([undefined, hostile(r)]), m: r.pick([undefined, 100, 0, -5, "50", "x", NaN, 1e300]), z: r.pick([...SIZES.map((x) => x.id), "xl", 3])
}]);

test("cleanSpec repairs hostile data, is idempotent and never throws", async () => {
  await fuzz("chart-clean", 500, (r) => {
    const raw = randomRaw(r);
    for (const block of [false, true]) {
      const c = cleanSpec(raw, { block });
      assert.deepEqual(cleanSpec(c, { block }), c);
      assert.ok(KINDS.some((x) => x.id === c.k));
      assert.ok(c.h === "grey" || (Number.isInteger(c.h) && c.h >= 0 && c.h < 360 && c.h % 30 === 0));
      assert.equal(Object.getPrototypeOf(c), Object.prototype);
      assert.equal(block, "z" in c);
      if (c.n) {
        assert.ok(c.n.length <= LIMITS.nums && c.n.every((v) => Number.isFinite(v) && Math.abs(v) <= LIMITS.maxAbs));
        assert.equal(sourceOf(c), "n");
      }
      for (const l of c.l ?? []) assert.ok([...l].length <= LIMITS.label && !/[\u0000-\u001f]/.test(l));
      assert.ok((c.l?.length ?? 0) <= LIMITS.labels);
      if (c.t) assert.ok([...c.t].length <= LIMITS.title && !/[\r\n]/.test(c.t));
      if (c.f !== undefined) assert.ok(!/[\r\n]/.test(c.f) && c.f.length <= LIMITS.formula);
      if (c.m !== undefined) assert.ok(Number.isFinite(c.m) && c.m > 0);
    }
  });
});

test("numbers: parsing, clamping, formatting", () => {
  assert.deepEqual(parseNumbers("1, 2.5; -3e2\n .5 +4").values, [1, 2.5, -300, 0.5, 4]);
  const p = parseNumbers("1 two 3 NaN Infinity 0x10 1e999");
  assert.deepEqual(p.values, [1, 3]);
  assert.ok(p.bad.includes("two") && p.bad.includes("NaN") && p.bad.includes("0x10"));
  assert.equal(parseNumbers("1 ".repeat(1500)).values.length, LIMITS.nums);
  assert.equal(parseNumbers("1 ".repeat(1500)).over, true);
  assert.equal(toNum("  7 "), 7);
  assert.equal(toNum(""), null);
  assert.equal(toNum(null), null);
  assert.equal(toNum(NaN), null);
  assert.equal(toNum(1e300), 1e15);
  assert.equal(toNum(-1e300), -1e15);
  assert.equal(fmtNum(12), "12");
  assert.equal(fmtNum(12345), "12.35k");
  assert.equal(fmtNum(2500000), "2.5M");
  assert.equal(fmtNum(NaN), "?");
});

test("downsample keeps short lists and reduces 100k values to the limit with the same mean", () => {
  const short = [1, 2, 3];
  assert.equal(downsample(short, 200), short);
  const big = Array.from({ length: 100000 }, (_, i) => (i * 37) % 1000);
  const t0 = performance.now();
  const d = downsample(big, LIMITS.points);
  assert.equal(d.length, LIMITS.points);
  assert.ok(d.every(Number.isFinite));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(Math.abs(mean(d) - mean(big)) < 5);
  const st = stats(big);
  assert.equal(st.n, 100000);
  assert.equal(st.max, 999);
  assert.ok(performance.now() - t0 < 500);
  assert.equal(downsample([], 5).length, 0);
});

test("geometry stays finite for empty, one, flat, negative and huge data", async () => {
  await fuzz("chart-geometry", 400, (r) => {
    const n = r.pick([0, 1, 2, 3, 7, 30, 250, 3000]);
    const kind = r.pick(["small", "huge", "neg", "flat", "mixed"]);
    const values = Array.from({ length: n }, (_, i) => kind === "huge" ? r.pick([1e15, -1e15, 1, 0]) : kind === "neg" ? -r.int(0, 50) : kind === "flat" ? 5 : kind === "small" ? r.int(0, 30) : toNum(r.float() * 200 - 100));
    const labels = r.chance(0.5) ? values.map(() => hostile(r)) : [];
    const finiteAll = (o) => JSON.stringify(o, (_, v) => (typeof v === "number" && !Number.isFinite(v) ? "BAD" : v)).includes("BAD") === false;
    const sp = sparkGeometry(values, r.chance(0.5) ? { w: 560, h: 160, pad: 12, left: 50 } : void 0);
    const ba = barGeometry(values, r.chance(0.5) ? { w: 560, h: 160, detail: true, labels } : void 0);
    const pi = pieGeometry(values, { r: r.pick([10, 110]), labels });
    for (const g of [sp, ba, pi]) if (g) assert.ok(finiteAll(g), JSON.stringify(g).slice(0, 200));
    if (!n) assert.ok(!sp && !ba);
    if (sp) assert.ok(sp.n <= LIMITS.points);
    if (ba) {
      assert.ok(ba.bars.length <= LIMITS.points);
      for (const b of ba.bars) assert.ok(b.h >= 0 && b.w > 0);
    }
    if (pi) {
      assert.ok(pi.slices.length <= LIMITS.slices);
      assert.ok(Math.abs(pi.slices.reduce((a, s) => a + s.frac, 0) - 1) < 1e-6);
    }
    const pg = progressGeometry(r.pick(values.length ? values : [0]), r.pick([100, 0, -1, 1e-9, 1e15]));
    assert.ok(pg === null || (pg.frac >= 0 && pg.frac <= 1 && Number.isInteger(pg.pct)));
  });
});

test("100k literal-sized lists draw through downsampling", () => {
  const big = Array.from({ length: 100000 }, (_, i) => Math.sin(i / 100) * 50);
  const sp = sparkGeometry(big);
  assert.equal(sp.n, LIMITS.points);
  const ba = barGeometry(big);
  assert.equal(ba.bars.length, LIMITS.bars);
  assert.match(describe({ k: "spark" }, { values: big }), /^Sparkline of 100000 values, min -50, max 50, last /);
});

test("pie: negatives and zeros are skipped, 12+ slices merge, a single slice is a circle", () => {
  assert.equal(pieGeometry([0, -3], {}), null);
  assert.equal(pieGeometry([], {}), null);
  const one = pieGeometry([0, 5, -1]);
  assert.equal(one.slices.length, 1);
  assert.equal(one.slices[0].circle, true);
  const many = pieGeometry(Array.from({ length: 30 }, () => 1), { labels: [] });
  assert.equal(many.slices.length, LIMITS.slices);
  assert.equal(many.slices.at(-1).label, "Other");
  assert.equal(many.slices.at(-1).value, 19);
  assert.equal(sliceHue("grey", 3), "grey");
  assert.equal(new Set(Array.from({ length: 12 }, (_, i) => sliceHue(240, i))).size, 12);
});

test("text alternative summarises the data", () => {
  const spark = cleanSpec({ k: "spark", n: [3, 40, 5, 22] });
  assert.equal(describe(spark, literalData(spark)), "Sparkline of 4 values, min 3, max 40, last 22");
  assert.equal(describe({ ...spark, k: "bar", t: "Sales" }, literalData(spark)), "Sales: Bar chart of 4 values, min 3, max 40, last 22");
  const prog = cleanSpec({ k: "progress", n: [30, 12], m: 84 });
  assert.equal(describe(prog, literalData(prog)), "Progress 50%, 42 of 84");
  const pie = cleanSpec({ k: "pie", n: [1, 3], l: ["a", "b"] });
  assert.equal(describe(pie, literalData(pie)), "Pie chart of 2 slices, largest b, 75%");
  assert.equal(describe(spark, { values: [] }), "Sparkline with no data");
  assert.equal(describe(spark, { values: [], error: "Column not found" }), "Sparkline, Column not found");
  assert.equal(plainText(spark, literalData(spark)), "3, 40, 5, 22");
  assert.equal(plainText(cleanSpec({ k: "pie", n: [1, 3], l: ["a", "b"] }), { values: [1, 3] }), "a 1, b 3");
  assert.match(plainText(spark, { values: Array(50).fill(1) }), /^Sparkline of 50 values/);
});

const db = {
  columns: [
    { id: "n", name: "Amount", type: "number" }, { id: "k", name: "Kind", type: "select", config: { options: ["a", "b", "c"] } },
    { id: "t", name: "Note", type: "text" }, { id: "x", name: "Done", type: "checkbox" }
  ],
  views: [{ id: "v1", name: "Only a", type: "table", filter: { op: "and", rules: [{ col: "k", op: "is", value: "a" }] }, sorts: [{ col: "n", dir: "desc" }] }]
};
const rows = [
  { id: "1", values: { n: 5, k: "a", t: "7", x: true } }, { id: "2", values: { n: 10, k: "b", x: false } }, { id: "3", values: { n: null, k: "a", t: "z" } },
  { id: "4", values: { n: 20, k: "a", x: true } }, { id: "5", values: { k: "c", n: "n/a" } }
];

test("database source: columns, aggregates, saved view filter, errors", () => {
  const base = { k: "spark", s: "d", d: "db1", c: "n", a: "rows" };
  assert.deepEqual(dataFromRows(base, db, rows).values, [5, 10, 20]);
  assert.deepEqual(dataFromRows({ ...base, v: "v1" }, db, rows).values, [20, 5]);
  assert.deepEqual(dataFromRows({ ...base, a: "sum" }, db, rows).values, [35]);
  assert.deepEqual(dataFromRows({ ...base, a: "avg" }, db, rows).values, [35 / 3 > 11.66 ? Number((35 / 3).toPrecision(9)) : 0]);
  assert.deepEqual(dataFromRows({ ...base, a: "min", v: "v1" }, db, rows).values, [5]);
  assert.deepEqual(dataFromRows({ ...base, a: "max" }, db, rows).values, [20]);
  const cnt = dataFromRows({ ...base, c: "k", a: "count" }, db, rows);
  assert.deepEqual(cnt.values, [3, 1, 1]);
  assert.deepEqual(cnt.labels, ["a", "b", "c"]);
  const chk = dataFromRows({ ...base, c: "x", a: "sum" }, db, rows);
  assert.deepEqual(chk.values, [2]);
  assert.equal(chk.max, 5);
  assert.equal(progressMax({ k: "progress" }, chk), 5);
  assert.equal(progressMax({ k: "progress", m: 9 }, chk), 9);
  assert.equal(progressMax({ k: "progress" }, { values: [1] }), 100);
  assert.match(dataFromRows({ ...base, c: "t" }, db, rows.slice(2, 3)).error ?? "", /no numbers/);
  assert.equal(dataFromRows({ ...base, c: "zz" }, db, rows).error, "Column not found");
  assert.equal(dataFromRows({ ...base, c: "" }, db, rows).error, "Pick a column");
  assert.equal(dataFromRows({ ...base, v: "nope" }, db, rows).error, "View not found");
  assert.equal(dataFromRows(base, null, rows).error, "Database not found");
  assert.deepEqual(dataFromRows(base, db, []).values, []);
  assert.equal(cellNumber(db.columns[3], undefined), 0);
  assert.equal(cellNumber(db.columns[0], "12"), 12);
});

test("database source survives 100k rows quickly and fuzzed rows", async () => {
  const big = Array.from({ length: 100000 }, (_, i) => ({ id: String(i), values: { n: i % 977, k: ["a", "b", "c"][i % 3] } }));
  const t0 = performance.now();
  const d = dataFromRows({ k: "spark", s: "d", d: "db1", c: "n", a: "rows" }, db, big);
  assert.equal(d.values.length, 100000);
  assert.equal(sparkGeometry(d.values).n, LIMITS.points);
  assert.deepEqual(dataFromRows({ k: "pie", s: "d", d: "db1", c: "k", a: "count" }, db, big).values.reduce((a, b) => a + b, 0), 100000);
  assert.ok(performance.now() - t0 < 3000);
  await fuzz("chart-rows", 300, (r) => {
    const rs = Array.from({ length: r.int(0, 30) }, (_, i) => ({ id: String(i), values: r.pick([{}, null, { n: hugeNum(r), k: hostile(r), t: hostile(r), x: r.pick([true, false, "x", 1]) }]) })).filter(Boolean);
    for (const c of ["n", "k", "t", "x", "zz"]) for (const a of AGGS) {
      const out = dataFromRows({ k: "bar", s: "d", d: "db1", c, a: a.id, v: r.pick(["", "v1"]) }, db, rs);
      assert.ok(out.values.every(Number.isFinite) && out.values.length <= Math.max(LIMITS.nums, rs.length));
      assert.ok(out.labels.every((l) => typeof l === "string"));
    }
  });
});

test("formula source: numbers, lists and errors", () => {
  assert.deepEqual(dataFromFormula({ ok: true, value: 42 }).values, [42]);
  assert.deepEqual(dataFromFormula({ ok: true, value: "3, 5, 8" }).values, [3, 5, 8]);
  assert.deepEqual(dataFromFormula({ ok: true, value: "[1; 2 ; x]" }).values, [1, 2]);
  assert.equal(dataFromFormula({ ok: true, value: "hello" }).error, "The formula gives no numbers");
  assert.deepEqual(dataFromFormula({ ok: true, value: null }).values, []);
  assert.deepEqual(dataFromFormula({ ok: true, value: true }).values, [1]);
  assert.equal(dataFromFormula({ ok: false, error: "#NAME?", detail: "x" }).error, "#NAME?");
  assert.equal(dataFromFormula(null).error, "Formula error");
});

test("token round trip: {{chart:<json>}} survives escaping, scanning and hostile labels", async () => {
  await fuzz("chart-token", 400, (r) => {
    const spec = cleanSpec({ ...randomRaw(r), s: "n", n: Array.from({ length: r.int(0, 25) }, () => toNum(hugeNum(r)) ?? 1), l: Array.from({ length: r.int(0, 6) }, () => hostile(r)), t: hostile(r) });
    const token = buildToken("chart", [specJson(spec)]);
    if (token === null) return assert.ok(specJson(spec).length > 3000, "only oversize tokens are refused");
    const text = `before ${token} after`;
    const found = scanTokens(text);
    assert.equal(found.length, 1, text);
    assert.equal(found[0].node.kind, "chart");
    assert.deepEqual(specFromJson(found[0].node.args[0]), spec);
  });
  assert.equal(buildToken("chart", ["not json"]), null);
  assert.equal(buildToken("chart", ["[1,2]"]), null);
  assert.equal(buildToken("chart", ["{}", "x"]), null);
  assert.equal(specFromJson("not json"), null);
  assert.equal(specFromJson("[1]"), null);
  assert.equal(specFromJson("x".repeat(30000)), null);
});

test("hostile labels stay data: no markup is interpreted, text is kept", () => {
  const evil = "<img src=x onerror=\"window.__fuzzXss=1\">";
  const spec = cleanSpec({ k: "pie", n: [1, 2], l: [evil, "</textarea><script>1</script>"], t: evil });
  assert.equal(spec.l[0], evil);
  assert.equal(spec.t, evil);
  assert.ok(describe(spec, literalData(spec)).startsWith(`${evil}: Pie chart`));
  const token = buildToken("chart", [specJson(spec)]);
  assert.equal(scanTokens(token).length, 1);
});

test("Markdown fence round trip for the block, and the chip text export", async () => {
  await fuzz("chart-fence", 300, (r) => {
    const raw = randomRaw(r);
    const spec = cleanSpec({ ...(raw && typeof raw === "object" ? raw : {}), s: r.pick(["n", "d", "f"]), n: raw?.n, t: hostile(r), l: Array.from({ length: r.int(0, 4) }, () => hostile(r)) }, { block: true });
    const lines = specToLines(spec);
    assert.deepEqual(specFromLines(lines), spec, lines.join("\n"));
    const b = newBlock("chart", spec);
    const md = blocksToMarkdown([b]);
    assert.ok(md.startsWith("```chart\n") && md.endsWith("\n```"));
    const back = markdownToBlocks(md);
    assert.equal(back.length, 1);
    assert.equal(back[0].type, "chart");
    const { id, type, ...rest } = back[0];
    assert.deepEqual(cleanSpec(rest, { block: true }), spec);
  });
  const md = fenceText({ k: "bar", n: [1, 2, 3], l: ["a", "b", "c"], z: "l", h: 120 });
  assert.match(md, /^```chart\nkind: bar\nsource: numbers\ndata: 1, 2, 3\nlabels: \["a","b","c"\]\ncolor: 120\nsize: l\n# Bar chart of 3 values, min 1, max 3, last 3\n```$/);
  assert.deepEqual(specFromLines(["# comment", "kind: nonsense", "color: 45", "data: 1 2 x"]), cleanSpec({ n: [1, 2] }, { block: true }));
  const two = markdownToBlocks(`text\n\n${md}\n\nmore`);
  assert.deepEqual(two.map((b) => b.type), ["p", "chart", "p"]);
});
