// AI access permissions storage: a copy in this browser (localStorage) and, when a folder is
// connected, permissions.json in that folder (what the local MCP server reads). The newer copy wins
// by updatedAt and is written to the other side.
import { sanitize, newer, PERMISSIONS_KEY } from "../permissions.js";

export function loadLocalPermissions() {
  try {
    const raw = globalThis.localStorage?.getItem(PERMISSIONS_KEY);
    return sanitize(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitize(null);
  }
}
export function saveLocalPermissions(perms) {
  try {
    globalThis.localStorage?.setItem(PERMISSIONS_KEY, JSON.stringify(sanitize(perms)));
    return true;
  } catch {
    return false;
  }
}
const folderReady = (store) => !!store && typeof store.readPermissionsFile === "function" && store.connected && store.status?.().state === "synced";

/** Reconcile the browser copy and the folder copy; returns the winning permissions. Never throws. */
export async function syncPermissions(store) {
  const local = loadLocalPermissions();
  if (!folderReady(store)) return local;
  try {
    const raw = await store.readPermissionsFile();
    const remote = raw ? sanitize(raw) : null;
    const best = remote ? newer(local, remote) : local;
    if (best.updatedAt > local.updatedAt) saveLocalPermissions(best);
    // Only create the folder file once something has been set (updatedAt > 0).
    if (best.updatedAt > 0 && (!remote || remote.updatedAt !== best.updatedAt)) await store.writePermissionsFile(best);
    return best;
  } catch {
    return local;
  }
}

/** Save new permissions everywhere. Returns { folder: "saved"|"none"|"failed" }. */
export async function savePermissions(store, perms) {
  const next = { ...sanitize(perms), updatedAt: Date.now() };
  saveLocalPermissions(next);
  if (!folderReady(store)) return { perms: next, folder: "none" };
  try {
    await store.writePermissionsFile(next);
    return { perms: next, folder: "saved" };
  } catch {
    return { perms: next, folder: "failed" };
  }
}
