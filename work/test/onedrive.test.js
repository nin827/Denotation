import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../source/app/js/config.js";
import { onedriveProvider, sanitizeOnedriveHandle, onedriveName } from "../../source/app/js/adapters/onedrive.js";
import { tokenStore } from "../../source/app/js/adapters/oauth.js";
import { memoryHandles, createLocationRegistry } from "../../source/app/js/adapters/locations.js";
import { createMemoryAdapter } from "../../source/app/js/adapters/memory.js";
import { createFolderAdapter } from "../../source/app/js/adapters/folder.js";
import { createKeyFile, createKeyring, isEnvelope } from "../../source/app/js/crypto.js";
import { makeFetch, fakeGraph, fakeMsIdentity } from "./fixtures/cloud-fakes.js";

const MS_ID = "ms-client-id-123";
config.oauth.microsoft.clientId = MS_ID;
const F = "Denotation";
const TK = "tok:microsoft:0123456789abcdef0123";
const page = (id, title, updatedAt, extra = {}) => ({ id, type: "doc", title, parentId: null, createdAt: 1, updatedAt, blocks: [], ...extra });
const json = (r) => JSON.stringify(r);
function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
}
async function device(graph, { token = "mtoken", folder = F, expiresAt = Date.now() + 3600_000, refreshToken, refreshExpiresAt, identity } = {}) {
  const handles = memoryHandles();
  await handles.put(TK, { provider: "microsoft", accessToken: token, expiresAt, refreshToken, refreshExpiresAt, scope: "Files.ReadWrite.AppFolder", account: { id: "t.o", hint: "" } });
  const fetch = makeFetch(graph, ...(identity ? [identity] : []));
  const p = onedriveProvider({ cloud: "onedrive", v: 1, tokenKey: TK, folder, account: { id: "t.o", hint: "" } }, { fetch, handles, sleep: async () => {} });
  return { p, handles, fetch };
}

test("handles are validated; names", () => {
  assert.equal(sanitizeOnedriveHandle({ cloud: "onedrive", tokenKey: "tok:google:0123456789abcdef0123", folder: "x" }), null);
  assert.equal(sanitizeOnedriveHandle({ cloud: "onedrive", tokenKey: TK, folder: "a:b" }), null);
  assert.equal(onedriveName({ folder: "W" }), "OneDrive: W");
  assert.throws(() => onedriveProvider({ cloud: "onedrive", tokenKey: TK }), /damaged/);
});

test("CRUD over Graph path addressing, with spaces and unicode in the folder name", async () => {
  const graph = fakeGraph();
  const { p, fetch } = await device(graph, { folder: "My notes é" });
  assert.equal(await p.permission(false), "granted");
  assert.equal(await p.readText("denotation.json"), null);
  assert.deepEqual(await p.list("pages"), []);
  await p.writeText("pages/a.json", json(page("a", "A", 1)));
  await p.writeText("denotation.json", "{}");
  assert.equal(JSON.parse(await p.readText("pages/a.json")).title, "A");
  assert.deepEqual(await p.list("pages"), [{ name: "a.json", kind: "file" }]);
  assert.deepEqual((await p.list("")).sort((x, y) => (x.name < y.name ? -1 : 1)), [{ name: "denotation.json", kind: "file" }, { name: "pages", kind: "directory" }]);
  await p.remove("pages/a.json");
  await p.remove("pages/a.json");
  assert.equal(await p.readText("pages/a.json"), null);
  assert.ok(fetch.calls.some((c) => c.url.includes("approot:/My%20notes%20%C3%A9/pages/a.json:/content")));
  assert.ok(fetch.calls.every((c) => c.url.startsWith("https://graph.microsoft.com/v1.0/me/drive/special/approot:/")));
});

test("listing follows Graph's nextLink pages, and never sends the token anywhere else", async () => {
  const graph = fakeGraph();
  graph.pageSize = 2;
  for (let i = 0; i < 5; i++) graph.put(F, `rows/r${i}.json`, "{}");
  const { p, fetch } = await device(graph);
  assert.equal((await p.list("rows")).length, 5);
  graph.evilNextLink = "https://evil.example/steal";
  const got = await p.list("rows");
  assert.equal(got.length, 2, "a foreign nextLink is not followed");
  assert.ok(fetch.calls.every((c) => !c.url.startsWith("https://evil.example")));
});

test("expired access token: renewed with the refresh token (rotated), then the request succeeds", async () => {
  const graph = fakeGraph({ tokens: [] });
  const identity = fakeMsIdentity({ graph });
  identity.refresh.set("r0", { scope: "x" });
  const { p, handles, fetch } = await device(graph, { token: "dead", expiresAt: Date.now() - 1000, refreshToken: "r0", refreshExpiresAt: Date.now() + 3600_000, identity });
  assert.equal(await p.permission(false), "granted");
  await p.writeText("denotation.json", "{}");
  const rec = await tokenStore(handles).get(TK);
  assert.match(rec.accessToken, /^mtoken-/);
  assert.notEqual(rec.refreshToken, "r0");
  assert.equal(identity.stats.refresh, 1);
  // a 401 on a token that looked valid: one forced refresh, then it works
  graph.revoke(rec.accessToken);
  assert.equal(await p.readText("denotation.json"), "{}");
  assert.equal(identity.stats.refresh, 2);
  assert.ok(fetch.calls.filter((c) => c.url.includes("/token")).every((c) => c.auth === null), "the token endpoint gets no bearer");
});

test("refresh window over (24 h): requests are permission errors, without calling the token endpoint", async () => {
  const graph = fakeGraph({ tokens: [] });
  const identity = fakeMsIdentity({ graph });
  const { p } = await device(graph, { token: "dead", expiresAt: Date.now() - 1000, refreshToken: "r0", refreshExpiresAt: Date.now() - 1, identity });
  assert.equal(await p.permission(false), "granted", "a stored sign-in counts until a request says otherwise");
  await assert.rejects(p.readText("denotation.json"), (e) => e.name === "NotAllowedError");
  assert.equal(identity.stats.refresh, 0);
  const none = onedriveProvider({ cloud: "onedrive", tokenKey: TK, folder: F }, { handles: memoryHandles() });
  assert.equal(await none.permission(false), "prompt");
});

test("retries: 429 with Retry-After and 503 are retried", async () => {
  const graph = fakeGraph();
  graph.put(F, "pages/a.json", "{}");
  const { p } = await device(graph);
  graph.failNext((u) => u.endsWith("a.json:/content"), 429, { "Retry-After": "3" });
  graph.failNext((u) => u.endsWith("a.json:/content"), 503);
  assert.equal(await p.readText("pages/a.json"), "{}");
});

test("lost updates: denotation.json uses If-Match; a concurrent change makes every reader merge", async () => {
  const graph = fakeGraph();
  graph.put(F, "denotation.json", json({ app: "denotation", rev: 4, writer: "w-a" }));
  const { p } = await device(graph);
  const before = JSON.parse(await p.readText("denotation.json"));
  // another device stamps in between
  graph.put(F, "denotation.json", json({ app: "denotation", rev: 5, writer: "w-other" }));
  await p.writeText("denotation.json", json({ ...before, rev: 5, writer: "w-me" }));
  assert.equal(graph.stats.conflicts, 1);
  const now = JSON.parse(graph.read(F, "denotation.json"));
  assert.equal(now.writer, "w-me");
  assert.equal(now.rev, 6, "raised past both, so neither writer's remembered stamp matches and both merge");
  // created at the same moment by two devices: If-None-Match catches it too
  const g2 = fakeGraph();
  const { p: q } = await device(g2);
  assert.equal(await q.readText("denotation.json"), null);
  g2.put(F, "denotation.json", json({ rev: 1, writer: "w-other" }));
  await q.writeText("denotation.json", json({ rev: 1, writer: "w-me" }));
  assert.equal(JSON.parse(g2.read(F, "denotation.json")).rev, 2);
  // keys.json conflicts and encryption disagreements stop with an error instead
  const g3 = fakeGraph();
  g3.put(F, "keys.json", '{"kid":"a"}');
  g3.put(F, "denotation.json", json({ rev: 1 }));
  const { p: r } = await device(g3);
  await r.readText("keys.json");
  g3.put(F, "keys.json", '{"kid":"b"}');
  await assert.rejects(r.writeText("keys.json", '{"kid":"c"}'), (e) => e.code === "conflict");
  assert.equal(g3.read(F, "keys.json"), '{"kid":"b"}');
  await r.readText("denotation.json");
  g3.put(F, "denotation.json", json({ rev: 2, encrypted: true, keyId: "k" }));
  await assert.rejects(r.writeText("denotation.json", json({ rev: 2 })), (e) => e.code === "conflict");
  assert.equal(JSON.parse(g3.read(F, "denotation.json")).encrypted, true);
});

// ---------- the sync engine over OneDrive ----------
test("sync: two devices, auto check, tombstones and a manual Pull through OneDrive", async () => {
  const graph = fakeGraph();
  graph.put(F, "pages/r.json", json(page("r", "remote", 50)));
  const c1 = createMemoryAdapter();
  await c1.set("pages", "l", page("l", "local", 60));
  const one = await device(graph);
  const fs1 = createFolderAdapter(c1, { storage: memStorage(), registry: createLocationRegistry({ storage: memStorage(), handles: one.handles }), mergeOnFocus: false, cooldownMs: 0 });
  assert.deepEqual(await fs1.connect(one.p), { pulled: 1, pushed: 1, deleted: 0 });
  const two = await device(graph);
  const c2 = createMemoryAdapter();
  const fs2 = createFolderAdapter(c2, { storage: memStorage(), registry: createLocationRegistry({ storage: memStorage(), handles: two.handles }), mergeOnFocus: false, cooldownMs: 0 });
  await fs2.connect(two.p);
  assert.equal((await c2.get("pages", "l")).title, "local");
  await fs2.set("pages", "l", page("l", "edited on 2", 70));
  await fs2.remove("pages", "r");
  await fs2.flush();
  assert.equal((await fs1.checkNow()).pulled, true);
  assert.equal((await c1.get("pages", "l")).title, "edited on 2");
  assert.equal(await c1.get("pages", "r"), null);
  assert.ok(graph.read(F, "tombstones/r.json"));
  // manual mode: Pull overwrites with the cloud copy after a warning
  await fs1.setMode("manual");
  await fs1.set("pages", "l", page("l", "newer here", 90));
  const warn = await fs1.pull();
  assert.equal(warn.applied, false);
  assert.equal(warn.conflicts.olderRemote.length, 1);
  await fs1.pull({ force: true });
  assert.equal((await c1.get("pages", "l")).title, "edited on 2");
});

test("sync: encryption round trip through OneDrive; a browser without the key is locked and writes nothing", async () => {
  const storage = memStorage();
  const keyring = createKeyring({ storage });
  const { file, dek } = await createKeyFile({ pin: "1234", iterations: 1000 });
  keyring.adopt(dek, file);
  const graph = fakeGraph();
  graph.put(F, "pages/s.json", json(page("s", "Top secret", 5)));
  const one = await device(graph);
  const fs = createFolderAdapter(createMemoryAdapter(), { storage, keyring, registry: createLocationRegistry({ storage, handles: one.handles }), mergeOnFocus: false });
  await fs.connect(one.p);
  assert.equal((await fs.setEncryption(true))[0].error, undefined);
  assert.ok(isEnvelope(JSON.parse(graph.read(F, "pages/s.json"))));
  assert.equal(JSON.parse(graph.read(F, "denotation.json")).encrypted, true);
  const other = await device(graph);
  const storage2 = memStorage();
  const fs2 = createFolderAdapter(createMemoryAdapter(), { storage: storage2, keyring: createKeyring({ storage: storage2 }), registry: createLocationRegistry({ storage: storage2, handles: other.handles }), mergeOnFocus: false });
  const puts = graph.stats.put;
  await fs2.connect(other.p).catch(() => {});
  assert.equal(fs2.status().state, "locked");
  assert.equal(graph.stats.put, puts, "nothing written without the key");
  assert.equal((await fs.setEncryption(false))[0].error, undefined);
  assert.equal(JSON.parse(graph.read(F, "pages/s.json")).title, "Top secret");
  assert.equal(graph.read(F, "keys.json"), undefined);
});

test("sync: an expired sign-in pauses the location ('needs permission'); the cache keeps working", async () => {
  const graph = fakeGraph({ tokens: [] });
  const identity = fakeMsIdentity({ graph });
  const { p, handles } = await device(graph, { token: "dead", expiresAt: Date.now() - 1, refreshToken: "gone", refreshExpiresAt: Date.now() + 1000, identity });
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { storage: memStorage(), registry: createLocationRegistry({ storage: memStorage(), handles }), mergeOnFocus: false });
  await fs.connect(p).catch(() => {});
  assert.equal(fs.status().state, "needs-permission");
  await fs.set("pages", "x", page("x", "still saved", 1));
  assert.equal((await cache.get("pages", "x")).title, "still saved");
});
