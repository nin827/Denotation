// local adapter: parsed-record cache, row index by dbId, setMany, write ordering and lock handling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalAdapter } from "../../source/app/js/adapters/local.js";
import { createKeyring, generateDek, encryptText, isEnvelope, decryptText } from "../../source/app/js/crypto.js";

// localStorage stand-in. key(i) follows insertion order like a Map; `fail(k)` can make setItem throw (quota).
function memStorage({ fail = null } = {}) {
  const m = new Map();
  let keys = null;
  const s = {
    map: m,
    gets: 0,
    get length() {
      return m.size;
    },
    key(i) {
      keys ??= [...m.keys()];
      return keys[i] ?? null;
    },
    getItem(k) {
      s.gets++;
      return m.has(k) ? m.get(k) : null;
    },
    setItem(k, v) {
      if (fail?.(k, v)) throw Object.assign(new Error("QuotaExceededError"), { name: "QuotaExceededError" });
      if (!m.has(k)) keys = null;
      m.set(k, String(v));
    },
    removeItem(k) {
      if (m.delete(k)) keys = null;
    },
    clear() {
      m.clear();
      keys = null;
    }
  };
  return s;
}
// A window stand-in that lets a test deliver `storage` events like another tab would.
function fakeWin() {
  const fns = [];
  return { addEventListener: (t, f) => t === "storage" && fns.push(f), fire: (e) => fns.forEach((f) => f(e)) };
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
async function encSetup(storage) {
  const keyring = createKeyring({ storage });
  keyring.saveSettings({ browser: "on" });
  const dek = await generateDek();
  keyring.setKey(dek);
  return { keyring, dek };
}
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const row = (id, dbId, v = 0) => ({ id, dbId, createdAt: 1, values: { a: v } });

test("same-tab set / remove are seen at once by get and list", async () => {
  const s = memStorage();
  const a = createLocalAdapter(s, "t", { win: null });
  await a.set("pages", "p1", { id: "p1", title: "one" });
  assert.equal((await a.get("pages", "p1")).title, "one");
  assert.deepEqual((await a.list("pages")).map((p) => p.title), ["one"]);
  await a.set("pages", "p1", { id: "p1", title: "two" });
  await a.set("pages", "p2", { id: "p2", title: "x" });
  assert.equal((await a.get("pages", "p1")).title, "two");
  assert.deepEqual((await a.list("pages")).map((p) => p.title).sort(), ["two", "x"]);
  await a.remove("pages", "p1");
  assert.equal(await a.get("pages", "p1"), null);
  assert.deepEqual((await a.list("pages")).map((p) => p.id), ["p2"]);
});

test("returned records are fresh objects: mutating them never changes the cache", async () => {
  const a = createLocalAdapter(memStorage(), "t", { win: null });
  const data = { id: "p", title: "keep", blocks: [{ id: "b", text: "x" }] };
  await a.set("pages", "p", data);
  data.title = "caller changed its own object after saving";
  const got = await a.get("pages", "p");
  assert.equal(got.title, "keep");
  got.title = "mutated";
  got.blocks[0].text = "mutated";
  const listed = (await a.list("pages"))[0];
  assert.equal(listed.title, "keep");
  assert.equal(listed.blocks[0].text, "x");
  listed.blocks.push({});
  assert.equal((await a.get("pages", "p")).blocks.length, 1);
  assert.notEqual(await a.get("pages", "p"), await a.get("pages", "p"));
});

test("a raw value changed behind the adapter is re-read (same key count, so only the raw compare sees it)", async () => {
  const s = memStorage();
  const a = createLocalAdapter(s, "t", { win: null });
  await a.set("rows", "r1", row("r1", "A", 1));
  assert.equal((await a.list("rows", { dbId: "A" }))[0].values.a, 1);
  s.setItem("t:rows:r1", JSON.stringify(row("r1", "A", 2))); // e.g. migrateBrowserCopy or another writer
  assert.equal((await a.get("rows", "r1")).values.a, 2);
  assert.equal((await a.list("rows", { dbId: "A" }))[0].values.a, 2);
  // moved to another database behind our back: never returned for the old one
  s.setItem("t:rows:r1", JSON.stringify(row("r1", "B", 3)));
  assert.deepEqual(await a.list("rows", { dbId: "A" }), []);
  assert.deepEqual((await a.list("rows", { dbId: "B" })).map((r) => r.id), ["r1"], "the read above moved it in the index");
});

test("keys added or removed behind the adapter are noticed by the key-count guard", async () => {
  const s = memStorage();
  const a = createLocalAdapter(s, "t", { win: null });
  await a.set("rows", "r1", row("r1", "A"));
  assert.equal((await a.list("rows", { dbId: "A" })).length, 1);
  s.setItem("t:rows:r2", JSON.stringify(row("r2", "A")));
  assert.deepEqual((await a.list("rows", { dbId: "A" })).map((r) => r.id).sort(), ["r1", "r2"]);
  assert.equal((await a.list("rows")).length, 2);
  s.removeItem("t:rows:r1");
  assert.deepEqual((await a.list("rows", { dbId: "A" })).map((r) => r.id), ["r2"]);
});

test("storage events from another tab rebuild the key sets and the row index", async () => {
  const s = memStorage();
  const win = fakeWin();
  const a = createLocalAdapter(s, "t", { win });
  await a.set("rows", "r1", row("r1", "A"));
  await a.set("pages", "p1", { id: "p1" });
  assert.equal((await a.list("rows", { dbId: "A" })).length, 1);
  assert.equal((await a.list("pages")).length, 1);
  // Another tab removes r1 and adds r2 (key count unchanged, so only the event tells us).
  s.removeItem("t:rows:r1");
  s.setItem("t:rows:r2", JSON.stringify(row("r2", "A")));
  s.removeItem("t:pages:p1");
  s.setItem("t:pages:p2", JSON.stringify({ id: "p2" }));
  win.fire({ key: "t:rows:r1", storageArea: s });
  win.fire({ key: "t:rows:r2", storageArea: s });
  win.fire({ key: "t:pages:p2", storageArea: s });
  assert.deepEqual((await a.list("rows", { dbId: "A" })).map((r) => r.id), ["r2"]);
  assert.deepEqual((await a.list("pages")).map((p) => p.id), ["p2"]);
  // clear() in another tab (key null)
  s.clear();
  s.setItem("t:pages:p9", JSON.stringify({ id: "p9" }));
  win.fire({ key: null, storageArea: s });
  assert.deepEqual((await a.list("pages")).map((p) => p.id), ["p9"]);
  assert.deepEqual(await a.list("rows", { dbId: "A" }), []);
  // Events for other storage areas or other prefixes are ignored (and harmless).
  win.fire({ key: "t:pages:p9", storageArea: {} });
  win.fire({ key: "other:x", storageArea: s });
  assert.deepEqual((await a.list("pages")).map((p) => p.id), ["p9"]);
});

test("encrypted browser copy: plaintext is cached only while unlocked; nothing stale after lock / unlock", async () => {
  const s = memStorage();
  const { keyring, dek } = await encSetup(s);
  const a = createLocalAdapter(s, "t", { keyring, win: null });
  await a.set("pages", "p", { id: "p", title: "secret" });
  assert.ok(isEnvelope(JSON.parse(s.map.get("t:pages:p"))));
  assert.equal((await a.get("pages", "p")).title, "secret");
  assert.ok(a.cacheSize > 0);
  keyring.lock();
  assert.equal(a.cacheSize, 0, "lock drops every cached record");
  await assert.rejects(a.get("pages", "p"), (e) => e.code === "locked");
  await assert.rejects(a.list("pages"), (e) => e.code === "locked");
  await assert.rejects(a.set("pages", "p", { id: "p" }), (e) => e.code === "locked");
  assert.equal(a.cacheSize, 0);
  // While locked another tab saves a newer version with the same key.
  s.setItem("t:pages:p", JSON.stringify(await encryptText(dek, keyring.kid, "pages", "p", JSON.stringify({ id: "p", title: "newer" }))));
  keyring.setKey(dek); // unlock
  assert.equal((await a.get("pages", "p")).title, "newer");
  assert.deepEqual((await a.list("pages")).map((p) => p.title), ["newer"]);
  // Changing to another key (adopt) also empties the cache.
  const before = a.cacheSize;
  assert.ok(before > 0);
  keyring.setKey(await generateDek());
  assert.equal(a.cacheSize, 0);
  await assert.rejects(a.get("pages", "p")); // the old envelope doesn't open with the other key
});

test("a lock during a decrypt hands the record over but doesn't keep it; dropCache() forgets everything", async () => {
  const s = memStorage();
  const { keyring, dek } = await encSetup(s);
  const a = createLocalAdapter(s, "t", { keyring, win: null });
  await a.set("rows", "r", row("r", "A"));
  a.dropCache();
  assert.equal(a.cacheSize, 0);
  const p = a.get("rows", "r");
  keyring.lock();
  assert.equal((await p).id, "r");
  assert.equal(a.cacheSize, 0);
  keyring.setKey(dek);
  assert.equal((await a.list("rows", { dbId: "A" })).length, 1);
  assert.ok(a.cacheSize > 0);
  a.dropCache();
  assert.equal(a.cacheSize, 0);
});

test("a half-migrated store (plain and encrypted values) reads the same through the cache", async () => {
  const s = memStorage();
  const { keyring, dek } = await encSetup(s);
  s.setItem("t:rows:p1", JSON.stringify(row("p1", "A", 1)));
  s.setItem("t:rows:e1", JSON.stringify(await encryptText(dek, keyring.kid, "rows", "e1", JSON.stringify(row("e1", "A", 2)))));
  const a = createLocalAdapter(s, "t", { keyring, win: null });
  assert.deepEqual((await a.list("rows", { dbId: "A" })).sort(byId).map((r) => r.values.a), [2, 1]);
  assert.deepEqual((await a.list("rows", { dbId: "A" })).sort(byId).map((r) => r.values.a), [2, 1]);
});

for (const enc of [false, true]) {
  test(`row index matches a naive scan under seeded random set / remove / outside writes / events (${enc ? "encrypted" : "plain"})`, async () => {
    const rnd = rng(enc ? 77 : 42);
    const s = memStorage();
    const win = fakeWin();
    const ks = enc ? await encSetup(s) : null;
    const a = createLocalAdapter(s, "t", { keyring: ks?.keyring ?? null, win });
    const dbs = ["A", "B", "C", "D", undefined];
    const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
    const naive = async (dbId, extra = {}) => {
      const out = [];
      for (const [k, raw] of s.map) {
        if (!k.startsWith("t:rows:")) continue;
        let v = JSON.parse(raw);
        if (isEnvelope(v)) v = JSON.parse(await decryptText(ks.dek, "rows", k.slice(7), v));
        if (v && v.dbId === dbId && Object.entries(extra).every(([x, y]) => v[x] === y)) out.push(v);
      }
      return out.sort(byId);
    };
    const outside = async (id, rec) => {
      const text = JSON.stringify(rec);
      s.setItem(`t:rows:${id}`, enc ? JSON.stringify(await encryptText(ks.dek, ks.keyring.kid, "rows", id, text)) : text);
    };
    for (let step = 0; step < 1500; step++) {
      const id = `r${Math.floor(rnd() * 60)}`;
      const op = rnd();
      if (op < 0.4) await a.set("rows", id, { ...row(id, pick(dbs), step), tag: step % 3 });
      else if (op < 0.5) await a.remove("rows", id);
      else if (op < 0.58) await a.setMany("rows", Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => {
        const j = `r${Math.floor(rnd() * 60)}`;
        return { ...row(j, pick(dbs), step), tag: step % 3 };
      }));
      else if (op < 0.63) {
        // another tab overwrites / adds a row and the event arrives
        await outside(id, { ...row(id, pick(dbs), -step), tag: 1 });
        win.fire({ key: `t:rows:${id}`, storageArea: s });
      } else if (op < 0.66) {
        s.removeItem(`t:rows:${id}`);
        win.fire({ key: `t:rows:${id}`, storageArea: s });
      } else if (op < 0.68) {
        // same-tab write around the adapter that only changes content (same dbId, key exists): raw compare covers it
        const cur = s.map.get(`t:rows:${id}`);
        if (cur) {
          let v = JSON.parse(cur);
          if (isEnvelope(v)) v = JSON.parse(await decryptText(ks.dek, "rows", id, v));
          await outside(id, { ...v, values: { a: "outside" } });
        }
      } else if (op < 0.7) {
        a.dropCache();
      } else {
        const dbId = pick(dbs);
        const extra = rnd() < 0.3 ? { tag: Math.floor(rnd() * 3) } : {};
        const got = (await a.list("rows", { dbId, ...extra })).sort(byId);
        assert.deepEqual(got, await naive(dbId, extra), `step ${step} dbId ${dbId}`);
      }
    }
    for (const dbId of dbs) assert.deepEqual((await a.list("rows", { dbId })).sort(byId), await naive(dbId));
  });
}

test("setMany gives the same storage as N awaited sets (duplicates: last wins), plain and encrypted", async () => {
  for (const enc of [false, true]) {
    const rnd = rng(enc ? 5 : 6);
    const recs = Array.from({ length: 300 }, (_, i) => ({ ...row(`r${Math.floor(rnd() * 120)}`, `db${i % 3}`, i), n: i }));
    const s1 = memStorage();
    const s2 = memStorage();
    const k1 = enc ? await encSetup(s1) : null;
    const k2 = enc ? { keyring: createKeyring({ storage: s2 }) } : null;
    if (enc) {
      k2.keyring.saveSettings({ browser: "on" });
      k2.keyring.setKey(k1.dek);
    }
    const a1 = createLocalAdapter(s1, "t", { keyring: k1?.keyring ?? null, win: null });
    const a2 = createLocalAdapter(s2, "t", { keyring: k2?.keyring ?? null, win: null });
    await a1.set("rows", "r0", row("r0", "old"));
    await a2.set("rows", "r0", row("r0", "old"));
    for (const r of recs) await a1.set("rows", r.id, r);
    await a2.setMany("rows", recs);
    const plain = async (s) => {
      const out = {};
      for (const [k, raw] of s.map) {
        if (!k.startsWith("t:rows:")) continue;
        const v = JSON.parse(raw);
        out[k] = isEnvelope(v) ? await decryptText(k1.dek, "rows", k.slice(7), v) : raw;
        if (enc) assert.ok(isEnvelope(v), "encrypted when the setting is on");
      }
      return out;
    };
    assert.deepEqual(await plain(s2), await plain(s1));
    for (const db of ["db0", "db1", "db2", "old"]) assert.deepEqual((await a2.list("rows", { dbId: db })).sort(byId), (await a1.list("rows", { dbId: db })).sort(byId));
  }
});

test("writes of one key land in call order even when encryption makes the first one slower", async () => {
  const s = memStorage();
  const { keyring } = await encSetup(s);
  const a = createLocalAdapter(s, "t", { keyring, win: null });
  // set -> set: the newer value wins
  await Promise.all([a.set("rows", "r", row("r", "A", 1)), a.set("rows", "r", row("r", "A", 2))]);
  assert.equal((await a.get("rows", "r")).values.a, 2);
  // set -> remove: stays removed (an encrypted write must not resurrect it)
  await Promise.all([a.set("rows", "r", row("r", "A", 3)), a.remove("rows", "r")]);
  assert.equal(await a.get("rows", "r"), null);
  assert.deepEqual(await a.list("rows", { dbId: "A" }), []);
  // setMany -> set / set -> setMany
  await Promise.all([a.setMany("rows", [row("r", "A", 4), row("q", "A", 4)]), a.set("rows", "r", row("r", "B", 5))]);
  assert.deepEqual([(await a.get("rows", "r")).values.a, (await a.get("rows", "q")).values.a], [5, 4]);
  await Promise.all([a.set("rows", "q", row("q", "A", 6)), a.setMany("rows", [row("q", "C", 7)])]);
  assert.equal((await a.get("rows", "q")).dbId, "C");
  assert.deepEqual((await a.list("rows", { dbId: "B" })).map((x) => x.id), ["r"]);
  assert.deepEqual((await a.list("rows", { dbId: "C" })).map((x) => x.id), ["q"]);
  // plain mode: no queue, the write is synchronous as before
  const p = memStorage();
  const b = createLocalAdapter(p, "t", { win: null });
  b.set("rows", "x", row("x", "A"));
  assert.ok(p.map.has("t:rows:x"), "written before the first await");
});

test("setMany: a failing write (quota) stops the ones after it; the cache and index stay true to storage", async () => {
  for (const enc of [false, true]) {
    let writes = 0;
    const s = memStorage({ fail: (k) => k.startsWith("t:rows:") && ++writes > 3 });
    const ks = enc ? await encSetup(s) : null;
    const a = createLocalAdapter(s, "t", { keyring: ks?.keyring ?? null, win: null });
    const recs = Array.from({ length: 6 }, (_, i) => row(`r${i}`, "A", i));
    await assert.rejects(a.setMany("rows", recs), /Quota/);
    assert.deepEqual([...s.map.keys()].filter((k) => k.startsWith("t:rows:")).sort(), ["t:rows:r0", "t:rows:r1", "t:rows:r2"]);
    assert.deepEqual((await a.list("rows", { dbId: "A" })).map((r) => r.id).sort(), ["r0", "r1", "r2"]);
    // locked + encrypted: refused before anything is written
    if (enc) {
      ks.keyring.lock();
      writes = -100;
      await assert.rejects(a.setMany("rows", [row("z", "A")]), (e) => e.code === "locked");
      assert.equal(s.map.has("t:rows:z"), false);
    }
  }
});

test("the cache avoids re-reading: a second listPages parses nothing new (plain) and decrypts nothing (encrypted)", async () => {
  const s = memStorage();
  const { keyring } = await encSetup(s);
  const a = createLocalAdapter(s, "t", { keyring, win: null });
  for (let i = 0; i < 20; i++) await a.set("pages", `p${i}`, { id: `p${i}`, title: `T${i}` });
  a.dropCache();
  const orig = globalThis.crypto.subtle.decrypt;
  let decrypts = 0;
  globalThis.crypto.subtle.decrypt = function (...args) {
    decrypts++;
    return orig.apply(this, args);
  };
  try {
    await a.list("pages");
    assert.equal(decrypts, 20);
    await a.list("pages");
    await a.get("pages", "p3");
    assert.equal(decrypts, 20, "served from the cache");
    await a.set("pages", "p3", { id: "p3", title: "new" });
    assert.equal((await a.get("pages", "p3")).title, "new");
    assert.equal(decrypts, 20, "a write fills the cache with its own plaintext");
  } finally {
    globalThis.crypto.subtle.decrypt = orig;
  }
});

test("concurrent ops (not awaited) on an encrypted copy: last call per key wins and the index stays exact", async () => {
  const rnd = rng(99);
  const s = memStorage();
  const ks = await encSetup(s);
  const a = createLocalAdapter(s, "t", { keyring: ks.keyring, win: null });
  const model = new Map(); // id -> record | null, in call order
  const dbs = ["A", "B", "C"];
  for (let round = 0; round < 60; round++) {
    const ops = [];
    const lists = [];
    for (let i = 0; i < 25; i++) {
      const id = `r${Math.floor(rnd() * 30)}`;
      const x = rnd();
      if (x < 0.45) {
        const r = row(id, dbs[Math.floor(rnd() * 3)], round * 100 + i);
        model.set(id, r);
        ops.push(a.set("rows", id, r));
      } else if (x < 0.6) {
        model.set(id, null);
        ops.push(a.remove("rows", id));
      } else if (x < 0.8) {
        const batch = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, j) => row(`r${Math.floor(rnd() * 30)}`, dbs[Math.floor(rnd() * 3)], -(round * 100 + i * 10 + j)));
        for (const r of batch) model.set(r.id, r);
        ops.push(a.setMany("rows", batch));
      } else {
        if (rnd() < 0.3) a.dropCache();
        lists.push(a.list("rows", { dbId: dbs[Math.floor(rnd() * 3)] })); // results mid-flight may be either side of a write
      }
    }
    await Promise.all([...ops, ...lists]);
    for (const db of dbs) {
      const want = [...model.values()].filter((r) => r && r.dbId === db).sort(byId);
      assert.deepEqual((await a.list("rows", { dbId: db })).sort(byId), want, `round ${round} db ${db}`);
    }
    for (const [id, r] of model) assert.deepEqual(await a.get("rows", id), r);
  }
});
