import { isTexty, HUES, normColor, normBg, COLUMN_LIMITS } from "../blocks/model.js";
import { h } from "./dom.js";
import { ico, pageIcon } from "../icons/index.js";
import { openMenu, CLOSE_EVENT } from "./popover.js";
import { CATALOG } from "../blocks/catalog.js";
import { openModal } from "./modal.js";
import { confirmDialog, toast } from "./dialogs.js";
import { isTableSource, tableData, NAME_MAX } from "../sources.js";
import { newBlock } from "../blocks/model.js";
import { calloutLook, hasOverride, applyPreset, resetToPreset } from "../blocks/callout.js";
import { CALLOUT_PRESETS } from "../blocks/callout-presets.js";
import { iconNode } from "../icons/index.js";
import { openImageSizeDialog, setImageAlign, alignOf } from "./imageBlock.js";

let pickerClose = null;
/** Swatch grid (6 per row) for text colour and background; the chosen swatch shows a check, not just a fill. */
function openColorPicker(anchor, b, a) {
  pickerClose?.();
  const look = b.type === "callout" ? calloutLook(b) : null;
  const curColor = look ? look.color : normColor(b.color);
  const curBg = look ? look.bg : normBg(b.bg);
  const sw = (key, value, current, { label, cls = "", glyph }) => {
    const sel = value === current;
    return h("button", {
      type: "button",
      class: `cp-sw ${cls}${sel ? " sel" : ""}`,
      style: typeof value === "number" ? `--h:${value}` : null,
      title: label,
      "aria-label": label,
      "aria-pressed": String(sel),
      onClick: () => {
        close();
        a.setColor(b, key, value === null ? "default" : value);
      }
    }, sel ? ico("check") : h("span", { class: "cp-a" }, glyph ?? ""));
  };
  const hueLabel = ([deg, name]) => `${name} ${deg}\u00b0`;
  const el = h("div", { class: "color-pop", role: "dialog", "aria-label": "Block color" },
    h("div", { class: "cp-title" }, "Text color"),
    h("div", { class: "cp-grid", role: "group", "aria-label": "Text color" },
      sw("color", null, curColor, { label: "Default text", glyph: "A" }),
      ...HUES.map((hu) => sw("color", hu[0], curColor, { label: hueLabel(hu), cls: "hue fg", glyph: "A" }))),
    h("div", { class: "cp-title" }, "Background"),
    h("div", { class: "cp-grid", role: "group", "aria-label": "Background color" },
      sw("bg", null, curBg, { label: "Default background" }),
      ...HUES.map((hu) => sw("bg", hu[0], curBg, { label: hueLabel(hu), cls: "hue" })),
      sw("bg", "grey", curBg, { label: "Grey", cls: "grey" })));
  const onKey = (e) => {
    const btns = [...el.querySelectorAll("button")];
    const i = btns.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 6, ArrowUp: -6 }[e.key];
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (step) {
      e.preventDefault();
      e.stopPropagation();
      btns[Math.min(btns.length - 1, Math.max(0, (i < 0 ? 0 : i + step)))].focus();
    }
  };
  const onDown = (e) => {
    if (!el.contains(e.target)) close();
  };
  function close() {
    document.removeEventListener(CLOSE_EVENT, close);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDown, true);
    el.remove();
    if (pickerClose === close) pickerClose = null;
  }
  pickerClose = close;
  document.body.append(el);
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const left = Math.max(8, Math.min(r.left, vw - el.offsetWidth - 8));
  const top = Math.max(8, Math.min(r.bottom + 4, vh - el.offsetHeight - 8));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  document.addEventListener(CLOSE_EVENT, close);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
  (el.querySelector("button[aria-pressed=true]") ?? el.querySelector("button")).focus();
  return { close, el };
}
/** Name and key column for a table block used as a data source (first row = column names). */
function openTableSourceDialog(b, a) {
  const cols = tableData(b).columns;
  const name = h("input", { type: "text", value: b.sourceName ?? "", maxlength: NAME_MAX, placeholder: "For example: Price list", "aria-label": "Data source name", style: "font-size:16px" });
  const key = h("select", { "aria-label": "Key column", style: "font-size:16px" }, cols.map((c, i) => h("option", { value: String(i), selected: i === (Number.isInteger(b.sourceKey) ? b.sourceKey : 0) }, c.name)));
  openModal({
    title: "Use this table as a data source",
    content: h(
      "div",
      { class: "ts-form" },
      h("p", { class: "hint" }, "The first row becomes the column names. Pickers, view blocks, value chips and record previews can then read this table, read-only."),
      h("label", {}, "Name", name),
      h("label", {}, "Key column", key)
    ),
    actions: [{ label: "Cancel" }, { label: "Use as data source", class: "primary", run: () => {
      const n = name.value.trim();
      if (!n) throw new Error("Give the data source a name.");
      b.dataSource = true;
      b.sourceName = n.slice(0, NAME_MAX);
      const k = Number(key.value);
      if (k > 0) b.sourceKey = k;
      else delete b.sourceKey;
      a.save();
      a.redraw();
      toast(`"${b.sourceName}" can now be used as a data source.`);
    } }]
  });
  name.focus();
}
/** Turn a data-source (or any) table block into a real database next to the page, and put a view block in its place. */
async function convertTable(b, inst, a) {
  const { ctx } = inst;
  const title = (b.sourceName || "").trim() || `${inst.container.title || "Table"} table`;
  const ok = await confirmDialog(`Convert this table into a database named "${title}"? The table block is replaced by a view of the new database. The first row becomes the column names and every column is text.`, { title: "Convert to database", confirmLabel: "Convert", danger: false });
  if (!ok) return;
  try {
    const host = await ctx.ws.getPage(ctx.pageId);
    const parentId = host?.type === "database" ? host.parentId : host?.parentId ?? host?.id ?? null;
    const { db, rows } = await ctx.ws.createDatabaseFromTable({ block: b, title, parentId });
    const keep = b.id;
    for (const k of Object.keys(b)) delete b[k];
    Object.assign(b, newBlock("dbview", { sourceId: db.id }), { id: keep });
    a.save();
    await ctx.refresh?.();
    a.redraw();
    toast(`Created the database "${db.title}" with ${rows} row${rows === 1 ? "" : "s"}.`);
  } catch (e) {
    toast(e.message, "error");
  }
}
export function openBlockMenu(anchor, b, inst, a) {
  const { ctx } = inst;
  const texty = isTexty(b);
  const items = [];
  if (texty || b.type === "code") {
    items.push({
      label: "Turn into",
      icon: ico("replace"),
      items: CATALOG.filter((e) => e.turn && (e.type || e.id) !== b.type || e.props?.fold && !b.fold && (e.type || e.id) === b.type).filter((e) => !(b.type === "code" && e.id === "code")).map((e) => ({ label: e.label, onSelect: () => a.turnInto(b, e) }))
    });
  }
  if (texty) {
    items.push({ label: "Color", icon: ico("palette"), hint: "Text, background", onSelect: () => openColorPicker(anchor, b, a) });
  }
  if (b.type === "callout") {
    const look = calloutLook(b);
    items.push({ label: "Callout style", icon: ico("swatch-book"), hint: look.preset?.label ?? null, items: CALLOUT_PRESETS.map((p) => ({
      label: p.label,
      icon: iconNode(p.icon, "icon:lightbulb"),
      hint: look.preset?.id === p.id ? "\u2713" : null,
      onSelect: () => {
        applyPreset(b, p.id);
        a.save();
        a.redraw();
      }
    })) });
    if (hasOverride(b)) items.push({ label: "Reset to preset", icon: ico("rotate-ccw"), onSelect: () => {
      resetToPreset(b);
      a.save();
      a.redraw();
    } });
  }
  if (/^h[1-4]$/.test(b.type)) {
    items.push({ label: b.fold ? "Make not foldable" : "Make foldable (toggle heading)", icon: ico("chevron-right"), onSelect: () => a.setFold(b, !b.fold) });
  }
  if (b.type === "columns") {
    items.push({
      label: "Column count",
      icon: ico("columns-3"),
      items: Array.from({ length: COLUMN_LIMITS.max - COLUMN_LIMITS.min + 1 }, (_, i) => {
        const n = COLUMN_LIMITS.min + i;
        return { label: `${n} columns${n === b.children.length ? " (current)" : ""}`, onSelect: () => a.setColumns(b, n) };
      })
    });
  }
  if (b.type === "image" && b.src) {
    const cur = alignOf(b);
    items.push({ label: "Image size\u2026", icon: ico("ruler"), hint: [b.width, b.height].filter((v) => typeof v === "string").join(" \u00d7 ") || null, onSelect: () => openImageSizeDialog(b, inst, a) });
    items.push({ label: "Align", icon: ico("text-align-center"), hint: cur, items: [["left", "Left"], ["center", "Centre"], ["right", "Right"]].map(([k, label]) => ({
      label,
      icon: ico(cur === k ? "check" : "minus"),
      onSelect: () => setImageAlign(b, k, a)
    })) });
  }
  if (b.type === "table") {
    const on = isTableSource(b);
    const flip = (key) => () => {
      b[key] = !b[key];
      a.save();
      a.redraw();
    };
    items.push({ label: "Header row", icon: ico(b.headerRow || on ? "square-check" : "square"), hint: on ? "data source" : null, disabled: on, onSelect: flip("headerRow") });
    items.push({ label: "Header column", icon: ico(b.headerCol ? "square-check" : "square"), onSelect: flip("headerCol") });
    if (b.colWidths || b.rowHeights) items.push({ label: "Reset column widths and row heights", icon: ico("rotate-ccw"), onSelect: () => {
      delete b.colWidths;
      delete b.rowHeights;
      a.save();
      a.redraw();
    } });
    items.push({ label: "Use as data source", icon: ico(on ? "square-check" : "database-zap"), hint: on ? "on" : null, onSelect: () => {
      if (!on) return openTableSourceDialog(b, a);
      delete b.dataSource;
      a.save();
      a.redraw();
      toast("Table is no longer a data source.");
    } });
    if (on) items.push({ label: "Data source settings\u2026", icon: ico("settings-2"), onSelect: () => openTableSourceDialog(b, a) });
    items.push({ label: "Convert to database\u2026", icon: ico("database"), onSelect: () => convertTable(b, inst, a) });
  }
  if (b.type === "page" && b.ref) items.push({ label: "Open", icon: ico("arrow-up-right"), onSelect: () => ctx.openPage(b.ref) });
  if (b.type === "synced") items.push({ label: "Unsync (make independent copy)", icon: ico("unlink"), onSelect: () => a.unsync(b) });
  items.push({ header: true, label: "Actions" });
  items.push({ label: "Duplicate", icon: ico("copy"), hint: "Ctrl+D", onSelect: () => a.duplicate(b) });
  items.push({ label: "Copy", icon: ico("clipboard"), onSelect: () => a.copy(b) });
  items.push({ label: "Cut", icon: ico("scissors"), onSelect: () => a.copy(b, true) });
  items.push({ label: "Paste below", icon: ico("clipboard-paste"), onSelect: () => a.paste(b) });
  items.push({ label: "Move up", icon: ico("arrow-up"), hint: "Ctrl+Shift+Up", onSelect: () => a.move(b, -1) });
  items.push({ label: "Move down", icon: ico("arrow-down"), hint: "Ctrl+Shift+Down", onSelect: () => a.move(b, 1) });
  const targets = ctx.livePages().filter((p) => p.type === "doc" && p.id !== inst.container.id).slice(0, 40);
  if (targets.length) {
    items.push({
      label: "Move to page",
      icon: ico("corner-up-right"),
      items: targets.map((p) => ({ label: p.title || "Untitled", icon: pageIcon(p), onSelect: () => a.moveToPage(b, p.id) }))
    });
  }
  items.push({ label: "Copy link", icon: ico("link"), onSelect: () => a.copyLink(b) });
  if (b.type !== "synced") items.push({ label: "Turn into synced block", icon: ico("refresh-cw"), onSelect: () => a.makeSynced(b) });
  items.push({ label: "Delete", icon: ico("trash"), danger: true, onSelect: () => a.remove(b) });
  return openMenu(anchor, items, { width: 250 });
}
