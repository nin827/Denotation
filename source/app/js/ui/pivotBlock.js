import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { setBlockMenu } from "./blockExtras.js";
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
  const databasesNow = () => ctx.livePages().filter((p) => p.type === "database");
  let view = { data: null, cfg: null }; // what the last draw used; the block menu offers its fields
  const set = (patch) => {
    Object.assign(b, patch);
    a.save();
    render();
  };
  /** One setting as a submenu of choices; the current one is marked with a check and the word "current". */
  const choice = (label, icon, cur, options, onPick) => {
    const shown = options.find((o) => o.value === (cur ?? ""));
    return { label, icon: ico(icon), hint: shown?.label ?? null, items: options.map((o) => ({
      label: o.label,
      hint: o.value === (cur ?? "") ? "\u2713 current" : null,
      onSelect: () => onPick(o.value || null)
    })) };
  };
  // the settings that used to sit in a bar above the table now live in the block menu
  setBlockMenu(b, () => {
    if (locked) return [];
    const { data, cfg } = view;
    const items = [
      { header: true, label: "Pivot table" },
      choice("Database", "database", b.source, [{ value: "", label: "Choose\u2026" }, ...databasesNow().map((p) => ({ value: p.id, label: p.title || "Untitled" }))], (v) => set({ source: v, rowBy: null, colBy: null, agg: "count", value: null }))
    ];
    if (!cfg) return items;
    const fields = pivotFields(data.columns);
    items.push(
      choice("Rows", "rows-3", cfg.rowBy, [{ value: "", label: "Choose\u2026" }, ...fields.map((c) => ({ value: c.id, label: c.name }))], (v) => set({ rowBy: v })),
      choice("Columns", "columns-3", cfg.colBy, [{ value: "", label: "None" }, ...fields.filter((c) => c.id !== cfg.rowBy).map((c) => ({ value: c.id, label: c.name }))], (v) => set({ colBy: v })),
      choice("Value", "sigma", cfg.value, [{ value: "", label: "Count of rows" }, ...pivotValueFields(data.columns).map((c) => ({ value: c.id, label: c.name }))], (v) => set({ value: v, agg: v ? cfg.agg === "count" ? "sum" : cfg.agg : "count" }))
    );
    if (cfg.value) items.push(choice("Calculate", "calculator", cfg.agg, PIVOT_AGGS.filter((x) => x.id !== "count").map((x) => ({ value: x.id, label: x.label })), (v) => set({ agg: v || "sum" })));
    return items;
  });
  async function render() {
    const src = b.source ? await ctx.ws.getPage(b.source) : null;
    const data = src?.sourceId ? await ctx.ws.getPage(src.sourceId) : src;
    const usable = data && data.type === "database" && databasesNow().some((p) => p.id === b.source);
    const cfg = usable ? cleanPivot({ rowBy: b.rowBy, colBy: b.colBy, agg: b.agg, value: b.value }, data.columns) : null;
    if (cfg) {
      b.rowBy = cfg.rowBy;
      b.colBy = cfg.colBy;
      b.agg = cfg.agg;
      b.value = cfg.value;
    }
    view = { data: usable ? data : null, cfg };
    let body;
    if (!b.source) body = note(locked ? "No database chosen." : "Choose a database to summarize: open the block menu (the \u2261 handle, or right-click) and pick Database.");
    else if (!usable) body = note("That database is missing or in the trash.");
    else if (!cfg.rowBy) body = note(locked ? "No field chosen for the rows." : "Choose a field for the rows in the block menu (the \u2261 handle, or right-click).");
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
    box.replaceChildren(body);
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
