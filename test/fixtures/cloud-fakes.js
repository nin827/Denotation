// Fake HTTP backends for the cloud storage tests (Node unit tests and the Playwright test): Google Drive v3,
// Microsoft Graph (OneDrive app folder) and the Microsoft token endpoint (code + PKCE, refresh). No network.
import { createHash } from "node:crypto";

const json = (status, body, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const bearer = (init) => {
  const hd = init?.headers ?? {};
  const v = hd.Authorization ?? hd.authorization ?? (typeof hd.get === "function" ? hd.get("Authorization") : null);
  return typeof v === "string" && v.startsWith("Bearer ") ? v.slice(7) : null;
};
const header = (init, name) => {
  const hd = init?.headers ?? {};
  for (const [k, v] of Object.entries(hd)) if (k.toLowerCase() === name.toLowerCase()) return v;
  return null;
};

/** A fetch that routes to the given backends (each: { handles(url) -> bool, handle(url, init) -> Response }). */
export function makeFetch(...backends) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? "GET", auth: bearer(init) });
    for (const b of backends) if (b.handles(u)) return b.handle(u, init);
    throw new TypeError(`no route for ${u}`);
  };
  fn.calls = calls;
  return fn;
}

// ---------- Google Drive v3 ----------
export function fakeDrive({ tokens = ["gtoken"], user = { permissionId: "perm-1", emailAddress: "someone@example.test" } } = {}) {
  const files = new Map(); // id -> { id, name, mimeType, parents, content, createdTime, modifiedTime, trashed }
  let seq = 0;
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const tick = () => new Date((clock += 1000)).toISOString();
  const valid = new Set(tokens);
  const failures = []; // { match(url, init), status, headers, times }
  const lag = { hideNew: 0, hidden: new Set() }; // search lag: newly created files stay hidden from searches for N searches
  const stats = { search: 0, download: 0, upload: 0, update: 0, delete: 0, trash: 0 };
  const mk = (name, mimeType, parents, content = "") => {
    const id = `f${++seq}`;
    const t = tick();
    files.set(id, { id, name, mimeType, parents, content, createdTime: t, modifiedTime: t, trashed: false });
    if (lag.hideNew) lag.hidden.add(id);
    return files.get(id);
  };
  const ROOT = "root";
  const meta = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, createdTime: f.createdTime, trashed: f.trashed });
  function search(qs) {
    const name = /name = '((?:\\.|[^'\\])*)'/.exec(qs)?.[1]?.replace(/\\(.)/g, "$1");
    const mime = /mimeType = '((?:\\.|[^'\\])*)'/.exec(qs)?.[1];
    const parents = [...qs.matchAll(/'((?:\\.|[^'\\])*)' in parents/g)].map((m) => m[1]);
    const out = [...files.values()].filter((f) => !f.trashed && (name === undefined || f.name === name) && (!mime || f.mimeType === mime) && (!parents.length || f.parents.some((p) => parents.includes(p))) && !lag.hidden.has(f.id));
    if (lag.hidden.size && --lag.hideNew <= 0) lag.hidden.clear();
    return out;
  }
  function multipart(body, ct) {
    const boundary = /boundary=([^;]+)/.exec(ct)[1];
    const parts = body.split(`--${boundary}`).slice(1, -1).map((p) => p.replace(/^\r\n/, "").replace(/\r\n$/, ""));
    const [m, c] = parts.map((p) => p.slice(p.indexOf("\r\n\r\n") + 4));
    return { metadata: JSON.parse(m), content: c };
  }
  const api = {
    files,
    stats,
    lag,
    user,
    revoke: (t) => valid.delete(t),
    grant: (t) => valid.add(t),
    failNext: (match, status, headers = {}, times = 1, body = null) => failures.push({ match, status, headers, times, body }),
    handles: (u) => u.startsWith("https://www.googleapis.com/drive/v3/") || u.startsWith("https://www.googleapis.com/upload/drive/v3/"),
    async handle(u, init) {
      if (!valid.has(bearer(init))) return json(401, { error: { code: 401, message: "Invalid Credentials" } });
      const f = failures.find((x) => x.times > 0 && x.match(u, init));
      if (f) {
        f.times--;
        return json(f.status, f.body ?? { error: { code: f.status } }, f.headers);
      }
      const url = new URL(u);
      const method = init.method ?? "GET";
      const path = url.pathname;
      if (path === "/drive/v3/about") return json(200, { user });
      if (path === "/drive/v3/files" && method === "GET") {
        stats.search++;
        const all = search(url.searchParams.get("q") ?? "");
        const size = Number(url.searchParams.get("pageSize")) || 100;
        const start = Number(url.searchParams.get("pageToken") || 0);
        const page = all.slice(start, start + Math.min(size, api.pageSize ?? size));
        const next = start + page.length < all.length ? String(start + page.length) : undefined;
        return json(200, { files: page.map(meta), ...(next ? { nextPageToken: next } : {}) });
      }
      if (path === "/drive/v3/files" && method === "POST") {
        const b = JSON.parse(init.body);
        return json(200, meta(mk(b.name, b.mimeType, b.parents ?? [ROOT])));
      }
      if (path === "/upload/drive/v3/files" && method === "POST") {
        stats.upload++;
        const { metadata, content } = multipart(init.body, header(init, "Content-Type"));
        return json(200, meta(mk(metadata.name, metadata.mimeType ?? "application/json", metadata.parents ?? [ROOT], content)));
      }
      const m = /^\/(upload\/)?drive\/v3\/files\/([^/]+)$/.exec(path);
      if (m) {
        const file = files.get(decodeURIComponent(m[2]));
        if (!file || (file.trashed && method !== "GET")) return json(404, { error: { code: 404, message: "File not found" } });
        if (method === "GET" && url.searchParams.get("alt") === "media") {
          stats.download++;
          return new Response(file.content, { status: 200 });
        }
        if (method === "GET") return json(200, meta(file));
        if (method === "PATCH" && m[1]) {
          stats.update++;
          file.content = init.body;
          file.modifiedTime = tick();
          return json(200, meta(file));
        }
        if (method === "PATCH") {
          const b = JSON.parse(init.body);
          if (b.trashed) {
            stats.trash++;
            file.trashed = true;
          }
          return json(200, meta(file));
        }
        if (method === "DELETE") {
          stats.delete++;
          files.delete(file.id);
          return new Response(null, { status: 204 });
        }
      }
      return json(400, { error: { code: 400, message: `unhandled ${method} ${path}` } });
    },
    // ---- path helpers for scenario tests (My Drive/<root>/...) ----
    folderId(rootName, dir = "", create = true, space = ROOT) {
      let parent = [...files.values()].filter((f) => !f.trashed && f.name === rootName && f.parents.includes(space) && f.mimeType.endsWith("folder")).sort((a, b) => (a.createdTime < b.createdTime ? -1 : 1))[0];
      if (!parent) {
        if (!create) return null;
        parent = mk(rootName, "application/vnd.google-apps.folder", [space]);
      }
      if (!dir) return parent.id;
      let d = [...files.values()].find((f) => !f.trashed && f.name === dir && f.parents.includes(parent.id) && f.mimeType.endsWith("folder"));
      if (!d) {
        if (!create) return null;
        d = mk(dir, "application/vnd.google-apps.folder", [parent.id]);
      }
      return d.id;
    },
    put(rootName, path, content, { dup = false } = {}) {
      const i = path.lastIndexOf("/");
      const dir = i < 0 ? "" : path.slice(0, i);
      const name = path.slice(i + 1);
      const parent = api.folderId(rootName, dir);
      const cur = [...files.values()].find((f) => !f.trashed && f.name === name && f.parents.includes(parent));
      if (cur && !dup) {
        cur.content = content;
        cur.modifiedTime = tick();
        return cur;
      }
      return mk(name, "application/json", [parent], content);
    },
    all(rootName, path) {
      const i = path.lastIndexOf("/");
      const parent = api.folderId(rootName, i < 0 ? "" : path.slice(0, i), false);
      return [...files.values()].filter((f) => !f.trashed && f.name === path.slice(i + 1) && f.parents.includes(parent));
    },
    read(rootName, path) {
      const list = api.all(rootName, path).sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : -1));
      return list[0]?.content;
    },
    /** Every file under the workspace folder: { path: content } (newest of duplicates). */
    tree(rootName) {
      const root = api.folderId(rootName, "", false);
      const out = {};
      const walk = (id, prefix) => {
        for (const f of files.values()) {
          if (f.trashed || !f.parents.includes(id)) continue;
          if (f.mimeType.endsWith("folder")) walk(f.id, `${prefix}${f.name}/`);
          else out[`${prefix}${f.name}`] = api.read(rootName, `${prefix}${f.name}`);
        }
      };
      if (root) walk(root, "");
      return out;
    }
  };
  return api;
}

// ---------- Microsoft Graph (OneDrive app folder) + identity platform ----------
export function fakeGraph({ tokens = ["mtoken"] } = {}) {
  const items = new Map(); // "<folder>/<path>" -> { content, eTag, folder: bool }
  const valid = new Set(tokens);
  const failures = [];
  let n = 0;
  const stats = { get: 0, put: 0, del: 0, list: 0, conflicts: 0 };
  const PREFIX = "https://graph.microsoft.com/v1.0/me/drive/special/approot";
  const ensureParents = (p) => {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      if (!items.has(d)) items.set(d, { folder: true, eTag: `"d${++n}"` });
    }
  };
  const api = {
    items,
    stats,
    pageSize: 999,
    revoke: (t) => valid.delete(t),
    grant: (t) => valid.add(t),
    failNext: (match, status, headers = {}, times = 1) => failures.push({ match, status, headers, times }),
    handles: (u) => u.startsWith(PREFIX),
    async handle(u, init) {
      if (!valid.has(bearer(init))) return json(401, { error: { code: "InvalidAuthenticationToken" } });
      const f = failures.find((x) => x.times > 0 && x.match(u, init));
      if (f) {
        f.times--;
        return json(f.status, { error: { code: "fail" } }, f.headers);
      }
      const method = init.method ?? "GET";
      const rest = u.slice(PREFIX.length);
      const m = /^:\/(.+?):(\/content|\/children)?(\?.*)?$/.exec(rest);
      if (!m) return json(400, { error: { code: "bad path" } });
      const path = m[1].split("/").map(decodeURIComponent).join("/");
      const it = items.get(path);
      if (m[2] === "/children") {
        stats.list++;
        if (!it?.folder) return json(404, { error: { code: "itemNotFound" } });
        const kids = [...items].filter(([k]) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes("/")).map(([k, v]) => ({ name: k.slice(path.length + 1), ...(v.folder ? { folder: {} } : { file: {} }) }));
        const skip = Number(new URLSearchParams(m[3]?.slice(1) ?? "").get("$skiptoken") ?? 0);
        const page = kids.slice(skip, skip + api.pageSize);
        const next = skip + page.length < kids.length ? `${PREFIX}:/${m[1]}:/children?$skiptoken=${skip + page.length}` : undefined;
        return json(200, { value: page, ...(next ? { "@odata.nextLink": api.evilNextLink ?? next } : {}) });
      }
      if (m[2] === "/content" && method === "GET") {
        stats.get++;
        return it && !it.folder ? new Response(it.content, { status: 200 }) : json(404, { error: { code: "itemNotFound" } });
      }
      if (m[2] === "/content" && method === "PUT") {
        const ifMatch = header(init, "If-Match");
        const ifNone = header(init, "If-None-Match");
        if ((ifMatch && it?.eTag !== ifMatch) || (ifNone === "*" && it)) {
          stats.conflicts++;
          return json(412, { error: { code: "preconditionFailed" } });
        }
        stats.put++;
        ensureParents(path);
        const next = { content: init.body, eTag: `"e${++n}"`, folder: false };
        items.set(path, next);
        return json(it ? 200 : 201, { id: path, name: path.split("/").pop(), eTag: next.eTag, file: {} });
      }
      if (!m[2] && method === "GET") return it ? json(200, { id: path, eTag: it.eTag, ...(it.folder ? { folder: {} } : { file: {} }) }) : json(404, { error: { code: "itemNotFound" } });
      if (!m[2] && method === "DELETE") {
        stats.del++;
        if (!it) return json(404, { error: { code: "itemNotFound" } });
        for (const k of [...items.keys()]) if (k === path || k.startsWith(`${path}/`)) items.delete(k);
        return new Response(null, { status: 204 });
      }
      return json(400, { error: { code: `unhandled ${method}` } });
    },
    put(folder, path, content) {
      const p = `${folder}/${path}`;
      ensureParents(p);
      items.set(p, { content, eTag: `"e${++n}"`, folder: false });
    },
    read: (folder, path) => items.get(`${folder}/${path}`)?.content,
    tree(folder) {
      const out = {};
      for (const [k, v] of items) if (!v.folder && k.startsWith(`${folder}/`)) out[k.slice(folder.length + 1)] = v.content;
      return out;
    }
  };
  return api;
}

/** Microsoft identity platform: /authorize (issues a code bound to the PKCE challenge) and /token. */
export function fakeMsIdentity({ clientId = "ms-client-id-123", tid = "11111111-2222-3333-4444-555555555555", oid = "oid-1", graph } = {}) {
  const codes = new Map();
  const refresh = new Map(); // refresh token -> { scope }
  let n = 0;
  const jwt = (claims) => `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(claims))}.sig`;
  const api = {
    codes,
    refresh,
    lifetime: 3600,
    stats: { code: 0, refresh: 0 },
    /** What the authorize page would do after the user agrees: returns the redirect URL. */
    authorize(urlStr, { deny = false } = {}) {
      const u = new URL(urlStr);
      const p = u.searchParams;
      const back = new URL(p.get("redirect_uri"));
      const out = new URLSearchParams({ state: p.get("state") });
      if (deny) out.set("error", "access_denied");
      else {
        const code = `code-${++n}`;
        codes.set(code, { challenge: p.get("code_challenge"), method: p.get("code_challenge_method"), clientId: p.get("client_id"), redirectUri: p.get("redirect_uri"), nonce: p.get("nonce"), scope: p.get("scope") });
        out.set("code", code);
      }
      back.hash = out.toString();
      return back.toString();
    },
    handles: (u) => u === "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    async handle(u, init) {
      const p = new URLSearchParams(init.body);
      const issue = (scope, nonce) => {
        const at = `mtoken-${++n}`;
        const rt = `mrefresh-${n}`;
        graph?.grant(at);
        refresh.set(rt, { scope });
        const body = { token_type: "Bearer", access_token: at, refresh_token: rt, expires_in: api.lifetime, scope: "Files.ReadWrite.AppFolder openid profile" };
        if (nonce !== undefined) body.id_token = jwt({ aud: clientId, iss: `https://login.microsoftonline.com/${tid}/v2.0`, tid, oid, nonce, exp: Math.floor(Date.now() / 1000) + 3600, preferred_username: "someone@example.test" });
        return json(200, body);
      };
      if (p.get("client_id") !== clientId) return json(400, { error: "unauthorized_client" });
      if (p.get("grant_type") === "authorization_code") {
        api.stats.code++;
        const c = codes.get(p.get("code"));
        codes.delete(p.get("code")); // single use
        if (!c) return json(400, { error: "invalid_grant" });
        const challenge = b64url(createHash("sha256").update(p.get("code_verifier") ?? "").digest());
        if (c.method !== "S256" || challenge !== c.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        if (p.get("redirect_uri") !== c.redirectUri) return json(400, { error: "invalid_grant" });
        return issue(c.scope, c.nonce ?? null);
      }
      if (p.get("grant_type") === "refresh_token") {
        api.stats.refresh++;
        const r = refresh.get(p.get("refresh_token"));
        refresh.delete(p.get("refresh_token")); // rotation: single use
        if (!r) return json(400, { error: "invalid_grant" });
        return issue(r.scope, undefined);
      }
      return json(400, { error: "unsupported_grant_type" });
    }
  };
  return api;
}
