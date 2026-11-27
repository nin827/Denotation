// Workspace link tracker (pure, no DOM): one link index per workspace, fed per record on save and checked against the
// page list on load / refresh, so a save costs O(that record) and opening the graph or a backlinks list never re-scans
// page content. Also builds the graph's node records from pages and rows. Node imports this (tests), keep it pure.
//
//   const links = createWorkspaceLinks();
//   links.syncPages(pages);          // on load / refresh: re-extracts only records whose updatedAt changed
//   links.updatePage(page);          // on save (forced)
//   links.setRows(rows);             // once rows are loaded (lazy: the graph and backlinks ask for them)
//   links.updateRow(row); links.remove(id);
//   links.backlinks(id) -> [{ from, hidden }]
//   graphNodes(pages, rows) -> page records for graph/model.js buildGraph

import { extractLinks } from "../links.js";
import { createLinkIndex } from "./model.js";

const stampOf = (r) => `${r?.updatedAt ?? r?.createdAt ?? 0}`;
const linksOf = (rec) => extractLinks({ id: rec.id, blocks: rec.blocks }).map((l) => ({ to: l.to, hidden: l.hidden }));

export function createWorkspaceLinks() {
  const index = createLinkIndex();
  const stamps = new Map(); // id -> updatedAt stamp of the version indexed
  const pageIds = new Set();
  const rowIds = new Set();
  let rowsReady = false;
  const put = (rec, set) => {
    if (!rec || typeof rec.id !== "string") return false;
    set.add(rec.id);
    stamps.set(rec.id, stampOf(rec));
    return index.update(rec.id, linksOf(rec));
  };
  const drop = (id) => {
    stamps.delete(id);
    pageIds.delete(id);
    rowIds.delete(id);
    return index.remove(id);
  };
  const sync = (list, set) => {
    const seen = new Set();
    let changed = 0;
    for (const r of list || []) {
      if (!r || typeof r.id !== "string") continue;
      seen.add(r.id);
      if (stamps.get(r.id) === stampOf(r) && set.has(r.id)) continue;
      if (put(r, set)) changed++;
    }
    for (const id of [...set]) if (!seen.has(id)) changed += drop(id) ? 1 : 0;
    return changed;
  };
  return {
    index,
    /** Re-index one page (after a save). Returns true when its outgoing links changed. */
    updatePage: (p) => put(p, pageIds),
    updateRow: (r) => put(r, rowIds),
    remove: drop,
    /** The full page list: pages whose updatedAt changed are re-read, missing ones dropped. Returns the change count. */
    syncPages: (pages) => sync(pages, pageIds),
    /** The full row list (rows are loaded lazily; until then only pages are indexed). */
    setRows(rows) {
      const n = sync(rows, rowIds);
      rowsReady = true;
      return n;
    },
    /** Rows must be listed again (e.g. after a pull from a sync location). */
    invalidateRows() {
      rowsReady = false;
    },
    get rowsReady() {
      return rowsReady;
    },
    isRow: (id) => rowIds.has(id),
    /** Records linking to `id`: [{ from, hidden }] (hidden = only x-links). */
    backlinks(id) {
      return index.incoming(id).map((from) => ({ from, hidden: !!index.outgoing(from).get(id) }));
    },
    get version() {
      return index.version;
    }
  };
}

// ---------- graph node records ----------
const kindOf = (p) => (p.type === "database" ? "database" : p.type === "repo" ? "repo" : "page");
/** page.props ([{ name, type, value }]) -> { name: value } for style rules; a multi-select named Tags also fills tags. */
export function propValues(props) {
  const out = {};
  const set = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); // "__proto__" stays data
  let tags = null;
  for (const p of Array.isArray(props) ? props : []) {
    if (!p || typeof p.name !== "string") continue;
    set(out, p.name, p.value);
    if (!tags && /^tags?$/i.test(p.name) && Array.isArray(p.value)) tags = p.value.map(safeStr);
  }
  return { props: out, tags };
}
const rowText = (v) => (v == null ? "" : typeof v === "object" ? (Array.isArray(v) ? v.join(", ") : "") : String(v));

/**
 * Graph node records (graph/model.js format) for the live workspace: no sync pages, nothing trashed, archived or
 * inside a template. `rows` (optional) are database rows; their props are the row values by column name.
 * @returns {object[]} { id, title, kind, repo, db?, props, tags?, icon?, graph? }
 */
export function graphNodes(pages, rows = []) {
  const byId = new Map();
  for (const p of pages || []) if (p && typeof p.id === "string") byId.set(p.id, p);
  const state = new Map(); // id -> { hidden, repo }
  const info = (p) => {
    let s = state.get(p.id);
    if (s) return s;
    let hidden = false, repo = null;
    for (let q = p, n = 0; q && n < 100; q = byId.get(q.parentId), n++) {
      const known = state.get(q.id);
      if (known) { hidden = hidden || known.hidden; repo = repo ?? known.repo; break; }
      if (q.trashedAt || q.archivedAt || q.template || q.type === "sync") hidden = true;
      if (q.type === "repo") repo = q.id;
    }
    // every page on the walked chain shares the answer from its own position upwards: cache only the start (safe)
    s = { hidden, repo };
    state.set(p.id, s);
    return s;
  };
  const out = [];
  const dbs = new Map();
  for (const p of byId.values()) {
    const s = info(p);
    if (s.hidden) continue;
    const { props, tags } = propValues(p.props);
    const node = { id: p.id, title: p.title || "Untitled", kind: kindOf(p), repo: s.repo, props };
    if (tags) node.tags = tags;
    if (p.icon) node.icon = p.icon;
    if (p.graph && typeof p.graph === "object") node.graph = p.graph;
    if (p.type === "database") dbs.set(p.id, { page: p, repo: s.repo });
    out.push(node);
  }
  for (const r of rows || []) {
    if (!r || typeof r.id !== "string") continue;
    const db = dbs.get(r.dbId);
    if (!db) continue;
    const cols = db.page.columns || [];
    const props = {};
    for (const c of cols) if (c && typeof c.name === "string") props[c.name] = r.values?.[c.id];
    const title = rowText(r.values?.[cols[0]?.id]).trim() || "Untitled";
    const node = { id: r.id, title, kind: "row", repo: db.repo, db: r.dbId, props };
    if (r.icon) node.icon = r.icon;
    if (r.graph && typeof r.graph === "object") node.graph = r.graph;
    out.push(node);
  }
  return out;
}

/**
 * Style rules of the given repositories for one graph: each repository's `graphRules` apply to its own pages only
 * (a repo condition is added), in sidebar order. `repos` = repo page records.
 */
export function repoRules(repos) {
  const out = [];
  for (const r of repos || []) {
    for (const rule of Array.isArray(r?.graphRules) ? r.graphRules : []) {
      if (!rule || typeof rule !== "object") continue;
      const when = rule.when == null ? [] : Array.isArray(rule.when) ? rule.when : [rule.when];
      out.push({ ...rule, when: [...when, { field: "repo", op: "is", value: r.id }] });
    }
  }
  return out;
}

// ---------- rule cleaning (repo.graphRules) ----------
export const RULE_OPS = ["is", "isNot", "contains", "notContains", "empty", "notEmpty", "gt", "lt"];
export const RULE_FIELDS = ["type", "title", "links", "tag"];
export const RULES_MAX = 40;
const safeStr = (v) => {
  try {
    return String(v ?? "");
  } catch {
    return "";
  }
};
const str = (v, max) => safeStr(v).trim().slice(0, max);
const num = (v) => (typeof v === "number" || typeof v === "string" ? Number(v) : NaN);
/** One condition, cleaned, or null. */
function cleanWhen(c) {
  if (!c || typeof c !== "object") return null;
  const op = RULE_OPS.includes(c.op) ? c.op : "is";
  const value = op === "empty" || op === "notEmpty" ? "" : str(c.value, 200);
  if (c.prop != null) {
    const prop = str(c.prop, 80);
    return prop ? { prop, op, value } : null;
  }
  return RULE_FIELDS.includes(c.field) ? { field: c.field, op, value } : null;
}
/** Rules as stored on a repository page: [{ when: [condition], icon?, color?, size? }]; at least one style set. */
export function cleanGraphRules(list) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r !== "object") continue;
    const when = (Array.isArray(r.when) ? r.when : [r.when]).map(cleanWhen).filter(Boolean).slice(0, 4);
    if (!when.length) continue;
    const rule = { when };
    const icon = str(r.icon, 64);
    if (icon) rule.icon = icon;
    if (typeof r.color === "number" && isFinite(r.color)) rule.color = r.color;
    else if (str(r.color, 16)) rule.color = str(r.color, 16);
    const size = num(r.size);
    if (isFinite(size) && size > 0) rule.size = Math.max(0.25, Math.min(6, size));
    if (rule.icon || rule.color != null || rule.size) out.push(rule);
    if (out.length >= RULES_MAX) break;
  }
  return out;
}
/** page.graph cleaned: { icon?, color?, size? } or null (nothing set). */
export function cleanAppearance(g) {
  if (!g || typeof g !== "object") return null;
  const out = {};
  const icon = str(g.icon, 64);
  if (icon) out.icon = icon;
  if (typeof g.color === "number" && isFinite(g.color)) out.color = g.color;
  else if (str(g.color, 16)) out.color = str(g.color, 16);
  const size = num(g.size);
  if (isFinite(size) && size > 0 && size !== 1) out.size = Math.max(0.25, Math.min(6, size));
  return Object.keys(out).length ? out : null;
}

// ---------- positions cache (bounded) ----------
/**
 * Trims a positions store { [graphKey]: { t, p: { id: [x, y] } } } to at most `maxKeys` graphs (least recently used
 * dropped) and `maxEntries` positions in total (newest graphs keep theirs first). Coordinates are rounded to integers.
 */
export function trimPositions(store, { maxKeys = 6, maxEntries = 3000 } = {}) {
  const keys = Object.keys(store || {}).filter((k) => store[k] && typeof store[k] === "object").sort((a, b) => (store[b].t || 0) - (store[a].t || 0)).slice(0, maxKeys);
  const out = {};
  const set = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  let left = maxEntries;
  for (const k of keys) {
    if (left <= 0) break;
    const p = {};
    for (const [id, xy] of Object.entries(store[k].p || {})) {
      if (left <= 0) break;
      if (!Array.isArray(xy) || !isFinite(xy[0]) || !isFinite(xy[1])) continue;
      set(p, id, [Math.round(xy[0]), Math.round(xy[1])]);
      left--;
    }
    set(out, k, { t: store[k].t || 0, p });
  }
  return out;
}
