// OAuth 2.0 for the cloud storage locations (Google Drive, OneDrive), written by hand: no third-party script is
// ever loaded (any script on the page could read the tokens).
//
// Flows
//   microsoft: authorization code + PKCE (S256) for a SPA, response_mode=fragment, refresh tokens (offline_access).
//              The token endpoint allows CORS for redirect URIs registered under the "Single-page application"
//              platform. OpenID id_token: nonce, aud and exp are checked (it comes straight from the token endpoint
//              over TLS, so its signature isn't checked; it is only used to recognise the account).
//   google:    Google requires a client secret to redeem a code for "Web application" clients, so a static site
//              can't use code + PKCE. We use the token ("implicit") response via popup or redirect instead:
//              response_type=token, no refresh token, access tokens last ~1 h. A quiet renewal is tried with
//              prompt=none in a hidden iframe; when Google refuses that, the location asks for one click
//              ("Reconnect"), which opens a popup that usually closes by itself.
//   Every request carries a random state (and nonce); the response must match a request this browser started.
//
// Where things live
//   Tokens: IndexedDB only (db "denotation", store "handles", keys "tok:<provider>:<random>"), via locations.js.
//     While the PIN lock is on they are stored encrypted with a key opened by the PIN (tokenLock.js); while the
//     app is locked they can't be read or written and cloud sync pauses (errors with code "locked").
//     They share the existing store instead of adding one so no second module has to bump the database version
//     (two upgrade paths racing would be worse than a key prefix). Never localStorage, never logged.
//     "Reset local cache" deletes the whole database; removing a location deletes its token.
//   Pending requests: "oauth:<state>" in the same store, for at most 10 minutes. Popup / iframe requests keep the
//     PKCE verifier in memory only; a full-page redirect has to keep it in the pending record until it returns.
//
// Redirect handling: the redirect URI is the app's own URL. handleRedirect() runs at boot before routing. It
//   cleans the address bar (history.replaceState) whenever it sees an OAuth response; in a popup / iframe it hands
//   the response to the window that asked (BroadcastChannel, same origin only) and tells the caller to stop.
import { config } from "../config.js";
import { tokenLockFor, isTokenKey } from "./tokenLock.js";
// locations.js is loaded lazily: it imports the providers, which import this module (no import cycle at load).
const locations = () => import("./locations.js");

export const PROVIDERS = {
  google: {
    label: "Google Drive",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    flow: "token",
    scopes: { drive: "https://www.googleapis.com/auth/drive.file", appdata: "https://www.googleapis.com/auth/drive.appdata" }
  },
  microsoft: {
    label: "OneDrive",
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    flow: "pkce",
    scope: "openid profile offline_access Files.ReadWrite.AppFolder"
  }
};
const PENDING_TTL_MS = 10 * 60_000;
const POPUP_TIMEOUT_MS = 5 * 60_000;
const SILENT_TIMEOUT_MS = 8000;
const MS_REFRESH_LIFETIME_MS = 24 * 3600_000; // SPA refresh tokens: 24 h from sign-in, not extended by use
const CHANNEL = "denotation-oauth";
const STATE_RE = /^[A-Za-z0-9_-]{22,64}$/;
const RESPONSE_KEYS = ["code", "access_token", "error", "id_token", "state", "token_type", "expires_in", "scope", "session_state", "error_description", "error_uri", "authuser", "prompt", "hd", "iss", "client_info"];

export const permissionError = (message) => Object.assign(new Error(message), { name: "NotAllowedError" });
const oauthError = (message, code) => Object.assign(new Error(message), { code });

// ---------- config ----------
const cleanId = (v) => (typeof v === "string" && /^[A-Za-z0-9._-]{8,200}$/.test(v.trim()) ? v.trim() : "");
/** The public OAuth client id for "google" / "microsoft" from config.js, or "" when the site owner hasn't set one. */
export const clientId = (provider, cfg = config) => cleanId(cfg?.oauth?.[provider]?.clientId);
export const cloudConfigured = (cfg = config) => !!(clientId("google", cfg) || clientId("microsoft", cfg));
/** The app's own URL without query, hash or a trailing index.html: what the owner registers as redirect URI. */
export function redirectUri(loc = globalThis.location, cfg = config) {
  const set = cfg?.oauth?.redirectUri;
  if (typeof set === "string" && /^https?:\/\//.test(set)) return set;
  if (!loc) return "";
  return `${loc.origin}${loc.pathname.replace(/index\.html$/, "")}`;
}

// ---------- PKCE, state, nonce ----------
const b64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const randomString = (bytes = 32) => b64url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
const randomHex = (bytes = 12) => [...globalThis.crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
/** RFC 7636 S256: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier) {
  return b64url(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
export const newTokenKey = (provider) => `tok:${provider}:${randomHex(12)}`;
export const validTokenKey = isTokenKey;

/** The authorization URL for one request. */
export function buildAuthUrl({ provider, clientId: id, redirectUri: uri, state, nonce, challenge, scope, prompt, loginHint }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown sign-in provider "${provider}".`);
  const q = new URLSearchParams({ client_id: id, redirect_uri: uri, state });
  if (p.flow === "pkce") {
    q.set("response_type", "code");
    q.set("response_mode", "fragment");
    q.set("scope", scope ?? p.scope);
    q.set("code_challenge", challenge);
    q.set("code_challenge_method", "S256");
    if (nonce) q.set("nonce", nonce);
  } else {
    q.set("response_type", "token");
    q.set("scope", scope ?? p.scopes.drive);
    q.set("include_granted_scopes", "false");
  }
  if (prompt) q.set("prompt", prompt);
  if (loginHint) q.set("login_hint", loginHint);
  return `${p.authorize}?${q}`;
}

/**
 * The OAuth response in a URL, or null. Looks at the fragment first (our requests use it), then the query.
 * -> { params: { state, code?, access_token?, error?, ... }, where: "hash" | "query", rest: <href without it> }
 */
export function parseRedirect(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const looks = (sp) => sp.has("state") && (sp.has("code") || sp.has("access_token") || sp.has("error"));
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  let where = null;
  let sp = null;
  if (url.hash.length > 1 && looks(hash)) [where, sp] = ["hash", hash];
  else if (looks(url.searchParams)) [where, sp] = ["query", url.searchParams];
  if (!sp) return null;
  const params = {};
  for (const k of RESPONSE_KEYS) if (sp.has(k)) params[k] = String(sp.get(k)).slice(0, 8192);
  if (where === "query") {
    for (const k of RESPONSE_KEYS) url.searchParams.delete(k);
  }
  url.hash = "";
  return { params, where, rest: `${url.pathname}${url.search}` };
}

// ---------- id tokens (Microsoft) ----------
export function decodeJwtPayload(jwt) {
  const part = String(jwt ?? "").split(".")[1];
  if (!part) return null;
  try {
    const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}
/** Check an id_token's claims against the request. Throws on a mismatch. */
export function checkIdToken(payload, { clientId: id, nonce, now = Date.now() }) {
  if (!payload || typeof payload !== "object") throw oauthError("The sign-in response had no readable identity.", "bad-id-token");
  if (payload.aud !== id) throw oauthError("The sign-in response was meant for another app.", "bad-id-token");
  if (nonce && payload.nonce !== nonce) throw oauthError("The sign-in response didn't match this request (nonce).", "bad-id-token");
  if (!(Number(payload.exp) * 1000 > now - 300_000)) throw oauthError("The sign-in response has expired.", "bad-id-token");
  if (typeof payload.iss !== "string" || !/^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/.test(payload.iss)) throw oauthError("The sign-in response came from an unexpected issuer.", "bad-id-token");
  return payload;
}

// ---------- token records ----------
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
/** Normalise a token response into the record we keep. Throws when the needed access wasn't granted. */
export function tokenRecord(provider, res, { now = Date.now(), wantScope, previous = null } = {}) {
  if (!res || typeof res !== "object" || typeof res.access_token !== "string" || !res.access_token) throw oauthError("The sign-in response had no access token.", "no-token");
  if (res.token_type && String(res.token_type).toLowerCase() !== "bearer") throw oauthError("Unexpected token type.", "no-token");
  const scope = String(res.scope ?? previous?.scope ?? "");
  if (wantScope && !scope.split(/\s+/).some((s) => s === wantScope || s.endsWith(`/${wantScope}`))) {
    throw oauthError(provider === "google" ? "Google Drive access wasn't granted. Sign in again and allow access to the app's files." : "OneDrive access wasn't granted.", "scope");
  }
  const rec = { provider, accessToken: res.access_token, expiresAt: now + num(res.expires_in, 3600) * 1000, scope, obtainedAt: now };
  if (provider === "microsoft") {
    const refresh = typeof res.refresh_token === "string" && res.refresh_token ? res.refresh_token : previous?.refreshToken ?? null;
    if (refresh) rec.refreshToken = refresh;
    const given = Number(res.refresh_token_expires_in) > 0 ? now + Number(res.refresh_token_expires_in) * 1000 : Infinity;
    const deadline = res.refresh_token && !previous ? now + MS_REFRESH_LIFETIME_MS : previous?.refreshExpiresAt ?? now + MS_REFRESH_LIFETIME_MS;
    rec.refreshExpiresAt = Math.min(deadline, given);
  }
  return rec;
}

/**
 * Token storage over the IndexedDB handle store. Keys must look like "tok:<provider>:<hex>". Encrypted while the
 * PIN lock is on; get / put throw code "locked" while the app is locked.
 */
export function tokenStore(handles = null) {
  const lk = async () => tokenLockFor(handles ?? (await defaultHandles()));
  return {
    async get(key) {
      if (!validTokenKey(key)) return null;
      return (await lk()).read(key);
    },
    async put(key, rec) {
      if (!validTokenKey(key)) throw new Error("Bad token key.");
      await (await lk()).write(key, rec);
    },
    delete: async (key) => (validTokenKey(key) ? (await lk()).remove(key) : undefined)
  };
}
/** The IndexedDB handle store (memory when IndexedDB is missing), shared with locations.js. */
export async function defaultHandles() {
  return (await locations()).sharedHandles();
}
/** The token lock of the app's handle store (opened at unlock, closed at lock; see tokenLock.js). */
export const defaultTokenLock = async () => tokenLockFor(await defaultHandles());

// ---------- token endpoint (Microsoft) ----------
async function postForm(fetchFn, url, form, { refreshing = false } = {}) {
  let res;
  try {
    res = await fetchFn(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  } catch {
    throw oauthError("Couldn't reach the sign-in service. Check your connection.", "network");
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const code = typeof body?.error === "string" ? body.error.slice(0, 60) : `http-${res.status}`;
    const e = refreshing && (code === "invalid_grant" || code === "interaction_required" || code === "login_required" || code === "consent_required")
      ? permissionError("Sign in to OneDrive again.")
      : oauthError(`Sign-in failed (${code}).`, code);
    e.oauth = code;
    throw e;
  }
  return body;
}
/** Redeem an authorization code (PKCE). */
export async function exchangeCode({ provider = "microsoft", code, verifier, clientId: id, redirectUri: uri, nonce, fetch: fetchFn = globalThis.fetch, now = Date.now() }) {
  const p = PROVIDERS[provider];
  if (p?.flow !== "pkce") throw new Error(`${provider} doesn't use the code flow here.`);
  const body = await postForm(fetchFn, p.token, { client_id: id, grant_type: "authorization_code", code, redirect_uri: uri, code_verifier: verifier, scope: p.scope });
  const rec = tokenRecord(provider, body, { now, wantScope: "Files.ReadWrite.AppFolder" });
  if (body.id_token) {
    const claims = checkIdToken(decodeJwtPayload(body.id_token), { clientId: id, nonce, now });
    rec.account = accountFromClaims(claims);
  } else if (nonce) throw oauthError("The sign-in response had no identity token.", "bad-id-token");
  return rec;
}
const accountFromClaims = (c) => ({ id: `${String(c.tid ?? "").slice(0, 64)}.${String(c.oid ?? c.sub ?? "").slice(0, 64)}`, hint: typeof c.preferred_username === "string" ? c.preferred_username.slice(0, 200) : "" });
/** Use a refresh token (Microsoft). Returns the new record (refresh tokens rotate). */
export async function refreshAccess(rec, { clientId: id = clientId("microsoft"), fetch: fetchFn = globalThis.fetch, now = Date.now() } = {}) {
  if (rec?.provider !== "microsoft" || !rec.refreshToken) throw permissionError("Sign in again.");
  if (rec.refreshExpiresAt && rec.refreshExpiresAt <= now) throw permissionError("Sign in to OneDrive again (sign-ins last 24 hours).");
  const p = PROVIDERS.microsoft;
  const body = await postForm(fetchFn, p.token, { client_id: id, grant_type: "refresh_token", refresh_token: rec.refreshToken, scope: p.scope }, { refreshing: true });
  const next = tokenRecord("microsoft", body, { now, previous: rec, wantScope: "Files.ReadWrite.AppFolder" });
  if (rec.account) next.account = rec.account;
  return next;
}

// ---------- interactive and quiet sign-in ----------
const live = new Map(); // state -> { resolve, reject, provider, verifier, nonce } for popup / iframe requests in this window
let channel = null;
function listen(win) {
  if (channel !== null) return;
  channel = false;
  const onMsg = (data) => {
    if (!data || data.type !== "denotation-oauth" || typeof data.params?.state !== "string") return;
    const req = live.get(data.params.state);
    if (req) req.receive(data.params);
  };
  if (typeof globalThis.BroadcastChannel === "function") {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e) => onMsg(e.data);
    channel.unref?.(); // Node (tests): don't keep the process alive
  }
  win?.addEventListener?.("message", (e) => {
    if (e.origin === win.location?.origin) onMsg(e.data);
  });
}

/**
 * Turn a response (params from the redirect) into a token record for request `req`.
 * req: { provider, state, verifier?, nonce?, wantScope, clientId, redirectUri }
 */
export async function completeResponse(params, req, { fetch: fetchFn = globalThis.fetch, now = Date.now() } = {}) {
  if (!params || params.state !== req.state) throw oauthError("The sign-in response didn't match this request.", "state");
  if (params.error) {
    const code = String(params.error).slice(0, 60);
    throw oauthError(code === "access_denied" ? "Sign-in was cancelled." : code === "interaction_required" || code === "login_required" || code === "consent_required" ? "Sign-in needs you." : `Sign-in failed (${code}).`, code);
  }
  if (PROVIDERS[req.provider].flow === "pkce") {
    if (!params.code) throw oauthError("The sign-in response had no code.", "no-code");
    return exchangeCode({ provider: req.provider, code: params.code, verifier: req.verifier, clientId: req.clientId, redirectUri: req.redirectUri, nonce: req.nonce, fetch: fetchFn, now });
  }
  if (params.code) throw oauthError("Unexpected code response.", "no-token");
  return tokenRecord(req.provider, params, { now, wantScope: req.wantScope });
}

/**
 * Start a sign-in. mode: "popup" (default; opens the window synchronously, so call it straight from a click),
 * "redirect" (leaves the page; handleRedirect finishes it on return; `purpose` says what to do then) or "silent"
 * (Google only: hidden iframe with prompt=none). Resolves the token record (popup / silent); a redirect never resolves.
 * opts: { provider, scope?, wantScope, loginHint?, prompt?, signal?, purpose?, win?, handles?, fetch? }
 */
export function authorize(opts) {
  const win = opts.win ?? globalThis.window;
  const mode = opts.mode ?? "popup";
  const popup = mode === "popup" ? win.open("about:blank", "denotation-oauth", "popup,width=520,height=680") : null;
  return (async () => {
    const provider = opts.provider;
    const id = clientId(provider, opts.config);
    if (!id) {
      try {
        popup?.close();
      } catch {
        // ignore
      }
      throw oauthError(`${PROVIDERS[provider]?.label ?? provider} isn't configured. The site owner must add a client ID.`, "not-configured");
    }
    if (mode === "popup" && !popup) throw oauthError("The sign-in window was blocked.", "popup-blocked");
    const handles = opts.handles ?? (await defaultHandles());
    const state = randomString(24);
    const verifier = PROVIDERS[provider].flow === "pkce" ? randomString(48) : null;
    const nonce = PROVIDERS[provider].flow === "pkce" ? randomString(16) : null;
    const uri = redirectUri(win.location, opts.config);
    const url = buildAuthUrl({ provider, clientId: id, redirectUri: uri, state, nonce, challenge: verifier ? await pkceChallenge(verifier) : null, scope: opts.scope, prompt: mode === "silent" ? "none" : opts.prompt, loginHint: opts.loginHint });
    const req = { provider, state, verifier, nonce, wantScope: opts.wantScope, clientId: id, redirectUri: uri };
    const pendingKey = `oauth:${state}`;
    if (mode === "redirect") {
      await handles.put(pendingKey, { ...req, mode, createdAt: Date.now(), purpose: opts.purpose ?? null, returnHash: String(win.location.hash ?? "").slice(0, 300) });
      win.location.assign(url);
      return new Promise(() => {}); // the page is leaving
    }
    await handles.put(pendingKey, { mode, provider, createdAt: Date.now() }); // lets the child window recognise it; no secrets
    listen(win);
    let frame = null;
    let timer = null;
    try {
      const params = await new Promise((resolve, reject) => {
        live.set(state, { receive: resolve });
        timer = setTimeout(() => reject(mode === "silent" ? permissionError("Quiet sign-in didn't work.") : oauthError("Sign-in didn't finish. Try again.", "timeout")), mode === "silent" ? SILENT_TIMEOUT_MS : POPUP_TIMEOUT_MS);
        opts.signal?.addEventListener?.("abort", () => reject(oauthError("Sign-in was cancelled.", "access_denied")), { once: true });
        if (popup) popup.location.href = url;
        else {
          frame = win.document.createElement("iframe");
          frame.hidden = true;
          frame.setAttribute("aria-hidden", "true");
          frame.src = url;
          win.document.body.append(frame);
        }
      });
      return await completeResponse(params, req, { fetch: opts.fetch ?? globalThis.fetch });
    } catch (e) {
      if (mode === "silent" && e?.name !== "NotAllowedError") throw permissionError(e.message);
      throw e;
    } finally {
      clearTimeout(timer);
      live.delete(state);
      frame?.remove();
      try {
        if (popup && !popup.closed) popup.close();
      } catch {
        // severed by the provider's opener policy: the popup closes itself
      }
      await handles.delete(pendingKey).catch(() => {});
    }
  })();
}

// ---------- boot: handle a response in the address bar ----------
let notice = null;
/** A message from a sign-in that finished (or failed) during boot, once. -> { kind: "info"|"error", text } | null */
export function takeRedirectNotice() {
  const n = notice;
  notice = null;
  return n;
}
/** What a finished redirect sign-in does next ("reauth" here; the providers register "add-<type>" and their own). */
const purposes = new Map();
export const onRedirectPurpose = (name, fn) => void purposes.set(name, fn);
// Reconnect through a full-page sign-in: store the fresh token for the existing location (same account only).
onRedirectPurpose("reauth", async (rec, purpose, { handles }) => {
  if (!validTokenKey(purpose.tokenKey) || !purpose.tokenKey.startsWith(`tok:${rec.provider}:`)) throw new Error("The sign-in request was damaged.");
  const store = tokenStore(handles);
  const old = await store.get(purpose.tokenKey);
  if (old?.account?.id && rec.account?.id && rec.account.id !== old.account.id) throw new Error("That's a different account than this location uses.");
  rec.account = old?.account ?? rec.account;
  await store.put(purpose.tokenKey, rec);
  return "Signed in again.";
});

/**
 * Call once at boot, before routing. Returns { stop: true } in a sign-in popup / iframe (the response was handed
 * to the window that asked; the app must not start), otherwise { stop: false, handled }.
 */
export async function handleRedirect({ win = globalThis.window, handles, fetch: fetchFn = globalThis.fetch, now = Date.now() } = {}) {
  const parsed = win?.location ? parseRedirect(win.location.href) : null;
  if (!parsed) return { stop: false, handled: false };
  // The response (a code or token) leaves the address bar and the history entry right away.
  const clean = (hash = "") => {
    try {
      win.history.replaceState(win.history.state, "", `${parsed.rest}${hash}`);
    } catch {
      // ignore
    }
  };
  clean();
  const { params } = parsed;
  if (!STATE_RE.test(params.state ?? "")) return { stop: false, handled: false };
  const hs = handles ?? (await defaultHandles());
  await locations(); // registers the providers' redirect purposes
  const key = `oauth:${params.state}`;
  const pending = await hs.get(key).catch(() => null);
  if (!pending || !(Number(pending.createdAt) > now - PENDING_TTL_MS)) {
    if (pending) await hs.delete(key).catch(() => {});
    return { stop: false, handled: false }; // stray or stale: ignored
  }
  if (pending.mode !== "redirect") {
    // A popup or iframe: hand the response to the window that asked, same origin only.
    const msg = { type: "denotation-oauth", params };
    try {
      if (typeof globalThis.BroadcastChannel === "function") {
        const bc = new BroadcastChannel(CHANNEL);
        bc.postMessage(msg);
        bc.close();
      }
    } catch {
      // ignore
    }
    for (const w of [win.opener, win.parent !== win ? win.parent : null]) {
      try {
        w?.postMessage(msg, win.location.origin);
      } catch {
        // severed opener
      }
    }
    try {
      if (win.document?.body) win.document.body.textContent = "Signed in. You can close this window.";
      if (win.parent === win) win.close();
    } catch {
      // ignore
    }
    return { stop: true, handled: true };
  }
  await hs.delete(key).catch(() => {});
  clean(typeof pending.returnHash === "string" && /^#[A-Za-z0-9_-]{0,200}$/.test(pending.returnHash) ? pending.returnHash : "");
  const finish = async (at) => {
    try {
      const rec = await completeResponse(params, pending, { fetch: fetchFn, now: at });
      const run = purposes.get(pending.purpose?.kind);
      if (!run) throw new Error("Nothing was waiting for this sign-in.");
      notice = { kind: "info", text: await run(rec, pending.purpose, { handles: hs, fetch: fetchFn }) };
    } catch (e) {
      notice = { kind: "error", text: `Sign-in failed: ${e?.message ?? e}` };
    }
  };
  // With the PIN lock on, the new token can only be stored encrypted: finish after the PIN is entered. The
  // response stays in memory only until then (finishDeferredRedirect).
  if ((await tokenLockFor(hs).state().catch(() => "locked")) === "locked") {
    deferred = finish;
    return { stop: false, handled: true, deferred: true };
  }
  await finish(now);
  return { stop: false, handled: true };
}
let deferred = null;
/** Finish a redirect sign-in that waited for the unlock (call after the PIN opened the token key). */
export async function finishDeferredRedirect({ now = Date.now() } = {}) {
  const run = deferred;
  deferred = null;
  if (run) await run(now);
}

// ---------- HTTP with a bearer token, retries and backoff ----------
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * fetch with "Authorization: Bearer" from getToken(force). 401 -> one forced renewal, then NotAllowedError.
 * 429 / 5xx / network errors -> up to `retries` more attempts with exponential backoff (Retry-After honoured,
 * at most 30 s). Returns the Response for 2xx, 304, 404, 409 and 412; throws otherwise.
 * isRateLimit(res, body) lets a caller treat a 403 as throttling (Google's rateLimitExceeded).
 */
export async function authedFetch(url, init, { getToken, label = "Cloud storage", fetch: fetchFn = globalThis.fetch, sleep = defaultSleep, retries = 4, isRateLimit } = {}) {
  let renewed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await getToken(false);
    const headers = { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` };
    let res;
    try {
      if (globalThis.navigator?.onLine === false) throw new TypeError("offline");
      res = await fetchFn(url, { ...init, headers });
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      if (attempt < retries && globalThis.navigator?.onLine !== false) {
        await sleep(backoff(attempt));
        continue;
      }
      throw Object.assign(new Error(`${label} isn't reachable. Check your connection.`), { code: "network" });
    }
    if (res.ok || [304, 404, 409, 412].includes(res.status)) return res;
    if (res.status === 401) {
      if (!renewed) {
        renewed = true;
        await getToken(true);
        attempt--;
        continue;
      }
      throw permissionError(`Sign in to ${label} again.`);
    }
    let throttled = RETRY_STATUS.has(res.status);
    if (res.status === 403 && isRateLimit) throttled = await isRateLimit(res.clone()).catch(() => false);
    if (throttled && attempt < retries) {
      const ra = Number(res.headers?.get?.("Retry-After"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : backoff(attempt));
      continue;
    }
    if (res.status === 403) throw permissionError(`${label} refused access.`);
    throw Object.assign(new Error(`${label} request failed (HTTP ${res.status}).`), { code: `http-${res.status}`, status: res.status });
  }
}
const backoff = (attempt) => Math.min(500 * 2 ** attempt, 16_000) + Math.floor(Math.random() * 250);

// ---------- size guard and warnings ----------
/** Files above this are refused by the cloud providers (not written) and reported; records should stay < ~250 KB. */
export const MAX_CLOUD_FILE_BYTES = 4 * 1024 * 1024;
const warnFns = new Set();
/** Listen for provider warnings (e.g. a file too large to upload). -> unsubscribe */
export const onCloudWarning = (fn) => (warnFns.add(fn), () => warnFns.delete(fn));
export function cloudWarning(w) {
  for (const f of [...warnFns]) {
    try {
      f(w);
    } catch {
      // listeners must not break storage
    }
  }
}

// ---------- the "add a location" purpose, shared by both providers ----------
/**
 * After a redirect sign-in for a new location: store the token and add the location to this device's config, so
 * the storage code connects it on this boot. Runs before the storage adapter exists.
 */
export async function registerLocationFromRedirect({ handles, storage, descriptor, rec, tokenKey, role, name, type, now = Date.now() }) {
  const ts = tokenStore(handles);
  const { createLocationRegistry, sameCloudFolder } = await locations();
  const registry = createLocationRegistry({ storage, handles });
  const list = await registry.migrate(now);
  for (const l of list) {
    if (l.type === type && sameCloudFolder((await registry.getHandle(l.id).catch(() => null))?.handle, descriptor)) throw new Error(`"${l.name}" is already connected.`);
  }
  await ts.put(tokenKey, rec);
  const id = registry.newId();
  await registry.putHandle(id, descriptor);
  const next = list.map((l) => (role === "main" && l.role === "main" ? { ...l, role: "backup" } : l));
  next.push({ id, type, name, role: role === "main" ? "main" : "backup", addedAt: now, lastSyncAt: 0, seen: null });
  registry.save(next);
  return id;
}
