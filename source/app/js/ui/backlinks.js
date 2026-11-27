// "Linked from": the pages (and database rows) whose text links to this page, read from the workspace link index
// (ws.links), so it costs nothing per keystroke. Rows are indexed lazily: the list fills them in once they are read.
import { h } from "./dom.js";
import { ico, pageIcon } from "../icons/index.js";
import { isHidden } from "../workspace.js";

const OPEN_KEY = "denotation-backlinks-open";
const isOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
};

/** A collapsible list at the bottom of a page. env: the app env (ws, pages(), open(), openRow()). */
export function backlinksBox(env, pageId) {
  const { ws } = env;
  const box = h("details", { class: "backlinks", open: isOpen() });
  box.addEventListener("toggle", () => {
    try {
      localStorage.setItem(OPEN_KEY, box.open ? "1" : "0");
    } catch {
      /* per-browser convenience only */
    }
  });
  if (!ws?.links) return null;
  let rowInfo = new Map(); // row id -> { title, dbTitle }
  const draw = () => {
    const all = env.pages();
    const byId = new Map(all.map((p) => [p.id, p]));
    const items = [];
    for (const { from, hidden } of ws.links.backlinks(pageId)) {
      if (from === pageId) continue;
      const p = byId.get(from);
      if (p) {
        if (p.type === "sync" || isHidden(all, p)) continue;
        items.push({ id: from, title: p.title || "Untitled", icon: pageIcon(p), hidden, open: () => env.open(from) });
      } else if (rowInfo.has(from)) {
        const r = rowInfo.get(from);
        items.push({ id: from, title: r.title, hint: r.dbTitle, icon: ico("table-properties"), hidden, open: () => env.openRow(from) });
      }
    }
    items.sort((a, b) => a.title.localeCompare(b.title));
    box.replaceChildren(
      h("summary", {}, ico("link"), h("span", {}, ` Linked from (${items.length})`)),
      items.length ? h("ul", { class: "backlinks-list" }, items.map((it) => h(
        "li",
        {},
        h("a", { href: it.hint ? `#row-${it.id}` : `#page-${it.id}`, class: "backlink", onClick: (e) => {
          e.preventDefault();
          it.open();
        } }, it.icon, h("span", { class: "backlink-title" }, it.title), it.hint ? h("span", { class: "backlink-hint" }, ` in ${it.hint}`) : null),
        it.hidden ? h("span", { class: "backlink-tag", title: "Linked only with x[[…]]: not drawn in the graph" }, ico("eye-off"), " hidden link") : null
      ))) : h("p", { class: "hint" }, "No page links here yet. Type [[ in any page to link to this one.")
    );
  };
  draw();
  // rows: indexed once per workspace (then kept current on save); only the linking rows are read for their titles
  Promise.resolve(ws.ensureLinkRows?.()).then(async () => {
    const ids = ws.links.backlinks(pageId).map((l) => l.from).filter((id) => ws.links.isRow(id)).slice(0, 200);
    if (!ids.length) return box.isConnected && draw();
    const all = env.pages();
    const dbs = new Map(all.filter((p) => p.type === "database" && !isHidden(all, p)).map((p) => [p.id, p]));
    const next = new Map();
    for (const id of ids) {
      const r = await ws.getRow(id);
      const db = r && dbs.get(r.dbId);
      if (!db) continue;
      const v = r.values?.[db.columns?.[0]?.id];
      next.set(id, { title: (typeof v === "string" || typeof v === "number" ? String(v) : "").trim() || "Untitled", dbTitle: db.title || "Untitled" });
    }
    rowInfo = next;
    draw();
  }).catch(() => {});
  return box;
}
