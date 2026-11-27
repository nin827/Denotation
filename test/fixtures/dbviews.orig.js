import { summarize } from "../../public/js/schema.js";
import { newId } from "../../public/js/ids.js";

export const VIEW_TYPES = [
  { id: "table", label: "Table", icon: "table" },
  { id: "sheet", label: "Sheet", icon: "sheet" },
  { id: "board", label: "Board", icon: "kanban" },
  { id: "list", label: "List", icon: "list" },
  { id: "gallery", label: "Gallery", icon: "layout-grid" },
  { id: "calendar", label: "Calendar", icon: "calendar" },
  { id: "feed", label: "Feed", icon: "newspaper" },
  { id: "chart", label: "Chart", icon: "chart-column" },
  { id: "dashboard", label: "Dashboard", icon: "layout-dashboard" }
];
export const typeInfo = (id) => VIEW_TYPES.find((t) => t.id === id) ?? VIEW_TYPES[0];
const emptyFilter = () => ({ op: "and", rules: [] });
export function newView(type, db, name) {
  const cols = db.columns;
  const v = { id: newId(), name: name ?? typeInfo(type).label, type, filter: emptyFilter(), sorts: [], groupBy: null, hidden: [] };
  if (type === "board") v.groupBy = (cols.find((c) => c.type === "select") ?? cols.find((c) => c.type === "checkbox"))?.id ?? null;
  if (type === "chart") v.chart = { type: "bar", x: (cols.find((c) => c.type === "select") ?? cols.find((c) => c.type === "checkbox"))?.id ?? null, agg: "count", y: null };
  if (type === "calendar") v.dateCol = cols.find((c) => c.type === "date")?.id ?? null;
  return v;
}
export function ensureViews(db) {
  if (!Array.isArray(db.views) || !db.views.length) db.views = [newView("table", db)];
  const ids = new Set(db.columns.map((c) => c.id));
  for (const v of db.views) {
    v.filter ?? (v.filter = emptyFilter());
    v.filter.rules = (v.filter.rules || []).filter((r) => ids.has(r.col));
    v.sorts = (v.sorts || []).filter((s) => ids.has(s.col));
    v.hidden = (v.hidden || []).filter((id) => ids.has(id));
    if (v.groupBy && !ids.has(v.groupBy)) v.groupBy = null;
    if (v.dateCol && !ids.has(v.dateCol)) v.dateCol = null;
    if (v.chart) {
      if (!ids.has(v.chart.x)) v.chart.x = null;
      if (v.chart.y && !ids.has(v.chart.y)) {
        v.chart.y = null;
        v.chart.agg = "count";
      }
    }
    for (const key of ["calc", "widths", "wrap"]) if (v[key]) {
      for (const k of Object.keys(v[key])) if (!ids.has(k)) delete v[key][k];
    }
  }
  return db.views;
}
const OPS = {
  text: ["contains", "not_contains", "is", "is_not", "starts", "empty", "not_empty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "not_empty"],
  checkbox: ["checked", "unchecked"],
  date: ["is", "before", "after", "empty", "not_empty"],
  select: ["is", "is_not", "empty", "not_empty"],
  array: ["contains", "empty", "not_empty"],
  dictionary: ["contains", "empty", "not_empty"]
};
export const OP_LABEL = {
  contains: "contains",
  not_contains: "does not contain",
  is: "is",
  is_not: "is not",
  starts: "starts with",
  empty: "is empty",
  not_empty: "is not empty",
  eq: "=",
  neq: "\u2260",
  gt: ">",
  gte: "\u2265",
  lt: "<",
  lte: "\u2264",
  checked: "is checked",
  unchecked: "is unchecked",
  before: "is before",
  after: "is after"
};
export const needsValue = (op) => !["empty", "not_empty", "checked", "unchecked"].includes(op);
export const opsFor = (col) => OPS[col.type] ?? OPS.text;
export const isNumeric = (col) => col.type === "number" || col.type === "formula";
export function isEmpty(col, v) {
  if (col.type === "checkbox") return false;
  if (v == null || v === "") return true;
  if (Array.isArray(v)) return v.every((x) => x == null || x === "");
  if (typeof v === "object") return Object.values(v).every((x) => x == null || x === "");
  return false;
}
const low = (v) => String(v ?? "").toLowerCase();
const flat = (v) => Array.isArray(v) ? v.join(" ") : typeof v === "object" && v ? Object.entries(v).map(([k, x]) => `${k} ${x}`).join(" ") : String(v ?? "");
function matchRule(col, value, rule) {
  const { op } = rule;
  const arg = rule.value;
  if (op === "empty") return isEmpty(col, value);
  if (op === "not_empty") return !isEmpty(col, value);
  if (op === "checked") return value === true;
  if (op === "unchecked") return value !== true;
  if (arg === void 0 || arg === null || arg === "") return true;
  switch (col.type) {
    case "number": {
      if (value == null) return op === "neq";
      const a = Number(arg);
      return { eq: value === a, neq: value !== a, gt: value > a, gte: value >= a, lt: value < a, lte: value <= a }[op] ?? true;
    }
    case "date":
      if (!value) return false;
      return { is: value === arg, before: value < arg, after: value > arg }[op] ?? true;
    case "select":
      return op === "is" ? value === arg : op === "is_not" ? value !== arg : true;
    case "array":
    case "dictionary":
      return op === "contains" ? low(flat(value)).includes(low(arg)) : true;
    default: {
      const t = low(value);
      const q = low(arg);
      return { contains: t.includes(q), not_contains: !t.includes(q), is: t === q, is_not: t !== q, starts: t.startsWith(q) }[op] ?? true;
    }
  }
}
function applyFilter(rows, columns, filter) {
  const rules = (filter?.rules || []).filter((r) => columns.some((c) => c.id === r.col) && r.op);
  if (!rules.length) return rows;
  const byId = new Map(columns.map((c) => [c.id, c]));
  const test = (row) => rules.map((r) => matchRule(byId.get(r.col), row.values?.[r.col], r));
  return rows.filter((row) => filter.op === "or" ? test(row).some(Boolean) : test(row).every(Boolean));
}
function compareValues(col, a, b) {
  switch (col.type) {
    case "number":
    case "checkbox":
      return Number(a) - Number(b);
    case "select": {
      const o = col.config?.options || [];
      return o.indexOf(a) - o.indexOf(b);
    }
    case "array":
      return (a?.length ?? 0) - (b?.length ?? 0);
    case "dictionary":
      return Object.keys(a || {}).length - Object.keys(b || {}).length;
    case "formula":
      if (typeof a === "number" && typeof b === "number") return a - b;
    // else fall through to text
    // eslint-disable-next-line no-fallthrough
    default:
      return String(a).localeCompare(String(b), void 0, { numeric: true, sensitivity: "base" });
  }
}
function applySorts(rows, columns, sorts) {
  const keys = (sorts || []).map((s) => ({ col: columns.find((c) => c.id === s.col), dir: s.dir === "desc" ? -1 : 1 })).filter((k) => k.col);
  if (!keys.length) return rows;
  return rows.map((r, i) => [r, i]).sort(([a, ia], [b, ib]) => {
    for (const { col, dir } of keys) {
      const va = a.values?.[col.id];
      const vb = b.values?.[col.id];
      const ea = isEmpty(col, va);
      const eb = isEmpty(col, vb);
      if (ea || eb) {
        if (ea && eb) continue;
        return ea ? 1 : -1;
      }
      const c = compareValues(col, va, vb) * dir;
      if (c) return c;
    }
    return ia - ib;
  }).map(([r]) => r);
}
export const visibleRows = (db, view, rows) => applySorts(applyFilter(rows, db.columns, view.filter), db.columns, view.sorts);
export function groupRows(rows, columns, colId) {
  const col = columns.find((c) => c.id === colId);
  if (!col) return [{ key: "all", label: "", value: void 0, rows }];
  const at = (r) => r.values?.[col.id];
  if (col.type === "checkbox") {
    return [
      { key: "on", label: "Checked", value: true, rows: rows.filter((r) => at(r) === true) },
      { key: "off", label: "Unchecked", value: false, rows: rows.filter((r) => at(r) !== true) }
    ];
  }
  const groups = [];
  const index = new Map();
  const add = (key, label, value) => {
    const g = { key, label, value, rows: [] };
    groups.push(g);
    index.set(key, g);
    return g;
  };
  if (col.type === "select") for (const o of col.config?.options || []) add(`v:${o}`, o, o);
  const none = { key: "none", label: "No value", value: null, rows: [] };
  for (const r of rows) {
    const v = at(r);
    if (isEmpty(col, v)) {
      none.rows.push(r);
      continue;
    }
    const text = col.type === "array" || col.type === "dictionary" ? summarize(col, v) : String(v);
    (index.get(`v:${text}`) ?? add(`v:${text}`, text, col.type === "select" || col.type === "text" ? text : void 0)).rows.push(r);
  }
  if (col.type !== "select") groups.sort((a, b) => a.label.localeCompare(b.label, void 0, { numeric: true }));
  groups.push(none);
  return groups.filter((g) => g.rows.length || col.type === "select" || g === none);
}
export const canMoveBetween = (col) => !!col && ["select", "checkbox", "text"].includes(col.type);
const pad = (n) => String(n).padStart(2, "0");
export const isoDate = (y, m, d) => `${String(y).padStart(4, "0")}-${pad(m + 1)}-${pad(d)}`;
export function monthGrid(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  const start = new Date(Date.UTC(year, month, 1 - first.getUTCDay()));
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(start.getTime() + (w * 7 + d) * 864e5);
      week.push({ iso: isoDate(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()), day: day.getUTCDate(), inMonth: day.getUTCMonth() === month });
    }
    if (w >= 4 && !week.some((x) => x.inMonth)) break;
    weeks.push(week);
  }
  return weeks;
}
export function shiftMonth(year, month, delta) {
  const t = year * 12 + month + delta;
  return { year: Math.floor(t / 12), month: (t % 12 + 12) % 12 };
}
export function rowsByDate(rows, dateColId) {
  const m = new Map();
  for (const r of rows) {
    const d = r.values?.[dateColId];
    if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      if (!m.has(d)) m.set(d, []);
      m.get(d).push(r);
    }
  }
  return m;
}
export function colLetter(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}
export function parseTsv(text) {
  const rows = [[]];
  let cell = "";
  let quoted = false;
  const s = String(text).replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === "	") {
      rows[rows.length - 1].push(cell);
      cell = "";
    } else if (ch === "\n") {
      rows[rows.length - 1].push(cell);
      cell = "";
      rows.push([]);
    } else cell += ch;
  }
  if (cell !== "" || rows[rows.length - 1].length) rows[rows.length - 1].push(cell);
  if (!rows[rows.length - 1].length) rows.pop();
  return rows;
}
export const toTsv = (grid) => grid.map((r) => r.map((c) => /[\t\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join("	")).join("\n");
export const CALCS = [
  { id: "none", label: "None" },
  { id: "count", label: "Count all" },
  { id: "filled", label: "Count filled" },
  { id: "empty", label: "Count empty" },
  { id: "sum", label: "Sum", numeric: true },
  { id: "avg", label: "Average", numeric: true },
  { id: "min", label: "Min", numeric: true },
  { id: "max", label: "Max", numeric: true }
];
export function calculate(col, rows, calc) {
  const vals = rows.map((r) => r.values?.[col.id]);
  const filled = vals.filter((v) => !isEmpty(col, v));
  switch (calc) {
    case "count":
      return rows.length;
    case "filled":
      return col.type === "checkbox" ? vals.filter((v) => v === true).length : filled.length;
    case "empty":
      return col.type === "checkbox" ? vals.filter((v) => v !== true).length : vals.length - filled.length;
    default: {
      if (!isNumeric(col) || !["sum", "avg", "min", "max"].includes(calc)) return null;
      const n = (col.type === "formula" ? filled.filter((v) => typeof v === "number") : filled).map(Number).filter(Number.isFinite);
      if (!n.length) return null;
      const sum = n.reduce((a, b) => a + b, 0);
      const r = { sum, avg: sum / n.length, min: Math.min(...n), max: Math.max(...n) }[calc];
      return Math.round(r * 1e6) / 1e6;
    }
  }
}
export function toText(col, v) {
  if (v == null) return "";
  switch (col.type) {
    case "checkbox":
      return v ? "true" : "false";
    case "array":
      return Array.isArray(v) ? v.map((x) => x ?? "").join(", ") : String(v);
    case "dictionary":
      return v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).length ? JSON.stringify(v) : "" : String(v);
    default:
      return String(v);
  }
}
export function fromText(col, text) {
  const t = String(text ?? "");
  switch (col.type) {
    case "checkbox":
      return /^\s*(true|1|yes|y|x|checked)\s*$/i.test(t);
    case "number":
      return t.trim() === "" ? null : t.trim();
    case "date":
    case "select":
      return t.trim() === "" ? null : t.trim();
    case "array":
      return t.trim() === "" ? [] : t.split(/\s*,\s*/);
    case "dictionary": {
      if (t.trim() === "") return {};
      try {
        return JSON.parse(t);
      } catch {
        return void 0;
      }
    }
    default:
      return t;
  }
}
export const CHART_TYPES = [{ id: "bar", label: "Bar" }, { id: "line", label: "Line" }, { id: "pie", label: "Pie" }];
export const CHART_AGGS = [{ id: "count", label: "Count" }, { id: "sum", label: "Sum" }, { id: "avg", label: "Average" }, { id: "min", label: "Min" }, { id: "max", label: "Max" }];
export function chartData(db, chart, rows) {
  const x = db.columns.find((c) => c.id === chart?.x);
  if (!x) return [];
  const y = db.columns.find((c) => c.id === chart.y && isNumeric(c));
  const agg = y ? chart.agg : "count";
  return groupRows(rows, db.columns, x.id).filter((g) => g.rows.length || x.type === "select" && g.key !== "none").map((g) => ({ label: g.label || "No value", value: agg === "count" || !y ? g.rows.length : calculate(y, g.rows, agg) ?? 0 }));
}
export function dashboardData(db, rows) {
  const tiles = [{ label: "Rows", value: rows.length }];
  for (const c of db.columns) {
    if (isNumeric(c)) {
      for (const [id, label] of [["sum", "Sum"], ["avg", "Average"]]) {
        const v = calculate(c, rows, id);
        if (v !== null) tiles.push({ label: `${label} of ${c.name}`, value: v });
      }
    } else if (c.type === "checkbox") tiles.push({ label: `${c.name} (checked)`, value: calculate(c, rows, "filled") });
  }
  const charts = db.columns.filter((c) => c.type === "select" || c.type === "checkbox").slice(0, 4).map((c) => ({ col: c, data: chartData(db, { x: c.id, agg: "count" }, rows) }));
  return { tiles, charts };
}
const COL_WIDTH = Object.freeze({ min: 60, max: 800, def: 160 });
export const WIDTH_PRESETS = [{ label: "Narrow", px: 100 }, { label: "Medium", px: 160 }, { label: "Wide", px: 260 }, { label: "Extra wide", px: 400 }];
export const clampWidth = (px) => Math.min(COL_WIDTH.max, Math.max(COL_WIDTH.min, Math.round(Number(px)) || COL_WIDTH.def));
export const colWidth = (view, col) => clampWidth(view.widths?.[col.id] ?? COL_WIDTH.def);
export const isWrapped = (view, col) => view.wrap?.[col.id] ?? !!view.wrapAll;
export const freezeCount = (view, cols) => Math.max(0, Math.min(Number(view.freeze) || 0, cols.length));
export function freezeOffsets(view, cols, lead = 0) {
  const n = freezeCount(view, cols);
  const out = [];
  let x = lead;
  for (let i = 0; i < n; i++) {
    out.push(x);
    x += colWidth(view, cols[i]);
  }
  return out;
}
