// After a repository constant changes, databases keep stale formula caches (row.values) until opened, and the MCP server
// reads those caches. This recomputes them in the background: one database at a time, rows saved in chunks, with a yield
// to the browser between steps. Pure of the DOM: the scheduler is injectable so tests run it synchronously.
import { applyFormulas } from "./formula.js";
import { constantResolver, findRepo } from "./constants.js";

const CHUNK = 200;
/** Run `fn` when the browser is idle (or soon after, where requestIdleCallback is missing). */
export const whenIdle = (fn) => new Promise((resolve, reject) => {
  const run = () => Promise.resolve().then(fn).then(resolve, reject);
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 50);
});
const hasFormula = (db) => db.type === "database" && !db.sourceId && !db.trashedAt && db.columns?.some((c) => c.type === "formula");

/**
 * Recompute the formula columns of every database that belongs to repository `repoId`. `pages` is the page list,
 * `ws` provides listRows / saveRows. Returns the number of rows saved. A newer call can cancel an older one through
 * `isStale()` (checked between steps).
 */
export async function refreshFormulaCaches(ws, pages, repoId, { schedule = whenIdle, isStale = () => false } = {}) {
  const repo = pages.find((p) => p.id === repoId);
  if (!repo) return 0;
  const constants = constantResolver(repo);
  let saved = 0;
  for (const db of pages) {
    if (!hasFormula(db) || findRepo(pages, db.id)?.id !== repoId) continue;
    await schedule(async () => {
      if (isStale()) return;
      const rows = await ws.listRows(db.id);
      const changed = applyFormulas(db.columns, rows, { constants });
      for (let i = 0; i < changed.length; i += CHUNK) {
        if (isStale()) return;
        const part = changed.slice(i, i + CHUNK);
        await (ws.saveRows ? ws.saveRows(part) : Promise.all(part.map((r) => ws.saveRow(r))));
        saved += part.length;
        if (i + CHUNK < changed.length) await schedule(() => {});
      }
    });
    if (isStale()) break;
  }
  return saved;
}
