import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TERMS, MAX_TERM_TEXT, MAX_TERM_DEF, cleanTerms, cleanCategories, cleanIcon, canBranch, resolveTerm, treeOrder, groupTerms,
  filterTerms, countTermUsers, deleteTerm, renameCategory, newTerm, termsOf, termText
} from "../../source/app/js/terms.js";
import { buildToken, parseInline } from "../../source/app/js/blocks/inline.js";

const T = (id, text, extra = {}) => ({ id, text, ...extra });

test("cleanTerms: validates, trims, limits", () => {
  const out = cleanTerms([
    T("a", "  Branch  ", { definition: "x".repeat(900), hue: 90, icon: "icon:star", category: "Shapes", subcategory: "Lines" }),
    T("a", "dup"), T("b!", "badid"), T("c", "   "), null, 7, T("d", "y".repeat(200), { hue: 45, icon: "javascript" }),
    T("e", "No cat", { subcategory: "orphan" })
  ]);
  assert.deepEqual(out.map((t) => t.id), ["a", "d", "e"]);
  assert.equal(out[0].text, "Branch");
  assert.equal(out[0].definition.length, MAX_TERM_DEF);
  assert.equal(out[1].text.length, MAX_TERM_TEXT);
  assert.equal(out[1].hue, undefined);
  assert.equal(out[1].icon, undefined);
  assert.equal(out[2].subcategory, undefined);
  assert.equal(cleanTerms("nope").length, 0);
});
test("cleanTerms: caps the count", () => {
  const many = Array.from({ length: MAX_TERMS + 50 }, (_, i) => T(`t${i}`, `T${i}`));
  assert.equal(cleanTerms(many).length, MAX_TERMS);
});
test("icons: lucide references and emoji only", () => {
  assert.equal(cleanIcon("icon:star"), "icon:star");
  assert.equal(cleanIcon("\u{1F525}"), "\u{1F525}");
  for (const bad of ["", "star", "<b>", "icon:", "icon:Bad Name", "a".repeat(40), 5, null]) assert.equal(cleanIcon(bad), null);
});
test("branches: one level, valid parent", () => {
  const out = cleanTerms([T("a", "A"), T("b", "B", { parentId: "a" }), T("c", "C", { parentId: "b" }), T("d", "D", { parentId: "zzz" }), T("e", "E", { parentId: "e" })]);
  const by = Object.fromEntries(out.map((t) => [t.id, t]));
  assert.equal(by.b.parentId, "a");
  assert.equal(by.c.parentId, undefined);
  assert.equal(by.d.parentId, undefined);
  assert.equal(by.e.parentId, undefined);
  // a loop settles to a valid tree
  const loop = cleanTerms([T("x", "X", { parentId: "y" }), T("y", "Y", { parentId: "x" })]);
  assert.equal(loop.filter((t) => t.parentId).length, 1);
});
test("canBranch rules", () => {
  const list = [T("a", "A"), T("b", "B", { parentId: "a" }), T("c", "C")];
  assert.equal(canBranch(list, "c", "a"), true);
  assert.equal(canBranch(list, "c", "b"), false); // parent is a branch
  assert.equal(canBranch(list, "a", "c"), false); // a has branches
  assert.equal(canBranch(list, "a", "a"), false);
  assert.equal(canBranch(list, "c", "nope"), false);
});
test("inheritance: own > parent > category default", () => {
  const cats = cleanCategories([{ name: "Shapes", hue: 210, icon: "icon:circle" }, { name: "empty" }, { name: "shapes", hue: 0 }]);
  assert.equal(cats.length, 1);
  const terms = cleanTerms([
    T("p", "Branch", { category: "Shapes", subcategory: "Lines", hue: 60 }),
    T("l", "Long Branch", { parentId: "p", icon: "icon:ruler" }),
    T("s", "Short Branch", { parentId: "p", hue: 150, category: "Other" }),
    T("n", "Plain", { category: "Shapes" }),
    T("z", "Zero", {})
  ]);
  const l = resolveTerm(terms, cats, "l");
  assert.deepEqual([l.hue, l.icon, l.category, l.subcategory], [60, "icon:ruler", "Shapes", "Lines"]);
  assert.equal(l.parent.text, "Branch");
  const s = resolveTerm(terms, cats, "s");
  assert.deepEqual([s.hue, s.icon, s.category, s.subcategory], [150, null, "Other", ""]); // own category, no default for it
  const n = resolveTerm(terms, cats, "n");
  assert.deepEqual([n.hue, n.icon], [210, "icon:circle"]);
  const z = resolveTerm(terms, cats, "z");
  assert.deepEqual([z.hue, z.icon, z.category, z.parent], [null, null, "", null]);
  assert.equal(resolveTerm(terms, cats, "missing"), null);
  // hue 0 is a real colour, not "none"
  assert.equal(resolveTerm(cleanTerms([T("r", "Rose", { hue: 0 })]), [], "r").hue, 0);
});
test("treeOrder and groupTerms", () => {
  const terms = cleanTerms([
    T("p", "Branch", { category: "Shapes" }), T("l", "Long Branch", { parentId: "p" }), T("s", "Short Branch", { parentId: "p" }),
    T("a", "Alpha", { category: "Shapes", subcategory: "Dots" }), T("u", "Unfiled"), T("b", "Beta", { category: "Animals" })
  ]);
  assert.deepEqual(treeOrder(terms).map((x) => `${x.depth}${x.term.text}`), ["0Alpha", "0Beta", "0Branch", "1Long Branch", "1Short Branch", "0Unfiled"]);
  const g = groupTerms(terms);
  assert.deepEqual(g.map((c) => c.category), ["Animals", "Shapes", ""]);
  const shapes = g[1];
  assert.deepEqual(shapes.subs.map((s) => s.sub), ["", "Dots"]);
  assert.deepEqual(shapes.subs[0].items.map((x) => x.term.text), ["Branch", "Long Branch", "Short Branch"]);
  assert.equal(groupTerms([]).length, 0);
});
test("filterTerms keeps the parent of a matching branch", () => {
  const terms = cleanTerms([T("p", "Branch"), T("l", "Long Branch", { parentId: "p", definition: "reaches far" }), T("x", "Other", { category: "Zed" })]);
  assert.deepEqual([...filterTerms(terms, "far")].sort(), ["l", "p"]);
  assert.deepEqual([...filterTerms(terms, "zed")], ["x"]);
  assert.equal(filterTerms(terms, "").size, 3);
  assert.equal(filterTerms(terms, "nothing").size, 0);
});
test("usage counting reads tokens from block text, children included", () => {
  const terms = cleanTerms([T("p", "Branch"), T("l", "Long", { parentId: "p" })]);
  const lists = [[
    { id: "1", type: "p", text: `a ${buildToken("term", ["p"])} b ${buildToken("term", ["p"])} ${buildToken("term", ["l"])}`, children: [{ id: "2", type: "p", text: buildToken("term", ["l"]) }] },
    { id: "3", type: "p", text: "no tokens {{const:p}}" }
  ]];
  assert.equal(countTermUsers(lists, terms, "p"), 2);
  assert.equal(countTermUsers(lists, terms, "p", true), 4);
  assert.equal(countTermUsers(lists, terms, "l"), 2);
  assert.equal(countTermUsers([], terms, "p"), 0);
});
test("deleteTerm: delete or keep branches", () => {
  const cats = [{ name: "Shapes", hue: 210 }];
  const terms = cleanTerms([T("p", "Branch", { category: "Shapes", icon: "icon:star" }), T("l", "Long", { parentId: "p" }), T("o", "Other")]);
  const del = deleteTerm(terms, "p", "delete", cats);
  assert.deepEqual(del.terms.map((t) => t.id), ["o"]);
  assert.deepEqual(del.removed.sort(), ["l", "p"]);
  const keep = deleteTerm(terms, "p", "keep", cats);
  assert.deepEqual(keep.terms.map((t) => t.id), ["l", "o"]);
  const l = keep.terms[0];
  assert.equal(l.parentId, undefined);
  assert.deepEqual([l.category, l.icon, l.hue], ["Shapes", "icon:star", 210]); // looks the same afterwards
  assert.deepEqual(deleteTerm(terms, "l").terms.map((t) => t.id), ["p", "o"]);
  assert.deepEqual(deleteTerm(terms, "nope").terms.length, 3);
});
test("renameCategory", () => {
  const terms = cleanTerms([T("a", "A", { category: "Old", subcategory: "S" }), T("b", "B", { category: "old" }), T("c", "C", { category: "Keep" })]);
  const r = renameCategory(terms, [{ name: "Old", hue: 30 }], "Old", "New");
  assert.deepEqual(r.terms.map((t) => t.category), ["New", "New", "Keep"]);
  assert.equal(r.terms[0].subcategory, "S");
  assert.equal(r.categories[0].name, "New");
  const gone = renameCategory(terms, [{ name: "Old", hue: 30 }], "Old", "");
  assert.equal(gone.terms[0].category, undefined);
  assert.equal(gone.terms[0].subcategory, undefined);
  assert.equal(gone.categories.length, 0);
});
test("token and helpers", () => {
  const t = newTerm("  Hello ", { definition: "d" });
  assert.equal(t.text, "Hello");
  assert.equal(newTerm("  "), null);
  assert.equal(newTerm("Kid", { parentId: "p" }).parentId, "p");
  assert.equal(cleanTerms([T("p", "P"), newTerm("Kid", { parentId: "p" })])[1].parentId, "p");
  const tok = buildToken("term", [t.id]);
  assert.equal(parseInline(tok)[0].kind, "term");
  assert.equal(termText({ terms: [t] }, t.id), "Hello");
  assert.equal(termText({}, "x"), null);
  assert.deepEqual(termsOf(null), []);
});
test("fuzz: cleanTerms always yields a valid one-level tree", () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let round = 0; round < 300; round++) {
    const n = Math.floor(rnd() * 15);
    const ids = Array.from({ length: n }, (_, i) => `t${i}`);
    const raw = ids.map((id) => ({
      id: rnd() < 0.05 ? "bad id" : id, text: rnd() < 0.1 ? "" : `T ${id}`,
      parentId: rnd() < 0.6 ? ids[Math.floor(rnd() * (n + 1))] : undefined,
      category: rnd() < 0.5 ? "C" : undefined, hue: rnd() < 0.3 ? Math.floor(rnd() * 14) * 30 : undefined
    }));
    const out = cleanTerms(raw);
    const by = new Map(out.map((t) => [t.id, t]));
    for (const t of out) {
      if (t.parentId === undefined) continue;
      const p = by.get(t.parentId);
      assert.ok(p && p !== t && p.parentId === undefined, `round ${round}: ${t.id}`);
      assert.ok(t.hue === undefined || t.hue % 30 === 0 && t.hue < 360);
    }
    const flat = treeOrder(out);
    assert.equal(flat.length, out.length);
    for (let i = 0; i < flat.length; i++) if (flat[i].depth === 1) assert.ok(flat.slice(0, i).some((x) => x.term.id === flat[i].term.parentId));
    assert.deepEqual(cleanTerms(out), out); // idempotent
    const grouped = groupTerms(out).flatMap((c) => c.subs.flatMap((s) => s.items));
    assert.equal(grouped.length, out.length);
  }
});
