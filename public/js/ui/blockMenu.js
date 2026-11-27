import { isTexty, COLORS, COLUMN_LIMITS } from "../blocks/model.js";
import { ico, pageIcon } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { CATALOG } from "../blocks/catalog.js";

const swatch = (c, bg) => bg ? `color-mix(in srgb, var(--c-${c}) 30%, var(--bg))` : `var(--c-${c})`;
const cap = (s) => s[0].toUpperCase() + s.slice(1);
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
    items.push({
      label: "Color",
      icon: ico("palette"),
      items: [
        { header: true, label: "Text color" },
        ...COLORS.map((c) => ({ label: cap(c), swatch: c === "default" ? "var(--text)" : swatch(c), onSelect: () => a.setColor(b, "color", c) })),
        { header: true, label: "Background" },
        ...COLORS.map((c) => ({ label: cap(c), swatch: c === "default" ? "var(--bg)" : swatch(c, true), onSelect: () => a.setColor(b, "bg", c) }))
      ]
    });
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
