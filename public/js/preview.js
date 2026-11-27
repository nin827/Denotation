// Record preview: pure logic (key matching, config resolution, column selection, Markdown export).
// No DOM access. The UI lives in ui/recordPreview.js.
import { toText } from "./dbviews.js";
import { summarize } from "./schema.js";
import { formatResult } from "./formula.js";
import { newId } from "./ids.js";

export const WIDTH_MIN = 40;
export const WIDTH_MAX = 800;
export const LABEL_MAX = 60;
export const MAX_KEYS = 100;
export const DEFAULT_COLS = 4;
const LAYOUTS = ["table", "card"];
const ALIGNS = ["left", "right"];

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const clone = (v) => v == null ? v : JSON.parse(JSON.stringify(v));

/** Normalise a key for matching: displayed text, trimmed, case-insensitive. */
export const normKey = (s) => String(s ?? "").trim().toLowerCase();

/** Trim, drop empties and case-insensitive duplicates, keep order. */
export function cleanKeys(list) {
  const out = [];
  const seen = new Set();
  for (const k of Array.isArray(list) ? list : []) {
    const t = String(k ?? "").trim().slice(0, 200);
    const n = normKey(t);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(t);
    if (out.length >= MAX_KEYS) break;
  }
  return out;
}

/** Split typed or pasted text into keys (commas, semicolons, new lines, tabs). */
export const splitKeys = (text) => String(text ?? "").split(/[,;\n\t]+/).map((s) => s.trim()).filter(Boolean);

/** The primary key column: `db.primaryKey` when it names a column, else the first (title) column. */
export function primaryKeyCol(db) {
  const cols = db?.columns ?? [];
  return cols.find((c) => c.id === db?.primaryKey) ?? cols[0] ?? null;
}

/** The key text of a row, as displayed. */
export function rowKey(db, row, col = primaryKeyCol(db)) {
  return col ? toText(col, row?.values?.[col.id]).trim() : "";
}

/**
 * Look keys up in rows. Returns one entry per distinct key, in key order:
 * { key, rows: [row...], missing, duplicate }.
 */
export function matchKeys(db, rows, keys) {
  const col = primaryKeyCol(db);
  const by = new Map();
  for (const r of rows ?? []) {
    const n = normKey(rowKey(db, r, col));
    if (!n) continue;
    if (!by.has(n)) by.set(n, []);
    by.get(n).push(r);
  }
  return cleanKeys(keys).map((key) => {
    const found = by.get(normKey(key)) ?? [];
    return { key, rows: found, missing: found.length === 0, duplicate: found.length > 1 };
  });
}

// ---------- display config ----------

/** Sanitise one column entry; null when it has no usable id. */
function cleanCol(c, known) {
  if (!isObj(c) || typeof c.id !== "string" || (known && !known.has(c.id))) return null;
  const w = Number(c.width);
  const label = typeof c.label === "string" ? c.label.trim().slice(0, LABEL_MAX) : "";
  return {
    id: c.id,
    width: Number.isFinite(w) && w > 0 ? Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(w))) : null,
    wrap: c.wrap === true,
    align: ALIGNS.includes(c.align) ? c.align : null,
    label
  };
}

/**
 * Sanitise a display config { layout, columns: [{ id, width, wrap, align, label }] }.
 * With `columns` (the database's columns) unknown ids are dropped. Never returns an empty column list when the
 * database has columns: it falls back to the first few. layout: "table" | "card" | null (auto).
 */
export function cleanConfig(cfg, columns = null) {
  const known = columns ? new Set(columns.map((c) => c.id)) : null;
  const seen = new Set();
  const cols = [];
  for (const c of isObj(cfg) && Array.isArray(cfg.columns) ? cfg.columns : []) {
    const k = cleanCol(c, known);
    if (!k || seen.has(k.id)) continue;
    seen.add(k.id);
    cols.push(k);
  }
  if (!cols.length && columns) for (const c of columns.slice(0, DEFAULT_COLS)) cols.push(cleanCol({ id: c.id }, known));
  return { layout: LAYOUTS.includes(cfg?.layout) ? cfg.layout : null, columns: cols };
}

export const defaultConfig = (columns) => cleanConfig(null, columns);

/** Columns in display order: shown ones first (in config order), then the hidden remainder. */
export function columnSelection(cfg, columns) {
  const c = cleanConfig(cfg, columns);
  const shown = c.columns.map((x) => ({ ...x, col: columns.find((k) => k.id === x.id), shown: true }));
  const rest = columns.filter((k) => !c.columns.some((x) => x.id === k.id)).map((col) => ({ ...cleanCol({ id: col.id }, null), col, shown: false }));
  return [...shown, ...rest];
}

/** Toggle a column on or off in a config (keeps at least one column). */
export function toggleColumn(cfg, id, on) {
  const cols = cfg.columns.filter((c) => c.id !== id);
  if (on) cols.push(cleanCol({ id }, null));
  if (!cols.length) return cfg;
  return { ...cfg, columns: cols };
}

/** Move a shown column up or down (dir -1 / +1). */
export function moveColumn(cfg, id, dir) {
  const cols = [...cfg.columns];
  const i = cols.findIndex((c) => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cols.length) return cfg;
  [cols[i], cols[j]] = [cols[j], cols[i]];
  return { ...cfg, columns: cols };
}

/** Patch one column's settings (width, wrap, align, label) and re-sanitise. */
export function patchColumn(cfg, id, patch) {
  return { ...cfg, columns: cfg.columns.map((c) => c.id === id ? cleanCol({ ...c, ...patch }, null) : c) };
}

/** Effective alignment: explicit, else numbers right. */
export const alignOf = (entry, col) => entry.align ?? (col?.type === "number" ? "right" : "left");

/** Effective layout: explicit, else card for exactly one key and table otherwise. */
export const layoutOf = (cfg, keyCount) => cfg?.layout ?? (keyCount === 1 ? "card" : "table");

export const labelOf = (entry, col) => entry.label || col?.name || "";

// ---------- presets (stored on the database page as previewPresets) ----------

export function cleanPresets(list, columns = null) {
  const out = [];
  const ids = new Set();
  for (const p of Array.isArray(list) ? list : []) {
    if (!isObj(p) || typeof p.id !== "string" || !p.id || ids.has(p.id)) continue;
    ids.add(p.id);
    const name = typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 80) : "Preset";
    out.push({ id: p.id, name, ...cleanConfig(p, columns) });
  }
  return out;
}

export const newPreset = (name, cfg, columns = null) => ({
  id: newId(),
  name: String(name ?? "").trim().slice(0, 80) || "Preset",
  ...cleanConfig(cfg, columns)
});

/** Is the preset name already used (case-insensitive) by another preset? */
export const presetNameTaken = (presets, name, exceptId = null) => (presets ?? []).some((p) => p.id !== exceptId && normKey(p.name) === normKey(name));

/**
 * Which config a block shows. Order: its preset (if it still exists), else the snapshot taken when the preset was
 * attached (preset deleted), else the block's own config, else the default. `orphan` is true when presetId is set
 * but the preset is gone.
 */
export function resolveConfig(block, db) {
  const columns = db?.columns ?? [];
  const presets = Array.isArray(db?.previewPresets) ? db.previewPresets : [];
  const preset = block?.presetId ? presets.find((p) => p.id === block.presetId) ?? null : null;
  if (preset) return { source: "preset", preset, orphan: false, config: cleanConfig(preset, columns) };
  const orphan = !!block?.presetId;
  if (orphan && isObj(block.snapshot)) return { source: "snapshot", preset: null, orphan, config: cleanConfig(block.snapshot, columns) };
  if (isObj(block?.config)) return { source: "own", preset: null, orphan, config: cleanConfig(block.config, columns) };
  return { source: "default", preset: null, orphan, config: defaultConfig(columns) };
}

/** Number of preview blocks (anywhere in the given block trees) that use a preset of a database. */
export function countPresetUsers(blockLists, presetId) {
  let n = 0;
  const walk = (list) => {
    for (const b of Array.isArray(list) ? list : []) {
      if (b?.type === "preview" && b.presetId === presetId) n++;
      if (b?.children) walk(b.children);
    }
  };
  for (const l of blockLists) walk(l);
  return n;
}

/** Shape-check a block's own props (without knowing the database). */
export function cleanBlock(b) {
  b.dbId = typeof b.dbId === "string" && b.dbId ? b.dbId : null;
  b.keys = cleanKeys(b.keys);
  b.presetId = typeof b.presetId === "string" && b.presetId ? b.presetId : null;
  b.config = isObj(b.config) ? cleanConfig(b.config) : null;
  b.snapshot = isObj(b.snapshot) ? cleanConfig(b.snapshot) : null;
  return b;
}

// ---------- Markdown export ----------

const mdCell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();

/** Text of a value as the preview shows it (formula results use their cached value). */
export function displayText(col, value) {
  if (!col) return "";
  if (col.type === "formula") return formatResult(value);
  if (col.type === "checkbox") return value ? "Yes" : "No";
  if (col.type === "array" || col.type === "dictionary") return summarize(col, value);
  return toText(col, value);
}

/** Markdown for the block, or null when the database is unavailable. */
export function previewMarkdown(block, db, rows) {
  if (!db || db.type !== "database") return null;
  const { config } = resolveConfig(block, db);
  const sel = columnSelection(config, db.columns).filter((s) => s.shown && s.col);
  const matches = matchKeys(db, rows, block.keys);
  const found = matches.flatMap((m) => m.rows);
  const parts = [];
  if (found.length && sel.length) {
    const line = (cells) => `| ${cells.map(mdCell).join(" | ")} |`;
    parts.push([
      line(sel.map((s) => labelOf(s, s.col))),
      `| ${sel.map(() => "---").join(" | ")} |`,
      ...found.map((r) => line(sel.map((s) => displayText(s.col, r.values?.[s.col.id]))))
    ].join("\n"));
  }
  const missing = matches.filter((m) => m.missing).map((m) => m.key);
  if (missing.length) parts.push(`No row with key: ${missing.join(", ")}`);
  return parts.length ? parts.join("\n\n") : null;
}

/** One-line fallback when rows are not available to the exporter. */
export const previewLine = (title, keys) => `Record preview: ${title || "Untitled"} (keys: ${cleanKeys(keys).join(", ") || "none"})`;
