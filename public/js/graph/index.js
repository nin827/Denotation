// Graph view: wires model → style → layout (worker or main thread) → canvas renderer, plus the accessible list.
//
//   const view = createGraphView(container, {
//     data: { pages, links } | { pages, linkIndex },   // see model.js for the record formats
//     filter, styleRules, sizeMode: "links" | "fixed",
//     onOpen: (id, page) => …,
//     local: { focusId, depth },                         // local graph (neighbours up to depth steps)
//     positionsCache: { load(): obj | null | Promise<obj|null>, save(obj) },  // { [id]: [x, y] }
//     worker: true, reducedMotion: auto, seed: 1, mode: "canvas" | "list" | "both"
//   });
//   view.update(data); view.setFilter(f); view.setLocal(l); view.setStyleRules(r); view.setMode(m); view.fit(); view.destroy();

import { buildGraph } from "./model.js";
import { styleGraph } from "./style.js";
import { importPositions } from "./layout.js";
import { createLayoutRunner } from "./runner.js";
import { createRenderer } from "./render.js";
import { createGraphList } from "./list.js";

const reduced = () => !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Order-independent hash of a graph's node ids and edges (to tell whether the layout needs to move). */
function signature(g) {
  let h = g.nodes.length * 2654435761 >>> 0, c = 0;
  const hs = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619); return x >>> 0; };
  for (let e = 0; e < g.edgeCount; e++) { h = (h + hs(g.nodes[g.source[e]].id + ">" + g.nodes[g.target[e]].id)) >>> 0; c++; }
  for (const p of g.nodes) h = (h + hs(String(p.id))) >>> 0;
  return h + ":" + c;
}

export function createGraphView(container, options = {}) {
  let data = options.data || { pages: [], links: [] };
  let filter = options.filter || {};
  let local = options.local || null;
  let rules = options.styleRules || [];
  let sizeMode = options.sizeMode || "links";
  const quiet = options.reducedMotion ?? reduced();
  const seed = options.seed ?? 1;

  const wrap = document.createElement("div");
  wrap.className = "graph-view";
  wrap.style.cssText = "position:relative;width:100%;height:100%;min-height:200px;overflow:hidden";
  const canvas = document.createElement("canvas");
  canvas.className = "graph-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;outline-offset:-2px";
  const listBox = document.createElement("div");
  listBox.className = "graph-list-box";
  listBox.style.cssText = "position:absolute;inset:0;overflow:auto;padding:8px";
  wrap.append(canvas, listBox);
  container.append(wrap);

  // icons: Lucide data loads on demand (only if a node has an icon); one bitmap per icon + colour
  let ICONS = null, iconsLoading = false;
  const iconImgs = new Map();
  const iconSvg = options.iconSvg || ((name) => (ICONS && Object.hasOwn(ICONS, name) ? ICONS[name][0] : null));
  const iconImage = (name, color) => {
    const key = name + "|" + color;
    let img = iconImgs.get(key);
    if (img) return img.bitmap || null;
    if (!options.iconSvg && !ICONS) {
      if (!iconsLoading) {
        iconsLoading = true;
        import("../icons/lucide-data.js").then((m) => { ICONS = m.ICONS; renderer.invalidate(); }).catch(() => {});
      }
      return null;
    }
    const body = iconSvg(name);
    if (!body) return null;
    // rasterise once into a small canvas: drawing an SVG image re-rasterises it on every call
    img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      c.getContext("2d").drawImage(img, 0, 0, 64, 64);
      img.bitmap = c;
      renderer.invalidate();
    };
    const col = String(color).replace(/["<>&]/g, "");
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`);
    iconImgs.set(key, img);
    return null;
  };

  let g = null, runner = null, lastSig = null;
  let known = {}; // id -> [x, y]: every position this view has seen (cache + layouts), reused across filters
  let saveTimer = 0;
  const persist = () => {
    clearTimeout(saveTimer); saveTimer = 0;
    if (!options.positionsCache?.save || !g) return;
    rememberPositions();
    const ids = new Set((data.pages || []).map((p) => String(p.id)));
    const out = {};
    for (const id in known) if (ids.has(id)) out[id] = known[id];
    try { options.positionsCache.save(out); } catch { /* cache is best effort */ }
  };
  const rememberPositions = () => {
    if (!g || !runner) return;
    const xy = renderer.positions;
    if (xy.length !== 2 * g.nodes.length) return;
    for (let i = 0; i < g.nodes.length; i++) known[g.nodes[i].id] = [Math.round(xy[2 * i] * 10) / 10, Math.round(xy[2 * i + 1] * 10) / 10];
  };

  const renderer = createRenderer(canvas, {
    iconImage,
    onOpen: (i) => g && options.onOpen?.(g.nodes[i].id, g.nodes[i]),
    onDragStart: (i) => runner?.pin(i, renderer.positions[2 * i], renderer.positions[2 * i + 1], quiet ? 0 : 0.3),
    onDrag: (i, x, y) => runner?.pin(i, x, y, quiet ? 0 : 0.3),
    onDragEnd: (i) => { if (!quiet) runner?.unpin(i); scheduleSave(); }
  });
  const list = createGraphList(listBox, {
    onOpen: (i) => g && options.onOpen?.(g.nodes[i].id, g.nodes[i]),
    onFocusNode: (i) => { renderer.setHover(i); if (mode !== "list") renderer.centerOn(i); }
  });
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 800); };

  let mode = options.mode || "canvas";
  const applyMode = () => {
    canvas.style.display = mode === "list" ? "none" : "block";
    listBox.style.display = mode === "canvas" ? "none" : "block";
    listBox.style.position = mode === "both" ? "static" : "absolute";
    if (mode === "both") { wrap.style.height = "auto"; canvas.style.height = "60vh"; }
  };
  applyMode();

  function rebuild() {
    rememberPositions();
    const f = { ...filter };
    if (local?.focusId) { f.focus = local.focusId; f.depth = local.depth ?? 1; }
    g = buildGraph(data, f);
    const style = styleGraph(g, rules, { sizeMode });
    const ids = g.nodes.map((p) => String(p.id));
    const warm = importPositions(ids, known);
    const sig = signature(g);
    const changed = lastSig !== null && sig !== lastSig;
    lastSig = sig;
    runner?.stop();
    wrap.dataset.state = "layout";
    canvas.setAttribute("aria-label", `Graph of ${g.nodes.length} pages and ${g.edgeCount} links. The list view lists them for keyboard and screen reader use.`);
    const allKnown = warm.count === g.nodes.length;
    renderer.setGraph(g, style, allKnown && g.nodes.length ? warm.positions : null);
    list.setGraph(g);
    runner = createLayoutRunner({
      n: g.nodes.length, source: g.source, target: g.target, radius: style.radius, seed,
      positions: warm.positions, known: warm.known,
      alpha: allKnown ? (changed ? 0.15 : 0) : undefined
    }, {
      worker: options.worker !== false, quiet,
      onTick: (xy, settled) => {
        renderer.setPositions(xy);
        if (settled) { wrap.dataset.state = "ready"; scheduleSave(); view.onSettled?.(); }
      }
    });
  }

  // theme follows <html data-mode / style> and the OS colour scheme
  const retheme = () => renderer.setTheme();
  const mo = typeof MutationObserver === "function" ? new MutationObserver(retheme) : null;
  mo?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "style", "class", "data-theme"] });
  const mq = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  mq?.addEventListener?.("change", retheme);

  const view = {
    element: wrap,
    /** New pages/links (e.g. after a save). Positions of unchanged nodes are kept. */
    update(d) { data = d || { pages: [], links: [] }; rebuild(); },
    /** Replaces the filter (see model.normalizeFilter). */
    setFilter(f) { filter = f || {}; rebuild(); },
    /** Local graph around focusId (null for the global graph). */
    setLocal(l) { local = l || null; rebuild(); },
    setStyleRules(r, sm) { rules = r || []; if (sm) sizeMode = sm; rebuild(); },
    /** "canvas" | "list" | "both" */
    setMode(m) { mode = m; applyMode(); },
    fit: () => renderer.fit(),
    refreshTheme: retheme,
    get graph() { return g; },
    get renderer() { return renderer; },
    get runner() { return runner; },
    onSettled: null,
    destroy() {
      persist();
      runner?.stop();
      renderer.destroy();
      list.destroy();
      mo?.disconnect();
      mq?.removeEventListener?.("change", retheme);
      wrap.remove();
    }
  };

  const cached = options.positionsCache?.load?.();
  if (cached && typeof cached.then === "function") {
    cached.then((c) => { if (c && typeof c === "object") known = { ...c, ...known }; }).catch(() => {}).finally(rebuild);
  } else {
    if (cached && typeof cached === "object") known = { ...cached };
    rebuild();
  }
  return view;
}
