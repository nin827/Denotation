// Sign-in tokens encrypted with the PIN (adapters/tokenLock.js) and how the cloud providers behave while locked.
import test from "node:test";
import assert from "node:assert/strict";
import { createTokenLock, tokenLockFor, VAULT_KEY, isTokenEnvelope, sanitizeVault } from "../../source/app/js/adapters/tokenLock.js";
import { tokenStore, newTokenKey, handleRedirect, finishDeferredRedirect, takeRedirectNotice } from "../../source/app/js/adapters/oauth.js";
import { memoryHandles } from "../../source/app/js/adapters/locations.js";
import { onedriveProvider } from "../../source/app/js/adapters/onedrive.js";
import { gdriveProvider } from "../../source/app/js/adapters/gdrive.js";
import { config } from "../../source/app/js/config.js";
import { sanitizeRecord, createPinRecord } from "../../source/app/js/lock.js";
import { KDF_MIN_ITERATIONS, KDF_MAX_ITERATIONS } from "../../source/app/js/crypto.js";

const SECRET = "at-SECRET-access-0123456789";
const REFRESH = "rt-SECRET-refresh-0123456789";
const rec = (over = {}) => ({ provider: "microsoft", accessToken: SECRET, refreshToken: REFRESH, expiresAt: Date.now() + 3600_000, scope: "Files.ReadWrite.AppFolder", obtainedAt: 1, account: { id: "t.o", hint: "someone" }, ...over });
/** Nothing in the store may contain a token secret in any form. */
const noPlain = (hs, msg) => {
  const dump = JSON.stringify([...hs.map.entries()]);
  assert.ok(!dump.includes(SECRET) && !dump.includes(REFRESH), msg ?? "no plaintext token in the store");
};

test("PIN on: existing tokens are encrypted in place; reads work while open, throw 'locked' while locked", async () => {
  const hs = memoryHandles();
  const ts = tokenStore(hs);
  const k1 = newTokenKey("microsoft");
  const k2 = newTokenKey("google");
  await ts.put(k1, rec());
  await ts.put(k2, rec({ provider: "google", refreshToken: undefined }));
  assert.equal(hs.map.get(k1).accessToken, SECRET, "plain while the PIN is off");
  const lock = tokenLockFor(hs);
  assert.equal(await lock.state(), "off");
  const r = await lock.open("1234");
  assert.deepEqual(r, { created: true, discarded: false });
  assert.equal(await lock.state(), "open");
  assert.ok(isTokenEnvelope(hs.map.get(k1)) && isTokenEnvelope(hs.map.get(k2)));
  assert.ok(sanitizeVault(hs.map.get(VAULT_KEY)));
  noPlain(hs);
  assert.equal((await ts.get(k1)).accessToken, SECRET);
  assert.equal((await ts.get(k1)).refreshToken, REFRESH);
  lock.close();
  assert.equal(await lock.state(), "locked");
  await assert.rejects(ts.get(k1), (e) => e.code === "locked" && /unlock/i.test(e.message));
  await assert.rejects(ts.put(k1, rec()), (e) => e.code === "locked");
  noPlain(hs, "a refused write stores nothing");
  await lock.open("1234");
  assert.equal((await ts.get(k2)).accessToken, SECRET, "unlock: readable again");
});

test("writes while open are encrypted; envelopes are bound to their key name", async () => {
  const hs = memoryHandles();
  const lock = createTokenLock(hs);
  await lock.open("2468");
  const a = newTokenKey("microsoft");
  const b = newTokenKey("microsoft");
  await lock.write(a, rec());
  await lock.write(b, rec({ accessToken: "other" }));
  noPlain(hs);
  hs.map.set(b, hs.map.get(a)); // swap an envelope under another name
  assert.equal(await lock.read(b), null, "a moved envelope doesn't decrypt");
  const env = hs.map.get(a);
  const ct = Buffer.from(env.ct, "base64");
  ct[0] ^= 1;
  hs.map.set(a, { ...env, ct: ct.toString("base64") });
  assert.equal(await lock.read(a), null, "a changed envelope reads as signed out");
});

test("PIN change re-wraps the key (old PIN stops working); PIN off decrypts and removes the record", async () => {
  const hs = memoryHandles();
  const k = newTokenKey("microsoft");
  await hs.put(k, rec());
  const lock = createTokenLock(hs);
  await lock.open("1111");
  const before = { ...hs.map.get(VAULT_KEY) };
  await lock.rekey("999999");
  const after = hs.map.get(VAULT_KEY);
  assert.equal(after.kid, before.kid);
  assert.notEqual(after.salt, before.salt);
  assert.notEqual(after.ct, before.ct);
  const copy = memoryHandles(Object.fromEntries(hs.map));
  assert.equal((await createTokenLock(copy).open("1111")).discarded, true, "the old PIN no longer opens the key");
  // A fresh tab: the new PIN opens it and the token is intact.
  const other = createTokenLock(hs);
  assert.deepEqual(await other.open("999999"), { created: false, discarded: false });
  assert.equal((await other.read(k)).accessToken, SECRET);
  noPlain(hs);
  await lock.disable();
  assert.equal(hs.map.has(VAULT_KEY), false);
  assert.equal(hs.map.get(k).accessToken, SECRET, "plain again");
  assert.equal(await lock.state(), "off");
  assert.equal(await other.state(), "off", "another tab notices the PIN went off");
  assert.equal((await other.read(k)).accessToken, SECRET);
  await other.write(k, rec({ accessToken: "next" }));
  assert.equal(hs.map.get(k).accessToken, "next");
});

test("a stale tab can't write plain text after the PIN went on elsewhere", async () => {
  const hs = memoryHandles();
  const a = createTokenLock(hs);
  const b = createTokenLock(hs);
  const k = newTokenKey("google");
  await b.write(k, rec({ provider: "google" }));
  await a.open("4321");
  assert.equal(await b.state(), "locked");
  await assert.rejects(b.write(k, rec({ provider: "google" })), (e) => e.code === "locked");
  await assert.rejects(b.read(k), (e) => e.code === "locked");
  noPlain(hs);
});

test("a record the verified PIN can't open: its tokens are dropped and a fresh key is made; no plaintext survives", async () => {
  const hs = memoryHandles();
  const lock = createTokenLock(hs);
  const k = newTokenKey("microsoft");
  const p = newTokenKey("google");
  await lock.open("1111");
  await lock.write(k, rec());
  lock.close();
  await hs.put(p, rec({ provider: "google" })); // left plain by an interrupted switch
  const r = await lock.open("2222"); // out of step (e.g. a PIN change cut short)
  assert.deepEqual(r, { created: true, discarded: true });
  assert.equal(await lock.read(k), null, "the old envelope is gone");
  assert.ok(isTokenEnvelope(hs.map.get(p)), "the plain one was encrypted by the sweep");
  noPlain(hs);
  // Damaged record: same.
  hs.map.set(VAULT_KEY, { v: 1, kid: "zz", junk: true });
  assert.equal(await lock.state(), "locked");
  assert.equal((await lock.open("2222")).discarded, true);
  assert.equal(await lock.state(), "open");
});

test("no PIN any more: discard() deletes the unreadable tokens and the record, keeps plain ones", async () => {
  const hs = memoryHandles();
  const lock = createTokenLock(hs);
  const k = newTokenKey("microsoft");
  await lock.open("1234");
  await lock.write(k, rec());
  lock.close();
  assert.equal(await lock.discard(), true);
  assert.equal(hs.map.has(k), false);
  assert.equal(hs.map.has(VAULT_KEY), false);
  assert.equal(await lock.discard(), false);
});

test("vault record iteration count is clamped like key files; PIN records too", async () => {
  const hs = memoryHandles();
  const lock = createTokenLock(hs);
  await lock.open("1234");
  const v = hs.map.get(VAULT_KEY);
  assert.ok(sanitizeVault(v));
  for (const iterations of [0, 1, KDF_MIN_ITERATIONS - 1, KDF_MAX_ITERATIONS + 1, 1e12, 1.5, "600000"]) {
    assert.equal(sanitizeVault({ ...v, iterations }), null, `vault ${iterations}`);
  }
  const pr = await createPinRecord("1234", 4, { iterations: KDF_MIN_ITERATIONS });
  assert.ok(sanitizeRecord(pr));
  assert.ok(sanitizeRecord({ ...pr, iterations: KDF_MAX_ITERATIONS }));
  for (const iterations of [1, KDF_MIN_ITERATIONS - 1, KDF_MAX_ITERATIONS + 1, 1e12]) {
    assert.equal(sanitizeRecord({ ...pr, iterations }), null, `pin ${iterations}`);
  }
});

test("OneDrive provider while locked: permission stays 'granted', requests fail with code 'locked', nothing is sent", async () => {
  const hs = memoryHandles();
  const k = newTokenKey("microsoft");
  await hs.put(k, rec());
  const lock = tokenLockFor(hs);
  await lock.open("5555");
  let calls = 0;
  const fetch = async () => {
    calls++;
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const p = onedriveProvider({ cloud: "onedrive", v: 1, tokenKey: k, folder: "Denotation", account: { id: "t.o", hint: "" } }, { handles: hs, fetch, sleep: async () => {} });
  assert.equal(await p.permission(false), "granted");
  await p.readText("x.json");
  assert.equal(calls, 1, "one request while open");
  lock.close();
  assert.equal(await p.permission(false), "granted", "a locked sign-in still counts as stored");
  await assert.rejects(p.readText("x.json"), (e) => e.code === "locked");
  assert.equal(calls, 1, "no request (and no token) went out while locked");
  await lock.open("5555");
  await p.readText("x.json");
  assert.equal(calls, 2, "resumes after unlock");
});

test("Google Drive provider while locked: no quiet renewal is tried, requests fail with code 'locked'", async () => {
  const hs = memoryHandles();
  const k = newTokenKey("google");
  const lock = tokenLockFor(hs);
  await lock.open("5555");
  await tokenStore(hs).put(k, rec({ provider: "google", refreshToken: undefined }));
  lock.close();
  let calls = 0;
  const p = gdriveProvider({ cloud: "gdrive", v: 1, tokenKey: k, folder: "Denotation", space: "drive" }, { handles: hs, fetch: async () => (calls++, new Response("{}")), silent: false, sleep: async () => {} });
  await assert.rejects(p.readText("x.json"), (e) => e.code === "locked");
  assert.equal(calls, 0);
  noPlain(hs);
});

test("a redirect sign-in that returns while locked waits for the unlock and is then stored encrypted", async () => {
  const MS_ID = "ms-client-id-123";
  config.oauth.microsoft.clientId = MS_ID;
  const APP = "https://example.github.io/Denotation/";
  const hs = memoryHandles();
  const lock = tokenLockFor(hs);
  const state = "R".repeat(24);
  await lock.open("8080");
  const k0 = newTokenKey("microsoft");
  await lock.write(k0, rec());
  lock.close();
  await hs.put(`oauth:${state}`, { provider: "microsoft", state, verifier: "v".repeat(43), nonce: null, wantScope: "Files.ReadWrite.AppFolder", clientId: MS_ID, redirectUri: APP, mode: "redirect", createdAt: Date.now(), purpose: { kind: "reauth", tokenKey: k0 } });
  const href = `${APP}#code=abc&state=${state}`;
  const win = { location: { href, origin: "https://example.github.io" }, history: { state: null, replaceState() {} } };
  let posted = 0;
  const fetch = async () => {
    posted++;
    return new Response(JSON.stringify({ access_token: SECRET, refresh_token: REFRESH, token_type: "Bearer", expires_in: 3600, scope: "Files.ReadWrite.AppFolder" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const r = await handleRedirect({ win, handles: hs, fetch });
  assert.deepEqual(r, { stop: false, handled: true, deferred: true });
  assert.equal(posted, 0, "nothing redeemed before the unlock");
  assert.equal(await hs.get(`oauth:${state}`), null, "the pending request is consumed");
  await lock.open("8080");
  await finishDeferredRedirect();
  assert.equal(posted, 1);
  assert.deepEqual(takeRedirectNotice(), { kind: "info", text: "Signed in again." });
  assert.ok(isTokenEnvelope(hs.map.get(k0)));
  assert.equal((await tokenStore(hs).get(k0)).accessToken, SECRET);
  noPlain(hs);
});
