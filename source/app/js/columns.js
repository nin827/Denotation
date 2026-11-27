// Shared column helpers (pure, no DOM): column groups (ticket 011), per-column display (ticket 012) and the
// "Edit columns as JSON" format (ticket 010).
import { COLUMN_TYPES, validateColumn } from "./schema.js";
import { parseType } from "./typespec.js";
import { newId } from "./ids.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---------- display ----------

export const DISPLAY_MODES = ["clip", "wrap", "marquee", "obfuscate", "hide"];
export const DISPLAY_LABEL = { clip: "Clip", wrap: "Wrap", marquee: "Marquee", obfuscate: "Obfuscate", hide: "Hide contents" };
export const DISPLAY_HINT = {
  clip: "One line, cut off at the edge",
  wrap: "Long text wraps onto more lines",
  marquee: "Long text scrolls sideways (still when motion is reduced)",
  obfuscate: "Shows ——— until you open the cell",
  hide: "A narrow, blank column"
};
export const OBFUSCATED = "———";
export const HIDE_WIDTH = 44;
export const isDisplay = (m) => DISPLAY_MODES.includes(m);
/** The column's own display (its default for every view). */
export const columnDisplay = (col) => isDisplay(col?.display) ? col.display : "clip";
/**
 * Display of a column in a view: the view's override, else the legacy per-view wrap flags, else the column's own setting.
 * `view.wrapAll` turns every "clip" column into "wrap".
 */
export function resolveDisplay(view, col) {
  if (!col) return "clip";
  const own = view?.display?.[col.id];
  if (isDisplay(own)) return own;
  const legacy = view?.wrap?.[col.id];
  if (legacy === true) return "wrap";
  if (legacy === false) return columnDisplay(col) === "wrap" ? "clip" : columnDisplay(col);
  const base = columnDisplay(col);
  return base === "clip" && view?.wrapAll ? "wrap" : base;
}
/** Sets (or with null clears) a view's display override for a column; drops the legacy wrap flag for it. */
export function setViewDisplay(view, colId, mode) {
  const next = { ...view.display || {} };
  if (isDisplay(mode)) next[colId] = mode;
  else delete next[colId];
  view.display = next;
  if (view.wrap && colId in view.wrap) {
    view.wrap = { ...view.wrap };
    delete view.wrap[colId];
  }
  return view;
}

// ---------- groups ----------

/**
 * Cleans column groups against the columns: unknown column ids go, a column belongs to one group (first wins),
 * a parentId must name a top-level group (else the group becomes top-level), groups left empty go.
 */
export function cleanGroups(columns, groups) {
  if (!Array.isArray(groups) || !groups.length) return [];
  const ids = new Set((columns || []).map((c) => c.id));
  const seenIds = new Set();
  const list = groups.filter(isObj).map((g) => ({
    id: typeof g.id === "string" && g.id ? g.id : newId(),
    label: String(g.label ?? "").trim() || "Group",
    parentId: typeof g.parentId === "string" && g.parentId ? g.parentId : null,
    colIds: Array.isArray(g.colIds) ? g.colIds.filter((x) => typeof x === "string") : []
  })).filter((g) => !seenIds.has(g.id) && seenIds.add(g.id));
  const byId = new Map(list.map((g) => [g.id, g]));
  for (const g of list) {
    const p = g.parentId && byId.get(g.parentId);
    if (!p || p.parentId || p === g) g.parentId = null;
  }
  // a parent that became a child itself cannot keep children: those move up a level
  for (const g of list) if (g.parentId && byId.get(g.parentId).parentId) g.parentId = null;
  const used = new Set();
  for (const g of list) g.colIds = g.colIds.filter((id) => ids.has(id) && !used.has(id) && used.add(id));
  const hasCols = (g) => g.colIds.length > 0 || list.some((s) => s.parentId === g.id && s.colIds.length);
  const kept = list.filter(hasCols);
  return kept.map((g) => {
    const out = { id: g.id, label: g.label, colIds: g.colIds };
    if (g.parentId && kept.some((p) => p.id === g.parentId)) out.parentId = g.parentId;
    return out;
  });
}
/** Top-level group id of a column, its subgroup id (or null) — from cleaned groups. */
export function groupIndex(groups) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const ofCol = new Map();
  for (const g of groups) for (const id of g.colIds) ofCol.set(id, { top: g.parentId ? byId.get(g.parentId) : g, sub: g.parentId ? g : null });
  return { byId, ofCol };
}
/**
 * Column order with every group's columns side by side. A group's block sits where its first column was; inside it,
 * direct columns and subgroups keep the order of their first column. Stable and idempotent.
 */
export function orderColumns(columns, groups) {
  const gs = cleanGroups(columns, groups);
  if (!gs.length) return columns.slice();
  const { ofCol } = groupIndex(gs);
  const out = [];
  const done = new Set();
  const members = new Map(); // top id -> units [[col...]]
  for (const c of columns) {
    const at = ofCol.get(c.id);
    if (!at) continue;
    if (!members.has(at.top.id)) members.set(at.top.id, { units: [], subs: new Map() });
    const m = members.get(at.top.id);
    if (at.sub) {
      if (!m.subs.has(at.sub.id)) {
        const unit = [];
        m.subs.set(at.sub.id, unit);
        m.units.push(unit);
      }
      m.subs.get(at.sub.id).push(c);
    } else m.units.push([c]);
  }
  for (const c of columns) {
    const at = ofCol.get(c.id);
    if (!at) {
      out.push(c);
      continue;
    }
    if (done.has(at.top.id)) continue;
    done.add(at.top.id);
    for (const unit of members.get(at.top.id).units) out.push(...unit);
  }
  return out;
}
/** { columns, columnGroups } with groups cleaned and columns ordered; what every save of groups goes through. */
export function applyGroups(columns, groups) {
  const columnGroups = cleanGroups(columns, groups);
  return { columns: orderColumns(columns, columnGroups), columnGroups };
}
/** Columns of a group, including its subgroups', in column order. */
export function groupColumns(columns, groups, groupId) {
  const want = new Set();
  for (const g of groups || []) if (g.id === groupId || g.parentId === groupId) g.colIds.forEach((id) => want.add(id));
  return columns.filter((c) => want.has(c.id));
}
/** Adds columns to a group (taking them out of any other group). */
export function addToGroup(groups, groupId, colIds) {
  const move = new Set(colIds);
  return (groups || []).map((g) => g.id === groupId ? { ...g, colIds: [...g.colIds.filter((id) => !move.has(id)), ...colIds] } : { ...g, colIds: g.colIds.filter((id) => !move.has(id)) });
}
export const removeFromGroup = (groups, colIds) => {
  const drop = new Set(colIds);
  return (groups || []).map((g) => ({ ...g, colIds: g.colIds.filter((id) => !drop.has(id)) }));
};
/** A new group holding `colIds` (moved out of other groups), optionally under a top-level parent. */
export function makeGroup(groups, label, colIds, parentId = null) {
  const g = { id: newId(), label: String(label || "").trim() || "Group", colIds: [...colIds] };
  if (parentId) g.parentId = parentId;
  return { groups: [...removeFromGroup(groups, colIds), g], group: g };
}
/** Removes a group; its columns become ungrouped (a top-level group's subgroups go too, their columns ungrouped). */
export const ungroup = (groups, groupId) => (groups || []).filter((g) => g.id !== groupId && g.parentId !== groupId);
export const renameGroup = (groups, groupId, label) => (groups || []).map((g) => g.id === groupId ? { ...g, label: String(label || "").trim() || g.label } : g);

/** Collapsed groups of a view (ids). */
export const collapsedSet = (view) => new Set(Array.isArray(view?.collapsedGroups) ? view.collapsedGroups : []);
export function toggleCollapsed(view, groupId) {
  const s = collapsedSet(view);
  if (s.has(groupId)) s.delete(groupId);
  else s.add(groupId);
  view.collapsedGroups = [...s];
  return view;
}
/** A narrow stand-in column for a collapsed group: it renders as "Label (n)". */
export const stubColumn = (group, n) => ({ id: `group:${group.id}`, name: `${group.label} (${n})`, type: "stub", stub: true, groupId: group.id, count: n });
export const isStub = (col) => !!col?.stub;
/**
 * The columns a table or sheet shows: `cols` (visible, ordered) with each collapsed group's columns replaced by one stub.
 * A collapsed top-level group hides its subgroups too. The first (title) column is never folded away.
 */
export function gridColumns(cols, groups, view) {
  const gs = cleanGroups(cols, groups);
  const shut = collapsedSet(view);
  if (!gs.length || !shut.size) return cols;
  const { ofCol } = groupIndex(gs);
  const out = [];
  const stubbed = new Set();
  cols.forEach((c, i) => {
    const at = ofCol.get(c.id);
    const g = at && (shut.has(at.top.id) ? at.top : at.sub && shut.has(at.sub.id) ? at.sub : null);
    if (!g || i === 0) {
      out.push(c);
      return;
    }
    if (stubbed.has(g.id)) return;
    stubbed.add(g.id);
    const n = cols.filter((x, k) => k > 0 && (ofCol.get(x.id)?.top.id === g.id || ofCol.get(x.id)?.sub?.id === g.id)).length;
    out.push(stubColumn(g, n));
  });
  return out;
}
/**
 * Header rows above the column names for the shown columns (stubs included).
 * Returns [] (no groups shown), [top] or [top, sub]; each row is a list of { group|null, span }.
 * A stub sits under its own group: a collapsed top group spans both rows' cells as that group.
 */
export function headerRows(cols, groups) {
  const real = cols.filter((c) => !c.stub);
  const gs = cleanGroups(real, groups);
  const all = (groups || []).filter((g) => cols.some((c) => c.stub && c.groupId === g.id));
  if (!gs.length && !all.length) return [];
  const byId = new Map((groups || []).map((g) => [g.id, g]));
  const { ofCol } = groupIndex(gs);
  const where = (c) => {
    if (c.stub) {
      const g = byId.get(c.groupId);
      if (!g) return { top: null, sub: null };
      return g.parentId ? { top: byId.get(g.parentId) ?? null, sub: g } : { top: g, sub: null };
    }
    return ofCol.get(c.id) ?? { top: null, sub: null };
  };
  const places = cols.map(where);
  if (!places.some((p) => p.top)) return [];
  const runs = (key) => {
    const out = [];
    places.forEach((p) => {
      const g = p[key];
      const last = out[out.length - 1];
      if (last && last.group === (g ?? null)) last.span++;
      else out.push({ group: g ?? null, span: 1 });
    });
    return out;
  };
  const top = runs("top");
  return places.some((p) => p.sub) ? [top, runs("sub")] : [top];
}
/** Columns grouped for row pages / previews: [{ group|null, sub|null, cols }] in column order, consecutive runs merged. */
export function sectionColumns(columns, groups) {
  const gs = cleanGroups(columns, groups);
  const { ofCol } = groupIndex(gs);
  const out = [];
  for (const c of columns) {
    const at = ofCol.get(c.id) ?? { top: null, sub: null };
    const last = out[out.length - 1];
    if (last && last.group === at.top && last.sub === at.sub) last.cols.push(c);
    else out.push({ group: at.top, sub: at.sub, cols: [c] });
  }
  return out;
}

// ---------- columns as JSON ----------

const COLUMN_FIELDS = new Set(["id", "name", "type", "config", "typeText", "display"]);
const GROUP_FIELDS = new Set(["id", "label", "parentId", "colIds"]);
/** The text shown by "Edit columns as JSON". */
export function columnsToJson(columns, groups) {
  const cols = columns.map((c) => {
    const out = { id: c.id, name: c.name, type: c.type };
    if (c.type === "json") out.typeText = c.typeText ?? "";
    if (c.config && Object.keys(c.config).length) out.config = c.config;
    if (isDisplay(c.display) && c.display !== "clip") out.display = c.display;
    return out;
  });
  return JSON.stringify({ columns: cols, columnGroups: cleanGroups(columns, groups) }, null, 2);
}
function jsonError(text, e) {
  const m = /position (\d+)/.exec(e.message);
  if (!m) return `Not valid JSON: ${e.message}`;
  const pos = Number(m[1]);
  const before = text.slice(0, pos);
  const line = before.split("\n").length;
  const col = pos - before.lastIndexOf("\n");
  return `Not valid JSON at line ${line}, column ${col}: ${e.message.replace(/\s*(in JSON )?at position \d+.*$/, "")}`;
}
/**
 * Parses and validates the columns JSON. Ids are kept (so row values survive); a column without an id gets a new one.
 * Returns { ok: true, columns, columnGroups } (groups cleaned, columns ordered) or { ok: false, error }.
 */
export function parseColumnsJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: jsonError(String(text), e) };
  }
  const err = (error) => ({ ok: false, error });
  if (!isObj(data)) return err('Expected an object like { "columns": [...], "columnGroups": [...] }.');
  for (const k of Object.keys(data)) if (k !== "columns" && k !== "columnGroups") return err(`Unknown top-level field "${k}". Use "columns" and "columnGroups".`);
  if (!Array.isArray(data.columns) || !data.columns.length) return err('"columns" must be a list with at least one column.');
  const columns = [];
  const ids = new Set();
  const names = new Set();
  for (let n = 0; n < data.columns.length; n++) {
    const c = data.columns[n];
    const where = `columns[${n}]${isObj(c) && typeof c.name === "string" ? ` ("${c.name}")` : ""}`;
    if (!isObj(c)) return err(`${where}: expected an object.`);
    for (const k of Object.keys(c)) if (!COLUMN_FIELDS.has(k)) return err(`${where}: unknown field "${k}". Allowed: ${[...COLUMN_FIELDS].join(", ")}.`);
    if (c.id !== undefined && (typeof c.id !== "string" || !c.id.trim())) return err(`${where}: "id" must be a non-empty string (or left out for a new column).`);
    const id = c.id ?? newId();
    if (ids.has(id)) return err(`${where}: the id "${id}" is used twice.`);
    ids.add(id);
    if (typeof c.name !== "string" || !c.name.trim()) return err(`${where}: "name" is required.`);
    const name = c.name.trim();
    if (names.has(name.toLowerCase())) return err(`${where}: another column is already called "${name}".`);
    names.add(name.toLowerCase());
    if (!COLUMN_TYPES.includes(c.type)) return err(`${where}: unknown type ${JSON.stringify(c.type)}. Use one of ${COLUMN_TYPES.join(", ")}.`);
    if (c.config !== undefined && !isObj(c.config)) return err(`${where}: "config" must be an object.`);
    if (c.display !== undefined && !isDisplay(c.display)) return err(`${where}: "display" must be one of ${DISPLAY_MODES.join(", ")}.`);
    if (c.typeText !== undefined && c.type !== "json") return err(`${where}: "typeText" is only for type "json".`);
    if (c.type === "json" && c.typeText !== undefined && typeof c.typeText !== "string") return err(`${where}: "typeText" must be a string.`);
    const col = { id, name, type: c.type, config: c.config ? JSON.parse(JSON.stringify(c.config)) : {} };
    if (c.type === "json") col.typeText = c.typeText ?? "";
    if (c.display !== undefined && c.display !== "clip") col.display = c.display;
    const bad = validateColumn(col);
    if (bad) return err(`${where}: ${bad}.`);
    columns.push(col);
  }
  let groups = [];
  if (data.columnGroups !== undefined) {
    if (!Array.isArray(data.columnGroups)) return err('"columnGroups" must be a list.');
    const gids = new Set();
    const owner = new Map();
    for (let n = 0; n < data.columnGroups.length; n++) {
      const g = data.columnGroups[n];
      const where = `columnGroups[${n}]${isObj(g) && typeof g.label === "string" ? ` ("${g.label}")` : ""}`;
      if (!isObj(g)) return err(`${where}: expected an object.`);
      for (const k of Object.keys(g)) if (!GROUP_FIELDS.has(k)) return err(`${where}: unknown field "${k}". Allowed: ${[...GROUP_FIELDS].join(", ")}.`);
      if (typeof g.label !== "string" || !g.label.trim()) return err(`${where}: "label" is required.`);
      if (g.id !== undefined && (typeof g.id !== "string" || !g.id)) return err(`${where}: "id" must be a non-empty string.`);
      const id = g.id ?? newId();
      if (gids.has(id)) return err(`${where}: the group id "${id}" is used twice.`);
      gids.add(id);
      if (!Array.isArray(g.colIds)) return err(`${where}: "colIds" must be a list of column ids.`);
      for (const cid of g.colIds) {
        if (!ids.has(cid)) return err(`${where}: no column has the id ${JSON.stringify(cid)}.`);
        if (owner.has(cid)) return err(`${where}: column "${columns.find((c) => c.id === cid).name}" is already in group "${owner.get(cid)}".`);
        owner.set(cid, g.label);
      }
      groups.push({ id, label: g.label.trim(), colIds: g.colIds.slice(), ...(g.parentId != null ? { parentId: g.parentId } : {}) });
    }
    for (const g of groups) {
      if (g.parentId === undefined) continue;
      const p = groups.find((x) => x.id === g.parentId);
      if (!p) return err(`Group "${g.label}": no group has the parentId ${JSON.stringify(g.parentId)}.`);
      if (p === g) return err(`Group "${g.label}" cannot be its own parent.`);
      if (p.parentId !== undefined) return err(`Group "${g.label}": groups nest two levels at most, and "${p.label}" is already a subgroup.`);
    }
  }
  return { ok: true, ...applyGroups(columns, groups) };
}
/** Plain-language summary of what a columns-JSON save changes (for the confirm line). */
export function columnsDiff(before, after) {
  const was = new Map(before.map((c) => [c.id, c]));
  const now = new Set(after.map((c) => c.id));
  const added = after.filter((c) => !was.has(c.id)).length;
  const removed = before.filter((c) => !now.has(c.id));
  const retyped = after.filter((c) => was.has(c.id) && was.get(c.id).type !== c.type).length;
  return { added, removed, retyped };
}

/** Type text of a json column, parsed: { ok, spec | error }. */
export const columnType = (col) => parseType(col?.typeText ?? "");
