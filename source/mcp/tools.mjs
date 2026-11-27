// Denotation MCP tools. Every call takes a fresh snapshot of the folder and permissions.json, checks
// the permission for the action, and only returns what `read` allows (titles of pages the assistant
// cannot read are never included).
import crypto from "node:crypto";
import { makeResolver } from "../app/js/permissions.js";
import { isTrashed, isArchived, descendantIds } from "../app/js/workspace.js";
import { blocksToMarkdown, markdownToBlocks } from "../app/js/blocks/markdown.js";
import { newBlock, plainText, walk } from "../app/js/blocks/model.js";
import { validate, defaultValue } from "../app/js/schema.js";
import { applyFormulas } from "../app/js/formula.js";
import { toText } from "../app/js/dbviews.js";
import { ID_RE } from "./folder-store.mjs";

export class ToolError extends Error {}
const fail = (msg) => {
  throw new ToolError(msg);
};

const TITLE_MAX = 500;
const MD_MAX = 200 * 1024;
const NEW_COL_TYPES = ["text", "number", "checkbox", "date", "select"];
const newId = () => crypto.randomUUID();
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// ---------- argument checks ----------
const str = (args, key, { required = false, max = TITLE_MAX } = {}) => {
  const v = args?.[key];
  if (v == null) {
    if (required) fail(`Missing "${key}".`);
    return undefined;
  }
  if (typeof v !== "string") fail(`"${key}" must be a string.`);
  if (v.length > max) fail(`"${key}" is too long (max ${max} characters).`);
  return v;
};
const id = (args, key, opts = {}) => {
  const v = str(args, key, { ...opts, max: 100 });
  if (v !== undefined && !ID_RE.test(v)) fail(`"${key}" is not a valid Denotation id.`);
  return v;
};
const int = (args, key, def, lo, hi) => {
  const v = args?.[key];
  if (v == null) return def;
  if (!Number.isInteger(v) || v < lo || v > hi) fail(`"${key}" must be a whole number from ${lo} to ${hi}.`);
  return v;
};
const md = (args, key) => str(args, key, { max: MD_MAX });
const bool = (args, key) => {
  const v = args?.[key];
  if (v == null) return false;
  if (typeof v !== "boolean") fail(`"${key}" must be true or false.`);
  return v;
};

// ---------- snapshot ----------
async function snapshot(store) {
  const [{ pages, rows }, perms] = await Promise.all([store.load(), store.readPermissions()]);
  const pageMap = new Map(pages.map((p) => [p.id, p]));
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const can = makeResolver(perms, pageMap, rowMap);
  const livePage = (p) => !!p && p.type !== "sync" && !isTrashed(pages, p);
  const liveRow = (r) => !!r && livePage(pageMap.get(r.dbId)) && pageMap.get(r.dbId).type === "database";
  const isLive = (x) => (pageMap.has(x) ? livePage(pageMap.get(x)) : liveRow(rowMap.get(x)));
  const allowed = (x, action) => can(x, action).allowed;
  const readable = (x) => isLive(x) && allowed(x, "read");
  const rowTitle = (r) => {
    const db = pageMap.get(r.dbId);
    const col = db?.columns?.[0];
    return col ? toText(col, r.values?.[col.id]).trim() || "Untitled" : "Untitled";
  };
  const titleOf = (x) => (pageMap.has(x) ? pageMap.get(x).title || "Untitled" : rowMap.has(x) ? rowTitle(rowMap.get(x)) : "Untitled");
  // Never reveal the title of something the assistant cannot read.
  const label = (x) => (readable(x) ? `"${titleOf(x)}"` : `${rowMap.has(x) && !pageMap.has(x) ? "row" : "page"} ${x}`);
  const need = (x, action) => {
    if (!allowed(x, action)) fail(`Denotation: permission denied: ${action} on ${x ? label(x) : "the workspace"}`);
  };
  const rowsOf = (dbId) => rows.filter((r) => r.dbId === dbId);
  const archived = (p) => !!p && isArchived(pages, p);
  return { pages, rows, pageMap, rowMap, perms, can, allowed, readable, isLive, livePage, label, need, titleOf, rowTitle, rowsOf, archived };
}

const mdCtx = (s) => ({
  pageTitle: (ref) => (s.readable(ref) ? s.titleOf(ref) : "(no access)"),
  syncBlocks: (ref) => {
    const p = s.pageMap.get(ref);
    return p && !p.trashedAt && s.allowed(ref, "read") ? (p.blocks ?? []).filter((b) => b.type !== "synced") : [];
  },
  // Embedded images are large data URLs: show a short reference that update_page/update_row map back.
  imageSrc: (b) => (String(b.src ?? "").startsWith("data:") ? `embedded:${b.id}` : b.src || "")
});
const toMd = (s, blocks) => blocksToMarkdown(blocks ?? [], mdCtx(s)).trim();
/** Markdown -> blocks; `![..](embedded:<blockId>)` lines get the image of that block in `old` back. */
const blocksFrom = (text, old = []) => {
  const images = new Map();
  walk(old, (b) => {
    if (b.type === "image" && String(b.src ?? "").startsWith("data:")) images.set(b.id, b.src);
  });
  const src = String(text ?? "").replace(/\(embedded:([A-Za-z0-9-]{1,100})\)/g, (m, ref) => (images.has(ref) ? `(${images.get(ref)})` : "(embedded-image)"));
  const blocks = src.trim() ? markdownToBlocks(src) : [];
  return blocks.length ? blocks : [newBlock("p")];
};
const json = (v) => JSON.stringify(v, null, 2);

function columnKeyMap(columns) {
  const counts = new Map();
  for (const c of columns) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  return new Map(columns.map((c) => [c.id, counts.get(c.name) > 1 ? `${c.name} (${c.id})` : c.name]));
}
const describeColumn = (c) => ({ id: c.id, name: c.name, type: c.type, ...(c.type === "select" ? { options: c.config?.options ?? [] } : {}) });

/** Turn { "<column name or id>": value } into clean values for `db`. */
function cleanValues(db, input) {
  if (input == null) return {};
  if (!isObj(input)) fail('"values" must be an object of { "column name or id": value }.');
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const col = db.columns.find((c) => c.id === key) ??
      db.columns.find((c) => c.name === key) ??
      db.columns.find((c) => c.name.toLowerCase() === String(key).toLowerCase());
    if (!col) fail(`No column "${key}". Columns: ${db.columns.map((c) => c.name).join(", ")}.`);
    if (col.type === "formula") fail(`Column "${col.name}" is a formula; its value is computed.`);
    const r = validate(col, value);
    if (!r.ok) fail(`Column "${col.name}": ${r.error}`);
    out[col.id] = r.value;
  }
  return out;
}
const withFormulas = (db, allRows, row) => {
  const list = allRows.filter((r) => r.id !== row.id).map((r) => ({ ...r, values: { ...r.values } }));
  list.push(row);
  list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  applyFormulas(db.columns, list);
  return row;
};

// ---------- tool definitions ----------
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const ID = { type: "string", description: "A Denotation page or row id (from list_pages / search)." };
const MD = { type: "string", description: "Body as Markdown (headings, lists, to-dos, quotes, code, tables, links)." };
const VALUES = { type: "object", description: 'Cell values keyed by column name or id, e.g. { "Name": "Milk", "Done": true }.', additionalProperties: true };

export const TOOLS = [
  {
    name: "list_pages",
    description: "List the pages, repositories and databases the assistant may read, as a tree (id, title, type, parentId, depth) with what it may do on each. Archived pages are left out unless includeArchived is true.",
    inputSchema: obj({ includeArchived: { type: "boolean", description: "Also list archived pages (marked archived: true)." } }),
    annotations: { readOnlyHint: true },
    write: false
  },
  {
    name: "read_page",
    description: "Read one page: a doc as Markdown; a database as its columns and rows; a row as its values and body.",
    inputSchema: obj({ id: ID, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 2000 } }, ["id"]),
    annotations: { readOnlyHint: true },
    write: false
  },
  {
    name: "search",
    description: "Search page titles, page text, page properties and database rows the assistant may read. Archived pages are left out unless includeArchived is true.",
    inputSchema: obj({ query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 }, includeArchived: { type: "boolean" } }, ["query"]),
    annotations: { readOnlyHint: true },
    write: false
  },
  {
    name: "create_page",
    description: "Create a page (type doc, default) or database under a repository or doc page, or a new repository (type repo, no parentId). Needs create permission on the parent.",
    inputSchema: obj({
      title: { type: "string" },
      parentId: ID,
      type: { type: "string", enum: ["doc", "database", "repo"] },
      markdown: MD,
      columns: {
        type: "array",
        description: "Database columns (type database only). Default: one text column \"Name\".",
        items: obj({ name: { type: "string" }, type: { type: "string", enum: NEW_COL_TYPES }, options: { type: "array", items: { type: "string" } } }, ["name"])
      }
    }, ["title"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
    write: true
  },
  {
    name: "update_page",
    description: "Change a page's title and/or replace its body with Markdown (docs and repositories; databases: title only). Needs edit permission.",
    inputSchema: obj({ id: ID, title: { type: "string" }, markdown: MD }, ["id"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
    write: true
  },
  {
    name: "delete_page",
    description: "Move a page (and everything under it) to the trash, like the app does. Needs delete permission.",
    inputSchema: obj({ id: ID }, ["id"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
    write: true
  },
  {
    name: "add_row",
    description: "Add a row to a database. Needs create permission on the database.",
    inputSchema: obj({ databaseId: ID, values: VALUES, markdown: MD }, ["databaseId"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
    write: true
  },
  {
    name: "update_row",
    description: "Change a row's values and/or replace its page body with Markdown. Needs edit permission on the row (rows inherit from their database).",
    inputSchema: obj({ id: ID, values: VALUES, markdown: MD }, ["id"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
    write: true
  },
  {
    name: "delete_row",
    description: "Delete a database row permanently. Needs delete permission on the row (rows inherit from their database).",
    inputSchema: obj({ id: ID }, ["id"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
    write: true
  }
];

export const listTools = (store) => TOOLS.filter((t) => !t.write || !store.readOnly).map(({ write, ...t }) => t);

// ---------- handlers ----------
const handlers = {
  async list_pages(store, args) {
    const withArchived = bool(args, "includeArchived");
    const s = await snapshot(store);
    const visible = s.pages.filter((p) => s.livePage(p) && s.allowed(p.id, "read") && (withArchived || !s.archived(p)));
    const ids = new Set(visible.map((p) => p.id));
    const kids = new Map();
    for (const p of visible) {
      const key = p.parentId && ids.has(p.parentId) ? p.parentId : null;
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key).push(p);
    }
    const out = [];
    const walk = (key, depth) => {
      for (const p of kids.get(key) ?? []) {
        const can = Object.fromEntries(["create", "edit", "delete"].map((a) => [a, s.allowed(p.id, a)]));
        out.push({ id: p.id, title: p.title || "Untitled", type: p.type, parentId: p.parentId ?? null, depth, can, ...(s.archived(p) ? { archived: true } : {}), ...(p.template ? { template: true } : {}) });
        if (out.length < 5000) walk(p.id, depth + 1);
      }
    };
    walk(null, 0);
    return json({ pages: out, canCreateRepository: s.allowed(null, "create") });
  },

  async read_page(store, args) {
    const target = id(args, "id", { required: true });
    const offset = int(args, "offset", 0, 0, 1e6);
    const limit = int(args, "limit", 200, 1, 2000);
    const s = await snapshot(store);
    if (!s.isLive(target)) fail(`Denotation: no page or row with id ${target}.`);
    s.need(target, "read");
    const row = !s.pageMap.has(target) ? s.rowMap.get(target) : null;
    if (row) {
      const db = s.pageMap.get(row.dbId);
      const names = columnKeyMap(db.columns);
      return json({
        kind: "row", id: row.id, databaseId: db.id, database: s.readable(db.id) ? db.title || "Untitled" : undefined, title: s.rowTitle(row),
        values: Object.fromEntries(db.columns.map((c) => [names.get(c.id), row.values?.[c.id] ?? null])),
        markdown: toMd(s, row.blocks)
      });
    }
    const page = s.pageMap.get(target);
    const children = s.pages.filter((p) => p.parentId === page.id && s.livePage(p) && s.allowed(p.id, "read")).map((p) => ({ id: p.id, title: p.title || "Untitled", type: p.type }));
    if (page.type !== "database") {
      return json({ kind: page.type, id: page.id, title: page.title || "Untitled", parentId: page.parentId ?? null, markdown: toMd(s, page.blocks), children });
    }
    let src = page;
    if (page.sourceId) {
      src = s.pageMap.get(page.sourceId);
      if (!src || !s.livePage(src)) fail("Denotation: the source of this linked database is missing.");
      s.need(src.id, "read");
    }
    const names = columnKeyMap(src.columns);
    const all = s.rowsOf(src.id).filter((r) => s.allowed(r.id, "read"));
    const rows = all.slice(offset, offset + limit).map((r) => ({
      id: r.id,
      values: Object.fromEntries(src.columns.map((c) => [names.get(c.id), r.values?.[c.id] ?? null])),
      hasBody: !!plainText(r.blocks ?? []).trim()
    }));
    return json({
      kind: "database", id: page.id, title: page.title || "Untitled", parentId: page.parentId ?? null,
      ...(page.sourceId ? { linkedTo: src.id } : {}),
      columns: src.columns.map(describeColumn), totalRows: all.length, offset, rows, children
    });
  },

  async search(store, args) {
    const query = str(args, "query", { required: true, max: 200 }).trim().toLowerCase();
    const limit = int(args, "limit", 30, 1, 100);
    const withArchived = bool(args, "includeArchived");
    if (!query) fail("Give a search query.");
    const s = await snapshot(store);
    const snip = (text) => {
      const i = text.toLowerCase().indexOf(query);
      return i < 0 ? "" : (i > 30 ? "…" : "") + text.slice(Math.max(0, i - 30), i + 80).replace(/\n/g, " ");
    };
    const hits = [];
    for (const p of s.pages) {
      if (!s.livePage(p)) continue;
      const arch = s.archived(p);
      if (arch && !withArchived) continue;
      if (s.allowed(p.id, "read")) {
        const inTitle = (p.title || "").toLowerCase().includes(query);
        const props = Array.isArray(p.props) ? p.props.map((x) => `${x.name}: ${Array.isArray(x.value) ? x.value.join(", ") : x.value ?? ""}`).join("\n") : "";
        const body = snip(`${props ? `${props}\n` : ""}${p.blocks ? plainText(p.blocks) : ""}`);
        if (inTitle || body) hits.push({ kind: p.type, id: p.id, title: p.title || "Untitled", snippet: inTitle ? undefined : body, rank: inTitle ? 0 : 1, ...(arch ? { archived: true } : {}) });
      }
      if (p.type === "database" && !p.sourceId) {
        for (const r of s.rowsOf(p.id)) {
          if (!s.allowed(r.id, "read")) continue;
          const text = p.columns.map((c) => toText(c, r.values?.[c.id])).join(" · ");
          const title = s.rowTitle(r);
          const body = snip(`${text}\n${r.blocks ? plainText(r.blocks) : ""}`);
          if (title.toLowerCase().includes(query) || body) {
            hits.push({ kind: "row", id: r.id, databaseId: p.id, title, snippet: body || undefined, rank: title.toLowerCase().includes(query) ? 0 : 1 });
          }
        }
      }
    }
    return json({ results: hits.sort((a, b) => a.rank - b.rank).slice(0, limit).map(({ rank, ...h }) => h) });
  },

  async create_page(store, args) {
    const title = str(args, "title", { required: true }).trim() || "Untitled";
    const type = str(args, "type") ?? "doc";
    if (!["doc", "database", "repo"].includes(type)) fail('"type" must be doc, database or repo.');
    const parentId = id(args, "parentId");
    const body = md(args, "markdown");
    const s = await snapshot(store);
    const now = Date.now();
    const page = { id: newId(), type, title, parentId: null, createdAt: now, updatedAt: now };
    if (type === "repo") {
      if (parentId) fail("A repository has no parent; leave out parentId.");
      s.need(null, "create");
    } else {
      if (!parentId) fail("Give parentId (a repository or doc page). Use list_pages to find one.");
      const parent = s.pageMap.get(parentId);
      if (!parent || !s.livePage(parent)) fail(`Denotation: no page with id ${parentId}.`);
      s.need(parentId, "create");
      if (!["doc", "repo"].includes(parent.type)) fail("Pages can only be created inside a repository or a doc page.");
      page.parentId = parentId;
    }
    if (type === "database") {
      if (body) fail("A database has no Markdown body; add rows with add_row.");
      const cols = args.columns ?? [{ name: "Name", type: "text" }];
      if (!Array.isArray(cols) || !cols.length || cols.length > 50) fail('"columns" must be a list of 1 to 50 columns.');
      page.columns = cols.map((c) => {
        if (!isObj(c) || typeof c.name !== "string" || !c.name.trim() || c.name.length > 100) fail("Each column needs a name (max 100 characters).");
        const t = c.type ?? "text";
        if (!NEW_COL_TYPES.includes(t)) fail(`Column type must be one of ${NEW_COL_TYPES.join(", ")}.`);
        const config = {};
        if (t === "select") {
          const opts = c.options ?? [];
          if (!Array.isArray(opts) || opts.length > 100 || opts.some((o) => typeof o !== "string" || !o.trim() || o.length > 100)) fail("Select options must be non-empty strings.");
          config.options = [...new Set(opts.map((o) => o.trim()))];
        }
        return { id: newId(), name: c.name.trim(), type: t, config };
      });
    } else {
      if (args.columns != null) fail('"columns" is only for type database.');
      page.blocks = blocksFrom(body);
    }
    await store.writeRecord("pages", page);
    return json({ created: { id: page.id, title: page.title, type: page.type, parentId: page.parentId } });
  },

  async update_page(store, args) {
    const target = id(args, "id", { required: true });
    const title = str(args, "title");
    const body = md(args, "markdown");
    if (title === undefined && body === undefined) fail("Give a new title and/or markdown.");
    const s = await snapshot(store);
    if (!s.pageMap.has(target) && s.rowMap.has(target)) fail("That id is a database row; use update_row.");
    const page = s.pageMap.get(target);
    if (!page || !s.livePage(page)) fail(`Denotation: no page with id ${target}.`);
    s.need(target, "edit");
    if (body !== undefined && page.type === "database") fail("A database has no Markdown body; change rows with update_row.");
    if (title !== undefined) page.title = title.trim() || "Untitled";
    if (body !== undefined) page.blocks = blocksFrom(body, page.blocks);
    page.updatedAt = Date.now();
    await store.writeRecord("pages", page);
    return json({ updated: { id: page.id, title: s.allowed(page.id, "read") ? page.title : undefined } });
  },

  async delete_page(store, args) {
    const target = id(args, "id", { required: true });
    const s = await snapshot(store);
    if (!s.pageMap.has(target) && s.rowMap.has(target)) fail("That id is a database row; use delete_row.");
    const page = s.pageMap.get(target);
    if (!page || !s.livePage(page)) fail(`Denotation: no page with id ${target}.`);
    s.need(target, "delete");
    // Trashing hides everything below, so every page (and row) underneath must allow delete too.
    const below = descendantIds(s.pages, target);
    for (const p of s.pages) {
      if (!below.has(p.id) || !s.livePage(p)) continue;
      s.need(p.id, "delete");
      if (p.type === "database") for (const r of s.rowsOf(p.id)) s.need(r.id, "delete");
    }
    page.trashedAt = Date.now();
    page.updatedAt = page.trashedAt;
    await store.writeRecord("pages", page);
    return json({ trashed: { id: page.id }, note: "Moved to the trash; it can be restored in the app." });
  },

  async add_row(store, args) {
    const dbId = id(args, "databaseId", { required: true });
    const body = md(args, "markdown");
    const s = await snapshot(store);
    let db = s.pageMap.get(dbId);
    if (!db || !s.livePage(db) || db.type !== "database") fail(`Denotation: no database with id ${dbId}.`);
    if (db.sourceId) {
      db = s.pageMap.get(db.sourceId);
      if (!db || !s.livePage(db)) fail("Denotation: the source of this linked database is missing.");
    }
    s.need(db.id, "create");
    const values = { ...Object.fromEntries(db.columns.map((c) => [c.id, defaultValue(c)])), ...cleanValues(db, args.values) };
    const now = Date.now();
    const row = { id: newId(), dbId: db.id, createdAt: now, updatedAt: now, values };
    if (body && body.trim()) row.blocks = blocksFrom(body);
    withFormulas(db, s.rowsOf(db.id), row);
    await store.writeRecord("rows", row);
    return json({ created: { id: row.id, databaseId: db.id } });
  },

  async update_row(store, args) {
    const target = id(args, "id", { required: true });
    const body = md(args, "markdown");
    if (args.values == null && body === undefined) fail("Give values and/or markdown.");
    const s = await snapshot(store);
    const row = s.pageMap.has(target) ? null : s.rowMap.get(target);
    if (!row || !s.isLive(target)) fail(`Denotation: no row with id ${target}.`);
    s.need(target, "edit");
    const db = s.pageMap.get(row.dbId);
    row.values = { ...row.values, ...cleanValues(db, args.values) };
    if (body !== undefined) row.blocks = blocksFrom(body, row.blocks);
    row.updatedAt = Date.now();
    withFormulas(db, s.rowsOf(db.id), row);
    await store.writeRecord("rows", row);
    return json({ updated: { id: row.id } });
  },

  async delete_row(store, args) {
    const target = id(args, "id", { required: true });
    const s = await snapshot(store);
    const row = s.pageMap.has(target) ? null : s.rowMap.get(target);
    if (!row || !s.isLive(target)) fail(`Denotation: no row with id ${target}.`);
    s.need(target, "delete");
    await store.deleteRow(row.id);
    return json({ deleted: { id: row.id } });
  }
};

/** Run one tool. Returns an MCP CallToolResult; tool failures come back as isError results. */
export async function callTool(store, name, args) {
  const def = TOOLS.find((t) => t.name === name);
  if (!def || !Object.hasOwn(handlers, name)) return null;
  if (args != null && !isObj(args)) return { content: [{ type: "text", text: "Arguments must be an object." }], isError: true };
  try {
    if (def.write) store.assertWritable();
    const text = await handlers[name](store, args ?? {});
    return { content: [{ type: "text", text }] };
  } catch (e) {
    const msg = e instanceof ToolError || String(e?.message ?? "").startsWith("Denotation:") ? e.message : `Denotation: ${e?.message ?? e}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
