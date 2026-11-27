// Function graphs in the UI: the SVG drawing (createElementNS, text via textContent only), the `plot` block body, the
// inline chip and the dedicated editor (function list, range, points, live preview, errors with icon + text).
// Maths, sampling and path data are in ../plot/plot.js (pure). Registered by ./plugins/plot.js.
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { setBlockMenu } from "./blockExtras.js";
import { openAnchoredEditor } from "./anchoredEditor.js";
import { CONSTANTS_EVENT } from "./inlineChips.js";
import { constantResolver, findRepo } from "../constants.js";
import {
  PLOT_HUES, HUE_NAMES, MAX_FNS, MAX_POINTS, MAX_EXPR, MAX_LABEL, DEFAULT_HUES,
  cleanPlot, plotModel, plotToArg, plotFromArg, plotToken
} from "../plot/plot.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
  if (text != null) el.textContent = String(text);
  return el;
};
const hueStyle = (hue) => (typeof hue === "number" ? `--ph:${hue}` : null);
const hueClass = (hue) => (hue === "grey" ? " is-grey" : "");

/** Repository constants for expressions on this page: ctx is the block editor / chip context (all parts optional). */
export function constantsFor(ctx) {
  try {
    const repo = findRepo(ctx?.livePages?.() ?? [], ctx?.pageId);
    return repo ? constantResolver(repo) : undefined;
  } catch {
    return undefined;
  }
}

/** The graph as an <svg>. opts.compact: the sparkline-sized version for text. */
export function plotSvg(model, { compact = false } = {}) {
  const { box, view } = model;
  const svg = svgEl("svg", {
    class: `plot-svg${compact ? " is-compact" : ""}`, viewBox: `0 0 ${box.w} ${box.h}`, width: box.w, height: box.h,
    role: "img", "aria-label": model.alt, focusable: "false"
  });
  svg.append(svgEl("title", {}, model.alt));
  const L = box.l;
  const R = box.w - box.r;
  const T = box.t;
  const B = box.h - box.b;
  svg.append(svgEl("rect", { class: "plot-frame", x: L, y: T, width: R - L, height: B - T }));
  if (!compact && model.spec.grid) {
    const d = [...model.xticks.map((t) => `M${t.px} ${T}V${B}`), ...model.yticks.map((t) => `M${L} ${t.py}H${R}`)].join("");
    if (d) svg.append(svgEl("path", { class: "plot-grid", d }));
  }
  const axes = [model.axisY !== null ? `M${model.axisY} ${T}V${B}` : "", model.axisX !== null ? `M${L} ${model.axisX}H${R}` : ""].join("");
  if (axes) svg.append(svgEl("path", { class: "plot-axis", d: axes }));
  if (!compact) {
    const ticks = svgEl("g", { class: "plot-ticks" });
    for (const t of model.xticks) {
      ticks.append(svgEl("path", { class: "plot-tick", d: `M${t.px} ${B}v3` }));
      ticks.append(svgEl("text", { x: t.px, y: B + 15, "text-anchor": "middle" }, t.label));
    }
    for (const t of model.yticks) {
      ticks.append(svgEl("path", { class: "plot-tick", d: `M${L} ${t.py}h-3` }));
      ticks.append(svgEl("text", { x: L - 6, y: t.py, "text-anchor": "end", "dominant-baseline": "central" }, t.label));
    }
    svg.append(ticks);
  }
  model.series.forEach((s, i) => {
    if (!s.d) return;
    svg.append(svgEl("path", { class: `plot-line${hueClass(s.hue)}${i % 2 ? " is-alt" : ""}`, d: s.d, style: hueStyle(s.hue) }, null));
  });
  if (!compact) {
    for (const p of model.points) {
      if (!p.inView) continue;
      const g = svgEl("g", { class: "plot-point" });
      g.append(svgEl("circle", { cx: p.px, cy: p.py, r: 4 }));
      if (p.label) {
        const right = p.px < (L + R) * 0.65;
        g.append(svgEl("text", { x: p.px + (right ? 7 : -7), y: p.py - 7, "text-anchor": right ? "start" : "end" }, p.label));
      }
      svg.append(g);
    }
  } else {
    for (const p of model.points) if (p.inView) svg.append(svgEl("circle", { class: "plot-dot", cx: p.px, cy: p.py, r: 2 }));
  }
  return svg;
}

/** The "y = expr" list under a graph: the text alternative, with errors and notes shown as icon + text. */
function legend(model) {
  const items = model.series.map((s) => {
    const li = h("li", { class: `plot-leg${s.error ? " has-error" : ""}` },
      h("span", { class: `plot-sw${hueClass(s.hue)}`, style: hueStyle(s.hue), "aria-hidden": "true" }),
      h("span", { class: "plot-eq" }, `y = ${s.expr}`));
    if (s.error) li.append(h("span", { class: "plot-err" }, ico("info"), h("span", {}, s.error)));
    else if (s.note) li.append(h("span", { class: "plot-note" }, s.note));
    else if (s.truncated) li.append(h("span", { class: "plot-note" }, "drawn in part (too slow)"));
    return li;
  });
  const out = model.points.filter((p) => !p.inView).length;
  if (out) items.push(h("li", { class: "plot-leg plot-note" }, `${out} point${out === 1 ? "" : "s"} outside the shown range`));
  return h("ul", { class: "plot-legend", "aria-label": "Functions" }, items.length ? items : [h("li", { class: "plot-leg plot-note" }, "No functions yet")]);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- the block ----------
export function plotBody(b, inst, a) {
  const locked = !!inst.ctx.locked;
  const apply = (spec) => {
    delete b.ymin;
    delete b.ymax;
    Object.assign(b, spec);
  };
  apply(cleanPlot(b));
  const wrap = h("div", { class: "plot" });
  const render = () => {
    if (!wrap.isConnected && wrap._seen) return false;
    wrap._seen = true;
    const model = plotModel(b, { constant: constantsFor(inst.ctx) });
    const hit = h("div", { class: "plot-hit" }, plotSvg(model));
    if (!locked) {
      Object.assign(hit, { tabIndex: 0 });
      hit.setAttribute("role", "button");
      hit.setAttribute("aria-label", `${model.alt}. Press Enter to edit`);
      hit.addEventListener("click", () => edit());
      hit.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        edit();
      });
    }
    wrap.replaceChildren(hit, legend(model));
    return true;
  };
  const edit = () => openPlotEditor({
    spec: b, ctx: inst.ctx, title: "Edit function graph", anchor: wrap,
    onSave: (spec) => {
      apply(spec);
      a.save();
      render();
      wrap.querySelector(".plot-hit")?.focus();
    }
  });
  setBlockMenu(b, () => {
    if (locked) return [];
    return [
      { header: true, label: "Function graph" },
      { label: "Edit graph…", icon: ico("pencil"), onSelect: edit },
      { label: b.grid === false ? "Show grid" : "Hide grid", icon: ico("grid-3x3"), onSelect: () => { apply(cleanPlot({ ...b, grid: b.grid === false })); a.save(); render(); } },
      b.ymin !== undefined ? { label: "Automatic y range", icon: ico("rotate-ccw"), onSelect: () => { apply(cleanPlot({ ...b, ymin: null, ymax: null })); a.save(); render(); } } : null
    ].filter(Boolean);
  });
  render();
  document.addEventListener(CONSTANTS_EVENT, function again() {
    if (!render()) document.removeEventListener(CONSTANTS_EVENT, again);
  });
  return wrap;
}

// ---------- the inline chip ----------
export const plotAlt = (spec) => (spec.fns.length ? spec.fns.map((f) => `y = ${f.expr}`).join("; ") : "empty graph");

export function plotChip(n, ctx) {
  const wrap = h("span", { class: "ichip-wrap" });
  const arg = n.args[0];
  const paint = () => {
    if (!wrap.isConnected && wrap._seen) return false;
    wrap._seen = true;
    const spec = plotFromArg(arg);
    if (!spec) {
      wrap.replaceChildren(h("span", { class: "ichip ichip-miss", title: "This graph could not be read" }, ico("info"), h("span", {}, "Bad graph")));
      return true;
    }
    const model = plotModel(spec, { constant: constantsFor(ctx), compact: true, budgetMs: 40 });
    const alt = plotAlt(spec);
    const btn = h("button", {
      type: "button", class: "ichip ichip-btn ichip-plot", "data-tok": "plot", "data-plot": arg, title: alt,
      "aria-label": `Function graph: ${alt}${ctx?.locked ? "" : ". Press Enter to edit"}`, disabled: !!ctx?.locked
    }, plotSvg(model, { compact: true }), model.errors.length ? h("span", { class: "plot-err" }, ico("info")) : null);
    wrap.replaceChildren(btn);
    return true;
  };
  paint();
  document.addEventListener(CONSTANTS_EVENT, function again() {
    if (!paint()) document.removeEventListener(CONSTANTS_EVENT, again);
  });
  return wrap;
}

/** Click / Enter on a chip (called by chipAction): open the editor and hand the new token text to apply(). */
export function plotChipAction(el, ctx, apply) {
  const spec = plotFromArg(el.dataset.plot ?? "") ?? cleanPlot({});
  openPlotEditor({
    spec, ctx, title: "Edit inline graph", anchor: el,
    onSave: (next) => {
      const token = plotToken(next);
      if (token) apply(token);
    }
  });
}

/** Insert flow: edit a starter graph, then onPick(token). Esc or a click outside inserts it, Cancel does not. */
export function pickPlot(ctx, { onPick, onCancel } = {}, spec) {
  let saved = false;
  openPlotEditor({
    spec, ctx, title: "Insert inline graph", always: true,
    onSave: (next) => {
      const token = plotToken(next);
      if (!token) return;
      saved = true;
      onPick?.(token);
    },
    onClose: () => {
      if (!saved) onCancel?.();
    }
  });
  return null;
}

// ---------- the editor ----------
const fmt = (n) => (n === undefined || n === null ? "" : String(Number(Number(n).toPrecision(12))));

/**
 * The dedicated editor (a popover next to its anchor on desktop, a bottom sheet on phones). Works on a copy; Esc, a click outside or Done saves
 * through onSave(spec) when something changed, Cancel leaves the graph as it was.
 */
export function openPlotEditor({ spec, ctx, title, onSave, onClose, always = false, anchor }) {
  const start = cleanPlot(spec);
  const st = {
    fns: start.fns.map((f) => ({ expr: f.expr, hue: f.hue })),
    xmin: fmt(start.xmin), xmax: fmt(start.xmax),
    ymin: fmt(start.ymin), ymax: fmt(start.ymax),
    points: start.points.map((p) => ({ x: fmt(p.x), y: fmt(p.y), label: p.label ?? "" })),
    grid: start.grid
  };
  if (!st.fns.length) st.fns.push({ expr: "", hue: undefined });
  const constant = constantsFor(ctx);
  const preview = h("div", { class: "pe-preview", "aria-live": "polite" });
  const fnList = h("ul", { class: "pe-list", "aria-label": "Functions" });
  const ptList = h("ul", { class: "pe-list", "aria-label": "Points" });
  const rangeErr = h("div", { class: "pe-err", role: "status" });
  const isNum = (s) => String(s).trim() !== "" && Number.isFinite(Number(s));
  let lastGood = start;
  let errEls = [];

  /** The spec the fields describe right now, plus the range problem (if any). */
  const readState = () => {
    const problems = [];
    let xmin = Number(st.xmin);
    let xmax = Number(st.xmax);
    if (!isNum(st.xmin) || !isNum(st.xmax) || !(xmin < xmax)) {
      problems.push("x range: enter two numbers, the first below the second.");
      [xmin, xmax] = [lastGood.xmin, lastGood.xmax];
    }
    const yBlank = st.ymin.trim() === "" && st.ymax.trim() === "";
    let ymin;
    let ymax;
    if (!yBlank) {
      if (isNum(st.ymin) && isNum(st.ymax) && Number(st.ymin) < Number(st.ymax)) [ymin, ymax] = [Number(st.ymin), Number(st.ymax)];
      else problems.push("y range: enter two numbers (first below second), or leave both empty for automatic.");
    }
    const points = st.points.filter((p) => p.x.trim() !== "" || p.y.trim() !== "" || p.label.trim() !== "");
    points.forEach((p, i) => {
      if (!isNum(p.x) || !isNum(p.y)) problems.push(`Point ${i + 1}: x and y must be numbers.`);
    });
    const out = cleanPlot({
      fns: st.fns, xmin, xmax, ymin, ymax, grid: st.grid,
      points: points.map((p) => ({ x: p.x, y: p.y, label: p.label }))
    });
    return { spec: out, problems };
  };

  const refresh = () => {
    const { spec: s, problems } = readState();
    lastGood = { ...s };
    // keep empty rows aligned with the model: model.series only holds the non-empty ones
    const model = plotModel(s, { constant });
    preview.replaceChildren(plotSvg(model), legend(model));
    rangeErr.replaceChildren(...problems.length ? [ico("info"), h("span", {}, problems.join(" "))] : []);
    let k = 0;
    st.fns.forEach((f, i) => {
      const el = errEls[i];
      if (!el) return;
      if (!f.expr.trim()) return void el.replaceChildren();
      const ser = model.series[k++];
      el.replaceChildren(...ser?.error ? [ico("info"), h("span", {}, ser.error)] : []);
    });
  };

  const input = (props) => h("input", { type: "text", autocomplete: "off", spellcheck: "false", autocapitalize: "off", style: "font-size:16px", ...props });
  const iconBtn = (name, label, onClick, cls = "icon") => h("button", { type: "button", class: cls, "aria-label": label, title: label, onClick }, ico(name));
  const hueSelect = (i) => {
    const f = st.fns[i];
    const sel = h("select", { "aria-label": `Colour of function ${i + 1}`, style: "font-size:16px" },
      h("option", { value: "" }, "Automatic"),
      PLOT_HUES.map((hv, j) => h("option", { value: String(hv), selected: f.hue === hv }, HUE_NAMES[j])),
      h("option", { value: "grey", selected: f.hue === "grey" }, "Grey"));
    sel.addEventListener("change", () => {
      f.hue = sel.value === "" ? undefined : sel.value === "grey" ? "grey" : Number(sel.value);
      refresh();
      drawFns(false);
    });
    return sel;
  };
  const effectiveHue = (i) => st.fns[i].hue ?? DEFAULT_HUES[st.fns.slice(0, i).filter((f) => f.expr.trim()).length % DEFAULT_HUES.length];
  function drawFns(focusLast) {
    errEls = [];
    fnList.replaceChildren(...st.fns.map((f, i) => {
      const e = input({ value: f.expr, maxlength: String(MAX_EXPR), placeholder: "sin(x), x^2 - 3, 2*x + 1", "aria-label": `Function ${i + 1}, y =`, "data-i": i });
      e.addEventListener("input", () => {
        f.expr = e.value;
        refresh();
      });
      e.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        if (i === st.fns.length - 1 && st.fns.length < MAX_FNS && f.expr.trim()) addFn();
        else fnList.querySelectorAll("input")[i + 1]?.focus();
      });
      const err = h("div", { class: "pe-err", role: "status" });
      errEls.push(err);
      const hv = effectiveHue(i);
      return h("li", { class: "pe-row" },
        h("span", { class: `plot-sw${f.hue === "grey" ? " is-grey" : ""}`, style: hueStyle(hv), "aria-hidden": "true" }),
        h("span", { class: "pe-y", "aria-hidden": "true" }, "y ="),
        e, hueSelect(i),
        iconBtn("trash", `Remove function ${i + 1}`, () => {
          st.fns.splice(i, 1);
          if (!st.fns.length) st.fns.push({ expr: "", hue: undefined });
          drawFns(false);
          refresh();
        }, "icon danger"),
        err);
    }));
    addFnBtn.disabled = st.fns.length >= MAX_FNS;
    if (focusLast) fnList.querySelectorAll("input")[st.fns.length - 1]?.focus();
    refresh();
  }
  function addFn() {
    if (st.fns.length >= MAX_FNS) return;
    st.fns.push({ expr: "", hue: undefined });
    drawFns(true);
  }
  const addFnBtn = h("button", { type: "button", class: "pe-add", onClick: addFn }, ico("plus"), " Add function");

  function drawPts(focusLast) {
    ptList.replaceChildren(...st.points.map((p, i) => {
      const bind = (key, props) => {
        const e = input({ value: p[key], ...props });
        e.addEventListener("input", () => {
          p[key] = e.value;
          refresh();
        });
        return e;
      };
      return h("li", { class: "pe-row pe-pt" },
        bind("x", { inputmode: "decimal", placeholder: "x", "aria-label": `Point ${i + 1} x` }),
        bind("y", { inputmode: "decimal", placeholder: "y", "aria-label": `Point ${i + 1} y` }),
        bind("label", { maxlength: String(MAX_LABEL), placeholder: "Label (optional)", "aria-label": `Point ${i + 1} label` }),
        iconBtn("trash", `Remove point ${i + 1}`, () => {
          st.points.splice(i, 1);
          drawPts(false);
          refresh();
        }, "icon danger"));
    }));
    addPtBtn.disabled = st.points.length >= MAX_POINTS;
    if (focusLast) ptList.querySelector("li:last-child input")?.focus();
  }
  const addPtBtn = h("button", { type: "button", class: "pe-add", onClick: () => {
    if (st.points.length >= MAX_POINTS) return;
    st.points.push({ x: "", y: "", label: "" });
    drawPts(true);
  } }, ico("plus"), " Add point");

  const field = (label, key, placeholder) => {
    const e = input({ value: st[key], inputmode: "decimal", placeholder, "aria-label": label });
    e.addEventListener("input", () => {
      st[key] = e.value;
      refresh();
    });
    return h("label", { class: "pe-field" }, label, e);
  };
  const gridBox = h("input", { type: "checkbox", checked: st.grid, onChange: (ev) => {
    st.grid = ev.target.checked;
    refresh();
  } });

  const body = h("div", { class: "plot-edit" },
    preview,
    h("div", { class: "pe-form" },
      h("h4", {}, "Functions"), fnList, h("div", { class: "pe-actions" }, addFnBtn),
      h("div", { class: "pe-help hint" }, "Use x, the constants pi and e, your repository constants and functions such as SIN, COS, TAN, SQRT, ABS, LN, EXP, POWER, IF."),
      h("h4", {}, "Range"),
      h("div", { class: "pe-range" }, field("x min", "xmin", "-10"), field("x max", "xmax", "10"), field("y min", "ymin", "auto"), field("y max", "ymax", "auto")),
      rangeErr,
      h("label", { class: "pe-check" }, gridBox, " Show grid"),
      h("h4", {}, "Points"),
      ptList, h("div", { class: "pe-actions" }, addPtBtn)));

  let cancelled = false;
  let committed = false;
  const commit = () => {
    if (cancelled || committed) return;
    committed = true;
    const next = readState().spec;
    if (always || !same(next, start)) onSave(next);
  };
  const modal = openAnchoredEditor({
    anchor, width: 780,
    title,
    content: body,
    actions: [{ label: "Cancel", run: () => { cancelled = true; } }, { label: "Done", class: "primary" }],
    onClose: () => {
      commit();
      onClose?.();
    }
  });
  void modal;
  drawFns(false);
  drawPts(false);
  setTimeout(() => fnList.querySelector("input")?.focus(), 0);
}

export { plotToArg };
