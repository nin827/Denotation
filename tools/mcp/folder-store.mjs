// File access for the Denotation MCP server: reads and writes the Denotation JSON folder layout
// (denotation.json, pages/<id>.json, rows/<id>.json) with strict path rules:
//   - writes only pages/<id>.json, rows/<id>.json, tombstones/<id>.json (delete markers) and the stamp in
//     denotation.json ({ ..., updatedAt, rev, writer }, bumped after every write / delete so the app's cheap
//     check notices the change and pulls)
//   - never writes permissions.json (or anything else)
//   - never follows symlinks; pages/ and rows/ must be real directories inside the folder
//   - writes go to a temp file in the same directory, then rename
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { validPage, validRow } from "../../public/js/vault.js";
import { sanitize, PERMISSIONS_FILE } from "../../public/js/permissions.js";
import { bumpManifest } from "../../public/js/sync.js";

export const ID_RE = /^[A-Za-z0-9-]{1,100}$/;
const FILE_RE = /^([A-Za-z0-9-]{1,100})\.json$/;
const COLS = ["pages", "rows"];
const DIRS = [...COLS, "tombstones"]; // tombstones/ is written, never read as records
const READ_MAX = 5 * 1024 * 1024; // skip absurdly large files
export const RECORD_MAX = 250 * 1024; // same limit the app keeps per record
export const TOMBS_DIR = "tombstones";
export const MANIFEST_FILE = "denotation.json";

export class FolderStore {
  constructor(folder, { readOnly = false, permissionsPath = null } = {}) {
    this.folder = path.resolve(String(folder));
    this.readOnly = !!readOnly;
    this.permissionsPath = permissionsPath ? path.resolve(String(permissionsPath)) : null;
    this.root = null;
    this.writer = `mcp-${crypto.randomBytes(5).toString("hex")}`; // this server process's writer id for the stamp
  }

  async init() {
    const st = await fs.lstat(this.folder).catch(() => null);
    if (!st) throw new Error(`Folder not found: ${this.folder}`);
    this.root = await fs.realpath(this.folder);
    if (!(await fs.stat(this.root)).isDirectory()) throw new Error(`Not a folder: ${this.folder}`);
    const has = async (n) => !!(await fs.lstat(path.join(this.root, n)).catch(() => null));
    if (!(await has("denotation.json")) && !(await has("pages"))) {
      throw new Error(`No Denotation workspace in ${this.folder} (expected denotation.json or pages/). Connect this folder in the app first.`);
    }
    return this;
  }

  /** Resolve <col>/<name> inside the folder, refusing anything that could escape it. */
  async safePath(col, name, { forWrite = false } = {}) {
    if (!DIRS.includes(col)) throw new Error("Denotation: refused path outside pages/, rows/ and tombstones/.");
    if (!FILE_RE.test(name)) throw new Error("Denotation: refused unsafe file name.");
    const dir = path.join(this.root, col);
    let st = await fs.lstat(dir).catch(() => null);
    if (!st && forWrite) {
      await fs.mkdir(dir).catch((e) => {
        if (e.code !== "EEXIST") throw e;
      });
      st = await fs.lstat(dir);
    }
    if (!st) return null;
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Denotation: ${col}/ is not a plain folder; refusing to use it.`);
    if ((await fs.realpath(dir)) !== path.join(this.root, col)) throw new Error("Denotation: refused path outside the folder.");
    const file = path.join(dir, name);
    if (path.dirname(file) !== dir) throw new Error("Denotation: refused unsafe path.");
    const fst = await fs.lstat(file).catch(() => null);
    if (fst && (fst.isSymbolicLink() || !fst.isFile())) throw new Error("Denotation: refused to use a link or non-file.");
    return file;
  }

  async readJson(file) {
    const st = await fs.lstat(file).catch(() => null);
    if (!st || !st.isFile() || st.size > READ_MAX) return null;
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return null;
    }
  }

  async readCol(col) {
    const out = [];
    const dir = path.join(this.root, col);
    const st = await fs.lstat(dir).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return out;
    const valid = col === "pages" ? validPage : validRow;
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const m = FILE_RE.exec(ent.name);
      if (!m || !ent.isFile()) continue; // skips symlinks and folders
      const rec = await this.readJson(path.join(dir, ent.name));
      if (rec && valid(rec) && rec.id === m[1]) out.push(rec);
    }
    return out;
  }

  /** A fresh snapshot of the workspace (re-read on every call). */
  async load() {
    const [pages, rows] = await Promise.all([this.readCol("pages"), this.readCol("rows")]);
    const byCreated = (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0);
    return { pages: pages.sort(byCreated), rows: rows.sort(byCreated) };
  }

  /** permissions.json, sanitised; missing or invalid means everything no. Never written here. */
  async readPermissions() {
    const file = this.permissionsPath ?? path.join(this.root, PERMISSIONS_FILE);
    const st = await fs.lstat(file).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isFile()) return sanitize(null);
    return sanitize(await this.readJson(file));
  }

  assertWritable() {
    if (this.readOnly) throw new Error("Denotation: this server is read-only (--read-only).");
  }

  async writeAtomic(file, text) {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    try {
      await fs.writeFile(tmp, text, { encoding: "utf8", flag: "wx", mode: 0o644 });
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  async writeRecord(col, rec) {
    this.assertWritable();
    const ok = col === "pages" ? validPage(rec) : col === "rows" ? validRow(rec) : false;
    if (!ok || !ID_RE.test(rec.id)) throw new Error("Denotation: refused to write an invalid record.");
    const text = JSON.stringify(rec, null, 2);
    if (Buffer.byteLength(text) > RECORD_MAX) throw new Error(`Denotation: that ${col === "pages" ? "page" : "row"} would be larger than ${RECORD_MAX / 1024} KB.`);
    const file = await this.safePath(col, `${rec.id}.json`, { forWrite: true });
    await this.writeAtomic(file, text);
    await this.bumpStamp();
  }

  /**
   * Bump the manifest stamp (rev + 1, updatedAt, writer) after a change, keeping the format fields.
   * Same rules as record writes: a plain file directly in the folder (no symlink), temp file + rename.
   */
  async bumpStamp() {
    this.assertWritable();
    const file = path.join(this.root, MANIFEST_FILE);
    if (path.dirname(file) !== this.root) throw new Error("Denotation: refused unsafe path.");
    const st = await fs.lstat(file).catch(() => null);
    if (st && (st.isSymbolicLink() || !st.isFile())) throw new Error("Denotation: denotation.json is not a plain file; refusing to use it.");
    const prev = st ? await this.readJson(file) : null;
    await this.writeAtomic(file, JSON.stringify(bumpManifest(prev, this.writer, Date.now()), null, 2));
  }

  /**
   * Delete rows/<id>.json and write tombstones/<id>.json ({ id, collection, deletedAt }) so the app
   * (and other devices) drop their copies instead of writing them back. The app prunes old tombstones.
   */
  async deleteRow(id) {
    this.assertWritable();
    if (!ID_RE.test(id)) throw new Error("Denotation: invalid id.");
    const tomb = await this.safePath(TOMBS_DIR, `${id}.json`, { forWrite: true });
    await this.writeAtomic(tomb, JSON.stringify({ id, collection: "rows", deletedAt: Date.now() }, null, 2));
    const file = await this.safePath("rows", `${id}.json`, { forWrite: true });
    await fs.rm(file, { force: true });
    await this.bumpStamp();
  }
}
