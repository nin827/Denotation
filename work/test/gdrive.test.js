import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../source/app/js/config.js";
import { gdriveProvider, sanitizeGdriveHandle, cleanFolderName, gdriveName } from "../../source/app/js/adapters/gdrive.js";
import { onCloudWarning, MAX_CLOUD_FILE_BYTES } from "../../source/app/js/adapters/oauth.js";
import { memoryHandles, createLocationRegistry, sanitizeLocations, locationTypeConfigured } from "../../source/app/js/adapters/locations.js";
import { createMemoryAdapter } from "../../source/app/js/adapters/memory.js";
import { createFolderAdapter } from "../../source/app/js/adapters/folder.js";
import { createKeyFile, createKeyring, isEnvelope } from "../../source/app/js/crypto.js";
import { makeFetch, fakeDrive } from "./fixtures/cloud-fakes.js";

config.oauth.google.clientId = "google-client-id-123.apps.googleusercontent.com";
const ROOT = "Denotation";
const TK = "tok:google:0123456789abcdef0123";
const page = (id, title, updatedAt, extra = {}) => ({ id, type: "doc", title, parentId: null, createdAt: 1, updatedAt, blocks: [], ...extra });
const json = (r) => JSON.stringify(r);
function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
}
async function device(drive, { token = "gtoken", space = "drive", folder = ROOT, expiresAt = Date.now() + 3600_000 } = {}) {
  const handles = memoryHandles();
  await handles.put(TK, { provider: "google", accessToken: token, expiresAt, scope: "https://www.googleapis.com/auth/drive.file", account: { id: "perm-1", hint: "" } });
  const fetch = makeFetch(drive);
  const sleep = async () => {};
  const p = gdriveProvider({ cloud: "gdrive", v: 1, tokenKey: TK, folder, space, account: { id: "perm-1", hint: "" } }, { fetch, handles, sleep, silent: false });
  return { p, handles, fetch };
}

test("handles: descriptors are validated; folder names are restricted; config gates the type", () => {
  assert.equal(sanitizeGdriveHandle({ cloud: "gdrive", tokenKey: TK, folder: "a/b" }), null);
  assert.equal(sanitizeGdriveHandle({ cloud: "gdrive", tokenKey: "tok:microsoft:0123456789abcdef0123", folder: "x" }), null);
  assert.deepEqual(sanitizeGdriveHandle({ cloud: "gdrive", tokenKey: TK, folder: " Notes ", space: "weird" }), { cloud: "gdrive", v: 1, tokenKey: TK, folder: "Notes", space: "drive", account: null });
  assert.equal(cleanFolderName(".."), "");
  assert.equal(cleanFolderName("x".repeat(61)), "");
  assert.equal(gdriveName({ folder: "W", space: "appdata" }), "Google Drive (app data): W");
  assert.throws(() => gdriveProvider({ cloud: "gdrive" }), /damaged/);
  assert.equal(locationTypeConfigured("gdrive", { oauth: { google: { clientId: "" } } }), false);
  assert.equal(locationTypeConfigured("gdrive"), true);
  assert.equal(locationTypeConfigured("folder", {}), true);
  assert.deepEqual(sanitizeLocations([{ id: "loc-a", type: "gdrive", name: "G", role: "main" }, { id: "loc-b", type: "dropbox", name: "D" }]).map((l) => l.type), ["gdrive"]);
});

test("CRUD and path mapping: one workspace folder with sub-folders; names and kinds listed", async () => {
  const drive = fakeDrive();
  const { p, fetch } = await device(drive);
  assert.equal(await p.permission(false), "granted");
  assert.equal(await p.readText("denotation.json"), null);
  assert.deepEqual(await p.list("pages"), []);
  await p.writeText("pages/a.json", json(page("a", "A", 1)));
  await p.writeText("pages/b.json", json(page("b", "B", 1)));
  await p.writeText("denotation.json", "{}");
  assert.equal(JSON.parse(await p.readText("pages/a.json")).title, "A");
  assert.deepEqual((await p.list("pages")).map((e) => e.name).sort(), ["a.json", "b.json"]);
  assert.deepEqual((await p.list("")).sort((x, y) => (x.name < y.name ? -1 : 1)), [{ name: "denotation.json", kind: "file" }, { name: "pages", kind: "directory" }]);
  await p.writeText("pages/a.json", json(page("a", "A2", 2)));
  assert.equal(JSON.parse(drive.read(ROOT, "pages/a.json")).title, "A2");
  assert.equal(drive.all(ROOT, "pages/a.json").length, 1, "updated in place");
  await p.remove("pages/a.json");
  await p.remove("pages/never.json");
  assert.equal(await p.readText("pages/a.json"), null);
  assert.equal(drive.stats.trash, 1, "My Drive deletes go to the trash");
  assert.deepEqual(Object.keys(drive.tree(ROOT)).sort(), ["denotation.json", "pages/b.json"]);
  assert.ok(fetch.calls.every((c) => c.auth === "gtoken"), "every request carries the token");
  assert.ok(fetch.calls.every((c) => c.url.startsWith("https://www.googleapis.com/")), "nothing goes elsewhere");
});

test("the hidden app folder lives under appDataFolder and is deleted, not trashed", async () => {
  const drive = fakeDrive();
  const { p } = await device(drive, { space: "appdata" });
  await p.writeText("rows/r.json", "{}");
  const root = [...drive.files.values()].find((f) => f.name === ROOT);
  assert.deepEqual(root.parents, ["appDataFolder"]);
  await p.remove("rows/r.json");
  assert.equal(drive.stats.delete, 1);
  assert.equal(drive.stats.trash, 0);
});

test("duplicates: the newest file wins, writes clean the older copies, removes delete every copy", async () => {
  const drive = fakeDrive();
  drive.put(ROOT, "pages/x.json", json(page("x", "old", 1)));
  drive.put(ROOT, "pages/x.json", json(page("x", "new", 2)), { dup: true });
  const { p } = await device(drive);
  assert.equal((await p.list("pages")).length, 1, "listed once");
  assert.equal(JSON.parse(await p.readText("pages/x.json")).title, "new");
  await p.writeText("pages/x.json", json(page("x", "newest", 3)));
  assert.equal(drive.all(ROOT, "pages/x.json").length, 1, "older duplicate removed");
  assert.equal(JSON.parse(drive.read(ROOT, "pages/x.json")).title, "newest");
  drive.put(ROOT, "pages/x.json", "dup again", { dup: true });
  await p.remove("pages/x.json");
  assert.equal(drive.all(ROOT, "pages/x.json").length, 0);
  // duplicate sub-folders (two devices created pages/ at once): both are listed and read
  const rootId = drive.folderId(ROOT);
  const extra = [...drive.files.values()].length;
  drive.files.set("dupdir", { id: "dupdir", name: "pages", mimeType: "application/vnd.google-apps.folder", parents: [rootId], content: "", createdTime: "2030-01-01T00:00:00Z", modifiedTime: "2030-01-01T00:00:00Z", trashed: false });
  drive.files.set("inDup", { id: "inDup", name: "y.json", mimeType: "application/json", parents: ["dupdir"], content: json(page("y", "Y", 1)), createdTime: "2030-01-01T00:00:00Z", modifiedTime: "2030-01-01T00:00:00Z", trashed: false });
  const { p: p2 } = await device(drive);
  assert.ok((await p2.list("pages")).some((e) => e.name === "y.json"));
  assert.equal(JSON.parse(await p2.readText("pages/y.json")).title, "Y");
  assert.ok(extra > 0);
});

test("search lag: a file created here a moment ago is still listed and read", async () => {
  const drive = fakeDrive();
  const { p } = await device(drive);
  await p.writeText("pages/seed.json", "{}"); // folders exist
  drive.lag.hideNew = 3;
  await p.writeText("pages/fresh.json", json(page("fresh", "F", 1)));
  assert.ok((await p.list("pages")).some((e) => e.name === "fresh.json"));
  assert.equal(JSON.parse(await p.readText("pages/fresh.json")).title, "F");
});

test("the workspace folder: an existing one is reused, a racing second one gives way to the oldest", async () => {
  const drive = fakeDrive();
  drive.put(ROOT, "denotation.json", '{"rev":1}');
  const { p } = await device(drive);
  assert.equal(await p.readText("denotation.json"), '{"rev":1}');
  assert.equal([...drive.files.values()].filter((f) => f.name === ROOT).length, 1);
  // race: another device creates the workspace folder just before this one does
  const d2 = fakeDrive();
  const dev = await device(d2, { folder: "Race" });
  const base = makeFetch(d2);
  let raced = false;
  const racing = async (u, init) => {
    if (!raced && init?.method === "POST" && u.startsWith("https://www.googleapis.com/drive/v3/files") && JSON.parse(init.body).name === "Race") {
      raced = true;
      d2.files.set("older", { id: "older", name: "Race", mimeType: "application/vnd.google-apps.folder", parents: ["root"], content: "", createdTime: "2000-01-01T00:00:00Z", modifiedTime: "2000-01-01T00:00:00Z", trashed: false });
    }
    return base(u, init);
  };
  const p2 = gdriveProvider({ cloud: "gdrive", tokenKey: TK, folder: "Race" }, { fetch: racing, handles: dev.handles, silent: false, sleep: async () => {} });
  await p2.writeText("denotation.json", "{}");
  assert.ok(raced);
  const live = [...d2.files.values()].filter((f) => f.name === "Race" && !f.trashed);
  assert.deepEqual(live.map((f) => f.id), ["older"], "everyone settles on the oldest folder");
  assert.equal(d2.read("Race", "denotation.json"), "{}");
});

test("expired token without a quiet renewal: a permission error, so the location asks to reconnect", async () => {
  const drive = fakeDrive({ tokens: [] });
  const { p } = await device(drive, { expiresAt: Date.now() - 1000 });
  assert.equal(await p.permission(false), "granted", "a stored token counts until a request says otherwise");
  await assert.rejects(p.readText("denotation.json"), (e) => e.name === "NotAllowedError");
  const none = gdriveProvider({ cloud: "gdrive", tokenKey: TK, folder: ROOT }, { handles: memoryHandles(), silent: false });
  assert.equal(await none.permission(false), "prompt");
  // revoked while valid: 401, no renewal possible -> permission error
  const d2 = fakeDrive({ tokens: [] });
  const { p: p2 } = await device(d2);
  await assert.rejects(p2.list("pages"), (e) => e.name === "NotAllowedError");
});

test("throttling: 429 and 403 rateLimitExceeded are retried; other 403s are permission errors", async () => {
  const drive = fakeDrive();
  const { p } = await device(drive);
  await p.writeText("pages/a.json", "{}");
  drive.failNext((u) => u.includes("alt=media"), 429, { "Retry-After": "1" });
  drive.failNext((u) => u.includes("alt=media"), 403, {}, 1, { error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } });
  assert.equal(await p.readText("pages/a.json"), "{}");
  drive.failNext((u) => u.includes("alt=media"), 403, {}, 1, { error: { code: 403, errors: [{ reason: "insufficientFilePermissions" }] } });
  await assert.rejects(p.readText("pages/a.json"), (e) => e.name === "NotAllowedError");
});

test("files over the size limit are refused with a warning, never half-written", async () => {
  const drive = fakeDrive();
  const { p } = await device(drive);
  const warnings = [];
  const off = onCloudWarning((w) => warnings.push(w));
  await p.writeText("rows/big.json", "x".repeat(MAX_CLOUD_FILE_BYTES + 1));
  off();
  assert.equal(drive.read(ROOT, "rows/big.json"), undefined);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].path, "rows/big.json");
});

// ---------- the sync engine over Google Drive ----------
test("sync: connect merges (last write wins), a second device sees it, deletes travel as tombstones", async () => {
  const drive = fakeDrive();
  drive.put(ROOT, "pages/a.json", json(page("a", "A remote new", 300)));
  drive.put(ROOT, "pages/c.json", json(page("c", "only remote", 50)));
  drive.put(ROOT, "notes.txt", "keep me");
  const cache = createMemoryAdapter();
  await cache.set("pages", "a", page("a", "A local old", 100));
  await cache.set("pages", "b", page("b", "only local", 200));
  const one = await device(drive);
  const fs = createFolderAdapter(cache, { storage: memStorage(), registry: createLocationRegistry({ storage: memStorage(), handles: one.handles }), mergeOnFocus: false });
  const counts = await fs.connect(one.p);
  assert.deepEqual(counts, { pulled: 2, pushed: 1, deleted: 0 });
  assert.equal((await cache.get("pages", "a")).title, "A remote new");
  assert.equal(JSON.parse(drive.read(ROOT, "pages/b.json")).title, "only local");
  assert.equal(drive.read(ROOT, "notes.txt"), "keep me");
  const m = JSON.parse(drive.read(ROOT, "denotation.json"));
  assert.equal(m.rev, 1);
  assert.equal(fs.status().locations[0].type, "gdrive");
  assert.equal(fs.status().state, "synced");
  // second device
  const cache2 = createMemoryAdapter();
  const two = await device(drive);
  const fs2 = createFolderAdapter(cache2, { storage: memStorage(), registry: createLocationRegistry({ storage: memStorage(), handles: two.handles }), mergeOnFocus: false });
  await fs2.connect(two.p);
  assert.equal((await cache2.get("pages", "b")).title, "only local");
  // delete on device 2 -> tombstone in Drive -> device 1 drops it on its next check
  await fs2.remove("pages", "b");
  await fs2.flush();
  assert.equal(drive.read(ROOT, "pages/b.json"), undefined);
  assert.equal(JSON.parse(drive.read(ROOT, "tombstones/b.json")).collection, "pages");
  const r = await fs.checkNow();
  assert.equal(r.pulled, true, "the manifest stamp changed");
  assert.equal(await cache.get("pages", "b"), null);
  assert.equal((await fs.checkNow()).pulled, false, "unchanged stamp: no pull");
});

test("sync: encryption on and off works unchanged through the Drive provider", async () => {
  const storage = memStorage();
  const keyring = createKeyring({ storage });
  const { file, dek } = await createKeyFile({ pin: "1234", iterations: 1000 });
  keyring.adopt(dek, file);
  const drive = fakeDrive();
  for (let i = 0; i < 4; i++) drive.put(ROOT, `pages/p${i}.json`, json(page(`p${i}`, `Secret ${i}`, 10 + i)));
  const one = await device(drive);
  const cache = createMemoryAdapter();
  const fs = createFolderAdapter(cache, { storage, keyring, registry: createLocationRegistry({ storage, handles: one.handles }), mergeOnFocus: false });
  await fs.connect(one.p);
  const res = await fs.setEncryption(true);
  assert.equal(res[0].error, undefined);
  assert.equal(res[0].changed, 4);
  const tree = drive.tree(ROOT);
  assert.ok(tree["keys.json"]);
  assert.equal(JSON.parse(tree["denotation.json"]).encrypted, true);
  assert.ok(Object.entries(tree).filter(([k]) => k.startsWith("pages/")).every(([, v]) => isEnvelope(JSON.parse(v))));
  assert.ok(!JSON.stringify(tree).includes("Secret 2"));
  // a second browser with the same key reads it
  const two = await device(drive);
  const cache2 = createMemoryAdapter();
  const fs2 = createFolderAdapter(cache2, { storage, keyring, registry: createLocationRegistry({ storage: memStorage(), handles: two.handles }), mergeOnFocus: false });
  await fs2.connect(two.p);
  assert.equal((await cache2.get("pages", "p2")).title, "Secret 2");
  const off = await fs.setEncryption(false);
  assert.equal(off[0].error, undefined);
  const plain = drive.tree(ROOT);
  assert.equal(plain["keys.json"], undefined, "keys.json removed last");
  assert.equal(JSON.parse(plain["pages/p1.json"]).title, "Secret 1");
});

test("sync: a backup on Google Drive receives copies; init rebuilds it from the stored descriptor", async () => {
  const drive = fakeDrive();
  const handles = memoryHandles();
  await handles.put(TK, { provider: "google", accessToken: "gtoken", expiresAt: Date.now() + 3600_000, scope: "" });
  const storage = memStorage();
  const registry = createLocationRegistry({ storage, handles });
  registry.save([{ id: "loc-g1", type: "gdrive", name: "Google Drive: Denotation", role: "backup" }]);
  await handles.put("loc:loc-g1", { cloud: "gdrive", v: 1, tokenKey: TK, folder: ROOT, space: "drive" });
  const cache = createMemoryAdapter();
  await cache.set("pages", "p", page("p", "Backed up", 5));
  // the registry builds providers with the default fetch: route it to the fake for this test
  const prevFetch = globalThis.fetch;
  globalThis.fetch = makeFetch(drive);
  try {
    const fs = createFolderAdapter(cache, { storage, registry, mergeOnFocus: false });
    const r = await fs.init();
    assert.deepEqual(r.needsPermission, []);
    await fs.backupNow();
    assert.equal(JSON.parse(drive.read(ROOT, "pages/p.json")).title, "Backed up");
    assert.equal(fs.status().locations[0].state, "synced");
    await fs.removeLocation("loc-g1");
    assert.equal(await handles.get(TK), null, "the token goes with the location");
  } finally {
    globalThis.fetch = prevFetch;
  }
});
