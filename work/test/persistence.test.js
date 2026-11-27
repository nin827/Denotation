import { test } from "node:test";
import assert from "node:assert/strict";

const { makePersistence } = await import("../../source/app/js/ui/pageView.js").catch(() => ({}));

function mk(l, t) {
  return {
    addEventListener: (k, f) => (l.get(t + k) || l.set(t + k, new Set()).get(t + k)).add(f),
    removeEventListener: (k, f) => l.get(t + k)?.delete(f)
  };
}
const fakeWin = () => {
  const l = new Map();
  return {
    ...mk(l, "win"),
    document: { visibilityState: "visible", ...mk(l, "doc") },
    fire: (k, t = "win") => [...(l.get(t + k) || [])].forEach((f) => f()),
    count: () => [...l.values()].reduce((n, s) => n + s.size, 0)
  };
};

test("hide events flush pending saves, then afterFlush; dispose removes listeners", { skip: !makePersistence }, async () => {
  const saved = [];
  const ws = { savePage: async (c) => void saved.push(c.id), saveRow: async () => {} };
  const win = fakeWin();
  let after = 0;
  const p = makePersistence(ws, { win, afterFlush: () => void after++ });
  p.persist({ id: "a" });
  win.fire("pagehide");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(saved, ["a"]);
  assert.equal(after, 1);
  p.persist({ id: "b" });
  win.document.visibilityState = "hidden";
  win.fire("visibilitychange", "doc");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(saved, ["a", "b"]);
  p.dispose();
  assert.equal(win.count(), 0);
});
