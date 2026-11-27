export function createLocalAdapter(storage = globalThis.localStorage, prefix = "denotion") {
  if (!storage) throw new Error("localStorage is not available in this environment");
  try {
    storage.setItem(`${prefix}:__probe`, "1");
    storage.removeItem(`${prefix}:__probe`);
  } catch {
    throw new Error("browser storage is blocked here");
  }
  const keyOf = (col, id) => `${prefix}:${col}:${id}`;
  const keysOf = (col) => {
    const p = `${prefix}:${col}:`;
    const out = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(p)) out.push(k);
    }
    return out;
  };
  const matches = (item, filter) => Object.entries(filter || {}).every(([k, v]) => item[k] === v);
  return {
    name: "local",
    label: "this browser",
    auth: null,
    async list(col, filter) {
      return keysOf(col).map((k) => JSON.parse(storage.getItem(k))).filter((item) => matches(item, filter));
    },
    async get(col, id) {
      const raw = storage.getItem(keyOf(col, id));
      return raw == null ? null : JSON.parse(raw);
    },
    async set(col, id, data) {
      storage.setItem(keyOf(col, id), JSON.stringify(data));
    },
    async remove(col, id) {
      storage.removeItem(keyOf(col, id));
    }
  };
}

