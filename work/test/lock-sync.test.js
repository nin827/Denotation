import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL, SIGNAL_KEY, KINDS, ACTIVE_EVERY_MS, parseSignal, reaction, createLockSync } from "../../source/app/js/lockSync.js";

// A BroadcastChannel stand-in: every instance of a name hears the others, never itself.
function fakeChannels() {
  const all = new Set();
  return class FakeChannel {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
      all.add(this);
    }
    postMessage(data) {
      for (const c of all) if (c !== this && c.name === this.name) c.onmessage?.({ data: structuredClone(data) });
    }
    close() {
      all.delete(this);
    }
  };
}
// Two "tabs" sharing one localStorage: setItem fires `storage` on the other tab's target only.
function fakeStorageTabs(n) {
  const data = new Map();
  const targets = Array.from({ length: n }, () => {
    const fns = new Set();
    return { addEventListener: (_t, f) => fns.add(f), removeEventListener: (_t, f) => fns.delete(f), fire: (e) => fns.forEach((f) => f(e)) };
  });
  const storageFor = (i) => ({
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      const old = data.get(k) ?? null;
      data.set(k, String(v));
      if (old !== String(v)) targets.forEach((t, j) => j !== i && t.fire({ key: k, newValue: String(v), oldValue: old }));
    }
  });
  return { targets, storageFor, data };
}

test("parseSignal accepts known kinds only", () => {
  for (const k of KINDS) assert.deepEqual(parseSignal({ kind: k, id: "a1" }), { kind: k, id: "a1" });
  assert.deepEqual(parseSignal(JSON.stringify({ kind: "lock", id: "x" })), { kind: "lock", id: "x" });
  for (const bad of [null, undefined, 3, "", "{", "lock", { kind: "unlock" }, { kind: "__proto__" }, { kind: ["lock"] }, []]) assert.equal(parseSignal(bad), null);
  assert.equal(parseSignal({ kind: "lock", id: 5 }).id, "");
});

test("reaction: what a tab does for each signal", () => {
  const R = (k, locked, hasPin) => reaction(k, { locked, hasPin });
  assert.equal(R("lock", false, true), "lock");
  assert.equal(R("lock", true, true), null); // already locked
  assert.equal(R("lock", false, false), null); // no PIN here (stale)
  assert.equal(R("pin-set", false, true), "lock");
  assert.equal(R("pin-set", true, true), "redraw");
  assert.equal(R("pin-set", false, false), null);
  assert.equal(R("pin-changed", false, true), "lock");
  assert.equal(R("pin-changed", true, true), "redraw");
  assert.equal(R("pin-removed", true, false), "reload");
  assert.equal(R("pin-removed", false, false), "refresh");
  assert.equal(R("pin-removed", true, true), null); // a PIN was set again since: stale
  assert.equal(R("active", false, true), "active");
  assert.equal(R("active", true, true), null); // activity elsewhere never unlocks
  assert.equal(R("nope", false, true), null);
});

test("BroadcastChannel transport: other tabs hear, the sender doesn't", () => {
  const Channel = fakeChannels();
  const a = createLockSync({ Channel, storage: null, target: null });
  const b = createLockSync({ Channel, storage: null, target: null });
  const c = createLockSync({ Channel, storage: null, target: null });
  assert.equal(a.transport, "broadcast");
  const got = { a: [], b: [], c: [] };
  a.onSignal((k) => got.a.push(k));
  b.onSignal((k) => got.b.push(k));
  const offC = c.onSignal((k) => got.c.push(k));
  a.send("pin-set");
  offC();
  b.send("lock");
  assert.deepEqual(got, { a: ["lock"], b: ["pin-set"], c: ["pin-set"] });
  assert.throws(() => a.send("unlock"));
  a.close();
  b.close();
  c.close();
});

test("storage fallback: a fresh value each time, delivered once", () => {
  const { targets, storageFor, data } = fakeStorageTabs(2);
  const a = createLockSync({ Channel: null, storage: storageFor(0), target: targets[0] });
  const b = createLockSync({ Channel: null, storage: storageFor(1), target: targets[1] });
  assert.equal(a.transport, "storage");
  const got = [];
  b.onSignal((k) => got.push(k));
  a.onSignal(() => assert.fail("the sender must not hear itself"));
  a.send("lock");
  a.send("lock"); // same kind again still reaches the other tab
  assert.deepEqual(got, ["lock", "lock"]);
  // A replayed value (same id) is ignored; other keys are ignored.
  targets[1].fire({ key: SIGNAL_KEY, newValue: data.get(SIGNAL_KEY) });
  targets[1].fire({ key: "denotion:prefs", newValue: JSON.stringify({ kind: "lock", id: "zz" }) });
  targets[1].fire({ key: SIGNAL_KEY, newValue: null });
  assert.deepEqual(got, ["lock", "lock"]);
  // Nothing but kind and id is written (never a PIN).
  assert.deepEqual(Object.keys(JSON.parse(data.get(SIGNAL_KEY))).sort(), ["id", "kind"]);
  b.close();
  targets[1].fire({ key: SIGNAL_KEY, newValue: JSON.stringify({ kind: "lock", id: "new" }) });
  assert.deepEqual(got, ["lock", "lock"]);
});

test("activity pings are throttled", () => {
  const Channel = fakeChannels();
  let t = 1000;
  const a = createLockSync({ Channel, storage: null, target: null, now: () => t });
  const b = createLockSync({ Channel, storage: null, target: null });
  const got = [];
  b.onSignal((k) => got.push(k));
  assert.equal(a.send("active"), true);
  t += ACTIVE_EVERY_MS - 1;
  assert.equal(a.send("active"), false);
  a.send("lock"); // other kinds are never throttled
  t += 1;
  assert.equal(a.send("active"), true);
  assert.deepEqual(got, ["active", "lock", "active"]);
});

test("no transport: send is a no-op, a throwing listener doesn't stop the others", () => {
  const none = createLockSync({ Channel: null, storage: null, target: null });
  assert.equal(none.transport, "none");
  assert.equal(none.send("lock"), false);
  const Channel = fakeChannels();
  const a = createLockSync({ Channel, storage: null, target: null });
  const b = createLockSync({ Channel, storage: null, target: null });
  const got = [];
  const err = console.error;
  console.error = () => {};
  b.onSignal(() => {
    throw new Error("boom");
  });
  b.onSignal((k) => got.push(k));
  a.send("pin-removed");
  console.error = err;
  assert.deepEqual(got, ["pin-removed"]);
  assert.equal(CHANNEL, "denotation-lock");
});
