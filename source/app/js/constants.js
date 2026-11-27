// Repository constants and status lists (pure, no DOM). Stored on the repository page:
//   constants: [{ id, name, type: "text"|"number"|"date", value, format? }]
//   statuses:  [{ id, label, hue }]
// Tokens {{const:<id>}} and {{status:<id>}} resolve through the page's repository (findRepo).
import { scanTokens } from "./blocks/inline.js";
import { newId } from "./ids.js";

export const CONST_TYPES = ["text", "number", "date"];
export const DATE_STYLES = [["iso", "2029-03-04"], ["short", "4 Mar 2029"], ["long", "Sunday, 4 March 2029"]];
export const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_CONSTANTS = 200;
export const MAX_STATUSES = 30;
export const STATUS_HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
export const DEFAULT_STATUSES = [
  { id: "todo", label: "Todo", hue: 210 },
  { id: "doing", label: "Doing", hue: 60 },
  { id: "done", label: "Done", hue: 150 }
];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const norm = (s) => String(s ?? "").trim().toLowerCase();

export const validName = (s) => NAME_RE.test(String(s ?? "").trim());
export function validDate(s) {
  const m = ISO.exec(String(s));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// ---------- the repository behind a page ----------
const liveRepo = (p) => p?.type === "repo" && !p.trashedAt;
/**
 * The repository a page belongs to: walk the parent chain from `pageId` (a database id also works for its rows).
 * Falls back to the first live repository (synced blocks and loose pages have no chain).
 */
export function findRepo(pages, pageId) {
  const list = Array.isArray(pages) ? pages : [];
  const byId = new Map(list.map((p) => [p.id, p]));
  let p = byId.get(pageId);
  for (let n = 0; p && n < 100; n++, p = byId.get(p.parentId)) if (p.type === "repo") return liveRepo(p) ? p : null;
  return list.find(liveRepo) ?? null;
}

// ---------- constants ----------
function cleanFormat(type, f) {
  if (!isObj(f)) return null;
  if (type === "number") {
    const out = {};
    const d = Number(f.decimals);
    if (f.decimals !== null && f.decimals !== undefined && f.decimals !== "" && Number.isInteger(d) && d >= 0 && d <= 10) out.decimals = d;
    if (f.thousands === true) out.thousands = true;
    return Object.keys(out).length ? out : null;
  }
  if (type === "date") return DATE_STYLES.some(([s]) => s === f.style) && f.style !== "iso" ? { style: f.style } : null;
  return null;
}
/** A value coerced to its type: text -> string, number -> finite number or null, date -> ISO string or "". */
export function coerceValue(type, v) {
  if (type === "number") {
    const n = typeof v === "number" ? v : v === "" || v == null ? NaN : Number(String(v).trim().replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  if (type === "date") return validDate(v) ? String(v) : "";
  return String(v ?? "").slice(0, 500);
}
/** Sanitise a constants list: drops bad ids, bad or duplicate (case-insensitive) names. */
export function cleanConstants(list) {
  const out = [];
  const ids = new Set();
  const names = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    if (!isObj(c) || typeof c.id !== "string" || !ID_RE.test(c.id) || ids.has(c.id)) continue;
    const name = typeof c.name === "string" ? c.name.trim() : "";
    if (!NAME_RE.test(name) || names.has(norm(name))) continue;
    const type = CONST_TYPES.includes(c.type) ? c.type : "text";
    ids.add(c.id);
    names.add(norm(name));
    const next = { id: c.id, name, type, value: coerceValue(type, c.value) };
    const format = cleanFormat(type, c.format);
    if (format) next.format = format;
    out.push(next);
    if (out.length >= MAX_CONSTANTS) break;
  }
  return out;
}
export const nameTaken = (list, name, exceptId = null) => (list ?? []).some((c) => c.id !== exceptId && norm(c.name) === norm(name));
export const newConstant = (name, type = "text", value = null) => cleanConstants([{ id: newId(), name, type, value }])[0] ?? null;
export const constantsOf = (repo) => (Array.isArray(repo?.constants) ? repo.constants : []);
export const constantById = (repo, id) => constantsOf(repo).find((c) => c.id === id) ?? null;
export const constantByName = (repo, name) => constantsOf(repo).find((c) => norm(c.name) === norm(name)) ?? null;

/** The value as the formula engine sees it: number, ISO date string or text; null when empty. */
export function constantValue(c) {
  if (!c) return null;
  if (c.type === "number") return typeof c.value === "number" && Number.isFinite(c.value) ? c.value : null;
  if (c.type === "date") return validDate(c.value) ? c.value : null;
  return typeof c.value === "string" ? c.value : "";
}
/** Display text honouring the format (number decimals / thousands, date style). */
export function formatConstant(c) {
  if (!c) return "";
  const v = constantValue(c);
  if (v === null || v === "") return "";
  if (c.type === "number") {
    const f = c.format ?? {};
    const hasDec = Number.isInteger(f.decimals);
    if (!hasDec && !f.thousands) return String(v);
    return new Intl.NumberFormat("en-US", {
      useGrouping: !!f.thousands,
      minimumFractionDigits: hasDec ? f.decimals : 0,
      maximumFractionDigits: hasDec ? f.decimals : 20
    }).format(v);
  }
  if (c.type === "date") {
    const style = c.format?.style;
    if (style !== "short" && style !== "long") return v;
    const [y, m, d] = v.split("-").map(Number);
    const opts = style === "short" ? { day: "numeric", month: "short", year: "numeric" } : { weekday: "long", day: "numeric", month: "long", year: "numeric" };
    return new Date(y, m - 1, d).toLocaleDateString("en-GB", opts);
  }
  return String(v);
}
/** name -> typed value (undefined when the repo has no such constant). The formula engine's `constant` hook. */
export function constantResolver(repo) {
  const byName = new Map(constantsOf(repo).map((c) => [norm(c.name), c]));
  return (name) => {
    const c = byName.get(norm(name));
    return c ? constantValue(c) : void 0;
  };
}

// ---------- statuses ----------
const hueOf = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? STATUS_HUES.reduce((a, b) => Math.abs(b - ((n % 360) + 360) % 360) < Math.abs(a - ((n % 360) + 360) % 360) ? b : a) : 210;
};
export function cleanStatuses(list) {
  const out = [];
  const ids = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    if (!isObj(s) || typeof s.id !== "string" || !ID_RE.test(s.id) || ids.has(s.id)) continue;
    const label = typeof s.label === "string" ? s.label.trim().slice(0, 40) : "";
    if (!label) continue;
    ids.add(s.id);
    out.push({ id: s.id, label, hue: hueOf(s.hue) });
    if (out.length >= MAX_STATUSES) break;
  }
  return out;
}
/** The repository's statuses; the default list (Todo, Doing, Done) until the repository defines its own. */
export const statusList = (repo) => Array.isArray(repo?.statuses) ? cleanStatuses(repo.statuses) : DEFAULT_STATUSES.map((s) => ({ ...s }));
export const statusById = (repo, id) => statusList(repo).find((s) => s.id === id) ?? null;
export const newStatus = (label, hue = 210) => cleanStatuses([{ id: newId(), label, hue }])[0] ?? null;

// ---------- usage counts ----------
/** Number of {{<kind>:<id>}} tokens (nested blocks included) in the given block trees. */
export function countTokenUsers(blockLists, kind, id) {
  let n = 0;
  const walk = (list) => {
    for (const b of Array.isArray(list) ? list : []) {
      if (typeof b?.text === "string" && b.text.includes("{{")) {
        for (const t of scanTokens(b.text)) if (t.node.kind === kind && t.node.args[0] === id) n++;
      }
      if (b?.children) walk(b.children);
    }
  };
  for (const l of blockLists) walk(l);
  return n;
}
