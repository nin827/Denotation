import { h } from "./dom.js";
import { openModal } from "./modal.js";
import { ico } from "../icons/index.js";

export function confirmDialog(message, { title = "Are you sure?", confirmLabel = "Delete", danger = true } = {}) {
  return new Promise((resolve) => {
    openModal({
      title,
      content: h("p", {}, message),
      actions: [
        { label: "Cancel" },
        { label: confirmLabel, class: danger ? "danger" : "primary", run: () => resolve(true) }
      ],
      onClose: () => resolve(false)
      // no effect if already resolved true
    });
  });
}
const TOAST_ICONS = { success: "circle-check", error: "triangle-exclamation-point", warning: "triangle-exclamation-point", info: "info" };
/**
 * Shows a message. `kind`: "info" (default), "success", "warning" or "error"; a leading icon says the state, not
 * colour alone. Optional `{ action: { label, run }, sticky }`: a button inside the toast, and a toast that stays
 * until dismissed (an action toast is sticky unless `sticky: false`). Returns the toast element, or null for a duplicate.
 */
export function toast(message, kind = "info", { action = null, sticky = !!action } = {}) {
  let box = document.getElementById("toasts");
  if (!box) {
    box = h("div", { id: "toasts", class: "toasts", "aria-live": "polite" });
    document.body.append(box);
  }
  if ([...box.children].some((el2) => el2.dataset.msg === message)) return null;
  const icon = ico(TOAST_ICONS[kind] ?? TOAST_ICONS.info);
  icon.style.cssText = "flex:none;width:var(--ico-md,16px);height:var(--ico-md,16px);margin-top:2px";
  const el = h("div", {
    class: `toast ${kind}`, role: kind === "error" ? "alert" : "status", "data-msg": message,
    style: "display:flex;align-items:flex-start;gap:var(--sp-8,8px)"
  }, icon, h("span", { style: "min-width:0;overflow-wrap:anywhere" }, message));
  if (action) {
    el.append(h("button", {
      type: "button", style: "flex:none;margin-left:var(--sp-8,8px);color:inherit;background:transparent;border-color:currentColor",
      onClick: () => {
        el.remove();
        action.run();
      }
    }, action.label));
  }
  if (sticky) {
    el.append(h("button", {
      type: "button", "aria-label": "Dismiss", title: "Dismiss", style: "flex:none;color:inherit;background:transparent;border-color:transparent;padding:0 var(--sp-4,4px)",
      onClick: () => el.remove()
    }, ico("x")));
  }
  box.append(el);
  if (!sticky) setTimeout(() => el.remove(), kind === "error" ? 8e3 : 3500);
  return el;
}
