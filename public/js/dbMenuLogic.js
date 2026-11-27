// Pure helpers for the database context menus (kept DOM-free so Node tests can import them).

/** Sets a single sort on a column (replacing others); `dir` is "asc" | "desc". */
export function sortOnly(view, colId, dir) {
  view.sorts = [{ col: colId, dir: dir === "desc" ? "desc" : "asc" }];
  return view;
}
export const sortDir = (view, colId) => (view.sorts || []).find((s) => s.col === colId)?.dir ?? null;
export function clearSort(view, colId) {
  view.sorts = (view.sorts || []).filter((s) => s.col !== colId);
  return view;
}
/** Hides a column in a view. The first column can never be hidden. Returns true if it changed. */
export function hideColumn(view, columns, colId) {
  if (!columns.length || columns[0].id === colId || (view.hidden || []).includes(colId)) return false;
  view.hidden = [...view.hidden || [], colId];
  return true;
}
/** Values and body for a duplicate of `row` (deep copy, so edits never share objects). */
export function duplicatePatch(row) {
  return {
    values: JSON.parse(JSON.stringify(row.values ?? {})),
    blocks: row.blocks ? JSON.parse(JSON.stringify(row.blocks)) : null
  };
}
/** Link to a row that works on GitHub Pages sub-paths. */
export const rowLink = (row, loc = globalThis.location) => `${loc.origin}${loc.pathname}${loc.search}#row-${row.id}`;
