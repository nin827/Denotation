function friendly(e, verb) {
  const code = e?.code;
  const detail = e?.message ? ` (${e.message})` : "";
  switch (code) {
    case "quota_exceeded":
      return new StorageError(`Storage is full${detail}. Delete some pages or rows and try again.`, code);
    case "resource_exhausted":
      return new StorageError("Too many requests at once. Wait a moment and try again.", code);
    case "invalid_argument":
      return new StorageError(
        verb === "write" ? `Could not save${detail}. If you only have view access, ask the owner for Contributor access.` : `Could not read${detail}.`,
        code
      );
    case "revoked":
      return new StorageError("Access to this workspace was withdrawn. Reload the page.", code);
    default:
      return new StorageError(`Claude storage is unavailable right now${detail}.`, code ?? "unavailable");
  }
}
async function call(verb, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.code !== "unavailable") throw friendly(e, verb);
    await sleep(250 + Math.random() * 500);
    try {
      return await fn();
    } catch (e2) {
      throw friendly(e2, verb);
    }
  }
}
function checkSegment(value, what) {
  const s = String(value);
  if (!SEGMENT.test(s) || s === "." || s === ".." || new TextEncoder().encode(s).length > 200) {
    throw new Error(`Invalid ${what} "${s}" for Claude storage`);
  }
  return s;
}
export async function createArtifactDbAdapter({ scope = "private", claude = globalThis.claude } = {}) {
  if (typeof claude?.use !== "function") throw new Error("this page is not running inside a Claude artifact");
  if (scope !== "private" && scope !== "shared") throw new Error(`unknown scope "${scope}"`);
  const db = await claude.use("db");
  if (!db) throw new Error("this view has no access to the artifact database");
  let base = null;
  if (scope === "private") {
    const user = await claude.use("user");
    const uid = await user?.id();
    if (!uid) throw new Error("private storage needs a signed-in identity");
    base = `${PRIVATE_PREFIX}/${checkSegment(uid, "user id")}`;
  }
  const priv = base !== null;
  const colRef = (col) => db.collection(priv ? base : checkSegment(col, "collection"));
  const docRef = (col, id) => {
    checkSegment(col, "collection");
    checkSegment(id, "id");
    return colRef(col).doc(priv ? `${col}:${id}` : id);
  };
  const encode = (col, data) => priv ? { ...plain(data), _col: col } : plain(data);
  const decode = (body) => {
    const { _col, ...rest } = plain(body);
    return rest;
  };
  const idOf = (col, snap) => priv ? snap.id.slice(col.length + 1) : snap.id;
  const seen = new Map();
  const keyOf = (col, id) => `${col}/${id}`;
  const tails = new Map();
  const serial = (key, fn) => {
    const next = (tails.get(key) ?? Promise.resolve()).catch(() => {
    }).then(fn);
    tails.set(key, next);
    next.catch(() => {
    }).finally(() => {
      if (tails.get(key) === next) tails.delete(key);
    });
    return next;
  };
  const api = {
    name: "artifact-db",
    label: priv ? "Claude artifact (private to you)" : "Claude artifact (shared)",
    scope,
    auth: null,
    // identity and access are handled by Claude
    async list(col, filter = {}) {
      checkSegment(col, "collection");
      return call("read", async () => {
        let q = colRef(col);
        if (priv) q = q.where("_col", "==", col);
        for (const [field, value] of Object.entries(filter)) q = q.where(field, "==", value);
        const snap = await q.get();
        return snap.docs.map((d) => {
          const item = decode(d.data());
          seen.set(keyOf(col, idOf(col, d)), JSON.stringify(item));
          return item;
        });
      });
    },
    async get(col, id) {
      const ref = docRef(col, id);
      return call("read", async () => {
        const snap = await ref.get();
        if (!snap.exists) {
          seen.delete(keyOf(col, id));
          return null;
        }
        const item = decode(snap.data());
        seen.set(keyOf(col, id), JSON.stringify(item));
        return item;
      });
    },
    async set(col, id, data) {
      const ref = docRef(col, id);
      const key = keyOf(col, id);
      const body = encode(col, data);
      const json = JSON.stringify(plain(data));
      return serial(key, async () => {
        if (seen.get(key) === json) return;
        await call("write", () => ref.set(body));
        seen.set(key, json);
      });
    },
    /** No batch call in the artifact database: set() for each record (by record.id), one after another, in order. */
    async setMany(col, records) {
      for (const data of records) await api.set(col, data.id, data);
    },
    async remove(col, id) {
      const ref = docRef(col, id);
      const key = keyOf(col, id);
      return serial(key, async () => {
        await call("write", () => ref.delete());
        seen.delete(key);
      });
    }
  };
  return api;
}
const PRIVATE_PREFIX = "data/users";
const SEGMENT = /^[A-Za-z0-9_\-.~:@+]+$/;
export const StorageError = class extends Error {
  constructor(message, code) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
};
const plain = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
