// Shared helpers for the seeded fuzz tests (work/test/fuzz-*.test.js, work/test/e2e/fuzz-*.cjs).
//
// Every run is reproducible: a test draws from rng(seed) only. Environment:
//   FUZZ_SEED=<n>    base seed (default 20261127); each test derives its own stream from it and its name
//   FUZZ_RUNS=<n>    multiplier for the number of cases (default 1; e.g. FUZZ_RUNS=20 for a long run)
//   FUZZ_HEAVY=1     enable the slow size steps of the performance guards
// A failing case throws with "[fuzz seed=… case=…]" in its message, so `FUZZ_SEED=… node --test <file>` replays it.

export const BASE_SEED = Number(process.env.FUZZ_SEED ?? 20261127) >>> 0;
export const RUNS = Math.max(1, Number(process.env.FUZZ_RUNS ?? 1) || 1);
export const HEAVY = process.env.FUZZ_HEAVY === "1" || process.env.FUZZ_HEAVY === "true";

/** mulberry32: tiny, fast, good enough for fuzzing. Returns a float in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** FNV-1a hash of a string (derives a per-test seed from the base seed and a name). */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}
export const seedFor = (name, base = BASE_SEED) => (hashStr(String(name)) ^ base) >>> 0;

/** A random source with helpers. */
export function rng(seed) {
  const next = mulberry32(seed);
  const r = {
    seed,
    next,
    float: () => next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), // inclusive
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle: (arr) => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    /** n random items of arr (with repeats). */
    some: (arr, n) => Array.from({ length: n }, () => r.pick(arr)),
    id: (len = r.int(4, 12)) => Array.from({ length: len }, () => r.pick(ID_CHARS)).join(""),
    /** Random text from an alphabet (default: printable ASCII plus a few specials). */
    text: (max = 40, alphabet = PRINTABLE) => Array.from({ length: r.int(0, max) }, () => r.pick(alphabet)).join(""),
    /** Mix of plain text, markup-ish fragments and adversarial payloads. */
    nasty: (max = 6) => Array.from({ length: r.int(1, max) }, () => {
      const k = r.int(0, 9);
      if (k < 3) return r.pick(XSS);
      if (k < 5) return r.pick(UNICODE);
      if (k < 7) return r.pick(MARKUP);
      return r.text(12);
    }).join(r.pick(["", " ", "\n", "|", "\t"]))
  };
  return r;
}

const ID_CHARS = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"];
export const PRINTABLE = [...' !"#$%&\'()*+,-./0123456789:;<=>?@ABCXYZ[\\]^_`abcxyz{|}~', "\n", "\t", "é", "☃"];

/** Script-injection payloads. Payloads that run set window.__fuzzXss (checked by the browser fuzz test). */
export const XSS = [
  "<script>window.__fuzzXss=1</script>",
  "<img src=x onerror=\"window.__fuzzXss=1\">",
  "<svg onload=window.__fuzzXss=1>",
  "<svg><script>window.__fuzzXss=1</script></svg>",
  "\"><img src=x onerror=window.__fuzzXss=1>",
  "'><svg/onload=window.__fuzzXss=1>",
  "<iframe srcdoc=\"<script>parent.__fuzzXss=1</script>\"></iframe>",
  "<a href=\"javascript:window.__fuzzXss=1\">x</a>",
  "javascript:window.__fuzzXss=1",
  "JaVaScRiPt:window.__fuzzXss=1",
  " javascript:window.__fuzzXss=1",
  "java\tscript:window.__fuzzXss=1",
  "java\nscript:window.__fuzzXss=1",
  "\u0001javascript:window.__fuzzXss=1",
  "\u0000javascript:window.__fuzzXss=1",
  "vbscript:msgbox(1)",
  "data:text/html,<script>parent.__fuzzXss=1</script>",
  "data:text/html;base64,PHNjcmlwdD5wYXJlbnQuX19mdXp6WHNzPTE8L3NjcmlwdD4=",
  "data:image/svg+xml,<svg onload=parent.__fuzzXss=1>",
  "<math><mi xlink:href=\"javascript:window.__fuzzXss=1\">x</mi></math>",
  "<details open ontoggle=window.__fuzzXss=1>",
  "<body onload=window.__fuzzXss=1>",
  "<style>@import 'javascript:window.__fuzzXss=1'</style>",
  "{{img:javascript:window.__fuzzXss=1|1|1|x}}",
  "[click](javascript:window.__fuzzXss=1)",
  "[click](JAVASCRIPT:window.__fuzzXss=1)",
  "[click](data:text/html,<script>parent.__fuzzXss=1</script>)",
  "![x](javascript:window.__fuzzXss=1)",
  "<!--",
  "]]>",
  "</textarea><script>window.__fuzzXss=1</script>",
  "`<script>window.__fuzzXss=1</script>`",
  "${window.__fuzzXss=1}",
  "\" onmouseover=\"window.__fuzzXss=1",
  "a".repeat(5000) + "<script>window.__fuzzXss=1</script>"
];
export const UNICODE = [
  "‮gnp.exe", // RTL override
  "​‌‍﻿", // zero-width
  "😀👍🏽",
  "\ud800", // lone surrogate
  "\udfff\ud800",
  "é́́́",
  "\u0000\u0001\u001f\u007f",
  "  ",
  "＜script＞", // full-width < >
  "〈script〉",
  "ＪａｖａＳｃｒｉｐｔ：",
  "İıſK",
  "a\u0000b"
];
export const MARKUP = [
  "**b**", "*i*", "_i_", "~~s~~", "`code`", "\\*", "\\", "{{", "}}", "{{date:2024-02-29}}", "{{check:1}}", "{{= 1+1}}",
  "{{value:db1|k\\|ey|c1}}", "{{link:abc}}", "{{embed:abc|b|x,y}}", "[[Title]]", "x[[Title]]", "![[Title]]", "![[T][H]]",
  "[a](https://example.com)", "[a](#page-abc)", "# ", "- ", "1. ", "> ", "```", "| a | b |", "|---|---|", "---",
  "[", "]", "(", ")", "[x](", "**", "__proto__", "constructor", "prototype", "toString"
];

/** Text that a string must never contain when rendered as an attribute or a URL. */
export const UNSAFE_PROTOCOLS = ["javascript:", "vbscript:", "data:text", "file:", "blob:"];

/**
 * The protocol a browser would use for `href` on a page at `base` (WHATWG URL parsing, which strips tabs/newlines
 * and leading C0 controls just like the HTML parser does). null when it can't be parsed.
 */
export function effectiveProtocol(href, base = "https://app.example/Denotation/") {
  try {
    return new URL(String(href), base).protocol;
  } catch {
    return null;
  }
}

/**
 * Run `cases` iterations of fn(r, i) with a per-test seed; failures report the seed and case index.
 * Returns the number of cases run. fn may be async.
 */
export async function fuzz(name, cases, fn, { seed = seedFor(name) } = {}) {
  const n = Math.max(1, Math.round(cases * RUNS));
  for (let i = 0; i < n; i++) {
    const caseSeed = (seed + Math.imul(i, 0x9e3779b1)) >>> 0;
    const r = rng(caseSeed);
    try {
      await fn(r, i);
    } catch (e) {
      const msg = `[fuzz ${name} seed=${seed} case=${i} caseSeed=${caseSeed} (FUZZ_SEED=${BASE_SEED})] ${e?.message ?? e}`;
      try {
        e.message = msg;
      } catch {
        throw new Error(msg, { cause: e });
      }
      throw e;
    }
  }
  return n;
}

/** Time fn (sync or async); returns { ms, value }. */
export async function timeIt(fn) {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}
/** Best of `reps` timings (less noise for the growth checks). */
export async function bestOf(reps, fn) {
  let best = Infinity;
  let value;
  for (let i = 0; i < reps; i++) {
    const t = await timeIt(fn);
    if (t.ms < best) best = t.ms;
    value = t.value;
  }
  return { ms: best, value };
}

/**
 * Measure fn(size) for each size (after one warm-up call); returns rows { size, ms } and the growth exponent from the
 * smallest to the largest size (time ratio vs size ratio: 1 = linear, 2 = quadratic). Timings are floored at floorMs
 * so timer noise on tiny inputs can't fake growth.
 */
export async function growth(sizes, fn, { reps = 3, floorMs = 5 } = {}) {
  await fn(sizes[0]);
  const rows = [];
  for (const size of sizes) rows.push({ size, ...(await bestOf(reps, () => fn(size))) });
  const a = rows[0];
  const b = rows[rows.length - 1];
  const exponent = Math.log(Math.max(b.ms, floorMs) / Math.max(a.ms, floorMs)) / Math.log(b.size / a.size);
  return { rows, exponent: Math.max(0, exponent) };
}

/** One printable line per measurement, collected for the timings table at the end of a file. */
export const timings = [];
export function record(label, ms, extra = "") {
  timings.push({ label, ms });
  console.log(`  [timing] ${label.padEnd(58)} ${ms.toFixed(1).padStart(9)} ms ${extra}`);
}

/** Snapshot of Object.prototype (and friends) to detect prototype pollution. */
export function protoSnapshot() {
  const names = (o) => Object.getOwnPropertyNames(o).sort().join(",");
  return { obj: names(Object.prototype), arr: names(Array.prototype), fn: names(Function.prototype), str: names(String.prototype) };
}
export function assertNoPollution(before, label = "") {
  const now = protoSnapshot();
  for (const k of Object.keys(before)) if (before[k] !== now[k]) throw new Error(`prototype polluted (${k}) ${label}`);
  const probe = {};
  for (const k of ["polluted", "isAdmin", "x", "__fuzz"]) if (probe[k] !== undefined) throw new Error(`Object.prototype.${k} is set ${label}`);
}
/** JSON texts that try prototype pollution through parse + merge / assign / spread. */
export const PROTO_JSON = [
  '{"__proto__":{"polluted":1,"isAdmin":true}}',
  '{"constructor":{"prototype":{"polluted":1}}}',
  '{"a":{"__proto__":{"polluted":1}}}',
  '{"__proto__":[1,2,3]}',
  '{"prototype":{"polluted":1}}',
  '{"toString":"x","valueOf":1,"hasOwnProperty":"y"}',
  '{"__proto__":null}'
];
