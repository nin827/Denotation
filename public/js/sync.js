// Sync planning, shared by every sync target (local folder now; Google Drive / OneDrive later).
// Pure: no DOM, no file or network access. The IO layer reads both sides, asks for a plan, shows any
// conflicts, then hands the plan to applyPlan() with its own read/write functions.
//
// Records are plain objects with an `id` and `updatedAt` (fallback `createdAt`), grouped by collection:
//   local / remote: { [collection]: Iterable<record> | Map<id, record> }
// Tombstones mark deletions: { collection, id, deletedAt }.
//   localTombstones:  deletions made on this device that the other side has not seen yet
//   remoteTombstones: deletions recorded on the shared side (e.g. tombstones/<id>.json in the folder)
//
// Directions:
//   "merge": two-way, per record last write wins (record vs record by stamp, tombstone vs record by
//            deletedAt >= stamp: the delete wins ties). No conflicts are reported.
//   "push":  make the remote side equal to this device. Conflicts (`newerRemote`) list remote state that
//            would be lost: a newer remote copy, a remote-only record, a remote edit made after a local
//            delete, or a remote delete made after the local edit.
//   "pull":  make this device equal to the remote side. Conflicts (`olderRemote`) list local state that
//            would be lost: a newer local copy, a local-only record, a local delete made after the remote
//            edit, or a local edit made after the remote delete.
// Tombstones older than ttlMs are pruned from the remote side (merge and push).

export const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000;
export const stamp = (r) => Number(r?.updatedAt ?? r?.createdAt ?? 0) || 0;
export const keyOf = (collection, id) => `${collection}/${id}`;

const toMap = (byCol) => {
  const out = new Map();
  for (const [collection, recs] of Object.entries(byCol ?? {})) {
    const list = recs instanceof Map ? recs.values() : recs ?? [];
    for (const r of list) if (r && r.id != null) out.set(keyOf(collection, r.id), { collection, id: r.id, record: r });
  }
  return out;
};
const tombMap = (list) => {
  const out = new Map();
  for (const t of list ?? []) {
    const at = Number(t?.deletedAt) || 0;
    if (!t || t.id == null || !t.collection || at <= 0) continue;
    const k = keyOf(t.collection, t.id);
    if (!out.has(k) || out.get(k).deletedAt < at) out.set(k, { ...t, deletedAt: at });
  }
  return out;
};

/**
 * Compute what to change on each side.
 * @returns {{ direction, toLocal, toRemote, deleteLocal, deleteRemote, writeTombstones, removeTombstones,
 *   forgetLocalTombstones, conflicts: { newerRemote, olderRemote } }}
 *   toLocal / toRemote: { collection, id, record } (record = the copy to write)
 *   deleteLocal / deleteRemote: { collection, id, record } (record = the copy being removed)
 *   (toLocal and deleteLocal entries also carry localStamp: the local stamp the plan saw, or null)
 *   writeTombstones: { collection, id, deletedAt } to store on the remote side
 *   removeTombstones: { collection, id } remote tombstones to drop (record resurrected, or pruned)
 *   forgetLocalTombstones: the local tombstones this plan consumes (drop them after applying)
 *   conflict: { collection, id, reason, localAt, remoteAt, local, remote }
 *     reason: "newer" | "only-remote" | "only-local" | "deleted-locally" | "deleted-remotely"
 */
export function planSync({ local, remote, localTombstones = [], remoteTombstones = [], direction = "merge", now = Date.now(), ttlMs = TOMBSTONE_TTL_MS } = {}) {
  if (!["merge", "push", "pull"].includes(direction)) throw new Error(`Unknown sync direction: ${direction}`);
  const L = toMap(local);
  const R = toMap(remote);
  const TL = tombMap(localTombstones);
  const TR = tombMap(remoteTombstones);
  const plan = {
    direction,
    toLocal: [], toRemote: [], deleteLocal: [], deleteRemote: [],
    writeTombstones: [], removeTombstones: [],
    forgetLocalTombstones: [...TL.values()],
    conflicts: { newerRemote: [], olderRemote: [] }
  };
  const cutoff = now - ttlMs;
  const tombOut = new Map(); // key -> deletedAt the remote side should end up with (or null to remove)
  const keys = new Set([...L.keys(), ...R.keys(), ...TL.keys(), ...TR.keys()]);

  for (const k of keys) {
    const l = L.get(k);
    const r = R.get(k);
    const tl = TL.get(k);
    const tr = TR.get(k);
    const { collection, id } = l ?? r ?? tl ?? tr;
    const ls = l ? stamp(l.record) : 0;
    const rs = r ? stamp(r.record) : 0;
    const conflict = (side, reason, localAt, remoteAt) => plan.conflicts[side].push({ collection, id, reason, localAt, remoteAt, local: l?.record ?? null, remote: r?.record ?? null });
    const put = (list, rec) => list.push(list === plan.toLocal || list === plan.deleteLocal ? { collection, id, record: rec, localStamp: l ? ls : null } : { collection, id, record: rec });
    const tombTo = (at) => tombOut.set(k, at);

    if (direction === "merge") {
      const t = Math.max(tl?.deletedAt ?? 0, tr?.deletedAt ?? 0);
      const recStamp = Math.max(l ? ls : -1, r ? rs : -1);
      if (t > 0 && t >= recStamp) {
        if (l) put(plan.deleteLocal, l.record);
        if (r) put(plan.deleteRemote, r.record);
        tombTo(t);
      } else {
        if (r && (!l || rs > ls)) put(plan.toLocal, r.record);
        if (l && (!r || ls > rs)) put(plan.toRemote, l.record);
        if (tr) tombTo(null);
      }
    } else if (direction === "push") {
      if (l) {
        if (r && rs > ls) conflict("newerRemote", "newer", ls, rs);
        else if (tr && tr.deletedAt >= ls) conflict("newerRemote", "deleted-remotely", ls, tr.deletedAt);
        if (!r || rs !== ls) put(plan.toRemote, l.record);
        if (tr) tombTo(null);
      } else if (r) {
        put(plan.deleteRemote, r.record);
        const covered = Math.max(tl?.deletedAt ?? 0, tr?.deletedAt ?? 0);
        if (covered >= rs) tombTo(covered);
        else {
          if (!tl) conflict("newerRemote", "only-remote", 0, rs);
          else conflict("newerRemote", "deleted-locally", tl.deletedAt, rs);
          tombTo(Math.max(now, rs));
        }
      } else if (tl && (!tr || tr.deletedAt < tl.deletedAt)) tombTo(tl.deletedAt);
    } else {
      // pull: the remote record counts only if no remote tombstone covers it
      const rEff = r && !(tr && tr.deletedAt >= rs) ? r : null;
      if (rEff) {
        if (l) {
          if (ls > rs) conflict("olderRemote", "newer", ls, rs);
          if (ls !== rs) put(plan.toLocal, rEff.record);
        } else {
          if (tl && tl.deletedAt >= rs) conflict("olderRemote", "deleted-locally", tl.deletedAt, rs);
          put(plan.toLocal, rEff.record);
        }
      } else if (l) {
        if (!tr) conflict("olderRemote", "only-local", ls, 0);
        else if (tr.deletedAt < ls) conflict("olderRemote", "deleted-remotely", ls, tr.deletedAt);
        put(plan.deleteLocal, l.record);
      }
    }
  }

  // Remote tombstone changes, with pruning (pull never writes to the remote side).
  if (direction !== "pull") {
    for (const [k, at] of tombOut) {
      const tr = TR.get(k);
      const [collection, ...rest] = k.split("/");
      const id = rest.join("/");
      if (at === null || at < cutoff) {
        if (tr) plan.removeTombstones.push({ collection: tr.collection, id: tr.id });
      } else if (!tr || tr.deletedAt !== at) plan.writeTombstones.push({ collection: tr?.collection ?? collection, id: tr?.id ?? id, deletedAt: at });
    }
    for (const [k, tr] of TR) if (!tombOut.has(k) && tr.deletedAt < cutoff) plan.removeTombstones.push({ collection: tr.collection, id: tr.id });
  }
  return plan;
}

export const conflictCount = (plan) => plan.conflicts.newerRemote.length + plan.conflicts.olderRemote.length;

/** Counts for a summary toast. */
export function summarize(plan) {
  return {
    pulled: plan.toLocal.length,
    pushed: plan.toRemote.length,
    deletedLocal: plan.deleteLocal.length,
    deletedRemote: plan.deleteRemote.length,
    deleted: plan.deleteLocal.length + plan.deleteRemote.length
  };
}

/** True when applying the plan would change no record on either side. */
export const isNoop = (plan) => !plan.toLocal.length && !plan.toRemote.length && !plan.deleteLocal.length && !plan.deleteRemote.length;

/**
 * Apply a plan through IO callbacks (all async; only those the plan needs are called):
 *   getLocal(collection, id)            -> current local record (skips records edited meanwhile)
 *   putLocal(collection, id, record), removeLocal(collection, id)
 *   putRemote(collection, id, record),  removeRemote(collection, id)
 *   putTombstone({ collection, id, deletedAt }), removeTombstone({ collection, id })
 *   forgetLocalTombstone({ collection, id, deletedAt })
 * Local changes are skipped when the local record changed after the plan was made; remote writes use
 * the freshest local copy, and a remote delete is skipped if the record was recreated here meanwhile.
 * Returns the counts actually applied.
 */
export async function applyPlan(plan, io) {
  const done = { pulled: 0, pushed: 0, deletedLocal: 0, deletedRemote: 0, deleted: 0, skipped: 0 };
  const get = async (c) => (io.getLocal ? io.getLocal(c.collection, c.id) : undefined);
  const untouched = async (c) => {
    if (!io.getLocal || c.localStamp === undefined) return true;
    const now = await io.getLocal(c.collection, c.id);
    return (now ? stamp(now) : null) === c.localStamp;
  };
  for (const c of plan.toLocal) {
    if (!(await untouched(c))) done.skipped++;
    else {
      await io.putLocal(c.collection, c.id, c.record);
      done.pulled++;
    }
  }
  for (const c of plan.deleteLocal) {
    if (!(await untouched(c))) done.skipped++;
    else {
      await io.removeLocal(c.collection, c.id);
      done.deletedLocal++;
    }
  }
  for (const c of plan.toRemote) {
    const rec = io.getLocal ? await get(c) : c.record;
    if (!rec) {
      done.skipped++; // deleted here meanwhile; the next sync handles it
      continue;
    }
    await io.putRemote(c.collection, c.id, rec);
    done.pushed++;
  }
  for (const c of plan.deleteRemote) {
    if (io.getLocal && (await get(c))) {
      done.skipped++; // recreated here meanwhile
      continue;
    }
    await io.removeRemote(c.collection, c.id);
    done.deletedRemote++;
  }
  for (const t of plan.writeTombstones) await io.putTombstone?.(t);
  for (const t of plan.removeTombstones) await io.removeTombstone?.(t);
  for (const t of plan.forgetLocalTombstones) await io.forgetLocalTombstone?.(t);
  done.deleted = done.deletedLocal + done.deletedRemote;
  return done;
}

// ---------- manifest stamp (cheap change detection) ----------
// Every writer of a shared location stamps its manifest (denotation.json) after it changes records:
//   { app: "denotation", format: "json", version: 1, updatedAt, rev, writer }
// rev is a counter (previous rev + 1), writer a per-device (or per-process) random id. A reader remembers
// the stamp it last synced with; any difference means another writer changed the folder since.

/** The comparable part of a parsed manifest, or null when there is none. */
export function manifestStamp(m) {
  if (!m || typeof m !== "object") return null;
  return { rev: Math.max(0, Math.floor(Number(m.rev) || 0)), writer: typeof m.writer === "string" ? m.writer.slice(0, 64) : "", updatedAt: Number(m.updatedAt) || 0 };
}
/** True when two stamps (from manifestStamp, or null) describe the same folder version. */
export function sameStamp(a, b) {
  if (!a || !b) return !a && !b;
  return a.rev === b.rev && a.writer === b.writer && a.updatedAt === b.updatedAt;
}
const MANIFEST_KNOWN = new Set(["app", "format", "version", "exportedAt", "updatedAt", "rev", "writer"]);
/**
 * The manifest a writer stores after a change: the previous one with a bumped stamp. Known fields are normalised;
 * unknown fields (e.g. `encrypted`, `keyId`, `encryption` from crypto.js, or ones a newer app adds) are kept as
 * they are, so an app that doesn't know them can't strip them.
 */
export function bumpManifest(prev, writer, now = Date.now()) {
  const p = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
  const out = { app: "denotation", format: "json", version: 1 };
  if (typeof p.exportedAt === "string") out.exportedAt = p.exportedAt.slice(0, 40);
  out.updatedAt = Math.max(Number(now) || 0, (Number(p.updatedAt) || 0) + 1);
  out.rev = (manifestStamp(p)?.rev ?? 0) + 1;
  out.writer = String(writer ?? "").slice(0, 64);
  for (const [k, v] of Object.entries(p)) {
    if (MANIFEST_KNOWN.has(k) || k === "__proto__" || v === undefined) continue;
    out[k] = v;
  }
  return out;
}
