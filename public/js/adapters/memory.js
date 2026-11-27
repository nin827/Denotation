export function createMemoryAdapter() {
  const cols = new Map();
  const col = (name) => {
    if (!cols.has(name)) cols.set(name, new Map());
    return cols.get(name);
  };
  const matches = (item, filter) => Object.entries(filter || {}).every(([k, v]) => item[k] === v);
  return {
    name: "memory",
    label: "this session only",
    auth: null,
    async list(name, filter) {
      return [...col(name).values()].map((j) => JSON.parse(j)).filter((item) => matches(item, filter));
    },
    async get(name, id) {
      const raw = col(name).get(id);
      return raw === void 0 ? null : JSON.parse(raw);
    },
    async set(name, id, data) {
      col(name).set(id, JSON.stringify(data));
    },
    /** set() for each record (by record.id), in order. */
    async setMany(name, records) {
      const c = col(name);
      for (const data of records) c.set(data.id, JSON.stringify(data));
    },
    async remove(name, id) {
      col(name).delete(id);
    }
  };
}

