// Data sources: which databases and table blocks the source pickers offer, and how a plain table block becomes a
// small read-only "virtual database". Pure (no DOM), so Node tests and the MCP server can import it.
//
//  - A database marked `page.dataSource === true` is a data source. Pickers list those first.
//  - A `/table` block marked `block.dataSource === true` with a `block.sourceName` is a read-only table source. Its
//    virtual database id is `tbl-<blockId>` (short enough for the 64-character inline token id limit).
import { walk } from "./blocks/model.js";
import { isHidden, isTrashed } from "./workspace.js";

export const TABLE_PREFIX = "tbl-";
export const NAME_MAX = 80;

export const isTableSourceId = (id) => typeof id === "string" && id.startsWith(TABLE_PREFIX) && id.length > TABLE_PREFIX.length;
export const tableSourceId = (blockId) => `${TABLE_PREFIX}${blockId}`;
export const blockIdOf = (id) => (isTableSourceId(id) ? id.slice(TABLE_PREFIX.length) : null);

/** Marks (or unmarks) a database page as a data source; returns the page. Only databases that are not linked views can be one. */
export function setDataSource(page, on) {
  if (!page || page.type !== "database" || page.sourceId) return page;
  if (on) page.dataSource = true;
  else delete page.dataSource;
  return page;
}

/** The trimmed source name of a table block, "" when it has none. */
export const sourceNameOf = (block) => String(block?.sourceName ?? "").trim().slice(0, NAME_MAX);
/** True for a table block that is marked as a data source and has a name. */
export const isTableSource = (block) => block?.type === "table" && block.dataSource === true && !!sourceNameOf(block);

/**
 * Columns and rows of a table block: the first row holds the column names (blank names become "Column N", repeated
 * names get " 2", " 3"). Column ids are `c0`, `c1`... by position; row ids are `r1`, `r2`... Every column is text.
 * keyIndex is the key column position (default 0, clamped into range).
 */
export function tableData(block) {
  const cells = Array.isArray(block?.cells) && Array.isArray(block.cells[0]) ? block.cells : [[""]];
  const seen = new Map();
  const columns = cells[0].map((raw, i) => {
    let name = String(raw ?? "").trim() || `Column ${i + 1}`;
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    if (n > 1) name = `${name} ${n}`;
    return { id: `c${i}`, name, type: "text", config: {} };
  });
  const rows = cells.slice(1).map((r, i) => ({
    id: `r${i + 1}`,
    values: Object.fromEntries(columns.map((c, j) => [c.id, String(r?.[j] ?? "")]))
  }));
  const k = Number(block?.sourceKey);
  const keyIndex = Number.isInteger(k) && k >= 0 && k < columns.length ? k : 0;
  return { columns, rows, keyIndex };
}

/** The read-only virtual database behind a marked table block of `page`. */
export function tableSourceOf(page, block) {
  const { columns, rows, keyIndex } = tableData(block);
  const id = tableSourceId(block.id);
  return {
    id,
    type: "database",
    virtual: true,
    readOnly: true,
    title: sourceNameOf(block),
    pageId: page.id,
    pageTitle: page.title || "Untitled",
    blockId: block.id,
    columns,
    primaryKey: columns[keyIndex]?.id,
    rows: rows.map((r, i) => ({ ...r, id: `${id}:${r.id}`, dbId: id, createdAt: i, values: r.values })),
    createdAt: page.createdAt ?? 0,
    updatedAt: page.updatedAt ?? 0
  };
}

/** Every marked table block in the given doc pages (pass the live pages), as virtual databases, in page order. */
export function tableSources(pages) {
  const out = [];
  for (const p of pages ?? []) {
    if (!p || p.type !== "doc" || !Array.isArray(p.blocks)) continue;
    walk(p.blocks, (b) => {
      if (isTableSource(b)) out.push(tableSourceOf(p, b));
    });
  }
  return out;
}

/** One virtual table source by its `tbl-` id, or null. */
export const findTableSource = (pages, id) => (isTableSourceId(id) ? tableSources(pages).find((s) => s.id === id) ?? null : null);

/** The label a picker shows: "Table: <name> on <page>" for table sources, the title for databases. */
export const sourceLabel = (p) => (p?.virtual ? `Table: ${p.title} on ${p.pageTitle}` : p?.title || "Untitled");

/**
 * The databases a picker offers, data sources first, then the other databases, then (with `tables`) table sources.
 * Each group keeps the order of `pages`. Trashed and archived pages and sync pages are left out; linked views (databases with a
 * `sourceId`) only appear with `linked: true`, after the others.
 */
export function sourceList(pages, { tables = true, linked = false } = {}) {
  const all = pages ?? [];
  const live = all.filter((p) => p && p.type === "database" && !isHidden(all, p));
  const own = live.filter((p) => !p.sourceId);
  const marked = own.filter((p) => p.dataSource === true);
  const rest = own.filter((p) => p.dataSource !== true);
  return [
    ...marked,
    ...rest,
    ...linked ? live.filter((p) => p.sourceId) : [],
    ...tables ? tableSources(all.filter((p) => !isHidden(all, p))) : []
  ];
}

/**
 * What an id points at, for view blocks and previews. `pages` is every page (trashed ones included).
 * Returns { state: "ok" | "missing" | "trashed", host, data }: `host` is the picked page (a database, a linked view or a
 * virtual table source) and `data` the database that holds the rows (a linked view resolves to its source).
 */
export function resolveSource(pages, id) {
  const all = pages ?? [];
  if (isTableSourceId(id)) {
    const live = all.filter((p) => !isHidden(all, p));
    const t = findTableSource(live, id);
    if (t) return { state: "ok", host: t, data: t };
    const owner = all.find((p) => Array.isArray(p.blocks) && JSON.stringify(p.blocks).includes(`"${blockIdOf(id)}"`));
    return { state: owner && isHidden(all, owner) ? "trashed" : "missing", host: null, data: null };
  }
  const host = all.find((p) => p.id === id && p.type === "database");
  if (!host) return { state: "missing", host: null, data: null };
  if (isHidden(all, host)) return { state: isTrashed(all, host) ? "trashed" : "archived", host, data: null };
  if (!host.sourceId) return { state: "ok", host, data: host };
  const data = all.find((p) => p.id === host.sourceId && p.type === "database");
  if (!data) return { state: "missing", host, data: null };
  return { state: isHidden(all, data) ? "trashed" : "ok", host, data: isHidden(all, data) ? null : data };
}
