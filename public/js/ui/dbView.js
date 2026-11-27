import { applyFormulas, formatResult, isErrorValue, renameColumnRefs } from "../formula.js";
import { validate, describe, typeLabel } from "../schema.js";
import {
  ensureViews,
  visibleRows,
  isNumeric,
  CHART_TYPES,
  CHART_AGGS,
  newView,
  VIEW_TYPES,
  typeInfo,
  colWidth
} from "../dbviews.js";
import { databaseToCsv } from "../csv.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { openModal } from "./modal.js";
import { renderCell } from "./cellEditors.js";
import { toast, confirmDialog } from "./dialogs.js";
import { openColumnEditor } from "./columnEditor.js";
import { openDbOptions } from "./dbOptions.js";
import {
  groupSections,
  renderBoard,
  renderList,
  renderGallery,
  renderCalendar,
  renderFeed
} from "./dbLayouts.js";
import { renderChart, renderDashboard } from "./dbCharts.js";
import {
  openLayoutMenu,
  tableWidth,
  frozenClass,
  cellStyle,
  resizeHandle,
  wrapClass,
  displayClass,
  displayItems,
  openWidthDialog
} from "./dbCols.js";
import { resolveDisplay, orderColumns, gridColumns, cleanGroups, headerRows, toggleCollapsed } from "../columns.js";
import { groupMenuItems, columnGroupItems, openColumnsJson, groupHeaderCell } from "./dbGroups.js";
import { renderSheet } from "./dbSheet.js";
import { pickCsv } from "./csvFile.js";
import { saveTextFile } from "./files.js";
import { bindContextMenu } from "./contextMenu.js";
import { bindRowMenu } from "./dbMenus.js";
import { sortOnly, sortDir, clearSort, hideColumn } from "../dbMenuLogic.js";
import { windowedRows } from "./bigLists.js";

const activeView = new Map();
/**
 * Renders a database view (toolbar + layout) into `root`. `link` holds the views (a database page, a linked view, or a
 * pseudo page `{ id, title, sourceId, views }` for a view block); rows and columns come from `link.sourceId`'s page.
 * `embed` (view blocks, ui/viewBlock.js) = { viewId, save, readOnly }:
 *   viewId   show exactly this view of `link` (no tabs), else the usual tabs
 *   save     async (link) => ..., stores the views instead of ws.savePage(link) (a custom view lives in the block)
 *   readOnly rows, columns and views of a virtual table source cannot be edited
 */
export async function renderDatabase(root, ws, link, { onOpenRow: openRow, onOpenPage, embed = null, frozen = false } = {}) {
  // frozen: an archived or trashed database page, shown read-only (rows can still be opened)
  const readOnly = !!embed?.readOnly || frozen;
  const onOpenRow = embed?.readOnly ? null : openRow;
  const src = link.sourceId ? await ws.getPage(link.sourceId) : null;
  if (link.sourceId && (!src || src.trashedAt)) {
    root.replaceChildren(h("p", { class: "hint" }, src ? "The source database of this linked view is in the trash. Restore it to see the data." : "The source database of this linked view no longer exists."));
    return;
  }
  const data = src ?? link;
  const db = Object.create(null);
  Object.defineProperties(db, {
    id: { get: () => link.id },
    title: { get: () => link.title },
    columns: { get: () => data.columns, set: (v) => {
      data.columns = v;
    }, enumerable: true },
    views: { get: () => link.views, set: (v) => {
      link.views = v;
    }, enumerable: true },
    columnGroups: { get: () => data.columnGroups || [], set: (v) => {
      if (v && v.length) data.columnGroups = v;
      else delete data.columnGroups;
    }, enumerable: true }
  });
  let rows = await ws.listRows(data.id);
  const rowPages = data.rowPages !== false;
  const openLabel = rowPages ? "Open as page" : "Open properties";
  // row templates of this database ("New row from template")
  const rowTemplates = readOnly || !ws.listTemplates ? [] : await ws.listTemplates({ forDb: data.id });
  ensureViews(db);
  const bar = h("div", { class: "db-toolbar" });
  const body = h("div", { class: "db-wrap" });
  const current = () => db.views.find((v) => v.id === (embed?.viewId ?? activeView.get(db.id))) ?? db.views[0];
  const saveViews = () => embed?.save ? embed.save(link) : readOnly ? Promise.resolve() : ws.savePage(link);
  const noWrite = () => ({ ok: false, error: "This table is a read-only data source. Edit the table block itself." });
  const reload = async () => {
    rows = await ws.listRows(data.id);
    settle();
    draw();
  };
  const queue = new Map();
  const saveRow = (row) => {
    const prev = queue.get(row.id) ?? Promise.resolve();
    const next = prev.catch(() => {
    }).then(() => ws.saveRow(row));
    queue.set(row.id, next);
    next.then(() => queue.get(row.id) === next && queue.delete(row.id), () => queue.get(row.id) === next && queue.delete(row.id));
    return next;
  };
  const settle = () => {
    for (const r of applyFormulas(db.columns, rows)) saveRow(r).catch(() => {
    });
    const els = root.querySelectorAll("[data-frow]");
    if (!els.length) return;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const el of els) {
      const row = byId.get(el.dataset.frow);
      const v = row?.values?.[el.dataset.fcol];
      el.textContent = formatResult(v);
      el.classList.toggle("f-err", isErrorValue(v));
      el.classList.toggle("num", typeof v === "number");
    }
  };
  settle();
  const editColumn = (col) => readOnly ? null : openColumnEditor({
    column: col,
    columns: db.columns,
    rows,
    onSave: async (next) => {
      let columns = col ? db.columns.map((c) => c.id === col.id ? next : c) : [...db.columns, next];
      if (col && col.name !== next.name) {
        columns = columns.map((c) => c.type === "formula" && c.id !== next.id ? { ...c, config: { ...c.config, expr: renameColumnRefs(c.config?.expr, col.name, next.name) } } : c);
      }
      db.columnGroups = cleanGroups(columns, db.columnGroups);
      await ws.updateColumns(data, columns);
      ensureViews(db);
      await reload();
    },
    onDelete: col && db.columns.length > 1 ? async () => {
      const left = db.columns.filter((c) => c.id !== col.id);
      db.columnGroups = cleanGroups(left, db.columnGroups);
      await ws.updateColumns(data, left);
      ensureViews(db);
      await saveViews();
      await reload();
    } : null
  });
  /** Saves column groups (cleaned) and the column order they imply. Values are untouched. */
  const saveGroups = async (groups) => {
    db.columnGroups = cleanGroups(db.columns, groups);
    data.columns = orderColumns(db.columns, db.columnGroups);
    ensureViews(db);
    await ws.savePage(data);
    if (data !== link) await saveViews();
    draw();
  };
  const api = () => {
    const view = current();
    const ordered = orderColumns(db.columns, db.columnGroups);
    const shown = ordered.filter((c, i) => c.id === db.columns[0].id || !view.hidden.includes(c.id));
    const grid = ["table", "sheet"].includes(view.type) ? gridColumns(shown, db.columnGroups, view) : shown;
    return {
      ws: ws,
      locked: !!link.locked || readOnly,
      readOnly,
      db,
      view: view,
      saveView: saveViews,
      settle,
      allRows: rows,
      rows: visibleRows(db, view, rows),
      cols: grid,
      realCols: shown,
      groups: db.columnGroups,
      saveGroups,
      groupMenu: (g) => groupMenuItems(api(), g),
      toggleGroup: async (gid) => {
        toggleCollapsed(view, gid);
        await saveViews();
        draw();
      },
      displayOf: (col) => resolveDisplay(view, col),
      editColumnsJson: link.locked || readOnly ? null : () => editColumnsJson(),
      onOpenRow,
      editColumn,
      columnMenu,
      saveRow,
      redraw: () => draw(),
      reload,
      title: (row) => String(row.values?.[db.columns[0].id] ?? "") || "Untitled",
      async addRow(patch = {}) {
        if (readOnly) throw new Error(noWrite().error);
        const row = await ws.createRow(data, patch);
        rows.push(row);
        settle();
        return row;
      },
      async removeRow(row) {
        if (readOnly) return;
        await ws.deleteRow(row.id);
        rows = rows.filter((r) => r.id !== row.id);
        settle();
      },
      /** Validates a raw input for one cell and saves it. Returns { ok, error }.
       *  `defer` skips the save and the formula pass: the caller then hands every touched row to commitRows once. */
      setCell(row, col, raw, { defer = false } = {}) {
        if (readOnly) return noWrite();
        const r = validate(col, raw);
        if (!r.ok) return r;
        row.values[col.id] = r.value;
        if (!defer) {
          saveRow(row).catch((e) => toast(e.message, "error"));
          settle();
        }
        return r;
      },
      /** Saves each distinct row once and recomputes formulas once (after a batch of deferred setCell calls). */
      commitRows(list) {
        const uniq = [...new Set(list)];
        if (uniq.length > 1 && ws.saveRows) {
          // One batched save, queued behind each row's pending save and ahead of later ones (same order as saveRow).
          const next = Promise.all(uniq.map((r) => (queue.get(r.id) ?? Promise.resolve()).catch(() => {}))).then(() => ws.saveRows(uniq));
          const done = () => uniq.forEach((r) => queue.get(r.id) === next && queue.delete(r.id));
          uniq.forEach((r) => queue.set(r.id, next));
          next.then(done, done);
          next.catch((e) => toast(e.message, "error"));
        } else for (const row of uniq) saveRow(row).catch((e) => toast(e.message, "error"));
        settle();
      }
    };
  };
  function chartMenu(view) {
    const c = view.chart ?? (view.chart = { type: "bar", x: null, agg: "count", y: null });
    const set = (patch) => async () => {
      Object.assign(c, patch);
      await saveViews();
      draw();
    };
    const nums = db.columns.filter(isNumeric);
    const mark = (on) => ico(on ? "check" : "minus");
    return [
      { label: "Chart type", icon: ico("chart-pie"), items: CHART_TYPES.map((t) => ({ label: t.label, icon: mark(c.type === t.id), onSelect: set({ type: t.id }) })) },
      { label: "X axis (group by)", icon: ico("group"), items: db.columns.filter((col) => ["select", "checkbox", "text", "date", "number"].includes(col.type)).map((col) => ({ label: col.name, icon: mark(c.x === col.id), onSelect: set({ x: col.id }) })) },
      { label: "Value", icon: ico("sigma"), items: [
        { label: "Row count", icon: mark(c.agg === "count"), onSelect: set({ agg: "count", y: null }) },
        ...nums.flatMap((col) => CHART_AGGS.filter((g) => g.id !== "count").map((g) => ({ label: `${g.label} of ${col.name}`, icon: mark(c.agg === g.id && c.y === col.id), onSelect: set({ agg: g.id, y: col.id }) })))
      ] }
    ];
  }
  function renameView(v) {
    const input = h("input", { type: "text", value: v.name, maxlength: 40 });
    openModal({
      title: "Rename view",
      content: h("label", {}, "Name", input),
      actions: [{ label: "Cancel" }, { label: "Save", class: "primary", run: async () => {
        v.name = input.value.trim() || v.name;
        await saveViews();
        draw();
      } }]
    });
    input.focus();
  }
  function viewMenu(anchor, v, { layout = false } = {}) {
    openMenu(anchor, [
      ...layout && ["table", "sheet"].includes(v.type) ? [{ label: "Layout settings", icon: ico("move-horizontal"), onSelect: () => openLayoutMenu(anchor, api()) }] : [],
      { label: "Rename", icon: ico("pencil"), onSelect: () => renameView(v) },
      { label: "Duplicate", icon: ico("copy"), onSelect: async () => {
        const c = { ...JSON.parse(JSON.stringify(v)), id: newView("table", db).id, name: `${v.name} copy` };
        db.views.push(c);
        activeView.set(db.id, c.id);
        await saveViews();
        draw();
      } },
      ...VIEW_TYPES.filter((t) => t.id !== v.type).map((t) => ({ label: `Show as ${t.label.toLowerCase()}`, icon: ico(t.icon), onSelect: async () => {
        v.type = t.id;
        const fresh = newView(t.id, db);
        if (t.id === "board" && !v.groupBy) v.groupBy = fresh.groupBy;
        if (t.id === "calendar" && !v.dateCol) v.dateCol = fresh.dateCol;
        await saveViews();
        draw();
      } })),
      ...db.views.length > 1 ? [{ label: "Delete view", icon: ico("trash"), danger: true, onSelect: async () => {
        if (!await confirmDialog(`Delete the view "${v.name}"? Your rows are not affected.`, { title: "Delete view" })) return;
        db.views = db.views.filter((x) => x.id !== v.id);
        activeView.set(db.id, db.views[0].id);
        await saveViews();
        draw();
      } }] : []
    ], { width: 220 });
  }
  function columnMenu(col) {
    const view = current();
    const dir = sortDir(view, col.id);
    const change = (fn) => async () => {
      fn();
      await saveViews();
      draw();
    };
    if (col.stub) {
      const g = db.columnGroups.find((x) => x.id === col.groupId);
      return g ? groupMenuItems(api(), g) : [];
    }
    return [
      readOnly ? null : { label: "Edit column\u2026", icon: ico("pencil"), onSelect: () => editColumn(col) },
      { label: "Display in this view", icon: ico("eye"), items: displayItems(api(), col) },
      ["table", "sheet"].includes(view.type) ? { label: "Column width\u2026", icon: ico("move-horizontal"), onSelect: () => openWidthDialog(api(), col) } : null,
      ...readOnly ? [] : columnGroupItems(api(), col),
      { separator: true },
      { label: "Sort ascending", icon: ico("arrow-up"), hint: dir === "asc" ? "on" : null, onSelect: change(() => sortOnly(view, col.id, "asc")) },
      { label: "Sort descending", icon: ico("arrow-down"), hint: dir === "desc" ? "on" : null, onSelect: change(() => sortOnly(view, col.id, "desc")) },
      dir ? { label: "Clear sort", icon: ico("x"), onSelect: change(() => clearSort(view, col.id)) } : null,
      db.columns[0].id !== col.id ? { label: "Hide in this view", icon: ico("eye-off"), onSelect: change(() => hideColumn(view, db.columns, col.id)) } : null,
      readOnly ? null : { separator: true },
      readOnly ? null : { label: "Add column\u2026", icon: ico("plus"), onSelect: () => editColumn(null) },
      readOnly ? null : { label: "Edit columns as JSON\u2026", icon: ico("braces"), disabled: !!link.locked, onSelect: () => editColumnsJson() }
    ].filter(Boolean);
  }
  function editColumnsJson() {
    openColumnsJson({
      columns: db.columns,
      groups: db.columnGroups,
      onSave: async ({ columns, columnGroups }) => {
        const before = new Map(db.columns.map((c) => [c.id, c]));
        let next = columns;
        for (const c of columns) {
          const old = before.get(c.id);
          if (old && old.name !== c.name) next = next.map((x) => x.type === "formula" && x.id !== c.id ? { ...x, config: { ...x.config, expr: renameColumnRefs(x.config?.expr, old.name, c.name) } } : x);
        }
        db.columnGroups = columnGroups;
        await ws.updateColumns(data, next);
        ensureViews(db);
        await saveViews();
        await reload();
      }
    });
  }
  function drawBar() {
    const view = current();
    const filterN = view.filter.rules.length;
    const badge = (n) => n ? h("span", { class: "badge" }, String(n)) : null;
    const group = db.columns.find((c) => c.id === view.groupBy);
    bar.replaceChildren(...[
      embed ? null : h(
        "div",
        { class: "view-tabs", role: "toolbar", "aria-label": "Views" },
        db.views.map((v) => {
          const on = v.id === view.id;
          const tab = h(
            "div",
            { class: `view-tab${on ? " on" : ""}` },
            h("button", { class: "vt-main", "aria-pressed": String(on), onClick: () => {
              activeView.set(db.id, v.id);
              draw();
            } }, ico(typeInfo(v.type).icon), h("span", {}, v.name)),
            on ? h("button", { class: "icon vt-menu", title: "View options", "aria-label": `Options for view ${v.name}`, "aria-haspopup": "menu", onClick: (e) => viewMenu(e.currentTarget, v) }, ico("chevron-down")) : null
          );
          tab.addEventListener("contextmenu", (e) => {
            if (e.defaultPrevented) return;
            e.preventDefault();
            viewMenu({ x: e.clientX, y: e.clientY }, v, { layout: on });
          });
          return tab;
        }),
        h("button", {
          class: "icon add-view",
          title: "Add a view",
          "aria-label": "Add a view",
          onClick: (e) => openMenu(e.currentTarget, VIEW_TYPES.map((t) => ({
            label: t.label,
            icon: ico(t.icon),
            onSelect: async () => {
              const v = newView(t.id, db, db.views.some((x) => x.name === t.label) ? `${t.label} ${db.views.length + 1}` : t.label);
              db.views.push(v);
              activeView.set(db.id, v.id);
              await saveViews();
              draw();
            }
          })), { width: 190 })
        }, ico("plus"))
      ),
      h(
        "div",
        { class: "db-tools" },
        h("button", { class: "tool-filter", onClick: () => openDbOptions("filter", api(), { onDone: async () => {
          await saveViews();
          draw();
        }, redraw: drawBody }) }, ico("funnel"), " Filter", badge(filterN)),
        h("button", { class: "tool-sort", onClick: () => openDbOptions("sort", api(), { onDone: async () => {
          await saveViews();
          draw();
        }, redraw: drawBody }) }, ico("arrow-up-down"), " Sort", badge(view.sorts.length)),
        !["calendar", "sheet", "chart", "dashboard"].includes(view.type) ? h("button", {
          class: "tool-group",
          onClick: (e) => openMenu(e.currentTarget, [
            { label: "No grouping", icon: ico(view.groupBy ? "x" : "check"), onSelect: async () => {
              view.groupBy = null;
              await saveViews();
              draw();
            } },
            ...db.columns.map((c) => ({ label: c.name, icon: ico(view.groupBy === c.id ? "check" : "group"), onSelect: async () => {
              view.groupBy = c.id;
              await saveViews();
              draw();
            } }))
          ], { width: 200 })
        }, ico("group"), ` Group${group ? `: ${group.name}` : ""}`) : null,
        view.type === "chart" ? h("button", { class: "tool-chart", onClick: (e) => openMenu(e.currentTarget, chartMenu(view)) }, ico("chart-column"), " Chart") : null,
        view.type === "calendar" ? h("button", {
          class: "tool-datecol",
          onClick: (e) => openMenu(e.currentTarget, db.columns.filter((c) => c.type === "date").map((c) => ({
            label: c.name,
            icon: ico(view.dateCol === c.id ? "check" : "calendar"),
            onSelect: async () => {
              view.dateCol = c.id;
              await saveViews();
              draw();
            }
          })), { width: 200, empty: "Add a date column first" })
        }, ico("calendar"), ` Date: ${db.columns.find((c) => c.id === view.dateCol)?.name ?? "none"}`) : null,
        ["table", "sheet"].includes(view.type) ? h("button", { class: "tool-layout", onClick: (e) => openLayoutMenu(e.currentTarget, api()) }, ico("move-horizontal"), " Layout") : null,
        h("button", { class: "tool-props", onClick: () => openDbOptions("props", api(), { onDone: async () => {
          await saveViews();
          draw();
        }, redraw: drawBody }) }, ico("sliders-horizontal"), " Properties", badge(view.hidden.length)),
        h("button", { class: "tool-csv", onClick: (e) => openMenu(e.currentTarget, csvMenu(), { width: 230 }) }, ico("file-spreadsheet"), " CSV"),
        readOnly ? null : h("button", { class: "primary add-row-top", onClick: async () => {
          await api().addRow();
          draw();
        } }, ico("plus"), " New row"),
        readOnly || !rowTemplates.length ? null : h("button", {
          class: "add-row-tpl",
          title: "New row from template",
          "aria-label": "New row from template",
          "aria-haspopup": "menu",
          onClick: (e) => openMenu(e.currentTarget, rowTemplates.map((t) => ({ label: t.title || "Untitled", icon: ico("layout-template"), onSelect: async () => {
            const row = await ws.createRowFromTemplate(data, t.id);
            rows.push(row);
            settle();
            draw();
            toast(`Row added from "${t.title || "Untitled"}"`);
          } })), { width: 220 })
        }, ico("layout-template"), h("span", { class: "tpl-label" }, " From template"))
      )
    ].filter(Boolean));
  }
  function csvMenu() {
    return [
      { label: "Export this view as CSV", icon: ico("download"), onSelect: async () => {
        const a = api();
        const text = `\uFEFF${databaseToCsv(a.realCols, a.rows)}`;
        try {
          const how = await saveTextFile(`${(link.title || "database").replace(/[\\/:*?"<>|]+/g, "-")}.csv`, text, "text/csv;charset=utf-8");
          toast(how === "copied" ? "CSV copied to the clipboard." : `Exported ${a.rows.length} row${a.rows.length === 1 ? "" : "s"}.`);
        } catch (e) {
          if (e.code !== "declined") toast(e.message, "error");
        }
      } },
      { label: "Import rows from CSV\u2026", icon: ico("upload"), disabled: link.locked || readOnly, onSelect: async () => {
        const file = await pickCsv();
        if (!file) return;
        try {
          const made = await ws.appendCsv(data, file.text);
          rows.push(...made);
          settle();
          draw();
          toast(`Imported ${made.length} row${made.length === 1 ? "" : "s"}.`);
        } catch (e) {
          toast(e.message, "error");
        }
      } }
    ];
  }
  function tableLayout(a) {
    const ACTIONS = 56;
    const cg = a.cols.map(() => h("col"));
    cg.forEach((c, i) => {
      c.style.width = `${colWidth(a.view, a.cols[i])}px`;
    });
    const table = h("table", { class: "db-table fixed", style: `width:${tableWidth(a, ACTIONS)}px` });
    const groupRows = headerRows(a.cols, a.groups).map((cells, level) => h(
      "tr",
      { class: `grp-row lvl-${level}` },
      cells.map((c) => groupHeaderCell(a, c, level)),
      h("th", { class: "grp-blank", "aria-hidden": "true" })
    ));
    const head = h(
      "tr",
      {},
      a.cols.map((col, i) => bindContextMenu(col.stub ? h(
        "th",
        { class: `col-head stub-head${frozenClass(a, i)}`, style: cellStyle(a, col, i), title: `${col.name}: collapsed group, click to expand` },
        h("button", { class: "stub-btn", "aria-expanded": "false", onClick: () => a.toggleGroup(col.groupId) }, ico("chevrons-left-right"), h("span", {}, col.name))
      ) : h(
        "th",
        { class: `col-head${frozenClass(a, i)}${displayClass(a, col)}`, style: cellStyle(a, col, i), title: describe(col), tabindex: 0, onClick: () => editColumn(col), onKeydown: (e) => {
          if (e.key === "Enter" && e.target === e.currentTarget) editColumn(col);
        } },
        h("span", { class: "th-name" }, col.name),
        h("small", { class: "type-tag" }, typeLabel(col)),
        resizeHandle(a, col, { colEl: cg[i], tableEl: table, extra: ACTIONS })
      ), () => columnMenu(col))),
      readOnly ? h("th", { class: "add-col ro", "aria-hidden": "true" }) : h("th", { class: "add-col", title: "Add column", "aria-label": "Add column", onClick: () => editColumn(null) }, ico("plus"))
    );
    const rowEl = (row) => bindRowMenu(h(
      "tr",
      {},
      a.cols.map((col, i) => h(
        "td",
        { class: `${frozenClass(a, i)}${wrapClass(a, col)}${displayClass(a, col)}`.trim(), style: cellStyle(a, col, i) },
        col.stub ? h("button", { class: "stub-cell", tabindex: -1, title: `${col.name}: click to expand`, "aria-label": `Expand ${col.name}`, onClick: () => a.toggleGroup(col.groupId) }) : renderCell(col, row.values[col.id], (v) => {
          row.values[col.id] = v;
          settle();
          saveRow(row).catch((e) => toast(e.message, "error"));
        }, { display: a.displayOf(col), rowId: row.id, readOnly })
      )),
      readOnly ? h("td", { class: "row-actions" }) : h(
        "td",
        { class: "row-actions" },
        h("button", { class: "icon row-open", title: openLabel, "aria-label": openLabel, onClick: () => onOpenRow?.(row.id) }, ico(rowPages ? "arrow-up-right" : "panel-right-open")),
        h("button", { class: "icon", title: "Delete row", "aria-label": "Delete row", onClick: async () => {
          await a.removeRow(row);
          draw();
        } }, ico("x"))
      )
    ), a, row);
    const sections = groupSections(a);
    // one flat list of group header rows and data rows, so a long table can draw only the rows near the viewport
    const items = sections.flatMap((g) => [
      g.label !== null ? { group: g } : null,
      ...g.rows.map((row) => ({ row }))
    ]).filter(Boolean);
    const tbody = h("tbody");
    windowedRows(tbody, {
      count: items.length,
      colSpan: a.cols.length + 1,
      kind: (i) => items[i].group ? 1 : 0,
      render: (i) => {
        const it = items[i];
        return it.group ? h("tr", { class: "group-row" }, h("td", { colspan: a.cols.length + 1 }, h("strong", {}, it.group.label), h("span", { class: "hint" }, ` ${it.group.rows.length}`))) : rowEl(it.row);
      }
    });
    table.append(h("colgroup", {}, cg, h("col", { style: `width:${ACTIONS}px` })), h("thead", {}, groupRows, head), tbody);
    return h("div", { class: "tbl-scroll" }, table);
  }
  function drawBody() {
    const a = api();
    let content;
    switch (a.view.type) {
      case "board":
        content = renderBoard(a);
        break;
      case "list":
        content = renderList(a);
        break;
      case "gallery":
        content = renderGallery(a);
        break;
      case "calendar":
        content = renderCalendar(a);
        break;
      case "sheet":
        content = renderSheet(a);
        break;
      case "feed":
        content = renderFeed(a);
        break;
      case "chart":
        content = renderChart(a);
        break;
      case "dashboard":
        content = renderDashboard(a);
        break;
      default:
        content = tableLayout(a);
    }
    const empty = !a.rows.length && a.allRows.length ? h("p", { class: "hint" }, "No rows match this view's filter.") : null;
    body.classList.toggle("ro", readOnly);
    body.replaceChildren(...[
      content,
      empty,
      a.view.type === "table" && !readOnly ? h("button", { class: "add-row", onClick: async () => {
        await a.addRow();
        draw();
      } }, ico("plus"), " New row") : null
    ].filter(Boolean));
  }
  function draw() {
    drawBar();
    drawBody();
  }
  draw();
  if (embed) body.dataset.vscroll = "";
  root.replaceChildren(...embed ? [bar, body] : [
    src ? h(
      "p",
      { class: "hint linked-note" },
      ico("link-2"),
      ` Linked view of `,
      h("a", { href: `#page-${src.id}`, class: "linked-src", onClick: (e) => {
        e.preventDefault();
        onOpenPage?.(src.id);
      } }, src.title || "Untitled"),
      ". Rows and columns are shared with the source; filters, sorts and layout are yours."
    ) : h("p", { class: "hint" }, "Click a column header to change its type or settings."),
    bar,
    body
  ]);
}
