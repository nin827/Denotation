// AI access permissions (pure: no DOM, no storage). Shared by the app and tools/mcp (Node).
//
// File shape (permissions.json in a connected folder, and localStorage["denotion:ai-permissions"]):
//   { version: 1, broad: { read, create, edit, delete }, pages: { <id>: { read?, create?, edit?, delete? } }, updatedAt }
// Each value is "yes", "no" or "ignore".
//
// Resolution for (target, action): walk from the target up its ancestors (row -> its database ->
// parentId chain -> repository). The first granular value that is not "ignore" wins. If there is
// none, the broad value applies; broad "ignore" means no. No permissions at all means no.

export const ACTIONS = ["read", "create", "edit", "delete"];
export const VALUES = ["no", "yes", "ignore"];
export const PERMISSIONS_FILE = "permissions.json";
export const PERMISSIONS_KEY = "denotion:ai-permissions";
const ID_RE = /^[A-Za-z0-9-]{1,100}$/;
const MAX_PAGES = 20000;
const MAX_DEPTH = 200;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const val = (v, fallback) => (VALUES.includes(v) ? v : fallback);

/** The permissions used when nothing has been set: everything no. */
export const defaultPermissions = () => ({ version: 1, broad: { read: "no", create: "no", edit: "no", delete: "no" }, pages: {}, updatedAt: 0 });

/** Clean any input into a valid permissions object. Unknown keys and values are dropped. */
export function sanitize(input) {
  const out = defaultPermissions();
  if (!isObj(input)) return out;
  if (isObj(input.broad)) for (const a of ACTIONS) out.broad[a] = val(input.broad[a], "no");
  if (isObj(input.pages)) {
    let n = 0;
    for (const [id, set] of Object.entries(input.pages)) {
      if (n >= MAX_PAGES) break;
      if (!ID_RE.test(id) || !isObj(set)) continue;
      const clean = {};
      for (const a of ACTIONS) if (VALUES.includes(set[a]) && set[a] !== "ignore") clean[a] = set[a];
      if (Object.keys(clean).length) {
        out.pages[id] = clean;
        n++;
      }
    }
  }
  const t = Number(input.updatedAt);
  out.updatedAt = Number.isFinite(t) && t > 0 ? Math.floor(t) : 0;
  return out;
}

/** Granular value set directly on one page/row ("ignore" when not set). */
export const ownValue = (perms, id, action) => val(perms?.pages?.[id]?.[action], "ignore");

/** Return a copy of `perms` with one granular value changed ("ignore" removes it). */
export function setPageValue(perms, id, action, value) {
  const next = sanitize(perms);
  if (!ID_RE.test(id) || !ACTIONS.includes(action) || !VALUES.includes(value)) return next;
  const set = { ...(next.pages[id] ?? {}) };
  if (value === "ignore") delete set[action];
  else set[action] = value;
  if (Object.keys(set).length) next.pages[id] = set;
  else delete next.pages[id];
  return next;
}
export function setBroadValue(perms, action, value) {
  const next = sanitize(perms);
  if (ACTIONS.includes(action) && VALUES.includes(value)) next.broad[action] = value;
  return next;
}

const toMap = (list) => (list instanceof Map ? list : new Map((list ?? []).filter((x) => x && ID_RE.test(x.id)).map((x) => [x.id, x])));

/**
 * Build a resolver for one snapshot of the workspace.
 * resolver(id | null, action) -> { allowed, value: "yes"|"no", source: "self"|"ancestor"|"broad"|"default", sourceId }
 * `id` may be a page id or a row id; null asks about the workspace as a whole (broad only).
 */
export function makeResolver(perms, pages, rows) {
  const p = sanitize(perms);
  const pageMap = toMap(pages);
  const rowMap = toMap(rows);
  const chain = (id) => {
    const out = [];
    const seen = new Set();
    let cur = id;
    const row = rowMap.get(cur);
    if (row && !pageMap.has(cur)) {
      out.push(cur);
      seen.add(cur);
      cur = row.dbId;
    }
    while (cur && !seen.has(cur) && out.length < MAX_DEPTH) {
      seen.add(cur);
      out.push(cur);
      cur = pageMap.get(cur)?.parentId ?? null;
    }
    return out;
  };
  return (id, action) => {
    if (!ACTIONS.includes(action)) return { allowed: false, value: "no", source: "default", sourceId: null };
    const ids = id ? chain(id) : [];
    for (let i = 0; i < ids.length; i++) {
      const v = ownValue(p, ids[i], action);
      if (v !== "ignore") return { allowed: v === "yes", value: v, source: i === 0 ? "self" : "ancestor", sourceId: ids[i] };
    }
    const b = p.broad[action];
    if (b !== "ignore") return { allowed: b === "yes", value: b, source: "broad", sourceId: null };
    return { allowed: false, value: "no", source: "default", sourceId: null };
  };
}

/** One-off resolution. `target` is a page id, a row id, or null for the whole workspace. */
export const resolve = (perms, pages, rows, target, action) => makeResolver(perms, pages, rows)(target, action);

/** Newer of two permission objects by updatedAt (ties keep `a`). */
export function newer(a, b) {
  const x = sanitize(a);
  const y = sanitize(b);
  return y.updatedAt > x.updatedAt ? y : x;
}
