import { ancestors, isHidden, inTemplate } from "../workspace.js";
import { h } from "./dom.js";
import { ico, pageIcon } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { newItems } from "./newMenu.js";
import { toast } from "./dialogs.js";
import { currentInstallMode, promptInstall } from "../pwa.js";

const collapsed = new Set();
const openTemplates = new Set(); // repositories whose Templates group is unfolded (folded by default)
export function activeRepo(pages, currentId) {
  const chain = ancestors(pages, currentId);
  return chain.find((p) => p.type === "repo") ?? pages.find((p) => p.type === "repo" && !isHidden(pages, p)) ?? null;
}
// Handlers are looked up on the latest props at call time, so a sidebar kept across redraws never calls stale closures.
let P = {};
const call = (name) => (...args) => P[name](...args);
let built = null; // { el, sig, list } of the last full build
const sigOf = (live, locked) => {
  let out = `${locked ? 1 : 0}|${[...collapsed].sort().join(",")}|${[...openTemplates].sort().join(",")}`;
  for (const p of live) out += `\n${p.id}\u0001${p.title ?? ""}\u0001${p.parentId ?? ""}\u0001${p.type}\u0001${p.icon ?? ""}\u0001${p.favorite ? 1 : 0}\u0001${p.sourceId ?? ""}\u0001${p.dataSource ? 1 : 0}\u0001${p.template ? 1 : 0}\u0001${p.templateFor ?? ""}`;
  return out;
};
export function renderSidebar(el, props) {
  P = props;
  const { pages, currentId, view, locked, footer, vaultItems } = props;
  const onOpen = call("onOpen");
  const onRedraw = call("onRedraw");
  const onCreate = call("onCreate");
  const onImportCsv = call("onImportCsv");
  const onTrash = call("onTrash");
  const onRename = call("onRename");
  const onFavorite = call("onFavorite");
  const onDuplicate = call("onDuplicate");
  const onSearch = call("onSearch");
  const onOpenTrash = call("onOpenTrash");
  const onOpenArchive = call("onOpenArchive");
  const onArchive = call("onArchive");
  const onSettings = call("onSettings");
  const onFeedback = call("onFeedback");
  const onAiAccess = call("onAiAccess");
  const onPageAiAccess = call("onPageAiAccess");
  const onDataSource = call("onDataSource");
  const onRepoSettings = call("onRepoSettings");
  const onToggleLock = call("onToggleLock");
  const onClose = call("onClose");
  const live = pages.filter((p) => p.type !== "sync" && !isHidden(pages, p));
  // templates (and anything inside one) are listed in each repository's Templates group, not in the tree
  const templated = new Set(live.filter((p) => inTemplate(pages, p)).map((p) => p.id));
  const templatesOf = new Map();
  for (const p of live) {
    if (!p.template) continue;
    const repo = ancestors(pages, p.id).find((x) => x.type === "repo");
    const key = repo?.id ?? null;
    if (!templatesOf.has(key)) templatesOf.set(key, []);
    templatesOf.get(key).push(p);
  }
  const known = new Set(live.map((p) => p.id));
  const children = new Map();
  for (const p of live) {
    if (p.type === "repo" || templated.has(p.id)) continue;
    const key = p.parentId && known.has(p.parentId) ? p.parentId : null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(p);
  }
  const repos = live.filter((p) => p.type === "repo");
  const here = activeRepo(pages, currentId);
  props.live = live; // read at click time by the menus
  props.here = here;
  const sig = sigOf(live, locked);
  if (built && built.el === el && built.sig === sig && el.contains(built.list)) {
    // same tree as the last build: only the highlighted row and the footer change
    for (const row of el.querySelectorAll(".side-item")) row.classList.toggle("active", row.dataset.id === currentId && !view);
    if (footer && el.lastElementChild !== footer) el.lastElementChild.replaceWith(footer);
    return;
  }
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
        canHold ? { label: p.type === "repo" ? "Add page or database" : "Add sub-page", icon: ico("plus"), items: newItems({ pages: P.live, parentId: p.id, onCreate, onImportCsv, repoLevel: p.type === "repo" }) } : null,
        { label: "Rename", icon: ico("pencil"), onSelect: () => onRename(p) },
        p.type === "repo" ? { label: "Constants\u2026", icon: ico("variable"), onSelect: () => onRepoSettings(p, "constants") } : null,
        p.type === "repo" ? { label: "Statuses\u2026", icon: ico("circle-dot"), onSelect: () => onRepoSettings(p, "statuses") } : null,
        p.type === "database" && !p.sourceId ? { label: p.dataSource ? "Data source (on)" : "Data source", icon: ico("database-zap"), hint: p.dataSource ? "turn off" : null, onSelect: () => onDataSource(p) } : null,
        p.type !== "repo" ? { label: p.favorite ? "Remove from favorites" : "Add to favorites", icon: ico("star"), onSelect: () => onFavorite(p) } : null,
        { label: "Duplicate", icon: ico("copy"), onSelect: () => onDuplicate(p) },
        { label: "AI access…", icon: ico("bot"), onSelect: () => {
          onClose();
          onPageAiAccess(p);
        } },
        p.type !== "repo" ? { label: "Archive", icon: ico("archive"), onSelect: () => onArchive(p) } : null,
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
          "data-id": p.id,
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
        h("span", { class: "side-title" }, h("span", { class: "side-text" }, p.title || "Untitled")),
        p.dataSource && p.type === "database" ? h("span", { class: "side-badge", title: "Data source", "aria-label": "Data source", role: "img" }, ico("database-zap")) : null
      ),
      ...fold ? [] : kids.flatMap((c) => item(c, depth + 1, { tree })),
      ...!fold && tree && p.type === "repo" ? templateGroup(p.id, depth + 1) : []
    ];
  };
  const templateGroup = (repoId, depth) => {
    const list = templatesOf.get(repoId) ?? [];
    if (!list.length) return [];
    const open = openTemplates.has(repoId ?? "");
    const toggle = () => {
      if (open) openTemplates.delete(repoId ?? "");
      else openTemplates.add(repoId ?? "");
      onRedraw();
    };
    return [
      h("button", {
        type: "button",
        class: "side-group side-templates",
        "data-repo": repoId ?? "",
        style: `padding-left:${6 + depth * 14}px`,
        "aria-expanded": String(open),
        onClick: toggle
      }, h("span", { class: `icon twist${open ? " open" : ""}`, "aria-hidden": "true" }, ico("chevron-right")), h("span", { class: "side-icon" }, ico("layout-template")), h("span", { class: "side-title" }, h("span", { class: "side-text" }, "Templates")), h("span", { class: "side-count" }, String(list.length))),
      ...open ? list.map((t) => item(t, depth + 1, { tree: false })[0]) : []
    ];
  };
  const favorites = live.filter((p) => p.favorite && p.type !== "repo");
  const newMenu = (e) => openMenu(e.currentTarget, stepAside(newItems({ pages: P.live, parentId: P.here?.id, onCreate, onImportCsv })), { width: 230 });
  // An overlay sidebar (phones) would cover the dialog a menu entry opens, so it steps aside first.
  const stepAside = (items) => items.map((it) => it.items ? { ...it, items: stepAside(it.items) } : it.onSelect ? { ...it, onSelect: () => {
    onClose();
    return it.onSelect();
  } } : it);
  // Install: the browser's own dialog where it offers one, otherwise how to do it from the browser menu.
  const installApp = async () => {
    const mode = currentInstallMode();
    if (mode === "prompt") {
      const r = await promptInstall();
      if (r !== "unavailable") return;
    }
    toast(mode === "ios"
      ? "To install on iPhone or iPad: tap Share, then Add to Home Screen."
      : "To install: open your browser menu and choose Install app (Chrome, Edge) or Add to Dock (Safari on Mac), or Add to Home screen on Android. Firefox on desktop can't install web apps; the app works fine in a tab.", "info", { sticky: true });
  };
  const workspaceMenu = (e) => openMenu(e.currentTarget, stepAside([
    { label: "Settings", icon: ico("settings-2"), onSelect: onSettings },
    { label: "Feedback", icon: ico("message-square-text"), onSelect: onFeedback },
    { label: "Trash", icon: ico("trash"), onSelect: onOpenTrash },
    { label: "Archive", icon: ico("archive"), onSelect: onOpenArchive },
    // Locking open only exists on wide screens (see ui/layout.js).
    matchMedia("(max-width: 700px)").matches ? null : { label: locked ? "Unlock sidebar" : "Lock sidebar open", icon: ico(locked ? "lock-open" : "lock"), onSelect: onToggleLock },
    { separator: true },
    ...P.vaultItems(),
    { separator: true },
    { label: "AI access…", icon: ico("bot"), onSelect: onAiAccess },
    currentInstallMode() !== "installed" ? { label: "Install app", icon: ico("download"), onSelect: installApp } : null,
    P.onLockNow ? { separator: true } : null,
    P.onLockNow ? { label: "Lock now", icon: ico("lock-keyhole"), onSelect: () => P.onLockNow() } : null
  ].filter(Boolean)), { width: 240 });
  el.replaceChildren(
    h(
      "div",
      { class: "brand" },
      h("span", { class: "brand-name" }, "Denotation"),
      h("button", { class: "act-new primary", title: "New page or database", "aria-haspopup": "menu", onClick: newMenu }, ico("plus"), h("span", {}, "New"), ico("chevron-down")),
      iconBtn("search", "Search (Ctrl/Cmd+K)", () => {
        onClose();
        onSearch();
      }, "act-search"),
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
  built = { el, sig, list: el.querySelector(".side-list") };
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
// Marquees are measured in batches (all writes, one layout read, all writes) so 500 titles cost one layout, not 500.
function startMarquees(root) {
  ro ?? (ro = new ResizeObserver((entries) => {
    const live = entries.map((e) => e.target).filter((t) => t.isConnected && !fresh.has(t));
    for (const e of entries) fresh.delete(e.target); // a title's first notification repeats the pass below
    if (live.length) rollTitles(live);
  }));
  if (marqueeFrame) return; // several redraws before one frame share one pass over the latest rows
  marqueeFrame = requestAnimationFrame(() => {
    marqueeFrame = 0;
    const titles = [...root.querySelectorAll(".side-title")];
    rollTitles(titles);
    for (const t of titles) {
      if (!watched.has(t)) {
        watched.add(t);
        fresh.add(t);
        ro.observe(t);
      }
    }
  });
}
const fresh = new WeakSet();
let marqueeFrame = 0;
function rollTitles(titles) {
  for (const title of titles) {
    if (!title.classList.contains("roll")) continue; // nothing is animating on a title that never rolled
    title.firstElementChild.getAnimations?.().forEach((a) => a.cancel());
    title.classList.remove("roll");
  }
  const over = titles.filter((title) => title.scrollWidth - title.clientWidth > 1);
  if (!over.length || calm()) return;
  const animated = over.filter((title) => title.firstElementChild.animate);
  for (const title of animated) title.classList.add("roll");
  const dists = animated.map((title) => title.firstElementChild.scrollWidth - title.clientWidth + 12);
  animated.forEach((title, k) => {
    const d = dists[k];
    const t = marqueeTiming(d);
    title.firstElementChild.animate([
      { transform: "translateX(0)", offset: 0 },
      { transform: "translateX(0)", offset: t.from },
      { transform: `translateX(${-d}px)`, offset: t.to },
      { transform: `translateX(${-d}px)`, offset: 1 }
    ], { duration: t.total, iterations: Infinity, easing: "linear" });
  });
}
