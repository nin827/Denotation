// Shared pieces for sized things (table columns / rows, images): constants lookup, a live-update hook and the size dialog.
import { h } from "./dom.js";
import { openModal } from "./modal.js";
import { findRepo, constantsOf } from "../constants.js";
import { CONSTANTS_EVENT } from "./inlineChips.js";
import { parseSizeField, sizeFieldText, SIZE_RANGES } from "../sizes.js";

/** The repository constants visible from a block editor context ([] when there is no repository). */
export function constantsFor(ctx) {
  try {
    return constantsOf(findRepo(ctx?.livePages?.() ?? [], ctx?.pageId));
  } catch {
    return [];
  }
}
/** Call fn() again whenever repository constants change, until `el` has been removed from the page. */
export function onConstantsChange(el, fn) {
  const again = () => {
    if (!el.isConnected) {
      document.removeEventListener(CONSTANTS_EVENT, again);
      return;
    }
    fn();
  };
  document.addEventListener(CONSTANTS_EVENT, again);
}
/** Make `handle` drag: begin(e) returns state; move(state, dx, dy) updates live; end(state, moved) runs on release. */
export function dragHandle(handle, { begin, move, end }) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    const st = begin(e);
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("on");
    const onMove = (ev) => {
      moved = true;
      move(st, ev.clientX - x0, ev.clientY - y0);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      handle.classList.remove("on");
      end(st, moved);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
}
/**
 * A dialog asking for sizes. fields: [{ key, label, value, allowConst? }]; onSave(values) gets { key: storedValue|null }.
 * `range` clamps; `constants` (names offered in a list) is for fields with allowConst.
 */
export function openSizeDialog({ title, fields, constants = [], range = SIZE_RANGES.image, hint, extra = null, onSave, onReset }) {
  const inputs = fields.map((f, i) => {
    const listId = f.allowConst && constants.length ? `size-names-${Date.now()}-${i}` : null;
    const input = h("input", {
      type: "text",
      inputmode: "text",
      autocomplete: "off",
      class: "size-input",
      "aria-label": f.label,
      list: listId,
      placeholder: f.placeholder ?? "auto",
      value: sizeFieldText(f.value, constants),
      style: "font-size:16px"
    });
    const names = listId ? h("datalist", { id: listId }, constants.map((c) => h("option", { value: c.name }))) : null;
    return { f, input, names };
  });
  const body = h(
    "div",
    { class: "size-dialog" },
    h("p", { class: "hint" }, hint ?? "Use px, em or rem. A bare number means px. Leave empty for automatic."),
    ...inputs.map(({ f, input, names }) => h("label", { class: "size-field" }, f.label, input, names)),
    extra
  );
  const actions = [];
  if (onReset) actions.push({ label: "Reset", run: () => onReset() });
  actions.push({ label: "Cancel" });
  actions.push({ label: "Save", class: "primary", run: () => {
    const out = {};
    for (const { f, input } of inputs) {
      const r = parseSizeField(input.value, { constants, allowConst: !!f.allowConst, range: f.range ?? range });
      if (r.error) {
        input.focus();
        throw new Error(`${f.label}: ${r.error}`);
      }
      out[f.key] = r.value;
    }
    return onSave(out);
  } });
  const modal = openModal({ title, content: body, actions });
  requestAnimationFrame(() => inputs[0]?.input.focus());
  body.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && e.target.tagName === "INPUT") {
      e.preventDefault();
      body.closest(".modal-overlay")?.querySelector("button.primary")?.click();
    }
  });
  return modal;
}
