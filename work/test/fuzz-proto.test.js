// Seeded fuzz: prototype pollution through every path that merges or copies untrusted JSON (imports, prefs,
// permissions, the sync manifest, page properties, Custom-column types and values, sync plans, MCP-shared code).
// Each test snapshots Object/Array/Function/String prototypes and checks nothing new appeared.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzz, PROTO_JSON, protoSnapshot, assertNoPollution } from "./fixtures/fuzz.js";
import { sanitizePrefs } from "../../source/app/js/prefs.js";
import { sanitize as sanitizePerms, makeResolver, setPageValue, newer } from "../../source/app/js/permissions.js";
import { bumpManifest, planSync, manifestStamp } from "../../source/app/js/sync.js";
import { cleanProps, valuesFromProps, propsFromFrontMatter } from "../../source/app/js/pageProps.js";
import { parseType, specOf, validate, clamp, defaultFor, getPath, summary, leafPaths } from "../../source/app/js/typespec.js";
import { fromJsonFiles, checkLegacy, importFiles, toJsonFiles } from "../../source/app/js/vault.js";
import { createWorkspace } from "../../source/app/js/workspace.js";
import { createMemoryAdapter } from "../../source/app/js/adapters/memory.js";
import { sanitizeKeyFile, sanitizeSettings, encFields } from "../../source/app/js/crypto.js";
import { cleanRules } from "../../source/app/js/autoCallouts.js";
import { reconcile, validate as validateCell } from "../../source/app/js/schema.js";

const KEYS = ["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "__defineGetter__", "isAdmin", "polluted"];
/** A random object tree that uses dangerous keys, built through JSON.parse (like any imported file). */
function hostile(r, depth = 0) {
  if (depth > 3 || r.chance(0.25)) return r.pick([1, "x", null, true, [], {}]);
  if (r.chance(0.2)) return JSON.parse(r.pick(PROTO_JSON));
  const parts = Array.from({ length: r.int(1, 5) }, () => `${JSON.stringify(r.pick(KEYS))}:${JSON.stringify(hostile(r, depth + 1))}`);
  return JSON.parse(`{${parts.join(",")}}`);
}
const objOnly = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const asJsonObj = (r, base) => JSON.parse(JSON.stringify({ ...base, ...hostile(r) }).replace(/^\{/, `{"__proto__":${JSON.stringify(hostile(r))},`));

test("prefs.sanitizePrefs: hostile objects give plain prefs and pollute nothing", async () => {
  const before = protoSnapshot();
  await fuzz("proto-prefs", 1500, (r) => {
    const p = sanitizePrefs(asJsonObj(r, { mode: "dark", accent: r.pick(["random", "grey", 15, "__proto__"]), fontSize: r.pick([5, "16", NaN, 99]) }));
    assert.equal(Object.getPrototypeOf(p), Object.prototype);
    assert.deepEqual(Object.keys(p).sort(), ["accent", "customFont", "font", "fontSize", "headingIntercept", "headingStep", "mode", "remoteImages", "sidebarLocked"]);
  });
  assertNoPollution(before, "prefs");
});

test("permissions.sanitize / resolver: dangerous page ids are never granted by inheritance from Object.prototype", async () => {
  const before = protoSnapshot();
  await fuzz("proto-perms", 1500, (r) => {
    const raw = { broad: hostile(r), pages: hostile(r), updatedAt: r.pick([1, "2", {}, -1]) };
    if (r.chance(0.5)) raw.pages = JSON.parse(`{"__proto__":{"read":"yes"},"constructor":{"read":"yes"},"toString":{"edit":"yes"}}`);
    const p = sanitizePerms(raw);
    assert.equal(Object.getPrototypeOf(p.pages), Object.prototype);
    for (const v of Object.values(p.pages)) for (const a of Object.values(v)) assert.ok(a === "yes" || a === "no");
    const can = makeResolver(p, [{ id: "constructor", parentId: null }, { id: "toString", parentId: "constructor" }, { id: "plain", parentId: null }], []);
    for (const id of ["constructor", "toString", "valueOf", "hasOwnProperty", "plain", "__proto__"]) {
      for (const action of ["read", "create", "edit", "delete", "__proto__", "constructor"]) {
        const res = can(id, action);
        const own = Object.hasOwn(p.pages, id) ? p.pages[id][action] : undefined;
        if (res.allowed) assert.ok(own === "yes" || p.broad[action] === "yes" || res.source === "ancestor", `${id}/${action} allowed from ${res.source}`);
      }
    }
    setPageValue(p, r.pick(KEYS), r.pick(["read", "__proto__"]), r.pick(["yes", "no", "ignore"]));
    newer(p, hostile(r));
  });
  assertNoPollution(before, "permissions");
});

test("sync.bumpManifest keeps unknown fields but never copies __proto__ into the prototype chain", async () => {
  const before = protoSnapshot();
  await fuzz("proto-manifest", 2000, (r) => {
    const prev = asJsonObj(r, { app: "denotation", rev: r.pick([1, "5", -3, 1e20, {}]), writer: r.pick(["w", 5, null]), encrypted: true });
    const out = bumpManifest(prev, r.pick(["dev-1", null, 5, "x".repeat(200)]), r.int(0, 2e12));
    assert.equal(Object.getPrototypeOf(out), Object.prototype, "plain object");
    assert.equal(out.app, "denotation");
    assert.ok(Number.isInteger(out.rev) && out.rev >= 1);
    assert.ok(out.writer.length <= 64);
    assert.equal(Object.hasOwn(out, "__proto__"), false);
    manifestStamp(prev);
  });
  assertNoPollution(before, "manifest");
});

test("planSync: records with dangerous ids and collections plan cleanly (Map-keyed) and pollute nothing", async () => {
  const before = protoSnapshot();
  await fuzz("proto-sync", 800, (r) => {
    const rec = () => ({ id: r.pick(KEYS), updatedAt: r.int(1, 9), ...hostile(r) });
    const col = () => Object.fromEntries([["pages", Array.from({ length: r.int(0, 4) }, rec)], [r.pick(["rows", "__proto__", "constructor"]), Array.from({ length: r.int(0, 3) }, rec)]]);
    const local = JSON.parse(JSON.stringify(col()));
    const remote = JSON.parse(JSON.stringify(col()));
    const tombs = Array.from({ length: r.int(0, 3) }, () => ({ collection: r.pick(["pages", "__proto__"]), id: r.pick(KEYS), deletedAt: r.int(1, 9) }));
    for (const direction of ["merge", "push", "pull"]) planSync({ local, remote, localTombstones: tombs, remoteTombstones: tombs, direction, now: 10 });
  });
  assertNoPollution(before, "sync");
});

test("page props, auto-callout rules, front matter: dangerous names stay data", async () => {
  const before = protoSnapshot();
  await fuzz("proto-props", 1500, (r) => {
    const props = cleanProps(Array.from({ length: r.int(0, 6) }, () => ({ ...hostile(r), name: r.pick(KEYS), type: r.pick(["text", "select", "multi", "__proto__"]), value: r.pick(KEYS), options: [r.pick(KEYS)] })));
    const cols = KEYS.map((k, i) => ({ id: `c${i}`, name: k, type: r.pick(["text", "number", "select", "checkbox"]), config: { options: KEYS } }));
    const vals = valuesFromProps(cols, props);
    assert.equal(Object.getPrototypeOf(vals), Object.prototype);
    cleanRules(Array.from({ length: r.int(0, 4) }, () => ({ ...hostile(r), when: hostile(r), preset: r.pick(KEYS) })));
    propsFromFrontMatter(`${r.pick(KEYS)}: ${r.pick(KEYS)}\n__proto__: [polluted]\nconstructor: {prototype: 1}`);
  });
  assertNoPollution(before, "props");
});

test("typespec: struct keys named __proto__/constructor validate, clamp and default as own data", async () => {
  const before = protoSnapshot();
  await fuzz("proto-typespec", 1500, (r) => {
    const keys = r.some(KEYS.map((k) => `"${k}"`), r.int(1, 4));
    const text = `Dictionary{${[...new Set(keys)].map((k) => `${k}: ${r.pick(["int(0..5)", "String", "bool", "Array[int]", "Dictionary[float]", "any"])}`).join(", ")}}`;
    const spec = specOf(text);
    const v = hostile(r);
    validate(spec, v);
    const c = clamp(spec, v);
    if (c && typeof c === "object") assert.ok([Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(c)));
    const d = defaultFor(spec);
    if (spec.kind === "struct") {
      assert.equal(Object.getPrototypeOf(d), Object.prototype);
      assert.deepEqual(validate(spec, d), [], `${text} default validates`);
      for (const k of spec.keys) assert.ok(Object.hasOwn(d, k.key), k.key);
    }
    getPath(v, `${r.pick(KEYS)}.${r.pick(KEYS)}`);
    assert.equal(getPath({}, "__proto__"), undefined, "inherited members are not paths");
    assert.equal(getPath({}, "constructor"), undefined);
    summary(spec, v);
    leafPaths(spec);
    const col = { id: "j", type: "json", typeText: text };
    validateCell(col, v);
    reconcile(col, v);
    parseType(r.pick(KEYS));
  });
  assertNoPollution(before, "typespec");
});

test("JSON import (vault + workspace.importAll): dangerous keys in records pollute nothing; ids stay what the file says", async () => {
  const before = protoSnapshot();
  await fuzz("proto-import", 200, async (r) => {
    const ws = createWorkspace(createMemoryAdapter());
    const pages = Array.from({ length: r.int(1, 5) }, (_, i) => ({ ...hostile(r), id: `p${i}`, type: r.pick(["doc", "repo", "database"]), title: r.pick(KEYS), parentId: null, columns: [], blocks: [], createdAt: i, props: [{ name: r.pick(KEYS), value: r.pick(KEYS), ...objOnly(hostile(r)) }] }));
    const rows = Array.from({ length: r.int(0, 4) }, (_, i) => ({ ...hostile(r), id: `r${i}`, dbId: "p0", values: hostile(r), createdAt: i }));
    const files = toJsonFiles({ pages, rows }).map((f) => ({ ...f, data: f.data.replace(/^\{/, '{"__proto__":{"polluted":1},') }));
    const back = fromJsonFiles(files.filter((f) => f.path !== "denotation.json"));
    for (const p of back.pages) assert.equal(Object.getPrototypeOf(p), Object.prototype);
    const res = await importFiles(ws, files);
    assert.equal(res.format, "json");
    const legacy = JSON.parse(`{"app":"denotation","__proto__":{"polluted":1},"pages":${JSON.stringify(pages)},"rows":${JSON.stringify(rows)}}`);
    checkLegacy(legacy);
    await ws.importAll(legacy);
    await ws.search(r.pick(KEYS));
    await ws.listTrash();
  });
  assertNoPollution(before, "import");
});

test("workspace.search survives imported pages whose props hold non-objects (pinned)", async () => {
  const ws = createWorkspace(createMemoryAdapter());
  await ws.importAll({ app: "denotation", pages: [{ id: "p1", type: "doc", title: "A", parentId: null, createdAt: 1, blocks: [], props: [null, 5, "x"] }], rows: [] });
  await assert.doesNotReject(ws.search("a"));
});

test("crypto sanitizers: hostile key files / settings / manifest fields give null or plain objects", async () => {
  const before = protoSnapshot();
  await fuzz("proto-crypto", 1500, (r) => {
    assert.equal(sanitizeKeyFile(hostile(r)), null);
    const s = sanitizeSettings(hostile(r));
    assert.deepEqual(Object.keys(s).sort(), ["browser", "files", "filesJob"]);
    const f = encFields(asJsonObj(r, { encrypted: r.pick([true, "true", 1]), keyId: r.pick(["0123456789abcdef", "__proto__"]) }));
    for (const k of Object.keys(f)) assert.ok(["encrypted", "keyId", "encryption"].includes(k));
  });
  assertNoPollution(before, "crypto");
});
