// Seeded fuzz for the formula engine (formula.js): random well-formed and garbage expressions never throw out of
// evalExpression / previewFormula / applyFormulas, stay within a time budget, and can't reach JavaScript globals or
// prototypes. Also pins the pathological inputs found by fuzzing (wildcard criteria, inherited keys).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzz, record, HEAVY } from "./fixtures/fuzz.js";
import { evalExpression, applyFormulas, previewFormula, check, FUNCTIONS, formulaRefs, renameColumnRefs, isErrorValue } from "../../source/app/js/formula.js";

const FN_NAMES = Object.keys(FUNCTIONS);
const COLS = [
  { id: "c1", name: "Name", type: "text", config: {} },
  { id: "c2", name: "Qty", type: "number", config: {} },
  { id: "c3", name: "Done", type: "checkbox", config: {} },
  { id: "c4", name: "When", type: "date", config: {} },
  { id: "c5", name: "J", type: "json", config: {} },
  { id: "c6", name: "__proto__", type: "text", config: {} }
];
const lit = (r) => r.pick([
  () => String(r.int(-1000, 1000)), () => `${r.int(0, 99)}.${r.int(0, 99)}`, () => "1e308", () => "0", () => "TRUE", () => "FALSE",
  () => `"${r.text(6, [..."ab* ?\"-,0129"]).replace(/"/g, '""')}"`, () => `"2024-02-29"`, () => `"#DIV/0!"`, () => `""`
])();
function expr(r, depth = 0, cols = true) {
  if (depth > 4 || r.chance(0.3)) {
    if (cols && r.chance(0.4)) return r.pick(["[Name]", "[Qty]", "[Done]", "[When]", "[J]", "[J].a", "[__proto__]", "[Missing]"]);
    return lit(r);
  }
  return r.pick([
    () => `${expr(r, depth + 1, cols)} ${r.pick(["+", "-", "*", "/", "^", "&", "=", "<>", "<", ">", "<=", ">="])} ${expr(r, depth + 1, cols)}`,
    () => `-${expr(r, depth + 1, cols)}`,
    () => `(${expr(r, depth + 1, cols)})`,
    () => `${expr(r, depth + 1, cols)}%`,
    () => `${r.pick(FN_NAMES)}(${Array.from({ length: r.int(0, 3) }, () => expr(r, depth + 1, cols)).join(", ")})`,
    () => `IF(${expr(r, depth + 1, cols)}, ${expr(r, depth + 1, cols)}, ${expr(r, depth + 1, cols)})`,
    () => `IFERROR(${expr(r, depth + 1, cols)}, ${lit(r)})`,
    () => (cols ? `SUM(ALL([Qty]))` : `SUM(1,2)`),
    () => `${r.pick(["CONST", "VALUE", "PRESET", "PROP"])}(${lit(r)}${r.chance(0.5) ? `, ${lit(r)}, ${lit(r)}` : ""})`,
    () => r.pick(["globalThis", "process", "constructor", "this", "window", "eval", "Function", "__proto__", "prototype", "toString"])
  ])();
}
const okValue = (v) => v === null || ["number", "string", "boolean"].includes(typeof v);

test("evalExpression: random expressions never throw, return plain values and stay fast", async () => {
  let worst = 0;
  let worstSrc = "";
  const n = await fuzz("formula-eval", 6000, (r) => {
    const src = expr(r, 0, false);
    const t0 = performance.now();
    const res = evalExpression(src, { constant: (k) => (k === "rate" ? 2 : undefined), value: () => 5, preset: () => "p" });
    const ms = performance.now() - t0;
    if (ms > worst) [worst, worstSrc] = [ms, src];
    assert.equal(typeof res.ok, "boolean");
    assert.ok(okValue(res.value), `non-plain value ${typeof res.value} from ${src}`);
    if (!res.ok) assert.ok(isErrorValue(res.error), res.error);
  });
  record(`evalExpression worst of ${n} random expressions`, worst, worstSrc.slice(0, 60));
  assert.ok(worst < 250, `slowest expression took ${worst.toFixed(0)} ms: ${worstSrc}`);
});

test("evalExpression: garbage text never throws", async () => {
  await fuzz("formula-garbage", 6000, (r) => {
    const src = Array.from({ length: r.int(0, 20) }, () => r.pick(["(", ")", "[", "]", "\"", ",", ";", ".", "%", "^", "=", "<", ">", "!", "&", "1", "a", "SUM", "IF", " ", "\\", "{", "}", "'", "#", "\u0000", "e5", "..", r.nasty(1)])).join("");
    const res = evalExpression(src);
    assert.equal(typeof res.ok, "boolean");
    const c = check(src);
    assert.equal(typeof c.ok, "boolean");
    formulaRefs(src);
    assert.equal(typeof renameColumnRefs(src, "a", "b"), "string");
  });
});

test("applyFormulas: random formula columns over random rows never throw; results are plain values", async () => {
  await fuzz("formula-apply", 400, (r) => {
    const fcols = Array.from({ length: r.int(1, 3) }, (_, i) => ({ id: `f${i}`, name: `F${i}`, type: "formula", config: { expr: r.chance(0.9) ? expr(r) : r.nasty(1) } }));
    // formulas may reference each other (and themselves)
    if (r.chance(0.3)) fcols[0].config.expr = `[F${r.int(0, fcols.length - 1)}] + 1`;
    const columns = [...COLS, ...fcols];
    const rows = Array.from({ length: r.int(0, 30) }, (_, i) => ({ id: `r${i}`, dbId: "db", values: {
      c1: r.pick(["apple", "Ab", "", null, r.nasty(1)]), c2: r.pick([r.int(-9, 9), "3", null, "x", 1e308]), c3: r.chance(0.5), c4: r.pick(["2024-02-29", "2023-02-30", null]),
      c5: r.pick([{ a: 1 }, JSON.parse('{"__proto__":{"a":2}}'), [1], "s", null]), c6: "proto-col"
    } }));
    applyFormulas(columns, rows);
    for (const row of rows) for (const f of fcols) assert.ok(okValue(row.values[f.id]) || row.values[f.id] === undefined, `${f.config.expr} -> ${typeof row.values[f.id]}`);
    if (rows.length) previewFormula(r.pick(fcols).config.expr, columns, rows, r.int(0, rows.length - 1));
    assert.equal({}.a, undefined);
  });
});

test("formulas cannot reach JavaScript: global names, prototype members and function names are #NAME?", () => {
  for (const name of ["globalThis", "process", "require", "eval", "Function", "constructor", "__proto__", "prototype", "this", "window", "document"]) {
    assert.equal(evalExpression(name).error, "#NAME?", name);
    assert.equal(evalExpression(`${name}(1)`).error, "#NAME?", `${name}()`);
    assert.equal(evalExpression(`${name.toUpperCase()}(1)`).error, "#NAME?", `${name.toUpperCase()}()`);
  }
  for (const fn of ["TOSTRING", "VALUEOF", "HASOWNPROPERTY", "__PROTO__", "CONSTRUCTOR", "__DEFINEGETTER__", "ISPROTOTYPEOF"]) assert.equal(evalExpression(`${fn}()`).error, "#NAME?", fn);
});

test("key access on JSON values reads own keys only", { todo: "BUG (low): formula key access uses `n.key in o`, so [J].constructor / [J].__proto__ return inherited members (a function value lands in the cell)" }, () => {
  const rows = [{ id: "r", values: { j: { a: 1 } } }];
  const cols = [{ id: "j", name: "J", type: "json", config: {} }];
  for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const res = previewFormula(`[J].${k}`, cols, rows);
    assert.equal(res.value, "#REF!", `[J].${k} -> ${typeof res.value}`);
  }
});

test("wildcard criteria are linear-time (no catastrophic regex backtracking)", { todo: "BUG: COUNTIF/SUMIF/AVERAGEIF compile '*' to '.*' in a RegExp; many stars against a long value backtrack exponentially (UI hang from one inline formula)" }, () => {
  const t0 = performance.now();
  evalExpression(`COUNTIF(REPT("a",${HEAVY ? 34 : 27}),"*a*a*a*a*a*a*a*a*a*a*a*b")`);
  const ms = performance.now() - t0;
  record("COUNTIF wildcard backtracking (27 a's, 11 stars; FUZZ_HEAVY: 34)", ms);
  assert.ok(ms < 50, `${ms.toFixed(0)} ms`);
});

test("wildcard criteria: timing grows with the value length (printed)", () => {
  const rows = [];
  for (const n of [16, 20, 24]) {
    const t0 = performance.now();
    evalExpression(`COUNTIF(REPT("a",${n}),"*a*a*a*a*a*a*a*a*a*a*b")`);
    rows.push([n, performance.now() - t0]);
  }
  for (const [n, ms] of rows) record(`COUNTIF "*a*a…*b" against ${n} a's`, ms);
  assert.ok(rows.every(([, ms]) => ms < 5000));
});

test("nested REPT can't build huge strings cheaply", { todo: "BUG (low): REPT caps one call at 1000 copies but nesting multiplies (REPT(REPT(REPT(\"a\",1000),1000),500) = 500 MB string; UPPER/LEN on it allocate)" }, () => {
  const res = evalExpression('LEN(REPT(REPT(REPT("a",1000),1000),500))');
  assert.ok(!res.ok || res.value <= 1e6, `built a ${res.value}-character string`);
});

test("very long / deeply nested formulas return an error code instead of overflowing", () => {
  for (const src of ["(".repeat(20000) + "1" + ")".repeat(20000), Array(50000).fill("1").join("+"), "-".repeat(50000) + "1", "SUM(".repeat(5000) + "1" + ")".repeat(5000)]) {
    const res = evalExpression(src);
    assert.equal(typeof res.ok, "boolean");
  }
});
