// Graph UI on top of the engine (js/graph/): the Graph page (#graph, #graph-<repoId>), the Local graph side panel,
// the `graph` block, "Graph appearance…" per page and the per-repository style rules editor.
// Data comes from the workspace link index (ws.links, kept current on save) plus page / row records; opening a graph
// never re-reads page content. Positions are cached per graph key (memory, plus a small bounded localStorage copy).
import { h } from "./dom.js";
import { ico, iconNode } from "../icons/index.js";
import { openModal } from "./modal.js";
import { toast } from "./dialogs.js";
import { pickEmoji } from "./emoji.js";
import { createGraphView } from "../graph/index.js";
import { graphNodes, repoRules, cleanGraphRules, cleanAppearance, trimPositions, RULE_OPS } from "../graph/workspaceLinks.js";
import { isHidden } from "../workspace.js";

// ---------- shared ----------
export const GRAPH_HUES = [["Red", "red"], ["Orange", "orange"], ["Yellow", "yellow"], ["Lime", "lime"], ["Green", "green"], ["Teal", "teal"], ["Cyan", "cyan"], ["Blue", "blue"], ["Indigo", "indigo"], ["Purple", "purple"], ["Magenta", "magenta"], ["Pink", "pink"]];
const HUE_OF = { red: 25, orange: 55, yellow: 90, lime: 125, green: 145, teal: 185, cyan: 210, blue: 250, indigo: 275, purple: 300, magenta: 325, pink: 345 };
const swatchCss = (c) => (c === "grey" ? "var(--muted)" : HUE_OF[c] != null ? `oklch(0.64 0.15 ${HUE_OF[c]})` : "transparent");
const SIZES = [["Default", ""], ["Small (0.5×)", "0.5"], ["Smaller (0.75×)", "0.75"], ["Larger (1.5×)", "1.5"], ["Large (2×)", "2"], ["Huge (3×)", "3"]];
const safe = (f) => {
  try {
    return f();
  } catch {
    return null;
  }
};

// UI choices (filters, mode, depth) remembered per browser: a viewer convenience only
const UI_KEY = "denotation-graph-ui";
const uiPrefs = () => safe(() => JSON.parse(localStorage.getItem(UI_KEY) || "{}")) || {};
const saveUi = (patch) => safe(() => localStorage.setItem(UI_KEY, JSON.stringify({ ...uiPrefs(), ...patch })));

// positions: every graph key in memory for this session; a bounded copy in localStorage (6 graphs, 3000 positions)
const POS_KEY = "denotation-graph-pos";
const memPos = new Map();
let diskPos = null;
const loadDisk = () => (diskPos ??= safe(() => JSON.parse(localStorage.getItem(POS_KEY) || "{}")) || {});
let diskTimer = 0;
function positionsCache(key) {
  return {
    load: () => memPos.get(key) ?? loadDisk()[key]?.p ?? null,
    save(p) {
      memPos.set(key, p);
      const all = loadDisk();
      all[key] = { t: Date.now(), p };
      diskPos = trimPositions(all, { maxKeys: 6, maxEntries: 3000 });
      clearTimeout(diskTimer);
      diskTimer = setTimeout(() => safe(() => localStorage.setItem(POS_KEY, JSON.stringify(diskPos))), 500);
    }
  };
}

/** Graph data for the live workspace: node records (pages + rows) and the link index. Rows are listed once per call. */
async function loadData(ws, pages) {
  let rows = [];
  try {
    rows = await ws.store.list("rows");
    ws.links.setRows(rows);
  } catch {
    /* rows are optional for the graph */
  }
  return { pages: graphNodes(pages, rows), linkIndex: ws.links.index };
}
const liveRepos = (pages) => pages.filter((p) => p.type === "repo" && !isHidden(pages, p));

// Views whose element left the page are destroyed on the next sweep (route change, new graph).
const views = new Set();
export function sweepGraphs() {
  for (const v of [...views]) if (!v.el.isConnected) v.destroy();
}

/**
 * Mounts a graph in `host`. src: { ws, pages(): page records (all), open(id, node) }.
 * opts: { key, filter(), local(), mode, onCount(text) }. Returns { view, refresh(), setFilter(), setLocal(), setMode(), destroy() }.
 */
function mountGraph(host, src, opts) {
  sweepGraphs();
  const ctl = { el: host, view: null, destroyed: false };
  let lastSig = "";
  const sigOf = (pages) => {
    let s = `${src.ws.links.version}|${pages.length}`;
    for (const p of pages) s += `|${p.id}:${p.updatedAt ?? 0}`;
    return s;
  };
  const rulesFor = (pages) => {
    const f = opts.filter();
    const repos = liveRepos(pages).filter((r) => !f.repo || r.id === f.repo);
    const fixed = f.repo && repos[0]?.graphSize === "fixed";
    return { rules: repoRules(repos), sizeMode: fixed ? "fixed" : "links" };
  };
  const count = () => {
    const g = ctl.view?.graph;
    if (g) opts.onCount?.(`${g.nodes.length} ${g.nodes.length === 1 ? "page" : "pages"}, ${g.edgeCount} ${g.edgeCount === 1 ? "link" : "links"}`);
  };
  const start = async () => {
    const pages = src.pages();
    const data = await loadData(src.ws, pages);
    if (ctl.destroyed) return;
    lastSig = sigOf(pages);
    const { rules, sizeMode } = rulesFor(pages);
    ctl.view = createGraphView(host, {
      data,
      filter: opts.filter(),
      local: opts.local?.() ?? null,
      styleRules: rules,
      sizeMode,
      mode: opts.mode || "canvas",
      positionsCache: positionsCache(opts.key),
      onOpen: (id, node) => src.open(id, node)
    });
    count();
  };
  const ready = start();
  // live updates: a save changes the link index; redraw at most about once a second, only when something changed
  let t = 0;
  const off = src.ws.onDataChange?.(() => {
    clearTimeout(t);
    t = setTimeout(async () => {
      if (ctl.destroyed || !ctl.view) return;
      if (!host.isConnected) return ctl.destroy();
      const pages = src.pages();
      if (sigOf(pages) === lastSig) return;
      lastSig = sigOf(pages);
      const data = await loadData(src.ws, pages);
      if (ctl.destroyed) return;
      const { rules, sizeMode } = rulesFor(pages);
      ctl.view.setStyleRules(rules, sizeMode);
      ctl.view.update(data);
      count();
    }, 900);
  });
  const after = (f) => ready.then(() => {
    if (!ctl.destroyed && ctl.view) f(ctl.view);
  });
  Object.assign(ctl, {
    ready,
    setFilter: (f) => after((v) => {
      const pages = src.pages();
      const { rules, sizeMode } = rulesFor(pages);
      v.setStyleRules(rules, sizeMode);
      v.setFilter(f);
      count();
    }),
    setLocal: (l) => after((v) => {
      v.setLocal(l);
      count();
    }),
    setMode: (m) => after((v) => v.setMode(m)),
    fit: () => after((v) => v.fit()),
    async refresh() {
      lastSig = "";
      const pages = src.pages();
      const data = await loadData(src.ws, pages);
      after((v) => {
        const { rules, sizeMode } = rulesFor(pages);
        v.setStyleRules(rules, sizeMode);
        v.update(data);
        count();
      });
    },
    destroy() {
      if (ctl.destroyed) return;
      ctl.destroyed = true;
      clearTimeout(t);
      off?.();
      views.delete(ctl);
      ctl.view?.destroy();
    }
  });
  views.add(ctl);
  return ctl;
}

/** Canvas / List toggle (two buttons with aria-pressed and a visible label). */
function modeToggle(mode, onChange) {
  const btn = (m, icon, label) => h("button", { type: "button", class: "graph-seg-btn", "data-mode": m, "aria-pressed": String(mode === m), onClick: () => {
    mode = m;
    for (const b of wrap.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === m));
    onChange(m);
  } }, ico(icon), h("span", {}, label));
  const wrap = h("div", { class: "graph-seg", role: "group", "aria-label": "Graph view" }, btn("canvas", "waypoints", "Graph"), btn("list", "list", "List"));
  return wrap;
}
const openNode = (env) => (id, node) => (node?.kind === "row" ? env.openRow(id) : env.open(id));

// ---------- the Graph page ----------
/** #graph (whole workspace) or #graph-<repoId>. */
export function renderGraphPage(main, env, { repoId = null } = {}) {
  closeLocalGraph();
  const all = env.pages();
  const repos = liveRepos(all);
  const prefs = uiPrefs();
  const state = {
    repo: repoId && repos.some((r) => r.id === repoId) ? repoId : null,
    search: "",
    orphans: prefs.orphans !== false,
    includeDbs: Array.isArray(prefs.includeDbs) ? prefs.includeDbs : [],
    mode: prefs.mode === "list" ? "list" : "canvas"
  };
  const filter = () => ({ repo: state.repo, search: state.search, orphans: state.orphans, includeDbs: state.includeDbs });
  const countEl = h("span", { class: "graph-count", role: "status", "aria-live": "polite" }, "Loading…");
  const stage = h("div", { class: "graph-stage" });
  const repoSel = h("select", { class: "graph-repo", "aria-label": "Repository", onChange: (e) => {
    state.repo = e.target.value || null;
    location.replace(state.repo ? `#graph-${state.repo}` : "#graph");
  } }, h("option", { value: "" }, "Whole workspace"), repos.map((r) => h("option", { value: r.id, selected: r.id === state.repo }, r.title || "Untitled")));
  repoSel.value = state.repo ?? "";
  let st = 0;
  const search = h("input", { type: "search", class: "graph-search", placeholder: "Filter by title…", "aria-label": "Filter pages by title", onInput: (e) => {
    clearTimeout(st);
    st = setTimeout(() => {
      state.search = e.target.value;
      g.setFilter(filter());
    }, 220);
  } });
  const orphans = h("label", { class: "graph-check" }, h("input", { type: "checkbox", checked: state.orphans, onChange: (e) => {
    state.orphans = e.target.checked;
    saveUi({ orphans: state.orphans });
    g.setFilter(filter());
  } }), h("span", {}, "Unlinked pages"));
  const dbs = all.filter((p) => p.type === "database" && !p.sourceId && !isHidden(all, p));
  const dbSummary = h("span", {});
  const setDbLabel = () => dbSummary.replaceChildren(ico("table-properties"), ` Rows${state.includeDbs.length ? ` (${state.includeDbs.length})` : ""}`);
  setDbLabel();
  const dbBox = h("details", { class: "graph-dbs" }, h("summary", { title: "Show every row of chosen databases (rows linked from or to pages always show)" }, dbSummary), h(
    "div",
    { class: "graph-dbs-list" },
    h("p", { class: "hint" }, "Rows linked to or from pages always show. Also show every row of:"),
    dbs.length ? dbs.map((d) => h("label", { class: "graph-check" }, h("input", { type: "checkbox", checked: state.includeDbs.includes(d.id), onChange: (e) => {
      state.includeDbs = e.target.checked ? [...state.includeDbs, d.id] : state.includeDbs.filter((x) => x !== d.id);
      saveUi({ includeDbs: state.includeDbs });
      setDbLabel();
      g.setFilter(filter());
    } }), h("span", {}, d.title || "Untitled"))) : h("p", { class: "hint" }, "No databases.")
  ));
  const rulesBtn = h("button", { type: "button", class: "graph-rules-btn", disabled: !state.repo, title: state.repo ? "Style rules for this repository" : "Choose a repository to edit its style rules", onClick: () => {
    const repo = env.pages().find((p) => p.id === state.repo);
    if (repo) openGraphRules(env, repo, () => g.refresh());
  } }, ico("palette"), h("span", {}, "Rules…"));
  const fit = h("button", { type: "button", class: "icon", title: "Fit to screen (0)", "aria-label": "Fit to screen", onClick: () => g.fit() }, ico("scan"));
  const head = h(
    "header",
    { class: "graph-head" },
    h("div", { class: "graph-title" }, h("h1", {}, ico("waypoints"), " Graph"), countEl),
    h("div", { class: "graph-tools", role: "toolbar", "aria-label": "Graph filters" }, repoSel, search, orphans, dbBox, modeToggle(state.mode, (m) => {
      state.mode = m;
      saveUi({ mode: m });
      g.setMode(m);
    }), rulesBtn, fit),
    h("p", { class: "graph-help hint" }, "Drag to move, scroll or pinch to zoom, click a page to open it. Keyboard: Tab to the graph, arrows pan, + and − zoom, 0 fits; the List view lists every page and its links.")
  );
  main.classList.remove("doc-wide", "doc-small");
  main.replaceChildren(h("section", { class: "graph-page", "aria-label": "Graph" }, head, stage));
  const g = mountGraph(stage, { ws: env.ws, pages: env.pages, open: openNode(env) }, {
    key: state.repo ? `repo:${state.repo}` : "workspace",
    filter,
    mode: state.mode,
    onCount: (t) => (countEl.textContent = t)
  });
  return g;
}

// ---------- local graph side panel ----------
let panel = null; // { el, g, pageId, depth }
export const localGraphOpen = () => !!panel;
export function closeLocalGraph() {
  if (!panel) return;
  panel.g.destroy();
  panel.el.remove();
  document.documentElement.classList.remove("has-graph-panel");
  panel = null;
}
/** Page ⋯ → Local graph: opens (or closes) the side panel focused on `pageId`. */
export function toggleLocalGraph(env, pageId) {
  if (panel) return closeLocalGraph();
  const prefs = uiPrefs();
  const depth = [1, 2, 3].includes(prefs.depth) ? prefs.depth : 1;
  const mode = prefs.localMode === "list" ? "list" : "canvas";
  const stage = h("div", { class: "graph-stage" });
  const depthSel = h("select", { "aria-label": "Depth", onChange: (e) => {
    panel.depth = Number(e.target.value);
    saveUi({ depth: panel.depth });
    panel.g.setLocal({ focusId: panel.pageId, depth: panel.depth });
  } }, [1, 2, 3].map((d) => h("option", { value: String(d), selected: d === depth }, `${d} step${d === 1 ? "" : "s"}`)));
  depthSel.value = String(depth);
  const countEl = h("span", { class: "graph-count", role: "status", "aria-live": "polite" });
  const el = h(
    "aside",
    { class: "graph-panel", "aria-label": "Local graph" },
    h("div", { class: "graph-panel-head" }, h("strong", {}, ico("waypoints"), " Local graph"), depthSel, modeToggle(mode, (m) => {
      saveUi({ localMode: m });
      panel.g.setMode(m);
    }), h("button", { type: "button", class: "icon graph-panel-close", title: "Close local graph", "aria-label": "Close local graph", onClick: closeLocalGraph }, ico("x"))),
    countEl,
    stage
  );
  document.body.append(el);
  document.documentElement.classList.add("has-graph-panel");
  panel = { el, pageId, depth, g: null };
  panel.g = mountGraph(stage, { ws: env.ws, pages: env.pages, open: openNode(env) }, {
    key: "local",
    filter: () => ({}),
    local: () => ({ focusId: panel?.pageId ?? pageId, depth: panel?.depth ?? depth }),
    mode,
    onCount: (t) => (countEl.textContent = t)
  });
  el.querySelector("select")?.focus();
}
/** Called on every navigation: the open panel follows the current page. */
export function followLocalGraph(env, pageId) {
  sweepGraphs();
  if (!panel || !pageId || panel.pageId === pageId) return;
  panel.pageId = pageId;
  panel.g.setLocal({ focusId: pageId, depth: panel.depth });
}

// ---------- the graph block ----------
/** Body of a `graph` block: b.graph = { scope: "local" | "workspace" | <repoId>, depth: 1–3, mode: "canvas" | "list" }. */
export function graphBlockBody(b, inst, a) {
  const { ctx } = inst;
  const cfg = b.graph && typeof b.graph === "object" ? b.graph : (b.graph = {});
  const pages = () => ctx.livePages();
  const scope = () => cfg.scope || "local";
  const depth = () => ([1, 2, 3].includes(cfg.depth) ? cfg.depth : 1);
  const stage = h("div", { class: "graph-stage graph-block-stage" });
  const countEl = h("span", { class: "graph-count", role: "status", "aria-live": "polite" });
  const filter = () => (scope() === "local" || scope() === "workspace" ? {} : { repo: scope() });
  const local = () => (scope() === "local" ? { focusId: ctx.pageId, depth: depth() } : null);
  const ws = ctx.ws;
  if (!ws?.links) return h("div", { class: "graph-block hint" }, "The graph is not available here.");
  const set = (patch) => {
    Object.assign(cfg, patch);
    a.save();
  };
  const repos = liveRepos(pages());
  const depthSel = h("select", { "aria-label": "Depth", disabled: ctx.locked, hidden: scope() !== "local", onChange: (e) => {
    set({ depth: Number(e.target.value) });
    g.setLocal(local());
  } }, [1, 2, 3].map((d) => h("option", { value: String(d), selected: d === depth() }, `${d} step${d === 1 ? "" : "s"}`)));
  const scopeSel = h("select", { "aria-label": "Graph of", disabled: ctx.locked, onChange: (e) => {
    set({ scope: e.target.value });
    depthSel.hidden = scope() !== "local";
    g.setLocal(local());
    g.setFilter(filter());
  } }, h("option", { value: "local" }, "This page (local)"), h("option", { value: "workspace" }, "Whole workspace"), repos.map((r) => h("option", { value: r.id }, r.title || "Untitled")));
  scopeSel.value = scope();
  const open = (id, node) => {
    Promise.resolve(ctx.flush?.()).finally(() => {
      if (node?.kind === "row") location.hash = `#row-${id}`;
      else ctx.openPage(id);
    });
  };
  const el = h(
    "div",
    { class: "graph-block", role: "group", "aria-label": "Graph" },
    h("div", { class: "graph-block-tools" }, h("span", { class: "graph-block-label" }, ico("waypoints")), scopeSel, depthSel, modeToggle(cfg.mode === "list" ? "list" : "canvas", (m) => {
      if (!ctx.locked) set({ mode: m });
      g.setMode(m);
    }), countEl),
    stage
  );
  const g = mountGraph(stage, { ws, pages, open }, {
    key: `block:${b.id}`,
    filter,
    local,
    mode: cfg.mode === "list" ? "list" : "canvas",
    onCount: (t) => (countEl.textContent = t)
  });
  return el;
}

// ---------- appearance ----------
function colorPicker(value, onChange) {
  let cur = value ?? "";
  const btn = (val, label) => h("button", {
    type: "button",
    class: "graph-swatch",
    "data-color": val,
    "aria-pressed": String(cur === val),
    "aria-label": label,
    title: label,
    style: val ? `--sw:${swatchCss(val)}` : null,
    onClick: () => {
      cur = val;
      for (const b of wrap.querySelectorAll("button")) {
        const on = b.dataset.color === val;
        b.setAttribute("aria-pressed", String(on));
        b.replaceChildren(on ? ico("check") : "");
      }
      onChange(val);
    }
  }, cur === val ? ico("check") : "");
  const wrap = h("div", { class: "graph-swatches", role: "group", "aria-label": "Colour" }, btn("", "Default (no colour)"), btn("grey", "Grey"), GRAPH_HUES.map(([label, v]) => btn(v, label)));
  return wrap;
}
function iconField(value, onChange) {
  let cur = value || "";
  const show = h("span", { class: "graph-icon-show" });
  const paint = () => show.replaceChildren(cur ? iconNode(cur) : h("span", { class: "hint" }, "None"));
  paint();
  const pick = h("button", { type: "button", onClick: () => pickEmoji(pick, (em) => {
    cur = em || "";
    paint();
    onChange(cur);
  }, { removable: true }) }, ico("shapes"), " Choose…");
  const clear = h("button", { type: "button", onClick: () => {
    cur = "";
    paint();
    onChange("");
  } }, "Clear");
  return h("div", { class: "graph-icon-field" }, show, pick, clear);
}
const sizeSelect = (value, onChange, label = "Size") => {
  const sel = h("select", { "aria-label": label, onChange: (e) => onChange(e.target.value) }, SIZES.map(([l, v]) => h("option", { value: v }, l)));
  sel.value = SIZES.some(([, v]) => v === String(value ?? "")) ? String(value ?? "") : "";
  return sel;
};

/** Page ⋯ → Graph appearance…: icon, colour and size of this page's node (page.graph). */
export function openAppearance(env, page, onSaved) {
  const cur = { ...(page.graph || {}) };
  const content = h(
    "div",
    { class: "graph-appearance" },
    h("p", { class: "hint" }, "How this page looks in the graph. Anything left at default follows the repository's rules."),
    h("div", { class: "graph-field" }, h("span", { class: "graph-field-label" }, "Icon"), iconField(cur.icon, (v) => (cur.icon = v))),
    h("div", { class: "graph-field" }, h("span", { class: "graph-field-label" }, "Colour"), colorPicker(cur.color ?? "", (v) => (cur.color = v))),
    h("label", { class: "graph-field" }, h("span", { class: "graph-field-label" }, "Size"), sizeSelect(cur.size, (v) => (cur.size = v ? Number(v) : null)))
  );
  openModal({
    title: "Graph appearance",
    content,
    actions: [
      { label: "Cancel" },
      { label: "Save", class: "primary", run: async () => {
        await env.persistence?.flush?.();
        const clean = cleanAppearance(cur);
        if (clean) page.graph = clean;
        else delete page.graph;
        await env.ws.savePage(page);
        toast(clean ? "Graph appearance saved" : "Graph appearance reset");
        onSaved?.();
      } }
    ]
  });
}

// ---------- rules ----------
const OP_LABELS = { is: "is", isNot: "is not", contains: "contains", notContains: "does not contain", empty: "is empty", notEmpty: "is not empty", gt: "is more than", lt: "is less than" };
const FIELD_OPTS = [["field:type", "Type (page, database, row)"], ["field:title", "Title"], ["field:links", "Link count"], ["field:tag", "Tags"]];
/** Property names used by pages (and database columns) in a repository, for the rule editor's field list. */
function propNames(env, repo) {
  const all = env.pages();
  const names = new Set();
  const inRepo = (p) => {
    for (let q = p, n = 0; q && n < 100; q = all.find((x) => x.id === q.parentId), n++) if (q.id === repo.id) return true;
    return false;
  };
  for (const p of all) {
    if (!inRepo(p)) continue;
    for (const pr of p.props || []) if (pr?.name) names.add(pr.name);
    if (p.type === "database" && !p.sourceId) for (const c of p.columns || []) if (c?.name) names.add(c.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b)).slice(0, 200);
}
/** Repository graph rules: "when <field> <op> <value> → icon / colour / size", first match wins. Saved on the repo page. */
export function openGraphRules(env, repo, onSaved) {
  const rules = (repo.graphRules || []).map((r) => ({ ...r, when: { ...(Array.isArray(r.when) ? r.when[0] : r.when) } }));
  let sizeMode = repo.graphSize === "fixed" ? "fixed" : "links";
  const names = [...new Set([...propNames(env, repo), ...rules.filter((r) => r.when?.prop != null).map((r) => String(r.when.prop))])];
  const list = h("div", { class: "graph-rules" });
  const fieldValue = (w) => (w.prop != null ? `prop:${w.prop}` : `field:${w.field || "type"}`);
  const draw = () => {
    list.replaceChildren(...rules.length ? rules.map((r, i) => {
      const w = r.when;
      const fieldSel = h("select", { "aria-label": `Rule ${i + 1}: field`, onChange: (e) => {
        const v = e.target.value;
        r.when = v.startsWith("prop:") ? { prop: v.slice(5), op: w.op, value: w.value } : { field: v.slice(6), op: w.op, value: w.value };
        draw();
      } }, h("optgroup", { label: "Page" }, FIELD_OPTS.map(([v, l]) => h("option", { value: v }, l))), names.length ? h("optgroup", { label: "Properties" }, names.map((n) => h("option", { value: `prop:${n}` }, n))) : null);
      fieldSel.value = fieldValue(w);
      const opSel = h("select", { "aria-label": `Rule ${i + 1}: condition`, onChange: (e) => {
        w.op = e.target.value;
        draw();
      } }, RULE_OPS.map((o) => h("option", { value: o }, OP_LABELS[o])));
      opSel.value = w.op || "is";
      const needsValue = !["empty", "notEmpty"].includes(w.op);
      const valIn = needsValue ? h("input", { type: "text", value: w.value ?? "", "aria-label": `Rule ${i + 1}: value`, placeholder: w.field === "type" ? "page, database or row" : "value", onInput: (e) => (w.value = e.target.value) }) : null;
      const move = (d) => {
        const j = i + d;
        if (j < 0 || j >= rules.length) return;
        [rules[i], rules[j]] = [rules[j], rules[i]];
        draw();
      };
      return h(
        "fieldset",
        { class: "graph-rule" },
        h("legend", {}, `Rule ${i + 1}`),
        h("div", { class: "graph-rule-when" }, h("span", { class: "graph-rule-kw" }, "When"), fieldSel, opSel, valIn),
        h("div", { class: "graph-rule-then" }, h("span", { class: "graph-rule-kw" }, "Show"), iconField(r.icon, (v) => (r.icon = v)), sizeSelect(r.size, (v) => (r.size = v ? Number(v) : null), `Rule ${i + 1}: size`)),
        colorPicker(r.color ?? "", (v) => (r.color = v)),
        h("div", { class: "graph-rule-acts" },
          h("button", { type: "button", class: "icon", title: "Move up", "aria-label": `Move rule ${i + 1} up`, disabled: i === 0, onClick: () => move(-1) }, ico("arrow-up")),
          h("button", { type: "button", class: "icon", title: "Move down", "aria-label": `Move rule ${i + 1} down`, disabled: i === rules.length - 1, onClick: () => move(1) }, ico("arrow-down")),
          h("button", { type: "button", class: "danger", onClick: () => {
            rules.splice(i, 1);
            draw();
          } }, ico("trash"), " Remove"))
      );
    }) : [h("p", { class: "hint" }, "No rules yet.")]);
  };
  draw();
  const sizeSel = h("select", { "aria-label": "Node size", onChange: (e) => (sizeMode = e.target.value) }, h("option", { value: "links" }, "Grows with link count"), h("option", { value: "fixed" }, "Fixed"));
  sizeSel.value = sizeMode;
  openModal({
    title: `Graph rules: ${repo.title || "Untitled"}`,
    content: h(
      "div",
      { class: "graph-rules-box" },
      h("p", { class: "hint" }, "The first matching rule styles a page's node. A page's own Graph appearance wins over rules."),
      list,
      h("button", { type: "button", onClick: () => {
        rules.push({ when: { field: "type", op: "is", value: "page" } });
        draw();
        list.lastElementChild?.querySelector("select")?.focus();
      } }, ico("plus"), " Add rule"),
      h("label", { class: "graph-field" }, h("span", { class: "graph-field-label" }, "Node size"), sizeSel)
    ),
    actions: [
      { label: "Cancel" },
      { label: "Save", class: "primary", run: async () => {
        await env.persistence?.flush?.();
        const fresh = (await env.ws.getPage(repo.id)) || repo;
        const clean = cleanGraphRules(rules.map((r) => ({ ...r, color: r.color || null })));
        if (clean.length) fresh.graphRules = clean;
        else delete fresh.graphRules;
        if (sizeMode === "fixed") fresh.graphSize = "fixed";
        else delete fresh.graphSize;
        await env.ws.savePage(fresh);
        await env.refresh?.();
        toast(clean.length ? `${clean.length} graph rule${clean.length === 1 ? "" : "s"} saved` : "Graph rules cleared");
        onSaved?.();
      } }
    ]
  });
}
