import { check } from "./formula.js";
import { parseType, specOf, summary as jsonSummary } from "./typespec.js";

export const SCALAR_TYPES = ["text", "number", "checkbox", "date"];
export const COLUMN_TYPES = [...SCALAR_TYPES, "select", "dictionary", "array", "json", "formula"];
/** Columns whose value is structured (edited in a dialog, shown as a summary). */
export const isComposite = (col) => col?.type === "array" || col?.type === "dictionary" || col?.type === "json";
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isLooseScalar = (v) => v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v);
export function defaultScalar(type) {
  switch (type) {
    case "text":
      return "";
    case "number":
      return null;
    case "checkbox":
      return false;
    case "date":
      return null;
    default:
      throw new Error(`Unknown scalar type: ${type}`);
  }
}
function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
export function coerceScalar(type, v) {
  switch (type) {
    case "text":
      return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    case "number": {
      const s = typeof v === "string" ? v.trim() : v;
      if (s === "" || s == null) return null;
      if (typeof s === "boolean") throw new Error("Not a number");
      const n = typeof s === "number" ? s : Number(s);
      if (!Number.isFinite(n)) throw new Error("Not a number");
      return n;
    }
    case "checkbox":
      if (typeof v === "boolean") return v;
      if (v === "true") return true;
      if (v === "false" || v == null || v === "") return false;
      throw new Error("Not a checkbox value");
    case "date":
      if (v === "" || v == null) return null;
      if (typeof v !== "string" || !isValidDate(v)) throw new Error("Date must be YYYY-MM-DD");
      return v;
    default:
      throw new Error(`Unknown scalar type: ${type}`);
  }
}
const safeScalar = (type, v) => {
  try {
    return coerceScalar(type, v);
  } catch {
    return defaultScalar(type);
  }
};
function normalizeDictionary(cfg, value) {
  if (!isPlainObject(value)) throw new Error("Expected an object");
  if (cfg.mode === "strict") {
    const fields = cfg.fields || [];
    const known = new Set(fields.map((f) => f.key));
    for (const k of Object.keys(value)) {
      if (!known.has(k)) throw new Error(`Unknown key "${k}"`);
    }
    const out2 = {};
    for (const f of fields) {
      const raw = f.key in value ? value[f.key] : defaultScalar(f.type);
      try {
        out2[f.key] = coerceScalar(f.type, raw);
      } catch (e) {
        throw new Error(`${f.key}: ${e.message}`);
      }
    }
    return out2;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k.trim() === "") throw new Error("Keys cannot be empty");
    if (!isLooseScalar(v)) throw new Error(`${k}: values must be text, number or checkbox`);
    out[k] = v;
  }
  return out;
}
function normalizeArray(cfg, value) {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  const itemType = cfg.itemType || "text";
  const size = cfg.size ?? null;
  if (size != null && value.length !== size) {
    throw new Error(`Expected exactly ${size} items, got ${value.length}`);
  }
  return value.map((v, i) => {
    try {
      return coerceScalar(itemType, v);
    } catch (e) {
      throw new Error(`Item ${i + 1}: ${e.message}`);
    }
  });
}
function normalize(col, value) {
  const cfg = col.config || {};
  switch (col.type) {
    case "select":
      if (value == null || value === "") return null;
      if (!(cfg.options || []).includes(value)) throw new Error(`"${value}" is not an option`);
      return value;
    case "formula":
      return value === void 0 ? null : value;
    // Custom (JSON): any JSON value is stored as written; mismatches with the type text are flagged, never dropped
    case "json":
      return value === void 0 ? null : value;
    // results are computed, never typed in
    case "dictionary":
      return normalizeDictionary(cfg, value);
    case "array":
      return normalizeArray(cfg, value);
    default:
      return coerceScalar(col.type, value);
  }
}
export function validate(col, value) {
  try {
    return { ok: true, value: normalize(col, value) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
export function defaultValue(col) {
  const cfg = col.config || {};
  switch (col.type) {
    case "select":
    case "formula":
    case "json":
      return null;
    case "dictionary":
      if (cfg.mode === "strict") {
        return Object.fromEntries((cfg.fields || []).map((f) => [f.key, defaultScalar(f.type)]));
      }
      return {};
    case "array": {
      const itemType = cfg.itemType || "text";
      return cfg.size == null ? [] : Array.from({ length: cfg.size }, () => defaultScalar(itemType));
    }
    default:
      return defaultScalar(col.type);
  }
}
export function reconcile(col, value) {
  const r = validate(col, value);
  if (r.ok) return r.value;
  const cfg = col.config || {};
  if (col.type === "array" && Array.isArray(value)) {
    const itemType = cfg.itemType || "text";
    let items = value.map((v) => safeScalar(itemType, v));
    if (cfg.size != null) {
      items = items.slice(0, cfg.size);
      while (items.length < cfg.size) items.push(defaultScalar(itemType));
    }
    return items;
  }
  if (col.type === "dictionary" && isPlainObject(value)) {
    if (cfg.mode === "strict") {
      return Object.fromEntries((cfg.fields || []).map((f) => [
        f.key,
        f.key in value ? safeScalar(f.type, value[f.key]) : defaultScalar(f.type)
      ]));
    }
    return Object.fromEntries(
      Object.entries(value).filter(([k, v]) => k.trim() !== "" && isLooseScalar(v))
    );
  }
  return defaultValue(col);
}
export function validateColumn(col) {
  if (!col.name || !col.name.trim()) return "Column name is required";
  if (!COLUMN_TYPES.includes(col.type)) return `Unknown type "${col.type}"`;
  const cfg = col.config || {};
  if (col.type === "select") {
    const o = cfg.options || [];
    if (o.some((x) => typeof x !== "string" || !x.trim())) return "Options cannot be empty";
    if (new Set(o).size !== o.length) return "Options must be unique";
  }
  if (col.type === "json") {
    if (col.typeText != null && typeof col.typeText !== "string") return "Type must be text";
    const r = parseType(col.typeText ?? "");
    if (!r.ok) return `Type: ${r.error}`;
  }
  if (col.type === "formula") {
    const r = check(cfg.expr ?? "");
    if (!r.ok) return `Formula: ${r.error}`;
  }
  if (col.type === "dictionary") {
    if (!["strict", "loose"].includes(cfg.mode)) return "Choose strict or loose";
    if (cfg.mode === "strict") {
      const f = cfg.fields || [];
      if (!f.length) return "Strict dictionaries need at least one key";
      if (f.some((x) => !x.key || !x.key.trim())) return "Keys cannot be empty";
      if (new Set(f.map((x) => x.key)).size !== f.length) return "Keys must be unique";
      if (f.some((x) => !SCALAR_TYPES.includes(x.type))) return "Invalid key type";
    }
  }
  if (col.type === "array") {
    if (!SCALAR_TYPES.includes(cfg.itemType)) return "Invalid item type";
    if (cfg.size != null && !(Number.isInteger(cfg.size) && cfg.size >= 1 && cfg.size <= 1e3)) {
      return "Size must be a whole number between 1 and 1000";
    }
  }
  return null;
}
const fmt = (v) => v === null || v === void 0 ? "\u2205" : String(v);
const truncate = (s, n) => s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
export function summarize(col, value) {
  if (value == null) return "";
  if (col.type === "json") return jsonSummary(specOf(col.typeText), value, 44);
  if (col.type === "dictionary") {
    if (typeof value !== "object" || Array.isArray(value)) return truncate(String(value), 44);
    const entries = Object.entries(value);
    if (!entries.length) return "";
    return truncate(`{ ${entries.map(([k, v]) => `${k}: ${fmt(v)}`).join(", ")} }`, 44);
  }
  if (col.type === "array") {
    if (!Array.isArray(value)) return truncate(String(value), 44);
    if (!value.length) return "";
    return truncate(`[${value.map(fmt).join(", ")}]`, 44);
  }
  return String(value);
}
export function typeLabel(col) {
  const cfg = col.config || {};
  if (col.type === "dictionary") return `{${cfg.mode === "strict" ? "strict" : "loose"}}`;
  if (col.type === "array") return `${cfg.itemType || "text"}[${cfg.size ?? ""}]`;
  if (col.type === "json") return "json";
  return col.type;
}
export function describe(col) {
  const cfg = col.config || {};
  if (col.type === "dictionary") {
    return cfg.mode === "strict" ? `Dictionary (strict): ${(cfg.fields || []).map((f) => `${f.key}:${f.type}`).join(", ")}` : "Dictionary (loose): any keys";
  }
  if (col.type === "array") {
    return cfg.size == null ? `Array of ${cfg.itemType || "text"}, any length` : `Array of ${cfg.itemType || "text"}, exactly ${cfg.size} items`;
  }
  if (col.type === "formula") return `Formula: ${cfg.expr || ""}`;
  if (col.type === "json") return `Custom (JSON): ${col.typeText || "any"}`;
  if (col.type === "select") return `Select: ${(cfg.options || []).join(", ") || "(no options)"}`;
  return col.type;
}
