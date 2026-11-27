import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../source/app/js/config.js";
import {
  pkceChallenge, buildAuthUrl, parseRedirect, handleRedirect, authorize, completeResponse, checkIdToken, decodeJwtPayload,
  tokenStore, tokenRecord, refreshAccess, authedFetch, exchangeCode, redirectUri, clientId, cloudConfigured, newTokenKey, takeRedirectNotice, randomString
} from "../../source/app/js/adapters/oauth.js";
import { memoryHandles, createLocationRegistry, LOCATIONS_KEY } from "../../source/app/js/adapters/locations.js";
import { makeFetch, fakeMsIdentity, fakeGraph, fakeDrive } from "./fixtures/cloud-fakes.js";

const MS_ID = "ms-client-id-123";
const G_ID = "google-client-id-123.apps.googleusercontent.com";
config.oauth.microsoft.clientId = MS_ID;
config.oauth.google.clientId = G_ID;
const APP = "https://example.github.io/Denotation/";

function memStorage() {
  const m = new Map();
  return { map: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
}
/** A window stand-in: location, history.replaceState, open() returning a fake popup. */
function fakeWin(href = `${APP}#page-abc`, { onPopupNavigate, opener = null, parent = null } = {}) {
  const w = {
    replaced: [],
    closed: false,
    opener,
    location: null,
    history: { state: null, replaceState(_s, _t, url) { w.replaced.push(url); w.location = loc(new URL(url, w.location.href).href); } },
    open() {
      const popup = { closed: false, close() { this.closed = true; }, location: {} };
      let target = "";
      Object.defineProperty(popup.location, "href", { get: () => target, set: (v) => { target = v; queueMicrotask(() => onPopupNavigate?.(v)); } });
      w.popup = popup;
      return w.blockPopups ? null : popup;
    },
    close() { w.closed = true; },
    addEventListener() {},
    document: { body: { textContent: "app" } }
  };
  w.parent = parent ?? w;
  const loc = (h) => {
    const u = new URL(h);
    return { href: u.href, origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash, assign(v) { w.assigned = v; } };
  };
  w.location = loc(href);
  return w;
}

test("PKCE S256 matches the RFC 7636 example; random strings are url-safe and unique", async () => {
  assert.equal(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const a = randomString(32);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, randomString(32));
  assert.match(newTokenKey("google"), /^tok:google:[0-9a-f]{24}$/);
});

test("config: empty client IDs mean not configured; the redirect URI is the app URL without index.html", () => {
  assert.equal(clientId("google", { oauth: { google: { clientId: "" } } }), "");
  assert.equal(cloudConfigured({ oauth: {} }), false);
  assert.equal(cloudConfigured({ oauth: { microsoft: { clientId: MS_ID } } }), true);
  assert.equal(clientId("google", { oauth: { google: { clientId: "<script>" } } }), "", "junk is ignored");
  assert.equal(redirectUri({ origin: "https://x.github.io", pathname: "/Denotation/index.html" }, {}), "https://x.github.io/Denotation/");
  assert.equal(redirectUri({ origin: "http://127.0.0.1:8098", pathname: "/" }, {}), "http://127.0.0.1:8098/");
});

test("authorization URLs: Microsoft uses code + PKCE + nonce in the fragment; Google the token response", () => {
  const ms = new URL(buildAuthUrl({ provider: "microsoft", clientId: MS_ID, redirectUri: APP, state: "s".repeat(32), nonce: "n1", challenge: "c1" }));
  assert.equal(ms.origin + ms.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  const p = ms.searchParams;
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("response_mode"), "fragment");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.equal(p.get("code_challenge"), "c1");
  assert.equal(p.get("nonce"), "n1");
  assert.match(p.get("scope"), /Files\.ReadWrite\.AppFolder/);
  assert.match(p.get("scope"), /offline_access/);
  const g = new URL(buildAuthUrl({ provider: "google", clientId: G_ID, redirectUri: APP, state: "s".repeat(32) }));
  assert.equal(g.searchParams.get("response_type"), "token");
  assert.equal(g.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.file");
  assert.equal(g.searchParams.get("code_challenge"), null);
});

test("parseRedirect: fragment and query responses; app hashes are not responses", () => {
  const r = parseRedirect(`${APP}#state=abc&code=xyz&session_state=1`);
  assert.deepEqual(r.params, { code: "xyz", state: "abc", session_state: "1" });
  assert.equal(r.where, "hash");
  assert.equal(r.rest, "/Denotation/");
  const t = parseRedirect(`${APP}#access_token=ya29.t&token_type=Bearer&expires_in=3599&state=abc&scope=x`);
  assert.equal(t.params.access_token, "ya29.t");
  const q = parseRedirect(`${APP}?keep=1&code=c&state=s`);
  assert.equal(q.where, "query");
  assert.equal(q.rest, "/Denotation/?keep=1");
  assert.equal(parseRedirect(`${APP}#page-abc`), null);
  assert.equal(parseRedirect(`${APP}#code=1`), null, "no state: not ours");
  assert.equal(parseRedirect("not a url"), null);
});

test("id token checks: audience, nonce, issuer and expiry", () => {
  const now = Date.now();
  const ok = { aud: MS_ID, nonce: "n", iss: "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0", exp: now / 1000 + 600 };
  assert.ok(checkIdToken(ok, { clientId: MS_ID, nonce: "n", now }));
  assert.throws(() => checkIdToken({ ...ok, nonce: "other" }, { clientId: MS_ID, nonce: "n", now }), /nonce/);
  assert.throws(() => checkIdToken({ ...ok, aud: "x" }, { clientId: MS_ID, nonce: "n", now }), /another app/);
  assert.throws(() => checkIdToken({ ...ok, iss: "https://evil.example/v2.0" }, { clientId: MS_ID, nonce: "n", now }), /issuer/);
  assert.throws(() => checkIdToken({ ...ok, exp: now / 1000 - 3600 }, { clientId: MS_ID, nonce: "n", now }), /expired/);
  assert.equal(decodeJwtPayload("garbage"), null);
});

test("token records: Google must grant the Drive scope; token keys are validated", async () => {
  assert.throws(() => tokenRecord("google", { access_token: "t", token_type: "Bearer", expires_in: "3599", scope: "email" }, { wantScope: "https://www.googleapis.com/auth/drive.file" }), /wasn't granted/);
  const r = tokenRecord("google", { access_token: "t", token_type: "Bearer", expires_in: "3599", scope: "https://www.googleapis.com/auth/drive.file" }, { now: 1000, wantScope: "https://www.googleapis.com/auth/drive.file" });
  assert.equal(r.expiresAt, 1000 + 3599 * 1000);
  const hs = memoryHandles();
  const ts = tokenStore(hs);
  await assert.rejects(ts.put("loc:x", r), /Bad token key/);
  await assert.rejects(ts.put("tok:google:short", r), /Bad token key/);
  const key = newTokenKey("google");
  await ts.put(key, r);
  assert.equal((await ts.get(key)).accessToken, "t");
  await ts.delete(key);
  assert.equal(await ts.get(key), null);
});

test("code exchange verifies PKCE; a wrong verifier or a reused code fails", async () => {
  const id = fakeMsIdentity();
  const fetch = makeFetch(id);
  const verifier = randomString(48);
  const back = new URL(id.authorize(buildAuthUrl({ provider: "microsoft", clientId: MS_ID, redirectUri: APP, state: "s".repeat(32), nonce: "nn", challenge: await pkceChallenge(verifier) })));
  const code = new URLSearchParams(back.hash.slice(1)).get("code");
  await assert.rejects(exchangeCode({ code, verifier: randomString(48), clientId: MS_ID, redirectUri: APP, nonce: "nn", fetch }), /invalid_grant/);
  const back2 = new URL(id.authorize(buildAuthUrl({ provider: "microsoft", clientId: MS_ID, redirectUri: APP, state: "s".repeat(32), nonce: "nn", challenge: await pkceChallenge(verifier) })));
  const code2 = new URLSearchParams(back2.hash.slice(1)).get("code");
  const rec = await exchangeCode({ code: code2, verifier, clientId: MS_ID, redirectUri: APP, nonce: "nn", fetch });
  assert.match(rec.accessToken, /^mtoken-/);
  assert.match(rec.refreshToken, /^mrefresh-/);
  assert.equal(rec.account.hint, "someone@example.test");
  await assert.rejects(exchangeCode({ code: code2, verifier, clientId: MS_ID, redirectUri: APP, nonce: "nn", fetch }), /invalid_grant/, "codes are single use");
  await assert.rejects(exchangeCode({ code: "x", verifier, clientId: MS_ID, redirectUri: APP, nonce: "other", fetch }), /invalid_grant/);
});

test("refresh rotates the refresh token and keeps the 24 h deadline; an expired sign-in asks again", async () => {
  const id = fakeMsIdentity();
  const fetch = makeFetch(id);
  id.refresh.set("r0", { scope: "x" });
  const first = { provider: "microsoft", accessToken: "old", expiresAt: 0, refreshToken: "r0", refreshExpiresAt: Date.now() + 3600_000, account: { id: "a", hint: "" } };
  const next = await refreshAccess(first, { fetch });
  assert.notEqual(next.refreshToken, "r0");
  assert.equal(next.refreshExpiresAt, first.refreshExpiresAt);
  assert.deepEqual(next.account, first.account);
  await assert.rejects(refreshAccess(first, { fetch }), (e) => e.name === "NotAllowedError", "the old refresh token is spent");
  await assert.rejects(refreshAccess({ ...next, refreshExpiresAt: Date.now() - 1 }, { fetch }), (e) => e.name === "NotAllowedError" && /24 hours/.test(e.message));
});

test("completeResponse: state must match; provider errors are reported without secrets", async () => {
  const req = { provider: "google", state: "a".repeat(32), wantScope: "https://www.googleapis.com/auth/drive.file" };
  await assert.rejects(completeResponse({ state: "b".repeat(32), access_token: "t" }, req), /didn't match/);
  await assert.rejects(completeResponse({ state: req.state, error: "access_denied" }, req), (e) => e.code === "access_denied");
  await assert.rejects(completeResponse({ state: req.state, code: "c" }, req), /Unexpected code/);
});

test("popup sign-in (Microsoft): the child page relays over BroadcastChannel, the opener redeems the code", async () => {
  const id = fakeMsIdentity();
  const graph = fakeGraph();
  const fetch = makeFetch(id, graph);
  const hs = memoryHandles();
  const storage = memStorage();
  const prev = globalThis.localStorage;
  globalThis.localStorage = storage;
  try {
    let child;
    const opener = fakeWin(`${APP}#page-abc`, {
      onPopupNavigate: async (url) => {
        child = fakeWin(id.authorize(url));
        const r = await handleRedirect({ win: child, handles: hs, fetch });
        assert.deepEqual(r, { stop: true, handled: true });
      }
    });
    const rec = await authorize({ provider: "microsoft", wantScope: "Files.ReadWrite.AppFolder", win: opener, handles: hs, fetch });
    assert.match(rec.accessToken, /^mtoken-/);
    assert.equal(child.replaced.length, 1, "the child cleaned its address bar");
    assert.ok(!child.location.href.includes("code="));
    assert.equal(child.closed, true);
    assert.equal(opener.popup.closed, true);
    assert.deepEqual([...hs.map.keys()], [], "the pending record is gone");
    assert.equal(storage.map.size, 0, "nothing in localStorage");
  } finally {
    globalThis.localStorage = prev;
  }
});

test("popup sign-in (Google token response); a blocked popup is reported", async () => {
  const hs = memoryHandles();
  const opener = fakeWin(`${APP}`, {
    onPopupNavigate: async (url) => {
      const p = new URL(url).searchParams;
      const back = `${p.get("redirect_uri")}#access_token=ya29.fake&token_type=Bearer&expires_in=3599&scope=${encodeURIComponent(p.get("scope"))}&state=${p.get("state")}`;
      await handleRedirect({ win: fakeWin(back), handles: hs });
    }
  });
  const rec = await authorize({ provider: "google", scope: "https://www.googleapis.com/auth/drive.file", wantScope: "https://www.googleapis.com/auth/drive.file", win: opener, handles: hs });
  assert.equal(rec.accessToken, "ya29.fake");
  assert.equal(rec.refreshToken, undefined);
  const blocked = fakeWin(APP);
  blocked.blockPopups = true;
  await assert.rejects(authorize({ provider: "google", win: blocked, handles: hs }), (e) => e.code === "popup-blocked");
});

test("redirect sign-in: pending state survives the reload; the response adds the location and cleans the URL", async () => {
  const id = fakeMsIdentity();
  const fetch = makeFetch(id);
  const hs = memoryHandles();
  const storage = memStorage();
  const prev = globalThis.localStorage;
  globalThis.localStorage = storage;
  try {
    const win = fakeWin(`${APP}#page-xyz`);
    authorize({ provider: "microsoft", mode: "redirect", wantScope: "Files.ReadWrite.AppFolder", win, handles: hs, purpose: { kind: "add-onedrive", role: "main", folder: "Work notes", tokenKey: "tok:microsoft:0123456789abcdef0123" } });
    for (let i = 0; i < 200 && !win.assigned; i++) await new Promise((r) => setTimeout(r, 10));
    assert.match(win.assigned, /^https:\/\/login\.microsoftonline\.com\//);
    const pendingKeys = [...hs.map.keys()].filter((k) => k.startsWith("oauth:"));
    assert.equal(pendingKeys.length, 1);
    // back from the provider: a fresh page load
    const back = fakeWin(id.authorize(win.assigned));
    const r = await handleRedirect({ win: back, handles: hs, fetch });
    assert.deepEqual(r, { stop: false, handled: true });
    assert.equal(back.location.href, `${APP}#page-xyz`, "the app hash comes back, the code is gone");
    assert.equal(takeRedirectNotice().text, 'Added "OneDrive: Work notes".');
    const list = JSON.parse(storage.getItem(LOCATIONS_KEY));
    assert.equal(list.length, 1);
    assert.equal(list[0].type, "onedrive");
    assert.equal(list[0].role, "main");
    const handle = await hs.get(`loc:${list[0].id}`);
    assert.equal(handle.cloud, "onedrive");
    assert.match((await tokenStore(hs).get(handle.tokenKey)).accessToken, /^mtoken-/);
    assert.ok(![...storage.map.values()].some((v) => /mtoken|mrefresh/.test(v)), "tokens never reach localStorage");
    // the registry rebuilds the provider from the stored descriptor; removing the location deletes the token
    const reg = createLocationRegistry({ storage, handles: hs });
    assert.equal((await reg.getHandle(list[0].id)).type, "onedrive");
    await reg.deleteHandle(list[0].id);
    assert.equal(await tokenStore(hs).get(handle.tokenKey), null);
    assert.equal(await hs.get(`loc:${list[0].id}`), null);
    // replaying the same response does nothing (the pending record is spent)
    const replay = fakeWin(id.authorize(win.assigned));
    assert.deepEqual(await handleRedirect({ win: replay, handles: hs, fetch }), { stop: false, handled: false });
    assert.ok(!replay.location.href.includes("code="), "still cleaned");
  } finally {
    globalThis.localStorage = prev;
  }
});

test("stray or forged responses are ignored but still removed from the address bar", async () => {
  const hs = memoryHandles();
  const fetch = makeFetch();
  const win = fakeWin(`${APP}#access_token=stolen&state=${"z".repeat(32)}&token_type=Bearer`);
  assert.deepEqual(await handleRedirect({ win, handles: hs, fetch }), { stop: false, handled: false });
  assert.equal(win.location.href, APP);
  assert.equal(fetch.calls.length, 0);
  // stale pending record (older than 10 minutes): ignored and deleted
  const st = "y".repeat(32);
  await hs.put(`oauth:${st}`, { mode: "redirect", provider: "google", state: st, createdAt: Date.now() - 11 * 60_000 });
  assert.deepEqual(await handleRedirect({ win: fakeWin(`${APP}#access_token=t&state=${st}`), handles: hs, fetch }), { stop: false, handled: false });
  assert.equal(await hs.get(`oauth:${st}`), null);
  assert.deepEqual(await handleRedirect({ win: fakeWin(`${APP}#page-1`), handles: hs }), { stop: false, handled: false });
});

test("authedFetch: 429 waits for Retry-After, 5xx and network errors back off, 401 renews once", async () => {
  const drive = fakeDrive({ tokens: ["good"] });
  const sleeps = [];
  const sleep = async (ms) => void sleeps.push(ms);
  const url = "https://www.googleapis.com/drive/v3/about";
  drive.failNext((u) => u === url, 429, { "Retry-After": "2" });
  drive.failNext((u) => u === url, 503);
  let net = 1;
  const base = makeFetch(drive);
  const fetch = async (u, i) => {
    if (net-- > 0) throw new TypeError("network down");
    return base(u, i);
  };
  let renewed = 0;
  let tok = "expired";
  const getToken = async (force) => {
    if (force) {
      renewed++;
      tok = "good";
    }
    return tok;
  };
  const res = await authedFetch(url, {}, { getToken, fetch, sleep });
  assert.equal(res.status, 200);
  assert.equal(renewed, 1);
  assert.equal(sleeps.length, 3);
  assert.ok(sleeps.includes(2000));
  // 401 after renewing: a permission error (the location shows "Reconnect")
  drive.revoke("good");
  await assert.rejects(authedFetch(url, {}, { getToken, fetch: base, sleep }), (e) => e.name === "NotAllowedError");
  // persistent 503: gives up with a plain error after the retries
  drive.grant("good");
  drive.failNext((u) => u === url, 503, {}, 10);
  await assert.rejects(authedFetch(url, {}, { getToken, fetch: base, sleep, retries: 2 }), /HTTP 503/);
});
