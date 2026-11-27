// Graph model (pure, no DOM): a link index kept up to date on page save, and buildGraph() turning pages + links into
// the arrays the layout and renderer use. Imported by Node tests, so keep it free of browser globals.
//
// Page record (what the caller passes in `pages`):
//   { id, title, kind: "page" | "database" | "row" | "repo", repo?: id, db?: id (rows: their database),
//     tags?: string[], props?: { [name]: value }, icon?: string, graph?: { icon?, color?, size? } }
// Link: { from, to, hidden }   hidden = the link was written x[[…]] (no edge in the graph).
//
// Edge rules (per unordered pair a/b):
//   a→b normal and b→a normal  → one two-way edge (no arrow)
//   only one side normal        → one one-way edge from the normal side (an arrow); a hidden link back changes nothing
//   no normal link              → no edge (hidden links never draw)
// Several links a→b collapse to one; any normal one makes the pair normal.

import { matches } from "./style.js";

/**
 * Link index: from → (to → hidden). `update(from, links)` replaces one page's outgoing links, so saving a page
 * costs O(its links) and opening the graph never re-scans page content.
 * @param {Array<{from:string,to:string,hidden?:boolean}>} [links]
 */
export function createLinkIndex(links = []) {
  const out = new Map(); // from -> Map(to -> hidden)
  const inc = new Map(); // to -> Set(from)
  let version = 0;
  const unlinkAll = (from) => {
    const m = out.get(from);
    if (!m) return;
    for (const to of m.keys()) {
      const s = inc.get(to);
      if (s) { s.delete(from); if (!s.size) inc.delete(to); }
    }
    out.delete(from);
  };
  const collapse = (list) => {
    const m = new Map();
    for (const l of list || []) {
      const to = typeof l === "string" ? l : l?.to;
      if (to == null || to === "") continue;
      const hidden = typeof l === "object" && !!l.hidden;
      m.set(to, m.has(to) ? m.get(to) && hidden : hidden); // normal wins
    }
    return m;
  };
  const sameMap = (a, b) => {
    if (!a) return b.size === 0;
    if (a.size !== b.size) return false;
    for (const [k, v] of b) if (a.get(k) !== v) return false;
    return true;
  };
  const index = {
    /** Replaces the outgoing links of `from`; returns true when anything changed. */
    update(from, links) {
      const m = collapse(links);
      if (sameMap(out.get(from), m)) return false;
      unlinkAll(from);
      if (m.size) {
        out.set(from, m);
        for (const to of m.keys()) {
          let s = inc.get(to);
          if (!s) inc.set(to, (s = new Set()));
          s.add(from);
        }
      }
      version++;
      return true;
    },
    /** Drops a page's outgoing links (incoming links from other pages stay; they point at nothing until it's back). */
    remove(from) {
      if (!out.has(from)) return false;
      unlinkAll(from);
      version++;
      return true;
    },
    /** @returns {Map<string, boolean>} to → hidden */
    outgoing: (from) => out.get(from) || new Map(),
    /** @returns {string[]} pages linking to `to` */
    incoming: (to) => [...(inc.get(to) || [])],
    /** Iterates every { from, to, hidden }. */
    *links() { for (const [from, m] of out) for (const [to, hidden] of m) yield { from, to, hidden }; },
    get size() { let n = 0; for (const m of out.values()) n += m.size; return n; },
    get version() { return version; }
  };
  const byFrom = new Map();
  for (const l of links) {
    if (!byFrom.has(l.from)) byFrom.set(l.from, []);
    byFrom.get(l.from).push(l);
  }
  for (const [from, list] of byFrom) index.update(from, list);
  version = 0;
  return index;
}

/**
 * Normalises a filter. Defaults: whole workspace, no database rows, orphans shown, no search, no focus.
 * @typedef {object} GraphFilter
 * @property {string|string[]|null} [repo]   only pages in this repository (or any of these)
 * @property {string[]} [includeDbs]          also show every row of these databases
 * @property {boolean} [orphans]              show nodes with no edges (default true)
 * @property {string} [search]                keep only nodes whose title contains this (case-insensitive)
 * @property {string[]} [kinds]               only these kinds (default: all but "repo")
 * @property {object|object[]} [where]        style-rule condition(s) every node must match (tags/properties)
 * @property {string|null} [focus]            local graph: centre node …
 * @property {number} [depth]                 … and how many steps out (1–3; default 1)
 */
export function normalizeFilter(f = {}) {
  const repo = f.repo == null || f.repo === "" ? null : Array.isArray(f.repo) ? (f.repo.length ? f.repo.map(String) : null) : [String(f.repo)];
  const depth = Math.max(0, Math.min(10, Math.floor(Number(f.depth ?? 1)) || 0));
  return {
    repo,
    includeDbs: Array.isArray(f.includeDbs) ? f.includeDbs.map(String) : [],
    orphans: f.orphans !== false,
    search: String(f.search ?? "").trim().toLowerCase(),
    kinds: Array.isArray(f.kinds) && f.kinds.length ? f.kinds.map(String) : null,
    where: f.where ? (Array.isArray(f.where) ? f.where : [f.where]) : [],
    focus: f.focus == null || f.focus === "" ? null : String(f.focus),
    depth
  };
}

/**
 * Builds the visible graph.
 * @param {{ pages: object[], links?: Array<{from,to,hidden}>, linkIndex?: ReturnType<typeof createLinkIndex> }} data
 * @param {GraphFilter} [filter]
 * @returns {{
 *   nodes: object[],              // visible page records, index = node number
 *   index: Map<string, number>,   // id -> node number
 *   source: Uint32Array, target: Uint32Array, // edge endpoints (node numbers); for a one-way edge source → target
 *   twoWay: Uint8Array,           // 1 = mutual link (no arrow)
 *   edgeCount: number,
 *   degree: Uint32Array,          // visible edges per node
 *   adjOffset: Uint32Array, adj: Uint32Array // CSR neighbour lists: neighbours of i = adj[adjOffset[i] .. adjOffset[i+1])
 *   focus: number                 // node number of the focus node, or -1
 * }}
 */
export function buildGraph(data, filter) {
  const f = normalizeFilter(filter);
  const pages = data?.pages || [];
  const byId = new Map();
  for (const p of pages) if (p && p.id != null) byId.set(String(p.id), p);

  // 1. candidate set: kind, repository and condition filters (rows handled below)
  const kindOk = (p) => (f.kinds ? f.kinds.includes(p.kind || "page") : (p.kind || "page") !== "repo");
  const repoOk = (p) => !f.repo || f.repo.includes(String(p.repo ?? ""));
  const whereOk = (p) => !f.where.length || f.where.every((w) => matches(p, w, { degree: 0 }));
  const cand = new Set(); // non-row pages
  const rowCand = new Set(); // rows that pass the filters but still need a database include or a normal page link
  for (const [id, p] of byId) {
    if (!kindOk(p) || !repoOk(p) || !whereOk(p)) continue;
    if (p.kind === "row") {
      if (f.includeDbs.includes(String(p.db ?? ""))) cand.add(id);
      else rowCand.add(id);
    } else cand.add(id);
  }

  // 2. collapse links into pair states: key -> bits (1 = lo→hi normal, 2 = hi→lo normal)
  const pairs = new Map();
  const visit = (from, to, hidden) => {
    if (hidden || from === to) return;
    from = String(from); to = String(to);
    if (!byId.has(from) || !byId.has(to)) return;
    const lo = from < to ? from : to, hi = from < to ? to : from;
    const key = lo + "\u0000" + hi;
    pairs.set(key, (pairs.get(key) || 0) | (from === lo ? 1 : 2));
  };
  if (data?.linkIndex) for (const l of data.linkIndex.links()) visit(l.from, l.to, l.hidden);
  else for (const l of data?.links || []) visit(l.from, l.to, !!l.hidden);

  // 3. rows linked to/from a candidate page by a normal link join the graph
  if (rowCand.size) {
    for (const key of pairs.keys()) {
      const k = key.indexOf("\u0000");
      const a = key.slice(0, k), b = key.slice(k + 1);
      if (rowCand.has(a) && cand.has(b) && byId.get(b).kind !== "row") cand.add(a);
      else if (rowCand.has(b) && cand.has(a) && byId.get(a).kind !== "row") cand.add(b);
    }
  }

  // 4. edges among candidates
  let ids = [...cand];
  let idx = new Map(ids.map((id, i) => [id, i]));
  let es = [], et = [], e2 = [];
  for (const [key, bits] of pairs) {
    const k = key.indexOf("\u0000");
    const a = idx.get(key.slice(0, k)), b = idx.get(key.slice(k + 1));
    if (a === undefined || b === undefined) continue;
    if (bits === 3) { es.push(a); et.push(b); e2.push(1); }
    else if (bits === 1) { es.push(a); et.push(b); e2.push(0); }
    else { es.push(b); et.push(a); e2.push(0); }
  }

  // 5. local graph (BFS over undirected edges), search, orphans: each narrows the node set
  const keep = new Uint8Array(ids.length).fill(1);
  const focusIdx = f.focus != null && idx.has(f.focus) ? idx.get(f.focus) : -1;
  if (f.focus != null) {
    keep.fill(0);
    if (focusIdx >= 0) {
      const { off, adj } = csr(ids.length, es, et);
      const dist = new Int32Array(ids.length).fill(-1);
      const queue = [focusIdx];
      dist[focusIdx] = 0;
      for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        keep[u] = 1;
        if (dist[u] >= f.depth) continue;
        for (let j = off[u]; j < off[u + 1]; j++) {
          const v = adj[j];
          if (dist[v] < 0) { dist[v] = dist[u] + 1; queue.push(v); }
        }
      }
    }
  }
  if (f.search) {
    for (let i = 0; i < ids.length; i++) {
      if (keep[i] && i !== focusIdx && !String(byId.get(ids[i]).title ?? "").toLowerCase().includes(f.search)) keep[i] = 0;
    }
  }
  if (!f.orphans) {
    const deg = new Uint32Array(ids.length);
    for (let e = 0; e < es.length; e++) if (keep[es[e]] && keep[et[e]]) { deg[es[e]]++; deg[et[e]]++; }
    for (let i = 0; i < ids.length; i++) if (keep[i] && !deg[i] && i !== focusIdx) keep[i] = 0;
  }

  // 6. compact
  const remap = new Int32Array(ids.length).fill(-1);
  const finalIds = [];
  for (let i = 0; i < ids.length; i++) if (keep[i]) { remap[i] = finalIds.length; finalIds.push(ids[i]); }
  const S = [], T = [], W = [];
  for (let e = 0; e < es.length; e++) {
    const a = remap[es[e]], b = remap[et[e]];
    if (a >= 0 && b >= 0) { S.push(a); T.push(b); W.push(e2[e]); }
  }
  const n = finalIds.length;
  const source = Uint32Array.from(S), target = Uint32Array.from(T), twoWay = Uint8Array.from(W);
  const { off: adjOffset, adj } = csr(n, source, target);
  const degree = new Uint32Array(n);
  for (let i = 0; i < n; i++) degree[i] = adjOffset[i + 1] - adjOffset[i];
  return {
    nodes: finalIds.map((id) => byId.get(id)),
    index: new Map(finalIds.map((id, i) => [id, i])),
    source, target, twoWay, edgeCount: S.length, degree, adjOffset, adj,
    focus: focusIdx >= 0 ? remap[focusIdx] : -1
  };
}

/** Undirected CSR adjacency from edge lists. */
function csr(n, s, t) {
  const off = new Uint32Array(n + 1);
  for (let e = 0; e < s.length; e++) { off[s[e] + 1]++; off[t[e] + 1]++; }
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  const fill = off.slice(0, n);
  const adj = new Uint32Array(off[n]);
  for (let e = 0; e < s.length; e++) { adj[fill[s[e]]++] = t[e]; adj[fill[t[e]]++] = s[e]; }
  return { off, adj };
}

/** Neighbour node numbers of `i` in a built graph. */
export const neighbours = (g, i) => Array.from(g.adj.subarray(g.adjOffset[i], g.adjOffset[i + 1]));
