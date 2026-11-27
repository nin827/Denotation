import {
  colWidth,
  freezeOffsets,
  freezeCount,
  isWrapped,
  clampWidth,
  WIDTH_PRESETS
} from "../dbviews.js";
import { DISPLAY_MODES, DISPLAY_LABEL, resolveDisplay, setViewDisplay, columnDisplay } from "../columns.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { openModal } from "./modal.js";

export function cellStyle(a, col, i, lead = 0) {
  const w = colWidth(a.view, col);
  const off = freezeOffsets(a.view, a.cols, lead);
  return `width:${w}px;min-width:${w}px;max-width:${w}px;${i < off.length ? `position:sticky;left:${off[i]}px;` : ""}`;
}
export const frozenClass = (a, i) => (i < freezeCount(a.view, a.cols) ? " frozen" : "") + (i === freezeCount(a.view, a.cols) - 1 ? " frozen-last" : "");
export const wrapClass = (a, col) => isWrapped(a.view, col) ? " wrap" : "";
/** Class for a cell's display mode in this view (" d-wrap", " d-hide", …; nothing for clip). */
export const displayClass = (a, col) => {
  if (col.stub) return " stub";
  const d = resolveDisplay(a.view, col);
  return d === "clip" ? "" : ` d-${d}`;
};
/** Menu items that set a column's display in this view: "Column default" plus the five modes. */
export function displayItems(a, col) {
  const v = a.view;
  const own = v.display?.[col.id];
  const cur = resolveDisplay(v, col);
  const set = (mode) => async () => {
    setViewDisplay(v, col.id, mode);
    await a.saveView?.();
    a.redraw();
  };
  return [
    { label: `Column default (${DISPLAY_LABEL[columnDisplay(col)]})`, icon: ico(!own ? "check" : "minus"), onSelect: set(null) },
    ...DISPLAY_MODES.map((m) => ({ label: DISPLAY_LABEL[m], icon: ico(own === m ? "check" : "minus"), hint: !own && cur === m ? "default" : null, onSelect: set(m) }))
  ];
}
/** Keyboard and touch path for resizing: a dialog with a number field, a slider and presets. */
export function openWidthDialog(a, col) {
  const v = a.view;
  const start = colWidth(v, col);
  const num = h("input", { type: "number", min: 60, max: 800, step: 10, inputmode: "numeric", value: String(start), "aria-label": "Width in pixels" });
  const slider = h("input", { type: "range", min: 60, max: 800, step: 10, value: String(start), "aria-label": "Width slider" });
  num.addEventListener("input", () => {
    slider.value = num.value;
  });
  slider.addEventListener("input", () => {
    num.value = slider.value;
  });
  const save = async (px) => {
    if (px == null) {
      if (v.widths) delete v.widths[col.id];
    } else v.widths = { ...v.widths || {}, [col.id]: clampWidth(px) };
    await a.saveView?.();
    a.redraw();
  };
  openModal({
    title: `Width of ${col.name}`,
    content: h(
      "div",
      { class: "width-dialog" },
      h("label", {}, "Pixels (60–800)", num),
      slider,
      h("div", { class: "width-presets" }, WIDTH_PRESETS.map((p) => h("button", { type: "button", "aria-pressed": String(start === p.px), onClick: () => {
        num.value = slider.value = String(p.px);
      } }, `${p.label} ${p.px}`)))
    ),
    actions: [
      { label: "Reset", run: () => save(null) },
      { label: "Cancel" },
      { label: "Save", class: "primary", run: () => save(Number(num.value)) }
    ]
  });
  requestAnimationFrame(() => num.focus());
}
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
  const real = a.cols.filter((c) => !c.stub);
  return [
    { label: v.wrapAll ? "Wrap all cells: on" : "Wrap all cells: off", icon: ico("text-wrap"), onSelect: async () => {
      v.wrapAll = !v.wrapAll;
      v.wrap = {};
      await done();
    } },
    { label: "Column display", icon: ico("eye"), items: real.map((c) => ({ label: `${c.name} (${DISPLAY_LABEL[resolveDisplay(v, c)]})`, items: displayItems(a, c) })) },
    { label: `Freeze columns: ${n || "none"}`, icon: ico("pin"), items: [0, 1, 2, 3].filter((k) => k <= a.cols.length).map((k) => ({ label: k === 0 ? "None" : `First ${k} column${k > 1 ? "s" : ""}`, icon: mark(n === k), onSelect: async () => {
      v.freeze = k;
      await done();
    } })) },
    { label: "Column width", icon: ico("move-horizontal"), items: real.map((c) => ({
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
