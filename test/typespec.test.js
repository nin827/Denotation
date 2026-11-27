import { test } from "node:test";
import assert from "node:assert/strict";
import { parseType, formatType, validate, clamp, defaultFor, summary, getPath, specAt, leafPaths, shapeIndex, issueText } from "../public/js/typespec.js";

const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

test("parses the documented grammar", () => {
  const ok = (t) => {
    const r = parseType(t);
    assert.ok(r.ok, `${t}: ${r.error}`);
    return r.spec;
  };
  assert.deepEqual(ok("String"), { kind: "string" });
  assert.deepEqual(ok("bool"), { kind: "bool" });
  assert.deepEqual(ok("int(0..10)"), { kind: "int", min: 0, max: 10 });
  assert.deepEqual(ok("float(..1.5)"), { kind: "float", max: 1.5 });
  assert.deepEqual(ok("float(-2.5..)"), { kind: "float", min: -2.5 });
  assert.deepEqual(ok('("low", "mid", "high")'), { kind: "enum", choices: ["low", "mid", "high"] });
  assert.deepEqual(ok('Array[("a", "b")]'), { kind: "enumlist", choices: ["a", "b"] });
  assert.deepEqual(ok("Array[int]"), { kind: "array", of: { kind: "int" } });
  assert.deepEqual(ok("Array"), { kind: "array", of: { kind: "any" } });
  assert.deepEqual(ok("Dictionary"), { kind: "dict" });
  assert.deepEqual(ok("Dictionary[float]"), { kind: "map", of: { kind: "float" } });
  const st = ok("Dictionary{name: String, level: int(1..99), stats: Dictionary{hp: int, sp: int}}");
  assert.equal(st.kind, "struct");
  assert.deepEqual(st.keys.map((k) => k.key), ["name", "level", "stats"]);
  assert.equal(st.keys[2].spec.kind, "struct");
  const un = ok("String | Dictionary{a: int}");
  assert.equal(un.kind, "union");
  assert.equal(un.alts.length, 2);
  assert.deepEqual(ok("  "), { kind: "any" });
  assert.deepEqual(ok("string"), { kind: "string" }, "keywords are case-insensitive");
});

test("type errors are clear and positioned", () => {
  const bad = (t, re) => {
    const r = parseType(t);
    assert.equal(r.ok, false, t);
    assert.match(r.error, re, `${t} -> ${r.error}`);
  };
  bad("Foo", /Unknown type "Foo".*character 1/);
  bad("int(5..1)", /minimum 5 is above the maximum 1/);
  bad("int(1.5..3)", /whole numbers/);
  bad("Dictionary{a: int, a: String}", /listed twice/);
  bad("Dictionary{}", /at least one key/);
  bad("Array[int", /Expected "\]"/);
  bad("String | String", /twice/);
  bad('("a", "a")', /repeats/);
  bad("int extra", /Unexpected/);
  bad('Dictionary{"a.b": int}', /cannot contain a dot/);
});

// random specs for the round-trip fuzz
function randSpec(rnd, depth = 0) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const words = ["a", "b c", 'q"t', "ü", "x\\y", "", "z1"];
  const leaf = () => {
    const k = pick(["string", "bool", "int", "float", "enum", "any", "dict"]);
    if (k === "int" || k === "float") {
      const s = { kind: k };
      const n = () => k === "int" ? Math.floor(rnd() * 200) - 100 : Math.round((rnd() * 200 - 100) * 100) / 100;
      if (rnd() < 0.5) s.min = n();
      if (rnd() < 0.5) s.max = n();
      if (s.min !== undefined && s.max !== undefined && s.min > s.max) [s.min, s.max] = [s.max, s.min];
      return s;
    }
    if (k === "enum") return { kind: "enum", choices: [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(words)))] };
    return { kind: k };
  };
  if (depth >= 3) return leaf();
  const k = pick(["leaf", "leaf", "array", "enumlist", "struct", "struct", "map", "union"]);
  if (k === "array") {
    const of = randSpec(rnd, depth + 1);
    return of.kind === "enum" ? { kind: "enumlist", choices: of.choices } : { kind: "array", of }; // Array[enum] is an enum list
  }
  if (k === "map") return { kind: "map", of: randSpec(rnd, depth + 1) };
  if (k === "enumlist") return { kind: "enumlist", choices: [...new Set([pick(words), pick(words)])] };
  if (k === "struct") {
    const keys = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pick(["name", "level", "hp", "sp", "my-key", "0", "with space", "ä"])))];
    return { kind: "struct", keys: keys.map((key) => ({ key, spec: randSpec(rnd, depth + 1) })) };
  }
  if (k === "union") {
    const alts = [];
    for (let i = 0; i < 2 + Math.floor(rnd() * 2); i++) {
      let a = randSpec(rnd, depth + 1);
      if (a.kind === "union") a = a.alts[0];
      if (!alts.some((x) => formatType(x) === formatType(a))) alts.push(a);
    }
    return alts.length > 1 ? { kind: "union", alts } : alts[0];
  }
  return leaf();
}
function randValue(rnd, depth = 0) {
  const r = rnd();
  if (depth > 3 || r < 0.5) return [null, true, false, 0, -3, 2.5, 150, "a", "z1", "", "hello"][Math.floor(rnd() * 11)];
  if (r < 0.75) return Array.from({ length: Math.floor(rnd() * 4) }, () => randValue(rnd, depth + 1));
  const o = {};
  for (const k of ["name", "level", "hp", "x"]) if (rnd() < 0.6) o[k] = randValue(rnd, depth + 1);
  return o;
}

test("format -> parse round trips on seeded fuzz", () => {
  const rnd = rng(7);
  for (let i = 0; i < 1500; i++) {
    const spec = randSpec(rnd);
    const text = formatType(spec);
    const r = parseType(text);
    assert.ok(r.ok, `${text}: ${r.error}`);
    assert.deepEqual(r.spec, spec, text);
    assert.equal(formatType(r.spec), text);
  }
});

test("defaults validate, clamp is idempotent and brings numbers into range (seeded fuzz)", () => {
  const rnd = rng(42);
  for (let i = 0; i < 1500; i++) {
    const spec = randSpec(rnd);
    const d = defaultFor(spec);
    assert.deepEqual(validate(spec, d), [], `${formatType(spec)} default ${JSON.stringify(d)}`);
    assert.deepEqual(clamp(spec, d), d);
    const v = randValue(rnd);
    const issues = validate(spec, v);
    assert.ok(Array.isArray(issues));
    for (const x of issues) assert.equal(typeof issueText(x), "string");
    const c = clamp(spec, v);
    assert.deepEqual(clamp(spec, c), c, "clamp is idempotent");
    assert.ok(!validate(spec, c).some((x) => /above the maximum|below the minimum/.test(x.message)) || spec.kind === "union", `${formatType(spec)} ${JSON.stringify(c)}`);
    assert.equal(typeof summary(spec, v), "string");
    assert.ok(summary(spec, v, 40).length <= 40);
    assert.deepEqual(JSON.parse(JSON.stringify(v)), v, "validate/clamp never mutate their input");
  }
});

test("validate reports paths; invalid values are flagged, not changed", () => {
  const spec = parseType('Dictionary{name: String, level: int(1..99), stats: Dictionary{hp: int, sp: int}, tags: Array[("a", "b")]}').spec;
  const v = { name: "Ava", level: 120, stats: { hp: 1.5 }, tags: ["a", "c", "a"], extra: 1 };
  const got = validate(spec, v).map(issueText);
  assert.deepEqual(got, [
    "level: 120 is above the maximum 99",
    "stats.hp: expected a whole number, got 1.5",
    "stats.sp: missing",
    'tags.1: "c" is not one of "a", "b"',
    'tags.2: "a" is listed twice',
    "extra: unknown key"
  ]);
  assert.deepEqual(validate(spec, null), [], "empty is never an issue");
  assert.equal(clamp(spec, v).level, 99);
  assert.equal(clamp(spec, v).stats.hp, 2);
  assert.equal(v.level, 120);
});

test("unions pick the matching shape", () => {
  const spec = parseType("String | Dictionary{label: String, weight: float(0..1)}").spec;
  assert.equal(shapeIndex(spec, "x"), 0);
  assert.equal(shapeIndex(spec, { label: "a", weight: 0.5 }), 1);
  assert.equal(shapeIndex(spec, { label: "a", weight: 5 }), 1, "falls back to the JSON shape");
  assert.equal(shapeIndex(spec, 3), -1);
  assert.deepEqual(validate(spec, { label: "a", weight: 5 }).map(issueText), ["weight: 5 is above the maximum 1"]);
  assert.match(issueText(validate(spec, 3)[0]), /Expected text or fields/);
});

test("summary is compact", () => {
  const spec = parseType("Dictionary{name: String, level: int, stats: Dictionary{hp: int}}").spec;
  assert.equal(summary(spec, { level: 12, name: "Ava", stats: { hp: 3 } }), "{name: Ava, level: 12, stats: {hp: 3}}");
  assert.equal(summary(spec, null), "");
  assert.ok(summary(spec, { name: "x".repeat(100), level: 1 }, 30).endsWith("…"));
  assert.equal(summary({ kind: "any" }, [[1, [2]]]), "[[1, [1]]]");
});

test("dotted paths", () => {
  const v = { stats: { hp: 7 }, items: [{ name: "a" }, { name: "b" }] };
  assert.equal(getPath(v, "stats.hp"), 7);
  assert.equal(getPath(v, "items.1.name"), "b");
  assert.equal(getPath(v, "items.x"), undefined);
  assert.equal(getPath(v, "nope.deeper"), undefined);
  assert.equal(getPath(v, ""), v);
  assert.equal(getPath({ __proto__: null, a: 1 }, "constructor"), undefined);
  assert.equal(getPath({}, "constructor"), undefined, "inherited properties are not paths");
  const spec = parseType("Dictionary{stats: Dictionary{hp: int(0..10)}, alt: String | Dictionary{x: float}, list: Array[Dictionary{n: bool}]}").spec;
  assert.deepEqual(specAt(spec, "stats.hp"), { kind: "int", min: 0, max: 10 });
  assert.deepEqual(specAt(spec, "alt.x"), { kind: "float" });
  assert.deepEqual(specAt(spec, "list.0.n"), { kind: "bool" });
  assert.equal(specAt(spec, "stats.nope"), null);
  assert.deepEqual(leafPaths(spec).map((p) => p.path), ["stats.hp", "alt.x", "alt", "list"]);
});
