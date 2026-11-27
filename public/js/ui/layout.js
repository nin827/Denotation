import { h } from "./dom.js";
import { ico } from "../icons/index.js";

export function createLayout({ appEl: appEl, getLocked, onChange }) {
  const narrow = window.matchMedia("(max-width: 700px)");
  let open = !narrow.matches;
  const scrim = h("div", { id: "side-scrim", hidden: true, onClick: () => api.close() });
  const opener = h("button", { id: "side-open", title: "Open sidebar (Ctrl+\\)", "aria-label": "Open sidebar", onClick: () => api.open() }, ico("panel-left-open"));
  document.body.append(scrim, opener);
  const mode = () => !narrow.matches && getLocked() ? "pinned" : open ? "overlay" : "closed";
  function apply() {
    const m = mode();
    appEl.dataset.side = m;
    scrim.hidden = m !== "overlay";
    opener.hidden = m !== "closed";
    onChange?.(m);
  }
  narrow.addEventListener("change", () => {
    open = false;
    apply();
  });
  const api = {
    mode,
    apply,
    open() {
      open = true;
      apply();
    },
    close() {
      if (mode() === "pinned") return;
      open = false;
      apply();
    },
    toggle() {
      if (mode() === "closed") api.open();
      else api.close();
    },
    /** Call after navigating: an overlay sidebar gets out of the way. */
    afterNavigate() {
      if (mode() === "overlay") {
        open = false;
        apply();
      }
    }
  };
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
      e.preventDefault();
      api.toggle();
    }
  });
  open = false;
  apply();
  return api;
}
