const ADAPTERS = {
  local: async (config) => (await import("./adapters/local.js")).createLocalAdapter(globalThis.localStorage, "denotion", { keyring: config.keyring ?? null }),
  memory: async () => (await import("./adapters/memory.js")).createMemoryAdapter(),
  "artifact-db": async (config) => (await import("./adapters/artifact-db.js")).createArtifactDbAdapter(config.artifactDb),
  firebase: async (config) => (await import("./adapters/firebase.js")).createFirebaseAdapter(config.firebase)
};
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
