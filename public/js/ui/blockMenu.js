import { isTexty, HUES, normColor, normBg, COLUMN_LIMITS } from "../blocks/model.js";
import { h } from "./dom.js";
import { ico, pageIcon } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { CATALOG } from "../blocks/catalog.js";

let pickerClose = null;
/** Swatch grid (6 per row) for text colour and background; the chosen swatch shows a check, not just a fill. */
function openColorPicker(anchor, b, a) {
  pickerClose?.();
  const curColor = normColor(b.color);
  const curBg = normBg(b.bg);
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
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
  (el.querySelector("button[aria-pressed=true]") ?? el.querySelector("button")).focus();
  return { close, el };
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
