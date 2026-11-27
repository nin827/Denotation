import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS, VALUES, sanitize, resolve, makeResolver, defaultPermissions, setPageValue, setBroadValue, ownValue, newer
} from "../public/js/permissions.js";

// repo > parent (doc) > page (doc), repo > db (database) with row r1
const pages = [
  { id: "repo", type: "repo", title: "Repo", parentId: null },
  { id: "parent", type: "doc", title: "Parent", parentId: "repo" },
  { id: "page", type: "doc", title: "Page", parentId: "parent" },
  { id: "db", type: "database", title: "DB", parentId: "repo", columns: [] }
];
const rows = [{ id: "r1", dbId: "db", values: {} }];
const perms = (broad, granular = {}) => ({ version: 1, broad: { read: broad, create: broad, edit: broad, delete: broad }, pages: granular, updatedAt: 1 });

test("default deny: no permissions, empty or junk input", () => {
  for (const p of [null, undefined, {}, "x", [], { broad: "yes" }]) {
    for (const a of ACTIONS) {
      const r = resolve(p, pages, rows, "page", a);
      assert.equal(r.allowed, false);
      assert.equal(r.value, "no");
    }
  }
  assert.equal(resolve(perms("yes"), pages, rows, "page", "launch").allowed, false, "unknown action is denied");
});

test("broad only: yes allows, no and ignore deny", () => {
  assert.deepEqual(resolve(perms("yes"), pages, rows, "page", "read"), { allowed: true, value: "yes", source: "broad", sourceId: null });
  assert.equal(resolve(perms("no"), pages, rows, "page", "read").allowed, false);
  const ig = resolve(perms("ignore"), pages, rows, "page", "read");
  assert.equal(ig.allowed, false);
  assert.equal(ig.source, "default");
  assert.equal(resolve(perms("yes"), pages, rows, null, "create").allowed, true, "workspace-level asks broad");
});

test("resolution matrix: broad x granular at page, parent and repo", () => {
  for (const broad of VALUES) {
    for (const level of ["page", "parent", "repo"]) {
      for (const g of VALUES) {
        const p = perms(broad, g === "ignore" ? { [level]: { read: "ignore" } } : { [level]: { read: g } });
        const r = resolve(p, pages, rows, "page", "read");
        const expected = g !== "ignore" ? g === "yes" : broad === "yes";
        assert.equal(r.allowed, expected, `broad=${broad} ${level}=${g}`);
        if (g !== "ignore") {
          assert.equal(r.sourceId, level);
          assert.equal(r.source, level === "page" ? "self" : "ancestor");
        } else {
          assert.equal(r.source, broad === "ignore" ? "default" : "broad");
        }
      }
    }
  }
});

test("nearest non-ignore ancestor wins", () => {
  const p = perms("no", { repo: { edit: "yes" }, parent: { edit: "no" } });
  assert.equal(resolve(p, pages, rows, "page", "edit").allowed, false);
  assert.equal(resolve(p, pages, rows, "parent", "edit").sourceId, "parent");
  assert.equal(resolve(p, pages, rows, "db", "edit").allowed, true);
  const q = perms("no", { repo: { edit: "no" }, page: { edit: "yes" } });
  assert.equal(resolve(q, pages, rows, "page", "edit").allowed, true);
  assert.equal(resolve(q, pages, rows, "parent", "edit").allowed, false);
  // actions are independent
  assert.equal(resolve(q, pages, rows, "page", "read").allowed, false);
});

test("rows inherit from their database, and can be overridden by id", () => {
  assert.equal(resolve(perms("no", { db: { read: "yes" } }), pages, rows, "r1", "read").allowed, true);
  assert.equal(resolve(perms("no", { repo: { read: "yes" } }), pages, rows, "r1", "read").sourceId, "repo");
  assert.equal(resolve(perms("yes", { db: { delete: "no" } }), pages, rows, "r1", "delete").allowed, false);
  assert.equal(resolve(perms("no", { db: { edit: "no" }, r1: { edit: "yes" } }), pages, rows, "r1", "edit").source, "self");
});

test("cycles and unknown ids fall back to broad without hanging", () => {
  const loop = [{ id: "a", type: "doc", parentId: "b" }, { id: "b", type: "doc", parentId: "a" }];
  assert.equal(resolve(perms("yes"), loop, [], "a", "read").allowed, true);
  assert.equal(resolve(perms("no", { b: { read: "yes" } }), loop, [], "a", "read").allowed, true);
  assert.equal(resolve(perms("yes"), pages, rows, "nope", "read").source, "broad");
  const r = makeResolver(perms("no", { repo: { read: "yes" } }), new Map(pages.map((p) => [p.id, p])), new Map(rows.map((x) => [x.id, x])));
  assert.equal(r("page", "read").allowed, true, "accepts Maps");
});

test("sanitize keeps only valid values and ids", () => {
  const s = sanitize({
    version: 9,
    broad: { read: "yes", create: "maybe", edit: "ignore" },
    pages: {
      good: { read: "no", edit: "yes", delete: "ignore", other: "yes" },
      empty: { read: "ignore" },
      "../bad": { read: "yes" },
      "has space": { read: "yes" },
      notobj: "yes"
    },
    updatedAt: "123",
    extra: true
  });
  assert.deepEqual(s, {
    version: 1,
    broad: { read: "yes", create: "no", edit: "ignore", delete: "no" },
    pages: { good: { read: "no", edit: "yes" } },
    updatedAt: 123
  });
  assert.deepEqual(sanitize(null), defaultPermissions());
  assert.equal(sanitize({ updatedAt: -5 }).updatedAt, 0);
  assert.equal(sanitize({ pages: { ["x".repeat(101)]: { read: "yes" } } }).pages["x".repeat(101)], undefined);
});

test("setPageValue / setBroadValue / newer", () => {
  let p = setPageValue(defaultPermissions(), "page", "read", "yes");
  assert.equal(ownValue(p, "page", "read"), "yes");
  p = setPageValue(p, "page", "read", "ignore");
  assert.equal(p.pages.page, undefined, "ignore removes the entry");
  assert.equal(ownValue(p, "page", "read"), "ignore");
  p = setBroadValue(p, "edit", "ignore");
  assert.equal(p.broad.edit, "ignore");
  assert.equal(setBroadValue(p, "edit", "bogus").broad.edit, "ignore");
  assert.equal(newer({ updatedAt: 5, broad: { read: "yes" } }, { updatedAt: 9 }).updatedAt, 9);
  assert.equal(newer({ updatedAt: 9, broad: { read: "yes" } }, { updatedAt: 9 }).broad.read, "yes");
});
