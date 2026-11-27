// Automatic callouts: rules on properties that show a callout at the top of a page while they match.
//   page.autoCallouts = [{ id, when: { prop, op, value }, preset, text }]
// Set on a page (its own rules, e.g. copied from a template), a parent page (applies to its sub-pages) or a database
// (applies to its row pages). The nearest rule set wins (own > parent > grandparent; row > database > its parents),
// then every matching rule of that set shows, in order. Generated at render time, never stored as blocks. Pure.
import { newId } from "./ids.js";

export const OPS = [
  { id: "is", label: "is", needsValue: true },
  { id: "is not", label: "is not", needsValue: true },
  { id: "empty", label: "is empty", needsValue: false },
  { id: "not empty", label: "is not empty", needsValue: false },
  { id: "contains", label: "contains", needsValue: true },
  { id: "before", label: "is before", needsValue: true },
  { id: "after", label: "is after", needsValue: true }
];
const OP_IDS = new Set(OPS.map((o) => o.id));
export const RULES_MAX = 30;
const TEXT_MAX = 500;
const ID_RE = /^[A-Za-z0-9-]{1,100}$/;
export const needsValue = (op) => OPS.find((o) => o.id === op)?.needsValue ?? true;

/** Cleans a rules list (drops non-objects, unknown ops become "is", text/prop/value become strings). */
export function cleanRules(list) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r !== "object" || !r.when || typeof r.when !== "object") continue;
    const op = OP_IDS.has(r.when.op) ? r.when.op : "is";
    out.push({
      id: typeof r.id === "string" && ID_RE.test(r.id) ? r.id : newId(),
      when: { prop: String(r.when.prop ?? "").trim().slice(0, 80), op, value: needsValue(op) ? String(r.when.value ?? "").slice(0, TEXT_MAX) : "" },
      preset: typeof r.preset === "string" && /^[a-z0-9-]{1,40}$/.test(r.preset) ? r.preset : "info",
      text: String(r.text ?? "").slice(0, TEXT_MAX)
    });
    if (out.length >= RULES_MAX) break;
  }
  return out;
}
export const newRule = (prop = "", op = "is", value = "", preset = "info", text = "") => cleanRules([{ id: newId(), when: { prop, op, value }, preset, text }])[0];

/**
 * A property map for rule checks: Map(lower-case name -> { type, value, text }).
 * Pass page properties (`page.props`) and/or a title.
 */
export function propMap(props = [], { title = null, titleOf = null } = {}) {
  const m = new Map();
  if (title !== null) m.set("title", { type: "text", value: title, text: String(title) });
  for (const p of props ?? []) {
    const text = p.type === "multi" ? (p.value ?? []).join(", ") : p.type === "page" ? (titleOf?.(p.value) ?? p.value ?? "") : p.value == null ? "" : String(p.value);
    m.set(String(p.name).toLowerCase(), { type: p.type, value: p.value, text });
  }
  return m;
}
/** A property map for a database row: columns by name; `textOf(col, v)` gives the text of composite values. */
export function rowPropMap(columns = [], row, textOf = (c, v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v))) {
  const m = new Map();
  for (const [i, col] of columns.entries()) {
    const v = row?.values?.[col.id];
    const type = ["number", "checkbox", "date", "select"].includes(col.type) ? col.type : "text";
    const entry = { type, value: v, text: type === "checkbox" ? (v ? "Yes" : "No") : textOf(col, v) };
    m.set(String(col.name).toLowerCase(), entry);
    if (i === 0 && !m.has("title")) m.set("title", entry);
  }
  return m;
}

const isoToday = (now) => {
  const d = now instanceof Date ? now : new Date(now ?? Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isEmptyVal = (e) => !e || e.value == null || e.value === "" || e.value === false || (Array.isArray(e.value) && !e.value.length);
const norm = (s) => String(s ?? "").trim().toLowerCase();
const truthy = (s) => /^(true|yes|checked|on|1|x)$/i.test(String(s).trim());

/** True when one rule matches the property map. `today` (Date or ms) resolves "today" in before/after. */
export function ruleMatches(rule, props, { today = Date.now() } = {}) {
  const w = rule?.when;
  if (!w || !w.prop) return false;
  const e = props.get(norm(w.prop));
  switch (w.op) {
    case "empty":
      return isEmptyVal(e);
    case "not empty":
      return !isEmptyVal(e);
    case "is":
    case "is not": {
      const hit = (() => {
        if (!e) return false;
        if (e.type === "checkbox") return !!e.value === truthy(w.value);
        if (Array.isArray(e.value)) return e.value.some((x) => norm(x) === norm(w.value));
        if (e.type === "number" && e.value != null && w.value.trim() !== "" && Number.isFinite(Number(w.value))) return Number(e.value) === Number(w.value);
        return norm(e.text) === norm(w.value);
      })();
      return w.op === "is" ? hit : !hit;
    }
    case "contains":
      if (!e || !norm(w.value)) return false;
      if (Array.isArray(e.value)) return e.value.some((x) => norm(x).includes(norm(w.value)));
      return norm(e.text).includes(norm(w.value));
    case "before":
    case "after": {
      if (!e || isEmptyVal(e)) return false;
      const target = norm(w.value) === "today" ? isoToday(today) : String(w.value).trim();
      const mine = String(e.value).trim();
      if (DATE_RE.test(target) && DATE_RE.test(mine)) return w.op === "before" ? mine < target : mine > target;
      const a = Number(e.value);
      const b = Number(target);
      if (target !== "" && Number.isFinite(a) && Number.isFinite(b)) return w.op === "before" ? a < b : a > b;
      return false;
    }
    default:
      return false;
  }
}

/** The nearest non-empty rule set along `chain` (nearest first: page or row, then its parents). */
export function nearestRules(chain) {
  for (const holder of chain ?? []) {
    const rules = holder?.autoCallouts;
    if (Array.isArray(rules) && rules.length) return { holder, rules };
  }
  return { holder: null, rules: [] };
}
/** Every matching rule of the nearest set, in order: [{ rule, holder }]. */
export function matchingCallouts(chain, props, opts) {
  const { holder, rules } = nearestRules(chain);
  return rules.filter((r) => ruleMatches(r, props, opts)).map((rule) => ({ rule, holder }));
}
