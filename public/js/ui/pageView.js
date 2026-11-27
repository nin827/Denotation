import { normalizeBlocks, hasChildren, newBlock } from "../blocks/model.js";
import { blocksToMarkdown } from "../blocks/markdown.js";
import { isTrashed, ancestors, descendantIds } from "../workspace.js";
import { debounce, h } from "./dom.js";
import { iconNode, ico, pageIcon } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { renderCell } from "./cellEditors.js";
import { toast, confirmDialog } from "./dialogs.js";
import { saveTextFile } from "./files.js";
import { pickEmoji } from "./emoji.js";
import { createBlockEditor } from "./blockEditor.js";

const COVERS = {
  sunset: "linear-gradient(120deg,#f6d365,#fda085)",
  ocean: "linear-gradient(120deg,#84fab0,#8fd3f4)",
  lavender: "linear-gradient(120deg,#a18cd1,#fbc2eb)",
  forest: "linear-gradient(120deg,#5ee7a0,#2b8a5d)",
  slate: "linear-gradient(120deg,#485563,#29323c)",
  rose: "linear-gradient(120deg,#ff9a9e,#fad0c4)",
  sky: "linear-gradient(120deg,#89f7fe,#66a6ff)",
  sand: "linear-gradient(120deg,#e6dccb,#c9b79c)"
};
export function makePersistence(ws) {
  const pending = new Map();
  const run = async (id) => {
    const e = pending.get(id);
    if (!e) return;
    pending.delete(id);
    clearTimeout(e.t);
    await (e.c.dbId ? ws.saveRow(e.c) : ws.savePage(e.c));
  };
  return {
    persist(c) {
      const e = pending.get(c.id);
      if (e) clearTimeout(e.t);
      pending.set(c.id, { c, t: setTimeout(() => run(c.id).catch((err) => toast(err.message, "error")), 400) });
    },
    flush: () => Promise.all([...pending.keys()].map(run))
  };
}
function makeCtx(env, container, { pageId, locked, crumbs }) {
  const { ws: ws } = env;
  const listeners = new Set();
  const syncs = new Map();
  const recordFor = (page) => ({ page: Object.assign(page, { blocks: normalizeBlocks(page.blocks) }), editors: new Set() });
  const lookup = (id) => env.pages().find((p) => p.id === id);
  const ctx = {
    ws: ws,
    locked,
    pageId,
    persist: env.persistence.persist,
    flush: env.persistence.flush,
    changed() {
      for (const f of [...listeners]) if (f() === false) listeners.delete(f);
    },
    onChange(f) {
      listeners.add(f);
    },
    pageInfo(id) {
      const p = lookup(id);
      if (!p) return { id, state: "missing", title: "" };
      return { id, title: p.title, icon: p.icon, type: p.type, state: isTrashed(env.pages(), p) ? "trashed" : "ok" };
    },
    livePages() {
      const all = env.pages();
      return all.filter((p) => p.type !== "sync" && !isTrashed(all, p));
    },
    breadcrumbs: () => crumbs(),
    openPage: (id) => env.open(id),
    async createChildPage(type) {
      const p = await ws.createPage({ type, parentId: pageId, title: type === "database" ? "New database" : "Untitled" });
      await env.refresh();
      return p;
    },
    async trashRef(id) {
      await ws.trashPage(id);
      await env.refresh();
    },
    async restoreRef(id) {
      await ws.restorePage(id);
      await env.refresh();
    },
    async duplicateRef(id) {
      const c = await ws.duplicatePage(id);
      await env.refresh();
      return c;
    },
    getSync(ref) {
      if (!syncs.has(ref)) {
        syncs.set(ref, ws.getPage(ref).then((p) => p && p.type === "sync" ? recordFor(p) : null));
      }
      return syncs.get(ref);
    },
    async createSync(blocks) {
      const rec = recordFor(await ws.createSync(blocks));
      syncs.set(rec.page.id, Promise.resolve(rec));
      return rec;
    }
  };
  return ctx;
}
function crumbTrail(env, page, row) {
  const chain = ancestors(env.pages(), page.id);
  if (row) chain.push({ id: row.id, title: row.title, icon: row.icon, isRow: true });
  return chain;
}
const exportMarkdown = async (env, title, blocks) => {
  const ctx = {
    pageTitle: (id) => env.pages().find((p) => p.id === id)?.title || "Untitled",
    syncBlocks: () => []
  };
  const md = `# ${title || "Untitled"}

${blocksToMarkdown(blocks, ctx)}
`;
  const status = await saveTextFile(`${(title || "page").replace(/[^\w-]+/g, "-").toLowerCase()}.md`, md);
  if (status === "copied") toast("Downloads are unavailable here, so the Markdown was copied to your clipboard.");
};
export function renderHeader(env, target, opts = {}) {
  const { ws: ws } = env;
  const isRow = !!opts.row;
  const trashed = !isRow && isTrashed(env.pages(), target);
  const locked = !!target.locked || trashed;
  const saveTarget = debounce(async () => {
    await (isRow ? ws.saveRow(target) : ws.savePage(target));
    env.refresh();
  });
  const titleInput = h("input", {
    class: "page-title",
    value: opts.titleValue,
    placeholder: "Untitled",
    readonly: locked || opts.readonlyTitle,
    "aria-label": "Page title",
    onInput: (e) => {
      opts.setTitle(e.target.value);
      saveTarget();
    },
    onKeydown: (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        document.querySelector("#main .blk-ta")?.focus();
      }
    }
  });
  const setIcon = () => pickEmoji(iconBtn ?? addIcon, async (em) => {
    if (em) target.icon = em;
    else delete target.icon;
    await (isRow ? ws.saveRow(target) : ws.savePage(target));
    await env.refresh();
    env.rerender();
  });
  const iconBtn = target.icon ? h("button", { class: "page-icon", "aria-label": "Change icon", disabled: locked, onClick: setIcon }, iconNode(target.icon)) : null;
  const addIcon = h("button", { class: "icon quick", onClick: setIcon }, ico("shapes"), " Add icon");
  const chooseCover = (anchor) => openMenu(anchor, [
    ...Object.entries(COVERS).map(([k, bg]) => ({
      label: k[0].toUpperCase() + k.slice(1),
      swatch: bg,
      onSelect: async () => {
        target.cover = k;
        await ws.savePage(target);
        env.rerender();
      }
    })),
    ...target.cover ? [{ label: "Remove cover", danger: true, onSelect: async () => {
      delete target.cover;
      await ws.savePage(target);
      env.rerender();
    } }] : []
  ], { width: 220 });
  const addCover = h("button", { class: "icon quick", onClick: (e) => chooseCover(e.currentTarget) }, ico("image-plus"), " Add cover");
  const trail = crumbTrail(env, isRow ? opts.row.db : target, isRow ? { id: target.id, title: opts.titleValue, icon: target.icon } : null);
  const crumbs = h("nav", { class: "crumbs", "aria-label": "Breadcrumb" }, trail.flatMap((p, i) => {
    const last = i === trail.length - 1;
    return [
      i ? h("span", { class: "sep" }, "/") : null,
      last ? h("span", { class: "crumb-current" }, iconNode(p.icon), " ", p.title || "Untitled") : h("a", { href: `#page-${p.id}`, onClick: (e) => {
        e.preventDefault();
        env.open(p.id);
      } }, iconNode(p.icon), " ", p.title || "Untitled")
    ];
  }));
  const fav = isRow ? null : h("button", {
    class: `icon fav${target.favorite ? " on" : ""}`,
    title: target.favorite ? "Remove from favorites" : "Add to favorites",
    "aria-pressed": String(!!target.favorite),
    onClick: async () => {
      await ws.setFavorite(target.id, !target.favorite);
      await env.refresh();
      env.rerender();
    }
  }, ico("star"));
  const menuBtn = h("button", { class: "icon", title: "Page options", "aria-label": "Page options", onClick: (e) => openMenu(e.currentTarget, pageMenuItems(env, target, opts)) }, ico("ellipsis"));
  const banner = trashed ? h(
    "div",
    { class: "banner" },
    h("span", {}, "This page is in the trash."),
    h("button", { onClick: async () => {
      await ws.restorePage(target.id);
      await env.refresh();
      env.rerender();
    } }, "Restore"),
    h("button", { class: "danger", onClick: () => deleteForever(env, target) }, "Delete forever")
  ) : null;
  return h(
    "header",
    { class: "page-head" },
    target.cover && COVERS[target.cover] ? h(
      "div",
      { class: "cover", style: `background:${COVERS[target.cover]}` },
      locked ? null : h("button", { class: "cover-btn", onClick: (e) => chooseCover(e.currentTarget) }, "Change cover")
    ) : null,
    h("div", { class: "page-bar" }, crumbs, h("div", { class: "page-actions" }, fav, menuBtn)),
    banner,
    h("div", { class: "quick-row" }, !target.icon && !locked ? addIcon : null, !target.cover && !locked && !isRow ? addCover : null),
    h("div", { class: "title-row" }, iconBtn, titleInput)
  );
}
async function deleteForever(env, page) {
  const ok = await confirmDialog(`Permanently delete "${page.title || "Untitled"}" and everything inside it? This can't be undone.`, { title: "Delete forever", confirmLabel: "Delete forever" });
  if (!ok) return;
  await env.ws.deletePage(page.id);
  await env.refresh();
  env.leave([page.id]);
}
function pageMenuItems(env, target, opts) {
  const { ws: ws } = env;
  const isRow = !!opts.row;
  const pick = async (key) => {
    target[key] = !target[key];
    await (isRow ? ws.saveRow(target) : ws.savePage(target));
    env.rerender();
  };
  const items = [{ label: target.icon ? "Change icon" : "Add icon", icon: ico("shapes"), onSelect: () => pickEmoji(document.querySelector(".page-title"), async (em) => {
    if (em) target.icon = em;
    else delete target.icon;
    await (isRow ? ws.saveRow(target) : ws.savePage(target));
    await env.refresh();
    env.rerender();
  }) }];
  if (!isRow) {
    if (target.type !== "repo") items.push(
      { label: `${target.fullWidth ? "Full width (on)" : "Full width"}`, icon: ico("maximize-2"), onSelect: () => pick("fullWidth") },
      { label: `${target.smallText ? "Small text (on)" : "Small text"}`, icon: ico("a-large-small"), onSelect: () => pick("smallText") },
      { label: `${target.locked ? "Lock page (on)" : "Lock page"}`, icon: ico("lock"), onSelect: () => pick("locked") },
      { label: "Duplicate", icon: ico("copy"), onSelect: async () => {
        const c = await ws.duplicatePage(target.id);
        await env.refresh();
        toast("Page duplicated");
        env.open(c.id);
      } }
    );
    const all = env.pages();
    const banned = descendantIds(all, target.id);
    const homes = all.filter((p) => ["doc", "repo"].includes(p.type) && !banned.has(p.id) && !isTrashed(all, p) && p.id !== target.parentId).slice(0, 40);
    if (homes.length && target.type !== "repo") {
      items.push({
        label: "Move to",
        icon: ico("corner-up-right"),
        items: homes.map((p) => ({ label: p.title || "Untitled", icon: pageIcon(p), onSelect: async () => {
          await ws.movePage(target.id, p.id);
          await env.refresh();
          env.rerender();
        } }))
      });
    }
  }
  if (target.blocks || isRow) {
    items.push({ label: "Export as Markdown", icon: ico("file-down"), onSelect: () => exportMarkdown(env, opts.titleValue, target.blocks || []) });
  }
  items.push(isRow ? { label: "Delete row", icon: ico("trash"), danger: true, onSelect: async () => {
    if (!await confirmDialog("Delete this row permanently?", { title: "Delete row" })) return;
    await ws.deleteRow(target.id);
    env.leave([], opts.row.db.id);
  } } : { label: "Move to trash", icon: ico("trash"), danger: true, onSelect: async () => {
    await ws.trashPage(target.id);
    await env.refresh();
    env.leave([target.id]);
  } });
  return items;
}
function applyLayout(root, page) {
  root.classList.toggle("doc-wide", !!page.fullWidth);
  root.classList.toggle("doc-small", !!page.smallText);
}
export function renderDocPage(root, env, page) {
  const trashed = isTrashed(env.pages(), page);
  const locked = !!page.locked || trashed;
  const ctx = makeCtx(env, page, { pageId: page.id, locked, crumbs: () => crumbTrail(env, page) });
  const header = renderHeader(env, page, { titleValue: page.title, setTitle: (v) => {
    page.title = v;
  } });
  const editor = createBlockEditor(page, ctx);
  applyLayout(root, page);
  root.replaceChildren(header, h(
    "div",
    { class: "doc-body" },
    editor.el,
    locked ? null : h("div", { class: "doc-tail", title: "Click to add a block at the end", onClick: () => {
      const last = page.blocks[page.blocks.length - 1];
      if (last.type === "p" && !last.text && !hasChildren(last)) return editor.focusBlock(last.id);
      const nb = newBlock("p");
      page.blocks.push(nb);
      editor.inst.save();
      editor.redraw({ id: nb.id });
    } })
  ));
}
export function renderRowPage(root, env, db, row) {
  const nameCol = db.columns[0];
  const nameIsText = nameCol?.type === "text";
  const title = nameCol ? String(row.values[nameCol.id] ?? "") : "";
  const ctx = makeCtx(env, row, {
    pageId: db.id,
    locked: isTrashed(env.pages(), db),
    crumbs: () => crumbTrail(env, db, { id: row.id, title, icon: row.icon })
  });
  const header = renderHeader(env, row, {
    row: { db },
    titleValue: title,
    readonlyTitle: !nameIsText,
    setTitle: (v) => {
      if (nameCol) row.values[nameCol.id] = v;
    }
  });
  const props = h("div", { class: "row-props" }, db.columns.slice(1).map((col) => h(
    "div",
    { class: "row-prop" },
    h("div", { class: "row-prop-name" }, col.name),
    h("div", { class: "row-prop-val" }, renderCell(col, row.values[col.id], async (v) => {
      row.values[col.id] = v;
      await env.ws.saveRow(row);
    }))
  )));
  const editor = createBlockEditor(row, ctx);
  root.classList.remove("doc-wide", "doc-small");
  root.replaceChildren(header, props, h("div", { class: "doc-body" }, editor.el));
}
