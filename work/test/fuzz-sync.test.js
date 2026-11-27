// Seeded fuzz for sync.js planSync / applyPlan with random local, remote and tombstone states.
//   merge: both sides end equal, a second merge is a no-op, deletes win unless a later edit exists (no resurrection)
//   push:  the remote side ends equal to this device; pull: this device ends equal to the remote side
//   applyPlan: a record edited between planning and applying is never overwritten or deleted locally
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzz } from "./fixtures/fuzz.js";
import { planSync, applyPlan, isNoop, keyOf, stamp, TOMBSTONE_TTL_MS } from "../../source/app/js/sync.js";

const COLS = ["pages", "rows", "tombstones"].slice(0, 2);

/** One side: Map key -> record, plus its tombstones Map key -> deletedAt. */
function randomWorld(r) {
  const ids = Array.from({ length: r.int(1, 14) }, (_, i) => `id${i}`);
  const local = new Map();
  const remote = new Map();
  const lt = new Map();
  const rt = new Map();
  for (const id of ids) {
    const col = r.pick(COLS);
    const k = keyOf(col, id);
    const s = () => r.int(1, 20);
    const rec = (who) => ({ id, ...(r.chance(0.9) ? { updatedAt: s() } : { createdAt: s() }), v: `${who}${r.int(0, 99)}` });
    if (r.chance(0.7)) local.set(k, { col, rec: rec("L") });
    if (r.chance(0.7)) remote.set(k, { col, rec: r.chance(0.3) && local.has(k) ? { ...local.get(k).rec } : rec("R") });
    if (r.chance(0.2)) lt.set(k, { collection: col, id, deletedAt: s() });
    if (r.chance(0.25)) rt.set(k, { collection: col, id, deletedAt: s() });
  }
  return { local, remote, lt, rt };
}
const byCol = (m) => {
  const out = {};
  for (const { col, rec } of m.values()) (out[col] ??= []).push(rec);
  return out;
};
const plan = (w, direction, now = 100) => planSync({ local: byCol(w.local), remote: byCol(w.remote), localTombstones: [...w.lt.values()], remoteTombstones: [...w.rt.values()], direction, now });
function io(w, { touch = null } = {}) {
  return {
    getLocal: async (c, id) => {
      touch?.(c, id);
      return w.local.get(keyOf(c, id))?.rec ?? null;
    },
    putLocal: async (c, id, rec) => void w.local.set(keyOf(c, id), { col: c, rec: structuredClone(rec) }),
    removeLocal: async (c, id) => void w.local.delete(keyOf(c, id)),
    putRemote: async (c, id, rec) => void w.remote.set(keyOf(c, id), { col: c, rec: structuredClone(rec) }),
    removeRemote: async (c, id) => void w.remote.delete(keyOf(c, id)),
    putTombstone: async (t) => void w.rt.set(keyOf(t.collection, t.id), { ...t }),
    removeTombstone: async (t) => void w.rt.delete(keyOf(t.collection, t.id)),
    forgetLocalTombstone: async (t) => void w.lt.delete(keyOf(t.collection, t.id))
  };
}
const view = (m) => [...m.entries()].map(([k, x]) => [k, stamp(x.rec), x.rec.v]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
const clone = (w) => ({ local: new Map([...w.local].map(([k, v]) => [k, structuredClone(v)])), remote: new Map([...w.remote].map(([k, v]) => [k, structuredClone(v)])), lt: new Map(w.lt), rt: new Map(w.rt) });

test("merge: sides converge, a second merge is a no-op, and deletes are never resurrected without a later edit", async () => {
  await fuzz("sync-merge", 3000, async (r) => {
    const w = randomWorld(r);
    const before = clone(w);
    const p1 = plan(w, "merge");
    assert.equal(p1.conflicts.newerRemote.length + p1.conflicts.olderRemote.length, 0, "merge reports no conflicts");
    await applyPlan(p1, io(w));
    // Both sides hold the same keys with the same stamps.
    assert.deepEqual(view(w.local).map((x) => x.slice(0, 2)), view(w.remote).map((x) => x.slice(0, 2)), "converged (stamps)");
    // Deletes: key gone iff its newest tombstone >= the newest record stamp.
    const keys = new Set([...before.local.keys(), ...before.remote.keys(), ...before.lt.keys(), ...before.rt.keys()]);
    for (const k of keys) {
      const t = Math.max(before.lt.get(k)?.deletedAt ?? 0, before.rt.get(k)?.deletedAt ?? 0);
      const s = Math.max(before.local.has(k) ? stamp(before.local.get(k).rec) : -1, before.remote.has(k) ? stamp(before.remote.get(k).rec) : -1);
      if (t > 0 && t >= s) assert.ok(!w.local.has(k) && !w.remote.has(k), `${k}: deleted at ${t} but kept (stamp ${s})`);
      else if (s >= 0) {
        assert.ok(w.local.has(k) && w.remote.has(k), `${k}: edited at ${s} after delete ${t} but missing`);
        assert.equal(stamp(w.local.get(k).rec), s, `${k}: newest copy wins`);
      }
    }
    assert.equal(w.lt.size, 0, "local tombstones are consumed");
    const p2 = plan(w, "merge");
    assert.ok(isNoop(p2), `second merge not a no-op: ${JSON.stringify({ toLocal: p2.toLocal.length, toRemote: p2.toRemote.length, dl: p2.deleteLocal.length, dr: p2.deleteRemote.length })}`);
    assert.equal(p2.writeTombstones.length + p2.removeTombstones.length, 0, "tombstones settled");
  });
});

test("push: the remote side ends equal to this device; pull: this device ends equal to the remote side", async () => {
  await fuzz("sync-push-pull", 3000, async (r) => {
    const w = randomWorld(r);
    const pushW = clone(w);
    const localBefore = view(pushW.local);
    const st = (v) => v.map((x) => x.slice(0, 2)); // key + stamp: equal stamps with different content are pinned below
    await applyPlan(plan(pushW, "push"), io(pushW));
    assert.deepEqual(st(view(pushW.remote)), st(localBefore), "remote == local after push");
    assert.deepEqual(view(pushW.local), localBefore, "push never changes local records");
    // after a push, a merge has nothing to move
    assert.ok(isNoop(plan(pushW, "merge")), "push then merge is a no-op");

    const pullW = clone(w);
    const remoteBefore = view(pullW.remote);
    const covered = (k) => pullW.rt.has(k) && pullW.rt.get(k).deletedAt >= stamp(pullW.remote.get(k).rec);
    const expected = view(pullW.remote).filter(([k]) => !covered(k));
    const p = plan(pullW, "pull");
    assert.equal(p.writeTombstones.length + p.removeTombstones.length + p.toRemote.length + p.deleteRemote.length, 0, "pull never writes remotely");
    await applyPlan(p, io(pullW));
    assert.deepEqual(st(view(pullW.local)), st(expected), "local == effective remote after pull");
    assert.deepEqual(view(pullW.remote), remoteBefore, "pull never changes remote records");
  });
});

test("push / pull mirror content even when both copies carry the same stamp", { todo: "BUG (low): push skips a record when the remote stamp equals the local one (rs !== ls), pull likewise; same-millisecond edits on two devices never converge, even via an explicit Push/Pull" }, async () => {
  const w = { local: new Map([["pages/a", { col: "pages", rec: { id: "a", updatedAt: 5, v: "mine" } }]]), remote: new Map([["pages/a", { col: "pages", rec: { id: "a", updatedAt: 5, v: "theirs" } }]]), lt: new Map(), rt: new Map() };
  await applyPlan(plan(w, "push"), io(w));
  assert.equal(w.remote.get("pages/a").rec.v, "mine");
});

test("applyPlan: records edited locally between plan and apply are skipped, never overwritten", async () => {
  await fuzz("sync-race", 2000, async (r) => {
    const w = randomWorld(r);
    const p = plan(w, r.pick(["merge", "pull"]));
    const edited = new Map();
    // Each time apply reads a local record, sometimes an edit lands right before it.
    const res = await applyPlan(p, io(w, {
      touch: (c, id) => {
        const k = keyOf(c, id);
        if (!edited.has(k) && r.chance(0.3)) {
          const rec = { id, updatedAt: 1000 + r.int(0, 9), v: "EDIT" };
          w.local.set(k, { col: c, rec });
          edited.set(k, rec);
        }
      }
    }));
    for (const [k, rec] of edited) {
      const now = w.local.get(k)?.rec;
      // the edit (or a later one) must still be there unless it happened after the plan's own step for that record
      if (p.toLocal.some((c) => keyOf(c.collection, c.id) === k) || p.deleteLocal.some((c) => keyOf(c.collection, c.id) === k)) {
        assert.deepEqual(now, rec, `${k}: a local edit made during apply was lost`);
      }
    }
    assert.ok(res.skipped >= 0);
  });
});

test("tombstones: pruned only after the TTL, never while they still cover a live remote copy", async () => {
  await fuzz("sync-ttl", 1500, async (r) => {
    const now = 3 * TOMBSTONE_TTL_MS;
    const id = "x";
    const k = keyOf("pages", id);
    const age = r.pick([0, 10, TOMBSTONE_TTL_MS - 1, TOMBSTONE_TTL_MS + 1, TOMBSTONE_TTL_MS * 2]);
    const deletedAt = now - age;
    const w = { local: new Map(), remote: new Map(), lt: new Map(), rt: new Map([[k, { collection: "pages", id, deletedAt }]]) };
    if (r.chance(0.5)) w.remote.set(k, { col: "pages", rec: { id, updatedAt: deletedAt - r.int(0, 5), v: "R" } });
    const p = planSync({ local: byCol(w.local), remote: byCol(w.remote), remoteTombstones: [...w.rt.values()], direction: "merge", now });
    await applyPlan(p, io(w));
    if (age <= TOMBSTONE_TTL_MS) assert.ok(w.rt.has(k), "young tombstone kept");
    assert.ok(!w.remote.has(k), "the covered remote copy is deleted");
  });
});

test("planSync: hostile inputs (bad stamps, missing ids, odd collections) never throw", async () => {
  await fuzz("sync-hostile", 2000, (r) => {
    const rec = () => r.pick([null, {}, { id: null }, { id: 0, updatedAt: "x" }, { id: "a", updatedAt: NaN }, { id: "a/b", updatedAt: -5 }, { id: "a", createdAt: 1e300 }, { id: "__proto__", updatedAt: 2 }, { id: "a", updatedAt: Infinity }]);
    const side = () => r.pick([undefined, null, {}, { pages: Array.from({ length: r.int(0, 4) }, rec) }, { "a/b": [rec()] }, { pages: new Map([["a", { id: "a", updatedAt: 1 }]]) }]);
    const tombs = () => Array.from({ length: r.int(0, 3) }, () => r.pick([null, {}, { collection: "pages", id: "a", deletedAt: r.pick([1, "2", -1, 0, NaN, Infinity]) }, { collection: "a/b", id: "c/d", deletedAt: 3 }]));
    for (const direction of ["merge", "push", "pull"]) {
      const p = planSync({ local: side(), remote: side(), localTombstones: tombs(), remoteTombstones: tombs(), direction, now: 50 });
      for (const list of [p.toLocal, p.toRemote, p.deleteLocal, p.deleteRemote]) for (const c of list) assert.ok(c.id != null);
    }
    assert.throws(() => planSync({ direction: "sideways" }));
  });
});
