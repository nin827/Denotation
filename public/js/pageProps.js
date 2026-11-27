// Page properties: `page.props = [{ id, name, type, value, options? }]` on any page that is not a database row.
// Pure (no DOM): cleaning, text for search / front matter / rules, and row values -> properties (archived row bodies).
import { newId } from "./ids.js";

export const PROP_TYPES = [
  { id: "text", label: "Text", icon: "text-initial" },
  { id: "number", label: "Number", icon: "hash" },
  { id: "date", label: "Date", icon: "calendar" },
  { id: "select", label: "Select", icon: "circle-chevron-down" },
  { id: "multi", label: "Multi-select", icon: "tags" },
  { id: "checkbox", label: "Checkbox", icon: "square-check" },
  { id: "url", label: "URL", icon: "link" },
  { id: "page", label: "Page link", icon: "file-text" }
];
const TYPE_IDS = new Set(PROP_TYPES.map((t) => t.id));
export const PROPS_MAX = 50;
export const NAME_MAX = 80;
const TEXT_MAX = 5000;
const OPTIONS_MAX = 100;
const ID_RE = /^[A-Za-z0-9-]{1,100}$/;
export const typeLabel = (type) => PROP_TYPES.find((t) => t.id === type)?.label ?? "Text";
export const hasOptions = (type) => type === "select" || type === "multi";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isDate(s) {
  const m = DATE_RE.exec(String(s ?? ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
/** Only http(s), mailto and relative links are kept as links. */
export function safeUrl(s) {
  const v = String(s ?? "").trim();
  if (!v) return "";
  if (/^(https?:|mailto:)/i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return "";
  return v;
}
const cleanOptions = (list) => {
  const out = [];
  for (const o of Array.isArray(list) ? list : []) {
    const s = String(o ?? "").trim().slice(0, NAME_MAX);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= OPTIONS_MAX) break;
  }
  return out;
};
export const defaultFor = (type) => (type === "checkbox" ? false : type === "multi" ? [] : type === "number" || type === "date" || type === "select" || type === "page" ? null : "");

/** A value cleaned for its type; never throws (bad values become the type's empty value). */
export function cleanValue(type, v, options = []) {
  switch (type) {
    case "number": {
      if (v === "" || v == null) return null;
      const n = typeof v === "number" ? v : Number(String(v).trim());
      return Number.isFinite(n) ? n : null;
    }
    case "checkbox":
      return v === true || v === "true" || v === 1 || v === "yes";
    case "date":
      return isDate(v) ? String(v) : null;
    case "select": {
      const s = v == null ? "" : String(v).trim();
      return s && options.includes(s) ? s : null;
    }
    case "multi": {
      const list = Array.isArray(v) ? v : v == null || v === "" ? [] : [v];
      return cleanOptions(list).filter((x) => options.includes(x));
    }
    case "url":
      return safeUrl(v).slice(0, TEXT_MAX);
    case "page":
      return typeof v === "string" && ID_RE.test(v) ? v : null;
    default:
      return v == null ? "" : String(typeof v === "object" ? JSON.stringify(v) : v).slice(0, TEXT_MAX);
  }
}
/** One property cleaned (or null if it is not an object). */
export function cleanProp(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const type = TYPE_IDS.has(p.type) ? p.type : "text";
  const out = { id: typeof p.id === "string" && ID_RE.test(p.id) ? p.id : newId(), name: String(p.name ?? "").trim().slice(0, NAME_MAX) || "Property", type };
  if (hasOptions(type)) out.options = cleanOptions(p.options);
  if (hasOptions(type)) {
    // values typed before the option existed are added as options, so nothing is dropped
    const vals = type === "multi" ? (Array.isArray(p.value) ? p.value : p.value ? [p.value] : []) : p.value ? [p.value] : [];
    for (const v of vals) {
      const s = String(v ?? "").trim().slice(0, NAME_MAX);
      if (s && !out.options.includes(s) && out.options.length < OPTIONS_MAX) out.options.push(s);
    }
  }
  out.value = cleanValue(type, p.value, out.options);
  return out;
}
/** A whole props list cleaned: objects only, unique ids, at most PROPS_MAX. Returns [] for anything else. */
export function cleanProps(list) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(list) ? list : []) {
    const c = cleanProp(p);
    if (!c) continue;
    if (seen.has(c.id)) c.id = newId();
    seen.add(c.id);
    out.push(c);
    if (out.length >= PROPS_MAX) break;
  }
  return out;
}
export const newProp = (name, type = "text", options = []) => cleanProp({ id: newId(), name, type, options, value: defaultFor(type) });

/** Converts a property to another type, keeping what still fits (text <-> select options etc.). */
export function convertProp(p, type) {
  const prev = propText(p);
  const next = { ...p, type };
  if (hasOptions(type)) {
    const vals = Array.isArray(p.value) ? p.value : prev ? prev.split(/,\s*/) : [];
    next.options = cleanOptions([...(p.options ?? []), ...vals]);
    next.value = type === "multi" ? vals : vals[0] ?? null;
  } else {
    delete next.options;
    next.value = type === "checkbox" ? p.value === true || /^(true|yes|1)$/i.test(prev) : type === "page" ? p.value : prev;
  }
  return cleanProp(next);
}

/** Plain text of a value (search, rules, front matter). `titleOf(id)` names page links. */
export function propText(p, titleOf = null) {
  const v = p?.value;
  if (v == null) return "";
  switch (p.type) {
    case "checkbox":
      return v ? "Yes" : "No";
    case "multi":
      return Array.isArray(v) ? v.join(", ") : "";
    case "page":
      return titleOf ? titleOf(v) || "" : String(v);
    default:
      return String(v);
  }
}
/** All property names and values as one string for search. */
export const propsSearchText = (props, titleOf = null) => (Array.isArray(props) ? props.map((p) => `${p.name}: ${propText(p, titleOf)}`).join("\n") : "");

/**
 * Database row values as page properties (used when a row body becomes an archive page). `textOf(col, v)` turns a
 * value the property types cannot hold (arrays, dictionaries, JSON, formulas) into text. The title column is skipped.
 */
export function propsFromRow(columns, row, textOf = (c, v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v))) {
  const out = [];
  for (const [i, col] of (columns ?? []).entries()) {
    if (i === 0) continue;
    const v = row?.values?.[col.id];
    let p;
    if (["text", "number", "checkbox", "date"].includes(col.type)) p = { name: col.name, type: col.type, value: v };
    else if (col.type === "select") p = { name: col.name, type: "select", options: col.config?.options ?? [], value: v };
    else p = { name: col.name, type: "text", value: textOf(col, v) };
    out.push(cleanProp(p));
  }
  return out.slice(0, PROPS_MAX);
}
/** Values for a new row from template properties, matched to columns by name (case-insensitive). Title column included. */
export function valuesFromProps(columns, props) {
  const byName = new Map((props ?? []).map((p) => [p.name.toLowerCase(), p]));
  const out = {};
  for (const col of columns ?? []) {
    const p = byName.get(String(col.name).toLowerCase());
    if (!p || col.type === "formula") continue;
    out[col.id] = col.type === "select" || col.type === "text" || col.type === "number" || col.type === "checkbox" || col.type === "date" ? p.value : null;
    if (col.type === "text") out[col.id] = propText(p);
  }
  return out;
}

const yamlString = (s) => (/^[\w][\w .,/@()+-]*$/.test(s) && !/^(true|false|null|yes|no|~|-?\d[\d.e+-]*)$/i.test(s) && !/[:#]\s|\s$/.test(s) ? s : JSON.stringify(s));
const yamlKey = (s) => (/^[A-Za-z_][\w -]*$/.test(s) && !/\s$/.test(s) ? s : JSON.stringify(s));
/** YAML front-matter lines (without the --- fences) for a title and its properties. */
export function frontMatter(title, props, titleOf = null) {
  const lines = [`title: ${JSON.stringify(String(title ?? ""))}`];
  for (const p of Array.isArray(props) ? props : []) {
    if (p.name.toLowerCase() === "title") continue;
    const v = p.value;
    let out;
    if (p.type === "multi") out = Array.isArray(v) && v.length ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : "[]";
    else if (p.type === "checkbox") out = v ? "true" : "false";
    else if (p.type === "number") out = v == null ? "" : String(v);
    else if (v == null || v === "") out = "";
    else out = yamlString(propText(p, titleOf));
    lines.push(`${yamlKey(p.name)}:${out === "" ? "" : ` ${out}`}`);
  }
  return lines.join("\n");
}
/** Reads simple `key: value` front-matter lines back as properties (title skipped). Types are guessed. */
export function propsFromFrontMatter(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^("(?:[^"\\]|\\.)*"|[A-Za-z_][\w -]*?)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let name = m[1];
    if (name.startsWith('"')) {
      try {
        name = JSON.parse(name);
      } catch {
        continue;
      }
    }
    if (name.toLowerCase() === "title") continue;
    let raw = m[2].trim();
    let p;
    const unq = (s) => {
      if (/^".*"$/.test(s)) {
        try {
          return JSON.parse(s);
        } catch {
          return s.slice(1, -1);
        }
      }
      return /^'.*'$/.test(s) ? s.slice(1, -1).replace(/''/g, "'") : s;
    };
    if (/^\[.*\]$/.test(raw)) {
      const items = raw.slice(1, -1).split(",").map((s) => unq(s.trim())).filter(Boolean);
      p = { name, type: "multi", options: items, value: items };
    } else if (/^(true|false)$/i.test(raw)) p = { name, type: "checkbox", value: /^true$/i.test(raw) };
    else if (/^-?\d+(\.\d+)?$/.test(raw)) p = { name, type: "number", value: Number(raw) };
    else {
      raw = unq(raw);
      if (isDate(raw)) p = { name, type: "date", value: raw };
      else if (/^https?:\/\//i.test(raw)) p = { name, type: "url", value: raw };
      else p = { name, type: "text", value: raw };
    }
    out.push(cleanProp(p));
    if (out.length >= PROPS_MAX) break;
  }
  return out;
}
