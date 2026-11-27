import { newBlock } from "./model.js";

const E = (id, label, group, keywords, make, extra = {}) => ({ id, label, group, keywords, make, ...extra });
const plain = (type, props) => () => newBlock(type, props);
export const CATALOG = [
  E("p", "Text", "Basic", "paragraph plain", plain("p"), { turn: true }),
  E("h1", "Heading 1", "Basic", "title h1 big", plain("h1"), { turn: true }),
  E("h2", "Heading 2", "Basic", "h2 subtitle", plain("h2"), { turn: true }),
  E("h3", "Heading 3", "Basic", "h3", plain("h3"), { turn: true }),
  E("h4", "Heading 4", "Basic", "h4 small", plain("h4"), { turn: true }),
  E("bullet", "Bulleted list", "Basic", "ul unordered dot", plain("bullet"), { turn: true }),
  E("numbered", "Numbered list", "Basic", "ol ordered", plain("numbered"), { turn: true }),
  E("todo", "To-do list", "Basic", "checkbox task", plain("todo"), { turn: true }),
  E("toggle", "Toggle list", "Basic", "foldable collapse expand", plain("toggle"), { turn: true }),
  E("toggleh1", "Toggle heading 1", "Basic", "foldable h1", plain("h1", { fold: true }), { turn: true, type: "h1", props: { fold: true } }),
  E("toggleh2", "Toggle heading 2", "Basic", "foldable h2", plain("h2", { fold: true }), { turn: true, type: "h2", props: { fold: true } }),
  E("toggleh3", "Toggle heading 3", "Basic", "foldable h3", plain("h3", { fold: true }), { turn: true, type: "h3", props: { fold: true } }),
  E("toggleh4", "Toggle heading 4", "Basic", "foldable h4", plain("h4", { fold: true }), { turn: true, type: "h4", props: { fold: true } }),
  E("quote", "Quote", "Basic", "blockquote cite", plain("quote"), { turn: true }),
  E("callout", "Callout", "Basic", "note info highlight", plain("callout"), { turn: true }),
  E("code", "Code", "Basic", "snippet monospace", plain("code"), { turn: true }),
  E("divider", "Divider", "Basic", "rule line hr separator", plain("divider")),
  E("table", "Table", "Layout", "grid rows cols", (a) => newBlock("table", { rows: a.rows ?? 3, cols: a.cols ?? 3 }), { sized: "table" }),
  ...[2, 3, 4, 5].map((n) => E(
    `columns${n}`,
    `${n} columns`,
    "Layout",
    "column layout side by side",
    (a) => newBlock("columns", { count: a.count ?? n }),
    { sized: "columns" }
  )),
  E("image", "Image", "Media", "picture photo upload", plain("image")),
  E("bookmark", "Web bookmark", "Media", "link url", plain("bookmark")),
  E("toc", "Table of contents", "Advanced", "headings outline", plain("toc")),
  E("breadcrumb", "Breadcrumb", "Advanced", "path trail", plain("breadcrumb")),
  E("pivot", "Pivot table", "Advanced", "pivot summary group aggregate crosstab database", plain("pivot")),
  E("preview", "Record preview", "Advanced", "record lookup key primary row card preview database", plain("preview")),
  E("synced", "Synced block", "Advanced", "sync mirror shared copy", plain("synced"), { needs: "sync" }),
  E("page", "Page", "Pages", "sub-page subpage new", plain("page"), { needs: "page", pageType: "doc" }),
  E("database", "Database", "Pages", "table collection sub database", plain("page"), { needs: "page", pageType: "database" })
];
const ICON_OF = { "p": "pilcrow", "h1": "heading-1", "h2": "heading-2", "h3": "heading-3", "h4": "heading-4", "bullet": "list", "numbered": "list-ordered", "todo": "list-checks", "toggle": "list-collapse", "toggleh1": "chevron-right", "toggleh2": "chevron-right", "toggleh3": "chevron-right", "toggleh4": "chevron-right", "quote": "quote", "callout": "lightbulb", "code": "code", "divider": "minus", "table": "table", "image": "image", "bookmark": "bookmark", "toc": "table-of-contents", "breadcrumb": "route", "pivot": "table-properties", "preview": "scan-search", "synced": "refresh-cw", "page": "file-text", "database": "database" };
for (const e of CATALOG) e.icon = ICON_OF[e.id] ?? (e.id.startsWith("columns") ? `columns-${Math.min(4, Math.max(2, Number(e.id.slice(7))))}` : "square");
export function parseArgs(query) {
  const a = {};
  const dim = /(\d{1,3})\s*[x×*]\s*(\d{1,3})/i.exec(query);
  if (dim) {
    a.rows = Number(dim[1]);
    a.cols = Number(dim[2]);
  }
  const n = /(?:^|\s)(\d{1,2})(?:\s|$)/.exec(query);
  if (n && !dim) {
    a.count = Number(n[1]);
    a.rows = a.cols = void 0;
  }
  return a;
}
export function filterCatalog(query, entries = CATALOG) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return entries;
  const words = q.replace(/[\d×x*]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return entries.filter((e) => e.sized);
  const scored = [];
  for (const e of entries) {
    const label = e.label.toLowerCase();
    const hay = `${label} ${e.keywords}`;
    if (!words.every((w) => hay.includes(w))) continue;
    scored.push([label.startsWith(words[0]) ? 0 : label.includes(words[0]) ? 1 : 2, e]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map((s) => s[1]);
}
export function labelFor(entry, args) {
  if (entry.sized === "table" && args.rows) return `Table ${args.rows} \xD7 ${args.cols}`;
  if (entry.sized === "columns" && args.count) return `${args.count} columns`;
  return entry.label;
}
