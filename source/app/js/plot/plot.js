// Function graphs, pure (no DOM): clean and validate a plot spec, sample y = f(x) with the sandboxed formula engine,
// compute axis ticks, clip to the view and build SVG path data. Rendering lives in ../ui/plotUi.js.
//
// Spec (block): { fns: [{ expr, hue? }], xmin, xmax, ymin?, ymax?, points: [{ x, y, label? }], grid }
// Expressions use the variable `x`, the constants pi / e / tau, repository constants (the `constant` hook) and the
// formula functions (SIN, COS, SQRT, ...). Nothing is evaluated with eval / new Function: formula.js does the work.
import { check, evalExpression, FUNCTIONS, lookupError } from "../formula.js";


export const PLOT_HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
export const HUE_NAMES = ["Rose", "Red", "Orange", "Yellow", "Lime", "Green", "Teal", "Cyan", "Blue", "Violet", "Purple", "Pink"];
/** Colours given to functions that have no hue of their own, in order. */
export const DEFAULT_HUES = [210, 30, 150, 330, 270, 90, 0, 180];
export const MAX_FNS = 8;
export const MAX_POINTS = 50;
export const MAX_EXPR = 200;
export const MAX_LABEL = 40;
export const SAMPLES = 400;
export const BUDGET_MS = 120;
export const MAX_EVALS = 1800; // per function: first pass plus refinement
export const PLOT_ARG_MAX = 1000;
export const PLOT_TOKEN_MAX = 1500;
const LIM = 1e9;
const EPS_OUT = 1e-9;

const num = (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= LIM ? n : null;
};
const snapHue = (v) => {
  if (v === "grey") return "grey";
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const d = ((n % 360) + 360) % 360;
  return PLOT_HUES.reduce((a, b) => (Math.abs(b - d) < Math.abs(a - d) ? b : a));
};
const cleanExpr = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, MAX_EXPR);
const cleanLabel = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, MAX_LABEL);

/** A valid spec from anything: bad fields fall back to defaults, empty functions are dropped, lists are capped. */
export function cleanPlot(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const fns = [];
  for (const f of Array.isArray(r.fns) ? r.fns : []) {
    if (fns.length >= MAX_FNS) break;
    const o = typeof f === "string" ? { expr: f } : f && typeof f === "object" ? f : null;
    const expr = o ? cleanExpr(o.expr) : "";
    if (!expr) continue;
    const hue = snapHue(o.hue);
    fns.push(hue === undefined ? { expr } : { expr, hue });
  }
  let xmin = num(r.xmin);
  let xmax = num(r.xmax);
  if (xmin === null || xmax === null) [xmin, xmax] = [-10, 10];
  else if (xmin > xmax) [xmin, xmax] = [xmax, xmin];
  else if (xmin === xmax) xmax = xmin + 1;
  const out = { fns, xmin, xmax };
  const ymin = num(r.ymin);
  const ymax = num(r.ymax);
  if (ymin !== null && ymax !== null && ymin < ymax) Object.assign(out, { ymin, ymax });
  out.points = [];
  for (const p of Array.isArray(r.points) ? r.points : []) {
    if (out.points.length >= MAX_POINTS) break;
    const x = num(p?.x);
    const y = num(p?.y);
    if (x === null || y === null) continue;
    const label = cleanLabel(p.label);
    out.points.push(label ? { x, y, label } : { x, y });
  }
  out.grid = r.grid !== false;
  return out;
}

/** A small graph to start from. */
export const starterPlot = (inline = false) => cleanPlot({
  fns: inline ? [{ expr: "sin(x)", hue: 210 }] : [{ expr: "sin(x)", hue: 210 }, { expr: "x/4", hue: 30 }],
  xmin: -6.28, xmax: 6.28, points: [], grid: true
});

// ---------- expressions ----------
/** "2x" and "3.5x^2" mean 2*x: the one implicit product the formula grammar lacks. */
const prep = (s) => s.replace(/(^|[^\w.])(\d+\.?\d*|\.\d+)\s*(?=x(?![\w.]))/gi, "$1$2*");

/**
 * Compile an expression of x. Returns { ok, error?, f } where f(x) is a finite number or NaN (errors, text, booleans,
 * infinities). f.lastError holds the engine's message for the latest failure.
 */
export function compileExpr(expr, constant) {
  const src = prep(cleanExpr(expr));
  if (!src) return { ok: false, error: "Enter an expression." };
  const chk = check(src);
  if (!chk.ok) return { ok: false, error: chk.error };
  let cur = 0;
  const env = {
    constant: (name) => {
      const n = String(name).toLowerCase();
      if (n === "x") return cur;
      const v = constant?.(name);
      if (v !== undefined) return v;
      if (n === "pi") return Math.PI;
      if (n === "e") return Math.E;
      if (n === "tau") return Math.PI * 2;
      return undefined;
    }
  };
  const f = (x) => {
    cur = x;
    const r = evalExpression(src, env);
    if (r.ok && typeof r.value === "number" && Number.isFinite(r.value)) return r.value;
    f.lastError = r.ok ? "not a number" : r.detail;
    return NaN;
  };
  f.lastError = "";
  return { ok: true, f };
}

// ---------- sampling ----------
const real = (y) => typeof y === "number" && Number.isFinite(y);

/**
 * First pass: n+1 evenly spaced samples. Stops at the deadline (opts.deadline, in opts.now() units) or at maxEvals.
 * Returns { xs, ys, evals, truncated }; ys holds NaN where f has no value.
 */
export function sampleFn(f, xmin, xmax, opts = {}) {
  const n = Math.max(2, Math.min(opts.n ?? SAMPLES, MAX_EVALS));
  const now = opts.now ?? Date.now;
  const deadline = opts.deadline ?? Infinity;
  const maxEvals = opts.maxEvals ?? MAX_EVALS;
  const xs = [];
  const ys = [];
  let evals = 0;
  let truncated = false;
  for (let i = 0; i <= n; i++) {
    if (evals >= maxEvals || ((i & 7) === 0 && now() > deadline)) {
      truncated = true;
      break;
    }
    const x = i === n ? xmax : xmin + (xmax - xmin) * i / n;
    let y = NaN;
    try {
      y = f(x);
    } catch {
      y = NaN;
    }
    evals++;
    xs.push(x);
    ys.push(real(y) ? y : NaN);
  }
  return { xs, ys, evals, truncated };
}

/** The y range to show when none is set: the data, ignoring poles that would flatten everything else. */
export function autoYRange(ysList, points = []) {
  const v = [];
  for (const ys of ysList) for (const y of ys) if (real(y)) v.push(y);
  let lo = Infinity;
  let hi = -Infinity;
  if (v.length) {
    v.sort((a, b) => a - b);
    const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
    lo = v[0];
    hi = v[v.length - 1];
    const p2 = q(0.02);
    const p98 = q(0.98);
    const span = p98 - p2;
    if (lo < p2 - span * 0.5 - 1e-12 || hi > p98 + span * 0.5 + 1e-12) {
      // far outliers (a pole): trust the bulk of the curve
      lo = span > 0 ? p2 - span * 0.1 : p2;
      hi = span > 0 ? p98 + span * 0.1 : p98;
    }
  }
  for (const p of points) {
    lo = Math.min(lo, p.y);
    hi = Math.max(hi, p.y);
  }
  if (!(lo <= hi) || !Number.isFinite(hi - lo)) return [-1, 1];
  if (!(hi > lo)) {
    const pad = Math.max(1, Math.abs(lo) * 0.1);
    return [lo - pad, lo + pad];
  }
  const pad = (hi - lo) * 0.06;
  return [lo - pad, hi + pad];
}

/**
 * Second pass: turn samples into points { x, y, brk } (brk: do not join to the previous point). Finds where a function
 * stops being defined and tells poles and jumps (tan, 1/x) from steep but continuous curves by bisecting, within the
 * remaining evaluation and time budget. View height H decides what counts as a big jump.
 */
export function refineSamples(f, xs, ys, H, opts = {}) {
  const now = opts.now ?? Date.now;
  const deadline = opts.deadline ?? Infinity;
  let left = Math.max(0, (opts.maxEvals ?? MAX_EVALS) - (opts.used ?? 0));
  const call = (x) => {
    left--;
    try {
      const y = f(x);
      return real(y) ? y : NaN;
    } catch {
      return NaN;
    }
  };
  const out = [];
  let brk = true; // the next finite point starts a new run
  let flagged = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const y = ys[i];
    const prevOk = i > 0 && real(ys[i - 1]);
    if (!real(y)) {
      if (prevOk && left > 14 && now() <= deadline) {
        // edge of the domain: the last defined x before the gap
        let lo = xs[i - 1];
        let ylo = ys[i - 1];
        let hi = x;
        for (let k = 0; k < 12 && left > 0; k++) {
          const m = (lo + hi) / 2;
          const ym = call(m);
          if (real(ym)) {
            lo = m;
            ylo = ym;
          } else hi = m;
        }
        if (lo > xs[i - 1]) out.push({ x: lo, y: ylo, brk: false });
      }
      brk = true;
      continue;
    }
    if (!prevOk && i > 0 && left > 14 && now() <= deadline) {
      // the function starts here: the first defined x after the gap
      let lo = xs[i - 1];
      let hi = x;
      let yhi = y;
      for (let k = 0; k < 12 && left > 0; k++) {
        const m = (lo + hi) / 2;
        const ym = call(m);
        if (real(ym)) {
          hi = m;
          yhi = ym;
        } else lo = m;
      }
      if (hi < x) out.push({ x: hi, y: yhi, brk: true });
      out.push({ x, y, brk: false });
      brk = false;
      continue;
    }
    if (prevOk && !brk && Math.abs(y - ys[i - 1]) > H) {
      // a big step between neighbours: pole / jump, or a very steep curve?
      const gap0 = Math.abs(y - ys[i - 1]);
      let jump = true;
      if (flagged < 40 && left > 20 && now() <= deadline) {
        flagged++;
        let lo = xs[i - 1];
        let ylo = ys[i - 1];
        let hi = x;
        let yhi = y;
        let undefinedInside = false;
        for (let k = 0; k < 16 && left > 0; k++) {
          const m = (lo + hi) / 2;
          const ym = call(m);
          if (!real(ym)) {
            undefinedInside = true;
            break;
          }
          if (Math.abs(ym - ylo) > Math.abs(yhi - ym)) {
            hi = m;
            yhi = ym;
          } else {
            lo = m;
            ylo = ym;
          }
        }
        if (!undefinedInside && Math.abs(yhi - ylo) <= gap0 * 0.5) jump = false;
        if (undefinedInside) jump = true;
        if (jump) {
          if (lo > xs[i - 1]) out.push({ x: lo, y: ylo, brk: false });
          out.push({ x: hi, y: yhi, brk: true });
          out.push({ x, y, brk: false });
          brk = false;
          continue;
        }
        out.push({ x: lo, y: ylo, brk: false }, { x: hi, y: yhi, brk: false });
      }
      out.push({ x, y, brk: jump && out.length > 0 });
      brk = false;
      continue;
    }
    out.push({ x, y, brk });
    brk = false;
  }
  return out;
}

// ---------- clipping, ticks, path data ----------
/** Clip the segment (x0,y0)-(x1,y1) to ymin <= y <= ymax. null when outside; else { a, b, ca, cb } (c* = that end was cut). */
export function clipSegment(x0, y0, x1, y1, ymin, ymax) {
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  if (dy === 0) {
    if (y0 < ymin - EPS_OUT || y0 > ymax + EPS_OUT) return null;
  } else {
    const ta = (ymin - y0) / dy;
    const tb = (ymax - y0) / dy;
    const lo = Math.min(ta, tb);
    const hi = Math.max(ta, tb);
    t0 = Math.max(t0, lo);
    t1 = Math.min(t1, hi);
    if (t0 > t1) return null;
  }
  const dx = x1 - x0;
  const clamp = (y) => Math.min(ymax, Math.max(ymin, y));
  return {
    a: { x: x0 + dx * t0, y: clamp(y0 + dy * t0) },
    b: { x: x0 + dx * t1, y: clamp(y0 + dy * t1) },
    ca: t0 > 0,
    cb: t1 < 1
  };
}

/** Split points into runs of connected, in-view data coordinates: [[{x,y}, ...], ...]. */
export function visibleRuns(pts, ymin, ymax) {
  const runs = [];
  let cur = null;
  const open = (p) => {
    cur = [p];
    runs.push(cur);
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!real(p.x) || !real(p.y)) {
      cur = null;
      continue;
    }
    const prev = pts[i - 1];
    if (p.brk || !prev || !real(prev.y) || !real(prev.x)) {
      // a point with no segment to its left: a dot when it is the only one, extended by the segment that follows
      cur = null;
      if (p.y >= ymin && p.y <= ymax) open({ x: p.x, y: p.y });
      continue;
    }
    const c = clipSegment(prev.x, prev.y, p.x, p.y, ymin, ymax);
    if (!c) {
      cur = null;
      continue;
    }
    if (!cur || c.ca) open(c.a);
    cur.push(c.b);
    if (c.cb) cur = null;
  }
  return runs;
}

const r2 = (n) => Math.round(n * 100) / 100;
/** "M..L.." path data for runs mapped through px(x) / py(y); never contains NaN or Infinity. */
export function runsToPath(runs, px, py) {
  let d = "";
  for (const run of runs) {
    let lastX = NaN;
    let lastY = NaN;
    let started = false;
    for (const p of run) {
      const X = r2(px(p.x));
      const Y = r2(py(p.y));
      if (!Number.isFinite(X) || !Number.isFinite(Y)) continue;
      if (started && X === lastX && Y === lastY) continue;
      d += `${started ? "L" : "M"}${X} ${Y}`;
      started = true;
      lastX = X;
      lastY = Y;
    }
    if (started && run.length === 1) d += `h0.01`;
  }
  return d;
}

/** "Nice" tick values covering [min, max], about `target` of them (never more than 60). */
export function niceTicks(min, max, target = 6) {
  if (!real(min) || !real(max) || !(max > min)) return [];
  const range = max - min;
  const raw = range / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  let step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  if (!(step > 0) || !Number.isFinite(step)) return [];
  while (range / step > 60) step *= 2;
  const i0 = Math.ceil(min / step - 1e-9);
  const i1 = Math.floor(max / step + 1e-9);
  const out = [];
  for (let i = i0; i <= i1 && out.length <= 60; i++) out.push(Number((i * step).toPrecision(12)));
  return out;
}

/** The label for a tick value on an axis whose ticks are `step` apart. */
export function tickLabel(v, step) {
  if (!real(v)) return "";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4 || step >= 1e6) return v.toExponential(2).replace(/\.?0+e/, "e").replace("e+", "e");
  const dec = Math.max(0, Math.min(10, -Math.floor(Math.log10(step) + 1e-9)));
  const s = v.toFixed(dec);
  return s === "-0" ? "0" : s;
}
const stepOf = (ticks) => (ticks.length > 1 ? ticks[1] - ticks[0] : 1);

// ---------- model ----------
export const FULL = { w: 420, h: 280, l: 38, r: 12, t: 10, b: 24 };
export const COMPACT = { w: 96, h: 28, l: 2, r: 2, t: 2, b: 2 };

/**
 * Everything the renderer draws, as plain data:
 * { spec, view: {xmin,xmax,ymin,ymax}, box, series: [{ expr, hue, d, error?, truncated }], xticks, yticks (with px / py and
 *   label), axisX (py of y = 0 or null), axisY (px of x = 0 or null), points, errors, text, alt }
 * opts: { constant, compact, now, budgetMs, samples }
 */
export function plotModel(raw, opts = {}) {
  const spec = cleanPlot(raw);
  const box = opts.compact ? COMPACT : FULL;
  const now = opts.now ?? Date.now;
  const start = now();
  const budget = opts.budgetMs ?? BUDGET_MS;
  const nf = Math.max(1, spec.fns.length);
  const sampled = spec.fns.map((fn, i) => {
    const c = compileExpr(fn.expr, opts.constant);
    const deadline = start + budget * (i + 1) / nf;
    if (!c.ok) return { fn, error: c.error, deadline };
    const s = sampleFn(c.f, spec.xmin, spec.xmax, { n: opts.samples ?? SAMPLES, now, deadline });
    return { fn, c, s, deadline };
  });
  let [ymin, ymax] = spec.ymin !== undefined ? [spec.ymin, spec.ymax] : autoYRange(sampled.map((x) => x.s?.ys ?? []), spec.points);
  if (!(ymax > ymin) || !Number.isFinite(ymax - ymin) || ymax - ymin < 1e-300) [ymin, ymax] = [-1, 1];
  const view = { xmin: spec.xmin, xmax: spec.xmax, ymin, ymax };
  const iw = box.w - box.l - box.r;
  const ih = box.h - box.t - box.b;
  const px = (x) => box.l + (x - view.xmin) / (view.xmax - view.xmin) * iw;
  const py = (y) => box.t + (view.ymax - y) / (view.ymax - view.ymin) * ih;
  const H = view.ymax - view.ymin;
  const series = sampled.map((x, i) => {
    const hue = x.fn.hue ?? DEFAULT_HUES[i % DEFAULT_HUES.length];
    const base = { expr: x.fn.expr, hue, d: "" };
    if (x.error) return { ...base, error: x.error };
    const pts = refineSamples(x.c.f, x.s.xs, x.s.ys, H, { now, deadline: x.deadline, used: x.s.evals });
    base.d = runsToPath(visibleRuns(pts, view.ymin, view.ymax), px, py);
    base.truncated = x.s.truncated;
    if (!x.s.ys.some(real)) base.error = x.c.f.lastError || "no value in this range";
    else if (!base.d) base.note = "outside the shown range";
    return base;
  });
  const xt = niceTicks(view.xmin, view.xmax, opts.compact ? 3 : Math.max(3, Math.round(iw / 60)));
  const yt = niceTicks(view.ymin, view.ymax, opts.compact ? 2 : Math.max(3, Math.round(ih / 40)));
  const xs = stepOf(xt);
  const ys = stepOf(yt);
  const points = spec.points.map((p) => ({
    ...p,
    px: r2(px(p.x)),
    py: r2(py(p.y)),
    inView: p.x >= view.xmin && p.x <= view.xmax && p.y >= view.ymin && p.y <= view.ymax
  }));
  const text = spec.fns.map((f) => `y = ${f.expr}`);
  const rng = (a, b) => `${tickLabel(a, xs)} to ${tickLabel(b, xs)}`;
  return {
    spec, view, box, series, points,
    xticks: xt.map((v) => ({ v, px: r2(px(v)), label: tickLabel(v, xs) })),
    yticks: yt.map((v) => ({ v, py: r2(py(v)), label: tickLabel(v, ys) })),
    axisY: view.xmin <= 0 && view.xmax >= 0 ? r2(px(0)) : null,
    axisX: view.ymin <= 0 && view.ymax >= 0 ? r2(py(0)) : null,
    errors: series.map((s, i) => (s.error ? { index: i, message: s.error } : null)).filter(Boolean),
    text,
    alt: `Graph of ${text.length ? text.join(", ") : "no functions"} for x from ${rng(view.xmin, view.xmax)}`
  };
}

// ---------- text form (Markdown export / import) ----------
const fmtNum = (n) => String(Number(n.toPrecision(12)));
const HUE_WORDS = new Map([...PLOT_HUES.map((h, i) => [HUE_NAMES[i].toLowerCase(), h]), ["grey", "grey"]]);
const hueWord = (h) => (h === "grey" ? "grey" : HUE_NAMES[PLOT_HUES.indexOf(h)].toLowerCase());

/** Lines like `# x: -10..10, y: auto, grid: on`, `y = sin(x) @cyan`, `point 1, 2: label`. */
export function serializePlot(raw) {
  const s = cleanPlot(raw);
  const y = s.ymin === undefined ? "auto" : `${fmtNum(s.ymin)}..${fmtNum(s.ymax)}`;
  const lines = [`# x: ${fmtNum(s.xmin)}..${fmtNum(s.xmax)}, y: ${y}, grid: ${s.grid ? "on" : "off"}`];
  for (const f of s.fns) lines.push(`y = ${f.expr}${f.hue === undefined ? "" : ` @${hueWord(f.hue)}`}`);
  for (const p of s.points) lines.push(`point ${fmtNum(p.x)}, ${fmtNum(p.y)}${p.label ? `: ${p.label}` : ""}`);
  return lines.join("\n");
}
export function parsePlot(text) {
  const out = { fns: [], points: [], grid: true };
  const range = (v) => {
    const m = /^\s*(-?[\d.eE+-]+)\s*\.\.\s*(-?[\d.eE+-]+)\s*$/.exec(v);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let m;
    if (t.startsWith("#")) {
      for (const part of t.slice(1).split(/,(?=\s*[xyg]\w*\s*:)/)) {
        const kv = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(part);
        if (!kv) continue;
        if (kv[1] === "x") {
          const r = range(kv[2]);
          if (r) [out.xmin, out.xmax] = r;
        } else if (kv[1] === "y") {
          const r = range(kv[2]);
          if (r) [out.ymin, out.ymax] = r;
        } else if (kv[1] === "grid") out.grid = !/^(off|false|no|0)$/i.test(kv[2]);
      }
    } else if ((m = /^point\s+(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*(?::\s*(.*))?$/i.exec(t))) {
      out.points.push({ x: Number(m[1]), y: Number(m[2]), label: m[3] ?? "" });
    } else {
      const body = t.replace(/^y\s*=\s*/i, "");
      const h = /\s@(grey|[a-z]+|\d+)\s*$/i.exec(body);
      const expr = h ? body.slice(0, h.index) : body;
      const hue = h ? HUE_WORDS.get(h[1].toLowerCase()) ?? snapHue(h[1]) : undefined;
      out.fns.push({ expr, hue });
    }
  }
  return cleanPlot(out);
}

// ---------- inline token argument ----------
/** Compact JSON for {{plot:<json>}}: { f: [[expr, hue?]], x: [min,max], y?: [min,max], p?: [[x,y,label?]], g?: 0 }. null when too long. */
export function plotToArg(raw) {
  const s = cleanPlot(raw);
  const o = { f: s.fns.map((f) => (f.hue === undefined ? [f.expr] : [f.expr, f.hue])), x: [s.xmin, s.xmax] };
  if (s.ymin !== undefined) o.y = [s.ymin, s.ymax];
  if (s.points.length) o.p = s.points.map((p) => (p.label ? [p.x, p.y, p.label] : [p.x, p.y]));
  if (!s.grid) o.g = 0;
  const json = JSON.stringify(o);
  return json.length <= PLOT_ARG_MAX ? json : null;
}
/** The spec in a token argument, or null when it is not a valid plot object. */
export function plotFromArg(str) {
  let o;
  try {
    o = JSON.parse(String(str));
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o) || !Array.isArray(o.f)) return null;
  return cleanPlot({
    fns: o.f.map((f) => (Array.isArray(f) ? { expr: f[0], hue: f[1] } : f)),
    xmin: o.x?.[0], xmax: o.x?.[1], ymin: o.y?.[0], ymax: o.y?.[1],
    points: Array.isArray(o.p) ? o.p.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1], label: p[2] } : null)) : [],
    grid: o.g !== 0
  });
}
const escArg = (a) => String(a).replace(/[\\|}]/g, "\\$&").replace(/\r?\n/g, " ");
/** The token text, or null when the graph is too big for a chip. */
export function plotToken(raw) {
  const arg = plotToArg(raw);
  return arg ? `{{plot:${escArg(arg)}}}` : null;
}
