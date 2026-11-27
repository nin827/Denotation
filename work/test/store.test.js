// store.js setManyIn and the adapters' setMany (memory, artifact-db fallback loop).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setManyIn } from "../../source/app/js/store.js";
import { createMemoryAdapter } from "../../source/app/js/adapters/memory.js";
import { createArtifactDbAdapter } from "../../source/app/js/adapters/artifact-db.js";

const recs = Array.from({ length: 40 }, (_, i) => ({ id: `r${i % 30}`, dbId: `d${i % 2}`, createdAt: i, values: { a: i } }));

test("setManyIn uses the adapter's setMany when there is one, else set() in order", async () => {
  const calls = [];
  const withMany = { setMany: async (c, list) => calls.push(["many", c, list.length]), set: async () => calls.push(["set"]) };
  await setManyIn(withMany, "rows", new Set(recs)); // any iterable
  assert.deepEqual(calls, [["many", "rows", 40]]);
  const order = [];
  await setManyIn({ set: async (c, id, r) => order.push([c, id, r.values.a]) }, "rows", recs);
  assert.deepEqual(order, recs.map((r) => ["rows", r.id, r.values.a]));
});

test("memory setMany equals N sets (last duplicate wins; stored as copies)", async () => {
  const a = createMemoryAdapter();
  const b = createMemoryAdapter();
  for (const r of recs) await a.set("rows", r.id, r);
  await b.setMany("rows", recs);
  const sort = (xs) => xs.sort((x, y) => (x.id < y.id ? -1 : 1));
  assert.deepEqual(sort(await b.list("rows")), sort(await a.list("rows")));
  assert.deepEqual(sort(await b.list("rows", { dbId: "d1" })), sort(await a.list("rows", { dbId: "d1" })));
  recs[0].values.a = "changed after saving";
  assert.equal((await b.get("rows", "r0")).values.a, 30);
  recs[0].values.a = 0;
});

test("artifact-db setMany writes each record through set(), in order", async () => {
  const docs = new Map();
  const writes = [];
  const db = {
    collection: (name) => ({
      doc: (id) => ({
        set: async (body) => {
          writes.push(id);
          docs.set(`${name}/${id}`, JSON.parse(JSON.stringify(body)));
        },
        get: async () => ({ exists: docs.has(`${name}/${id}`), data: () => docs.get(`${name}/${id}`), id }),
        delete: async () => docs.delete(`${name}/${id}`)
      })
    })
  };
  const claude = { use: async (what) => (what === "db" ? db : null) };
  const a = await createArtifactDbAdapter({ scope: "shared", claude });
  await a.setMany("rows", recs.slice(0, 5));
  assert.deepEqual(writes, ["r0", "r1", "r2", "r3", "r4"]);
  assert.deepEqual(await a.get("rows", "r3"), recs[3]);
});
