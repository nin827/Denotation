import { chartData, CHART_TYPES, dashboardData } from "../dbviews.js";
import { h } from "./dom.js";

const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  el.append(...kids.flat().filter(Boolean));
  return el;
};
const tip = (text) => svg("title", {}, document.createTextNode(text));
const PALETTE = ["blue", "orange", "green", "purple", "pink", "yellow", "red", "brown", "gray"].map((c) => `var(--c-${c})`);
const fmt = (n) => Math.abs(n) >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : Math.abs(n) >= 1e4 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n * 100) / 100);
const clip = (s, n) => s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
function niceScale(max) {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const pow = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => max / s <= 5);
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}
function drawChart(type, data, label) {
  const W = 640;
  const H = 300;
  if (!data.length) return h("div", { class: "view-hint" }, "Nothing to chart yet.");
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img", "aria-label": label });
  if (type === "pie") {
    const total = data.reduce((a, d) => a + Math.max(0, d.value), 0);
    if (!total) return h("div", { class: "view-hint" }, "All values are zero.");
    const cx = 130;
    const cy = H / 2;
    const r = 110;
    let a0 = -Math.PI / 2;
    data.forEach((d, i) => {
      const frac = Math.max(0, d.value) / total;
      if (!frac) return;
      const color = PALETTE[i % PALETTE.length];
      if (frac > 0.9999) {
        root.append(svg("circle", { cx, cy, r, fill: color }, tip(`${d.label}: ${fmt(d.value)}`)));
        return;
      }
      const a1 = a0 + frac * Math.PI * 2;
      const p = (a) => `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
      root.append(svg("path", { d: `M${cx},${cy} L${p(a0)} A${r},${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${p(a1)} Z`, fill: color, stroke: "var(--bg)", "stroke-width": 2 }, tip(`${d.label}: ${fmt(d.value)} (${Math.round(frac * 100)}%)`)));
      a0 = a1;
    });
    data.slice(0, 12).forEach((d, i) => {
      const y2 = 30 + i * 22;
      root.append(
        svg("rect", { x: 290, y: y2 - 10, width: 12, height: 12, rx: 2, fill: PALETTE[i % PALETTE.length] }),
        svg("text", { x: 310, y: y2, class: "chart-txt" }, document.createTextNode(`${clip(d.label, 24)} \xB7 ${fmt(d.value)}`))
      );
    });
    return root;
  }
  const L = 44;
  const R = 12;
  const T = 14;
  const B = 54;
  const pw = W - L - R;
  const ph = H - T - B;
  const { top, ticks } = niceScale(Math.max(0, ...data.map((d) => d.value)));
  const y = (v) => T + ph - Math.max(0, v) / top * ph;
  for (const t of ticks) {
    root.append(
      svg("line", { x1: L, x2: W - R, y1: y(t), y2: y(t), class: "chart-grid" }),
      svg("text", { x: L - 6, y: y(t) + 4, "text-anchor": "end", class: "chart-txt" }, document.createTextNode(fmt(t)))
    );
  }
  const slot = pw / data.length;
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(pw / 70)));
  data.forEach((d, i) => {
    const cx = L + slot * (i + 0.5);
    if (i % labelEvery === 0) {
      root.append(svg("text", { x: cx, y: H - B + 16, "text-anchor": data.length > 6 ? "end" : "middle", class: "chart-txt", transform: data.length > 6 ? `rotate(-30 ${cx} ${H - B + 16})` : null }, document.createTextNode(clip(d.label, 14))));
    }
  });
  if (type === "line") {
    const pts = data.map((d, i) => `${L + slot * (i + 0.5)},${y(d.value)}`);
    root.append(svg("polyline", { points: pts.join(" "), fill: "none", stroke: PALETTE[0], "stroke-width": 2.5 }));
    data.forEach((d, i) => root.append(svg("circle", { cx: L + slot * (i + 0.5), cy: y(d.value), r: 4, fill: PALETTE[0] }, tip(`${d.label}: ${fmt(d.value)}`))));
  } else {
    const bw = Math.min(56, slot * 0.7);
    data.forEach((d, i) => {
      const cx = L + slot * (i + 0.5);
      root.append(
        svg("rect", { x: cx - bw / 2, y: y(d.value), width: bw, height: Math.max(0, T + ph - y(d.value)), rx: 3, fill: PALETTE[0] }, tip(`${d.label}: ${fmt(d.value)}`)),
        svg("text", { x: cx, y: y(d.value) - 4, "text-anchor": "middle", class: "chart-txt chart-val" }, document.createTextNode(fmt(d.value)))
      );
    });
  }
  return root;
}
export function renderChart(a) {
  const chart = a.view.chart ?? {};
  const x = a.db.columns.find((c) => c.id === chart.x);
  if (!x) {
    return h("div", { class: "view-hint" }, h("p", {}, "A chart needs a property for its X axis."), h("p", { class: "hint" }, "Use the Chart button above to pick one."));
  }
  const data = chartData(a.db, chart, a.rows);
  const y = a.db.columns.find((c) => c.id === chart.y);
  const what = chart.agg !== "count" && y ? `${chart.agg} of ${y.name}` : "Row count";
  return h(
    "figure",
    { class: "chart" },
    h("figcaption", {}, `${what} by ${x.name} (${CHART_TYPES.find((t) => t.id === chart.type)?.label ?? "Bar"})`),
    drawChart(chart.type, data, `${what} by ${x.name}`)
  );
}
export function renderDashboard(a) {
  const { tiles, charts } = dashboardData(a.db, a.rows);
  return h(
    "div",
    { class: "dash" },
    h("div", { class: "dash-tiles" }, tiles.map((t) => h("div", { class: "dash-tile" }, h("div", { class: "dash-val" }, fmt(Number(t.value))), h("div", { class: "hint" }, t.label)))),
    charts.length ? h("div", { class: "dash-charts" }, charts.map(({ col, data }) => h("figure", { class: "chart" }, h("figcaption", {}, `Rows by ${col.name}`), drawChart("bar", data, `Rows by ${col.name}`)))) : h("p", { class: "hint" }, "Add a Select or Checkbox property to get charts here.")
  );
}
