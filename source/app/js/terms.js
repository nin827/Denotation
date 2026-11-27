// Terms: named, coloured inline chips ({{term:<id>}}) stored on the repository page as repo.terms, plus per-category
// defaults in repo.termCategories. Pure logic only (no DOM): cleaning, branch (parent) rules, inheritance, ordering,
// grouping, filtering and usage counting. The UI lives in ui/plugins/terms.js and ui/repoSettings.js.
import { countTokenUsers } from "./constants.js";
import { isTokenId } from "./blocks/inline.js";
import { normColor } from "./blocks/model.js";
import { newId } from "./ids.js";

export const MAX_TERMS = 500;
export const MAX_CATEGORIES = 60;
export const MAX_TERM_TEXT = 80;
export const MAX_TERM_DEF = 500;
export const MAX_TERM_CAT = 40;

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const oneLine = (v, max) => (typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const multiLine = (v, max) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, max).trim() : "");
const norm = (s) => String(s ?? "").trim().toLowerCase();
const ICON_RE = /^icon:[a-z0-9-]{1,60}$/;

/** An icon value: a Lucide reference ("icon:name") or a short emoji / symbol string; anything else is dropped (null). */
export function cleanIcon(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  if (ICON_RE.test(s)) return s;
  // emoji: short, and no plain ASCII letters, digits or markup characters
  return s.length <= 16 && !/[A-Za-z0-9<>&"'`\\{}]/.test(s) && !/[\u0000-\u001F]/.test(s) ? s : null;
}
/** A hue from the 12 block colours, or null (none). */
export const cleanHue = (v) => v == null || v === "" ? null : normColor(v);

/** Validate a list of terms: drops invalid entries, duplicate ids and over-limit extras; fixes broken parent links. */
export function cleanTerms(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_TERMS) break;
    if (!isObj(raw) || !isTokenId(raw.id) || seen.has(raw.id)) continue;
    const text = oneLine(raw.text, MAX_TERM_TEXT);
    if (!text) continue;
    seen.add(raw.id);
    const t = { id: raw.id, text };
    const definition = multiLine(raw.definition, MAX_TERM_DEF);
    if (definition) t.definition = definition;
    const category = oneLine(raw.category, MAX_TERM_CAT);
    if (category) t.category = category;
    const subcategory = category ? oneLine(raw.subcategory, MAX_TERM_CAT) : "";
    if (subcategory) t.subcategory = subcategory;
    const hue = cleanHue(raw.hue);
    if (hue !== null) t.hue = hue;
    const icon = cleanIcon(raw.icon);
    if (icon) t.icon = icon;
    if (typeof raw.parentId === "string") t.parentId = raw.parentId;
    out.push(t);
  }
  // one level only: a parent must exist, not be the term itself and not itself be a branch (checked in list order,
  // so a loop or a longer chain settles to a valid tree)
  const byId = new Map(out.map((t) => [t.id, t]));
  for (const t of out) {
    if (t.parentId === undefined) continue;
    const p = byId.get(t.parentId);
    if (!p || p === t || p.parentId !== undefined) delete t.parentId;
  }
  return out;
}

/** Per-category defaults: [{ name, hue?, icon? }] (names compared case-insensitively). */
export function cleanCategories(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_CATEGORIES) break;
    if (!isObj(raw)) continue;
    const name = oneLine(raw.name, MAX_TERM_CAT);
    if (!name || seen.has(norm(name))) continue;
    const c = { name };
    const hue = cleanHue(raw.hue);
    if (hue !== null) c.hue = hue;
    const icon = cleanIcon(raw.icon);
    if (icon) c.icon = icon;
    if (c.hue === undefined && !c.icon) continue; // a category with no defaults needs no record
    seen.add(norm(name));
    out.push(c);
  }
  return out;
}

export const termsOf = (repo) => Array.isArray(repo?.terms) ? repo.terms : [];
export const termById = (repo, id) => termsOf(repo).find((t) => t.id === id) ?? null;
export const categoriesOf = (repo) => Array.isArray(repo?.termCategories) ? repo.termCategories : [];
export const categoryDefaults = (repo, name) => categoriesOf(repo).find((c) => norm(c.name) === norm(name)) ?? null;
export const childrenOf = (terms, id) => (terms ?? []).filter((t) => t.parentId === id);

/** A fresh term (cleaned) or null when the text is empty. A `parentId` is kept as given: the caller checks it with canBranch. */
export function newTerm(text, extra = {}) {
  const { parentId, ...rest } = extra;
  const t = cleanTerms([{ id: newId(), text, ...rest }])[0] ?? null;
  if (t && typeof parentId === "string") t.parentId = parentId;
  return t;
}

/** Can `id` become a branch of `parentId`? (one level: the parent must be a base term and `id` must have no branches) */
export function canBranch(terms, id, parentId) {
  const t = terms.find((x) => x.id === id);
  const p = terms.find((x) => x.id === parentId);
  if (!t || !p || t === p) return false;
  if (p.parentId !== undefined) return false;
  return !terms.some((x) => x.parentId === id);
}

/**
 * Everything a chip or card shows for one term, with inheritance applied.
 * Order for hue and icon: the term's own, then its parent's own, then the category default of the effective category
 * (the term's own, else the parent's). Category and subcategory come from the term, else its parent.
 * Returns null when the id is unknown.
 */
export function resolveTerm(terms, categories, id) {
  const list = Array.isArray(terms) ? terms : [];
  const t = list.find((x) => x.id === id);
  if (!t) return null;
  const parent = t.parentId ? list.find((x) => x.id === t.parentId && x.parentId === undefined) ?? null : null;
  const category = t.category ?? parent?.category ?? "";
  const subcategory = t.category ? t.subcategory ?? "" : parent?.subcategory ?? "";
  const cat = category ? (categories ?? []).find((c) => norm(c.name) === norm(category)) : null;
  const hue = t.hue ?? parent?.hue ?? cat?.hue ?? null;
  const icon = t.icon ?? parent?.icon ?? cat?.icon ?? null;
  return {
    id: t.id, text: t.text, definition: t.definition ?? "", category, subcategory, hue, icon,
    parent: parent ? { id: parent.id, text: parent.text, definition: parent.definition ?? "" } : null
  };
}
export const resolveIn = (repo, id) => resolveTerm(termsOf(repo), categoriesOf(repo), id);

/** Plain text of a term chip for search / export; unknown ids give null. */
export const termText = (repo, id) => termById(repo, id)?.text ?? null;

const cmp = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
/**
 * Tree order: bases in alphabetical order, each followed by its branches (alphabetical), as [{ term, depth }].
 * A branch whose parent is missing is treated as a base. Pass `only` (a Set of ids) to keep just those.
 */
export function treeOrder(terms, only = null) {
  const list = (terms ?? []).filter((t) => !only || only.has(t.id));
  const ids = new Set(list.map((t) => t.id));
  const bases = list.filter((t) => !t.parentId || !ids.has(t.parentId)).sort((a, b) => cmp(a.text, b.text));
  const out = [];
  for (const b of bases) {
    out.push({ term: b, depth: 0 });
    for (const c of list.filter((t) => t.parentId === b.id).sort((x, y) => cmp(x.text, y.text))) out.push({ term: c, depth: 1 });
  }
  return out;
}

/**
 * Group for the management dialog: [{ category, subs: [{ sub, items: [{ term, depth }] }] }].
 * Category "" (uncategorised) goes last, subcategory "" first inside a category. A branch is grouped with its parent.
 */
export function groupTerms(terms, only = null) {
  const list = (terms ?? []).filter((t) => !only || only.has(t.id));
  const byId = new Map(list.map((t) => [t.id, t]));
  const where = (t) => {
    const p = t.parentId ? byId.get(t.parentId) : null;
    const category = t.category ?? p?.category ?? "";
    return [category, t.category ? t.subcategory ?? "" : p?.subcategory ?? ""];
  };
  // groups are keyed by the base term's place so a branch always sits under its parent
  const placeOf = (t) => where(t.parentId && byId.has(t.parentId) ? byId.get(t.parentId) : t);
  const cats = new Map();
  for (const t of list) {
    if (t.parentId && byId.has(t.parentId)) continue; // placed with its base
    const [c, s] = placeOf(t);
    if (!cats.has(c)) cats.set(c, new Map());
    const subs = cats.get(c);
    if (!subs.has(s)) subs.set(s, []);
    subs.get(s).push(t);
  }
  const catNames = [...cats.keys()].sort((a, b) => a === b ? 0 : a === "" ? 1 : b === "" ? -1 : cmp(a, b));
  return catNames.map((category) => {
    const subs = cats.get(category);
    const subNames = [...subs.keys()].sort((a, b) => a === b ? 0 : a === "" ? -1 : b === "" ? 1 : cmp(a, b));
    return {
      category,
      subs: subNames.map((sub) => ({ sub, items: treeOrder([...subs.get(sub), ...list.filter((t) => t.parentId && subs.get(sub).some((b) => b.id === t.parentId))]) }))
    };
  });
}

/** Does the term itself match a search (every word in its text, definition, category or subcategory)? */
export function termMatches(t, query) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  const hay = norm(`${t.text} ${t.definition ?? ""} ${t.category ?? ""} ${t.subcategory ?? ""}`);
  return words.every((w) => hay.includes(w));
}
/**
 * Ids to show for a search. A match on a branch also keeps its parent so the tree stays readable; use termMatches to
 * tell real hits from context.
 */
export function filterTerms(terms, query) {
  const list = terms ?? [];
  if (!norm(query)) return new Set(list.map((t) => t.id));
  const hit = new Set();
  for (const t of list) {
    if (!termMatches(t, query)) continue;
    hit.add(t.id);
    if (t.parentId) hit.add(t.parentId);
  }
  return hit;
}

/** Existing distinct categories (and the subcategories of one), for suggestions. */
export const categoryNames = (terms) => [...new Set((terms ?? []).map((t) => t.category).filter(Boolean))].sort(cmp);
export const subcategoryNames = (terms, category) => [...new Set((terms ?? []).filter((t) => norm(t.category) === norm(category)).map((t) => t.subcategory).filter(Boolean))].sort(cmp);

/** Number of {{term:<id>}} chips in the given block lists; `withBranches` adds chips of the term's branches. */
export function countTermUsers(blockLists, terms, id, withBranches = false) {
  let n = countTokenUsers(blockLists, "term", id);
  if (withBranches) for (const c of childrenOf(terms, id)) n += countTokenUsers(blockLists, "term", c.id);
  return n;
}

/**
 * Remove a term. A base term with branches needs `branches`: "delete" removes them too, "keep" turns them into plain
 * terms (they keep what they inherited, so they look the same). Returns { terms, removed: [ids] }.
 */
export function deleteTerm(terms, id, branches = "keep", categories = []) {
  const list = Array.isArray(terms) ? terms : [];
  const kids = childrenOf(list, id);
  const removed = new Set([id]);
  if (branches === "delete") for (const c of kids) removed.add(c.id);
  const next = [];
  for (const t of list) {
    if (removed.has(t.id)) continue;
    if (t.parentId === id) {
      const r = resolveTerm(list, categories, t.id);
      const { parentId: _gone, ...rest } = t;
      const plain = { ...rest };
      if (r?.category && plain.category === undefined) plain.category = r.category;
      if (r?.category && plain.subcategory === undefined && r.subcategory) plain.subcategory = r.subcategory;
      if (plain.hue === undefined && r?.hue != null) plain.hue = r.hue;
      if (plain.icon === undefined && r?.icon) plain.icon = r.icon;
      next.push(plain);
    } else next.push(t);
  }
  return { terms: next, removed: [...removed] };
}

/** Rename a category everywhere (terms and defaults); an empty `to` clears it. */
export function renameCategory(terms, categories, from, to) {
  const f = norm(from);
  const name = oneLine(to, MAX_TERM_CAT);
  const nt = (terms ?? []).map((t) => {
    if (norm(t.category) !== f) return t;
    const { category: _c, subcategory: _s, ...rest } = t;
    return name ? { ...rest, category: name, ...t.subcategory ? { subcategory: t.subcategory } : {} } : rest;
  });
  const nc = (categories ?? []).map((c) => norm(c.name) === f ? { ...c, name } : c).filter((c) => c.name);
  return { terms: cleanTerms(nt), categories: cleanCategories(nc) };
}
