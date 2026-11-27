// Seeded fuzz for the local adapter (adapters/local.js), extending work/test/local-cache.test.js: hostile record ids
// (prototype names, ':' and unicode), un-awaited interleavings of set / setMany / remove, writes from "another tab"
// straight into storage, and filters on arbitrary fields. Checked against a plain Map model after every step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzz, UNICODE, protoSnapshot, assertNoPollution } from "./fixtures/fuzz.js";
import { createLocalAdapter } from "../../source/app/js/adapters/local.js";

function memStorage() {
  const m = new Map();
  let keys = null;
  return {
    map: m,
    get length() { return m.size; },
    key(i) { keys ??= [...m.keys()]; return keys[i] ?? null; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (!m.has(k)) keys = null; m.set(k, String(v)); },
    removeItem(k) { if (m.delete(k)) keys = null; }
  };
}
const IDS = ["a", "b", "__proto__", "constructor", "toString", "x:y", "rows:z", "", " ", "é", "😀", "a/b", "hasOwnProperty", "0", "length"];

test("local adapter: hostile ids and un-awaited interleavings match a Map model", async () => {
  const before = protoSnapshot();
  await fuzz("local-model", 120, async (r) => {
    const s = memStorage();
    const fns = [];
    const win = { addEventListener: (t, f) => t === "storage" && fns.push(f) };
    const fire = (key) => fns.forEach((f) => f({ key, storageArea: s })); // another tab's write arrives as an event
    const a = createLocalAdapter(s, "t", { win });
    const model = { pages: new Map(), rows: new Map() };
    for (let step = 0; step < 40; step++) {
      const col = r.pick(["pages", "rows"]);
      const ops = [];
      for (let k = 0; k < r.int(1, 4); k++) {
        const id = r.chance(0.6) ? r.pick(IDS) : r.pick(UNICODE);
        const rec = { id, dbId: r.pick(["db1", "db2", "__proto__"]), v: r.int(0, 99), tag: r.pick(["x", "y"]) };
        const kind = r.int(0, 9);
        if (kind < 4) {
          ops.push(a.set(col, id, rec));
          model[col].set(id, rec);
        } else if (kind < 6) {
          const recs = Array.from({ length: r.int(1, 3) }, () => ({ ...rec, id: r.pick(IDS), v: r.int(0, 99) }));
          ops.push(a.setMany(col, recs));
          for (const x of recs) model[col].set(x.id, x);
        } else if (kind < 8) {
          ops.push(a.remove(col, id));
          model[col].delete(id);
        } else {
          // another tab writes or removes the raw value directly
          if (r.chance(0.5)) {
            s.setItem(`t:${col}:${id}`, JSON.stringify(rec));
            model[col].set(id, rec);
          } else {
            s.removeItem(`t:${col}:${id}`);
            model[col].delete(id);
          }
          fire(`t:${col}:${id}`);
        }
      }
      await Promise.all(ops);
      for (const c of ["pages", "rows"]) {
        const want = [...model[c].values()].map((x) => JSON.stringify(x)).sort();
        assert.deepEqual((await a.list(c)).map((x) => JSON.stringify(x)).sort(), want, `step ${step}: list(${c})`);
        const id = r.pick(IDS);
        assert.deepEqual(await a.get(c, id), model[c].get(id) ?? null, `step ${step}: get(${c}, ${JSON.stringify(id)})`);
      }
      const db = r.pick(["db1", "db2", "__proto__", "nope"]);
      const byDb = (await a.list("rows", { dbId: db })).map((x) => x.id).sort();
      assert.deepEqual(byDb, [...model.rows.values()].filter((x) => x.dbId === db).map((x) => x.id).sort(), `step ${step}: rows of ${db}`);
      const tag = r.pick(["x", "y"]);
      assert.deepEqual((await a.list("pages", { tag })).map((x) => x.id).sort(), [...model.pages.values()].filter((x) => x.tag === tag).map((x) => x.id).sort());
    }
  });
  assertNoPollution(before, "local adapter");
});

test("local adapter: one corrupt record (truncated JSON) doesn't make the whole collection unreadable", { todo: "BUG: list() JSON.parses every raw value without a guard; one corrupt localStorage record makes list('pages') throw, so the workspace can't load" }, async () => {
  const s = memStorage();
  const a = createLocalAdapter(s, "t", { win: null });
  await a.set("pages", "ok", { id: "ok", title: "fine" });
  s.setItem("t:pages:bad", '{"id":"bad","title":"trunc');
  const list = await a.list("pages");
  assert.deepEqual(list.map((p) => p.id), ["ok"]);
});
