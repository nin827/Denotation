import { h } from "./dom.js";
import { ico } from "../icons/index.js";

let current = null;
const closeMenus = () => current?.close();
export function openMenu(anchor, items, { onClose, empty = "No results", width: width } = {}) {
  closeMenus();
  const el = h("div", { class: "menu", role: "menu", style: width ? `width:${width}px` : null });
  const stack = [];
  let list = items;
  let active = 0;
  let closed = false;
  const rows = () => [...el.querySelectorAll(".menu-item:not(.disabled)")];
  const setActive = (i) => {
    const r = rows();
    if (!r.length) return;
    active = (i + r.length) % r.length;
    r.forEach((x, n) => x.classList.toggle("active", n === active));
    r[active].scrollIntoView({ block: "nearest" });
  };
  function draw() {
    const shown = stack.length ? [{ label: stack[stack.length - 1].title, icon: ico("chevron-left"), back: true }, ...list] : list;
    el.replaceChildren(...shown.length ? shown.map(rowFor) : [h("div", { class: "menu-empty" }, empty)]);
    setActive(Math.min(active, Math.max(0, rows().length - 1)));
    place();
  }
  function rowFor(item) {
    if (item.separator) return h("div", { class: "menu-sep", role: "separator" });
    if (item.header) return h("div", { class: "menu-header" }, item.label);
    const r = h(
      "div",
      {
        class: `menu-item${item.disabled ? " disabled" : ""}${item.danger ? " danger" : ""}`,
        role: "menuitem",
        onMousedown: (e) => e.preventDefault(),
        // keep focus where it is (the editor textarea)
        onMouseenter: () => {
          const i = rows().indexOf(r);
          if (i >= 0) setActive(i);
        },
        onClick: () => choose(item)
      },
      item.swatch ? h("span", { class: "menu-swatch", style: `background:${item.swatch}` }) : null,
      item.icon ? h("span", { class: "menu-icon" }, item.icon) : null,
      h("span", { class: "menu-label" }, item.label),
      item.hint ? h("span", { class: "menu-hint" }, item.hint) : null,
      item.items ? h("span", { class: "menu-hint" }, ico("chevron-right")) : null
    );
    r._item = item;
    return r;
  }
  async function choose(item) {
    if (item.disabled) return;
    if (item.back) {
      list = stack.pop().items;
      active = 0;
      draw();
      return;
    }
    if (item.items) {
      stack.push({ title: item.label, items: list });
      list = item.items;
      active = 0;
      draw();
      return;
    }
    close();
    await item.onSelect?.();
  }
  function place() {
    const a = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const vw = document.documentElement.clientWidth;
    // the visible area: with the on-screen keyboard up, only the visual viewport (above the keyboard) counts
    const vv = window.visualViewport;
    const vTop = vv ? vv.offsetTop : 0;
    const vh = vv ? Math.min(vv.height + vTop, document.documentElement.clientHeight) : document.documentElement.clientHeight;
    const w = el.offsetWidth || 240;
    const hgt = el.offsetHeight || 200;
    const left = Math.max(8, Math.min(a.left, vw - w - 8));
    const below = vh - a.bottom - 8;
    const top = below >= Math.min(hgt, 260) || a.top - vTop < hgt ? a.bottom + 4 : a.top - hgt - 4;
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(vTop + 8, top)}px`;
    el.style.maxHeight = `${Math.max(160, vh - Math.max(vTop + 8, top) - 8)}px`;
  }
  const onKey = (e) => {
    if (closed) return;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "ArrowDown") {
      stop();
      setActive(active + 1);
    } else if (e.key === "ArrowUp") {
      stop();
      setActive(active - 1);
    } else if (e.key === "ArrowRight" && rows()[active]?._item?.items) {
      stop();
      choose(rows()[active]._item);
    } else if (e.key === "ArrowLeft" && stack.length) {
      stop();
      list = stack.pop().items;
      active = 0;
      draw();
    } else if (e.key === "Enter" || e.key === "Tab") {
      const r = rows()[active];
      if (r) {
        stop();
        choose(r._item);
      }
    } else if (e.key === "Escape") {
      stop();
      close();
    }
  };
  const onDown = (e) => {
    if (!el.contains(e.target)) close();
  };
  const width0 = window.innerWidth;
  const onResize = () => {
    if (window.innerWidth !== width0) close();
    else place();
  };
  function close() {
    if (closed) return;
    closed = true;
    if (current === api) current = null;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("resize", onResize);
    el.remove();
    onClose?.();
  }
  const api = {
    close,
    el,
    /** Replace the top-level items (used by the slash menu while typing). */
    update(next) {
      list = next;
      stack.length = 0;
      active = 0;
      draw();
    }
  };
  current = api;
  document.body.append(el);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
  window.addEventListener("resize", onResize);
  draw();
  return api;
}
