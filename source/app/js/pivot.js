import { isNumeric, calculate, groupRows } from "./dbviews.js";

export const PIVOT_AGGS = [
  { id: "count", label: "Count" },
  { id: "sum", label: "Sum", numeric: true },
  { id: "avg", label: "Average", numeric: true },
  { id: "min", label: "Min", numeric: true },
  { id: "max", label: "Max", numeric: true }
];
const PIVOT_FIELD_TYPES = ["select", "checkbox", "text", "date", "number", "array", "dictionary"];
export const pivotFields = (columns) => columns.filter((c) => PIVOT_FIELD_TYPES.includes(c.type));
export const pivotValueFields = (columns) => columns.filter(isNumeric);
export function cleanPivot(cfg, columns) {
  const out = { rowBy: null, colBy: null, agg: "count", value: null, ...cfg };
  const ids = new Set(pivotFields(columns).map((c) => c.id));
  if (!ids.has(out.rowBy)) out.rowBy = null;
  if (!ids.has(out.colBy) || out.colBy === out.rowBy) out.colBy = null;
  const val = columns.find((c) => c.id === out.value && isNumeric(c));
  out.value = val ? val.id : null;
  if (!PIVOT_AGGS.some((a) => a.id === out.agg) || out.agg !== "count" && !out.value) out.agg = "count";
  return out;
}
export function pivotTable(columns, rows, config) {
  const cfg = cleanPivot(config, columns);
  if (!cfg.rowBy) return null;
  const val = columns.find((c) => c.id === cfg.value);
  const cell = (rs) => cfg.agg === "count" || !val ? rs.length : calculate(val, rs, cfg.agg);
  const side = groupRows(rows, columns, cfg.rowBy).filter((g) => g.rows.length || g.key !== "none");
  const top = cfg.colBy ? groupRows(rows, columns, cfg.colBy).filter((g) => g.rows.length || g.key !== "none") : [{ key: "all", label: "", rows }];
  const sets = top.map((t) => new Set(t.rows));
  const cells = side.map((s) => top.map((_, j) => cell(s.rows.filter((r) => sets[j].has(r)))));
  return {
    agg: val ? cfg.agg : "count",
    rowLabels: side.map((g) => g.label || "No value"),
    colLabels: cfg.colBy ? top.map((g) => g.label || "No value") : [],
    cells,
    rowTotals: side.map((g) => cell(g.rows)),
    colTotals: top.map((t) => cell(t.rows)),
    total: cell(rows)
  };
}
export const formatCell = (v) => v === null || v === void 0 ? "" : String(v);
