// Workspace <-> file map ([{ path, data }]) for ZIP and folder import/export. Pure: no DOM.
//
// JSON format (full fidelity):
//   denotation.json                 { app: "denotation", format: "json", version: 1, exportedAt }
//   pages/<id>.json, rows/<id>.json one record per file, exactly as stored
//
// Markdown format (vanilla, readable in any editor or Obsidian):
//   <Repository>/                   one folder per repository
//     <Page>.md                     doc page (YAML front-matter `title`, then the body)
//     <Page>/                       sub-pages of <Page>, next to <Page>.md (same base name)
//     <Database>.csv                database rows (column values)
//     <Database>/<Row>.md           a row's page body, only when it has content
//   attachments/image-<n>.<ext>     embedded images, linked relatively
// Names are sanitised (no characters illegal on Windows/macOS, max 80 characters, no reserved
// names) and made unique per folder, case-insensitively ("Notes", "Notes 2"). Trashed pages are left out.
// Links between pages become relative links to the target .md (or .csv for databases).
import { previewMarkdown, resolveValue, findChipPreset, resolvePreset, presetKey } from "./preview.js";
import { blocksToMarkdown, markdownToBlocks } from "./blocks/markdown.js";
import { newBlock } from "./blocks/model.js";
import { databaseToCsv } from "./csv.js";
import { toText } from "./dbviews.js";
import { isTrashed } from "./workspace.js";

export const MANIFEST = "denotation.json";
const ID_RE = /^[A-Za-z0-9-]{1,100}$/;
const PAGE_TYPES = new Set(["repo", "doc", "database", "sync"]);
const IMAGE_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const IMAGE_MAX = 200 * 1024; // embedded images are stored inside the page record (~250 KB limit)
const TEXT_MAX = 2 * 1024 * 1024;

const dec = new TextDecoder("utf-8");
export const asText = (d) => (typeof d === "string" ? d : dec.decode(d)).replace(/^﻿/, "");
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const extOf = (p) => (/\.([^./]+)$/.exec(p)?.[1] ?? "").toLowerCase();
const baseOf = (p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const sizeOf = (d) => (typeof d === "string" ? d.length : d.byteLength);

export function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(b64) {
  const s = atob(String(b64).replace(/\s+/g, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Normalise an archive path; null if unsafe ("..", drive letters) or empty. */
export function cleanPath(p) {
  const parts = String(p ?? "").replace(/\\/g, "/").split("/").filter((x) => x !== "" && x !== ".");
  if (!parts.length || parts.some((x) => x === ".." || /[\u0000-\u001f]/.test(x)) || /^[A-Za-z]:$/.test(parts[0])) return null;
  return parts.join("/");
}
const hiddenPath = (p) => p.split("/").some((x) => x.startsWith(".") || x === "__MACOSX");

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/** A file-name-safe version of a title (Windows, macOS, Linux, Obsidian links). */
export function safeName(title, max = 80) {
  const trimEnds = (x) => x.replace(/^[.\s]+|[.\s]+$/g, "");
  let s = trimEnds(String(title ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"/\\|?*#^[\]]/g, " ").replace(/\s+/g, " "));
  s = trimEnds([...s].slice(0, max).join(""));
  if (!s) s = "Untitled";
  if (RESERVED.test(s.split(".")[0])) s = `_${s}`;
  return s;
}
/** Percent-encode the characters that break a Markdown link target; keep the rest readable. */
const linkPath = (p) => p.replace(/[%\s()<>[\]#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
export function relPath(fromDir, to) {
  const a = fromDir ? fromDir.split("/") : [];
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}

// ---------- validation ----------
export function validPage(p) {
  return isObj(p) && ID_RE.test(p.id) && PAGE_TYPES.has(p.type) &&
    (p.parentId == null || typeof p.parentId === "string") &&
    (p.title == null || typeof p.title === "string") &&
    (p.blocks == null || Array.isArray(p.blocks)) &&
    (p.type !== "database" || Array.isArray(p.columns)) &&
    (p.views == null || Array.isArray(p.views));
}
export function validRow(r) {
  return isObj(r) && ID_RE.test(r.id) && typeof r.dbId === "string" && isObj(r.values) && (r.blocks == null || Array.isArray(r.blocks));
}
/** Both spellings of the app name count on import: "denotation" (current) and "denotion" (older exports). */
export const isAppName = (v) => v === "denotation" || v === "denotion";
/** Shape-check a legacy single-file export ({ app: "denotation" | "denotion", pages, rows }). Throws if it isn't one. */
export function checkLegacy(data) {
  if (!data || !isAppName(data.app) || !Array.isArray(data.pages) || !Array.isArray(data.rows)) throw new Error("Not a Denotation export file");
  const pages = data.pages.filter(validPage);
  const rows = data.rows.filter(validRow);
  return { app: "denotation", pages, rows, skipped: data.pages.length + data.rows.length - pages.length - rows.length };
}

// ---------- JSON format ----------
export function toJsonFiles({ pages, rows }, now = new Date()) {
  const manifest = { app: "denotation", format: "json", version: 1, exportedAt: now.toISOString() };
  return [
    { path: MANIFEST, data: JSON.stringify(manifest, null, 2) },
    ...pages.filter((p) => ID_RE.test(p.id)).map((p) => ({ path: `pages/${p.id}.json`, data: JSON.stringify(p, null, 2) })),
    ...rows.filter((r) => ID_RE.test(r.id)).map((r) => ({ path: `rows/${r.id}.json`, data: JSON.stringify(r, null, 2) }))
  ];
}
/** Read pages/<id>.json and rows/<id>.json (paths relative to the manifest). Invalid records are skipped. */
export function fromJsonFiles(files) {
  const pages = [];
  const rows = [];
  let skipped = 0;
  for (const f of files) {
    const m = /^(pages|rows)\/([^/]+)\.json$/.exec(f.path);
    if (!m) continue;
    let rec;
    try {
      rec = JSON.parse(asText(f.data));
    } catch {
      skipped++;
      continue;
    }
    const ok = m[1] === "pages" ? validPage(rec) : validRow(rec);
    if (!ok || rec.id !== m[2]) {
      skipped++;
      continue;
    }
    (m[1] === "pages" ? pages : rows).push(rec);
  }
  return { pages, rows, skipped };
}
const readManifest = (f) => {
  try {
    const m = JSON.parse(asText(f.data));
    return isObj(m) && isAppName(m.app) && m.format === "json" ? m : null;
  } catch {
    return null;
  }
};

// ---------- Markdown export ----------
export function toMarkdownFiles({ pages, rows }) {
  const files = [];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const live = pages.filter((p) => p.type !== "sync" && !isTrashed(pages, p));
  const liveIds = new Set(live.map((p) => p.id));
  const kids = new Map();
  for (const p of live) {
    const key = p.type !== "repo" && p.parentId && liveIds.has(p.parentId) ? p.parentId : null;
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(p);
  }
  const rowsByDb = new Map();
  for (const r of rows) {
    if (!rowsByDb.has(r.dbId)) rowsByDb.set(r.dbId, []);
    rowsByDb.get(r.dbId).push(r);
  }
  for (const list of rowsByDb.values()) list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

  const taken = new Map(); // dir -> Set of lower-case base names
  const unique = (dir, name) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir ? [] : ["attachments"]));
    const used = taken.get(dir);
    let out = name;
    for (let n = 2; used.has(out.toLowerCase()); n++) out = `${name} ${n}`;
    used.add(out.toLowerCase());
    return out;
  };
  const md = (blocks, ctx) => blocksToMarkdown(blocks || [], ctx).trim();
  const rowTitle = (db, r) => toText(db.columns?.[0] ?? { type: "text" }, r.values?.[db.columns?.[0]?.id]).trim();
  const bodyCtx = {
    syncBlocks: (id) => (byId.get(id)?.blocks ?? []).filter((b) => b.type !== "synced"),
    inline: (n) => {
      if (n.kind === "date") return n.args[0];
      if (n.kind === "preset") {
        const hit = findChipPreset(pages.filter((x) => liveIds.has(x.id)), n.args[0]);
        if (!hit) return null;
        const res = resolvePreset(hit.db, hit.preset, rowsByDb.get(hit.db.id) ?? [], n);
        return res.state === "ok" ? res.text : presetKey(n, hit.preset) || hit.preset.name;
      }
      const p = byId.get(n.args[0]);
      const data = p?.sourceId ? byId.get(p.sourceId) : p;
      if (!data || !liveIds.has(data.id)) return null;
      const res = resolveValue(data, rowsByDb.get(data.id) ?? [], n.args[1], n.args[2]);
      return res.state === "ok" ? res.text : null;
    },
    recordPreview: (b) => {
      const p = byId.get(b.dbId);
      const data = p?.sourceId ? byId.get(p.sourceId) : p;
      return data && liveIds.has(data.id) ? previewMarkdown(b, data, rowsByDb.get(data.id) ?? []) : null;
    }
  };

  const target = new Map(); // page or row id -> file path
  const jobs = []; // { path, title, blocks }
  const place = (p, dir) => {
    const base = unique(dir, safeName(p.title || "Untitled"));
    const folder = join(dir, base);
    if (p.type === "database") {
      const src = p.sourceId ? byId.get(p.sourceId) : p;
      const path = join(dir, `${base}.csv`);
      target.set(p.id, path);
      files.push({ path, data: `﻿${databaseToCsv(src?.columns ?? [], rowsByDb.get(src?.id) ?? [])}` });
    } else if (p.type === "doc" || (p.blocks?.length && md(p.blocks, bodyCtx))) {
      const path = join(dir, `${base}.md`);
      target.set(p.id, path);
      jobs.push({ path, title: p.title || "Untitled", blocks: p.blocks });
    }
    for (const c of kids.get(p.id) ?? []) place(c, folder);
    if (p.type === "database" && !p.sourceId) {
      for (const r of rowsByDb.get(p.id) ?? []) {
        if (!md(r.blocks, bodyCtx)) continue;
        const title = rowTitle(p, r) || "Untitled";
        const path = join(folder, `${unique(folder, safeName(title))}.md`);
        target.set(r.id, path);
        jobs.push({ path, title, blocks: r.blocks });
      }
    }
  };
  for (const p of kids.get(null) ?? []) place(p, "");
  // rows without a body still resolve to their database's CSV
  for (const r of rows) if (!target.has(r.id) && target.has(r.dbId)) target.set(r.id, target.get(r.dbId));

  const attached = new Map();
  const attachment = (src) => {
    if (attached.has(src)) return attached.get(src);
    const m = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
    let path = null;
    if (m) {
      const ext = { jpeg: "jpg", "svg+xml": "svg" }[m[1].toLowerCase()] ?? m[1].toLowerCase();
      path = `attachments/image-${attached.size + 1}.${ext}`;
      try {
        files.push({ path, data: base64ToBytes(m[2]) });
      } catch {
        path = null;
      }
    }
    attached.set(src, path);
    return path;
  };
  for (const job of jobs) {
    const here = dirOf(job.path);
    const link = (id) => (target.has(id) ? linkPath(relPath(here, target.get(id))) : null);
    const ctx = {
      ...bodyCtx,
      pageTitle: (id) => byId.get(id)?.title || "Untitled",
      pageLink: (id) => {
        const title = (byId.get(id)?.title || "Untitled").replace(/[[\]]/g, "");
        const to = liveIds.has(id) ? link(id) : null;
        return to ? `[${title}](${to})` : title;
      },
      imageSrc: (b) => {
        if (!b.src?.startsWith("data:")) return linkPath(b.src || "");
        const p = attachment(b.src);
        return p ? linkPath(relPath(here, p)) : "";
      }
    };
    const body = md(job.blocks, ctx).replace(/\[([^\]]*)\]\(#(?:page|row)-([A-Za-z0-9-]+)\)/g, (m0, text, id) => {
      const to = link(id);
      return to ? `[${text}](${to})` : text;
    });
    files.push({ path: job.path, data: `---\ntitle: ${JSON.stringify(job.title)}\n---\n\n${body}\n` });
  }
  return files;
}

// ---------- import ----------
/** Clean paths, drop hidden and unsafe entries. */
export function normaliseFiles(files) {
  const out = [];
  let rejected = 0;
  for (const f of files) {
    const path = cleanPath(f.path);
    if (!path) {
      rejected++;
      continue;
    }
    if (hiddenPath(path) || f.data == null) continue;
    out.push({ path, data: f.data });
  }
  return { files: out, rejected };
}
/** "json" (with prefix to the manifest's folder), "legacy" (old single-file export) or "markdown". */
export function detectFormat(files) {
  const manifests = files.filter((f) => f.path === MANIFEST || f.path.endsWith(`/${MANIFEST}`))
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  for (const f of manifests) if (readManifest(f)) return { format: "json", prefix: dirOf(f.path) };
  const content = files.filter((f) => ["md", "markdown", "csv", "tsv"].includes(extOf(f.path)));
  if (!content.length) {
    for (const f of files.filter((x) => extOf(x.path) === "json")) {
      try {
        if (isAppName(JSON.parse(asText(f.data))?.app)) return { format: "legacy", file: f };
      } catch {
        // not JSON: ignored
      }
    }
  }
  return { format: "markdown" };
}

/**
 * Import a file map into the workspace. Never deletes anything.
 * JSON restores records by id (same path as importAll). Markdown creates new pages under a new
 * repository called `name` (or under `parentId` when given).
 */
export async function importFiles(ws, rawFiles, { name = "Imported", parentId = null } = {}) {
  const { files, rejected } = normaliseFiles(rawFiles);
  const fmt = detectFormat(files);
  if (fmt.format === "json") {
    const pre = fmt.prefix ? `${fmt.prefix}/` : "";
    const inside = files.filter((f) => f.path.startsWith(pre)).map((f) => ({ path: f.path.slice(pre.length), data: f.data }));
    const { pages, rows, skipped } = fromJsonFiles(inside);
    const r = await ws.importAll({ app: "denotation", pages, rows });
    return { format: "json", ...r, skipped: skipped + rejected };
  }
  if (fmt.format === "legacy") {
    const data = checkLegacy(JSON.parse(asText(fmt.file.data)));
    const r = await ws.importAll(data);
    return { format: "json", ...r, skipped: data.skipped + rejected };
  }
  const r = await importMarkdown(ws, files, { name, parentId });
  r.skipped += rejected;
  return r;
}

const splitFrontMatter = (text) => {
  const m = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  const t = /^title:[ \t]*(.*)$/m.exec(m[1]);
  if (t) {
    let v = t[1].trim();
    if (/^".*"$/.test(v)) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    } else if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    if (typeof v === "string" && v.trim()) meta.title = v.trim();
  }
  return { meta, body: text.slice(m[0].length) };
};
/** Title from front-matter `title`, else a leading "# H1" (removed from the body), else the file name. */
export function readMarkdownFile(path, data) {
  const { meta, body } = splitFrontMatter(asText(data).replace(/\r\n?/g, "\n"));
  if (meta.title) return { title: meta.title, body };
  const h1 = /^\s*# +(.+?)\s*#*\s*(?:\n|$)/.exec(body);
  if (h1) return { title: h1[1], body: body.slice(h1[0].length) };
  return { title: baseOf(path), body };
}

async function importMarkdown(ws, input, { name, parentId }) {
  const stats = { format: "markdown", pages: 0, databases: 0, rows: 0, images: 0, skipped: 0, ignored: 0 };
  const files = input;
  const byPath = new Map();
  for (const f of files) {
    const ext = extOf(f.path);
    if (["md", "markdown", "csv", "tsv"].includes(ext) || IMAGE_EXT[ext]) byPath.set(f.path, f);
    else stats.ignored++;
  }
  const byBase = new Map(); // lower-case base name -> path, for [[wiki links]] and ![[embeds]]
  for (const p of byPath.keys()) {
    const key = (IMAGE_EXT[extOf(p)] ? p.slice(p.lastIndexOf("/") + 1) : baseOf(p)).toLowerCase();
    if (!byBase.has(key)) byBase.set(key, p);
  }
  const dirs = new Map(); // dir -> { md: [], csv: [], sub: Set }
  const dirEntry = (d) => {
    if (!dirs.has(d)) dirs.set(d, { md: [], csv: [], sub: new Set() });
    return dirs.get(d);
  };
  dirEntry("");
  for (const p of byPath.keys()) {
    const ext = extOf(p);
    let d = dirOf(p);
    if (ext === "md" || ext === "markdown") dirEntry(d).md.push(p);
    else if (ext === "csv" || ext === "tsv") dirEntry(d).csv.push(p);
    else dirEntry(d);
    while (d) {
      dirEntry(dirOf(d)).sub.add(d);
      d = dirOf(d);
    }
  }
  const order = (a, b) => a.localeCompare(b, undefined, { numeric: true });

  if (![...byPath.keys()].some((p) => /^(md|markdown|csv|tsv)$/.test(extOf(p)))) {
    throw new Error("Nothing to import: no Markdown, CSV or Denotation files found.");
  }
  const rootId = parentId ?? (await ws.createPage({ type: "repo", title: name })).id;
  stats.rootId = rootId;
  const targetOf = new Map(); // file path -> "#page-<id>" or "#row-<id>"
  const pending = []; // { kind, rec, path, body }
  const used = new Set();

  const makeDoc = async (path, parent) => {
    const f = byPath.get(path);
    used.add(path);
    if (sizeOf(f.data) > TEXT_MAX) {
      stats.skipped++;
      return null;
    }
    const { title, body } = readMarkdownFile(path, f.data);
    const page = await ws.createPage({ type: "doc", title: title.slice(0, 200), parentId: parent });
    stats.pages++;
    targetOf.set(path, `#page-${page.id}`);
    pending.push({ kind: "page", rec: page, path, body });
    return page;
  };
  const makeDb = async (path, parent) => {
    used.add(path);
    try {
      const f = byPath.get(path);
      if (sizeOf(f.data) > TEXT_MAX * 5) throw new Error("too large");
      const { db, rows } = await ws.importCsv({ text: asText(f.data), title: baseOf(path).slice(0, 200), parentId: parent });
      stats.databases++;
      stats.rows += rows;
      targetOf.set(path, `#page-${db.id}`);
      return db;
    } catch {
      stats.skipped++;
      return null;
    }
  };
  // Row bodies: <Database>/<Row>.md next to <Database>.csv. Unmatched files become pages beside the database.
  const attachRows = async (db, dir, parent) => {
    const rows = await ws.listRows(db.id);
    const col = db.columns[0];
    const free = new Map();
    for (const r of rows) {
      const key = safeName(toText(col, r.values?.[col.id])).toLowerCase();
      if (!free.has(key)) free.set(key, []);
      free.get(key).push(r);
    }
    for (const p of [...dirs.get(dir).md].sort(order)) {
      const f = byPath.get(p);
      const { title, body } = readMarkdownFile(p, f.data);
      const hit = free.get(safeName(title).toLowerCase())?.shift() ?? free.get(safeName(baseOf(p)).toLowerCase())?.shift();
      if (!hit || sizeOf(f.data) > TEXT_MAX) continue;
      used.add(p);
      targetOf.set(p, `#row-${hit.id}`);
      pending.push({ kind: "row", rec: hit, path: p, body });
    }
    await walkDir(dir, parent);
  };
  const walkDir = async (dir, parent) => {
    const e = dirs.get(dir);
    const subs = [...e.sub].sort(order);
    const subByBase = new Map(subs.map((s) => [baseOfDir(s).toLowerCase(), s]));
    const done = new Set();
    for (const p of [...e.csv].sort(order)) {
      if (used.has(p)) continue;
      const db = await makeDb(p, parent);
      const sub = subByBase.get(baseOf(p).toLowerCase());
      if (sub && !done.has(sub)) {
        done.add(sub);
        if (db) await attachRows(db, sub, parent);
        else await walkDir(sub, parent);
      }
    }
    for (const p of [...e.md].sort(order)) {
      if (used.has(p)) continue;
      const page = await makeDoc(p, parent);
      const sub = subByBase.get(baseOf(p).toLowerCase());
      if (sub && !done.has(sub)) {
        done.add(sub);
        await walkDir(sub, page?.id ?? parent);
      }
    }
    for (const sub of subs) {
      if (done.has(sub)) continue;
      done.add(sub);
      if (!hasContent(sub)) continue;
      // folder note inside the folder (X/X.md) becomes the folder's page
      const inner = dirs.get(sub).md.find((p) => baseOf(p).toLowerCase() === baseOfDir(sub).toLowerCase() && !used.has(p));
      let page = inner ? await makeDoc(inner, parent) : null;
      if (!page) {
        page = await ws.createPage({ type: "doc", title: baseOfDir(sub).slice(0, 200), parentId: parent });
        stats.pages++;
      }
      await walkDir(sub, page.id);
    }
  };
  const baseOfDir = (d) => d.slice(d.lastIndexOf("/") + 1);
  const hasContent = (d) => {
    const e = dirs.get(d);
    return e.md.length > 0 || e.csv.length > 0 || [...e.sub].some(hasContent);
  };
  // all pages inside one folder (a zipped vault, or one repository): that folder is the new repository
  const content = files.filter((f) => /^(md|markdown|csv|tsv)$/.test(extOf(f.path))).map((f) => f.path);
  const tops = new Set(content.map((p) => (p.includes("/") ? p.split("/")[0] : "")));
  const start = tops.size === 1 && !tops.has("") ? [...tops][0] : "";
  await walkDir(start, rootId);

  // second pass: links and images need every page's id
  const imageData = (path) => {
    const f = byPath.get(path);
    const mime = f && IMAGE_EXT[extOf(path)];
    if (!mime || typeof f.data === "string" || f.data.byteLength > IMAGE_MAX) return null;
    stats.images++;
    return `data:${mime};base64,${bytesToBase64(f.data)}`;
  };
  const resolve = (from, href) => {
    let h = String(href).trim().replace(/^<|>$/g, "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("#")) return null;
    h = h.replace(/#.*$/, "");
    try {
      h = decodeURIComponent(h);
    } catch {
      // keep as is
    }
    const out = [];
    for (const part of (h.startsWith("/") ? h : join(dirOf(from), h)).split("/")) {
      if (part === "..") {
        if (!out.length) return null;
        out.pop();
      } else if (part && part !== ".") out.push(part);
    }
    return out.length ? out.join("/") : null;
  };
  for (const job of pending) {
    let body = job.body
      .replace(/^[ \t]*!\[([^\]]*)\]\(([^)]+)\)[ \t]*$/gm, (m, alt, href) => {
        const p = resolve(job.path, href);
        const src = p && imageData(p);
        return src ? `![${alt}](${src})` : m;
      })
      .replace(/^[ \t]*!\[\[([^\]|]+)(?:\|[^\]]*)?\]\][ \t]*$/gm, (m, file) => {
        const p = byBase.get(file.trim().slice(file.lastIndexOf("/") + 1).toLowerCase());
        const src = p && imageData(p);
        return src ? `![](${src})` : m;
      })
      .replace(/(^|[^!])\[([^\]]*)\]\(([^)\s]+(?: [^)]*)?)\)/g, (m, pre, text, href) => {
        const p = resolve(job.path, href.replace(/\s+"[^"]*"$/, ""));
        const to = p && targetOf.get(p);
        return to ? `${pre}[${text}](${to})` : m;
      })
      .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (m, file, alias) => {
        const p = byBase.get(file.trim().replace(/\.md$/i, "").split("/").pop().toLowerCase());
        const to = p && targetOf.get(p);
        const text = (alias ?? file).trim();
        return to ? `[${text}](${to})` : text;
      });
    const blocks = markdownToBlocks(body).map((b) => {
      const m = b.type === "p" && /^\[[^\]]*\]\(#page-([A-Za-z0-9-]+)\)$/.exec(b.text);
      return m ? newBlock("page", { ref: m[1] }) : b;
    });
    job.rec.blocks = blocks.length ? blocks : [newBlock("p")];
    if (job.kind === "page") await ws.savePage(job.rec);
    else await ws.saveRow(job.rec);
  }
  return stats;
}
