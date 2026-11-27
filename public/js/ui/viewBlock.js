// Database view block ("/view"): a live view of a database (or of a plain table block marked as a data source) inside
// any doc page. Stored as { type: "dbview", sourceId, viewId?, view? }:
//   sourceId  a database page id (a linked view resolves to its data page) or a `tbl-<blockId>` table source id
//   viewId    follow one of the source's own views live (edits to its filters and layout change the source's view)
//   view      the block's own "custom" view (layout, filters, sorts, groups, column display, collapsed groups)
// Without a viewId the custom view is shown. Rows edited or added here are the source's rows. Table sources are read-only.
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { renderDatabase } from "./dbView.js";
import { openMenu } from "./popover.js";
import { openModal } from "./modal.js";
import { toast } from "./dialogs.js";
import { bindContextMenu } from "./contextMenu.js";
import { sourceList, sourceLabel, findTableSource, isTableSourceId } from "../sources.js";
import { newView, ensureViews, typeInfo } from "../dbviews.js";
import { newId } from "../ids.js";

const clone = (v) => JSON.parse(JSON.stringify(v));
const WRITES = ["saveRow", "createRow", "deleteRow", "savePage", "updateColumns", "appendCsv"];
/** A workspace facade that notes the time of every write, so the block can ignore its own change notifications. */
function trackedWs(ws, stamp) {
  const t = Object.create(ws);
  for (const m of WRITES) t[m] = async (...a) => {
    stamp();
    return ws[m](...a);
  };
  return t;
}
/** A workspace facade that serves one virtual table source (read-only) and the real workspace for anything else. */
function tableWs(ws, ctx, id, fallback) {
  const fresh = () => findTableSource(ctx.livePages(), id) ?? fallback;
  const no = async () => {
    throw new Error("This table is a read-only data source.");
  };
  return Object.assign(Object.create(ws), {
    getPage: async (pid) => pid === id ? fresh() : ws.getPage(pid),
    listRows: async (did) => did === id ? fresh().rows.map((r) => ({ ...r, values: { ...r.values } })) : ws.listRows(did),
    saveRow: async () => {},
    savePage: async () => {},
    createRow: no,
    deleteRow: no,
    updateColumns: no,
    appendCsv: no
  });
}
/** What a source id points at right now: { state: "none" | "missing" | "trashed" | "ok", host, data }. */
function lookup(ctx, id) {
  if (!id) return { state: "none" };
  if (isTableSourceId(id)) {
    const t = findTableSource(ctx.livePages(), id);
    return t ? { state: "ok", host: t, data: t } : { state: "missing" };
  }
  const info = ctx.pageInfo(id);
  if (info.state === "missing" || info.type !== "database") return { state: "missing" };
  if (info.state === "trashed" || info.state === "archived") return { state: info.state };
  const live = ctx.livePages();
  const host = live.find((p) => p.id === id);
  if (!host) return { state: "missing" };
  if (!host.sourceId) return { state: "ok", host, data: host };
  const data = live.find((p) => p.id === host.sourceId);
  if (data) return { state: "ok", host, data };
  return { state: ctx.pageInfo(host.sourceId).state === "trashed" ? "trashed" : "missing" };
}

/**
 * The searchable source list: data sources first, then other databases, then table sources.
 * onPick(page) gets the database page or the virtual table source.
 */
export function sourcePicker(ctx, { current = null, onPick }) {
  const input = h("input", { type: "search", class: "ip-search", placeholder: "Search sources…", "aria-label": "Search sources", autocomplete: "off", style: "font-size:16px" });
  const list = h("div", { class: "ip-list vb-pick", role: "listbox", "aria-label": "Sources" });
  const items = sourceList(ctx.livePages());
  let active = 0;
  let shown = [];
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.filter((p) => !q || sourceLabel(p).toLowerCase().includes(q));
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.length ? shown.map((p, i) => h(
      "button",
      { type: "button", class: `ip-item${i === active ? " active" : ""}`, role: "option", "aria-selected": String(i === active), onClick: () => onPick(p) },
      h("span", { class: "ip-label" }, p.dataSource ? ico("database-zap") : null, p.dataSource ? " " : null, sourceLabel(p)),
      p.dataSource ? h("span", { class: "ip-hint" }, "Data source") : p.virtual ? h("span", { class: "ip-hint" }, "Read-only") : null,
      p.id === current ? h("span", { class: "ip-hint" }, ico("check"), " current") : null
    )) : [h("div", { class: "ip-empty" }, items.length ? "No match." : "No databases or data-source tables yet.")]);
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", () => {
    active = 0;
    draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(0, Math.min(shown.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
      draw();
    } else if (e.key === "Enter" && shown[active]) {
      e.preventDefault();
      onPick(shown[active]);
    }
  });
  draw();
  return { el: h("div", { class: "vb-picker" }, input, list), input };
}

export function viewBlockBody(b, inst, a) {
  const { ctx } = inst;
  const locked = !!ctx.locked;
  const box = h("div", { class: "vb" });
  const head = h("div", { class: "vb-head" });
  const content = h("div", { class: "vb-content" });
  box.append(head, content);
  let gen = 0;
  let wrote = 0;
  const ws = trackedWs(ctx.ws, () => {
    wrote = Date.now();
  });
  const openRow = async (id) => {
    await ctx.flush?.();
    location.hash = `#row-${id}`;
  };
  const save = () => a.save();

  // ----- source and view selection -----
  const pickSource = (p) => {
    b.sourceId = p.id;
    delete b.viewId;
    delete b.view;
    save();
    renderAll();
  };
  const chooseSource = () => {
    const picker = sourcePicker(ctx, { current: b.sourceId, onPick: (p) => {
      modal.close();
      pickSource(p);
    } });
    const modal = openModal({ title: "Choose a source", content: picker.el, actions: [{ label: "Cancel" }] });
    picker.input.focus();
  };
  const goView = (id) => {
    b.viewId = id;
    save();
    renderAll();
  };
  const goCustom = (seed) => {
    if (!b.view) {
      b.view = seed ? { ...clone(seed), id: newId(), name: "Custom" } : null;
    }
    delete b.viewId;
    save();
    renderAll();
  };
  function convertToSourceView(link) {
    const input = h("input", { type: "text", value: "Page view", maxlength: 40, "aria-label": "View name", style: "font-size:16px" });
    openModal({
      title: "Convert to a view of the source",
      content: h("div", {}, h("p", { class: "hint" }, "The custom view becomes a normal view of the source database, shared by every page that shows it."), h("label", {}, "View name", input)),
      actions: [{ label: "Cancel" }, { label: "Convert", class: "primary", run: async () => {
        const v = { ...clone(b.view), id: newId(), name: input.value.trim() || "Page view" };
        (link.views ?? (link.views = [])).push(v);
        await ctx.ws.savePage(link);
        delete b.view;
        b.viewId = v.id;
        save();
        renderAll();
      } }]
    });
    input.focus();
    input.select();
  }

  // ----- header -----
  let state = null; // { res, link, views, mode: "follow" | "custom", viewId }
  function menuItems() {
    const res = state?.res;
    const items = [];
    if (!locked) items.push({ label: "Change source…", icon: ico("replace"), onSelect: chooseSource });
    if (res?.state === "ok") {
      items.push({ label: res.host.virtual ? "Open the page with the table" : "Open source", icon: ico("arrow-up-right"), onSelect: () => ctx.openPage(res.host.virtual ? res.host.pageId : res.host.id) });
    }
    if (!locked && res?.state === "ok" && !res.host.virtual && state?.mode === "custom" && b.view) {
      items.push({ label: "Convert custom view to a source view…", icon: ico("copy"), onSelect: () => convertToSourceView(state.link) });
    }
    if (!locked && res?.state === "ok" && !res.host.virtual && state?.mode === "follow" && !b.view) {
      items.push({ label: "Customise for this page", icon: ico("sliders-horizontal"), onSelect: () => goCustom(state.views.find((v) => v.id === state.viewId)) });
    }
    return items;
  }
  function drawHead() {
    const res = state?.res;
    const parts = [];
    if (!b.sourceId || !res || res.state !== "ok") {
      parts.push(h("span", { class: "vb-title" }, ico("table-2"), h("span", {}, "Database view")));
    } else {
      const host = res.host;
      parts.push(h(
        "a",
        { class: "vb-title", href: `#page-${host.virtual ? host.pageId : host.id}`, title: host.virtual ? "Open the page with this table" : "Open the source database", onClick: (e) => {
          e.preventDefault();
          ctx.openPage(host.virtual ? host.pageId : host.id);
        } },
        ico(host.virtual ? "table-2" : "database"),
        h("span", {}, host.virtual ? sourceLabel(host) : host.title || "Untitled")
      ));
      if (host.dataSource) parts.push(h("span", { class: "vb-badge", title: "Data source" }, ico("database-zap"), h("span", { class: "sr-only" }, "Data source")));
      if (host.virtual) parts.push(h("span", { class: "vb-badge ro", title: "Read-only: edit the table block" }, ico("lock"), h("span", {}, "Read-only")));
      const tab = (label, on, onClick, icon) => h(
        "button",
        { type: "button", class: `vb-tab${on ? " on" : ""}`, "aria-pressed": String(on), disabled: locked && !on, onClick },
        icon ? ico(icon) : null,
        h("span", {}, label)
      );
      const tabs = [];
      if (!host.virtual) for (const v of state.views) tabs.push(tab(v.name, state.mode === "follow" && v.id === state.viewId, () => goView(v.id), typeInfo(v.type).icon));
      if (host.virtual || b.view || !locked) tabs.push(tab("Custom", state.mode === "custom", () => goCustom(state.views.find((v) => v.id === state.viewId)), "sliders-horizontal"));
      parts.push(h("div", { class: "vb-tabs", role: "toolbar", "aria-label": "Views" }, tabs));
    }
    const items = menuItems();
    parts.push(items.length ? h("button", { type: "button", class: "icon vb-menu", title: "Database view options", "aria-label": "Database view options", "aria-haspopup": "menu", onClick: (e) => openMenu(e.currentTarget, menuItems(), { width: 270 }) }, ico("ellipsis")) : null);
    head.replaceChildren(...parts.filter(Boolean));
  }
  bindContextMenu(head, () => menuItems(), { width: 270 });

  // ----- content -----
  const message = (text, { choose = false } = {}) => h(
    "div",
    { class: "vb-empty" },
    h("p", { class: "hint" }, ico("info"), " ", text),
    choose && !locked ? h("button", { type: "button", onClick: chooseSource }, ico("replace"), " Choose another source") : null
  );
  async function renderAll() {
    const mine = ++gen;
    const res = lookup(ctx, b.sourceId);
    state = { res };
    if (res.state === "none") {
      drawHead();
      if (locked) return content.replaceChildren(message("No source chosen."));
      const picker = sourcePicker(ctx, { onPick: pickSource });
      return content.replaceChildren(h("p", { class: "hint" }, "Choose a database or a data-source table to show here."), picker.el);
    }
    if (res.state !== "ok") {
      drawHead();
      return content.replaceChildren(message(res.state === "trashed" ? "The source of this view is in the trash. Restore it to see the data." : res.state === "archived" ? "The source of this view is archived. Restore it from the Archive to see the data." : "The source of this view no longer exists (or the table is no longer a data source).", { choose: true }));
    }
    const { host, data } = res;
    try {
      let link;
      let embed;
      let runWs = ws;
      let views = [];
      let viewId = null;
      const virtual = !!host.virtual;
      const readOnly = virtual || locked;
      if (virtual) {
        runWs = tableWs(ctx.ws, ctx, host.id, host);
        if (!b.view) {
          b.view = newView("table", data, "Custom");
          save();
        }
        state.mode = "custom";
      } else {
        link = await ctx.ws.getPage(host.id);
        if (!link) throw new Error("The source was not found.");
        const facade = { columns: (link.sourceId ? await ctx.ws.getPage(link.sourceId) : link).columns, views: link.views, columnGroups: [] };
        const had = Array.isArray(link.views) && link.views.length;
        ensureViews(facade);
        link.views = facade.views;
        if (!had && !readOnly) await ctx.ws.savePage(link); // a followed view needs a stored id
        views = link.views;
        viewId = b.viewId && views.some((v) => v.id === b.viewId) ? b.viewId : b.view ? null : views[0].id;
        state.mode = viewId ? "follow" : "custom";
        if (state.mode === "custom" && !b.view) {
          b.view = newView("table", data, "Custom");
          save();
        }
      }
      state.link = link;
      state.views = views;
      state.viewId = viewId;
      drawHead();
      if (mine !== gen) return;
      if (state.mode === "custom") {
        const pseudo = { id: `blk-${b.id}`, title: host.title, sourceId: data.id, views: [b.view] };
        link = pseudo;
        embed = { readOnly, save: async (l) => {
          b.view = l.views[0];
          if (!locked) save();
        } };
        // the custom view's own view object is edited in place; a source page of a linked view keeps its own views
      } else {
        embed = { viewId, readOnly, save: locked ? async () => {} : null };
      }
      await renderDatabase(content, virtual ? runWs : ws, link, { onOpenRow: openRow, onOpenPage: (id) => ctx.openPage(id), embed });
      if (mine !== gen) return;
      content.classList.toggle("vb-ro", readOnly);
    } catch (e) {
      content.replaceChildren(message(e.message || "Could not show this view."));
    }
  }
  let timer = null;
  const stop = ctx.ws.onDataChange?.(() => {
    if (Date.now() - wrote < 1500) return; // this block's own edit
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!box.isConnected) return stop?.();
      if (box.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
      renderAll().catch(() => {});
    }, 300);
  });
  renderAll().catch((e) => content.replaceChildren(message(e.message)));
  return box;
}
