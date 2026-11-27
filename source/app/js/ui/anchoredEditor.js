// Anchored editor: the shared shell of the math, function-graph and chart editors. On desktop it is a popover placed next
// to the chip or block being edited; on phones (or a small touch viewport) it is the ordinary bottom-sheet modal.
// Esc, an outside click and a route change close it (the caller saves on close); Cancel (an action) restores.
import { h } from "./dom.js";
import { openModal } from "./modal.js";
import { CLOSE_EVENT } from "./popover.js";

const open = [];
const GAP = 6;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Phones keep the bottom sheet: a narrow window, or a touch device with a small viewport. */
export function isPhoneLayout() {
  const mq = (q) => !!window.matchMedia?.(q).matches;
  return mq("(max-width: 600px)") || (mq("(pointer: coarse)") && Math.min(window.innerWidth, window.innerHeight) <= 820);
}

// Safari does not focus a button on click, so remember what was pressed last as a fallback anchor.
let lastPress = null;
document.addEventListener("pointerdown", (e) => {
  lastPress = { el: e.target instanceof Element ? e.target : null, at: Date.now() };
}, true);
const pickAnchor = (given) => {
  if (given instanceof Element && given.isConnected) return given;
  const a = document.activeElement;
  if (a instanceof Element && a !== document.body && a.isConnected) return a;
  if (lastPress?.el?.isConnected && Date.now() - lastPress.at < 1500) return lastPress.el.closest("button, .ichip, .block") || lastPress.el;
  return null;
};

let probe = null;
/** Safe-area insets in px; zeros on desktop. */
function insets() {
  if (!probe) {
    probe = h("div", { "aria-hidden": "true", style: "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)" });
    document.body.append(probe);
  }
  const s = getComputedStyle(probe);
  return { t: parseFloat(s.paddingTop) || 0, r: parseFloat(s.paddingRight) || 0, b: parseFloat(s.paddingBottom) || 0, l: parseFloat(s.paddingLeft) || 0 };
}

/**
 * openAnchoredEditor({ anchor, title, content, actions, onClose, width, label })
 *  - anchor: the chip or block element (default: the focused element, else the last pressed one)
 *  - actions: [{ label, class, run }] like openModal; run() may return false to stay open
 *  - onClose(): called once, after the editor is gone (Esc, outside click, an action or a route change)
 * Returns { close }.
 */
export function openAnchoredEditor({ anchor, title, content, actions = [], onClose, width = 560, label }) {
  if (isPhoneLayout()) return openModal({ title, content, actions, onClose });
  const opener = document.activeElement;
  const anchorEl = pickAnchor(anchor);
  const error = h("div", { class: "modal-error aed-error", role: "alert" });
  const buttons = actions.map((a) => h("button", {
    type: "button", class: a.class || "",
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
  const titleId = `aed-t-${Math.random().toString(36).slice(2, 8)}`;
  const head = h("h3", { id: titleId, class: "aed-title" }, title);
  const body = h("div", { class: "aed-body" }, content, error);
  const el = h(
    "div",
    { class: "aed", role: "dialog", "aria-labelledby": label ? null : titleId, "aria-label": label || null, tabindex: "-1", style: `width:${width}px` },
    head, body, h("div", { class: "modal-actions aed-actions" }, buttons)
  );
  let closed = false;
  let lastRect = null;

  function place() {
    const vv = window.visualViewport;
    const vw = document.documentElement.clientWidth;
    const vh = vv ? Math.min(vv.height + vv.offsetTop, document.documentElement.clientHeight) : document.documentElement.clientHeight;
    const vTop = vv ? vv.offsetTop : 0;
    const s = insets();
    const m = 8;
    const minX = m + s.l, maxX = vw - m - s.r, minY = vTop + m + s.t, maxY = vh - m - s.b;
    let a = anchorEl?.isConnected ? anchorEl.getBoundingClientRect() : lastRect;
    if (!a) a = { left: vw / 2, right: vw / 2, top: vh / 3, bottom: vh / 3, width: 0, height: 0 };
    lastRect = a;
    const w = Math.min(width, maxX - minX);
    el.style.width = `${w}px`;
    // clip the anchor to the viewport so a block taller than the screen still gets a sensible side
    const top = Math.max(a.top, minY), bottom = Math.min(a.bottom, maxY);
    const below = maxY - bottom - GAP, above = top - minY - GAP;
    el.style.maxHeight = `${Math.max(180, maxY - minY)}px`;
    const natural = el.offsetHeight;
    let y, room;
    if (Math.max(below, above) < 200) {
      // the anchor fills the screen: float over it, near the top of its visible part
      room = maxY - minY;
      y = Math.max(minY, Math.min(top + 8, maxY - Math.min(natural, room)));
    } else if (below >= Math.min(natural, 320) || below >= above) {
      room = below;
      y = bottom + GAP;
    } else {
      room = above;
      y = top - GAP - Math.min(natural, room);
    }
    el.style.maxHeight = `${Math.max(160, room)}px`;
    const hgt = Math.min(el.offsetHeight, Math.max(160, room));
    if (y + hgt > maxY) y = Math.max(minY, maxY - hgt);
    // chips line up with their left edge, wide blocks centre the editor on themselves
    const x = a.width > w ? a.left + (a.width - w) / 2 : a.left;
    el.style.left = `${Math.round(Math.max(minX, Math.min(x, maxX - w)))}px`;
    el.style.top = `${Math.round(y)}px`;
  }
  function follow(e) {
    if (closed || (e?.target instanceof Node && el.contains(e.target))) return;
    if (anchorEl?.isConnected) {
      const r = anchorEl.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return close(); // scrolled out of sight: save and close
    }
    place();
  }
  const inside = (t) => t instanceof Element && (el.contains(t) || !!t.closest(".menu, .rp-pop"));
  const onDown = (e) => {
    if (inside(e.target)) return;
    if (anchorEl?.contains(e.target)) {
      // a click on the chip closes the editor; swallow its click so it does not open it again
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      document.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener("click", swallow, true), 500);
    }
    close();
  };
  const onKey = (e) => {
    if (closed || open[open.length - 1] !== close) return;
    if (e.key === "Escape") {
      if (e.defaultPrevented) return;
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      const els = [...el.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!els.length) return e.preventDefault();
      const first = els[0], last = els[els.length - 1];
      if (!el.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  function close() {
    if (closed) return;
    closed = true;
    const i = open.indexOf(close);
    if (i >= 0) open.splice(i, 1);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener(CLOSE_EVENT, close);
    window.removeEventListener("resize", follow);
    window.removeEventListener("scroll", follow, true);
    window.visualViewport?.removeEventListener("resize", follow);
    ro?.disconnect();
    const hadFocus = el.contains(document.activeElement) || document.activeElement === document.body;
    el.remove();
    // focus goes back to what was edited; the caller's onClose may move it on (the chip may have been redrawn)
    if (hadFocus) {
      const back = anchorEl?.isConnected ? anchorEl : opener instanceof HTMLElement && opener.isConnected ? opener : null;
      back?.focus?.({ preventScroll: true });
    }
    onClose?.();
  }
  open.push(close);
  document.body.append(el);
  place();
  document.addEventListener("keydown", onKey);
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener(CLOSE_EVENT, close);
  window.addEventListener("resize", follow);
  window.addEventListener("scroll", follow, true);
  window.visualViewport?.addEventListener("resize", follow);
  el.focus({ preventScroll: true });
  // content grows and shrinks (preview, errors, palette): keep it on screen
  const ro = window.ResizeObserver ? new ResizeObserver(() => !closed && place()) : null;
  ro?.observe(body);
  return { close, el };
}
