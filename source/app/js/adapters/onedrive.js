// OneDrive as a storage location provider (main or backup), over Microsoft Graph with fetch (CORS).
// Same interface as the folder provider (locations.js):
//   { type, name, handle, permission(request), readText(path), writeText(path, text), remove(path), list(dir) }
//
// Layout: the app's own folder (scope Files.ReadWrite.AppFolder; "Apps/<app name>" in the user's OneDrive),
//   one sub-folder per workspace: approot/<folder>/denotation.json, pages/<id>.json, ...
//   Paths map 1:1 onto Graph path addressing (/me/drive/special/approot:/<folder>/<path>:), which also creates
//   missing parent folders on upload. OneDrive names are unique per folder, so there are no duplicates.
// Lost updates: denotation.json and keys.json are written with If-Match (the eTag from this device's last read)
//   or If-None-Match: * (it was missing when read). On a conflict (412) for denotation.json the file is written
//   again with its rev raised by one more, so every reader, this device included, sees a changed stamp and runs a
//   full merge; nothing is lost and sync doesn't stop (unless the two disagree about encryption: then, like a
//   conflict on keys.json, it is reported as an error).
// Tokens: auth code + PKCE; access tokens last ~1 h and are renewed with the refresh token (which lasts 24 h for
//   single-page apps); after that the location asks for one click to sign in again.
// The handle (stored in IndexedDB as the location's handle) is plain data:
//   { cloud: "onedrive", v: 1, tokenKey, folder, account: { id, hint } }
import { authorize, tokenStore, authedFetch, permissionError, refreshAccess, cloudWarning, MAX_CLOUD_FILE_BYTES, onRedirectPurpose, registerLocationFromRedirect, newTokenKey, validTokenKey } from "./oauth.js";
import { cleanFolderName } from "./gdrive.js";

export const GRAPH = "https://graph.microsoft.com/v1.0";
const APPROOT = `${GRAPH}/me/drive/special/approot`;
const GUARDED = new Set(["denotation.json", "keys.json"]);
const WANT = "Files.ReadWrite.AppFolder";

export function sanitizeOnedriveHandle(h) {
  if (!h || typeof h !== "object" || h.cloud !== "onedrive" || !validTokenKey(h.tokenKey) || !h.tokenKey.startsWith("tok:microsoft:")) return null;
  const folder = cleanFolderName(h.folder);
  if (!folder) return null;
  const account = h.account && typeof h.account === "object" ? { id: String(h.account.id ?? "").slice(0, 200), hint: String(h.account.hint ?? "").slice(0, 200) } : null;
  return { cloud: "onedrive", v: 1, tokenKey: h.tokenKey, folder, account };
}
export const onedriveName = (h) => `OneDrive: ${h.folder}`;
const enc = (path) => path.split("/").map(encodeURIComponent).join("/");
const graphUrl = (u) => typeof u === "string" && u.startsWith(`${GRAPH}/`);

/**
 * Sign in for a new OneDrive location from a click (opens the popup synchronously).
 * -> { handle, record }; the token is stored under handle.tokenKey.
 */
export function connectOnedrive({ folder = "Denotation", mode = "popup", role = "backup", signal, handles, fetch: fetchFn, win } = {}) {
  const name = cleanFolderName(folder);
  const tokenKey = newTokenKey("microsoft");
  const started = authorize({ provider: "microsoft", mode, wantScope: WANT, signal, handles, fetch: fetchFn, win, prompt: "select_account", purpose: { kind: "add-onedrive", role, folder: name, tokenKey } });
  return (async () => {
    if (!name) throw new Error("Use a folder name of 1–60 characters without / \\ : * ? \" < > | # %.");
    const rec = await started;
    await tokenStore(handles).put(tokenKey, rec);
    return { handle: { cloud: "onedrive", v: 1, tokenKey, folder: name, account: rec.account ?? null }, record: rec };
  })();
}
onRedirectPurpose("add-onedrive", async (rec, purpose, { handles }) => {
  const folder = cleanFolderName(purpose.folder);
  if (!folder || !validTokenKey(purpose.tokenKey) || !purpose.tokenKey.startsWith("tok:microsoft:")) throw new Error("The sign-in request was damaged.");
  const handle = { cloud: "onedrive", v: 1, tokenKey: purpose.tokenKey, folder, account: rec.account ?? null };
  await registerLocationFromRedirect({ handles, descriptor: handle, rec, tokenKey: purpose.tokenKey, role: purpose.role, name: onedriveName(handle), type: "onedrive" });
  return `Added "${onedriveName(handle)}".`;
});

/** The provider. deps (tests): { fetch, handles, sleep, now, win } */
export function onedriveProvider(handle, deps = {}) {
  const h = sanitizeOnedriveHandle(handle);
  if (!h) throw new Error("This OneDrive location's settings are damaged. Remove it and add it again.");
  const fetchFn = deps.fetch ?? ((...a) => globalThis.fetch(...a));
  const now = deps.now ?? (() => Date.now());
  const tokens = tokenStore(deps.handles ?? null);
  const win = deps.win ?? globalThis.window;
  const etags = new Map(); // guarded path -> eTag from the last read, or null when it was missing
  let token = null;
  let renewing = null;

  async function getToken(force) {
    if (!force) {
      token ??= await tokens.get(h.tokenKey);
      if (token && token.expiresAt - 60_000 > now()) return token.accessToken;
    }
    renewing ??= (async () => {
      const cur = token ?? (await tokens.get(h.tokenKey));
      if (!cur) throw permissionError("Sign in to OneDrive again.");
      const next = await refreshAccess(cur, { fetch: fetchFn, now: now() });
      await tokens.put(h.tokenKey, next);
      token = next;
      return next.accessToken;
    })().finally(() => {
      renewing = null;
    });
    return renewing;
  }
  const http = (url, init = {}) => authedFetch(url, init, { getToken, label: "OneDrive", fetch: fetchFn, sleep: deps.sleep });
  const item = (path) => `${APPROOT}:/${enc(h.folder)}${path ? `/${enc(path)}` : ""}:`;
  const fail = (what, res) => Object.assign(new Error(`OneDrive couldn't ${what} (HTTP ${res.status}).`), { status: res.status });

  async function put(path, text, guard) {
    const headers = { "Content-Type": "application/json; charset=UTF-8" };
    if (guard) {
      const tag = etags.get(path);
      if (typeof tag === "string") headers["If-Match"] = tag;
      else if (tag === null) headers["If-None-Match"] = "*";
    }
    return http(`${item(path)}/content`, { method: "PUT", headers, body: text });
  }
  const remember = async (path, res) => {
    if (!GUARDED.has(path)) return;
    try {
      const b = await res.json();
      etags.set(path, typeof b?.eTag === "string" ? b.eTag : undefined);
    } catch {
      etags.delete(path);
    }
  };
  /** denotation.json changed under us: write ours with rev + 1 over the current one so every reader merges. */
  async function writeManifestAfterConflict(text) {
    for (let i = 0; i < 3; i++) {
      const cur = await readGuarded("denotation.json");
      let ours;
      try {
        ours = JSON.parse(text);
      } catch {
        ours = null;
      }
      let theirs = null;
      try {
        theirs = cur == null ? null : JSON.parse(cur);
      } catch {
        theirs = null;
      }
      if (!ours || typeof ours !== "object") break;
      // Encryption on / off is never resolved automatically: stop and let the next sync look again.
      const encOf = (m) => JSON.stringify([m?.encrypted ?? null, m?.keyId ?? null, m?.encryption?.state ?? null]);
      if (theirs && encOf(theirs) !== encOf(ours)) break;
      const rev = Math.max(Number(ours.rev) || 0, Number(theirs?.rev) || 0) + 1;
      const res = await put("denotation.json", JSON.stringify({ ...ours, rev }, null, 2), true);
      if (res.ok) return remember("denotation.json", res);
      if (res.status !== 412 && res.status !== 409) throw fail("save denotation.json", res);
    }
    throw Object.assign(new Error("denotation.json keeps changing on another device. Sync will try again."), { code: "conflict" });
  }
  async function readGuarded(path) {
    const res = await http(`${item(path)}?$select=id,eTag,file`);
    if (res.status === 404) {
      etags.set(path, null);
      return null;
    }
    if (!res.ok) throw fail(`read ${path}`, res);
    const meta = await res.json();
    const body = await http(`${item(path)}/content`);
    if (body.status === 404) {
      etags.set(path, null);
      return null;
    }
    if (!body.ok) throw fail(`read ${path}`, body);
    etags.set(path, typeof meta?.eTag === "string" ? meta.eTag : undefined);
    return body.text();
  }

  return {
    type: "onedrive",
    cloud: true,
    get name() {
      return onedriveName(h);
    },
    handle: h,
    /** "granted" while a token is stored (renewed or re-asked for when used); request: sign in now (from a click). */
    async permission(request = false) {
      if (request) {
        const started = authorize({ provider: "microsoft", mode: "popup", wantScope: WANT, loginHint: h.account?.hint || undefined, handles: deps.handles, win, fetch: fetchFn });
        try {
          const rec = await started;
          if (h.account?.id && rec.account?.id && rec.account.id !== h.account.id) throw permissionError("That's a different Microsoft account than this location uses.");
          rec.account = h.account?.id ? h.account : rec.account;
          await tokens.put(h.tokenKey, rec);
          token = rec;
          return "granted";
        } catch (e) {
          if (e?.code === "popup-blocked" && win?.location) {
            await authorize({ provider: "microsoft", mode: "redirect", wantScope: WANT, loginHint: h.account?.hint || undefined, handles: deps.handles, win, purpose: { kind: "reauth", tokenKey: h.tokenKey } });
          }
          if (e?.name === "NotAllowedError") throw e;
          return "denied";
        }
      }
      // A stored sign-in counts; a request finds out whether it still works (and the location then shows
      // "Sign in again" instead of opening a sign-in window on the next click anywhere).
      token ??= await tokens.get(h.tokenKey).catch(() => null);
      return token ? "granted" : "prompt";
    },
    async readText(path) {
      if (GUARDED.has(path)) return readGuarded(path);
      const res = await http(`${item(path)}/content`);
      if (res.status === 404) return null;
      if (!res.ok) throw fail(`read ${path}`, res);
      return res.text();
    },
    async writeText(path, text) {
      const size = new TextEncoder().encode(text).length;
      if (size > MAX_CLOUD_FILE_BYTES) {
        cloudWarning({ type: "too-large", provider: "onedrive", location: onedriveName(h), path, size });
        return; // refused, not written
      }
      const guard = GUARDED.has(path);
      const res = await put(path, text, guard);
      if (res.ok) return remember(path, res);
      if (guard && (res.status === 412 || res.status === 409)) {
        if (path === "denotation.json") return writeManifestAfterConflict(text);
        etags.delete(path);
        throw Object.assign(new Error(`${path} was changed on another device at the same time. Try again.`), { code: "conflict" });
      }
      throw fail(`save ${path}`, res);
    },
    async remove(path) {
      const res = await http(item(path), { method: "DELETE" });
      if (GUARDED.has(path)) etags.set(path, null);
      if (!res.ok && res.status !== 404) throw fail(`delete ${path}`, res);
    },
    async list(dir) {
      const out = [];
      let url = `${item(dir)}/children?$select=name,file,folder&$top=999`;
      for (let i = 0; url && i < 200; i++) {
        const res = await http(url);
        if (res.status === 404) return [];
        if (!res.ok) throw fail(`list ${dir || "the folder"}`, res);
        const b = await res.json();
        for (const it of b.value ?? []) if (typeof it?.name === "string") out.push({ name: it.name, kind: it.folder ? "directory" : "file" });
        const next = b["@odata.nextLink"];
        url = graphUrl(next) ? next : null; // never send the token anywhere but Graph
      }
      return out;
    }
  };
}
