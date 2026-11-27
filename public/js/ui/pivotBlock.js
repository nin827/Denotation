import { h } from "./dom.js";
import {
  cleanPivot,
  pivotFields,
  pivotValueFields,
  PIVOT_AGGS,
  pivotTable,
  formatCell
} from "../pivot.js";

export function pivotBody(b, inst, a) {
  const { ctx } = inst;
  const locked = ctx.locked;
  const box = h("div", { class: "pivot" });
  const note = (text) => h("div", { class: "hint" }, text);
  const databases = ctx.livePages().filter((p) => p.type === "database");
  const option = (value, label, cur) => h("option", { value, selected: value === (cur ?? "") }, label);
  const field = (label, cur, options, onPick) => h(
    "label",
    { class: "pivot-field" },
    label,
    h("select", { value: cur ?? "", disabled: locked, onChange: (e) => onPick(e.target.value || null) }, options)
  );
  const set = (patch) => {
    Object.assign(b, patch);
    a.save();
    render();
  };
  async function render() {
    const src = b.source ? await ctx.ws.getPage(b.source) : null;
    const data = src?.sourceId ? await ctx.ws.getPage(src.sourceId) : src;
    const usable = data && data.type === "database" && databases.some((p) => p.id === b.source);
    const cfg = usable ? cleanPivot({ rowBy: b.rowBy, colBy: b.colBy, agg: b.agg, value: b.value }, data.columns) : null;
    if (cfg) {
      b.rowBy = cfg.rowBy;
      b.colBy = cfg.colBy;
      b.agg = cfg.agg;
      b.value = cfg.value;
    }
    const controls = h(
      "div",
      { class: "pivot-controls" },
      field(
        "Database",
        b.source,
        [option("", "Choose\u2026", b.source), ...databases.map((p) => option(p.id, p.title || "Untitled", b.source))],
        (v) => set({ source: v, rowBy: null, colBy: null, agg: "count", value: null })
      ),
      cfg ? field("Rows", cfg.rowBy, [option("", "Choose\u2026", cfg.rowBy), ...pivotFields(data.columns).map((c) => option(c.id, c.name, cfg.rowBy))], (v) => set({ rowBy: v })) : null,
      cfg ? field("Columns", cfg.colBy, [option("", "None", cfg.colBy), ...pivotFields(data.columns).filter((c) => c.id !== cfg.rowBy).map((c) => option(c.id, c.name, cfg.colBy))], (v) => set({ colBy: v })) : null,
      cfg ? field("Value", cfg.value, [option("", "Count of rows", cfg.value), ...pivotValueFields(data.columns).map((c) => option(c.id, c.name, cfg.value))], (v) => set({ value: v, agg: v ? cfg.agg === "count" ? "sum" : cfg.agg : "count" })) : null,
      cfg && cfg.value ? field("Calculate", cfg.agg, PIVOT_AGGS.filter((x) => x.id !== "count").map((x) => option(x.id, x.label, cfg.agg)), (v) => set({ agg: v || "sum" })) : null
    );
    let body;
    if (!b.source) body = note("Choose a database to summarize.");
    else if (!usable) body = note("That database is missing or in the trash.");
    else if (!cfg.rowBy) body = note("Choose a field for the rows.");
    else {
      const rows = await ctx.ws.listRows(data.id);
      const t = pivotTable(data.columns, rows, cfg);
      const num = (v, cls) => h("td", { class: cls }, formatCell(v));
      body = h("div", { class: "pivot-wrap" }, h(
        "table",
        { class: "pivot-table" },
        h("thead", {}, h(
          "tr",
          {},
          h("th", {}, ""),
          t.colLabels.length ? t.colLabels.map((l) => h("th", { class: "num" }, l)) : h("th", { class: "num" }, cfg.value ? PIVOT_AGGS.find((x) => x.id === cfg.agg).label : "Count"),
          t.colLabels.length ? h("th", { class: "num total" }, "Total") : null
        )),
        h("tbody", {}, t.rowLabels.map((l, i) => h(
          "tr",
          {},
          h("th", { scope: "row" }, l),
          t.colLabels.length ? t.cells[i].map((v) => num(v, "num")) : num(t.rowTotals[i], "num"),
          t.colLabels.length ? num(t.rowTotals[i], "num total") : null
        ))),
        h("tfoot", {}, h(
          "tr",
          {},
          h("th", {}, "Total"),
          t.colLabels.length ? t.colTotals.map((v) => num(v, "num total")) : null,
          num(t.total, "num total")
        ))
      ));
    }
    box.replaceChildren(...[locked && b.source ? null : controls, body].filter(Boolean));
  }
  let timer = null;
  const stop = ctx.ws.onDataChange?.(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!box.isConnected) return stop?.();
      if (box.contains(document.activeElement) && document.activeElement.tagName === "SELECT") return;
      render().catch(() => {
      });
    }, 250);
  });
  render().catch((e) => box.replaceChildren(h("div", { class: "img-fail" }, e.message)));
  return box;
}
