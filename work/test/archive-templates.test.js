import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../../source/app/js/adapters/memory.js";
import { createWorkspace, isArchived, isHidden, inTemplate, hasWrittenBlocks } from "../../source/app/js/workspace.js";
import { newBlock, walk } from "../../source/app/js/blocks/model.js";
import { sourceList, resolveSource } from "../../source/app/js/sources.js";
import { toJsonFiles, toMarkdownFiles, importFiles, asText } from "../../source/app/js/vault.js";

const setup = async () => {
  const ws = createWorkspace(createMemoryAdapter());
  const repo = await ws.createPage({ type: "repo", title: "Repo" });
  return { ws, repo };
};
const ids = (blocks) => {
  const out = [];
  walk(blocks, (b) => out.push(b.id));
  return out;
};

test("archive: hidden everywhere, restore to origin or repository root, archive -> trash", async () => {
  const { ws, repo } = await setup();
  const parent = await ws.createPage({ title: "Parent", parentId: repo.id });
  const child = await ws.createPage({ title: "Child", parentId: parent.id });
  const db = await ws.createPage({ type: "database", title: "DB", parentId: parent.id });
  child.props = [{ id: "p", name: "Status", type: "text", value: "needle" }];
  await ws.savePage(child);
  assert.equal((await ws.search("needle")).length, 1, "search sees property values");
  await ws.archivePage(parent.id);
  let pages = await ws.listPages();
  assert.ok(isArchived(pages, pages.find((p) => p.id === child.id)), "children of an archived page count as archived");
  assert.ok(isHidden(pages, pages.find((p) => p.id === db.id)));
  assert.deepEqual((await ws.listArchive()).map((p) => p.id), [parent.id], "only the archived root is listed");
  assert.deepEqual(await ws.search("needle"), []);
  assert.equal((await ws.search("needle", 30, { includeArchived: true }))[0].archived, true);
  assert.ok(!sourceList(pages).some((p) => p.id === db.id), "pickers skip archived databases");
  assert.equal(resolveSource(pages, db.id).state, "archived");
  // restore the child alone while its parent is still archived -> goes to the repository root
  await ws.archivePage(child.id);
  await ws.unarchivePage(child.id);
  pages = await ws.listPages();
  assert.equal(pages.find((p) => p.id === child.id).parentId, repo.id);
  // restore the parent -> back where it was
  const r = await ws.unarchivePage(parent.id);
  assert.equal(r.page.parentId, repo.id);
  assert.equal(r.page.archivedAt, undefined);
  // archive -> trash -> restore
  await ws.archivePage(parent.id);
  await ws.archiveToTrash(parent.id);
  assert.deepEqual((await ws.listArchive()), []);
  assert.deepEqual((await ws.listTrash()).map((p) => p.id), [parent.id]);
  await ws.restorePage(parent.id);
  pages = await ws.listPages();
  assert.ok(!isHidden(pages, pages.find((p) => p.id === parent.id)));
  assert.equal(await ws.archivePage(repo.id), null, "repositories are not archived");
});

test("templates: new page copies blocks (fresh ids), properties and rules; row templates", async () => {
  const { ws, repo } = await setup();
  const tpl = await ws.createPage({ title: "Meeting", parentId: repo.id });
  const toggle = newBlock("toggle", { text: "Agenda" });
  toggle.children = [newBlock("todo", { text: "Item" })];
  tpl.blocks = [newBlock("h1", { text: "Meeting" }), toggle];
  tpl.props = [{ id: "s", name: "Status", type: "select", options: ["Draft", "Final"], value: "Draft" }];
  tpl.autoCallouts = [{ id: "r1", when: { prop: "Status", op: "is", value: "Draft" }, preset: "warning", text: "Draft" }];
  tpl.pinnedRules = ["r1"];
  await ws.savePage(tpl);
  await ws.setTemplate(tpl.id, true);
  const pages = await ws.listPages();
  assert.ok(inTemplate(pages, pages.find((p) => p.id === tpl.id)));
  assert.deepEqual((await ws.listTemplates({ pagesOnly: true })).map((p) => p.id), [tpl.id]);
  const page = await ws.createFromTemplate(tpl.id, repo.id);
  assert.equal(page.template, undefined);
  assert.equal(page.title, "Meeting");
  assert.equal(page.parentId, repo.id);
  assert.deepEqual(page.blocks.map((b) => b.type), ["h1", "toggle"]);
  const fresh = new Set(ids(page.blocks));
  assert.ok(ids(tpl.blocks).every((id) => !fresh.has(id)), "every block id is new");
  assert.equal(page.props[0].value, "Draft");
  assert.notEqual(page.props[0].id, "s");
  assert.equal(page.autoCallouts[0].text, "Draft");
  assert.notEqual(page.autoCallouts[0].id, "r1");
  assert.deepEqual(page.pinnedRules, [page.autoCallouts[0].id], "a rule pinned on the template stays pinned on the copy");
  // editing the copy leaves the template alone
  page.blocks[0].text = "Changed";
  assert.equal((await ws.getPage(tpl.id)).blocks[0].text, "Meeting");
  // row template
  const db = await ws.createPage({ type: "database", title: "Tasks", parentId: repo.id });
  db.columns.push({ id: "c-status", name: "Status", type: "select", config: { options: ["Draft", "Final"] } }, { id: "c-n", name: "N", type: "number", config: {} });
  await ws.updateColumns(db, db.columns);
  const rt = await ws.createPage({ title: "Task", parentId: repo.id });
  rt.props = [{ name: "Status", type: "select", options: ["Final"], value: "Final" }, { name: "N", type: "text", value: "oops" }];
  rt.blocks = [newBlock("p", { text: "Steps" })];
  await ws.savePage(rt);
  await ws.setTemplate(rt.id, true, { templateFor: db.id });
  assert.deepEqual((await ws.listTemplates({ forDb: db.id })).map((p) => p.id), [rt.id]);
  assert.deepEqual((await ws.listTemplates({ pagesOnly: true })).map((p) => p.id), [tpl.id]);
  const row = await ws.createRowFromTemplate(db, rt.id);
  assert.equal(row.values[db.columns[0].id], "Task", "the title column takes the template title");
  assert.equal(row.values["c-status"], "Final");
  assert.equal(row.values["c-n"], null, "a value the column rejects is left empty");
  assert.equal(row.blocks[0].text, "Steps");
  assert.notEqual(row.blocks[0].id, rt.blocks[0].id);
});

test("row pages: new databases default off, existing ones on; turning off archives or trashes written bodies", async () => {
  const { ws, repo } = await setup();
  const db = await ws.createPage({ type: "database", title: "Notes db", parentId: repo.id });
  assert.equal(db.rowPages, false);
  db.columns.push({ id: "c-s", name: "Status", type: "select", config: { options: ["Open"] } });
  await ws.updateColumns(db, db.columns);
  await ws.setRowPages(db.id, true);
  const [a, b, c] = [await ws.createRow(db), await ws.createRow(db), await ws.createRow(db)];
  a.values[db.columns[0].id] = "Alpha";
  a.values["c-s"] = "Open";
  a.blocks = [newBlock("p", { text: "Alpha notes" })];
  b.values[db.columns[0].id] = "Beta";
  b.blocks = [newBlock("p", { text: "" })]; // empty body: not "written"
  c.values[db.columns[0].id] = "Gamma";
  c.blocks = [newBlock("h2", { text: "Gamma notes" })];
  for (const r of [a, b, c]) await ws.saveRow(r);
  assert.equal(hasWrittenBlocks(b.blocks), false);
  assert.deepEqual((await ws.rowsWithBodies(db.id)).map((r) => r.id).sort(), [a.id, c.id].sort());
  // without a choice nothing changes
  const ask = await ws.setRowPages(db.id, false);
  assert.deepEqual(ask, { ok: false, needs: 2 });
  assert.notEqual((await ws.getPage(db.id)).rowPages, false);
  const done = await ws.setRowPages(db.id, false, { bodies: "archive" });
  assert.deepEqual(done, { ok: true, moved: 2 });
  assert.equal((await ws.getPage(db.id)).rowPages, false);
  for (const r of await ws.listRows(db.id)) assert.equal(r.blocks, undefined, "row bodies are gone from the rows");
  const archived = await ws.listArchive();
  const alpha = archived.find((p) => p.title === "Alpha");
  assert.ok(alpha && archived.some((p) => p.title === "Gamma"));
  assert.equal(alpha.parentId, repo.id);
  assert.deepEqual(alpha.archivedFrom, { dbId: db.id, rowId: a.id, dbTitle: "Notes db" });
  assert.deepEqual(alpha.props.map((p) => [p.name, p.value]), [["Status", "Open"]]);
  assert.equal(alpha.blocks[0].text, "Alpha notes");
  // restoring while row pages are off -> a normal page; with row pages on and an empty row body -> back into the row
  await ws.setRowPages(db.id, true);
  const back = await ws.unarchivePage(alpha.id);
  assert.equal(back.row.id, a.id);
  assert.equal((await ws.getRow(a.id)).blocks[0].text, "Alpha notes");
  assert.equal(await ws.getPage(alpha.id), null);
  // delete = to Trash
  const r2 = await ws.setRowPages(db.id, false, { bodies: "trash" });
  assert.equal(r2.moved, 1);
  assert.ok((await ws.listTrash()).some((p) => p.title === "Alpha"));
  // legacy databases (no field) behave as on
  const legacy = { id: "legacy-db", type: "database", title: "Old", parentId: repo.id, columns: [{ id: "x", name: "Name", type: "text", config: {} }], createdAt: 1, updatedAt: 1 };
  await ws.store.set("pages", legacy.id, legacy);
  assert.equal((await ws.getPage("legacy-db")).rowPages, undefined);
});

test("vault: JSON keeps props, templates, archive flags, presets and rules; Markdown writes front matter", async () => {
  const { ws, repo } = await setup();
  const p = await ws.createPage({ title: "Spec", parentId: repo.id });
  const call = newBlock("callout", { text: "Careful" });
  call.preset = "warning";
  call.custom = { icon: "🔥" };
  p.blocks = [call];
  p.props = [{ id: "s", name: "Status", type: "select", options: ["Draft"], value: "Draft" }, { id: "t", name: "Tags", type: "multi", options: ["x"], value: ["x"] }];
  p.autoCallouts = [{ id: "r", when: { prop: "Status", op: "is", value: "Draft" }, preset: "info", text: "Draft" }];
  p.template = true;
  await ws.savePage(p);
  const old = await ws.createPage({ title: "Old", parentId: repo.id });
  await ws.archivePage(old.id);
  const dump = { pages: await ws.store.list("pages"), rows: await ws.store.list("rows") };
  const fresh = createWorkspace(createMemoryAdapter());
  await importFiles(fresh, toJsonFiles(dump));
  const got = await fresh.getPage(p.id);
  assert.deepEqual(got.props, p.props);
  assert.deepEqual(got.autoCallouts, p.autoCallouts);
  assert.equal(got.template, true);
  assert.deepEqual([got.blocks[0].preset, got.blocks[0].custom], ["warning", { icon: "🔥" }]);
  assert.ok((await fresh.getPage(old.id)).archivedAt);
  const md = toMarkdownFiles(dump);
  const spec = md.find((f) => f.path.endsWith("Spec.md"));
  assert.match(asText(spec.data), /^---\ntitle: "Spec"\nStatus: Draft\nTags: \["x"\]\n---/);
  assert.ok(!md.some((f) => f.path.endsWith("Old.md")), "archived pages are left out of Markdown, like the trash");
  const back = createWorkspace(createMemoryAdapter());
  await importFiles(back, md, { name: "Imported" });
  const imported = (await back.listPages()).find((x) => x.title === "Spec");
  assert.deepEqual(imported.props.map((x) => [x.name, x.value]), [["Status", "Draft"], ["Tags", ["x"]]]);
});
