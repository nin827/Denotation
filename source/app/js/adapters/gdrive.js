// Google Drive as a storage location provider (main or backup), over Drive REST v3 with fetch.
// Same interface as the folder provider (locations.js):
//   { type, name, handle, permission(request), readText(path), writeText(path, text), remove(path), list(dir) }
//
// Layout: one folder per workspace, holding the usual vault files and sub-folders:
//   space "drive"   (scope drive.file):    My Drive/<folder>/denotation.json, pages/<id>.json, ...
//                    The app only sees files it created; other devices signed in to the same app see them too.
//   space "appdata" (scope drive.appdata): the hidden per-app folder, appDataFolder/<folder>/...
// Drive is id-based and allows several files with the same name in one folder (e.g. two devices creating
// pages/x.json at the same moment). Paths are resolved by name with a small cache:
//   - reading picks the most recently modified file of that name;
//   - writing updates that file and deletes the older duplicates;
//   - removing deletes every file of that name;
//   - duplicate sub-folders are all listed and searched; new files go to the oldest one.
// Drive v3 has no conditional (If-Match) writes; the sync code already re-reads denotation.json right before it
// stamps it, which keeps the race window short (see README_TECHNICAL.md).
// Drive search can lag just after a file is created, so files this device created in the last few minutes are
// remembered and merged into listings.
// The handle (stored in IndexedDB as the location's handle) is plain data:
//   { cloud: "gdrive", v: 1, tokenKey, folder, space, account: { id, hint } }
import { authorize, tokenStore, authedFetch, permissionError, clientId, cloudWarning, MAX_CLOUD_FILE_BYTES, PROVIDERS, onRedirectPurpose, registerLocationFromRedirect, newTokenKey, validTokenKey } from "./oauth.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FRESH_MS = 60_000; // a cached path from a listing this recent is used without another lookup
const MINE_MS = 5 * 60_000; // files created here this recently are merged into listings (search lag)
const FILE_FIELDS = "id,name,mimeType,modifiedTime,createdTime,trashed";
const ROOT_FILES = new Set(["denotation.json", "keys.json", "permissions.json"]); // always looked up fresh
const NAME_RE = /^[^\\/:*?"<>|#%\u0000-\u001f]{1,60}$/;

export const GDRIVE_SPACES = { drive: "drive.file", appdata: "drive.appdata" };
export const cleanFolderName = (v) => {
  const s = String(v ?? "").trim();
  return NAME_RE.test(s) && s !== "." && s !== ".." ? s : "";
};
export function sanitizeGdriveHandle(h) {
  if (!h || typeof h !== "object" || h.cloud !== "gdrive" || !validTokenKey(h.tokenKey) || !h.tokenKey.startsWith("tok:google:")) return null;
  const folder = cleanFolderName(h.folder);
  if (!folder) return null;
  const account = h.account && typeof h.account === "object" ? { id: String(h.account.id ?? "").slice(0, 200), hint: String(h.account.hint ?? "").slice(0, 200) } : null;
  return { cloud: "gdrive", v: 1, tokenKey: h.tokenKey, folder, space: h.space === "appdata" ? "appdata" : "drive", account };
}
export const gdriveName = (h) => `Google Drive${h.space === "appdata" ? " (app data)" : ""}: ${h.folder}`;
const scopeFor = (space) => PROVIDERS.google.scopes[space === "appdata" ? "appdata" : "drive"];
const q = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const time = (s) => Date.parse(s ?? "") || 0;
const split = (path) => {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i), path.slice(i + 1)];
};
const isRateLimit = async (res) => {
  const b = await res.json();
  return (b?.error?.errors ?? []).some((e) => /rateLimitExceeded|userRateLimitExceeded/.test(e?.reason ?? ""));
};

/**
 * Sign in for a new Google Drive location from a click (opens the popup synchronously).
 * -> { handle, record } after the user allowed access; the token is stored under handle.tokenKey.
 */
export function connectGdrive({ folder = "Denotation", space = "drive", mode = "popup", role = "backup", signal, handles, fetch: fetchFn, win } = {}) {
  const name = cleanFolderName(folder);
  const scope = scopeFor(space);
  const tokenKey = newTokenKey("google");
  const purpose = { kind: "add-gdrive", role, folder: name, space, tokenKey };
  const started = authorize({ provider: "google", mode, scope, wantScope: scope, signal, handles, fetch: fetchFn, win, purpose, prompt: "select_account" });
  return (async () => {
    if (!name) throw new Error("Use a folder name of 1–60 characters without / \\ : * ? \" < > | # %.");
    const rec = await started;
    const handle = await finishGdrive(rec, { folder: name, space, tokenKey, handles, fetch: fetchFn });
    return { handle, record: rec };
  })();
}
async function finishGdrive(rec, { folder, space, tokenKey, handles, fetch: fetchFn = globalThis.fetch }) {
  rec.account = await aboutAccount(rec.accessToken, fetchFn);
  await tokenStore(handles).put(tokenKey, rec);
  return { cloud: "gdrive", v: 1, tokenKey, folder, space: space === "appdata" ? "appdata" : "drive", account: rec.account };
}
/** The signed-in account ({ id: permissionId, hint: email }); used to check a later sign-in is the same person. */
async function aboutAccount(token, fetchFn) {
  try {
    const res = await authedFetch(`${API}/about?fields=user(permissionId,emailAddress)`, {}, { getToken: async () => token, label: "Google Drive", fetch: fetchFn, retries: 2 });
    const b = res.ok ? await res.json() : null;
    return { id: String(b?.user?.permissionId ?? "").slice(0, 200), hint: String(b?.user?.emailAddress ?? "").slice(0, 200) };
  } catch (e) {
    if (e?.name === "NotAllowedError") throw e;
    return { id: "", hint: "" };
  }
}
// A full-page sign-in (popup blocked) finishes at the next boot, before the storage code starts.
onRedirectPurpose("add-gdrive", async (rec, purpose, { handles, fetch: fetchFn }) => {
  const folder = cleanFolderName(purpose.folder);
  if (!folder || !validTokenKey(purpose.tokenKey) || !purpose.tokenKey.startsWith("tok:google:")) throw new Error("The sign-in request was damaged.");
  rec.account = await aboutAccount(rec.accessToken, fetchFn);
  const handle = { cloud: "gdrive", v: 1, tokenKey: purpose.tokenKey, folder, space: purpose.space === "appdata" ? "appdata" : "drive", account: rec.account };
  await registerLocationFromRedirect({ handles, descriptor: handle, rec, tokenKey: purpose.tokenKey, role: purpose.role, name: gdriveName(handle), type: "gdrive" });
  return `Added "${gdriveName(handle)}".`;
});

onRedirectPurpose("reauth-gdrive", async (rec, purpose, { handles, fetch: fetchFn }) => {
  if (!validTokenKey(purpose.tokenKey) || !purpose.tokenKey.startsWith("tok:google:")) throw new Error("The sign-in request was damaged.");
  const store = tokenStore(handles);
  const old = await store.get(purpose.tokenKey);
  const acct = await aboutAccount(rec.accessToken, fetchFn);
  if (old?.account?.id && acct.id && acct.id !== old.account.id) throw new Error("That's a different Google account than this location uses.");
  rec.account = old?.account?.id ? old.account : acct;
  await store.put(purpose.tokenKey, rec);
  return "Signed in to Google Drive again.";
});

/**
 * The provider. deps (tests): { fetch, handles, sleep, now, win, silent: false to skip the quiet iframe renewal }
 */
export function gdriveProvider(handle, deps = {}) {
  const h = sanitizeGdriveHandle(handle);
  if (!h) throw new Error("This Google Drive location's settings are damaged. Remove it and add it again.");
  const fetchFn = deps.fetch ?? ((...a) => globalThis.fetch(...a));
  const now = deps.now ?? (() => Date.now());
  const tokens = tokenStore(deps.handles ?? null);
  const win = deps.win ?? globalThis.window;
  const space = h.space === "appdata" ? "appDataFolder" : "drive";
  const parentRoot = h.space === "appdata" ? "appDataFolder" : "root";
  let renewing = null; // the token is read from the (maybe encrypted) store each time, never kept here
  let rootP = null;
  const dirs = new Map(); // dir -> Promise<string[]> (folder ids, oldest first)
  const files = new Map(); // path -> { id, dups: [id], at, mine }
  const listedAt = new Map(); // dir -> when it was last listed in full

  // ---------- tokens ----------
  async function getToken(force) {
    if (!force) {
      const token = await tokens.get(h.tokenKey);
      if (token && token.expiresAt - 60_000 > now()) return token.accessToken;
    }
    renewing ??= (async () => {
      if (deps.silent === false || !win?.document?.body || !clientId("google")) throw permissionError("Sign in to Google Drive again.");
      const rec = await authorize({ provider: "google", mode: "silent", scope: scopeFor(h.space), wantScope: scopeFor(h.space), loginHint: h.account?.hint || undefined, handles: deps.handles, win });
      await adopt(rec);
      return rec.accessToken;
    })().finally(() => {
      renewing = null;
    });
    return renewing;
  }
  async function adopt(rec) {
    const acct = await aboutAccount(rec.accessToken, fetchFn);
    if (h.account?.id && acct.id && acct.id !== h.account.id) throw permissionError("That's a different Google account than this location uses.");
    rec.account = h.account?.id ? h.account : acct;
    await tokens.put(h.tokenKey, rec);
  }
  const http = (url, init = {}) => authedFetch(url, init, { getToken, label: "Google Drive", fetch: fetchFn, sleep: deps.sleep, isRateLimit });
  const json = async (url, init) => {
    const res = await http(url, init);
    if (!res.ok) throw Object.assign(new Error(`Google Drive request failed (HTTP ${res.status}).`), { status: res.status });
    return res.json();
  };
  /** files.list over every page. */
  async function search(query) {
    const out = [];
    let pageToken = "";
    for (let i = 0; i < 200; i++) {
      const p = new URLSearchParams({ q: query, spaces: space, fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: "1000" });
      if (pageToken) p.set("pageToken", pageToken);
      const b = await json(`${API}/files?${p}`);
      out.push(...(b.files ?? []).filter((f) => f && typeof f.id === "string" && !f.trashed));
      pageToken = typeof b.nextPageToken === "string" ? b.nextPageToken : "";
      if (!pageToken) break;
    }
    return out;
  }
  const inParents = (ids) => `(${ids.map((id) => `${q(id)} in parents`).join(" or ")})`;
  async function createFolder(name, parent) {
    return json(`${API}/files?fields=${FILE_FIELDS}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }) });
  }
  const oldestFirst = (list) => list.sort((a, b) => time(a.createdTime) - time(b.createdTime) || (a.id < b.id ? -1 : 1));
  /** The workspace folder (created on first use). Several of the same name: the oldest. */
  function root() {
    rootP ??= (async () => {
      const find = async () => oldestFirst(await search(`name = ${q(h.folder)} and mimeType = ${q(FOLDER_MIME)} and ${q(parentRoot)} in parents and trashed = false`));
      const found = await find();
      if (found.length) return found[0].id;
      const made = await createFolder(h.folder, parentRoot);
      // Another device may have created it at the same moment: everyone settles on the oldest.
      const again = (await find()).filter((f) => f.id !== made.id);
      if (again.length && time(again[0].createdTime) <= time(made.createdTime)) {
        await deleteId(made.id).catch(() => {});
        return again[0].id;
      }
      return made.id;
    })().catch((e) => {
      rootP = null;
      throw e;
    });
    return rootP;
  }
  /** Folder ids for a sub-folder ("" = the workspace folder). create: make it when missing. */
  async function dirIds(dir, create) {
    const r = await root();
    if (!dir) return [r];
    let p = dirs.get(dir);
    if (!p) {
      p = search(`name = ${q(dir)} and mimeType = ${q(FOLDER_MIME)} and ${q(r)} in parents and trashed = false`).then((l) => oldestFirst(l).map((f) => f.id));
      dirs.set(dir, p);
      p.then((ids) => ids.length || dirs.get(dir) !== p || dirs.delete(dir), () => dirs.delete(dir)); // not found: ask again next time
    }
    let ids = await p;
    if (!ids.length && create) {
      p = createFolder(dir, r).then((f) => [f.id]);
      dirs.set(dir, p);
      p.catch(() => dirs.delete(dir));
      ids = await p;
    }
    return ids;
  }
  const pick = (list) => {
    const sorted = [...list].sort((a, b) => time(b.modifiedTime) - time(a.modifiedTime) || (a.id < b.id ? -1 : 1));
    return { id: sorted[0].id, dups: sorted.slice(1).map((f) => f.id) };
  };
  /** Resolve a path to { id, dups } or null. fresh: always ask Drive (root files, and stale cache entries). */
  async function resolve(path, { fresh = false } = {}) {
    const [dir, name] = split(path);
    const cached = files.get(path);
    if (cached && !fresh && !ROOT_FILES.has(path) && now() - cached.at < FRESH_MS) return cached;
    if (!cached && !fresh && dir && now() - (listedAt.get(dir) ?? -Infinity) < FRESH_MS) return null; // the listing just now didn't have it
    const ids = await dirIds(dir, false);
    const found = ids.length ? (await search(`name = ${q(name)} and ${inParents(ids)} and trashed = false`)).filter((f) => f.mimeType !== FOLDER_MIME) : [];
    if (found.length) {
      const e = { ...pick(found), at: now(), mine: cached?.mine ?? 0 };
      if (cached?.mine && cached.id !== e.id && !e.dups.includes(cached.id)) e.dups.push(cached.id);
      files.set(path, e);
      return e;
    }
    if (cached?.mine && now() - cached.mine < MINE_MS) {
      // Just created here; search may not show it yet.
      const res = await http(`${API}/files/${encodeURIComponent(cached.id)}?fields=id,trashed`);
      if (res.ok && !(await res.json()).trashed) return cached;
    }
    files.delete(path);
    return null;
  }
  const isGone = (res) => res.status === 404;
  async function deleteId(id) {
    // My Drive: to the trash (recoverable for 30 days); the hidden app folder has no trash.
    const res = h.space === "appdata"
      ? await http(`${API}/files/${encodeURIComponent(id)}`, { method: "DELETE" })
      : await http(`${API}/files/${encodeURIComponent(id)}?fields=id`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
    if (!res.ok && !isGone(res)) throw Object.assign(new Error(`Google Drive couldn't delete a file (HTTP ${res.status}).`), { status: res.status });
  }

  return {
    type: "gdrive",
    cloud: true,
    get name() {
      return gdriveName(h);
    },
    handle: h,
    /** "granted" when a token is stored (it is renewed or re-asked for when used); request: sign in now (from a click). */
    async permission(request = false) {
      if (request) {
        const started = authorize({ provider: "google", mode: "popup", scope: scopeFor(h.space), wantScope: scopeFor(h.space), loginHint: h.account?.hint || undefined, handles: deps.handles, win, fetch: fetchFn });
        try {
          await adopt(await started);
          return "granted";
        } catch (e) {
          if (e?.code === "popup-blocked" && win?.location) {
            await authorize({ provider: "google", mode: "redirect", scope: scopeFor(h.space), wantScope: scopeFor(h.space), loginHint: h.account?.hint || undefined, handles: deps.handles, win, purpose: { kind: "reauth-gdrive", tokenKey: h.tokenKey } });
          }
          if (e?.name === "NotAllowedError") throw e;
          return "denied";
        }
      }
      // Locked (PIN lock on, app locked): the sign-in is kept, so it counts; using it throws code "locked".
      const stored = await tokens.get(h.tokenKey).catch((e) => (e?.code === "locked" ? "locked" : null));
      return stored ? "granted" : "prompt";
    },
    async readText(path) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const e = await resolve(path, { fresh: attempt > 0 });
        if (!e) return null;
        const res = await http(`${API}/files/${encodeURIComponent(e.id)}?alt=media`);
        if (res.ok) return res.text();
        files.delete(path); // gone since we looked: look again once
      }
      return null;
    },
    async writeText(path, text) {
      const size = new TextEncoder().encode(text).length;
      if (size > MAX_CLOUD_FILE_BYTES) {
        cloudWarning({ type: "too-large", provider: "gdrive", location: gdriveName(h), path, size });
        return; // refused, not written: the copy in this browser stays, and the warning says so
      }
      const e = await resolve(path);
      if (e) {
        const res = await http(`${UPLOAD}/files/${encodeURIComponent(e.id)}?uploadType=media&fields=id,modifiedTime`, { method: "PATCH", headers: { "Content-Type": "application/json; charset=UTF-8" }, body: text });
        if (res.ok) {
          files.set(path, { id: e.id, dups: [], at: now(), mine: e.mine });
          for (const d of e.dups) await deleteId(d).catch(() => {});
          return;
        }
        if (!isGone(res)) throw Object.assign(new Error(`Google Drive couldn't save ${path} (HTTP ${res.status}).`), { status: res.status });
        files.delete(path);
      }
      const [dir, name] = split(path);
      const parent = (await dirIds(dir, true))[0];
      const boundary = `denotation-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent], mimeType: "application/json" })}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
      const made = await json(`${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
      files.set(path, { id: made.id, dups: [], at: now(), mine: now() });
    },
    async remove(path) {
      const e = await resolve(path, { fresh: true });
      if (!e) return;
      for (const id of [e.id, ...e.dups]) await deleteId(id);
      files.delete(path);
    },
    async list(dir) {
      const ids = await dirIds(dir, false);
      const seen = new Map();
      const started = now();
      if (ids.length) {
        const all = await search(`${inParents(ids)} and trashed = false`);
        const byName = new Map();
        for (const f of all) {
          if (typeof f.name !== "string") continue;
          if (f.mimeType === FOLDER_MIME) {
            seen.set(f.name, "directory");
            continue;
          }
          (byName.get(f.name) ?? byName.set(f.name, []).get(f.name)).push(f);
        }
        for (const [name, list] of byName) {
          const path = dir ? `${dir}/${name}` : name;
          const old = files.get(path);
          files.set(path, { ...pick(list), at: now(), mine: old?.mine ?? 0 });
          seen.set(name, "file");
        }
      }
      listedAt.set(dir, started);
      const prefix = dir ? `${dir}/` : "";
      for (const [path, e] of files) {
        const rest = path.slice(prefix.length);
        if (path.startsWith(prefix) && !rest.includes("/") && !seen.has(rest) && e.mine && now() - e.mine < MINE_MS) seen.set(rest, "file");
      }
      return [...seen].map(([name, kind]) => ({ name, kind }));
    }
  };
}
