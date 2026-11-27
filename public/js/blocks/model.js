import { newId } from "../ids.js";
import { stripInline } from "./inline.js";
import { cleanBlock as cleanPreviewBlock } from "../preview.js";

const BLOCK_TYPES = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "bullet",
  "numbered",
  "todo",
  "toggle",
  "quote",
  "callout",
  "code",
  "divider",
  "table",
  "columns",
  "column",
  "image",
  "bookmark",
  "toc",
  "breadcrumb",
  "synced",
  "page",
  "pivot",
  "preview"
];
const TEXTY = new Set(["p", "h1", "h2", "h3", "h4", "bullet", "numbered", "todo", "toggle", "quote", "callout"]);
const NESTABLE = new Set(["p", "bullet", "numbered", "todo", "toggle", "quote", "callout"]);
const isHeading = (b) => /^h[1-4]$/.test(b.type);
export const isTexty = (b) => TEXTY.has(b.type);
export const isFoldable = (b) => b.type === "toggle" || isHeading(b) && !!b.fold;
const canNest = (b) => NESTABLE.has(b.type) || isHeading(b) && !!b.fold;
export const hasChildren = (b) => (b.children?.length ?? 0) > 0;
export const COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));
export const TABLE_LIMITS = { maxRows: 100, maxCols: 12 };
export const COLUMN_LIMITS = { min: 2, max: 6 };
export function newBlock(type = "p", props = {}) {
  const { rows, cols, count, ...rest } = props;
  const b = { id: newId(), type, ...rest };
  switch (type) {
    case "todo":
      b.text ?? (b.text = "");
      b.checked ?? (b.checked = false);
      break;
    case "toggle":
      b.text ?? (b.text = "");
      b.open ?? (b.open = true);
      b.children ?? (b.children = []);
      break;
    case "callout":
      b.text ?? (b.text = "");
      b.icon ?? (b.icon = "icon:lightbulb");
      b.bg ?? (b.bg = "gray");
      break;
    case "code":
      b.text ?? (b.text = "");
      b.lang ?? (b.lang = "plain");
      break;
    case "table":
      b.cells = Array.from(
        { length: clampInt(rows ?? 3, 1, TABLE_LIMITS.maxRows) },
        () => Array(clampInt(cols ?? 3, 1, TABLE_LIMITS.maxCols)).fill("")
      );
      b.header ?? (b.header = true);
      b.headerCol ?? (b.headerCol = false);
      break;
    case "columns":
      b.children = Array.from(
        { length: clampInt(count ?? 2, COLUMN_LIMITS.min, COLUMN_LIMITS.max) },
        () => newBlock("column", { children: [newBlock("p")] })
      );
      break;
    case "column":
      b.children ?? (b.children = [newBlock("p")]);
      break;
    case "image":
      b.src ?? (b.src = "");
      b.caption ?? (b.caption = "");
      break;
    case "bookmark":
      b.url ?? (b.url = "");
      b.title ?? (b.title = "");
      break;
    case "pivot":
      b.source ?? (b.source = null);
      b.rowBy ?? (b.rowBy = null);
      b.colBy ?? (b.colBy = null);
      b.agg ?? (b.agg = "count");
      b.value ?? (b.value = null);
      break;
    case "preview":
      b.dbId ?? (b.dbId = null);
      b.keys ?? (b.keys = []);
      b.presetId ?? (b.presetId = null);
      b.config ?? (b.config = null);
      b.snapshot ?? (b.snapshot = null);
      break;
    case "divider":
    case "toc":
    case "breadcrumb":
    case "synced":
    case "page":
      break;
    default:
      b.text ?? (b.text = "");
  }
  if (isHeading(b) && b.fold) b.open ?? (b.open = true);
  return b;
}
function reId(b) {
  b.id = newId();
  (b.children || []).forEach(reId);
}
export function cloneBlock(b) {
  const c = JSON.parse(JSON.stringify(b));
  reId(c);
  return c;
}
export function walk(blocks, fn, depth = 0, parent = null) {
  for (const b of blocks) {
    fn(b, depth, parent, blocks);
    if (b.children?.length) walk(b.children, fn, depth + 1, b);
  }
}
export function find(blocks, id, parent = null) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.id === id) return { block: b, list: blocks, index: i, parent };
    if (b.children?.length) {
      const r = find(b.children, id, b);
      if (r) return r;
    }
  }
  return null;
}
function contains(block, id) {
  return (block.children || []).some((c) => c.id === id || contains(c, id));
}
function tidy(parent) {
  if (parent && parent.children && !parent.children.length) {
    if (parent.type === "column") parent.children.push(newBlock("p"));
    else delete parent.children;
  }
}
const fits = (target, list) => target.type === "column" === list.every((b) => b.type === "column");
export function insertAfter(blocks, id, ...newBlocks) {
  const r = find(blocks, id);
  if (!r || !fits(r.block, newBlocks)) return false;
  r.list.splice(r.index + 1, 0, ...newBlocks);
  return true;
}
export function remove(blocks, id) {
  const r = find(blocks, id);
  if (!r || r.block.type === "column") return null;
  r.list.splice(r.index, 1);
  tidy(r.parent);
  if (!blocks.length) blocks.push(newBlock("p"));
  return r.block;
}
export function indent(blocks, id) {
  const r = find(blocks, id);
  if (!r || r.index === 0) return false;
  const prev = r.list[r.index - 1];
  if (!canNest(prev)) return false;
  r.list.splice(r.index, 1);
  (prev.children ?? (prev.children = [])).push(r.block);
  if (isFoldable(prev)) prev.open = true;
  return true;
}
export function outdent(blocks, id) {
  const r = find(blocks, id);
  if (!r || !r.parent || r.parent.type === "column" || r.block.type === "column") return false;
  const g = find(blocks, r.parent.id);
  r.list.splice(r.index, 1);
  g.list.splice(g.index + 1, 0, r.block);
  tidy(r.parent);
  return true;
}
export function move(blocks, id, targetId, position) {
  var _a;
  if (id === targetId) return false;
  const src = find(blocks, id);
  const dst = find(blocks, targetId);
  if (!src || !dst || contains(src.block, targetId)) return false;
  if (src.block.type === "column") return false;
  if (dst.block.type === "column" && position !== "inside") return false;
  if (position === "inside" && !(canNest(dst.block) || dst.block.type === "column")) return false;
  src.list.splice(src.index, 1);
  tidy(src.parent);
  const d = find(blocks, targetId);
  if (position === "inside") {
    ((_a = d.block).children ?? (_a.children = [])).push(src.block);
    if (isFoldable(d.block)) d.block.open = true;
  } else {
    d.list.splice(d.index + (position === "after" ? 1 : 0), 0, src.block);
  }
  return true;
}
function swap(blocks, id, delta) {
  const r = find(blocks, id);
  const j = r ? r.index + delta : -1;
  if (!r || j < 0 || j >= r.list.length) return false;
  [r.list[r.index], r.list[j]] = [r.list[j], r.list[r.index]];
  return true;
}
export const moveUp = (blocks, id) => swap(blocks, id, -1);
export const moveDown = (blocks, id) => swap(blocks, id, 1);
export function canConvert(block, type) {
  const fromOk = isTexty(block) || block.type === "code";
  const toOk = TEXTY.has(type) || type === "code";
  if (!fromOk || !toOk) return false;
  if (type === "code" && hasChildren(block)) return false;
  return true;
}
export function convert(block, type, props = {}) {
  if (!canConvert(block, type)) return false;
  const keep = { id: block.id, text: block.text ?? "", color: block.color, bg: block.bg, children: block.children };
  for (const k of Object.keys(block)) delete block[k];
  Object.assign(block, newBlock(type, { ...props, text: keep.text }), { id: keep.id });
  if (keep.color) block.color = keep.color;
  if (keep.bg && type !== "callout") block.bg = keep.bg;
  if (keep.children?.length) {
    block.children = keep.children;
    if (isHeading(block)) block.fold = true;
  }
  if (isHeading(block) && block.fold) block.open ?? (block.open = true);
  return true;
}
export function numbering(list) {
  const m = new Map();
  let n = 0;
  for (const b of list) {
    if (b.type === "numbered") {
      n += 1;
      m.set(b.id, n);
    } else n = 0;
  }
  return m;
}
export function tocEntries(blocks) {
  const out = [];
  walk(blocks, (b) => {
    if (isHeading(b)) out.push({ id: b.id, level: Number(b.type[1]), text: stripInline(b.text || "") });
  });
  return out;
}
export function plainText(blocks) {
  const lines = [];
  walk(blocks, (b) => {
    if (isTexty(b)) lines.push(stripInline(b.text || ""));
    else if (b.type === "code") lines.push(b.text || "");
    else if (b.type === "table") lines.push(...b.cells.map((r) => r.join(" ")));
    else if (b.type === "image") lines.push(b.caption || "");
    else if (b.type === "bookmark") lines.push(b.title || b.url || "");
  });
  return lines.filter(Boolean).join("\n");
}
export function tableResize(b, rows, cols) {
  const r = clampInt(rows, 1, TABLE_LIMITS.maxRows);
  const c = clampInt(cols, 1, TABLE_LIMITS.maxCols);
  b.cells = Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_2, j) => b.cells[i]?.[j] ?? ""));
}
export function columnsSetCount(b, count) {
  const n = clampInt(count, COLUMN_LIMITS.min, COLUMN_LIMITS.max);
  while (b.children.length < n) b.children.push(newBlock("column", { children: [newBlock("p")] }));
  if (b.children.length > n) {
    const removed = b.children.splice(n);
    const last = b.children[n - 1];
    for (const col of removed) {
      const real = col.children.filter((c) => !(c.type === "p" && !c.text && !hasChildren(c)));
      last.children.push(...real);
    }
  }
}
export function normalizeBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const clean = (arr) => {
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i];
      if (!b || typeof b !== "object") {
        arr[i] = newBlock("p");
        continue;
      }
      if (!b.id) b.id = newId();
      if (!BLOCK_TYPES.includes(b.type)) b.type = "p";
      if (TEXTY.has(b.type) || b.type === "code") b.text = typeof b.text === "string" ? b.text : "";
      if (b.type === "pivot") {
        for (const k of ["source", "rowBy", "colBy", "value"]) if (typeof b[k] !== "string") b[k] = null;
        if (typeof b.agg !== "string") b.agg = "count";
      }
      if (b.type === "preview") cleanPreviewBlock(b);
      if (b.type === "table") {
        if (!Array.isArray(b.cells) || !b.cells.length || !Array.isArray(b.cells[0])) b.cells = [[""]];
        const w = Math.max(...b.cells.map((r) => Array.isArray(r) ? r.length : 0), 1);
        b.cells = b.cells.map((r) => Array.from({ length: w }, (_, j) => String(r?.[j] ?? "")));
      }
      if (b.type === "columns") {
        b.children = (b.children || []).filter((c) => c?.type === "column");
        while (b.children.length < COLUMN_LIMITS.min) b.children.push(newBlock("column", { children: [newBlock("p")] }));
      }
      if (b.children) {
        if (!Array.isArray(b.children) || !b.children.length && b.type !== "column") delete b.children;
        else clean(b.children);
      }
      if (b.type === "column") {
        b.children ?? (b.children = []);
        if (!b.children.length) b.children.push(newBlock("p"));
      }
    }
  };
  clean(list);
  if (!list.length) list.push(newBlock("p"));
  return list;
}
