import { h } from "./dom.js";
import { openModal } from "./modal.js";

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
export function toast(message, kind = "info") {
  let box = document.getElementById("toasts");
  if (!box) {
    box = h("div", { id: "toasts", class: "toasts", "aria-live": "polite" });
    document.body.append(box);
  }
  if ([...box.children].some((el2) => el2.textContent === message)) return;
  const el = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, message);
  box.append(el);
  setTimeout(() => el.remove(), kind === "error" ? 8e3 : 3500);
}
