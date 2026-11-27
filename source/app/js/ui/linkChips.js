// Link and embed chips ({{link}}, {{xlink}}, {{embed}}; see js/links.js). Links show the page's current icon and title;
// embeds show a heading section or chosen blocks read-only, or a warning box when the embed would include itself.
// All text is set with textContent (h()); hrefs are only ever "#page-<valid id>".
import { h } from "./dom.js";
import { ico, pageIcon } from "../icons/index.js";
import { renderInline } from "./inlineView.js";
import { isTokenId } from "../blocks/inline.js";
import { parseEmbed, embedKey, resolveEmbed, embedCycleFrom, embedPlainText, EMBED_MAX_BLOCKS } from "../links.js";

const miss = (label, title) => h("span", { class: "ichip ichip-miss", title }, ico("info"), h("span", {}, label));
/** Every page with blocks the chip may read (live pages only: trashed or archived targets read as missing). */
const pagesOf = (ctx) => (typeof ctx?.livePages === "function" ? ctx.livePages() : []);
const titleOf = (p) => (p?.title || "Untitled");

/** State of a link target: { state: "ok" | "missing" | "trashed" | "archived", page? }. */
function target(ctx, id) {
  const info = ctx?.pageInfo?.(id);
  if (info && info.state && info.state !== "ok") return { state: info.state, title: info.title };
  const page = pagesOf(ctx).find((p) => p.id === id);
  if (page) return { state: "ok", page };
  return { state: "missing" };
}

/** {{link:id}} and {{xlink:id}}: the same chip (the x of a hidden link is never shown), opening the page. */
export function linkChip(n, ctx) {
  const id = n.args[0];
  const hidden = n.kind === "xlink";
  if (!isTokenId(id)) return miss("Not found", "Not a valid page link");
  const t = target(ctx, id);
  if (t.state === "trashed") return miss("In trash", `${t.title || "Untitled"} is in the trash`);
  if (t.state === "archived") return miss("Archived", `${t.title || "Untitled"} is archived`);
  if (t.state !== "ok") return miss("Not found", "Page not found (deleted?)");
  const title = titleOf(t.page);
  return h("a", {
    class: `ichip ichip-link${hidden ? " ichip-xlink" : ""}`,
    href: `#page-${id}`,
    "data-link": id,
    title: hidden ? `Open ${title} (hidden link: not drawn in the graph)` : `Open ${title}`
  }, pageIcon(t.page), h("span", {}, title));
}
export const linkText = (n, ctx) => {
  const p = pagesOf(ctx).find((x) => x.id === n.args[0]);
  return p ? titleOf(p) : "(deleted page)";
};

// ---------- embeds ----------
const warnBox = (text, page, extra = null) => h(
  "span",
  { class: "embed embed-warn", role: "note" },
  h("span", { class: "embed-warn-text" }, ico("octagon-exclamation-point"), h("span", {}, text)),
  extra,
  page ? openLink(page) : null
);
const openLink = (page) => h("a", { class: "embed-open", href: `#page-${page.id}`, title: `Open ${titleOf(page)}` }, ico("arrow-up-right"), h("span", {}, "Open source"));

/** What an embed token shows, as plain text (search, copy, plain export). */
export const embedText = (n, ctx) => embedPlainText(pagesOf(ctx), n) || "(embedded content unavailable)";

/**
 * {{embed:page|h|heading}} / {{embed:page|b|ids}}: the section or blocks, read-only, with a header naming the source.
 * Nested embeds render through the same chip; `ctx.embedStack` (embed keys being drawn) stops any loop, and a loop
 * found up front (embedCycleFrom) shows a warning box naming it instead of the content.
 */
export function embedChip(n, ctx) {
  const e = parseEmbed(n);
  if (!e) return warnBox("Not a valid embed", null);
  const pages = pagesOf(ctx);
  const page = pages.find((p) => p.id === e.pageId);
  if (!page) {
    const info = ctx?.pageInfo?.(e.pageId);
    return warnBox(info?.state === "trashed" ? "The embedded page is in the trash" : info?.state === "archived" ? "The embedded page is archived" : "The embedded page no longer exists", null);
  }
  const key = embedKey(e);
  const stack = Array.isArray(ctx?.embedStack) ? ctx.embedStack : [];
  const loop = stack.includes(key) ? { pageIds: [...stack.slice(stack.indexOf(key)).map((k) => k.split("|")[0]), e.pageId] } : embedCycleFrom(pages, n);
  if (loop) {
    const names = loop.pageIds.map((id) => titleOf(pages.find((p) => p.id === id)));
    return warnBox(`Recursive embed not shown: ${names.join(" › ")}`, page);
  }
  const r = resolveEmbed(pages, n);
  if (!r.ok && !r.blocks.length) return warnBox(r.error?.message || "Embedded content unavailable", page);
  const sub = { ...ctx, embedStack: [...stack, key], locked: true };
  const shown = r.blocks.slice(0, EMBED_MAX_BLOCKS);
  const more = r.blocks.length - shown.length;
  const label = e.mode === "h" ? `${titleOf(page)} › ${String(r.blocks[0]?.text ?? "").replace(/[*_`~]/g, "").trim() || "Heading"}` : titleOf(page);
  return h(
    "span",
    { class: "embed", role: "group", "aria-label": `Embedded from ${label}`, "data-embed": key },
    h("span", { class: "embed-head" }, h("span", { class: "embed-src" }, ico("file-input"), h("span", {}, label)), openLink(page)),
    h("span", { class: "embed-body" }, staticBlocks(shown, sub)),
    more > 0 ? h("span", { class: "embed-more" }, `${more} more block${more === 1 ? "" : "s"}: open the source to see all`) : null,
    !r.ok ? h("span", { class: "embed-warn-text" }, ico("info"), h("span", {}, r.error.message)) : null
  );
}

// ---------- read-only block rendering (inside an embed) ----------
const safeImg = (s) => /^(data:image\/(png|jpe?g|gif|webp);|https?:\/\/)/i.test(String(s || ""));
const MAX_DEPTH = 6;
/** Blocks drawn read-only as spans with display:block (they sit inside inline text, where a div is not allowed). */
export function staticBlocks(blocks, ctx, depth = 0) {
  const out = [];
  let num = 0;
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== "object") continue;
    num = b.type === "numbered" ? num + 1 : 0;
    out.push(staticBlock(b, ctx, depth, num));
  }
  return out;
}
function staticBlock(b, ctx, depth, num) {
  const text = () => renderInline(typeof b.text === "string" ? b.text : "", ctx);
  const kids = () => (depth < MAX_DEPTH && Array.isArray(b.children) && b.children.length ? h("span", { class: "emb-kids" }, staticBlocks(b.children, ctx, depth + 1)) : null);
  const cls = `emb-blk emb-${String(b.type).replace(/[^a-z0-9]/gi, "")}`;
  const hm = /^h([1-4])$/.exec(b.type);
  if (hm) return h("span", { class: cls, role: "heading", "aria-level": String(Number(hm[1]) + 1) }, text(), kids());
  switch (b.type) {
    case "p":
    case "quote":
    case "callout":
    case "toggle":
      return h("span", { class: cls }, text(), kids());
    case "bullet":
      return h("span", { class: cls }, h("span", { class: "emb-mark", "aria-hidden": "true" }, "•"), h("span", {}, text()), kids());
    case "numbered":
      return h("span", { class: cls }, h("span", { class: "emb-mark" }, `${num}.`), h("span", {}, text()), kids());
    case "todo":
      return h("span", { class: `${cls}${b.checked ? " done" : ""}` }, h("span", { class: "emb-mark", role: "img", "aria-label": b.checked ? "Done" : "Not done" }, ico(b.checked ? "square-check" : "square")), h("span", {}, text()), kids());
    case "code":
      return h("code", { class: `${cls} emb-code` }, String(b.text ?? ""));
    case "divider":
      return h("span", { class: `${cls} emb-hr`, role: "separator" });
    case "image":
      return safeImg(b.src) ? h("img", { class: `${cls} emb-img`, src: b.src, alt: b.caption || "Image", loading: "lazy" }) : h("span", { class: cls }, "[image]");
    case "table":
      return h("span", { class: `${cls} emb-table` }, h("span", { class: "emb-tbl", role: "table" }, (Array.isArray(b.cells) ? b.cells : []).slice(0, 50).map((row, r) => h("span", { class: "emb-tr", role: "row" }, (Array.isArray(row) ? row : []).map((c) => h("span", { class: `emb-td${b.header && r === 0 ? " head" : ""}`, role: "cell" }, renderInline(String(c ?? ""), ctx)))))));
    case "columns":
      return h("span", { class: `${cls} emb-cols` }, (b.children || []).map((col) => h("span", { class: "emb-col" }, depth < MAX_DEPTH ? staticBlocks(col.children, ctx, depth + 1) : null)));
    case "page": {
      const p = pagesOf(ctx).find((x) => x.id === b.ref);
      return p ? h("span", { class: cls }, h("a", { class: "ichip ichip-link", href: `#page-${p.id}` }, pageIcon(p), h("span", {}, titleOf(p)))) : h("span", { class: cls }, "[page]");
    }
    default:
      return h("span", { class: `${cls} emb-other` }, `[${String(b.type)} block: open the source to see it]`);
  }
}
