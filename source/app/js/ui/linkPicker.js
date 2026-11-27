// Pickers for page links and embeds: the `[[` autocomplete menu items (typed in the block editor), the embed target
// step (heading section or chosen blocks) and the modal pickers behind the slash entries "Link to page" / "Embed page".
// Keyboard: the menu keeps focus in the textarea (Up/Down/Enter/Escape); the modal lists are buttons (touch) with a
// search box (Up/Down/Enter).
import { h } from "./dom.js";
import { ico, pageIcon } from "../icons/index.js";
import { openModal } from "./modal.js";
import { openMenu } from "./popover.js";
import { buildToken } from "../blocks/inline.js";
import { rankPages, headingList, blockChoices, EMBED_MAX_BLOCKS } from "../links.js";

const titleOf = (p) => p?.title || "Untitled";
const kindHint = (p) => (p.type === "database" ? "database" : p.type === "repo" ? "repository" : "");
/** Pages a link may point at: live pages, not the sync records (ctx.livePages already drops trashed / archived). */
export const linkablePages = (ctx) => (typeof ctx?.livePages === "function" ? ctx.livePages() : []).filter((p) => p.type !== "sync");

/**
 * Items for the `[[` menu: the best matching pages; choosing one calls onChoose(page).
 * @returns {object[]} popover menu items
 */
export function pageMenuItems(ctx, query, onChoose, { limit = 8 } = {}) {
  return rankPages(linkablePages(ctx), query, limit).map((p) => ({
    label: titleOf(p),
    icon: pageIcon(p),
    hint: p.id === ctx.pageId ? "this page" : kindHint(p),
    onSelect: () => onChoose(p)
  }));
}

/**
 * Second step of `![[`: link only, a heading section, or chosen blocks. Calls onPick(token) or onCancel().
 * `anchor` = element or point for the menu.
 */
export function embedTargetMenu(anchor, page, { onPick, onCancel }) {
  const heads = headingList(page.blocks);
  let picked = false;
  const done = (token) => {
    picked = true;
    if (token) onPick(token);
    else onCancel?.();
  };
  const items = [
    { header: true, label: `Embed from ${titleOf(page)}` },
    ...heads.slice(0, 60).map((hd) => ({
      label: hd.text || "(empty heading)",
      icon: ico(`heading-${hd.level}`),
      hint: "section",
      onSelect: () => done(buildToken("embed", [page.id, "h", hd.id]))
    })),
    { label: "Choose blocks…", icon: ico("list-checks"), onSelect: () => {
      picked = true;
      pickBlocks(page, { onPick, onCancel });
    } },
    { separator: true },
    { label: "Just link the page", icon: ico("link"), onSelect: () => done(buildToken("link", [page.id])) }
  ];
  openMenu(anchor, items, { width: 280, onClose: () => setTimeout(() => {
    if (!picked) onCancel?.();
  }, 0) });
}

/** Modal: tick up to EMBED_MAX_BLOCKS blocks of a page (document order kept). */
export function pickBlocks(page, { onPick, onCancel }) {
  const choices = blockChoices(page.blocks);
  const chosen = [];
  let done = false;
  const count = h("p", { class: "hint", role: "status", "aria-live": "polite" });
  const insert = h("button", { type: "button", class: "primary", disabled: true }, "Embed");
  const sync = () => {
    count.textContent = `${chosen.length} of at most ${EMBED_MAX_BLOCKS} chosen`;
    insert.disabled = !chosen.length;
    for (const box of list.querySelectorAll("input")) box.disabled = !box.checked && chosen.length >= EMBED_MAX_BLOCKS;
  };
  const label = (c) => c.text || (c.type === "divider" ? "Divider" : c.type === "image" ? "Image" : c.type === "table" ? "Table" : `${c.type} block`);
  const list = h("div", { class: "lp-blocks", role: "group", "aria-label": "Blocks" }, choices.length ? choices.map((c) => h(
    "label",
    { class: "lp-block", style: `padding-left:${8 + Math.min(c.depth, 6) * 14}px` },
    h("input", { type: "checkbox", value: c.id, onChange: (e) => {
      const i = chosen.indexOf(c.id);
      if (e.target.checked && i < 0) chosen.push(c.id);
      if (!e.target.checked && i >= 0) chosen.splice(i, 1);
      sync();
    } }),
    h("span", { class: "lp-type" }, c.type),
    h("span", { class: "lp-text" }, label(c).slice(0, 140))
  )) : h("p", { class: "hint" }, "This page has no blocks."));
  const finish = () => {
    // document order, as the reader sees it on the source page
    const order = choices.map((c) => c.id).filter((id) => chosen.includes(id));
    const token = buildToken("embed", [page.id, "b", order.join(",")]);
    if (!token) return false;
    done = true;
    onPick(token);
    return true;
  };
  insert.addEventListener("click", () => {
    if (finish()) m.close();
  });
  const m = openModal({
    title: `Embed blocks from ${titleOf(page)}`,
    content: h("div", { class: "lp-box" }, count, list, h("div", { class: "ip-btns" }, insert)),
    actions: [{ label: "Cancel" }],
    onClose: () => {
      if (!done) onCancel?.();
    }
  });
  sync();
  setTimeout(() => list.querySelector("input")?.focus(), 0);
  return m;
}

/** Searchable page list inside a modal body; onPick(page). */
function pageList(ctx, onPick) {
  const input = h("input", { type: "search", class: "ip-search", placeholder: "Search pages…", "aria-label": "Search pages", autocomplete: "off", style: "font-size:16px" });
  const list = h("div", { class: "ip-list", role: "listbox", "aria-label": "Pages" });
  const pages = linkablePages(ctx);
  let shown = [];
  let active = 0;
  const draw = () => {
    shown = rankPages(pages, input.value, 100);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.length ? shown.map((p, i) => h(
      "button",
      { type: "button", class: `ip-item${i === active ? " active" : ""}`, role: "option", "aria-selected": String(i === active), onClick: () => onPick(p) },
      h("span", { class: "ip-label" }, pageIcon(p), " ", titleOf(p)),
      kindHint(p) ? h("span", { class: "ip-hint" }, kindHint(p)) : null
    )) : [h("div", { class: "ip-empty" }, "No pages match.")]);
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", () => {
    active = 0;
    draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      draw();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[active]) onPick(shown[active]);
    }
  });
  draw();
  setTimeout(() => input.focus(), 0);
  return h("div", { class: "ip-box" }, input, list);
}

/** Slash entry "Link to page" (kind "link") or a hidden link (kind "xlink"): onPick(token). */
export function pickLink(ctx, { onPick, onCancel } = {}, kind = "link") {
  let done = false;
  const hiddenBox = h("input", { type: "checkbox", checked: kind === "xlink" });
  const m = openModal({
    title: "Link to page",
    content: h("div", {}, pageList(ctx, (p) => {
      const token = buildToken(hiddenBox.checked ? "xlink" : "link", [p.id]);
      if (!token) return;
      done = true;
      m.close();
      onPick?.(token);
    }), h("label", { class: "lp-hidden" }, hiddenBox, h("span", {}, "Hidden link (not drawn in the graph)"))),
    actions: [{ label: "Cancel" }],
    onClose: () => {
      if (!done) onCancel?.();
    }
  });
  return m;
}

/** Slash entry "Embed page": page, then heading section / blocks / plain link. */
export function pickEmbed(ctx, { onPick, onCancel } = {}) {
  let next = false;
  const m = openModal({
    title: "Embed page",
    content: pageList(ctx, (p) => {
      next = true;
      m.close();
      const anchor = document.activeElement instanceof Element && document.activeElement !== document.body ? document.activeElement : { x: Math.max(16, innerWidth / 2 - 140), y: Math.max(16, innerHeight / 3) };
      embedTargetMenu(anchor, p, { onPick, onCancel });
    }),
    actions: [{ label: "Cancel" }],
    onClose: () => {
      if (!next) onCancel?.();
    }
  });
  return m;
}
