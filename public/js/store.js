const ADAPTERS = {
  local: async (config) => (await import("./adapters/local.js")).createLocalAdapter(globalThis.localStorage, "denotion", { keyring: config.keyring ?? null }),
  memory: async () => (await import("./adapters/memory.js")).createMemoryAdapter(),
  "artifact-db": async (config) => (await import("./adapters/artifact-db.js")).createArtifactDbAdapter(config.artifactDb),
  firebase: async (config) => (await import("./adapters/firebase.js")).createFirebaseAdapter(config.firebase)
};
/**
 * Save many records of one collection (each by its `id`): the adapter's setMany when it has one, else set() one by
 * one in order. The result is the same as awaiting set(collection, r.id, r) for each record.
 */
export async function setManyIn(store, collection, records) {
  const list = [...records];
  if (typeof store?.setMany === "function") return store.setMany(collection, list);
  for (const r of list) await store.set(collection, r.id, r);
}
const inClaudeArtifact = () => typeof globalThis.claude?.use === "function";
export async function createStore(config = {}) {
  const name = config.adapter ?? "auto";
  if (name !== "auto") {
    const load = ADAPTERS[name];
    if (!load) {
      throw new Error(
        `Unknown storage adapter "${name}". Use 'auto', 'local', 'memory', 'artifact-db' or 'firebase' in js/config.js.`
      );
    }
    return load(config);
  }
  const notes = [];
  if (inClaudeArtifact()) {
    try {
      return await ADAPTERS["artifact-db"](config);
    } catch (e) {
      notes.push(`Claude storage is unavailable (${e.message}).`);
    }
  }
  try {
    const store = await ADAPTERS.local(config);
    if (notes.length) store.note = `${notes.join(" ")} Using this browser only.`;
    return store;
  } catch (e) {
    const store = await ADAPTERS.memory(config);
    notes.push(`Browser storage is blocked (${e.message}).`);
    store.note = `${notes.join(" ")} Changes last only until you close this page.`;
    return store;
  }
}
