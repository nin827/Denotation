import {
  colWidth,
  freezeOffsets,
  freezeCount,
  isWrapped,
  clampWidth,
  WIDTH_PRESETS
} from "../dbviews.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openMenu } from "./popover.js";

export function cellStyle(a, col, i, lead = 0) {
  const w = colWidth(a.view, col);
  const off = freezeOffsets(a.view, a.cols, lead);
  return `width:${w}px;min-width:${w}px;max-width:${w}px;${i < off.length ? `position:sticky;left:${off[i]}px;` : ""}`;
}
export const frozenClass = (a, i) => (i < freezeCount(a.view, a.cols) ? " frozen" : "") + (i === freezeCount(a.view, a.cols) - 1 ? " frozen-last" : "");
export const wrapClass = (a, col) => isWrapped(a.view, col) ? " wrap" : "";
export const tableWidth = (a, extra = 0) => a.cols.reduce((x, c) => x + colWidth(a.view, c), extra);
export function resizeHandle(a, col, { colEl, tableEl, extra = 0 }) {
  const handle = h("span", { class: "col-resize", role: "separator", "aria-label": `Resize ${col.name}`, title: "Drag to resize, double-click to reset" });
  handle.addEventListener("click", (e) => e.stopPropagation());
  handle.addEventListener("dblclick", async (e) => {
    e.stopPropagation();
    if (a.view.widths) delete a.view.widths[col.id];
    await a.saveView?.();
    a.redraw();
  });
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = colWidth(a.view, col);
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("on");
    const apply = (w) => {
      a.view.widths = { ...a.view.widths || {}, [col.id]: w };
      if (colEl) colEl.style.width = `${w}px`;
      const t = typeof tableEl === "function" ? tableEl() : tableEl;
      if (t) t.style.width = `${tableWidth(a, extra)}px`;
    };
    const move = (ev) => apply(clampWidth(w0 + ev.clientX - x0));
    const up = async () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.classList.remove("on");
      await a.saveView?.();
      a.redraw();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  return handle;
}
function layoutMenu(a) {
  const v = a.view;
  const done = async () => {
    await a.saveView?.();
    a.redraw();
  };
  const mark = (on) => ico(on ? "check" : "minus");
  const n = freezeCount(v, a.cols);
  return [
    { label: v.wrapAll ? "Wrap all cells: on" : "Wrap all cells: off", icon: ico("text-wrap"), onSelect: async () => {
      v.wrapAll = !v.wrapAll;
      v.wrap = {};
      await done();
    } },
    { label: "Wrap column", icon: ico("text-wrap"), items: a.cols.map((c) => ({ label: c.name, icon: mark(isWrapped(v, c)), onSelect: async () => {
      v.wrap = { ...v.wrap || {}, [c.id]: !isWrapped(v, c) };
      await done();
    } })) },
    { label: `Freeze columns: ${n || "none"}`, icon: ico("pin"), items: [0, 1, 2, 3].filter((k) => k <= a.cols.length).map((k) => ({ label: k === 0 ? "None" : `First ${k} column${k > 1 ? "s" : ""}`, icon: mark(n === k), onSelect: async () => {
      v.freeze = k;
      await done();
    } })) },
    { label: "Column width", icon: ico("move-horizontal"), items: a.cols.map((c) => ({
      label: `${c.name} (${colWidth(v, c)}px)`,
      items: WIDTH_PRESETS.map((p) => ({ label: `${p.label} (${p.px}px)`, icon: mark(colWidth(v, c) === p.px), onSelect: async () => {
        v.widths = { ...v.widths || {}, [c.id]: p.px };
        await done();
      } }))
    })) },
    { label: "Reset widths", icon: ico("rotate-ccw"), onSelect: async () => {
      v.widths = {};
      await done();
    } }
  ];
}
export const openLayoutMenu = (anchor, a) => openMenu(anchor, layoutMenu(a), { width: 240 });
