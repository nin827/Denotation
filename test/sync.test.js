import test from "node:test";
import assert from "node:assert/strict";
import { planSync, applyPlan, summarize, conflictCount, isNoop, keyOf, stamp, TOMBSTONE_TTL_MS, manifestStamp, sameStamp, bumpManifest } from "../public/js/sync.js";

const rec = (id, updatedAt, extra = {}) => ({ id, updatedAt, title: id, ...extra });
const ids = (list) => list.map((c) => `${c.collection}/${c.id}`).sort();
const NOW = 1_800_000_000_000;
const T = 10_000; // "now" for tests with small stamps (well inside the tombstone TTL)

test("merge: last write wins per record, both directions, new records copied", () => {
  const p = planSync({
    local: { pages: [rec("a", 100), rec("b", 300), rec("d", 10)], rows: [] },
    remote: { pages: [rec("a", 200), rec("b", 150), rec("c", 50)], rows: [rec("r", 5)] },
    now: NOW
  });
  assert.deepEqual(ids(p.toLocal), ["pages/a", "pages/c", "rows/r"]);
  assert.deepEqual(ids(p.toRemote), ["pages/b", "pages/d"]);
  assert.equal(p.deleteLocal.length + p.deleteRemote.length, 0);
  assert.equal(conflictCount(p), 0);
  assert.deepEqual(summarize(p), { pulled: 3, pushed: 2, deletedLocal: 0, deletedRemote: 0, deleted: 0 });
});

test("merge: equal timestamps change nothing; createdAt is the fallback stamp", () => {
  const p = planSync({ local: { pages: [rec("a", 100), { id: "b", createdAt: 7 }] }, remote: { pages: [rec("a", 100, { title: "other" }), { id: "b", createdAt: 7 }] } });
  assert.ok(isNoop(p));
  assert.equal(stamp({ createdAt: 7 }), 7);
  assert.equal(stamp({}), 0);
});

test("merge: a tombstone newer than every copy deletes both sides and is stored remotely", () => {
  const p = planSync({
    local: { pages: [rec("a", 100)] },
    remote: { pages: [rec("a", 120)] },
    localTombstones: [],
    remoteTombstones: [{ collection: "pages", id: "a", deletedAt: 150 }],
    now: T
  });
  assert.deepEqual(ids(p.deleteLocal), ["pages/a"]);
  assert.deepEqual(ids(p.deleteRemote), ["pages/a"]);
  assert.equal(p.writeTombstones.length, 0, "already stored");
  const q = planSync({ local: {}, remote: { pages: [rec("a", 120)] }, localTombstones: [{ collection: "pages", id: "a", deletedAt: 130 }], now: T });
  assert.deepEqual(ids(q.deleteRemote), ["pages/a"]);
  assert.deepEqual(q.writeTombstones, [{ collection: "pages", id: "a", deletedAt: 130 }]);
  assert.equal(q.forgetLocalTombstones.length, 1);
});

test("merge: delete wins a tie; an edit after the delete resurrects the record", () => {
  const tie = planSync({ local: { rows: [rec("x", 100)] }, remoteTombstones: [{ collection: "rows", id: "x", deletedAt: 100 }], now: T });
  assert.deepEqual(ids(tie.deleteLocal), ["rows/x"]);
  const res = planSync({ local: { rows: [rec("x", 101)] }, remoteTombstones: [{ collection: "rows", id: "x", deletedAt: 100 }], now: T });
  assert.deepEqual(ids(res.toRemote), ["rows/x"]);
  assert.deepEqual(res.removeTombstones, [{ collection: "rows", id: "x" }]);
  // Remote edited after a local delete: pulled back, local tombstone consumed, nothing written remotely.
  const back = planSync({ local: {}, remote: { rows: [rec("x", 200)] }, localTombstones: [{ collection: "rows", id: "x", deletedAt: 150 }], now: T });
  assert.deepEqual(ids(back.toLocal), ["rows/x"]);
  assert.equal(back.writeTombstones.length + back.deleteRemote.length, 0);
});

test("merge: tombstones older than the TTL are pruned (after being applied)", () => {
  const old = NOW - TOMBSTONE_TTL_MS - 1;
  const p = planSync({
    local: { pages: [rec("a", old - 5)] },
    remoteTombstones: [{ collection: "pages", id: "a", deletedAt: old }, { collection: "pages", id: "z", deletedAt: old }, { collection: "pages", id: "fresh", deletedAt: NOW - 1000 }],
    now: NOW
  });
  assert.deepEqual(ids(p.deleteLocal), ["pages/a"]);
  assert.deepEqual(ids(p.removeTombstones), ["pages/a", "pages/z"]);
  const q = planSync({ localTombstones: [{ collection: "pages", id: "o", deletedAt: old }], now: NOW });
  assert.equal(q.writeTombstones.length, 0, "an expired local delete is not written");
});

test("push: overwrites the remote side and reports newer remote state", () => {
  const p = planSync({
    direction: "push",
    local: { pages: [rec("same", 10), rec("mine", 50), rec("stale", 40), rec("revived", 30)] },
    remote: { pages: [rec("same", 10), rec("mine", 20), rec("stale", 90), rec("theirs", 70), rec("gone", 60), rec("gone2", 60)] },
    localTombstones: [{ collection: "pages", id: "gone", deletedAt: 80 }, { collection: "pages", id: "gone2", deletedAt: 55 }],
    remoteTombstones: [{ collection: "pages", id: "revived", deletedAt: 35 }],
    now: T
  });
  assert.deepEqual(ids(p.toRemote), ["pages/mine", "pages/revived", "pages/stale"]);
  assert.deepEqual(ids(p.deleteRemote), ["pages/gone", "pages/gone2", "pages/theirs"]);
  assert.deepEqual(p.conflicts.newerRemote.map((c) => `${c.id}:${c.reason}`).sort(), ["gone2:deleted-locally", "revived:deleted-remotely", "stale:newer", "theirs:only-remote"]);
  const stale = p.conflicts.newerRemote.find((c) => c.id === "stale");
  assert.equal(stale.localAt, 40);
  assert.equal(stale.remoteAt, 90);
  assert.equal(stale.remote.title, "stale");
  assert.equal(p.conflicts.olderRemote.length, 0);
  assert.deepEqual(p.removeTombstones, [{ collection: "pages", id: "revived" }]);
  const tomb = Object.fromEntries(p.writeTombstones.map((t) => [t.id, t.deletedAt]));
  assert.equal(tomb.gone, 80);
  assert.equal(tomb.gone2, T, "a forced delete of a newer copy is stamped now");
  assert.equal(tomb.theirs, T);
  assert.equal(p.toLocal.length + p.deleteLocal.length, 0, "push never changes local");
});

test("push without conflicts: deletes and writes, no warnings", () => {
  const p = planSync({
    direction: "push",
    local: { rows: [rec("a", 20)] },
    remote: { rows: [rec("a", 10), rec("b", 5)] },
    localTombstones: [{ collection: "rows", id: "b", deletedAt: 6 }, { collection: "rows", id: "c", deletedAt: 7 }],
    now: T
  });
  assert.equal(conflictCount(p), 0);
  assert.deepEqual(ids(p.toRemote), ["rows/a"]);
  assert.deepEqual(ids(p.deleteRemote), ["rows/b"]);
  assert.deepEqual(ids(p.writeTombstones), ["rows/b", "rows/c"]);
});

test("pull: overwrites this side and reports newer local state", () => {
  const p = planSync({
    direction: "pull",
    local: { pages: [rec("same", 10), rec("old", 20), rec("newer", 90), rec("only", 30), rec("edited", 70), rec("covered", 30)] },
    remote: { pages: [rec("same", 10), rec("old", 50), rec("newer", 40), rec("back", 60), rec("back2", 60), rec("stale", 5)] },
    localTombstones: [{ collection: "pages", id: "back", deletedAt: 80 }, { collection: "pages", id: "back2", deletedAt: 50 }],
    remoteTombstones: [{ collection: "pages", id: "edited", deletedAt: 65 }, { collection: "pages", id: "covered", deletedAt: 40 }, { collection: "pages", id: "stale", deletedAt: 9 }],
    now: NOW
  });
  assert.deepEqual(ids(p.toLocal), ["pages/back", "pages/back2", "pages/newer", "pages/old"]);
  assert.deepEqual(ids(p.deleteLocal), ["pages/covered", "pages/edited", "pages/only"]);
  assert.deepEqual(p.conflicts.olderRemote.map((c) => `${c.id}:${c.reason}`).sort(), ["back:deleted-locally", "edited:deleted-remotely", "newer:newer", "only:only-local"]);
  assert.equal(p.conflicts.newerRemote.length, 0);
  assert.equal(p.toRemote.length + p.deleteRemote.length + p.writeTombstones.length + p.removeTombstones.length, 0, "pull never writes remotely");
  assert.equal(p.forgetLocalTombstones.length, 2);
});

test("applyPlan: skips local changes when the record was edited after planning", async () => {
  const local = new Map([["pages/a", rec("a", 10)], ["pages/b", rec("b", 10)]]);
  const remote = new Map();
  const p = planSync({ direction: "pull", local: { pages: [...local.values()] }, remote: { pages: [rec("a", 5)] } });
  local.set("pages/a", rec("a", 99)); // edited while a dialog was open
  const io = {
    getLocal: async (c, id) => local.get(keyOf(c, id)) ?? null,
    putLocal: async (c, id, r) => void local.set(keyOf(c, id), r),
    removeLocal: async (c, id) => void local.delete(keyOf(c, id)),
    putRemote: async (c, id, r) => void remote.set(keyOf(c, id), r),
    removeRemote: async (c, id) => void remote.delete(keyOf(c, id))
  };
  const done = await applyPlan(p, io);
  assert.equal(local.get("pages/a").updatedAt, 99);
  assert.equal(local.has("pages/b"), false);
  assert.equal(done.skipped, 1);
  assert.equal(done.deletedLocal, 1);
});

// ---------- seeded fuzz: two devices sharing one folder converge in auto mode ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const byCol = (m) => {
  const out = { pages: [], rows: [] };
  for (const [k, r] of m) out[k.split("/")[0]].push(r);
  return out;
};
async function syncDevice(dev, folder, now) {
  const plan = planSync({ local: byCol(dev.cache), remote: byCol(folder.records), localTombstones: [...dev.tombs.values()], remoteTombstones: [...folder.tombs.values()], now });
  await applyPlan(plan, {
    getLocal: async (c, id) => dev.cache.get(keyOf(c, id)) ?? null,
    putLocal: async (c, id, r) => void dev.cache.set(keyOf(c, id), r),
    removeLocal: async (c, id) => void dev.cache.delete(keyOf(c, id)),
    putRemote: async (c, id, r) => void folder.records.set(keyOf(c, id), r),
    removeRemote: async (c, id) => void folder.records.delete(keyOf(c, id)),
    putTombstone: async (t) => void folder.tombs.set(keyOf(t.collection, t.id), t),
    removeTombstone: async (t) => void folder.tombs.delete(keyOf(t.collection, t.id)),
    forgetLocalTombstone: async (t) => void dev.tombs.delete(keyOf(t.collection, t.id))
  });
}
const snap = (m) => JSON.stringify([...m].sort(([a], [b]) => (a < b ? -1 : 1)));

for (const seed of [1, 2, 3, 42, 1234, 9001]) {
  test(`fuzz seed ${seed}: two devices + external edits converge; the last operation per record wins`, async () => {
    const r = rng(seed);
    let clock = 1000;
    let nextId = 0;
    const folder = { records: new Map(), tombs: new Map() };
    const devs = [{ cache: new Map(), tombs: new Map() }, { cache: new Map(), tombs: new Map() }];
    const truth = new Map(); // key -> { at, value | null }
    const pick = (arr) => arr[Math.floor(r() * arr.length)];
    for (let step = 0; step < 400; step++) {
      const roll = r();
      const dev = pick(devs);
      const col = r() < 0.5 ? "pages" : "rows";
      if (roll < 0.2) {
        const id = `n${nextId++}`;
        const at = ++clock;
        dev.cache.set(keyOf(col, id), rec(id, at, { v: at }));
        dev.tombs.delete(keyOf(col, id));
        truth.set(keyOf(col, id), { at, value: at });
      } else if (roll < 0.45 && dev.cache.size) {
        const k = pick([...dev.cache.keys()]);
        const at = ++clock;
        const [c, id] = k.split("/");
        dev.cache.set(k, rec(id, at, { v: at }));
        truth.set(k, { at, value: at, c });
      } else if (roll < 0.6 && dev.cache.size) {
        const k = pick([...dev.cache.keys()]);
        const at = ++clock;
        const [c, id] = k.split("/");
        dev.cache.delete(k);
        dev.tombs.set(k, { collection: c, id, deletedAt: at });
        truth.set(k, { at, value: null });
      } else if (roll < 0.68 && folder.records.size) {
        // external tool (MCP server) edits or deletes in the folder
        const k = pick([...folder.records.keys()]);
        const at = ++clock;
        const [c, id] = k.split("/");
        if (r() < 0.5) {
          folder.records.set(k, rec(id, at, { v: at }));
          truth.set(k, { at, value: at });
        } else {
          folder.records.delete(k);
          folder.tombs.set(k, { collection: c, id, deletedAt: at });
          truth.set(k, { at, value: null });
        }
      } else {
        await syncDevice(dev, folder, clock);
      }
    }
    for (let i = 0; i < 2; i++) for (const d of devs) await syncDevice(d, folder, clock);
    assert.equal(snap(devs[0].cache), snap(devs[1].cache), "devices agree");
    assert.equal(snap(devs[0].cache), snap(folder.records), "folder agrees");
    for (const [k, t] of truth) {
      const got = folder.records.get(k);
      if (t.value === null) assert.equal(got, undefined, `${k} should be deleted`);
      else assert.equal(got?.v, t.value, `${k} should hold the last edit`);
    }
    for (const d of devs) assert.equal(d.tombs.size, 0, "local tombstones are consumed");
  });
}

test("manifest stamp: bump keeps the format, increments rev, sets writer; any difference counts", () => {
  const first = bumpManifest(null, "w-a", 1000);
  assert.deepEqual(first, { app: "denotation", format: "json", version: 1, updatedAt: 1000, rev: 1, writer: "w-a" });
  const old = { app: "denotation", format: "json", version: 1, exportedAt: "2026-01-01T00:00:00.000Z", junk: "<x>", rev: 7, updatedAt: 5000, writer: "w-b" };
  const next = bumpManifest(old, "mcp-1", 2000);
  assert.deepEqual(next, { app: "denotation", format: "json", version: 1, exportedAt: old.exportedAt, updatedAt: 5001, rev: 8, writer: "mcp-1" }, "updatedAt never goes back; unknown keys dropped");
  assert.equal(manifestStamp(null), null);
  assert.deepEqual(manifestStamp({ rev: "3", writer: 5, updatedAt: "x" }), { rev: 3, writer: "", updatedAt: 0 });
  assert.deepEqual(manifestStamp({ app: "denotation" }), { rev: 0, writer: "", updatedAt: 0 }, "an unstamped manifest");
  const s = manifestStamp(next);
  assert.equal(sameStamp(s, manifestStamp({ ...next })), true);
  assert.equal(sameStamp(s, { ...s, rev: s.rev + 1 }), false);
  assert.equal(sameStamp(s, { ...s, writer: "other" }), false, "same rev from another writer is a change");
  assert.equal(sameStamp(s, { ...s, updatedAt: 1 }), false);
  assert.equal(sameStamp(null, null), true);
  assert.equal(sameStamp(null, s), false);
});
