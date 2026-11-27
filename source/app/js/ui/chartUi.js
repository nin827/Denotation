// Chart drawing, live data and the dedicated editor (inline chip and block). All maths are in ../chart/chart.js (pure).
// SVG is built with createElementNS and text only goes in as text nodes / attributes; nothing here uses innerHTML.
import { h, debounce } from "./dom.js";
import { ico } from "../icons/index.js";
import { openModal } from "./modal.js";
import { evalExpression } from "../formula.js";
import { sourceList, sourceLabel, isTableSourceId, findTableSource } from "../sources.js";
import * as chips from "./inlineChips.js";
import {
  KINDS, AGGS, SIZES, HUES, LIMITS, cleanSpec, sourceOf, parseNumbers, formatNumbers, literalData, dataFromRows, dataFromFormula,
  labelsFor, progressMax, progressValue, describe, fmtNum, stats, sparkGeometry, barGeometry, pieGeometry, progressGeometry, sliceHue
} from "../chart/chart.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const kid of kids) if (kid != null) el.append(kid);
  return el;
};
const text = (s) => document.createTextNode(String(s));
const hueStyle = (hue) => (typeof hue === "number" ? `--ch:${hue}` : null);
const BLOCK_W = 560;

// ---------- data ----------
const rowCache = new Map();
const rowsOf = (ctx, id) => {
  const hit = rowCache.get(id);
  if (hit && hit.ws === ctx.ws && Date.now() - hit.t < 300) return hit.p;
  const p = Promise.resolve(ctx.ws.listRows(id)).catch(() => []);
  rowCache.set(id, { t: Date.now(), ws: ctx.ws, p });
  return p;
};
/** The database a spec points at: { state, host, data, views } (`data` has columns, and rows for a table source). */
export function lookupDb(ctx, id) {
  const pages = ctx.livePages?.() ?? [];
  if (!id) return { state: "none" };
  if (isTableSourceId(id)) {
    const t = findTableSource(pages, id);
    return t ? { state: "ok", host: t, data: t, views: [] } : { state: "missing" };
  }
  const info = ctx.pageInfo?.(id);
  if (!info || info.state === "missing") return { state: "missing" };
  if (info.state === "trashed" || info.state === "archived") return { state: info.state };
  const host = pages.find((p) => p.id === id);
  const data = host?.sourceId ? pages.find((p) => p.id === host.sourceId) : host;
  if (!host || !data || data.type !== "database") return { state: "missing" };
  const views = Array.isArray(host.views) && host.views.length ? host.views : Array.isArray(data.views) ? data.views : [];
  return { state: "ok", host, data, views };
}
const lastData = new Map(); // token JSON -> last resolved data, for Markdown export of database / formula charts
export const lastResolved = (key) => lastData.get(key) ?? null;
const remember = (key, data) => {
  if (!key) return;
  lastData.delete(key);
  lastData.set(key, data);
  if (lastData.size > 200) lastData.delete(lastData.keys().next().value);
};
/** Numbers for a spec: literal, database column (honouring its saved view) or formula. Never throws. */
export async function loadData(spec, ctx) {
  const fail = (error) => ({ values: [], labels: [], error });
  try {
    const s = sourceOf(spec);
    if (s === "n") return literalData(spec);
    if (!ctx?.ws || !ctx.livePages) return fail("Needs the workspace");
    if (s === "f") {
      if (!spec.f) return fail("Enter a formula");
      return dataFromFormula(chips.runFormula ? await chips.runFormula(ctx, spec.f) : evalExpression(spec.f, {}));
    }
    const f = lookupDb(ctx, spec.d);
    if (f.state === "none") return fail("Pick a database");
    if (f.state === "trashed") return fail("Database is in the trash");
    if (f.state === "archived") return fail("Database is archived");
    if (f.state !== "ok") return fail("Database not found");
    const rows = f.data.virtual ? f.data.rows : await rowsOf(ctx, f.data.id);
    return dataFromRows(spec, { columns: f.data.columns, views: f.views }, rows);
  } catch {
    return fail("Could not load the data");
  }
}

// ---------- drawing ----------
const title = (s) => svgEl("title", {}, text(s));
/** An <svg> chart; `detail` is the block version (axes, legend). Returns { svg, caption } (caption: extra text for progress). */
export function drawChart(spec, data, { detail = false } = {}) {
  const values = data?.values ?? [];
  const labels = labelsFor(spec, data ?? {});
  const grey = spec.h === "grey";
  const H = SIZES.find((x) => x.id === spec.z)?.h ?? 160;
  const root = (w, hh, cls) => svgEl("svg", { class: `chart-svg ${cls}${grey ? " is-grey" : ""}`, viewBox: `0 0 ${w} ${hh}`, style: hueStyle(spec.h), "aria-hidden": "true", focusable: "false" });
  if (spec.k === "spark") {
    const g = sparkGeometry(values, detail ? { w: BLOCK_W, h: H, pad: 12, left: 50 } : { w: 80, h: 20, pad: 2 });
    if (!g) return null;
    const svg = root(g.w, g.h, detail ? "chart-spark chart-detail" : "chart-spark");
    if (detail) {
      for (const p of [g.max, g.min]) {
        svg.append(svgEl("line", { class: "c-grid", x1: 50, x2: g.w - 8, y1: p.y, y2: p.y }), svgEl("text", { class: "c-tick", x: 44, y: p.y, "text-anchor": "end", "dominant-baseline": "central" }, text(fmtNum(p.v))));
      }
    }
    if (g.area) svg.append(svgEl("path", { class: "c-area", d: g.area }));
    if (g.line) svg.append(svgEl("path", { class: "c-line", d: g.line }));
    svg.append(svgEl("circle", { class: "c-dot", cx: g.last.x, cy: g.last.y, r: detail ? 3.5 : 1.9 }, detail ? title(`Last: ${fmtNum(g.last.v)}`) : null));
    if (detail) svg.append(svgEl("text", { class: "c-val", x: g.last.x, y: Math.max(10, g.last.y - 9), "text-anchor": g.last.x > g.w - 40 ? "end" : "middle" }, text(fmtNum(g.last.v))));
    return { svg };
  }
  if (spec.k === "bar") {
    const g = barGeometry(values, detail ? { w: BLOCK_W, h: H, detail: true, labels } : { w: 60, h: 20 });
    if (!g) return null;
    const svg = root(g.w, g.h, detail ? "chart-bar chart-detail" : "chart-bar");
    for (const t of g.ticks) svg.append(svgEl("line", { class: "c-grid", x1: g.left, x2: g.right, y1: t.y, y2: t.y }), svgEl("text", { class: "c-tick", x: g.left - 6, y: t.y, "text-anchor": "end", "dominant-baseline": "central" }, text(t.text)));
    for (const b of g.bars) svg.append(svgEl("rect", { class: `c-bar${b.neg ? " neg" : ""}`, x: b.x, y: b.y, width: b.w, height: b.h, rx: detail && b.w > 6 ? 2 : 0 }, detail ? title(`${labels[b.i] ? `${labels[b.i]}: ` : ""}${fmtNum(b.v)}`) : null));
    if (detail || values.some((v) => v < 0)) svg.append(svgEl("line", { class: "c-base", x1: g.left, x2: g.right, y1: g.base, y2: g.base }));
    for (const l of g.xlabels) svg.append(svgEl("text", { class: "c-tick", x: l.x, y: l.y, "text-anchor": "middle" }, text(l.text)));
    return { svg };
  }
  if (spec.k === "pie") {
    const r = detail ? Math.min(H / 2 - 6, 110) : 10;
    const g = pieGeometry(values, { r, labels });
    if (!g) return null;
    const w = detail ? BLOCK_W : 20;
    const svg = root(w, detail ? Math.max(H, 2 * r + 12) : 20, detail ? "chart-pie chart-detail" : "chart-pie");
    const place = svgEl("g", { transform: detail ? `translate(6 ${(Math.max(H, 2 * r + 12) - 2 * r) / 2})` : null });
    for (const s of g.slices) {
      const attrs = { class: "c-slice", style: [hueStyle(sliceHue(spec.h, s.i)), grey ? `--i:${s.i}` : null].filter(Boolean).join(";") };
      const tip = title(`${s.label || `Slice ${s.i + 1}`}: ${fmtNum(s.value)} (${Math.round(s.frac * 100)}%)`);
      place.append(s.circle ? svgEl("circle", { ...attrs, cx: g.cx, cy: g.cy, r }, tip) : svgEl("path", { ...attrs, d: s.d }, tip));
    }
    svg.append(place);
    if (detail) {
      const x0 = 2 * r + 36;
      g.slices.forEach((s, row) => {
        const y = 22 + row * 22;
        svg.append(
          svgEl("rect", { class: "c-slice", x: x0, y: y - 10, width: 12, height: 12, rx: 2, style: [hueStyle(sliceHue(spec.h, s.i)), grey ? `--i:${s.i}` : null].filter(Boolean).join(";") }),
          svgEl("text", { class: "c-leg", x: x0 + 20, y, "dominant-baseline": "central" }, text(`${s.label || `Slice ${s.i + 1}`} · ${fmtNum(s.value)} · ${Math.round(s.frac * 100)}%`))
        );
      });
    }
    return { svg };
  }
  // progress
  const max = progressMax(spec, data ?? {});
  const g = progressGeometry(progressValue(values), max, { w: detail ? BLOCK_W : 60 });
  if (!g || !values.length) return null;
  const bh = detail ? 16 : 8;
  const svg = root(g.w, bh, detail ? "chart-progress chart-detail" : "chart-progress");
  svg.append(svgEl("rect", { class: "c-track", x: 0, y: 0, width: g.w, height: bh, rx: bh / 2 }));
  if (g.fill > 0) svg.append(svgEl("rect", { class: "c-fill", x: 0, y: 0, width: Math.max(g.fill, bh), height: bh, rx: bh / 2 }));
  return { svg, caption: `${g.pct}%${detail ? ` · ${fmtNum(g.value)} of ${fmtNum(g.max)}` : ""}` };
}
export const problem = (data) => data?.error ?? (!data?.values?.length ? "No data" : null);
/** The nodes inside an inline chip: the chart, plus the percentage for progress. */
export function chipNodes(spec, data) {
  const bad = problem(data);
  const art = bad ? null : drawChart(spec, data);
  if (!art) return [ico("info"), h("span", { class: "chart-msg" }, bad ?? "No data")];
  return [art.svg, art.caption ? h("span", { class: "chart-pct" }, art.caption) : null].filter(Boolean);
}
/** The block-size drawing: a figure with the chart, an optional caption and the progress numbers. */
export function blockNode(spec, data) {
  const bad = problem(data);
  const art = bad ? null : drawChart(spec, data, { detail: true });
  const fig = h("div", { class: "chart-fig" });
  if (!art) return h("div", { class: "chart-fig chart-fig-err" }, ico("info"), h("span", {}, bad ?? "No data"));
  fig.append(art.svg);
  if (art.caption) fig.append(h("div", { class: "chart-cap" }, art.caption));
  return fig;
}

// ---------- live ----------
/**
 * Paint a chart for `spec` now and again when the data it reads changes. Literal charts paint at once and never listen.
 * Database / formula charts refresh on workspace changes (debounced 300 ms) and stop listening once `el` leaves the page.
 * paint(data) draws the result; `key` names it for the Markdown export. Returns a function that stops the watching.
 */
export function watchChart(el, spec, ctx, paint, key) {
  const literal = sourceOf(spec) === "n";
  let gen = 0;
  let dead = false;
  const run = async () => {
    const mine = ++gen;
    const data = literal ? literalData(spec) : await loadData(spec, ctx);
    if (mine !== gen || dead) return;
    remember(key, data);
    paint(data);
  };
  if (literal) {
    remember(key, literalData(spec));
    paint(literalData(spec));
    return () => {};
  }
  paint({ values: [], labels: [], error: "…", loading: true });
  let stopWs = null;
  const stop = () => {
    stopWs?.();
    document.removeEventListener(chips.CONSTANTS_EVENT, onConst);
  };
  const again = debounce(() => {
    if (dead) return;
    if (!el.isConnected) return stop();
    rowCache.clear();
    run();
  }, 300);
  const onConst = () => again();
  stopWs = ctx.ws?.onDataChange?.(again) ?? null;
  if (sourceOf(spec) === "f") document.addEventListener(chips.CONSTANTS_EVENT, onConst);
  run();
  return () => {
    dead = true;
    stop();
  };
}

// ---------- editor ----------
const swatch = (v) => (v === "grey" ? "var(--muted)" : `oklch(0.64 0.15 ${v})`);
const hueName = (v) => (v === "grey" ? "Grey" : HUES.find((x) => x[0] === v)?.[1] ?? "");
const errLine = (msg) => h("div", { class: "chart-ed-err", role: "status" }, ico("info"), h("span", {}, msg));

/**
 * The dedicated chart editor (a dialog; a bottom sheet on phones). Live preview, inline errors, and Esc / clicking outside
 * saves (a new chart is only inserted once something changed); Cancel discards. onSave(spec) gets the cleaned spec.
 */
export function openChartEditor({ spec, ctx, block = false, isNew = false, onSave, onCancel }) {
  const start = cleanSpec(spec, { block });
  const startJson = JSON.stringify(start);
  const st = {
    k: start.k, s: sourceOf(start), nums: formatNumbers(start.n ?? []), l: start.l ?? [], d: start.d ?? "", c: start.c ?? "", v: start.v ?? "",
    a: start.a ?? "rows", f: start.f ?? "", h: start.h, t: start.t ?? "", m: start.m !== void 0 ? String(start.m) : "", z: start.z ?? "m"
  };
  let cancelled = false;
  let edited = false;
  const numInfo = () => parseNumbers(st.nums);
  const maxNum = () => (st.m.trim() === "" ? null : Number(st.m));
  const current = () => cleanSpec({ k: st.k, s: st.s, n: numInfo().values, l: st.l, d: st.d, c: st.c, v: st.v, a: st.a, f: st.f, h: st.h, t: st.t, m: maxNum(), z: st.z }, { block });

  const preview = h("div", { class: "chart-ed-preview", "aria-live": "polite" });
  const errors = h("div", { class: "chart-ed-errors" });
  const body = h("div", { class: "chart-ed" });
  let gen = 0;
  const refresh = debounce(async () => {
    const mine = ++gen;
    const sp = current();
    const data = await loadData(sp, ctx);
    if (mine !== gen) return;
    const msgs = [];
    if (st.s === "n") {
      const ni = numInfo();
      if (!ni.values.length) msgs.push(ni.bad.length ? `Not numbers: ${ni.bad.join(", ")}` : "Add some numbers, separated by commas or spaces.");
      else if (ni.bad.length) msgs.push(`Ignored (not numbers): ${ni.bad.join(", ")}`);
      if (ni.over) msgs.push(`Only the first ${LIMITS.nums} numbers are kept.`);
    }
    if (st.s !== "n" && data.error && !data.loading) msgs.push(data.error);
    if (data.note) msgs.push(data.note);
    if (st.m.trim() !== "" && !(maxNum() > 0)) msgs.push("The maximum must be a number above 0 (it is ignored).");
    errors.replaceChildren(...msgs.map(errLine));
    const nodes = [];
    if (!block) nodes.push(h("p", { class: "chart-ed-sample" }, "Sample: this week ", h("span", { class: "ichip ichip-chart", title: describe(sp, data) }, ...chipNodes(sp, data)), " compared with last week."));
    else nodes.push(blockNode(sp, data));
    preview.replaceChildren(...nodes);
    preview.setAttribute("aria-label", describe(sp, data));
  }, 120);
  const touch = () => {
    edited = true;
    refresh();
  };

  // ---- controls ----
  const radioGroup = (label, items, get, set, cls = "") => {
    const wrap = h("div", { class: `chart-radios ${cls}`, role: "radiogroup", "aria-label": label });
    const paint = () => {
      for (const b of wrap.children) {
        const on = b.dataset.v === String(get());
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.classList.toggle("on", on);
      }
    };
    for (const it of items) {
      wrap.append(h("button", { type: "button", role: "radio", class: "chart-radio", "data-v": it.id, title: it.label, onClick: () => {
        set(it.id);
        paint();
        touch();
      } }, it.icon ? ico(it.icon) : null, h("span", {}, it.label)));
    }
    paint();
    wrap.addEventListener("keydown", (e) => {
      if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
      const btns = [...wrap.children];
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      btns[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : btns.length - 1)) % btns.length].focus();
    });
    return wrap;
  };
  const kindPick = radioGroup("Chart type", KINDS, () => st.k, (v) => {
    st.k = v;
    drawSource();
  });
  const srcPick = radioGroup("Data source", [{ id: "n", label: "Numbers" }, { id: "d", label: "Database" }, { id: "f", label: "Formula" }], () => st.s, (v) => {
    st.s = v;
    drawSource();
  });
  const input = (label, key, props = {}) => h("label", {}, label, h("input", { type: "text", autocomplete: "off", value: st[key], ...props, onInput: (e) => {
    st[key] = e.target.value;
    touch();
  } }));
  const select = (label, options, get, set) => {
    const sel = h("select", { onChange: (e) => {
      set(e.target.value);
      touch();
    } }, options.map((o) => h("option", { value: o.value, selected: o.value === get() }, o.label)));
    return h("label", {}, label, sel);
  };
  const hueRow = h("div", { class: "chart-hues", role: "radiogroup", "aria-label": "Colour" });
  const paintHues = () => {
    hueRow.replaceChildren(...[...HUES.map((x) => x[0]), "grey"].map((v) => h("button", {
      type: "button", role: "radio", class: `chart-hue${st.h === v ? " on" : ""}`, "aria-checked": st.h === v ? "true" : "false", "aria-label": hueName(v), title: hueName(v), style: `--sw:${swatch(v)}`,
      onClick: () => {
        st.h = v;
        paintHues();
        touch();
        hueRow.querySelector(".on")?.focus();
      }
    }, st.h === v ? ico("check") : null)));
  };
  paintHues();
  const sourceBox = h("div", { class: "chart-ed-source" });
  const labelsInput = h("label", {}, "Labels (optional, comma separated; one per number or slice)", h("input", { type: "text", autocomplete: "off", value: st.l.join(", "), onInput: (e) => {
    st.l = e.target.value.split(",").map((x) => x.trim());
    touch();
  } }));
  function drawSource() {
    if (st.s === "n") {
      sourceBox.replaceChildren(
        h("label", {}, "Numbers (spaces, commas or new lines)", h("textarea", { rows: 3, spellcheck: "false", value: st.nums, onInput: (e) => {
          st.nums = e.target.value;
          touch();
        } }))
      );
    } else if (st.s === "f") {
      sourceBox.replaceChildren(
        input("Formula (a number, or a list of numbers as text)", "f", { spellcheck: "false", placeholder: "e.g. SUM(1, 2, 3)  or  TEXTJOIN(\", \", TRUE, 3, 5, 8)" }),
        h("p", { class: "hint" }, "Uses the same engine as inline formulas, so constants and database lookups work.")
      );
    } else {
      const dbs = sourceList(ctx.livePages?.() ?? [], { tables: true, linked: true });
      const f = lookupDb(ctx, st.d);
      const cols = f.state === "ok" ? f.data.columns : [];
      const views = f.state === "ok" ? f.views : [];
      const dbOpts = [{ value: "", label: "Pick a database…" }, ...dbs.map((p) => ({ value: p.id, label: sourceLabel(p) }))];
      if (st.d && !dbs.some((p) => p.id === st.d)) dbOpts.push({ value: st.d, label: "(unavailable database)" });
      const colOpts = [{ value: "", label: "Pick a column…" }, ...cols.map((c) => ({ value: c.id, label: `${c.name} (${c.type})` }))];
      if (st.c && !cols.some((c) => c.id === st.c)) colOpts.push({ value: st.c, label: "(missing column)" });
      sourceBox.replaceChildren(
        select("Database", dbOpts, () => st.d, (v) => {
          st.d = v;
          st.c = "";
          st.v = "";
          drawSource();
        }),
        select("Column", colOpts, () => st.c, (v) => {
          st.c = v;
        }),
        select("Saved view (its filters apply)", [{ value: "", label: "All rows" }, ...views.map((x) => ({ value: x.id, label: x.name || x.type }))].concat(st.v && !views.some((x) => x.id === st.v) ? [{ value: st.v, label: "(missing view)" }] : []), () => st.v, (v) => {
          st.v = v;
        }),
        select("Read the column as", AGGS.map((x) => ({ value: x.id, label: x.label })), () => st.a, (v) => {
          st.a = v;
        }),
        h("p", { class: "hint" }, "Progress adds the numbers up. A checkbox column counts ticked rows out of all rows. Charts update as the data changes.")
      );
    }
    optionsBox.replaceChildren(...[
      ...st.s === "d" ? [] : [labelsInput],
      st.k === "progress" ? input("Maximum (progress, default 100)", "m", { inputmode: "decimal", placeholder: "100" }) : null,
      input("Caption (read by screen readers, shown on hover)", "t", { maxlength: LIMITS.title }),
      block ? select("Size", SIZES.map((x) => ({ value: x.id, label: x.label })), () => st.z, (v) => {
        st.z = v;
      }) : null
    ].filter(Boolean));
    refresh();
  }
  const optionsBox = h("div", { class: "chart-ed-options" });
  body.append(
    h("div", { class: "chart-ed-group" }, h("span", { class: "chart-ed-h" }, "Type"), kindPick),
    h("div", { class: "chart-ed-group" }, h("span", { class: "chart-ed-h" }, "Data"), srcPick, sourceBox),
    h("div", { class: "chart-ed-group" }, h("span", { class: "chart-ed-h" }, "Colour"), hueRow),
    optionsBox,
    errors,
    h("div", { class: "chart-ed-group" }, h("span", { class: "chart-ed-h" }, "Preview"), preview)
  );
  drawSource();
  const finish = () => {
    if (cancelled) return onCancel?.();
    const sp = current();
    if (isNew) return edited ? onSave?.(sp) : onCancel?.();
    if (JSON.stringify(sp) !== startJson) onSave?.(sp);
  };
  const modal = openModal({
    title: isNew ? (block ? "New chart" : "New inline chart") : block ? "Edit chart" : "Edit inline chart",
    content: body,
    actions: [{ label: "Cancel", run: () => { cancelled = true; } }, { label: isNew ? "Insert" : "Done", class: "primary", run: () => { edited = true; } }],
    onClose: finish
  });
  body.closest(".modal")?.classList.add("chart-ed-modal");
  body.closest(".modal-overlay")?.classList.add("chart-ed-overlay");
  requestAnimationFrame(() => body.querySelector(".chart-radio.on")?.focus());
  return modal;
}
