import { ancestors, isTrashed } from "../workspace.js";
import { h } from "./dom.js";
import { ico, pageIcon } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { newItems } from "./newMenu.js";

const collapsed = new Set();
export function activeRepo(pages, currentId) {
  const chain = ancestors(pages, currentId);
  return chain.find((p) => p.type === "repo") ?? pages.find((p) => p.type === "repo" && !isTrashed(pages, p)) ?? null;
}
export function renderSidebar(el, {
  pages: pages,
  currentId: currentId,
  view: view,
  locked,
  onOpen,
  onRedraw,
  onCreate,
  onImportCsv,
  onTrash,
  onRename,
  onFavorite,
  onDuplicate,
  onSearch,
  onOpenTrash,
  onSettings,
  onFeedback,
  onAiAccess,
  onPageAiAccess,
  vaultItems,
  onToggleLock,
  onLockNow,
  onClose,
  footer
}) {
  const live = pages.filter((p) => p.type !== "sync" && !isTrashed(pages, p));
  const known = new Set(live.map((p) => p.id));
  const children = new Map();
  for (const p of live) {
    if (p.type === "repo") continue;
    const key = p.parentId && known.has(p.parentId) ? p.parentId : null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(p);
  }
  const repos = live.filter((p) => p.type === "repo");
  const here = activeRepo(pages, currentId);
  const iconBtn = (name, title, onClick, extra = "") => h("button", { class: `icon ${extra}`, title, "aria-label": title, onClick }, ico(name));
  const item = (p, depth, { tree }) => {
    const kids = tree ? children.get(p.id) || [] : [];
    const fold = collapsed.has(p.id);
    const menuAt = (e, anchor) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: rect.left + 24, y: rect.bottom };
      const canHold = p.type === "doc" || p.type === "repo";
      openMenu(anchor ?? at, stepAside([
        { label: "Open", icon: ico("arrow-up-right"), onSelect: () => onOpen(p.id) },
        canHold ? { label: p.type === "repo" ? "Add page or database" : "Add sub-page", icon: ico("plus"), items: newItems({ pages: live, parentId: p.id, onCreate, onImportCsv, repoLevel: p.type === "repo" }) } : null,
        { label: "Rename", icon: ico("pencil"), onSelect: () => onRename(p) },
        p.type !== "repo" ? { label: p.favorite ? "Remove from favorites" : "Add to favorites", icon: ico("star"), onSelect: () => onFavorite(p) } : null,
        { label: "Duplicate", icon: ico("copy"), onSelect: () => onDuplicate(p) },
        { label: "AI access…", icon: ico("bot"), onSelect: () => {
          onClose();
          onPageAiAccess(p);
        } },
        { label: "Move to trash", icon: ico("trash"), danger: true, onSelect: () => onTrash(p) }
      ].filter(Boolean)), { width: 230 });
    };
    let press = null;
    let longPressed = false; // a long-press opened the menu: swallow the click that follows the finger lifting
    const cancelPress = () => {
      clearTimeout(press);
      press = null;
    };
    return [
      h(
        "div",
        {
          class: `side-item${p.id === currentId && !view ? " active" : ""}${p.type === "repo" ? " repo" : ""}`,
          style: `padding-left:${6 + depth * 14}px`,
          role: "link",
          tabindex: 0,
          onClick: () => {
            if (longPressed) {
              longPressed = false;
              return;
            }
            onOpen(p.id);
          },
          onKeydown: (e) => {
            if (e.key === "Enter") onOpen(p.id);
          },
          onContextmenu: (e) => {
            if (press !== null) longPressed = true; // the browser's own long-press contextmenu beat our timer
            cancelPress();
            menuAt(e);
          },
          onTouchstart: (e) => {
            cancelPress();
            longPressed = false;
            const t = e.touches[0];
            const el2 = e.currentTarget;
            press = setTimeout(() => {
              press = null;
              longPressed = true;
              menuAt({ preventDefault() {
              }, stopPropagation() {
              }, currentTarget: el2, clientX: t.clientX, clientY: t.clientY });
            }, 520);
          },
          onTouchmove: cancelPress,
          onTouchend: (e) => {
            cancelPress();
            if (longPressed && e.cancelable) e.preventDefault(); // no emulated mouse/click after a long-press (it would close the menu)
          },
          onTouchcancel: cancelPress
        },
        kids.length ? h("button", {
          class: `icon twist${fold ? "" : " open"}`,
          "aria-label": fold ? "Expand" : "Collapse",
          onClick: (e) => {
            e.stopPropagation();
            if (fold) collapsed.delete(p.id);
            else collapsed.add(p.id);
            onRedraw();
          }
        }, ico("chevron-right")) : h("span", { class: "twist-gap" }),
        h("span", { class: "side-icon" }, pageIcon(p)),
        h("span", { class: "side-title" }, h("span", { class: "side-text" }, p.title || "Untitled"))
      ),
      ...fold ? [] : kids.flatMap((c) => item(c, depth + 1, { tree }))
    ];
  };
  const favorites = live.filter((p) => p.favorite && p.type !== "repo");
  const newMenu = (e) => openMenu(e.currentTarget, stepAside(newItems({ pages: live, parentId: here?.id, onCreate, onImportCsv })), { width: 230 });
  // An overlay sidebar (phones) would cover the dialog a menu entry opens, so it steps aside first.
  const stepAside = (items) => items.map((it) => it.items ? { ...it, items: stepAside(it.items) } : it.onSelect ? { ...it, onSelect: () => {
    onClose();
    return it.onSelect();
  } } : it);
  const workspaceMenu = (e) => openMenu(e.currentTarget, stepAside([
    { label: "Settings", icon: ico("settings-2"), onSelect: onSettings },
    { label: "Feedback", icon: ico("message-square-text"), onSelect: onFeedback },
    { label: "Trash", icon: ico("trash"), onSelect: onOpenTrash },
    { separator: true },
    ...vaultItems(),
    { separator: true },
    { label: "AI access…", icon: ico("bot"), onSelect: onAiAccess },
    onLockNow ? { separator: true } : null,
    onLockNow ? { label: "Lock now", icon: ico("lock-keyhole"), onSelect: onLockNow } : null
  ].filter(Boolean)), { width: 240 });
  el.replaceChildren(
    h(
      "div",
      { class: "brand" },
      h("span", { class: "brand-name" }, "Denotion"),
      h("button", { class: "act-new primary", title: "New page or database", "aria-haspopup": "menu", onClick: newMenu }, ico("plus"), h("span", {}, "New"), ico("chevron-down")),
      iconBtn("search", "Search (Ctrl/Cmd+K)", () => {
        onClose();
        onSearch();
      }, "act-search"),
      iconBtn(locked ? "lock" : "lock-open", locked ? "Sidebar is locked open. Click to unlock." : "Lock sidebar open", onToggleLock, `act-lock${locked ? " on" : ""}`),
      h("button", { class: "icon act-more", title: "Workspace menu", "aria-label": "Workspace menu", "aria-haspopup": "menu", onClick: workspaceMenu }, ico("ellipsis")),
      iconBtn("panel-left-close", locked ? "Unlock the sidebar to close it" : "Close sidebar", onClose, locked ? "disabled" : "")
    ),
    h(
      "div",
      { class: "side-list" },
      favorites.length ? h("div", { class: "side-section" }, "Favorites") : null,
      ...favorites.flatMap((p) => item(p, 0, { tree: false })),
      h(
        "div",
        { class: "side-section side-section-row" },
        h("span", {}, "Repositories"),
        h("button", { class: "icon act-repo", title: "New repository", "aria-label": "New repository", onClick: () => onCreate("repo", null) }, ico("plus"))
      ),
      ...repos.flatMap((r) => item(r, 0, { tree: true })),
      ...(children.get(null) || []).flatMap((p) => item(p, 0, { tree: true }))
    ),
    footer
  );
  startMarquees(el);
}
const HOLD_MS = 2e3;
const SPEED = 30;
const calm = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const watched = new WeakSet();
let ro = null;
function marqueeTiming(distance) {
  const travel = distance / SPEED * 1e3;
  const total = HOLD_MS * 2 + travel;
  return { total, from: HOLD_MS / total, to: (HOLD_MS + travel) / total };
}
function startMarquee(title) {
  const text = title.firstElementChild;
  text.getAnimations?.().forEach((a) => a.cancel());
  title.classList.remove("roll");
  const distance = title.scrollWidth - title.clientWidth;
  if (distance <= 1 || calm() || !text.animate) return;
  title.classList.add("roll");
  const d = text.scrollWidth - title.clientWidth + 12;
  const t = marqueeTiming(d);
  text.animate([
    { transform: "translateX(0)", offset: 0 },
    { transform: "translateX(0)", offset: t.from },
    { transform: `translateX(${-d}px)`, offset: t.to },
    { transform: `translateX(${-d}px)`, offset: 1 }
  ], { duration: t.total, iterations: Infinity, easing: "linear" });
}
function startMarquees(root) {
  ro ?? (ro = new ResizeObserver((entries) => entries.forEach((e) => {
    if (e.target.isConnected) startMarquee(e.target);
  })));
  requestAnimationFrame(() => root.querySelectorAll(".side-title").forEach((t) => {
    startMarquee(t);
    if (!watched.has(t)) {
      watched.add(t);
      ro.observe(t);
    }
  }));
}
