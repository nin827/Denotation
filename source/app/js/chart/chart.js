// Inline charts and the chart block (pure: no DOM, so Node tests import it). Cleans and validates a chart spec, turns a
// data source into numbers, scales them and builds plain SVG geometry that ui/chartUi.js draws with createElementNS.
//
// A spec (the same object is the {{chart:<json>}} token body and, plus `z`, the `chart` block's fields):
//   k  kind: "spark" | "bar" | "pie" | "progress"
//   s  source: "n" literal numbers (n, l) | "d" database column (d, c, v, a) | "f" formula (f). Omitted when "n".
//   n  numbers (max 1000)          l  labels, one per number / slice (max 100, 40 chars each)
//   d  database page id            c  column id     v  saved view id (its filter and sorts apply)     a  how the column is read
//   f  formula text (the sandboxed engine: a number, or a list like "3, 5, 8" such as TEXTJOIN(", ", …))
//   h  colour hue 0..330 step 30, or "grey"      t  caption (aria / tooltip)      m  progress maximum (default 100)
//   z  block size "s" | "m" | "l" (block only)
import { visibleRows, groupRows } from "../dbviews.js";

export const KINDS = [
  { id: "spark", label: "Sparkline", icon: "chart-line" },
  { id: "bar", label: "Mini bar", icon: "chart-column" },
  { id: "pie", label: "Pie", icon: "chart-pie" },
  { id: "progress", label: "Progress", icon: "gauge" }
];
export const AGGS = [
  { id: "rows", label: "Each row" },
  { id: "count", label: "Count by value" },
  { id: "sum", label: "Sum" },
  { id: "avg", label: "Average" },
  { id: "min", label: "Minimum" },
  { id: "max", label: "Maximum" }
];
export const SIZES = [{ id: "s", label: "Small", h: 90 }, { id: "m", label: "Medium", h: 160 }, { id: "l", label: "Large", h: 260 }];
export const HUES = [
  [0, "Rose"], [30, "Red"], [60, "Orange"], [90, "Yellow"], [120, "Lime"], [150, "Green"],
  [180, "Teal"], [210, "Cyan"], [240, "Blue"], [270, "Violet"], [300, "Purple"], [330, "Pink"]
];
export const LIMITS = { nums: 1000, labels: 100, label: 40, title: 80, formula: 300, maxAbs: 1e15, slices: 12, points: 200, bars: 60, groups: 100 };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const cut = (s, n) => {
  const a = Array.from(String(s ?? ""));
  return a.length > n ? a.slice(0, n).join("") : a.join("");
};
const oneLine = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
const r2 = (n) => Math.round(n * 100) / 100;
const kindLabel = (k) => KINDS.find((x) => x.id === k)?.label ?? "Chart";

// ---------- numbers ----------
/** A finite number clamped to +-1e15 with 9 significant digits, or null. Text numbers count; blanks and words do not. */
export function toNum(x) {
  let n = x;
  if (typeof n === "string") n = n.trim() === "" ? NaN : Number(n);
  else if (typeof n === "boolean") n = n ? 1 : 0;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Number(Math.max(-LIMITS.maxAbs, Math.min(LIMITS.maxAbs, n)).toPrecision(9));
}
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
/** Numbers from free text (separated by spaces, commas, semicolons or newlines): { values, bad: [words that are not numbers], over } */
export function parseNumbers(text) {
  const values = [];
  const bad = [];
  let over = false;
  for (const w of String(text ?? "").split(/[\s,;]+/)) {
    if (!w) continue;
    const n = NUM_RE.test(w) ? toNum(w) : null;
    if (n === null) {
      if (bad.length < 5) bad.push(cut(w, 20));
    } else if (values.length >= LIMITS.nums) over = true;
    else values.push(n);
  }
  return { values, bad, over };
}
export const formatNumbers = (values) => (values ?? []).join(", ");
/** A short number for labels: 12, 3.46, 12.3k, 4.5M. */
export function fmtNum(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  const a = Math.abs(n);
  if (a >= 1e12) return n.toExponential(2).replace("e+", "e");
  if (a >= 1e6) return `${r2(n / 1e6)}M`;
  if (a >= 1e4) return `${r2(n / 1e3)}k`;
  return String(Math.round(n * 100) / 100);
}
/** n, min, max, last and sum of a number list (loops, so 100k values are fine). */
export function stats(values) {
  const n = values.length;
  if (!n) return { n: 0, min: 0, max: 0, last: 0, sum: 0 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { n, min, max, last: values[n - 1], sum };
}
/** At most `max` points: each bucket of neighbours is replaced by its mean (the original list when it is short enough). */
export function downsample(values, max) {
  const n = values.length;
  if (n <= max || max < 1) return values;
  const out = new Array(max);
  for (let i = 0; i < max; i++) {
    const a = Math.floor((i * n) / max);
    const b = Math.max(a + 1, Math.floor(((i + 1) * n) / max));
    let s = 0;
    for (let j = a; j < b; j++) s += values[j];
    out[i] = s / (b - a);
  }
  return out;
}

// ---------- spec ----------
const cleanHue = (v) => {
  if (v === "grey" || v === "gray") return "grey";
  const n = typeof v === "string" && /^\d{1,3}$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n >= 0 && n < 360 && n % 30 === 0 ? n : 240;
};
/** Which source a (cleaned or raw) spec reads: "n" | "d" | "f". */
export const sourceOf = (spec) => (spec?.s === "d" || spec?.s === "f" ? spec.s : spec?.s === "n" ? "n" : spec?.d ? "d" : typeof spec?.f === "string" && spec.f.trim() && !Array.isArray(spec?.n) ? "f" : "n");
/** A valid spec from anything (an unknown object, an old version, hostile JSON). Never throws; keys appear in a fixed order. */
export function cleanSpec(raw, { block = false } = {}) {
  const r = isObj(raw) ? raw : {};
  const out = { k: KINDS.some((x) => x.id === r.k) ? r.k : "spark" };
  const s = sourceOf(r);
  if (s !== "n") out.s = s;
  if (s === "n") {
    const src = Array.isArray(r.n) ? r.n : [];
    out.n = [];
    for (let i = 0; i < src.length && out.n.length < LIMITS.nums; i++) {
      const v = toNum(src[i]);
      if (v !== null) out.n.push(v);
    }
  } else if (s === "d") {
    out.d = typeof r.d === "string" && ID_RE.test(r.d) ? r.d : "";
    out.c = typeof r.c === "string" && ID_RE.test(r.c) ? r.c : "";
    if (typeof r.v === "string" && ID_RE.test(r.v)) out.v = r.v;
    out.a = AGGS.some((x) => x.id === r.a) ? r.a : "rows";
  } else {
    out.f = cut(oneLine(r.f), LIMITS.formula).trim();
  }
  out.h = cleanHue(r.h);
  if (Array.isArray(r.l)) {
    const l = r.l.slice(0, LIMITS.labels).map((x) => cut(oneLine(x), LIMITS.label).trim());
    while (l.length && l[l.length - 1] === "") l.pop();
    if (l.length) out.l = l;
  }
  const t = cut(oneLine(r.t), LIMITS.title).trim();
  if (t) out.t = t;
  const m = toNum(r.m);
  if (m !== null && m > 0) out.m = m;
  if (block) out.z = SIZES.some((x) => x.id === r.z) ? r.z : "m";
  return out;
}
/** The token body (compact JSON, no block-only fields). */
export const specJson = (spec) => JSON.stringify(cleanSpec(spec));
/** A spec from a token body; null when it is not a JSON object. */
export function specFromJson(text) {
  if (typeof text !== "string" || text.length > 20000) return null;
  try {
    const v = JSON.parse(text);
    return isObj(v) ? cleanSpec(v) : null;
  } catch {
    return null;
  }
}

// ---------- data ----------
/** One column cell as a number: numbers, numeric text and checkboxes (1 / 0); anything else is null. */
export function cellNumber(col, v) {
  if (col?.type === "checkbox") return v === true ? 1 : 0;
  if (typeof v === "boolean") return null;
  return toNum(v);
}
const empty = (extra) => ({ values: [], labels: [], ...extra });
/** The literal numbers (and labels) of a spec. */
export const literalData = (spec) => ({ values: [...(spec.n ?? [])], labels: spec.l ?? [] });
/**
 * Numbers from a database: `db` = { columns, views? }, `rows` = the database's rows. The chosen saved view's filter and
 * sorts apply. Returns { values, labels, max?, error? } (`max` is the row count when a checkbox column feeds a progress chip).
 */
export function dataFromRows(spec, db, rows) {
  const col = (db?.columns ?? []).find((c) => c.id === spec.c);
  if (!db) return empty({ error: "Database not found" });
  if (!col) return empty({ error: spec.c ? "Column not found" : "Pick a column" });
  let list = Array.isArray(rows) ? rows : [];
  if (spec.v) {
    const view = (db.views ?? []).find((x) => x.id === spec.v);
    if (!view) return empty({ error: "View not found" });
    list = visibleRows(db, view, list);
  }
  const a = spec.a ?? "rows";
  if (a === "count") {
    const groups = groupRows(list, db.columns, col.id).filter((g) => g.rows.length).slice(0, LIMITS.groups);
    return { values: groups.map((g) => g.rows.length), labels: groups.map((g) => cut(oneLine(g.label || "No value"), LIMITS.label)) };
  }
  const nums = [];
  for (const row of list) {
    const n = cellNumber(col, row?.values?.[col.id]);
    if (n !== null) nums.push(n);
  }
  const max = col.type === "checkbox" ? list.length : void 0;
  if (!nums.length) return empty(list.length && col.type !== "checkbox" ? { error: "This column has no numbers (use Count by value for categories)" } : {});
  if (a === "rows") return { values: nums, labels: [], max };
  const st = stats(nums);
  const v = a === "sum" ? st.sum : a === "avg" ? st.sum / st.n : a === "min" ? st.min : st.max;
  return { values: [toNum(v) ?? 0], labels: [], max };
}
/** Numbers from a formula result (the value of evalExpression, or its error): one number, or a list written as text. */
export function dataFromFormula(result) {
  if (!result || result.ok === false) return empty({ error: result?.error ?? "Formula error", detail: result?.detail });
  const v = result.value;
  if (v === null || v === void 0 || v === "") return empty();
  const n = toNum(v);
  if (n !== null && typeof v !== "string") return { values: [n], labels: [] };
  const { values, bad } = parseNumbers(String(v).replace(/[\[\]()]/g, " "));
  if (!values.length) return empty({ error: "The formula gives no numbers" });
  return { values, labels: [], ...bad.length ? { note: `Ignored: ${bad.join(", ")}` } : {} };
}
/** Labels for a data set: the spec's own labels win over those the source gave. */
export const labelsFor = (spec, data) => (spec.l?.length ? spec.l : data.labels ?? []);
/** The progress maximum: the spec's, else the checkbox row count, else 100. */
export const progressMax = (spec, data) => spec.m ?? (data?.max > 0 ? data.max : 100);
/** The value a progress chart shows: the sum of the numbers. */
export const progressValue = (values) => stats(values).sum;

// ---------- text ----------
/** The text alternative: "Sparkline of 12 values, min 3, max 40, last 22". The caption (t) leads when there is one. */
export function describe(spec, data) {
  const k = kindLabel(spec.k);
  const head = spec.t ? `${spec.t}: ` : "";
  if (data?.error) return `${head}${k}, ${data.error}`;
  const values = data?.values ?? [];
  if (!values.length) return `${head}${k} with no data`;
  const st = stats(values);
  if (spec.k === "progress") {
    const max = progressMax(spec, data);
    return `${head}Progress ${Math.round(Math.max(0, Math.min(1, max > 0 ? st.sum / max : 0)) * 100)}%, ${fmtNum(st.sum)} of ${fmtNum(max)}`;
  }
  if (spec.k === "pie") {
    const labels = labelsFor(spec, data);
    let big = 0;
    let total = 0;
    values.forEach((v, i) => {
      if (v > 0) total += v;
      if (v > values[big]) big = i;
    });
    if (total <= 0) return `${head}Pie chart with no positive values`;
    const name = labels[big] ? `${labels[big]}, ` : "";
    return `${head}Pie chart of ${values.length} slice${values.length === 1 ? "" : "s"}, largest ${name}${Math.round((Math.max(0, values[big]) / total) * 100)}%`;
  }
  return `${head}${spec.k === "bar" ? "Bar chart" : k} of ${st.n} value${st.n === 1 ? "" : "s"}, min ${fmtNum(st.min)}, max ${fmtNum(st.max)}, last ${fmtNum(st.last)}`;
}
/** Plain text for Markdown export, search and copy: the numbers (or a summary when there are many). */
export function plainText(spec, data) {
  const head = spec.t ? `${spec.t}: ` : "";
  const values = data?.values ?? [];
  if (data?.error || !values.length) return describe(spec, data);
  if (spec.k === "progress") return describe(spec, data);
  if (values.length > 20) return describe(spec, data);
  const labels = labelsFor(spec, data);
  return head + values.map((v, i) => (labels[i] ? `${labels[i]} ${fmtNum(v)}` : fmtNum(v))).join(", ");
}

// ---------- fenced block (Markdown) ----------
/** Lines of a ```chart fence: "key: value" per line. `data` (optional, resolved numbers) adds a comment line that import ignores. */
export function specToLines(specIn, data) {
  const spec = cleanSpec(specIn, { block: true });
  const s = sourceOf(spec);
  const lines = [`kind: ${spec.k}`, `source: ${s === "n" ? "numbers" : s === "d" ? "database" : "formula"}`];
  if (s === "n") lines.push(`data: ${formatNumbers(spec.n)}`);
  if (s === "d") {
    lines.push(`database: ${spec.d}`, `column: ${spec.c}`);
    if (spec.v) lines.push(`view: ${spec.v}`);
    lines.push(`agg: ${spec.a}`);
  }
  if (s === "f") lines.push(`formula: ${spec.f}`);
  if (spec.l) lines.push(`labels: ${JSON.stringify(spec.l)}`);
  lines.push(`color: ${spec.h}`);
  if (spec.m !== void 0) lines.push(`max: ${spec.m}`);
  if (spec.t) lines.push(`title: ${spec.t}`);
  lines.push(`size: ${spec.z}`);
  if (data) lines.push(`# ${describe(spec, data)}`);
  return lines;
}
/** A cleaned block spec from the lines of a ```chart fence (unknown keys and comment lines are ignored). */
export function specFromLines(lines) {
  const raw = {};
  const kv = {};
  for (const line of lines) {
    const m = /^([a-z]+):[ \t]?(.*)$/.exec(String(line).trimStart());
    if (m && !(m[1] in kv)) kv[m[1]] = m[2];
  }
  raw.k = kv.kind;
  const src = (kv.source ?? "").trim();
  raw.s = src === "database" ? "d" : src === "formula" ? "f" : "n";
  raw.n = parseNumbers(kv.data).values;
  raw.d = (kv.database ?? "").trim();
  raw.c = (kv.column ?? "").trim();
  raw.v = (kv.view ?? "").trim();
  raw.a = (kv.agg ?? "").trim();
  raw.f = kv.formula;
  try {
    const l = kv.labels ? JSON.parse(kv.labels) : null;
    if (Array.isArray(l)) raw.l = l;
  } catch {
    // labels stay empty
  }
  raw.h = /^\d+$/.test((kv.color ?? "").trim()) ? Number(kv.color) : (kv.color ?? "").trim();
  raw.m = kv.max;
  raw.t = kv.title;
  raw.z = (kv.size ?? "").trim();
  return cleanSpec(raw, { block: true });
}

// ---------- geometry ----------
const finite = (n) => (Number.isFinite(n) ? n : 0);
/** Colour hue of slice i: 150 degrees apart steps through all 12 hues. "grey" stays grey. */
export const sliceHue = (h, i) => (h === "grey" ? "grey" : (h + 150 * i) % 360);
const niceStep = (span, target) => {
  const raw = span / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 5, 10].map((m) => m * pow).find((s) => raw <= s) ?? raw);
};
/** Sparkline: { w, h, line, area, last, min, max, n } or null for no data. Points fill the width; a flat series sits mid-height. */
export function sparkGeometry(values, { w = 80, h = 20, pad = 2, left = 0 } = {}) {
  const pts = downsample(values, LIMITS.points);
  const n = pts.length;
  if (!n) return null;
  const st = stats(pts);
  const span = st.max - st.min;
  const x = (i) => (n === 1 ? (left + w) / 2 : left + pad + (i * (w - left - 2 * pad)) / (n - 1));
  const y = (v) => (span > 0 ? h - pad - ((v - st.min) / span) * (h - 2 * pad) : h / 2);
  const P = pts.map((v, i) => ({ x: r2(finite(x(i))), y: r2(finite(y(v))), v }));
  const line = n > 1 ? P.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join("") : "";
  const area = n > 1 ? `${line}L${P[n - 1].x} ${h - pad}L${P[0].x} ${h - pad}Z` : "";
  const at = (v) => P[pts.indexOf(v)];
  return { w, h, n, line, area, last: P[n - 1], min: at(st.min), max: at(st.max) };
}
/**
 * Bars: { w, h, bars: [{ x, y, w, h, v, neg, i }], base, ticks: [{ y, text }], xlabels: [{ x, text }] } or null.
 * `detail` (the block) leaves room for axis numbers and labels; the mini bar uses the whole box. Negatives hang below the baseline.
 */
export function barGeometry(values, { w = 60, h = 20, pad = 1, detail = false, labels = [] } = {}) {
  const vs = downsample(values, detail ? LIMITS.points : LIMITS.bars);
  const n = vs.length;
  if (!n) return null;
  const st = stats(vs);
  let lo = Math.min(0, st.min);
  let hi = Math.max(0, st.max);
  if (hi === lo) hi = lo + 1;
  const left = detail ? 46 : pad;
  const right = detail ? 10 : pad;
  const top = detail ? 10 : pad;
  const showX = detail && labels.length > 0 && n <= 12 && vs === values;
  const bottom = detail ? (showX ? 26 : 8) : pad;
  let step = 0;
  if (detail) {
    step = niceStep(hi - lo, 4);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
  }
  const pw = w - left - right;
  const ph = h - top - bottom;
  const y = (v) => top + ((hi - v) / (hi - lo)) * ph;
  const base = r2(finite(y(0)));
  const slot = pw / n;
  const bw = Math.max(1, slot * (slot > 6 ? 0.78 : slot > 3 ? 0.7 : 1));
  const bars = vs.map((v, i) => {
    const yy = y(v);
    const top0 = Math.min(yy, base);
    return { x: r2(finite(left + i * slot + (slot - bw) / 2)), y: r2(finite(top0)), w: r2(bw), h: r2(finite(Math.max(v === 0 ? 0 : 1, Math.abs(base - yy)))), v, neg: v < 0, i };
  });
  const ticks = [];
  if (detail) for (let v = lo; v <= hi + step / 2 && ticks.length < 12; v += step) ticks.push({ y: r2(finite(y(v))), text: fmtNum(Number(v.toPrecision(10))), x: left });
  const xlabels = showX ? vs.map((_, i) => ({ x: r2(left + i * slot + slot / 2), text: cut(labels[i] ?? "", 12), y: h - 8 })).filter((l) => l.text) : [];
  return { w, h, bars, base, left, right: w - right, ticks, xlabels };
}
/** Pie: { slices: [{ i, d, frac, value, label, circle }], total, cx, cy, r } or null. Only positive values count; slices past 12 merge into "Other". */
export function pieGeometry(values, { r = 10, labels = [] } = {}) {
  let items = values.map((v, i) => ({ v: Math.max(0, v), label: labels[i] ?? "" }));
  if (items.length > LIMITS.slices) {
    const rest = items.slice(LIMITS.slices - 1);
    items = [...items.slice(0, LIMITS.slices - 1), { v: rest.reduce((a, b) => a + b.v, 0), label: "Other" }];
  }
  const total = items.reduce((a, b) => a + b.v, 0);
  if (!(total > 0)) return null;
  const c = r;
  let a0 = -Math.PI / 2;
  const slices = [];
  items.forEach((it, i) => {
    if (!(it.v > 0)) return;
    const frac = it.v / total;
    if (frac > 0.9999) return slices.push({ i, d: "", frac: 1, value: it.v, label: it.label, circle: true });
    const a1 = a0 + frac * Math.PI * 2;
    const p = (a) => `${r2(c + r * Math.cos(a))} ${r2(c + r * Math.sin(a))}`;
    slices.push({ i, d: `M${c} ${c}L${p(a0)}A${r} ${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${p(a1)}Z`, frac, value: it.v, label: it.label, circle: false });
    a0 = a1;
  });
  return { slices, total, cx: c, cy: c, r };
}
/** Progress: { frac, pct, value, max, fill (width of the filled part) } or null for no data. */
export function progressGeometry(value, max, { w = 60 } = {}) {
  if (!Number.isFinite(value)) return null;
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return { frac, pct: Math.round(frac * 100), value, max, fill: r2(frac * w), w };
}

/** A whole ```chart fence for the Markdown export (literal data also gets a summary comment that import ignores). */
export function fenceText(specIn) {
  const spec = cleanSpec(specIn, { block: true });
  return `\`\`\`chart\n${specToLines(spec, sourceOf(spec) === "n" ? literalData(spec) : null).join("\n")}\n\`\`\``;
}
