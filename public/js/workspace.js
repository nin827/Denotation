import { validate, defaultValue, reconcile } from "./schema.js";
import { newId } from "./ids.js";
import { newView } from "./dbviews.js";
import { newBlock, walk, plainText } from "./blocks/model.js";
import { markdownToBlocks } from "./blocks/markdown.js";
import { tableFromCsv, parseCsv, rowsFromCsv } from "./csv.js";
import { tableData } from "./sources.js";
import { cloneBlock } from "./blocks/model.js";
import { cleanProps, propsFromRow, valuesFromProps, propsSearchText } from "./pageProps.js";
import { cleanRules } from "./autoCallouts.js";
import { summarize, isComposite } from "./schema.js";
import { formatResult } from "./formula.js";
import { toText } from "./dbviews.js";

// id -> page index per pages array, so isTrashed / ancestors over a whole list stay O(n) instead of rebuilding the map per call.
// Holds references, so in-place edits (trashedAt, parentId) are seen; a changed length drops it.
const indexCache = new WeakMap();
const indexOf = (pages, page) => {
  const hit = indexCache.get(pages);
  // Rebuild if the length changed or the asked-for page was replaced in place.
  if (hit && hit.n === pages.length && (!page || hit.byId.get(page.id) === page)) return hit.byId;
  const byId = new Map(pages.map((p) => [p.id, p]));
  indexCache.set(pages, { n: pages.length, byId });
  return byId;
};
export const isTrashed = (pages, page) => {
  const byId = indexOf(pages, page);
  for (let p = page, n = 0; p && n < 100; p = byId.get(p.parentId), n++) if (p.trashedAt) return true;
  return false;
};
/** True when the page or one of its parents is archived (`archivedAt`). Archived pages are out of every listing. */
export const isArchived = (pages, page) => {
  const byId = indexOf(pages, page);
  for (let p = page, n = 0; p && n < 100; p = byId.get(p.parentId), n++) if (p.archivedAt) return true;
  return false;
};
/** Trashed or archived: left out of the tree, pickers, search and chips. */
export const isHidden = (pages, page) => isTrashed(pages, page) || isArchived(pages, page);
/** True when the page is a template or sits inside one (templates are listed apart from the tree). */
export const inTemplate = (pages, page) => {
  const byId = indexOf(pages, page);
  for (let p = page, n = 0; p && n < 100; p = byId.get(p.parentId), n++) if (p.template) return true;
  return false;
};
/** Does a row (or page) body hold anything written? An empty paragraph does not count. */
export const hasWrittenBlocks = (blocks) => Array.isArray(blocks) && blocks.some((b) => b && (b.type !== "p" || String(b.text ?? "").trim() || b.children?.length));
/** Text of a cell value for page properties and rules (composite values summarised, formulas formatted). */
export const valueText = (col, v) => {
  if (v == null) return "";
  if (col.type === "formula") return formatResult(v);
  if (isComposite(col)) return summarize(col, v);
  return toText(col, v);
};
const freshBlocks = (blocks) => (Array.isArray(blocks) ? blocks.map((b) => cloneBlock(b)) : []);
export const ancestors = (pages, id) => {
  const byId = indexOf(pages);
  const chain = [];
  for (let p = byId.get(id), n = 0; p && n < 100; p = byId.get(p.parentId), n++) chain.unshift(p);
  return chain;
};
export const descendantIds = (pages, id) => {
  const kids = new Map();
  for (const p of pages) if (p.parentId) (kids.get(p.parentId) ?? kids.set(p.parentId, []).get(p.parentId)).push(p.id);
  const out = new Set([id]);
  const todo = [id];
  while (todo.length) for (const k of kids.get(todo.pop()) ?? []) if (!out.has(k)) {
    out.add(k);
    todo.push(k);
  }
  return out;
};
export function createWorkspace(store) {
  const listeners = new Set();
  const notify = () => {
    for (const f of [...listeners]) {
      try {
        f();
      } catch {
      }
    }
  };
  const put = async (...a) => {
    await store.set(...a);
    notify();
  };
  const del = async (...a) => {
    await store.remove(...a);
    notify();
  };
  const onDataChange = (f) => {
    listeners.add(f);
    return () => listeners.delete(f);
  };
  const byCreated = (a, b) => a.createdAt - b.createdAt;
  const listPages = async () => (await store.list("pages")).sort(byCreated);
  const getPage = (id) => store.get("pages", id);
  const savePage = async (page) => {
    page.updatedAt = Date.now();
    await put("pages", page.id, page);
    return page;
  };
  const createPage = async ({ type = "doc", title = "Untitled", parentId = null, sourceId = null, viewType = null } = {}) => {
    const now = Date.now();
    const page = { id: newId(), type, title, parentId, createdAt: now, updatedAt: now };
    if (type === "repo") {
      page.parentId = null;
    } else if (type === "database" && sourceId) {
      const src = await getPage(sourceId);
      if (!src || src.type !== "database") throw new Error("The source database was not found.");
      if (src.sourceId) return createPage({ type, title, parentId, sourceId: src.sourceId, viewType });
      page.sourceId = sourceId;
      page.columns = [];
      page.views = [newView(viewType || "table", src, viewType ? void 0 : "Table")];
      page.icon = "icon:link-2";
    } else if (type === "database") {
      page.columns = [{ id: newId(), name: "Name", type: "text", config: {} }];
      page.rowPages = false; // new databases: rows are data only until Row pages is turned on
      if (viewType === "sheet") {
        page.columns.push({ id: newId(), name: "Column 2", type: "text", config: {} }, { id: newId(), name: "Column 3", type: "text", config: {} });
        page.views = [newView("sheet", page)];
        page.icon = "icon:sheet";
      }
    } else {
      page.blocks = [newBlock("p")];
    }
    await put("pages", page.id, page);
    if (type === "database" && viewType === "sheet" && !sourceId) for (let i = 0; i < 5; i++) await createRow(page);
    return page;
  };
  const CSV_MAX_ROWS = 5e3;
  const checked = (col, v) => {
    const r = validate(col, v);
    return r.ok ? r.value : defaultValue(col);
  };
  const importCsv = async ({ text, title = "Imported data", parentId = null }) => {
    const t = tableFromCsv(parseCsv(text));
    if (!t.columns.length) throw new Error("That file has no data.");
    if (t.rows.length > CSV_MAX_ROWS) throw new Error(`Too many rows (${t.rows.length}). The limit is ${CSV_MAX_ROWS}.`);
    const db = await createPage({ type: "database", title, parentId });
    db.columns = t.columns.map((c) => ({ id: newId(), name: c.name, type: c.type, config: {} }));
    await savePage(db);
    for (const r of t.rows) await createRow(db, Object.fromEntries(db.columns.map((c, i) => [c.id, checked(c, r[i])])));
    return { db, rows: t.rows.length };
  };
  /**
   * Makes a real database from a table block (first row = column names, every column text, one row per table row)
   * as a page under `parentId`. The caller swaps the block for a view block. The key column becomes the primary key.
   */
  const createDatabaseFromTable = async ({ block, title = "Table", parentId = null }) => {
    const t = tableData(block);
    const db = await createPage({ type: "database", title: String(title).trim() || "Table", parentId });
    db.columns = t.columns.map((c) => ({ id: newId(), name: c.name, type: "text", config: {} }));
    if (t.keyIndex > 0) db.primaryKey = db.columns[t.keyIndex].id;
    await savePage(db);
    for (const r of t.rows) await createRow(db, Object.fromEntries(db.columns.map((c, i) => [c.id, r.values[t.columns[i].id]])));
    return { db, rows: t.rows.length };
  };
  const appendCsv = async (db, text) => {
    const { rows, matched } = rowsFromCsv(parseCsv(text), db.columns);
    if (!rows.length) throw new Error("That file has no rows.");
    if (!matched) throw new Error("No column of the file matches this database.");
    if (rows.length > CSV_MAX_ROWS) throw new Error(`Too many rows (${rows.length}). The limit is ${CSV_MAX_ROWS}.`);
    const made = [];
    for (const patch of rows) {
      const clean = {};
      for (const c of db.columns) if (c.id in patch) clean[c.id] = checked(c, patch[c.id]);
      made.push(await createRow(db, clean));
    }
    return made;
  };
  const listRows = async (dbId) => (await store.list("rows", { dbId })).sort(byCreated);
  const createRow = async (db, patch = {}) => {
    const row = {
      id: newId(),
      dbId: db.id,
      createdAt: Date.now() + (createRow.n = ((createRow.n ?? 0) + 1) % 1e3) / 1e3,
      // keeps rows made in one millisecond in order
      values: { ...Object.fromEntries(db.columns.map((c) => [c.id, defaultValue(c)])), ...patch }
    };
    await put("rows", row.id, row);
    return row;
  };
  const saveRow = (row) => {
    row.updatedAt = Date.now();
    return put("rows", row.id, row);
  };
  const deleteRow = (id) => del("rows", id);
  const updateColumns = async (db, columns) => {
    const rows = await listRows(db.id);
    db.columns = columns;
    await savePage(db);
    for (const row of rows) {
      const next = Object.fromEntries(columns.map((c) => [
        c.id,
        c.id in row.values ? reconcile(c, row.values[c.id]) : defaultValue(c)
      ]));
      if (JSON.stringify(next) !== JSON.stringify(row.values)) {
        row.values = next;
        await saveRow(row);
      }
    }
  };
  const deletePage = async (id) => {
    const pages = await listPages();
    const doomed = descendantIds(pages, id);
    for (const p of pages) {
      if (!doomed.has(p.id)) continue;
      if (p.type === "database") {
        for (const r of await listRows(p.id)) await deleteRow(r.id);
      }
      await del("pages", p.id);
    }
    return [...doomed];
  };
  const trashPage = async (id) => {
    const p = await getPage(id);
    if (!p) return null;
    p.trashedAt = Date.now();
    delete p.archivedAt;
    return savePage(p);
  };
  const restorePage = async (id) => {
    const pages = await listPages();
    const p = pages.find((x) => x.id === id);
    if (!p) return null;
    delete p.trashedAt;
    delete p.archivedAt;
    rehome(pages, p);
    return savePage(p);
  };
  // Back to the parent it came from, or the root of its repository (else the first live one) when that is gone.
  const rehome = (pages, p) => {
    if (p.type === "repo") return;
    const parent = pages.find((x) => x.id === p.parentId);
    if (parent && !isHidden(pages, parent) && ["doc", "repo"].includes(parent.type)) return;
    const own = ancestors(pages, p.id).find((x) => x.type === "repo" && x.id !== p.id && !isHidden(pages, x));
    p.parentId = own?.id ?? pages.find((x) => x.type === "repo" && !isHidden(pages, x) && x.id !== p.id)?.id ?? null;
  };
  /** Archive: out of the tree, search and pickers, read-only until restored. */
  const archivePage = async (id) => {
    const p = await getPage(id);
    if (!p || p.type === "repo" || p.type === "sync") return null;
    p.archivedAt = Date.now();
    return savePage(p);
  };
  const listArchive = async () => {
    const pages = await listPages();
    return pages.filter((p) => p.archivedAt && p.type !== "sync" && !isTrashed(pages, p) && !isArchived(pages, { ...p, archivedAt: 0 })).sort((a, b) => b.archivedAt - a.archivedAt);
  };
  /**
   * Restores an archived page. A row body archived from a database goes back into its row when that row still exists,
   * its database has row pages on and the row body is empty; otherwise the page returns to its parent (or the root of
   * its repository). Returns { page } or { row }.
   */
  const unarchivePage = async (id) => {
    const pages = await listPages();
    const p = pages.find((x) => x.id === id);
    if (!p) return null;
    const from = p.archivedFrom;
    if (from?.rowId) {
      const row = await getRow(from.rowId);
      const db = row && pages.find((x) => x.id === row.dbId);
      if (row && db && !isHidden(pages, db) && db.rowPages !== false && !hasWrittenBlocks(row.blocks)) {
        row.blocks = p.blocks ?? [];
        await saveRow(row);
        await del("pages", p.id);
        return { row };
      }
    }
    delete p.archivedAt;
    rehome(pages, p);
    return { page: await savePage(p) };
  };
  /** Archived page -> Trash (it can still be restored from there). */
  const archiveToTrash = async (id) => {
    const p = await getPage(id);
    if (!p) return null;
    delete p.archivedAt;
    p.trashedAt = Date.now();
    return savePage(p);
  };
  /** Turns a row body into its own page (title, row values as properties, link back), archived or in the Trash. */
  const rowBodyToPage = async (db, row, mode = "archive") => {
    const nameCol = db.columns?.[0];
    const now = Date.now();
    const parent = (await listPages()).find((x) => x.id === db.parentId);
    const page = {
      id: newId(),
      type: "doc",
      title: (nameCol ? valueText(nameCol, row.values?.[nameCol.id]) : "").trim() || "Untitled",
      parentId: parent && ["doc", "repo"].includes(parent.type) ? parent.id : db.parentId ?? null,
      createdAt: now,
      updatedAt: now,
      props: propsFromRow(db.columns, row, valueText),
      archivedFrom: { dbId: db.id, rowId: row.id, dbTitle: db.title || "Untitled" },
      blocks: row.blocks
    };
    if (row.icon) page.icon = row.icon;
    if (mode === "trash") page.trashedAt = now;
    else page.archivedAt = now;
    await put("pages", page.id, page);
    delete row.blocks;
    await saveRow(row);
    return page;
  };
  /** Rows of a database whose page body holds something. */
  const rowsWithBodies = async (dbId) => (await listRows(dbId)).filter((r) => hasWrittenBlocks(r.blocks));
  /**
   * Row pages on/off. Off with written row bodies needs `bodies`: "archive" or "trash" (each body becomes a page there);
   * without it nothing changes and { needs: n } is returned. Empty bodies are just dropped.
   */
  const setRowPages = async (dbId, on, { bodies = null } = {}) => {
    const db = await getPage(dbId);
    if (!db || db.type !== "database" || db.sourceId) return { ok: false };
    if (on) {
      db.rowPages = true;
      await savePage(db);
      return { ok: true, moved: 0 };
    }
    const written = await rowsWithBodies(db.id);
    if (written.length && !["archive", "trash"].includes(bodies)) return { ok: false, needs: written.length };
    for (const r of written) await rowBodyToPage(db, r, bodies);
    for (const r of await listRows(db.id)) {
      if (r.blocks) {
        delete r.blocks;
        await saveRow(r);
      }
    }
    db.rowPages = false;
    await savePage(db);
    return { ok: true, moved: written.length };
  };
  /** Marks a page as a template (optionally a row template for database `templateFor`), or back to a normal page. */
  const setTemplate = async (id, on, { templateFor } = {}) => {
    const p = await getPage(id);
    if (!p || p.type === "repo" || p.type === "sync") return null;
    if (on) p.template = true;
    else {
      delete p.template;
      delete p.templateFor;
    }
    if (on && templateFor !== undefined) {
      if (templateFor) p.templateFor = templateFor;
      else delete p.templateFor;
    }
    return savePage(p);
  };
  /** Live templates (not trashed or archived); `forDb` limits to row templates of that database, `pagesOnly` to page templates. */
  const listTemplates = async ({ forDb = null, pagesOnly = false } = {}) => {
    const pages = await listPages();
    return pages.filter((p) => p.template && p.type !== "sync" && !isHidden(pages, p) && (forDb ? p.templateFor === forDb : pagesOnly ? !p.templateFor : true));
  };
  // Rules get fresh ids; rules the template already pinned as blocks stay pinned on the copy.
  const copyRules = (t, target) => {
    const map = new Map();
    const rules = cleanRules(t.autoCallouts).map((r) => {
      const id = newId();
      map.set(r.id, id);
      return { ...r, id };
    });
    if (rules.length) target.autoCallouts = rules;
    const pinned = (Array.isArray(t.pinnedRules) ? t.pinnedRules : []).map((id) => map.get(id)).filter(Boolean);
    if (pinned.length) target.pinnedRules = pinned;
  };
  /** A new page from a template: blocks (fresh ids), properties and automatic-callout rules are copied. */
  const createFromTemplate = async (templateId, parentId) => {
    const t = await getPage(templateId);
    if (!t || !t.template) throw new Error("That template was not found.");
    const page = await createPage({ type: "doc", title: t.title || "Untitled", parentId });
    if (t.icon) page.icon = t.icon;
    if (t.cover) page.cover = t.cover;
    for (const k of ["fullWidth", "smallText"]) if (t[k]) page[k] = true;
    page.blocks = t.blocks?.length ? freshBlocks(t.blocks) : page.blocks;
    const props = cleanProps(t.props).map((p) => ({ ...p, id: newId() }));
    if (props.length) page.props = props;
    copyRules(t, page);
    return savePage(page);
  };
  /** A new row from a row template: values from properties matched by column name, body and rules copied. */
  const createRowFromTemplate = async (db, templateId) => {
    const t = await getPage(templateId);
    if (!t || !t.template) throw new Error("That template was not found.");
    const patch = {};
    for (const [colId, v] of Object.entries(valuesFromProps(db.columns, t.props))) {
      const col = db.columns.find((c) => c.id === colId);
      const r = validate(col, v);
      if (r.ok) patch[colId] = r.value;
    }
    const nameCol = db.columns[0];
    if (nameCol && !(nameCol.id in patch) && nameCol.type === "text" && t.title) patch[nameCol.id] = t.title;
    const row = await createRow(db, patch);
    if (hasWrittenBlocks(t.blocks)) row.blocks = freshBlocks(t.blocks);
    copyRules(t, row);
    if (t.icon) row.icon = t.icon;
    if (row.blocks || row.autoCallouts || row.icon) await saveRow(row);
    return row;
  };
  const listTrash = async () => {
    const pages = await listPages();
    return pages.filter((p) => p.trashedAt && p.type !== "sync" && !isTrashed(pages, { ...p, trashedAt: 0 })).sort((a, b) => b.trashedAt - a.trashedAt);
  };
  const emptyTrash = async () => {
    const roots = await listTrash();
    let n = 0;
    for (const p of roots) n += (await deletePage(p.id)).length;
    return n;
  };
  const setFavorite = async (id, on) => {
    const p = await getPage(id);
    if (!p) return null;
    if (on) p.favorite = true;
    else delete p.favorite;
    return savePage(p);
  };
  const movePage = async (id, parentId) => {
    const pages = await listPages();
    const p = pages.find((x) => x.id === id);
    const target = parentId ? pages.find((x) => x.id === parentId) : null;
    if (!p || p.type === "repo") return false;
    if (!parentId && pages.some((x) => x.type === "repo")) return false;
    if (parentId && (!target || !["doc", "repo"].includes(target.type) || descendantIds(pages, id).has(parentId))) return false;
    p.parentId = parentId ?? null;
    await savePage(p);
    return true;
  };
  const duplicatePage = async (id) => {
    const pages = await listPages();
    const ids = descendantIds(pages, id);
    const idMap = new Map([...ids].map((old) => [old, newId()]));
    const now = Date.now();
    const clones = [];
    for (const old of pages.filter((p) => ids.has(p.id))) {
      const c = JSON.parse(JSON.stringify(old));
      c.id = idMap.get(old.id);
      c.parentId = old.id === id ? old.parentId : idMap.get(old.parentId);
      c.createdAt = c.updatedAt = now + clones.length;
      delete c.trashedAt;
      delete c.archivedAt;
      if (old.id === id) {
        c.title = `${old.title} (copy)`;
        delete c.favorite;
      }
      if (c.sourceId && idMap.has(c.sourceId)) c.sourceId = idMap.get(c.sourceId);
      if (c.blocks) {
        const fresh = (b) => {
          b.id = newId();
          (b.children || []).forEach(fresh);
        };
        c.blocks.forEach(fresh);
        walk(c.blocks, (b) => {
          if (b.type === "page" && idMap.has(b.ref)) b.ref = idMap.get(b.ref);
        });
      }
      clones.push(c);
    }
    for (const c of clones) await put("pages", c.id, c);
    for (const old of pages.filter((p) => ids.has(p.id) && p.type === "database")) {
      for (const r of await listRows(old.id)) {
        const c = JSON.parse(JSON.stringify(r));
        c.id = newId();
        c.dbId = idMap.get(old.id);
        await put("rows", c.id, c);
      }
    }
    return clones.find((c) => c.id === idMap.get(id));
  };
  const createSync = async (blocks = [newBlock("p")]) => {
    const now = Date.now();
    const page = { id: newId(), type: "sync", title: "Synced block", parentId: null, createdAt: now, updatedAt: now, blocks };
    await put("pages", page.id, page);
    return page;
  };
  const search = async (query, limit = 30, { includeArchived = false } = {}) => {
    const q = String(query).trim().toLowerCase();
    if (!q) return [];
    const pages = (await listPages()).filter((p) => p.type !== "sync");
    const live = pages.filter((p) => !isTrashed(pages, p) && (includeArchived || !isArchived(pages, p)));
    const titleOf = (id) => pages.find((x) => x.id === id)?.title || "Untitled";
    const snippetOf = (text) => {
      const i = text.toLowerCase().indexOf(q);
      if (i < 0) return "";
      return (i > 30 ? "\u2026" : "") + text.slice(Math.max(0, i - 30), i + 60).replace(/\n/g, " ");
    };
    const hits = [];
    for (const p of live) {
      const inTitle = (p.title || "").toLowerCase().includes(q);
      const body = `${p.props?.length ? `${propsSearchText(p.props, titleOf)}\n` : ""}${p.blocks ? plainText(p.blocks) : ""}`;
      const snip = snippetOf(body);
      const archived = isArchived(pages, p);
      if (inTitle || snip) hits.push({ kind: "page", id: p.id, pageId: p.id, title: p.title || "Untitled", snippet: inTitle ? "" : snip, rank: inTitle ? 0 : 1, ...(archived ? { archived: true } : {}), ...(p.template ? { template: true } : {}) });
      if (p.type === "database") {
        const nameCol = p.columns[0]?.id;
        for (const r of await listRows(p.id)) {
          const title = String(r.values?.[nameCol] ?? "");
          const text = r.blocks ? plainText(r.blocks) : "";
          const rs = snippetOf(text);
          if (title.toLowerCase().includes(q) || rs) {
            hits.push({ kind: "row", id: r.id, pageId: p.id, title: title || "Untitled", snippet: rs, rank: title.toLowerCase().includes(q) ? 0 : 1 });
          }
        }
      }
    }
    return hits.sort((a, b) => a.rank - b.rank).slice(0, limit);
  };
  const ensureRepository = async () => {
    const pages = await listPages();
    let repo = pages.find((p) => p.type === "repo" && !p.trashedAt);
    const known = new Set(pages.map((p) => p.id));
    const loose = pages.filter((p) => p.type !== "repo" && p.type !== "sync" && (!p.parentId || !known.has(p.parentId)));
    if (!repo && !pages.length) return null;
    if (!repo) repo = await createPage({ type: "repo", title: "My repository" });
    for (const p of loose) {
      p.parentId = repo.id;
      await savePage(p);
    }
    return repo;
  };
  const TICKET_KINDS = ["Feedback", "Request"];
  // Feedback is stored as rows of the page flagged `ticketDb` (the flag keeps its old name so earlier tickets still work).
  const fileFeedback = async ({ kind = "Feedback", title, details = "", images = [], blocks = null }) => {
    if (!TICKET_KINDS.includes(kind)) throw new Error("Choose Feedback or Request.");
    if (!String(title ?? "").trim()) throw new Error("Give the feedback a title.");
    const pages = await listPages();
    let db = pages.find((p) => p.ticketDb && !p.trashedAt);
    if (!db) {
      const repo = pages.find((p) => p.type === "repo" && !p.trashedAt) ?? await ensureRepository();
      db = await createPage({ type: "database", title: "Feedback", parentId: repo?.id ?? null });
      const col = (name, type, config = {}) => ({ id: newId(), name, type, config: config });
      db.columns = [
        col("Title", "text"),
        col("Type", "select", { options: TICKET_KINDS }),
        col("Status", "select", { options: ["Open", "In progress", "Done"] }),
        col("Details", "text")
      ];
      db.ticketDb = true;
      db.rowPages = true; // each feedback item keeps its details as a row page
      db.icon = "icon:message-square-text";
      db.views = [newView("table", db, "All feedback"), newView("board", db, "By status")];
      db.views[1].groupBy = db.columns[2].id;
      await savePage(db);
    }
    else if (db.title === "Tickets") {
      // Earlier versions called this database "Tickets": rename it, data and columns stay as they are.
      db.title = "Feedback";
      if (db.icon === "icon:ticket") db.icon = "icon:message-square-text";
      for (const v of db.views ?? []) if (v.name === "All tickets") v.name = "All feedback";
      await savePage(db);
    }
    const [cTitle, cType, cStatus, cDetails] = db.columns;
    const md = String(details).replace(/!\[([^\]]*)\]\(attached:(\d+)\)/g, (m, alt, n) => images[Number(n) - 1] ? `![${alt}](${images[Number(n) - 1]})` : "");
    const content = blocks ?? markdownToBlocks(md);
    const summary = plainText(content).replace(/\s+/g, " ").trim().slice(0, 300);
    const row = await createRow(db, { [cTitle.id]: title.trim(), [cType.id]: kind, [cStatus.id]: "Open", [cDetails.id]: summary });
    if (blocks ? summary || content.some((b) => b.type !== "p") : md.trim()) {
      row.blocks = content;
      await saveRow(row);
    }
    return { db, row };
  };
  const getRow = (id) => store.get("rows", id);
  const exportAll = async () => ({
    app: "denotation",
    version: 1,
    exportedAt: (new Date()).toISOString(),
    pages: await store.list("pages"),
    rows: await store.list("rows")
  });
  const importAll = async (data) => {
    if (!data || data.app !== "denotation" && data.app !== "denotion" || !Array.isArray(data.pages) || !Array.isArray(data.rows)) {
      throw new Error("Not a Denotation export file");
    }
    for (const p of data.pages) await put("pages", p.id, p);
    for (const r of data.rows) await put("rows", r.id, r);
    return { pages: data.pages.length, rows: data.rows.length };
  };
  return {
    store: store,
    listPages,
    getPage,
    savePage,
    createPage: createPage,
    deletePage,
    ensureRepository,
    fileFeedback,
    fileTicket: fileFeedback,
    importCsv: importCsv,
    createDatabaseFromTable,
    appendCsv,
    trashPage: trashPage,
    restorePage,
    archivePage,
    unarchivePage,
    listArchive,
    archiveToTrash,
    rowBodyToPage,
    rowsWithBodies,
    setRowPages,
    setTemplate,
    listTemplates,
    createFromTemplate,
    createRowFromTemplate,
    listTrash,
    emptyTrash,
    setFavorite,
    movePage,
    duplicatePage,
    createSync,
    search,
    listRows,
    getRow,
    createRow,
    saveRow,
    deleteRow,
    updateColumns,
    exportAll,
    importAll,
    onDataChange
  };
}
