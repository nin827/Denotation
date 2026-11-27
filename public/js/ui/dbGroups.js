// Column groups UI (ticket 011) and "Edit columns as JSON" (ticket 010). Logic lives in ../columns.js.
import {
  makeGroup, addToGroup, removeFromGroup, ungroup, renameGroup, collapsedSet, groupIndex, cleanGroups,
  columnsToJson, parseColumnsJson, columnsDiff
} from "../columns.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { openModal } from "./modal.js";
import { confirmDialog } from "./dialogs.js";
import { bindContextMenu } from "./contextMenu.js";

const allCols = (a) => a.db.columns;

/** One cell of a group label row: a button that opens the group's menu (click, right-click, long-press, Shift+F10). */
export function groupHeaderCell(a, cell, level, { extraClass = "" } = {}) {
  if (!cell.group) return h("th", { class: `grp-cell empty${extraClass}`, colspan: cell.span, "aria-hidden": "true" });
  const g = cell.group;
  const shut = collapsedSet(a.view).has(g.id);
  const btn = h("button", {
    class: "grp-label",
    "aria-haspopup": "menu",
    title: `${g.label}: group menu`,
    onClick: (e) => openMenu(e.currentTarget, groupMenuItems(a, g), { width: 230 })
  }, h("span", { class: "grp-text" }, g.label), shut ? h("span", { class: "sr-only" }, " (collapsed)") : null, ico("chevron-down"));
  const th = h("th", { class: `grp-cell lvl-${level}${shut ? " shut" : ""}${extraClass}`, colspan: cell.span, scope: "colgroup" }, btn);
  return bindContextMenu(th, () => groupMenuItems(a, g), { width: 230 });
}

/** Menu of a group label: rename, columns, collapse / expand, subgroup, ungroup. */
export function groupMenuItems(a, g) {
  const shut = collapsedSet(a.view).has(g.id);
  const locked = !!a.locked;
  return [
    { header: true, label: g.label },
    { label: shut ? "Expand" : "Collapse", icon: ico(shut ? "unfold-horizontal" : "fold-horizontal"), hint: "this view", onSelect: () => a.toggleGroup(g.id) },
    { label: "Rename…", icon: ico("pencil"), disabled: locked, onSelect: () => renameDialog(a, g) },
    { label: "Add or remove columns…", icon: ico("columns-3"), disabled: locked, onSelect: () => openGroupDialog(a, { group: g }) },
    !g.parentId ? { label: "New subgroup…", icon: ico("folder-plus"), disabled: locked, onSelect: () => openGroupDialog(a, { parentId: g.id }) } : null,
    { separator: true },
    { label: g.parentId ? "Remove subgroup" : "Ungroup", icon: ico("ungroup"), disabled: locked, onSelect: () => a.saveGroups(ungroup(a.groups, g.id)) }
  ].filter(Boolean);
}

/** Column header menu entries about groups. */
export function columnGroupItems(a, col) {
  if (a.locked) return [];
  const { ofCol } = groupIndex(cleanGroups(allCols(a), a.groups));
  const at = ofCol.get(col.id);
  const mine = at ? at.sub ?? at.top : null;
  const others = (a.groups || []).filter((g) => g !== mine && g.id !== mine?.id);
  return [
    { label: "Group with…", icon: ico("group"), onSelect: () => openGroupDialog(a, { preselect: [col.id] }) },
    others.length ? { label: "Move to group", icon: ico("folder"), items: others.map((g) => ({ label: g.parentId ? `${(a.groups.find((p) => p.id === g.parentId)?.label ?? "")} › ${g.label}` : g.label, onSelect: () => a.saveGroups(addToGroup(a.groups, g.id, [col.id])) })) } : null,
    mine ? { label: `Remove from “${mine.label}”`, icon: ico("folder-minus"), onSelect: () => a.saveGroups(removeFromGroup(a.groups, [col.id])) } : null
  ].filter(Boolean);
}

function renameDialog(a, g) {
  const input = h("input", { type: "text", value: g.label, maxlength: 60 });
  openModal({
    title: "Rename group",
    content: h("label", {}, "Label", input),
    actions: [{ label: "Cancel" }, { label: "Save", class: "primary", run: async () => {
      if (!input.value.trim()) throw new Error("A group needs a label.");
      await a.saveGroups(renameGroup(a.groups, g.id, input.value));
    } }]
  });
  input.focus();
  input.select();
}

/**
 * Make a group (optionally inside a top-level `parentId`), or change an existing group's columns.
 * Columns already in another group move into this one.
 */
export function openGroupDialog(a, { group = null, preselect = [], parentId = null } = {}) {
  const parent = parentId ? a.groups.find((g) => g.id === parentId) : group?.parentId ? a.groups.find((g) => g.id === group.parentId) : null;
  const gs = cleanGroups(allCols(a), a.groups);
  const { ofCol } = groupIndex(gs);
  // a subgroup picks from its parent's columns; anything else from all columns
  const pool = parent ? allCols(a).filter((c) => ofCol.get(c.id)?.top.id === parent.id) : allCols(a);
  const inGroup = new Set(group ? group.colIds : preselect);
  const label = h("input", { type: "text", value: group?.label ?? "", placeholder: parent ? "Subgroup label" : "Group label", maxlength: 60 });
  const where = (c) => {
    const at = ofCol.get(c.id);
    const g = at ? at.sub ?? at.top : null;
    return g && g.id !== group?.id ? ` (in ${g.label})` : "";
  };
  const boxes = pool.map((c) => {
    const box = h("input", { type: "checkbox", checked: inGroup.has(c.id), value: c.id });
    return h("label", { class: "opt-check" }, box, ` ${c.name}`, h("span", { class: "hint" }, where(c)));
  });
  openModal({
    title: group ? `Columns of “${group.label}”` : parent ? `New subgroup in “${parent.label}”` : "Group columns",
    content: h(
      "div",
      { class: "grp-dialog" },
      group ? null : h("label", {}, "Label", label),
      h("p", { class: "hint" }, parent ? "Pick columns of the parent group." : "Grouped columns sit side by side under the label."),
      pool.length ? h("div", { class: "opt-list grp-pick", role: "group", "aria-label": "Columns" }, boxes) : h("p", { class: "hint" }, "The parent group has no columns of its own to move into a subgroup.")
    ),
    actions: [{ label: "Cancel" }, { label: group ? "Save" : "Create group", class: "primary", run: async () => {
      const picked = boxes.map((b) => b.querySelector("input")).filter((i) => i.checked).map((i) => i.value);
      const ordered = allCols(a).map((c) => c.id).filter((id) => picked.includes(id));
      if (group) {
        if (!ordered.length && !a.groups.some((g) => g.parentId === group.id)) throw new Error("Pick at least one column, or use Ungroup.");
        const kept = removeFromGroup(a.groups, group.colIds.filter((id) => !ordered.includes(id)));
        await a.saveGroups(addToGroup(kept, group.id, ordered));
        return;
      }
      if (!label.value.trim()) throw new Error("A group needs a label.");
      if (!ordered.length) throw new Error("Pick at least one column.");
      // a subgroup takes its columns out of the parent's direct list; makeGroup moves them
      const { groups } = makeGroup(a.groups, label.value, ordered, parent?.id ?? null);
      await a.saveGroups(groups);
    } }]
  });
  if (!group) label.focus();
}

/** "Edit columns as JSON": the whole column setup, validated on save; ids are kept so row values survive. */
export function openColumnsJson({ columns, groups, onSave }) {
  const area = h("textarea", { class: "je-raw cols-json", rows: 18, spellcheck: false, "aria-label": "Columns as JSON", value: columnsToJson(columns, groups) });
  const status = h("p", { class: "je-raw-err", role: "status" });
  const check = () => {
    const r = parseColumnsJson(area.value);
    status.replaceChildren(r.ok ? h("span", { class: "je-ok" }, ico("circle-check"), ` ${r.columns.length} column${r.columns.length === 1 ? "" : "s"}, ${r.columnGroups.length} group${r.columnGroups.length === 1 ? "" : "s"}`) : h("span", { class: "je-flag" }, ico("triangle-exclamation-point"), ` ${r.error}`));
    return r;
  };
  let t = 0;
  area.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(check, 250);
  });
  check();
  openModal({
    title: "Columns as JSON",
    content: h(
      "div",
      { class: "cols-json-box" },
      h("p", { class: "hint" }, "Each column: id (keep it so values survive), name, type, and config, typeText (json columns) or display. Groups: id, label, colIds, parentId (two levels at most)."),
      area,
      status
    ),
    actions: [{ label: "Cancel" }, { label: "Save", class: "primary", run: async () => {
      const r = check();
      if (!r.ok) throw new Error(r.error);
      const d = columnsDiff(columns, r.columns);
      if (d.removed.length) {
        const ok = await confirmDialog(`This removes ${d.removed.map((c) => `“${c.name}”`).join(", ")} and the values in ${d.removed.length === 1 ? "it" : "them"}.`, { title: "Remove columns", confirmLabel: "Remove" });
        if (!ok) return false;
      }
      await onSave({ columns: r.columns, columnGroups: r.columnGroups });
    } }]
  });
  requestAnimationFrame(() => area.focus());
}
