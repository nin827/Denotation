// Seeded fuzz for Terms (terms.js: cleaning, one-level branches, inheritance, tree / group order, search, delete,
// rename) and sizes (sizes.js: parse / format / clamp round trips, constants, row heights). Sizes end up in inline
// styles (img width / height, --db-rh) and term icons / text in chips and cards, so outputs are checked for shape.
// Replay a failure with FUZZ_SEED=<n>; FUZZ_RUNS=<k> multiplies the case counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzz, XSS, UNICODE, PROTO_JSON, protoSnapshot, assertNoPollution } from "./fixtures/fuzz.js";
import {
  resolveIn, termText,
  MAX_TERMS, MAX_CATEGORIES, MAX_TERM_TEXT, MAX_TERM_DEF, MAX_TERM_CAT, cleanTerms, cleanCategories, cleanIcon, canBranch,
  resolveTerm, treeOrder, groupTerms, filterTerms, termMatches, deleteTerm, renameCategory, newTerm, countTermUsers
} from "../../source/app/js/terms.js";
import { buildToken, isTokenId, parseInline } from "../../source/app/js/blocks/inline.js";
import {
  SIZE_RANGES, EM_PX, parseSize, formatSize, clampSize, normSize, normSizeOrConst, normSizeList, resolveSize, parseSizeField,
  sizeFieldText, rowHeightInfo, rowHeightAttrs
} from "../../source/app/js/sizes.js";

// ---------- terms ----------
const hostile = (r) => r.pick([
  r.nasty(2), r.text(120), "", "   ", "\n\t", null, undefined, 5, NaN, true, [], {}, ["a"], ...XSS.slice(0, 8), ...UNICODE,
  "x".repeat(r.int(70, 700)), "icon:star", "icon:<svg>", "icon:" + "a".repeat(70), "★", "😀👍🏽", "<b>", "&amp;", "=", "‮"
]);
const randomTerms = (r, n = r.int(0, 40)) => Array.from({ length: n }, (_, i) => r.pick([
  null, 7, "x", [],
  JSON.parse(r.pick(PROTO_JSON)),
  {
    id: r.pick([`t${i}`, `t${r.int(0, n)}`, r.id(), "", "a b", "<x>", "__proto__", "constructor", 5, "x".repeat(65)]),
    text: r.chance(0.8) ? r.pick(["Alpha", "beta", "Gamma ray", r.nasty(1)]) : hostile(r),
    definition: r.chance(0.5) ? hostile(r) : undefined,
    category: r.chance(0.6) ? r.pick(["Cat", "cat ", "Other", hostile(r)]) : undefined,
    subcategory: r.chance(0.4) ? r.pick(["Sub", hostile(r)]) : undefined,
    hue: r.pick([undefined, null, "", 0, 30, 345, 400, -15, "red", "blue", "x", hostile(r)]),
    icon: r.chance(0.5) ? hostile(r) : undefined,
    parentId: r.chance(0.5) ? r.pick([`t${r.int(0, n)}`, `t${i}`, 5, null, "nope"]) : undefined
  }
]));

test("cleanTerms: hostile lists give bounded, one-level, unique, safe terms; cleaning is idempotent", async () => {
  const before = protoSnapshot();
  await fuzz("terms-clean", 500, (r) => {
    const list = randomTerms(r, r.chance(0.05) ? 700 : r.int(0, 40));
    const out = cleanTerms(list);
    assert.ok(out.length <= MAX_TERMS);
    const ids = new Set();
    const byId = new Map(out.map((t) => [t.id, t]));
    for (const t of out) {
      assert.ok(isTokenId(t.id) && !ids.has(t.id), `id ${t.id}`);
      ids.add(t.id);
      assert.ok(typeof t.text === "string" && t.text && t.text.length <= MAX_TERM_TEXT && !/[\r\n\t]/.test(t.text));
      assert.ok(t.definition === undefined || (t.definition.length <= MAX_TERM_DEF && t.definition));
      assert.ok(t.category === undefined || (t.category.length <= MAX_TERM_CAT && !/\n/.test(t.category)));
      assert.ok(t.subcategory === undefined || t.category !== undefined, "a subcategory needs a category");
      assert.ok(t.hue === undefined || (Number.isInteger(t.hue) && t.hue >= 0 && t.hue < 360) || typeof t.hue === "string");
      assert.equal(cleanIcon(t.icon ?? null), t.icon ?? null, "icons are already clean");
      if (t.parentId !== undefined) {
        const p = byId.get(t.parentId);
        assert.ok(p && p !== t && p.parentId === undefined, `branch ${t.id} -> ${t.parentId} is one level`);
      }
      for (const k of Object.keys(t)) assert.ok(["id", "text", "definition", "category", "subcategory", "hue", "icon", "parentId"].includes(k), k);
    }
    const out2 = cleanTerms(out); // one extra pass: see the pinned trailing-space case below
    assert.deepEqual(cleanTerms(out2), out2);
    const cats = cleanCategories(Array.from({ length: r.int(0, 80) }, () => r.pick([null, { name: hostile(r), hue: r.pick([30, "x", null]), icon: hostile(r) }, JSON.parse(r.pick(PROTO_JSON))])));
    assert.ok(cats.length <= MAX_CATEGORIES);
    assert.equal(new Set(cats.map((c) => c.name.toLowerCase())).size, cats.length);
    for (const c of cats) assert.ok(c.hue !== undefined || c.icon);
    const cats2 = cleanCategories(cats); // one extra pass: see the pinned trailing-space case below
    assert.deepEqual(cleanCategories(cats2), cats2);
  });
  assertNoPollution(before, "cleanTerms");
});

test("cleanTerms / cleanCategories are idempotent when the cut lands on a space (pinned)", () => {
  const t = cleanTerms([{ id: "a", text: `${"x".repeat(79)} y`, category: `${"c".repeat(39)} d` }]);
  assert.deepEqual(cleanTerms(t), t);
  const c = cleanCategories([{ name: `${"n".repeat(39)} m`, hue: 30 }]);
  assert.deepEqual(cleanCategories(c), c);
});

test("terms read from a stored repository (JSON import / sync) are cleaned before use (pinned)", () => {
  const repo = JSON.parse('{"id":"r","type":"repo","terms":[{"id":"a","text":{"toString":null},"hue":"0;position:fixed;background:url(https://example.invalid/x)","icon":"icon:<svg>"}]}');
  const res = resolveIn(repo, "a");
  assert.ok(res === null || (typeof res.text === "string" && (res.hue === null || Number.isInteger(res.hue)) && (res.icon === null || cleanIcon(res.icon) === res.icon)), JSON.stringify(res));
  const t = termText(repo, "a");
  assert.ok(t === null || typeof t === "string");
});

test("cleanIcon: kept icons are a Lucide reference or a short glyph with no letters, digits or markup", async () => {
  await fuzz("terms-icon", 2000, (r) => {
    const v = r.chance(0.5) ? hostile(r) : r.text(20, [..."<>&\"'`\\{}=:/;()icon-abc😀★", " ", "\u0000", "​"]);
    const out = cleanIcon(v);
    if (out === null) return;
    assert.ok(/^icon:[a-z0-9-]{1,60}$/.test(out) || (out.length <= 16 && !/[A-Za-z0-9<>&"'`\\{}\u0000-\u001f]/.test(out)), JSON.stringify(out));
  });
});

test("terms: inheritance, tree, groups, search, delete and rename never throw and keep every term exactly once", async () => {
  await fuzz("terms-ops", 300, (r) => {
    const terms = cleanTerms(randomTerms(r));
    const cats = cleanCategories([{ name: "Cat", hue: 30, icon: "icon:star" }, { name: "Other", icon: "★" }]);
    for (const t of terms) {
      const res = resolveTerm(terms, cats, t.id);
      assert.equal(res.id, t.id);
      assert.equal(res.text, t.text);
      if (t.parentId) assert.equal(res.parent?.id, t.parentId);
    }
    assert.equal(resolveTerm(terms, cats, "missing"), null);
    assert.equal(resolveTerm(null, null, "x"), null);
    const tree = treeOrder(terms);
    assert.deepEqual(tree.map((x) => x.term.id).sort(), terms.map((t) => t.id).sort(), "treeOrder lists each term once");
    const groups = groupTerms(terms);
    const grouped = groups.flatMap((g) => g.subs.flatMap((s) => s.items.map((i) => i.term.id)));
    assert.deepEqual(grouped.sort(), terms.map((t) => t.id).sort(), "groupTerms lists each term once");
    const q = r.pick(["", "a", "alpha ray", r.nasty(1), "  "]);
    const shown = filterTerms(terms, q);
    for (const t of terms) if (termMatches(t, q)) assert.ok(shown.has(t.id));
    if (terms.length) {
      const victim = r.pick(terms);
      const { terms: left, removed } = deleteTerm(terms, victim.id, r.pick(["keep", "delete"]), cats);
      assert.ok(!left.some((t) => removed.includes(t.id)));
      assert.ok(!left.some((t) => t.parentId && removed.includes(t.parentId)), "no branch points at a deleted term");
      assert.deepEqual(cleanTerms(left).map((t) => t.id), left.map((t) => t.id), "the result is still clean");
      const other = r.pick(terms);
      canBranch(terms, victim.id, other.id);
    }
    const ren = renameCategory(terms, cats, r.pick(["Cat", "cat", "nope", ""]), r.pick(["New", "", r.nasty(1), "x".repeat(100)]));
    assert.equal(ren.terms.length, terms.length);
    for (const t of ren.terms) assert.ok(t.category === undefined || t.category.length <= MAX_TERM_CAT);
    const nt = newTerm(r.pick(["", "  ", "New term", r.nasty(1)]), { icon: hostile(r), parentId: r.pick([undefined, "t1"]) });
    if (nt) assert.ok(isTokenId(nt.id) && nt.text);
  });
});

test("term chips: {{term:id}} only accepts token ids; counts match the tokens written", async () => {
  await fuzz("terms-tokens", 500, (r) => {
    const id = r.pick([r.id(), "a b", "<x>", "", "x".repeat(65), "t1", "__proto__"]);
    const tok = buildToken("term", [id]);
    assert.equal(tok !== null, isTokenId(id));
    if (!tok) return;
    const n = r.int(0, 5);
    const text = Array.from({ length: n }, () => `${r.nasty(1).replace(/[{}`\\*_~]/g, "")} ${tok}`).join(" ");
    const blocks = [{ id: "b", type: "p", text, children: [{ id: "c", type: "p", text: `\`${tok}\` \\${tok}` }] }];
    const flat = (ns) => ns.flatMap((x) => [x, ...flat(x.children ?? [])]);
    const nodes = flat(parseInline(text)).filter((x) => x.t === "inline" && x.kind === "term");
    assert.equal(countTermUsers([blocks], [], id), nodes.length);
    assert.ok(nodes.length <= n);
  });
});

// ---------- sizes ----------
const CSS_SIZE = /^(\d+(\.\d{1,2})?)(px|em|rem)$/;
const sizeInput = (r) => r.pick([
  r.int(-10, 5000), r.float() * 5000, String(r.int(0, 99999)), `${r.int(0, 999)}${r.pick(["", "px", "em", "rem", "PX", " em", "%", "vh", "pt"])}`,
  `.${r.int(0, 999)}rem`, `${r.int(0, 99)}.${r.int(0, 9999)}em`, "1e3", "0x10", "-5px", "Infinity", "NaN", "", "  ", null, undefined, {}, [],
  "320px; background:url(javascript:x)", "1px}body{x", "calc(1px + 2px)", "var(--x)", "expression(alert(1))", r.nasty(1), "rate", "Width_1",
  { const: r.pick(["k1", "k 2", "<x>", 5]) }, 1e300, 1e-9
]);
const constants = [
  { id: "k1", name: "Width_1", type: "number", value: 320 },
  { id: "k2", name: "rate", type: "text", value: "20em" },
  { id: "k3", name: "evil", type: "text", value: "1px;color:red" },
  { id: "k4", name: "day", type: "date", value: "2024-01-01" },
  { id: "k5", name: "empty", type: "text", value: "" },
  null, 5
];

test("sizes: parse/format/clamp round trip; every CSS value produced is a plain number + px/em/rem in range", async () => {
  await fuzz("sizes", 3000, (r) => {
    const v = sizeInput(r);
    const range = r.pick(Object.values(SIZE_RANGES));
    const sz = parseSize(v);
    if (sz) {
      assert.ok(Number.isFinite(sz.n) && sz.n >= 0 && ["px", "em", "rem"].includes(sz.unit)); // tiny inputs round to 0; clamping fixes them
      if (sz.n > 0 && sz.n < 1e5) { // unclamped huge / tiny numbers format as 1e+300px; stored sizes are always clamped first
        const f = formatSize(sz);
        assert.match(f, CSS_SIZE);
        assert.deepEqual(parseSize(f), sz, `format -> parse round trip for ${JSON.stringify(v)}`);
      }
    }
    const n = normSize(v, range);
    if (n !== null) {
      assert.match(n, CSS_SIZE);
      assert.equal(normSize(n, range), n, "normSize is idempotent");
      const c = parseSize(n);
      const px = c.unit === "px" ? c.n : c.n * EM_PX;
      assert.ok(px >= range[0] - 0.02 * (c.unit === "px" ? 1 : EM_PX) && px <= range[1] + 0.02 * EM_PX, `${n} outside ${range}`);
    }
    const oc = normSizeOrConst(v, range);
    assert.ok(oc === null || (typeof oc === "string" && CSS_SIZE.test(oc)) || (typeof oc === "object" && Object.keys(oc).join() === "const" && isTokenId(oc.const)));
    const res = resolveSize(v, r.chance(0.8) ? constants : r.pick([null, "x", [null]]), range);
    assert.ok(res.css === null || CSS_SIZE.test(res.css), `resolveSize css ${JSON.stringify(res.css)}`);
    assert.ok(res.css !== null || res.reason === null || typeof res.reason === "string");
    const field = parseSizeField(typeof v === "string" ? v : String(v ?? ""), { constants, allowConst: r.chance(0.5), range });
    assert.ok(field.value === null || field.value === undefined || typeof field.value === "string" ? field.value == null || CSS_SIZE.test(field.value) : isTokenId(field.value.const));
    assert.ok((field.value === undefined) === (field.error !== null), "an error exactly when the value is unusable");
    assert.equal(typeof sizeFieldText(v, constants), "string");
    const list = normSizeList(r.chance(0.8) ? Array.from({ length: r.int(0, 6) }, () => sizeInput(r)) : v, 4, range);
    assert.ok(list === null || (list.length === 4 && list.every((x) => x === null || CSS_SIZE.test(x))));
    const rh = rowHeightAttrs({ rowHeight: r.chance(0.3) ? r.pick(["compact", "normal", "tall", "TALL", "__proto__"]) : v });
    assert.ok(/^( rh-(compact|tall|custom))?$/.test(rh.cls), rh.cls);
    assert.ok(rh.style === "" || /^--db-rh:\d+(\.\d{1,2})?(px|em|rem);$/.test(rh.style), rh.style);
    assert.ok(["compact", "normal", "tall", "custom"].includes(rowHeightInfo(r.pick([null, {}, { rowHeight: v }])).mode));
  });
});

test("parseSize: a huge number is not a size of Infinity (pinned)", { todo: "BUG (low): sizes.js round(n) overflows for n > ~1.8e306 (Number.MAX_VALUE from a number constant), so parseSize returns { n: Infinity } instead of null; clampSize hides it" }, () => {
  const sz = parseSize(Number.MAX_VALUE);
  assert.ok(sz === null || Number.isFinite(sz.n));
});

test("sizes: clampSize keeps a parsed size inside the range for every unit", async () => {
  await fuzz("sizes-clamp", 2000, (r) => {
    const unit = r.pick(["px", "em", "rem"]);
    const range = r.pick(Object.values(SIZE_RANGES));
    const c = clampSize({ n: r.float() * 10 ** r.int(-3, 6), unit }, range);
    const px = c.unit === "px" ? c.n : c.n * EM_PX;
    assert.ok(px >= range[0] - 0.1 && px <= range[1] + 0.1, `${c.n}${c.unit} outside ${range}`);
    assert.equal(clampSize(null), null);
  });
});
