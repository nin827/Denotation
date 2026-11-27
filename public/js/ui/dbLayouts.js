import { summarize } from "../schema.js";
import {
  groupRows,
  isEmpty,
  canMoveBetween,
  rowsByDate,
  isoDate,
  shiftMonth,
  monthGrid
} from "../dbviews.js";
import { walk } from "../blocks/model.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { toast } from "./dialogs.js";
import { openMenu } from "./popover.js";

export function groupSections(a) {
  if (!a.view.groupBy || !a.db.columns.some((c) => c.id === a.view.groupBy)) return [{ label: null, value: void 0, rows: a.rows }];
  return groupRows(a.rows, a.db.columns, a.view.groupBy).map((g) => ({ ...g, label: g.label || "No value" }));
}
const MAX_PROPS = 3;
const propText = (col, v) => {
  if (col.type === "checkbox") return v ? col.name : null;
  if (col.type === "array" || col.type === "dictionary") return `${col.name}: ${summarize(col, v)}`;
  return `${col.name}: ${v}`;
};
function chips(a, row, skip) {
  const out = [];
  for (const col of a.cols.slice(1)) {
    if (col.id === skip) continue;
    const v = row.values?.[col.id];
    if (isEmpty(col, v) || col.type === "checkbox" && !v) continue;
    const t = propText(col, v);
    if (t) out.push(h("span", { class: "chip", title: t }, t));
    if (out.length >= MAX_PROPS) break;
  }
  return out;
}
const openBtn = (a, row, label = "Open") => h("button", { class: "icon", title: `${label} as page`, "aria-label": `${label} as page`, onClick: (e) => {
  e.stopPropagation();
  a.onOpenRow?.(row.id);
} }, ico("arrow-up-right"));
const delBtn = (a, row) => h("button", { class: "icon", title: "Delete row", "aria-label": "Delete row", onClick: async (e) => {
  e.stopPropagation();
  await a.removeRow(row);
  a.redraw();
} }, ico("x"));
function card(a, row, skip, extra = {}, moveTo = null) {
  return h(
    "div",
    { class: "card", tabindex: 0, role: "button", onClick: () => a.onOpenRow?.(row.id), onKeydown: (e) => {
      if (e.key === "Enter") a.onOpenRow?.(row.id);
    }, ...extra },
    h("div", { class: "card-title" }, a.title(row)),
    h("div", { class: "card-chips" }, chips(a, row, skip)),
    h("div", { class: "card-tools" }, moveTo?.length > 1 ? moveBtn(moveTo) : null, openBtn(a, row), delBtn(a, row))
  );
}
// Board cards drag between columns with a mouse; this is the tap alternative (touch has no HTML5 drag).
const moveBtn = (items) => h("button", { class: "icon", title: "Move to...", "aria-label": "Move card to another column", "aria-haspopup": "menu", onClick: (e) => {
  e.stopPropagation();
  openMenu(e.currentTarget, items);
} }, ico("arrow-right-left"));
let dragRow = null;
export function renderBoard(a) {
  const col = a.db.columns.find((c) => c.id === a.view.groupBy);
  if (!col) {
    return h(
      "div",
      { class: "view-hint" },
      h("p", {}, "A board needs a property to group cards by (for example a Select column)."),
      h("p", { class: "hint" }, "Use the Group button above to pick one.")
    );
  }
  const movable = canMoveBetween(col);
  const groups = groupRows(a.rows, a.db.columns, col.id);
  const move = (row, g) => {
    const value = g.value === void 0 ? void 0 : g.value ?? (col.type === "text" ? "" : null);
    if (value === void 0) return toast("Cards cannot be moved into that group.", "error");
    const r = a.setCell(row, col, value);
    if (!r.ok) toast(r.error, "error");
    else a.redraw();
  };
  return h("div", { class: "board" }, groups.map((g) => {
    const colEl = h("div", { class: "board-col" });
    if (movable) {
      colEl.addEventListener("dragover", (e) => {
        if (dragRow) {
          e.preventDefault();
          colEl.classList.add("drop");
        }
      });
      colEl.addEventListener("dragleave", (e) => {
        if (!colEl.contains(e.relatedTarget)) colEl.classList.remove("drop");
      });
      colEl.addEventListener("drop", (e) => {
        e.preventDefault();
        colEl.classList.remove("drop");
        const r = dragRow;
        dragRow = null;
        if (r) move(r, g);
      });
    }
    colEl.append(
      h(
        "div",
        { class: "board-head" },
        h("strong", {}, g.label || "No value"),
        h("span", { class: "hint" }, String(g.rows.length)),
        movable && g.value !== void 0 ? h("button", {
          class: "icon",
          title: "Add a card",
          "aria-label": "Add a card",
          onClick: async () => {
            await a.addRow({ [col.id]: g.value ?? (col.type === "text" ? "" : null) });
            a.redraw();
          }
        }, ico("plus")) : null
      ),
      h("div", { class: "board-cards" }, g.rows.map((row) => card(a, row, col.id, {
        draggable: movable ? "true" : null,
        onDragstart: (e) => {
          dragRow = row;
          e.dataTransfer.setData("text/plain", row.id);
          e.dataTransfer.effectAllowed = "move";
        },
        onDragend: () => {
          dragRow = null;
        }
      }, movable ? [{ header: true, label: "Move to" }, ...groups.filter((o) => o !== g && o.value !== void 0).map((o) => ({ label: o.label || "No value", onSelect: () => move(row, o) }))] : null)))
    );
    return colEl;
  }));
}
export function renderList(a) {
  const item = (row) => h(
    "li",
    { class: "list-item", tabindex: 0, onClick: () => a.onOpenRow?.(row.id), onKeydown: (e) => {
      if (e.key === "Enter") a.onOpenRow?.(row.id);
    } },
    h("span", { class: "li-title" }, a.title(row)),
    h("span", { class: "card-chips" }, chips(a, row)),
    openBtn(a, row),
    delBtn(a, row)
  );
  return h("div", { class: "db-list" }, groupSections(a).map((g) => h(
    "div",
    { class: "list-group" },
    g.label !== null ? h("div", { class: "group-head" }, h("strong", {}, g.label), h("span", { class: "hint" }, ` ${g.rows.length}`)) : null,
    h("ul", {}, g.rows.map(item))
  )));
}
export function renderGallery(a) {
  return h("div", { class: "db-gallery" }, groupSections(a).map((g) => h(
    "div",
    { class: "list-group" },
    g.label !== null ? h("div", { class: "group-head" }, h("strong", {}, g.label), h("span", { class: "hint" }, ` ${g.rows.length}`)) : null,
    h("div", { class: "gallery-grid" }, g.rows.map((row) => card(a, row, null, { class: "card gal-card" })))
  )));
}
const calState = new Map();
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function renderCalendar(a) {
  const col = a.db.columns.find((c) => c.id === a.view.dateCol && c.type === "date");
  if (!col) {
    return h(
      "div",
      { class: "view-hint" },
      h("p", {}, "A calendar needs a Date property."),
      h("p", { class: "hint" }, "Add a Date column (the + at the end of the table view), then pick it with the Date button above.")
    );
  }
  const now = new Date();
  const st = calState.get(a.db.id) ?? { year: now.getFullYear(), month: now.getMonth() };
  calState.set(a.db.id, st);
  const byDate = rowsByDate(a.rows, col.id);
  const today = isoDate(now.getFullYear(), now.getMonth(), now.getDate());
  const go = (d) => {
    Object.assign(st, shiftMonth(st.year, st.month, d));
    a.redraw();
  };
  const cell = (d) => h(
    "div",
    { class: `cal-day${d.inMonth ? "" : " out"}${d.iso === today ? " today" : ""}`, "data-date": d.iso },
    h(
      "div",
      { class: "cal-num" },
      h("span", {}, String(d.day)),
      h("button", { class: "icon cal-add", title: `Add a row on ${d.iso}`, "aria-label": `Add a row on ${d.iso}`, onClick: async () => {
        await a.addRow({ [col.id]: d.iso });
        a.redraw();
      } }, ico("plus"))
    ),
    (byDate.get(d.iso) || []).map((row) => h("button", { class: "cal-chip", title: a.title(row), onClick: () => a.onOpenRow?.(row.id) }, a.title(row)))
  );
  const unscheduled = a.rows.filter((r) => !isEmpty(col, r.values?.[col.id]) === false);
  return h(
    "div",
    { class: "cal" },
    h(
      "div",
      { class: "cal-head" },
      h("button", { class: "icon", title: "Previous month", "aria-label": "Previous month", onClick: () => go(-1) }, ico("chevron-left")),
      h("strong", { class: "cal-title" }, `${MONTHS[st.month]} ${st.year}`),
      h("button", { class: "icon", title: "Next month", "aria-label": "Next month", onClick: () => go(1) }, ico("chevron-right")),
      h("button", { onClick: () => {
        Object.assign(st, { year: now.getFullYear(), month: now.getMonth() });
        a.redraw();
      } }, "Today")
    ),
    h("div", { class: "cal-grid" }, DAYS.map((d) => h("div", { class: "cal-dow" }, d)), monthGrid(st.year, st.month).flat().map(cell)),
    unscheduled.length ? h(
      "div",
      { class: "cal-unsched" },
      h("span", { class: "hint" }, `No date (${unscheduled.length}): `),
      unscheduled.map((row) => h("button", { class: "cal-chip", onClick: () => a.onOpenRow?.(row.id) }, a.title(row)))
    ) : null
  );
}
const preview = (row, max = 320) => {
  const out = [];
  walk(row.blocks || [], (b) => {
    if (typeof b.text === "string" && b.text.trim()) out.push(b.text.trim());
  });
  const t = out.join("\n");
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
};
const when = (row) => new Date(row.createdAt).toLocaleString(void 0, { dateStyle: "medium", timeStyle: "short" });
export function renderFeed(a) {
  const post = (row) => {
    const text = preview(row);
    return h(
      "article",
      { class: "post", tabindex: 0, onClick: () => a.onOpenRow?.(row.id), onKeydown: (e) => {
        if (e.key === "Enter") a.onOpenRow?.(row.id);
      } },
      h("header", {}, h("h3", {}, a.title(row)), h("time", { class: "hint" }, when(row)), openBtn(a, row), delBtn(a, row)),
      h("div", { class: "card-chips" }, chips(a, row)),
      text ? h("p", { class: "post-text" }, text) : h("p", { class: "hint" }, "No content yet. Open it to write.")
    );
  };
  const newest = (rows) => rows.slice().sort((x, y) => y.createdAt - x.createdAt);
  return h("div", { class: "feed" }, groupSections(a).map((g) => h(
    "div",
    { class: "list-group" },
    g.label !== null ? h("div", { class: "group-head" }, h("strong", {}, g.label), h("span", { class: "hint" }, ` ${g.rows.length}`)) : null,
    newest(g.rows).map(post)
  )));
}
