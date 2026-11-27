import { normalizeBlocks, hasChildren, newBlock } from "../blocks/model.js";
import { blocksToMarkdown } from "../blocks/markdown.js";
import { isTrashed, isArchived, isHidden, inTemplate, ancestors, descendantIds, valueText, hasWrittenBlocks } from "../workspace.js";
import { debounce, h } from "./dom.js";
import { iconNode, ico, pageIcon } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { renderCell } from "./cellEditors.js";
import { jsonEditor } from "./valueEditors.js";
import { specOf } from "../typespec.js";
import { orderColumns, sectionColumns } from "../columns.js";
import { toast, confirmDialog } from "./dialogs.js";
import { saveTextFile } from "./files.js";
import { pickEmoji } from "./emoji.js";
import { createBlockEditor } from "./blockEditor.js";
import { inlineResolver, blockTexts } from "./inlineChips.js";
import { setDataSource } from "../sources.js";
import { propsPanel } from "./propsPanel.js";
import { autoCalloutsBox, openRulesEditor } from "./autoCalloutsUi.js";
import { propMap, rowPropMap } from "../autoCallouts.js";
import { frontMatter, cleanProps } from "../pageProps.js";
import { applyPreset } from "../blocks/callout.js";
import { openModal } from "./modal.js";

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
/**
 * Debounced editor saves. With `win`, also flushes at once when the tab goes away (pagehide, beforeunload,
 * visibilitychange to hidden) in capture listeners, so the save reaches the store before the folder adapter's own
 * hide flush runs; `afterFlush` (e.g. store.flush) then writes it out. `dispose()` removes the listeners.
 */
export function makePersistence(ws, { win = null, afterFlush = null } = {}) {
  const pending = new Map();
  const run = async (id) => {
    const e = pending.get(id);
    if (!e) return;
    pending.delete(id);
    clearTimeout(e.t);
    await (e.c.dbId ? ws.saveRow(e.c) : ws.savePage(e.c));
  };
  const flush = () => Promise.all([...pending.keys()].map(run));
  const onHide = () => {
    if (!pending.size) return;
    flush().then(() => afterFlush?.()).catch(() => {});
  };
  const onVisibility = () => win.document?.visibilityState === "hidden" && onHide();
  win?.addEventListener?.("pagehide", onHide, true);
  win?.addEventListener?.("beforeunload", onHide, true);
  win?.document?.addEventListener?.("visibilitychange", onVisibility, true);
  return {
    persist(c) {
      const e = pending.get(c.id);
      if (e) clearTimeout(e.t);
      pending.set(c.id, { c, t: setTimeout(() => run(c.id).catch((err) => toast(err.message, "error")), 400) });
    },
    flush,
    dispose() {
      win?.removeEventListener?.("pagehide", onHide, true);
      win?.removeEventListener?.("beforeunload", onHide, true);
      win?.document?.removeEventListener?.("visibilitychange", onVisibility, true);
    }
  };
}
/** "trashed", "archived" or "ok" (trash wins). */
export const pageState = (pages, p) => (isTrashed(pages, p) ? "trashed" : isArchived(pages, p) ? "archived" : "ok");
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
      return { id, title: p.title, icon: p.icon, type: p.type, state: pageState(env.pages(), p) };
    },
    livePages() {
      const all = env.pages();
      return all.filter((p) => p.type !== "sync" && !isHidden(all, p));
    },
    breadcrumbs: () => crumbs(),
    refresh: () => env.refresh(),
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
const exportMarkdown = async (env, title, blocks, props = null) => {
  const live = () => env.pages().filter((p) => p.type !== "sync" && !isHidden(env.pages(), p));
  const lookup = {
    ws: env.ws,
    livePages: live,
    pageInfo: (id) => {
      const p = env.pages().find((x) => x.id === id);
      return p ? { id, state: pageState(env.pages(), p) } : { id, state: "missing" };
    }
  };
  const ctx = {
    pageTitle: (id) => env.pages().find((p) => p.id === id)?.title || "Untitled",
    syncBlocks: () => [],
    inline: await inlineResolver(lookup, blockTexts(blocks))
  };
  const fm = props?.length ? `---\n${frontMatter(title || "Untitled", cleanProps(props), ctx.pageTitle)}\n---\n\n` : "";
  const md = `${fm}# ${title || "Untitled"}

${blocksToMarkdown(blocks, ctx)}
`;
  const status = await saveTextFile(`${(title || "page").replace(/[^\w-]+/g, "-").toLowerCase()}.md`, md);
  if (status === "copied") toast("Downloads are unavailable here, so the Markdown was copied to your clipboard.");
};
/** Live pages for pickers in the properties panel (no sync pages, nothing trashed or archived). */
const pickablePages = (env) => {
  const all = env.pages();
  return all.filter((p) => p.type !== "sync" && p.type !== "repo" && !isHidden(all, p));
};
export function renderHeader(env, target, opts = {}) {
  const { ws: ws } = env;
  const isRow = !!opts.row;
  const pages = env.pages();
  const trashed = !isRow && isTrashed(pages, target);
  const archived = !isRow && !trashed && isArchived(pages, target);
  const locked = !!target.locked || trashed || archived || !!opts.readOnly;
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
      opts.onPropsChange?.();
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
  // Page properties: docs and databases (database rows keep their columns)
  const panel = !isRow && ["doc", "database"].includes(target.type) ? propsPanel(target, {
    locked,
    pages: () => pickablePages(env),
    save: () => env.persistence.persist(target),
    onChange: () => opts.onPropsChange?.(),
    openPage: (id) => env.open(id)
  }) : null;
  const menuOpts = { ...opts, locked, addProperty: panel && !locked ? () => panel.addProperty() : null };
  const menuBtn = h("button", { class: "icon", title: "Page options", "aria-label": "Page options", onClick: (e) => openMenu(e.currentTarget, pageMenuItems(env, target, menuOpts)) }, ico("ellipsis"));
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
  ) : archived ? archiveBanner(env, target) : !isRow && target.template ? templateBanner(env, target) : null;
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
    h("div", { class: "title-row" }, iconBtn, titleInput),
    panel
  );
}
/** Archived page: read-only notice with Restore / Move to trash, and a link back to the row it came from. */
function archiveBanner(env, page) {
  const { ws } = env;
  const from = page.archivedFrom;
  const back = h("span", { class: "arch-from" });
  if (from?.rowId) {
    ws.getRow(from.rowId).then((row) => {
      const db = row && env.pages().find((p) => p.id === row.dbId);
      back.replaceChildren(row && db && !isHidden(env.pages(), db) ? h("a", { href: `#row-${row.id}`, class: "arch-row-link", onClick: (e) => {
        e.preventDefault();
        env.openRow(row.id);
      } }, ico("table-properties"), ` Row in ${db.title || "Untitled"}`) : h("span", { class: "hint" }, `From a row of ${from.dbTitle || "a database"} (no longer there)`));
    }).catch(() => {});
  }
  return h(
    "div",
    { class: "banner banner-archive" },
    h("span", {}, ico("archive"), " Archived: read-only until restored."),
    back,
    h("button", { class: "arch-restore", onClick: () => restoreArchived(env, page) }, ico("archive-arrow-up"), " Restore"),
    h("button", { class: "danger arch-trash", onClick: async () => {
      await ws.archiveToTrash(page.id);
      await env.refresh();
      toast(`"${page.title || "Untitled"}" moved to trash`);
      env.leave([page.id]);
    } }, "Move to trash")
  );
}
export async function restoreArchived(env, page) {
  const r = await env.ws.unarchivePage(page.id);
  await env.refresh();
  if (r?.row) {
    toast("Restored into its row");
    return env.openRow(r.row.id);
  }
  toast(`"${page.title || "Untitled"}" restored`);
  env.rerender();
}
function templateBanner(env, page) {
  const db = page.templateFor ? env.pages().find((p) => p.id === page.templateFor) : null;
  return h(
    "div",
    { class: "banner banner-template" },
    h("span", {}, ico("layout-template"), db ? ` Row template for ${db.title || "Untitled"}.` : page.templateFor ? " Row template (its database is gone)." : " Template: listed under Templates, not in the page tree."),
    !page.templateFor || db ? h("button", { class: "tpl-use", onClick: () => useTemplate(env, page) }, ico("plus"), db ? " New row from this template" : " New page from this template") : null
  );
}
/** A page (or, for a row template, a row) made from this template. */
export async function useTemplate(env, t) {
  await env.persistence.flush();
  if (t.templateFor) {
    const db = env.pages().find((p) => p.id === t.templateFor && p.type === "database");
    if (!db) return toast("The database of this row template is gone.", "error");
    const row = await env.ws.createRowFromTemplate(db, t.id);
    await env.refresh();
    toast("Row added from template");
    return db.rowPages === false ? env.open(db.id) : env.openRow(row.id);
  }
  const pages = env.pages();
  const parent = pages.find((p) => p.id === t.parentId && ["doc", "repo"].includes(p.type) && !isHidden(pages, p) && !inTemplate(pages, p));
  const repo = ancestors(pages, t.id).find((p) => p.type === "repo");
  return env.create("template", parent?.id ?? repo?.id ?? null, { templateId: t.id });
}
async function deleteForever(env, page) {
  const ok = await confirmDialog(`Permanently delete "${page.title || "Untitled"}" and everything inside it? This can't be undone.`, { title: "Delete forever", confirmLabel: "Delete forever" });
  if (!ok) return;
  await env.ws.deletePage(page.id);
  await env.refresh();
  env.leave([page.id]);
}
/** Asks first, then archives the page (it can be restored from Archive). */
export async function archiveWithConfirm(env, page) {
  const ok = await confirmDialog(`Archive "${page.title || "Untitled"}"? It leaves the page tree and search and becomes read-only. Restore it any time from Archive in the workspace menu.`, { title: "Archive page", confirmLabel: "Archive", danger: false });
  if (!ok) return false;
  await env.persistence.flush();
  await env.ws.archivePage(page.id);
  await env.refresh();
  toast(`"${page.title || "Untitled"}" archived`, "info", { action: { label: "Undo", run: async () => {
    await env.ws.unarchivePage(page.id);
    await env.refresh();
    env.open(page.id);
  } }, sticky: false });
  return true;
}
/**
 * Row pages on/off for a database. Turning it off when rows have written bodies asks where those bodies go:
 * Move to Archive or Delete (to Trash). Nothing changes on Cancel.
 */
export async function toggleRowPages(env, db) {
  const { ws } = env;
  await env.persistence.flush();
  const on = db.rowPages === false;
  if (on) {
    await ws.setRowPages(db.id, true);
    toast("Row pages are on: each row opens as a page.");
    await env.refresh();
    return env.rerender();
  }
  const written = await ws.rowsWithBodies(db.id);
  let bodies = null;
  if (written.length) {
    bodies = await new Promise((resolve) => {
      let picked = null;
      openModal({
        title: "Turn off row pages",
        content: h("div", {}, h("p", {}, `${written.length} row${written.length === 1 ? " has" : "s have"} written content in ${written.length === 1 ? "its" : "their"} page body. Where should ${written.length === 1 ? "it" : "they"} go?`),
          h("p", { class: "hint" }, "Each body becomes a page titled after its row, with the row's values as properties. Move to Archive keeps them read-only in the Archive; Delete moves them to the Trash. The rows and their values stay in the database.")),
        actions: [
          { label: "Cancel" },
          { label: "Delete", class: "danger rp-trash", run: () => {
            picked = "trash";
          } },
          { label: "Move to Archive", class: "primary rp-archive", run: () => {
            picked = "archive";
          } }
        ],
        onClose: () => resolve(picked)
      });
    });
    if (!bodies) return;
  }
  const r = await ws.setRowPages(db.id, false, { bodies });
  if (!r.ok) return toast("Row pages could not be turned off.", "error");
  toast(r.moved ? `Row pages are off. ${r.moved} row bod${r.moved === 1 ? "y" : "ies"} moved to ${bodies === "trash" ? "the Trash" : "the Archive"}.` : "Row pages are off: rows are data only.");
  await env.refresh();
  env.rerender();
}
/** Rules editor for a page or database; `holder` is saved with the cleaned list. */
function editRules(env, holder) {
  const isDb = holder.type === "database";
  const all = env.pages();
  const names = isDb ? (holder.sourceId ? all.find((p) => p.id === holder.sourceId)?.columns ?? [] : holder.columns ?? []).map((c) => c.name)
    : [...(holder.props ?? []).map((p) => p.name), ...all.filter((p) => p.parentId === holder.id).flatMap((p) => (p.props ?? []).map((x) => x.name)), "Title"];
  openRulesEditor({
    rules: holder.autoCallouts,
    propNames: names,
    where: isDb ? "These rules apply to the row pages of this database (column names)." : holder.template ? "Pages made from this template get a copy of these rules." : "These rules apply to this page and its sub-pages (unless a nearer page has its own).",
    onSave: async (list) => {
      if (list.length) holder.autoCallouts = list;
      else delete holder.autoCallouts;
      await env.persistence.flush();
      await env.ws.savePage(holder);
      toast(list.length ? `${list.length} automatic callout rule${list.length === 1 ? "" : "s"} saved` : "Automatic callouts removed");
      env.rerender();
    }
  });
}
function pageMenuItems(env, target, opts) {
  const { ws: ws } = env;
  const isRow = !!opts.row;
  const all = env.pages();
  if (!isRow && !isTrashed(all, target) && isArchived(all, target)) {
    return [
      target.archivedAt ? { label: "Restore from archive", icon: ico("archive-arrow-up"), onSelect: () => restoreArchived(env, target) } : null,
      target.archivedAt ? { label: "Move to trash", icon: ico("trash"), danger: true, onSelect: async () => {
        await ws.archiveToTrash(target.id);
        await env.refresh();
        env.leave([target.id]);
      } } : null,
      target.blocks ? { label: "Export as Markdown", icon: ico("file-down"), onSelect: () => exportMarkdown(env, opts.titleValue, target.blocks || [], target.props) } : null
    ].filter(Boolean);
  }
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
    if (opts.addProperty) items.push({ label: "Add a property", icon: ico("list-plus"), onSelect: () => opts.addProperty() });
    if (["doc", "database"].includes(target.type) && !opts.locked) {
      const n = target.autoCallouts?.length ?? 0;
      items.push({ label: "Automatic callouts…", icon: ico("wand-sparkles"), hint: n ? `${n} rule${n === 1 ? "" : "s"}` : null, onSelect: () => editRules(env, target) });
    }
    if (target.type === "database" && !target.sourceId) items.push({
      label: target.dataSource ? "Data source (on)" : "Data source",
      icon: ico("database-zap"),
      hint: target.dataSource ? "listed first in pickers" : null,
      onSelect: async () => {
        setDataSource(target, !target.dataSource);
        await ws.savePage(target);
        await env.refresh();
        env.rerender();
      }
    });
    if (target.type === "database" && !target.sourceId) {
      const on = target.rowPages !== false;
      items.push({ label: on ? "Row pages (on)" : "Row pages (off)", icon: ico(on ? "square-check" : "square"), hint: on ? "rows open as pages" : "rows are data only", onSelect: () => toggleRowPages(env, target) });
      const rowTemplates = all.filter((p) => p.template && p.templateFor === target.id && !isHidden(all, p));
      items.push({ label: "New row template", icon: ico("layout-template"), onSelect: () => newRowTemplate(env, target) });
      if (rowTemplates.length) items.push({ label: "New row from template", icon: ico("copy-plus"), items: rowTemplates.map((t) => ({ label: t.title || "Untitled", icon: pageIcon(t), onSelect: () => useTemplate(env, t) })) });
    }
    if (target.type === "doc") {
      items.push({ label: target.template ? "Template (on)" : "Template", icon: ico("layout-template"), hint: target.template ? "listed under Templates" : null, onSelect: async () => {
        await env.persistence.flush();
        await ws.setTemplate(target.id, !target.template);
        await env.refresh();
        toast(target.template ? "No longer a template" : "Marked as a template: it is listed under Templates in the sidebar.");
        env.rerender();
      } });
      if (target.template) {
        const dbs = all.filter((p) => p.type === "database" && !p.sourceId && !isHidden(all, p)).slice(0, 40);
        items.push({ label: "Template for", icon: ico("table-properties"), hint: target.templateFor ? "rows" : "pages", items: [
          { label: "New pages", icon: ico(target.templateFor ? "minus" : "check"), onSelect: async () => {
            await ws.setTemplate(target.id, true, { templateFor: null });
            await env.refresh();
            env.rerender();
          } },
          ...dbs.map((d) => ({ label: `Rows of ${d.title || "Untitled"}`, icon: ico(target.templateFor === d.id ? "check" : "database"), onSelect: async () => {
            await ws.setTemplate(target.id, true, { templateFor: d.id });
            await env.refresh();
            env.rerender();
          } }))
        ] });
      }
    }
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
    const banned = descendantIds(all, target.id);
    const homes = all.filter((p) => ["doc", "repo"].includes(p.type) && !banned.has(p.id) && !isHidden(all, p) && !inTemplate(all, p) && p.id !== target.parentId).slice(0, 40);
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
    items.push({ label: "Export as Markdown", icon: ico("file-down"), onSelect: () => exportMarkdown(env, opts.titleValue, target.blocks || [], isRow ? null : target.props) });
  }
  if (!isRow && target.type !== "repo" && target.type !== "sync") items.push({ label: "Archive", icon: ico("archive"), onSelect: async () => {
    if (await archiveWithConfirm(env, target)) env.leave([target.id]);
  } });
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
/** A new row template for `db`: a template page with one property per column, next to the database. */
async function newRowTemplate(env, db) {
  await env.persistence.flush();
  const { ws } = env;
  const all = env.pages();
  const parent = all.find((p) => p.id === db.parentId && ["doc", "repo"].includes(p.type));
  const t = await ws.createPage({ type: "doc", title: `${db.title || "Untitled"} row`, parentId: parent?.id ?? db.parentId ?? null });
  const src = db.sourceId ? all.find((p) => p.id === db.sourceId) ?? db : db;
  const typeOf = (c) => (["text", "number", "checkbox", "date", "select"].includes(c.type) ? c.type : "text");
  t.props = cleanProps(src.columns.slice(1).filter((c) => c.type !== "formula").map((c) => ({ name: c.name, type: typeOf(c), options: c.config?.options ?? [], value: null })));
  if (!t.props.length) delete t.props;
  t.template = true;
  t.templateFor = src.id;
  await ws.savePage(t);
  await env.refresh();
  toast("Row template created: fill in its properties and body.");
  env.open(t.id);
}
function applyLayout(root, page) {
  root.classList.toggle("doc-wide", !!page.fullWidth);
  root.classList.toggle("doc-small", !!page.smallText);
}
/** Automatic callouts for a page or row; `pinTo` is the record whose blocks get a pinned callout. */
function autoBox(env, { chain, props, holder, editor, locked }) {
  const skip = () => new Set(holder.pinnedRules ?? []);
  const box = autoCalloutsBox({
    chain,
    props,
    skip,
    onPin: locked ? null : (rule) => {
      const b = newBlock("callout", { text: rule.text });
      applyPreset(b, rule.preset);
      holder.blocks = normalizeBlocks(holder.blocks);
      const first = holder.blocks[0];
      if (holder.blocks.length === 1 && first.type === "p" && !first.text && !hasChildren(first)) holder.blocks.splice(0, 1, b);
      else holder.blocks.unshift(b);
      holder.pinnedRules = [...new Set([...(holder.pinnedRules ?? []), rule.id])];
      editor.inst.save();
      editor.redraw({ id: b.id, pos: "end" });
      box.refresh();
      toast("Pinned as a callout block");
    }
  });
  return box;
}
export function renderDocPage(root, env, page) {
  const pages = env.pages();
  const trashed = isTrashed(pages, page);
  const archived = !trashed && isArchived(pages, page);
  const locked = !!page.locked || trashed || archived;
  const ctx = makeCtx(env, page, { pageId: page.id, locked, crumbs: () => crumbTrail(env, page) });
  let box = null;
  const titleOf = (id) => env.pages().find((p) => p.id === id)?.title || "Untitled";
  const header = renderHeader(env, page, { titleValue: page.title, setTitle: (v) => {
    page.title = v;
  }, onPropsChange: () => box?.refresh() });
  const editor = createBlockEditor(page, ctx);
  box = autoBox(env, {
    chain: () => [page, ...ancestors(env.pages(), page.id).reverse().slice(1)],
    props: () => propMap(page.props, { title: page.title, titleOf }),
    holder: page,
    editor,
    locked
  });
  applyLayout(root, page);
  root.replaceChildren(header, h(
    "div",
    { class: "doc-body" },
    box,
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
  const pages = env.pages();
  const dbHidden = isHidden(pages, db);
  const dataOnly = db.rowPages === false; // Row pages off: a read-only property view, no body
  const locked = dbHidden || dataOnly;
  const ctx = makeCtx(env, row, {
    pageId: db.id,
    locked,
    crumbs: () => crumbTrail(env, db, { id: row.id, title, icon: row.icon })
  });
  let box = null;
  const header = renderHeader(env, row, {
    row: { db },
    titleValue: title,
    readonlyTitle: !nameIsText,
    readOnly: locked,
    setTitle: (v) => {
      if (nameCol) row.values[nameCol.id] = v;
    },
    onPropsChange: () => box?.refresh()
  });
  const save = async (col, v) => {
    row.values[col.id] = v;
    await env.ws.saveRow(row);
    box?.refresh();
  };
  // Custom (JSON) properties show their full form here, saved as you edit (not while the raw JSON does not parse)
  const valueOf = (col) => {
    if (locked) return renderCell(col, row.values[col.id], () => {}, { readOnly: true, display: "wrap" });
    if (col.type !== "json") return renderCell(col, row.values[col.id], (v) => save(col, v));
    const later = debounce((v) => save(col, v == null ? null : JSON.parse(JSON.stringify(v))), 400);
    let ed = null;
    ed = jsonEditor({ spec: specOf(col.typeText), value: row.values[col.id], label: col.name, onChange: (v) => {
      if (!ed?.rawError()) later(v);
    } });
    return h("div", { class: "row-json" }, ed.el);
  };
  const propRow = (col) => h(
    "div",
    { class: `row-prop${col.type === "json" && !locked ? " row-prop-json" : ""}` },
    h("div", { class: "row-prop-name" }, col.name),
    h("div", { class: "row-prop-val" }, valueOf(col))
  );
  const groups = db.columnGroups || [];
  const rest = orderColumns(db.columns, groups).filter((c) => c.id !== nameCol?.id);
  const props = h("div", { class: "row-props" }, groups.length ? sectionColumns(rest, groups).map((sec) => sec.group ? h(
    "section",
    { class: `row-group${sec.sub ? " sub" : ""}`, "aria-label": sec.sub ? `${sec.group.label}, ${sec.sub.label}` : sec.group.label },
    h("h3", { class: "row-group-head" }, sec.group.label, sec.sub ? h("span", { class: "row-group-sub" }, ` › ${sec.sub.label}`) : null),
    sec.cols.map(propRow)
  ) : sec.cols.map(propRow)) : rest.map(propRow));
  root.classList.remove("doc-wide", "doc-small");
  if (dataOnly) {
    const note = h("p", { class: "hint row-data-only" }, ico("info"), " Row pages are off for this database, so rows are data only. Edit values in the database, or turn on ",
      h("strong", {}, "Row pages"), " in its ⋯ menu to write in rows.");
    root.replaceChildren(header, props, note);
    return;
  }
  const editor = createBlockEditor(row, ctx);
  box = autoBox(env, {
    chain: () => [row, db, ...ancestors(env.pages(), db.id).reverse().slice(1)],
    props: () => rowPropMap(db.columns, row, valueText),
    holder: row,
    editor,
    locked
  });
  root.replaceChildren(header, props, h("div", { class: "doc-body" }, box, editor.el));
}
