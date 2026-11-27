// Seeded fuzz: random operation sequences on workspace.js over the memory adapter. After every step:
// no parent cycles, no dangling parents or rows, Trash / Archive listings agree with isTrashed / isArchived,
// search never returns hidden pages, row values only use the database's columns, records stay small.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzz, XSS, MARKUP } from "./fixtures/fuzz.js";
import { createWorkspace, isTrashed, isArchived, isHidden, descendantIds, ancestors } from "../../source/app/js/workspace.js";
import { createMemoryAdapter } from "../../source/app/js/adapters/memory.js";
import { newBlock } from "../../source/app/js/blocks/model.js";
import { applyFormulas } from "../../source/app/js/formula.js";
import { extractLinks, uniqueEdges } from "../../source/app/js/links.js";
import { buildToken } from "../../source/app/js/blocks/inline.js";

const RECORD_MAX = 250 * 1024;
let colSeq = 0;
const newCol = (r) => {
  const type = r.pick(["text", "number", "checkbox", "date", "select", "formula", "json"]);
  const col = { id: `col${++colSeq}`, name: r.pick(["Name", "Qty", "Done", "When", "Kind", "F", r.nasty(1).slice(0, 20) || "X"]), type, config: {} };
  if (type === "select") col.config.options = ["a", "b"];
  if (type === "formula") col.config.expr = r.pick(["[Qty]*2", "SUM(ALL([Qty]))", "IF([Done], 1, 0)", "CONCAT([Name], \"!\")", "1/0", "[Missing]", "COUNTIF(ALL([Name]), \"a*\")"]);
  if (type === "json") col.typeText = r.pick(["", "int(0..5)", "Dictionary{a: int}", "Array[String]"]);
  return col;
};
const cellFor = (r, col) => ({
  text: () => r.chance(0.5) ? r.pick(["a", "b", "apple"]) : r.nasty(2),
  number: () => r.pick([r.int(-50, 50), "7", null, "x"]),
  checkbox: () => r.chance(0.5),
  date: () => r.pick(["2024-02-29", "2023-02-29", null]),
  select: () => r.pick(["a", "b", "zz", null]),
  json: () => r.pick([{ a: 1 }, [1, "x"], 3, "s", null]),
  formula: () => null
}[col.type]?.() ?? null);

async function check(ws, label) {
  const pages = await ws.listPages();
  const byId = new Map(pages.map((p) => [p.id, p]));
  for (const p of pages) {
    const seen = new Set();
    for (let c = p; c; c = byId.get(c.parentId)) {
      assert.ok(!seen.has(c.id), `${label}: parent cycle through ${c.id}`);
      seen.add(c.id);
    }
    if (p.parentId != null) assert.ok(byId.has(p.parentId), `${label}: ${p.id} has a dangling parent ${p.parentId}`);
    assert.ok(JSON.stringify(p).length < RECORD_MAX, `${label}: page ${p.id} over ${RECORD_MAX} bytes`);
    if (p.type === "repo") assert.equal(p.parentId, null, `${label}: repository with a parent`);
  }
  const rows = await ws.store.list("rows");
  for (const row of rows) {
    const db = byId.get(row.dbId);
    assert.ok(db && db.type === "database", `${label}: row ${row.id} without its database`);
    for (const k of Object.keys(row.values ?? {})) assert.ok(db.columns.some((c) => c.id === k), `${label}: row ${row.id} keeps value for removed column ${k}`);
  }
  // Trash / Archive listings agree with the ancestor walks.
  const trash = await ws.listTrash();
  for (const p of trash) assert.ok(p.trashedAt && isTrashed(pages, p));
  for (const p of pages) if (p.trashedAt && p.type !== "sync" && !pages.some((q) => q.trashedAt && q.id !== p.id && descendantIds(pages, q.id).has(p.id))) assert.ok(trash.some((t) => t.id === p.id), `${label}: trashed root ${p.id} missing from Trash`);
  const arch = await ws.listArchive();
  for (const p of arch) assert.ok(isArchived(pages, p) && !isTrashed(pages, p));
  const hits = await ws.search("a", 1000);
  for (const h of hits.filter((x) => x.kind === "page")) assert.ok(!isHidden(pages, byId.get(h.id)), `${label}: search returned hidden page ${h.id}`);
  for (const h of hits.filter((x) => x.kind === "row")) assert.ok(!isHidden(pages, byId.get(h.pageId)), `${label}: search returned a row of hidden database ${h.pageId}`);
  // The incrementally kept link index equals a full rescan of every stored page and row.
  const li = await ws.ensureLinkRows();
  const want = new Map();
  for (const rec of [...pages, ...rows]) {
    const m = new Map();
    for (const e of uniqueEdges(extractLinks({ id: rec.id, blocks: rec.blocks }))) m.set(e.to, m.has(e.to) ? m.get(e.to) && e.hidden : e.hidden);
    if (m.size) want.set(rec.id, m);
  }
  const got = new Map();
  for (const { from, to, hidden } of li.index.links()) {
    if (!got.has(from)) got.set(from, new Map());
    got.get(from).set(to, hidden);
  }
  const fmt = (m) => JSON.stringify([...m].map(([k, v]) => [k, [...v].sort()]).sort());
  assert.equal(fmt(got), fmt(want), `${label}: link index differs from a full rescan`);
  for (const [from, m] of want) for (const to of m.keys()) assert.ok(li.backlinks(to).some((b) => b.from === from), `${label}: backlink ${from} -> ${to} missing`);
  return { pages, rows };
}

const OPS = ["doc", "doc", "db", "repo", "trash", "restore", "archive", "unarchive", "archiveToTrash", "move", "move", "dup", "template", "fromTemplate", "rowTemplate", "row", "rows", "saveRow", "deleteRow", "columns", "formulas", "deletePage", "emptyTrash", "rowPages", "favorite", "ensureRepo", "blocks", "links", "links", "rowLinks"];
const linkText = (r, ids) => Array.from({ length: r.int(1, 4) }, () => {
  const to = r.chance(0.85) && ids.length ? r.pick(ids) : r.id();
  return r.pick([
    () => buildToken("link", [to]),
    () => buildToken("xlink", [to]),
    () => buildToken("page", [to]),
    () => buildToken("embed", [to, "b", "b1,b2"]) ?? "",
    () => `[t](#page-${to})`,
    () => `\`{{link:${to}}}\``,
    () => r.nasty(1)
  ])();
}).join(" ");

test("workspace: random operation sequences keep the tree and listings consistent", async () => {
  const opCount = {};
  await fuzz("workspace-ops", 25, async (r) => {
    const ws = createWorkspace(createMemoryAdapter());
    await ws.createPage({ type: "repo", title: "R" });
    for (let step = 0; step < 60; step++) {
      if (!(await ws.listPages()).length) await ws.createPage({ type: "repo", title: "R" });
      const pages = await ws.listPages();
      const any = () => r.pick(pages);
      const ofType = (...t) => pages.filter((p) => t.includes(p.type));
      const dbs = ofType("database").filter((p) => !p.sourceId);
      const op = r.pick(OPS);
      opCount[op] = (opCount[op] ?? 0) + 1;
      const label = `step ${step} ${op}`;
      try {
        switch (op) {
          case "doc": {
            const parent = r.pick([...ofType("doc", "repo"), null]);
            await ws.createPage({ type: "doc", title: r.chance(0.5) ? r.pick(["apple", "a b"]) : r.nasty(1), parentId: parent?.id ?? null });
            break;
          }
          case "db": {
            const parent = r.pick(ofType("doc", "repo"));
            const src = r.chance(0.2) ? r.pick(dbs) : null;
            await ws.createPage({ type: "database", title: "D", parentId: parent?.id ?? null, sourceId: src?.id ?? null, viewType: r.pick([null, "sheet", "board"]) });
            break;
          }
          case "repo": await ws.createPage({ type: "repo", title: r.nasty(1) }); break;
          case "trash": await ws.trashPage(any().id); break;
          case "restore": { const t = await ws.listTrash(); if (t.length) await ws.restorePage(r.pick(t).id); break; }
          case "archive": await ws.archivePage(any().id); break;
          case "unarchive": { const a = await ws.listArchive(); if (a.length) await ws.unarchivePage(r.pick(a).id); break; }
          case "archiveToTrash": { const a = await ws.listArchive(); if (a.length) await ws.archiveToTrash(r.pick(a).id); break; }
          case "move": {
            const p = any();
            const target = r.chance(0.9) ? any() : null;
            const ok = await ws.movePage(p.id, target?.id ?? null);
            if (ok && target) assert.ok(!descendantIds(pages, p.id).has(target.id), `${label}: moved into its own subtree`);
            break;
          }
          case "dup": await ws.duplicatePage(any().id); break;
          case "template": await ws.setTemplate(any().id, r.chance(0.7), r.chance(0.5) && dbs.length ? { templateFor: r.pick(dbs).id } : {}); break;
          case "fromTemplate": { const t = await ws.listTemplates(); if (t.length) await ws.createFromTemplate(r.pick(t).id, r.pick(ofType("doc", "repo"))?.id ?? null); break; }
          case "rowTemplate": { const t = await ws.listTemplates(); if (t.length && dbs.length) await ws.createRowFromTemplate(r.pick(dbs), r.pick(t).id); break; }
          case "row": if (dbs.length) { const db = r.pick(dbs); await ws.createRow(db, Object.fromEntries(db.columns.filter(() => r.chance(0.5)).map((c) => [c.id, cellFor(r, c)]))); } break;
          case "rows": if (dbs.length) { const db = r.pick(dbs); await ws.createRows(db, Array.from({ length: r.int(1, 20) }, () => Object.fromEntries(db.columns.map((c) => [c.id, cellFor(r, c)])))); } break;
          case "saveRow": if (dbs.length) { const db = r.pick(dbs); const rows = await ws.listRows(db.id); if (rows.length) { const row = r.pick(rows); const c = r.pick(db.columns); if (c) row.values[c.id] = cellFor(r, c); if (r.chance(0.3)) row.blocks = [newBlock("p", { text: r.pick(XSS) })]; await ws.saveRow(row); } } break;
          case "deleteRow": if (dbs.length) { const rows = await ws.listRows(r.pick(dbs).id); if (rows.length) await ws.deleteRow(r.pick(rows).id); } break;
          case "columns": if (dbs.length) {
            const db = r.pick(dbs);
            let cols = [...db.columns];
            if (r.chance(0.5) || !cols.length) cols.push(newCol(r));
            if (r.chance(0.3) && cols.length > 1) cols.splice(r.int(0, cols.length - 1), 1);
            if (r.chance(0.3) && cols.length) cols = cols.map((c) => (r.chance(0.3) ? { ...c, type: r.pick(["text", "number", "checkbox", "select", "json"]), config: { options: ["a"] } } : c));
            await ws.updateColumns(db, cols);
            break;
          }
          case "formulas": if (dbs.length) { const db = r.pick(dbs); const rows = await ws.listRows(db.id); const changed = applyFormulas(db.columns, rows); await ws.saveRows(changed); } break;
          case "deletePage": if (r.chance(0.3)) await ws.deletePage(any().id); break;
          case "emptyTrash": if (r.chance(0.3)) await ws.emptyTrash(); break;
          case "rowPages": if (dbs.length) await ws.setRowPages(r.pick(dbs).id, r.chance(0.5), { bodies: r.pick([null, "archive", "trash"]) }); break;
          case "favorite": await ws.setFavorite(any().id, r.chance(0.5)); break;
          case "ensureRepo": await ws.ensureRepository(); break;
          case "links": {
            const p = r.pick(ofType("doc", "repo", "database"));
            if (p) {
              const ids = pages.map((q) => q.id);
              const b = newBlock(r.pick(["p", "h2", "callout", "toggle"]), { text: linkText(r, ids) });
              if (r.chance(0.3)) b.children = [newBlock("p", { text: linkText(r, ids) })];
              p.blocks = r.chance(0.3) ? [] : [...(p.blocks ?? []).slice(0, 3), b];
              await ws.savePage(p);
            }
            break;
          }
          case "rowLinks": if (dbs.length) {
            const rows = await ws.listRows(r.pick(dbs).id);
            if (rows.length) {
              const row = r.pick(rows);
              row.blocks = [newBlock("p", { text: linkText(r, pages.map((q) => q.id)) })];
              await ws.saveRow(row);
            }
            break;
          }
          case "blocks": {
            const p = r.pick(ofType("doc"));
            if (p) {
              p.blocks = Array.from({ length: r.int(1, 5) }, () => newBlock(r.pick(["p", "h1", "bullet", "todo"]), { text: r.chance(0.5) ? r.pick(MARKUP) : r.nasty(2) }));
              await ws.savePage(p);
            }
            break;
          }
        }
      } catch (e) {
        // Documented refusals are fine; anything else is a bug.
        if (!/not found|source database|Choose|title/i.test(e.message)) throw new Error(`${label}: ${e.stack}`);
      }
      await check(ws, label);
    }
  });
  console.log(`  ops: ${Object.entries(opCount).map(([k, v]) => `${k}=${v}`).join(" ")}`);
});

test("workspace: a page under a trashed ancestor more than 100 levels up counts as trashed", { todo: "BUG: isTrashed / isArchived / inTemplate / ancestors stop after 100 levels; deeper pages escape Trash and Archive" }, async () => {
  const pages = [{ id: "root", parentId: null, trashedAt: 1 }];
  for (let i = 1; i <= 150; i++) pages.push({ id: `p${i}`, parentId: i === 1 ? "root" : `p${i - 1}` });
  assert.equal(isTrashed(pages, pages[150]), true);
  assert.equal(ancestors(pages, "p150").length, 151);
});

test("workspace: movePage refuses cycles and repositories as children for any random pair", async () => {
  await fuzz("workspace-move", 40, async (r) => {
    const ws = createWorkspace(createMemoryAdapter());
    const repo = await ws.createPage({ type: "repo", title: "R" });
    const ids = [repo.id];
    const containers = [repo.id];
    for (let i = 0; i < 25; i++) {
      const p = await ws.createPage({ type: r.pick(["doc", "doc", "database"]), title: `p${i}`, parentId: r.pick(containers) });
      ids.push(p.id);
      if (p.type === "doc") containers.push(p.id);
    }
    for (let k = 0; k < 80; k++) {
      await ws.movePage(r.pick(ids), r.chance(0.95) ? r.pick(ids) : null);
      const pages = await ws.listPages();
      const byId = new Map(pages.map((p) => [p.id, p]));
      for (const p of pages) {
        const seen = new Set();
        for (let c = p; c; c = byId.get(c.parentId)) {
          assert.ok(!seen.has(c.id), "cycle");
          seen.add(c.id);
        }
        if (p.parentId) assert.ok(["doc", "repo"].includes(byId.get(p.parentId).type), `${p.id} under a ${byId.get(p.parentId).type}`);
      }
    }
  });
});

test("workspace: importAll with cyclic / self-parented / dangling pages doesn't hang the tree helpers", async () => {
  await fuzz("workspace-cycles", 200, async (r) => {
    const ws = createWorkspace(createMemoryAdapter());
    const n = r.int(1, 12);
    const pages = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, type: r.pick(["doc", "repo", "database"]), title: "a", parentId: r.chance(0.9) ? `p${r.int(0, n)}` : null, columns: [], blocks: [], createdAt: i, ...(r.chance(0.3) ? { trashedAt: 1 } : {}), ...(r.chance(0.3) ? { archivedAt: 1 } : {}) }));
    await ws.importAll({ app: "denotation", pages, rows: [] });
    const all = await ws.listPages();
    for (const p of all) {
      isHidden(all, p);
      ancestors(all, p.id);
      descendantIds(all, p.id);
    }
    await ws.listTrash();
    await ws.listArchive();
    await ws.search("a");
    await ws.restorePage(r.pick(all).id);
    await ws.duplicatePage(r.pick(all).id);
    await ws.deletePage(r.pick(all).id);
    await ws.ensureRepository();
  });
});
