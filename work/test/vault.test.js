import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../../source/app/js/adapters/memory.js";
import { createWorkspace } from "../../source/app/js/workspace.js";
import { newBlock } from "../../source/app/js/blocks/model.js";
import {
  toJsonFiles, toMarkdownFiles, importFiles, safeName, cleanPath, relPath, detectFormat, readMarkdownFile, asText, MANIFEST
} from "../../source/app/js/vault.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const byPath = (files) => new Map(files.map((f) => [f.path, f]));
const text = (files, p) => asText(byPath(files).get(p).data);
const sortById = (a) => [...a].sort((x, y) => x.id.localeCompare(y.id));

async function sample() {
  const ws = createWorkspace(createMemoryAdapter());
  const repo = await ws.createPage({ type: "repo", title: "My repo" });
  const a = await ws.createPage({ title: "Notes", parentId: repo.id });
  const b = await ws.createPage({ title: "notes", parentId: repo.id }); // duplicate (case-insensitive)
  const child = await ws.createPage({ title: 'Child: "quoted"?', parentId: a.id });
  const gone = await ws.createPage({ title: "Trashed", parentId: repo.id });
  await ws.trashPage(gone.id);
  const db = await ws.importCsv({ text: "Name,Count\nAlpha,1\nBeta,2\n", title: "Tasks", parentId: repo.id });
  const rows = await ws.listRows(db.db.id);
  rows[0].blocks = [newBlock("p", { text: "Alpha body" })];
  await ws.saveRow(rows[0]);
  a.blocks = [
    newBlock("h1", { text: "Heading" }),
    newBlock("p", { text: `See [the child](#page-${child.id}) and [row](#row-${rows[0].id}) and [gone](#page-${gone.id}).` }),
    newBlock("page", { ref: child.id }),
    newBlock("image", { src: `data:image/png;base64,${PNG}`, caption: "dot" })
  ];
  await ws.savePage(a);
  child.blocks = [newBlock("image", { src: `data:image/png;base64,${PNG}`, caption: "same" }), newBlock("page", { ref: a.id })];
  await ws.savePage(child);
  b.blocks = [newBlock("p", { text: "second" })];
  await ws.savePage(b);
  return { ws, repo, a, b, child, gone, db: db.db, rows };
}
const dump = async (ws) => ({ pages: await ws.store.list("pages"), rows: await ws.store.list("rows") });

test("safe names", () => {
  assert.equal(safeName('a<b>:c"d/e\\f|g?h*i'), "a b c d e f g h i");
  assert.equal(safeName("  ..hidden. "), "hidden");
  assert.equal(safeName(""), "Untitled");
  assert.equal(safeName("CON"), "_CON");
  assert.equal(safeName("lpt1.txt"), "_lpt1.txt");
  assert.equal([...safeName("x".repeat(300))].length, 80);
  assert.equal(safeName("Tag #1 [x]"), "Tag 1 x");
});

test("paths", () => {
  assert.equal(cleanPath("a/../b"), null);
  assert.equal(cleanPath("../x"), null);
  assert.equal(cleanPath("C:/x"), null);
  assert.equal(cleanPath("/a//b/./c.md"), "a/b/c.md");
  assert.equal(cleanPath("a\\b.md"), "a/b.md");
  assert.equal(relPath("A/B", "A/C/d.md"), "../C/d.md");
  assert.equal(relPath("", "attachments/x.png"), "attachments/x.png");
  assert.equal(relPath("A/B", "attachments/x.png"), "../../attachments/x.png");
});

test("JSON round trip into a fresh workspace", async () => {
  const { ws } = await sample();
  const before = await dump(ws);
  const files = toJsonFiles(before);
  assert.equal(JSON.parse(text(files, MANIFEST)).format, "json");
  assert.ok(files.some((f) => f.path.startsWith("pages/")) && files.some((f) => f.path.startsWith("rows/")));
  assert.equal(detectFormat(files).format, "json");
  const fresh = createWorkspace(createMemoryAdapter());
  const r = await importFiles(fresh, files);
  assert.equal(r.format, "json");
  const after = await dump(fresh);
  assert.deepEqual(sortById(after.pages), sortById(before.pages));
  assert.deepEqual(sortById(after.rows), sortById(before.rows));
});

test("JSON import inside a wrapper folder, skips bad records and unsafe paths", async () => {
  const { ws } = await sample();
  const files = toJsonFiles(await dump(ws)).map((f) => ({ path: `backup/${f.path}`, data: new TextEncoder().encode(f.data) }));
  files.push({ path: "backup/pages/bad.json", data: '{"id":"bad","type":"evil"}' });
  files.push({ path: "backup/pages/x.json", data: "not json" });
  files.push({ path: "../escape.json", data: "{}" });
  const fresh = createWorkspace(createMemoryAdapter());
  const r = await importFiles(fresh, files);
  assert.equal(r.format, "json");
  assert.equal(r.skipped, 3);
  assert.equal((await fresh.listPages()).length, (await ws.listPages()).length);
});

test("legacy single-file JSON is accepted", async () => {
  const { ws } = await sample();
  const legacy = await ws.exportAll();
  const fresh = createWorkspace(createMemoryAdapter());
  const r = await importFiles(fresh, [{ path: "denotion-2026-01-01.json", data: JSON.stringify(legacy) }]);
  assert.equal(r.format, "json");
  assert.equal(r.pages, legacy.pages.length);
  await assert.rejects(importFiles(fresh, [{ path: "x.json", data: JSON.stringify({ app: "denotion", pages: 1 }) }]), /Not a Denotation/);
});

test("Markdown export: layout, sanitising, duplicates, attachments, links", async () => {
  const { ws } = await sample();
  const files = toMarkdownFiles(await dump(ws));
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    "My repo/Notes.md",
    "My repo/Notes/Child quoted.md",
    "My repo/Tasks.csv",
    "My repo/Tasks/Alpha.md",
    "My repo/notes 2.md",
    "attachments/image-1.png"
  ].sort());
  assert.ok(!paths.some((p) => p.includes("Trashed")));
  const notes = text(files, "My repo/Notes.md");
  assert.match(notes, /^---\ntitle: "Notes"\n---\n/);
  assert.match(notes, /\[the child\]\(Notes\/Child%20quoted\.md\)/);
  assert.match(notes, /\[row\]\(Tasks\/Alpha\.md\)/);
  assert.match(notes, / and gone\./); // trashed target: link dropped, text kept
  assert.match(notes, /^\[Child: "quoted"\?\]\(Notes\/Child%20quoted\.md\)$/m);
  assert.match(notes, /!\[dot\]\(\.\.\/attachments\/image-1\.png\)/);
  const child = text(files, "My repo/Notes/Child quoted.md");
  assert.match(child, /title: "Child: \\"quoted\\"\?"/);
  assert.match(child, /!\[same\]\(\.\.\/\.\.\/attachments\/image-1\.png\)/); // de-duplicated
  assert.match(child, /\[Notes\]\(\.\.\/Notes\.md\)/);
  const png = byPath(files).get("attachments/image-1.png").data;
  assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const csv = text(files, "My repo/Tasks.csv");
  assert.match(csv, /^Name,Count\r\nAlpha,1\r\nBeta,2$/);
  assert.match(text(files, "My repo/Tasks/Alpha.md"), /Alpha body/);
});

test("Markdown round trip keeps structure, links and images", async () => {
  const { ws } = await sample();
  const files = toMarkdownFiles(await dump(ws));
  const fresh = createWorkspace(createMemoryAdapter());
  const r = await importFiles(fresh, files, { name: "vault.zip" });
  assert.equal(r.format, "markdown");
  const pages = await fresh.listPages();
  const repo = pages.find((p) => p.type === "repo");
  assert.equal(repo.title, "vault.zip");
  const notes = pages.find((p) => p.title === "Notes");
  const child = pages.find((p) => p.title === 'Child: "quoted"?');
  const tasks = pages.find((p) => p.title === "Tasks");
  assert.equal(notes.parentId, repo.id); // single wrapper folder "My repo" is dropped
  assert.equal(child.parentId, notes.id);
  assert.equal(tasks.type, "database");
  assert.ok(pages.find((p) => p.title === "notes")); // title restored from front-matter
  const rows = await fresh.listRows(tasks.id);
  assert.equal(rows.length, 2);
  const alpha = rows.find((x) => x.values[tasks.columns[0].id] === "Alpha");
  assert.equal(alpha.blocks[0].text, "Alpha body");
  assert.ok(notes.blocks.some((b) => b.type === "page" && b.ref === child.id));
  const para = notes.blocks.find((b) => b.type === "p");
  assert.ok(para.text.includes(`(#page-${child.id})`) && para.text.includes(`(#row-${alpha.id})`));
  const img = notes.blocks.find((b) => b.type === "image");
  assert.ok(img.src.startsWith("data:image/png;base64,"));
  assert.equal(r.images, 2);
});

test("Markdown import of a hand-made vault", async () => {
  const ws = createWorkspace(createMemoryAdapter());
  const files = [
    { path: "Home.md", data: "# Welcome home\n\nSee [[Projects/Plan|the plan]] and [csv](Data/People.csv).\n\n![[pic.png]]\n" },
    { path: "Projects/Projects.md", data: "---\ntags: [a]\ntitle: 'My projects'\n---\nFolder note body\n" },
    { path: "Projects/Plan.md", data: "Plain body, no title\n- [ ] todo\n" },
    { path: "Projects/Deep/Leaf.md", data: "leaf" },
    { path: "Data/People.csv", data: "Name,Age\nAda,36\nBob,40\n" },
    { path: "Data/People/Ada.md", data: "Ada's notes" },
    { path: "Data/People/Other.md", data: "not a row" },
    { path: "img/pic.png", data: Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0)) },
    { path: ".obsidian/workspace.json", data: "{}" },
    { path: "notes.pdf", data: new Uint8Array(3) }
  ];
  const r = await importFiles(ws, files, { name: "My vault" });
  assert.equal(r.format, "markdown");
  assert.equal(r.databases, 1);
  assert.equal(r.rows, 2);
  assert.equal(r.ignored, 1);
  const pages = await ws.listPages();
  const by = (t) => pages.find((p) => p.title === t);
  const repo = by("My vault");
  assert.equal(repo.type, "repo");
  const home = by("Welcome home"); // title from H1, removed from the body
  assert.equal(home.parentId, repo.id);
  assert.ok(!home.blocks.some((b) => b.type === "h1"));
  const projects = by("My projects"); // folder note X/X.md merges with the folder, title from front-matter
  assert.equal(projects.parentId, repo.id);
  assert.equal(projects.blocks[0].text, "Folder note body");
  const plan = by("Plan"); // title from the file name
  assert.equal(plan.parentId, projects.id);
  assert.equal(plan.blocks[1].type, "todo");
  const deep = by("Deep"); // folder without a note becomes an empty page
  assert.equal(by("Leaf").parentId, deep.id);
  assert.equal(deep.parentId, projects.id);
  const people = by("People");
  assert.equal(people.type, "database");
  assert.equal(by("Data").type, "doc");
  assert.equal(people.parentId, by("Data").id);
  const rows = await ws.listRows(people.id);
  const ada = rows.find((x) => x.values[people.columns[0].id] === "Ada");
  assert.equal(ada.blocks[0].text, "Ada's notes");
  assert.equal(by("Other").parentId, by("Data").id); // unmatched row file sits beside the database
  const para = home.blocks.find((b) => b.type === "p");
  assert.ok(para.text.includes(`[the plan](#page-${plan.id})`));
  assert.ok(para.text.includes(`[csv](#page-${people.id})`));
  assert.ok(home.blocks.some((b) => b.type === "image" && b.src.startsWith("data:image/png")));
  // importing again never clobbers: a second repository appears
  await importFiles(ws, files, { name: "My vault" });
  assert.equal((await ws.listPages()).filter((p) => p.type === "repo").length, 2);
});

test("front-matter and H1 title rules", () => {
  assert.deepEqual(readMarkdownFile("a/b.md", "---\ntitle: \"T\"\n---\n# H\nx"), { title: "T", body: "# H\nx" });
  assert.deepEqual(readMarkdownFile("a/b.md", "\n# H1 here\nbody"), { title: "H1 here", body: "body" });
  assert.equal(readMarkdownFile("a/b.md", "## not h1").title, "b");
});
test("legacy export written under either app name is accepted", async () => {
  const ws = createWorkspace(createMemoryAdapter());
  await ws.ensureRepository();
  const data = await ws.exportAll();
  assert.equal(data.app, "denotation");
  for (const app of ["denotation", "denotion"]) {
    const fresh = createWorkspace(createMemoryAdapter());
    const r = await importFiles(fresh, [{ path: "x.json", data: JSON.stringify({ ...data, app }) }]);
    assert.equal(r.pages, data.pages.length);
  }
});
