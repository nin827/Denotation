import { h } from "./dom.js";

const open = [];
export function openModal({ title, content, actions = [], onClose }) {
  const error = h("div", { class: "modal-error" });
  const overlay = h("div", { class: "modal-overlay" });
  let closed = false;
  const onKey = (e) => {
    if (e.key === "Escape" && open[open.length - 1] === close) close();
  };
  function close() {
    if (closed) return;
    closed = true;
    const i = open.indexOf(close);
    if (i >= 0) open.splice(i, 1);
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    onClose?.();
  }
  const buttons = actions.map((a) => h("button", {
    class: a.class || "",
    onClick: async () => {
      error.textContent = "";
      try {
        const result = a.run ? await a.run() : void 0;
        if (result !== false) close();
      } catch (e) {
        error.textContent = e.message;
      }
    }
  }, a.label));
  overlay.append(h(
    "div",
    { class: "modal", role: "dialog", "aria-modal": "true" },
    h("h3", {}, title),
    content,
    error,
    h("div", { class: "modal-actions" }, buttons)
  ));
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  open.push(close);
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  return { close };
}
