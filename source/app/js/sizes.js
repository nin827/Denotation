// Sizes for images, table columns and rows (pure, no DOM). Units are px, em and rem only (no %); a bare number is px.
// A stored size is a string like "320px" / "20em", or { const: <repo constant id> } where the page allows constants.
// Inline image tokens keep a size as "" | number+unit | constant name (see blocks/inline.js, kind "img").

export const SIZE_UNITS = ["px", "em", "rem"];
export const EM_PX = 16; // only used to compare a em / rem size with a px range
/** Sane ranges (in px) per use: a value outside is clamped, never rejected. */
export const SIZE_RANGES = {
  image: [8, 4000],
  column: [40, 1600],
  row: [20, 800]
};
const NUM_RE = /^(\d{1,5}(?:\.\d{1,3})?|\.\d{1,3})\s*(px|em|rem)?$/i;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const norm = (s) => String(s ?? "").trim().toLowerCase();
const round = (n) => Math.round(n * 100) / 100;

/** { n, unit } from "320", "320px", "20 em", "1.5rem" or a finite number (px); null when it is not a size. */
export function parseSize(input) {
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? { n: round(input), unit: "px" } : null;
  if (typeof input !== "string") return null;
  const m = NUM_RE.exec(input.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { n: round(n), unit: (m[2] || "px").toLowerCase() };
}
/** "320px" (trailing zeros dropped); "" for anything that is not a parsed size. */
export const formatSize = (sz) => sz && Number.isFinite(sz.n) && SIZE_UNITS.includes(sz.unit) ? `${round(sz.n)}${sz.unit}` : "";
/** A size clamped into [minPx, maxPx] (em / rem compared at 16px per em). */
export function clampSize(sz, [minPx, maxPx] = SIZE_RANGES.image) {
  if (!sz) return null;
  const k = sz.unit === "px" ? 1 : EM_PX;
  const n = Math.min(maxPx / k, Math.max(minPx / k, sz.n));
  return { n: round(n), unit: sz.unit };
}
/** Storage form of a plain size string ("320" -> "320px", clamped); null when it is not a size. */
export function normSize(value, range = SIZE_RANGES.image) {
  const sz = clampSize(parseSize(value), range);
  return sz ? formatSize(sz) : null;
}
/** Storage form of a size that may also be a constant reference: "320px" | { const: id } | null. */
export function normSizeOrConst(value, range = SIZE_RANGES.image) {
  if (isObj(value)) return typeof value.const === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.const) ? { const: value.const } : null;
  return normSize(value, range);
}
/** A list of sizes aligned to `length` entries; entries that are not sizes become null. Returns null when all are empty. */
export function normSizeList(list, length, range) {
  if (!Array.isArray(list)) return null;
  const out = Array.from({ length }, (_, i) => normSize(list[i], range));
  return out.some(Boolean) ? out : null;
}

const findConst = (constants, test) => (Array.isArray(constants) ? constants : []).find((c) => c && test(c)) ?? null;
/** Resolve a constant to a size string. Returns { css, reason }: css is null (with a reason) when it cannot be a size. */
function fromConstant(c, range) {
  if (!c) return { css: null, reason: "Constant not found (deleted, or in another repository)" };
  if (c.type === "date") return { css: null, reason: `Constant "${c.name}" is a date; a size needs a number (px) or text like 20em` };
  const v = c.value;
  if (v === null || v === undefined || v === "") return { css: null, reason: `Constant "${c.name}" is empty` };
  const sz = parseSize(c.type === "number" ? (typeof v === "number" ? v : Number(v)) : String(v));
  if (!sz) return { css: null, reason: `Constant "${c.name}" is not a size (use a number in px, or text like 20em)` };
  return { css: formatSize(clampSize(sz, range)), reason: null };
}
/**
 * Resolve a size value to CSS. `value` is a number, a size string, `{ const: id }`, or (inline images) a constant name.
 * `constants` is the repository's list (constantsOf(repo)). Returns { css, reason }; css null means "auto", with
 * a reason when a value was given but unusable (so the UI can say why).
 */
export function resolveSize(value, constants = [], range = SIZE_RANGES.image) {
  if (value === null || value === undefined || value === "") return { css: null, reason: null };
  if (isObj(value)) {
    if (typeof value.const !== "string") return { css: null, reason: "Not a size" };
    return fromConstant(findConst(constants, (c) => c.id === value.const), range);
  }
  const sz = parseSize(value);
  if (sz) return { css: formatSize(clampSize(sz, range)), reason: null };
  if (typeof value === "string" && NAME_RE.test(value.trim())) {
    const name = norm(value);
    const c = findConst(constants, (k) => norm(k.name) === name);
    return c ? fromConstant(c, range) : { css: null, reason: `No constant named "${value.trim()}"` };
  }
  return { css: null, reason: "Not a size (use a number with px, em or rem)" };
}

/** Text for an edit field: "320px", or the constant's name for a { const } reference ("" when empty). */
export function sizeFieldText(value, constants = []) {
  if (isObj(value)) return findConst(constants, (c) => c.id === value.const)?.name ?? "";
  return typeof value === "string" ? value : "";
}
/**
 * Parse what someone typed into a size field. Accepts a size (bare number = px) and, when `allowConst`, a constant name
 * (stored by id). Returns { value, error }: value is null for an empty field, undefined on error.
 */
export function parseSizeField(text, { constants = [], allowConst = false, range = SIZE_RANGES.image } = {}) {
  const t = String(text ?? "").trim();
  if (!t) return { value: null, error: null };
  const sz = parseSize(t);
  if (sz) return { value: formatSize(clampSize(sz, range)), error: null };
  if (allowConst && NAME_RE.test(t)) {
    const c = findConst(constants, (k) => norm(k.name) === norm(t));
    if (c) return { value: { const: c.id }, error: null };
    return { value: void 0, error: `No constant named "${t}".` };
  }
  return { value: void 0, error: allowConst ? "Enter a size like 320, 20em or 12rem, or a constant name." : "Enter a size like 320, 20em or 12rem." };
}

// ---------- database row height (per view: compact / normal / tall, or a size) ----------
export const ROW_HEIGHT_MODES = ["compact", "normal", "tall"];
/** { mode, css } for a view's `rowHeight`: a preset name, or a size string (mode "custom", css set). Anything else is "normal". */
export function rowHeightInfo(view) {
  const v = view?.rowHeight;
  if (ROW_HEIGHT_MODES.includes(v)) return { mode: v, css: null };
  const s = normSize(v, SIZE_RANGES.row);
  return s ? { mode: "custom", css: s } : { mode: "normal", css: null };
}
/** Class suffix (" rh-tall") and inline style for a table / sheet element ("" when the height is normal). */
export function rowHeightAttrs(view) {
  const { mode, css } = rowHeightInfo(view);
  return { cls: mode === "normal" ? "" : ` rh-${mode}`, style: css ? `--db-rh:${css};` : "" };
}
