// Ticket 016 follow-ups: stable table column ids, stub-aware freeze, background formula refresh, search resolver.
import test from "node:test";
import assert from "node:assert/strict";
import { newBlock, tableInsertCol, tableDeleteCol, tableResize, tableColIds, normalizeBlocks } from "../../source/app/js/blocks/model.js";
import { tableData, tableSourceOf } from "../../source/app/js/sources.js";
import { freezeCount, freezeOffsets } from "../../source/app/js/dbviews.js";
import { stubColumn } from "../../source/app/js/columns.js";
import { createWorkspace } from "../../source/app/js/workspace.js";
import { createMemoryAdapter } from "../../source/app/js/adapters/memory.js";
import { refreshFormulaCaches } from "../../source/app/js/formulaRefresh.js";
import { buildToken } from "../../source/app/js/blocks/inline.js";

const table = (header) => {
  const b = newBlock("table", { rows: 2, cols: header.length });
  b.cells[0] = [...header];
  b.cells[1] = header.map((h) => `${h}1`);
  return b;
};
const idsByName = (b) => Object.fromEntries(tableData(b).columns.map((c) => [c.name, c.id]));

// ---------- stable table column ids ----------
test("a fresh table keeps the positional ids and stores nothing", () => {
  const b = table(["A", "B", "C"]);
  assert.deepEqual(idsByName(b), { A: "c0", B: "c1", C: "c2" });
  assert.equal(b.colIds, undefined);
});
test("inserting a column keeps the ids of the others (old chips keep working)", () => {
  const b = table(["A", "B", "C"]);
  assert.ok(tableInsertCol(b, 1));
  b.cells[0][1] = "New";
  assert.deepEqual(idsByName(b), { A: "c0", New: "c3", B: "c1", C: "c2" });
  assert.deepEqual(b.cells[0], ["A", "New", "B", "C"]);
  assert.ok(tableInsertCol(b, 0));
  assert.equal(tableColIds(b).length, 5);
  assert.equal(new Set(tableColIds(b)).size, 5);
  assert.equal(idsByName({ ...b, cells: b.cells }).C, "c2");
});
test("deleting a column keeps the others and never reuses its id", () => {
  const b = table(["A", "B", "C"]);
  assert.ok(tableDeleteCol(b, 2));
  assert.deepEqual(idsByName(b), { A: "c0", B: "c1" });
  assert.ok(tableInsertCol(b, 2));
  b.cells[0][2] = "D";
  assert.equal(idsByName(b).D, "c3", "c2 belonged to the deleted column");
  assert.ok(tableDeleteCol(b, 0));
  assert.deepEqual(idsByName(b), { B: "c1", D: "c3" });
});
test("sourceKey follows its column and the key column id stays stable", () => {
  const b = table(["A", "B", "C"]);
  b.dataSource = true;
  b.sourceName = "T";
  b.sourceKey = 2;
  tableInsertCol(b, 0);
  assert.equal(b.sourceKey, 3);
  const src = tableSourceOf({ id: "p", title: "P" }, b);
  assert.equal(src.primaryKey, "c2");
  tableDeleteCol(b, 1);
  assert.equal(b.sourceKey, 2);
  assert.equal(tableSourceOf({ id: "p", title: "P" }, b).primaryKey, "c2");
});
test("resizing the column count keeps ids aligned", () => {
  const b = table(["A", "B", "C"]);
  tableResize(b, 2, 2); // drops C
  assert.deepEqual(idsByName(b), { A: "c0", B: "c1" });
  tableResize(b, 2, 3);
  b.cells[0][2] = "N";
  assert.equal(idsByName(b).N, "c3", "the dropped column's id is not reused");
  const g = table(["A", "B"]);
  tableResize(g, 2, 3); // growing a legacy table needs no stored ids
  assert.equal(g.colIds, undefined);
});
test("damaged colIds are dropped on clean, valid ones survive", () => {
  const bad = table(["A", "B"]);
  bad.colIds = ["x", "x"];
  const ok = table(["A", "B"]);
  ok.colIds = ["k1", "k2"];
  const short = table(["A", "B", "C"]);
  short.colIds = ["k1"];
  const weird = table(["A", "B"]);
  weird.colIds = ["a b", "<x>"];
  const out = normalizeBlocks([bad, ok, short, weird]);
  assert.equal(out[0].colIds, undefined);
  assert.deepEqual(out[1].colIds, ["k1", "k2"]);
  assert.equal(out[2].colIds, undefined);
  assert.equal(out[3].colIds, undefined);
  assert.deepEqual(Object.values(idsByName(out[1])), ["k1", "k2"]);
});
test("random insert / delete / resize sequences keep ids unique and tied to their cells", () => {
  let seed = 7;
  const rnd = (n) => (seed = (seed * 1664525 + 1013904223) >>> 0) % n;
  const b = table(["A", "B", "C"]);
  const label = new Map(tableColIds(b).map((id, i) => [id, `L${i}`]));
  b.cells[0] = tableColIds(b).map((id) => label.get(id));
  let k = 0;
  for (let step = 0; step < 300; step++) {
    const n = b.cells[0].length;
    const op = rnd(3);
    if (op === 0 && tableInsertCol(b, rnd(n + 1))) {
      const fresh = tableColIds(b).find((id) => !label.has(id));
      assert.ok(fresh, "an unused id was minted");
      label.set(fresh, `L${100 + k++}`);
      b.cells[0][tableColIds(b).indexOf(fresh)] = label.get(fresh);
    } else if (op === 1) tableDeleteCol(b, rnd(n));
    else if (op === 2) {
      const before = tableColIds(b);
      const c = 1 + rnd(8);
      tableResize(b, b.cells.length, c);
      for (const id of tableColIds(b)) if (!before.includes(id)) {
        assert.ok(!label.has(id), "resize never reuses an id");
        label.set(id, `R${k++}`);
        b.cells[0][tableColIds(b).indexOf(id)] = label.get(id);
      }
    }
    const ids = tableColIds(b);
    assert.equal(ids.length, b.cells[0].length);
    assert.equal(new Set(ids).size, ids.length);
    ids.forEach((id, i) => {
      if (label.get(id) && b.cells[0][i]) assert.equal(b.cells[0][i], label.get(id), `${id} still sits above its own header`);
    });
  }
});

// ---------- freeze with collapsed-group stubs ----------
test("freeze counts real columns: a stub is frozen only when everything it hides is inside the count", () => {
  const cols = [{ id: "a" }, stubColumn({ id: "g", label: "G" }, 2), { id: "d" }, { id: "e" }];
  assert.equal(freezeCount({ freeze: 0 }, cols), 0);
  assert.equal(freezeCount({ freeze: 1 }, cols), 1, "title only; the stub (2 columns) does not fit");
  assert.equal(freezeCount({ freeze: 2 }, cols), 1);
  assert.equal(freezeCount({ freeze: 3 }, cols), 2, "title + the whole group");
  assert.equal(freezeCount({ freeze: 4 }, cols), 3);
  assert.equal(freezeCount({ freeze: 99 }, cols), 4);
  const plain = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(freezeCount({ freeze: 2 }, plain), 2);
  assert.equal(freezeOffsets({ freeze: 3 }, cols, 38).length, 2);
});

// ---------- background formula refresh ----------
const sync = (fn) => fn(); // run steps at once in tests
async function setup() {
  const ws = createWorkspace(createMemoryAdapter());
  const repo = await ws.createPage({ type: "repo", title: "R" });
  repo.constants = [{ id: "k1", name: "rate", type: "number", value: 2 }];
  await ws.savePage(repo);
  const db = await ws.createPage({ type: "database", title: "D", parentId: repo.id });
  db.columns = [{ id: "n", name: "N", type: "number", config: {} }, { id: "f", name: "F", type: "formula", config: { expr: "[N] * rate" } }];
  await ws.savePage(db);
  const rows = await ws.createRows(db, Array.from({ length: 450 }, (_, i) => ({ n: i })));
  return { ws, repo, db, rows };
}
test("refreshFormulaCaches recomputes the caches of the repository's databases only", async () => {
  const { ws, repo, db } = await setup();
  const other = await ws.createPage({ type: "repo", title: "R2" });
  const odb = await ws.createPage({ type: "database", title: "O", parentId: other.id });
  odb.columns = db.columns;
  await ws.savePage(odb);
  const orows = await ws.createRows(odb, [{ n: 5 }]);
  repo.constants = [{ id: "k1", name: "rate", type: "number", value: 10 }];
  await ws.savePage(repo);
  const saved = await refreshFormulaCaches(ws, await ws.listPages(), repo.id, { schedule: sync });
  assert.equal(saved, 450);
  const fresh = await ws.listRows(db.id);
  assert.ok(fresh.every((r) => r.values.f === r.values.n * 10));
  assert.equal((await ws.listRows(odb.id))[0].values.f, null, "the other repository is untouched");
  assert.equal(orows.length, 1);
  assert.equal(await refreshFormulaCaches(ws, await ws.listPages(), repo.id, { schedule: sync }), 0, "second run changes nothing");
});
test("refreshFormulaCaches saves in chunks, yields between steps and stops when stale", async () => {
  const { ws, repo } = await setup();
  repo.constants = [{ id: "k1", name: "rate", type: "number", value: 3 }];
  await ws.savePage(repo);
  const batches = [];
  const orig = ws.saveRows;
  ws.saveRows = (rows) => (batches.push(rows.length), orig(rows));
  let yields = 0;
  await refreshFormulaCaches(ws, await ws.listPages(), repo.id, { schedule: (fn) => (yields++, fn()) });
  assert.deepEqual(batches, [200, 200, 50]);
  assert.ok(yields >= 3, "yields once per database and between chunks");
  batches.length = 0;
  repo.constants = [{ id: "k1", name: "rate", type: "number", value: 4 }];
  await ws.savePage(repo);
  let calls = 0;
  const saved = await refreshFormulaCaches(ws, await ws.listPages(), repo.id, { schedule: sync, isStale: () => ++calls > 3 });
  assert.ok(saved < 450, "a newer edit cancels the older run");
});
test("refreshFormulaCaches ignores linked views, trashed databases and missing repositories", async () => {
  const { ws, repo, db } = await setup();
  const view = await ws.createPage({ type: "database", title: "V", parentId: repo.id, sourceId: db.id });
  assert.ok(view.sourceId);
  assert.equal(await refreshFormulaCaches(ws, await ws.listPages(), "nope", { schedule: sync }), 0);
});

// ---------- search sees chip text ----------
test("search finds constant values, status labels and page-chip titles", async () => {
  const ws = createWorkspace(createMemoryAdapter());
  const repo = await ws.createPage({ type: "repo", title: "R" });
  repo.constants = [{ id: "k1", name: "launch", type: "text", value: "Zanzibar" }];
  repo.statuses = [{ id: "s1", label: "Blockedxyz", hue: 0 }];
  await ws.savePage(repo);
  const target = await ws.createPage({ title: "Quokka plan", parentId: repo.id });
  const doc = await ws.createPage({ title: "Host", parentId: repo.id });
  const p = newBlock("p");
  p.text = `value ${buildToken("const", ["k1"])} state ${buildToken("status", ["s1"])} see ${buildToken("page", [target.id])}`;
  doc.blocks = [p];
  await ws.savePage(doc);
  for (const q of ["zanzibar", "blockedxyz", "quokka"]) {
    const hits = await ws.search(q);
    assert.ok(hits.some((h) => h.id === doc.id), `"${q}" finds the host page`);
  }
  assert.ok(!(await ws.search("Constant")).some((h) => h.id === doc.id), "the generic fallback word is not indexed");
});
