import { openMenu } from "./popover.js";

const LONG_PRESS_MS = 520;
const NATIVE = "input,textarea,select,[contenteditable],[contenteditable=true],a[href]";

/** True when the browser's own menu should stay (editable fields, links, a text selection). Pure given its inputs. */
export function wantsNativeMenu(target, selectionText = "") {
  if (selectionText && String(selectionText).trim()) return true;
  const el = target && target.closest ? target : target?.parentElement;
  return !!(el && el.closest && el.closest(NATIVE));
}
const selectedText = () => {
  try {
    return window.getSelection?.()?.toString() ?? "";
  } catch {
    return "";
  }
};
/**
 * Opens a context menu on right-click, long-press (touch) and Shift+F10 / ContextMenu key.
 * getItems(event) returns the menu items (or an empty/falsy value for no menu, which leaves the native menu alone).
 */
export function bindContextMenu(el, getItems, { width = 220 } = {}) {
  let press = null;
  let longPressed = false; // swallow the click that follows a long-press
  const cancel = () => {
    clearTimeout(press);
    press = null;
  };
  const show = (anchor) => {
    const items = getItems();
    if (!items || !items.length) return false;
    openMenu(anchor, items, { width });
    return true;
  };
  el.addEventListener("contextmenu", (e) => {
    if (press !== null) longPressed = true; // the browser's own long-press contextmenu beat our timer
    cancel();
    if (wantsNativeMenu(e.target, selectedText())) return;
    if (show({ x: e.clientX, y: e.clientY })) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  el.addEventListener("keydown", (e) => {
    const key = e.key === "ContextMenu" || e.key === "F10" && e.shiftKey;
    if (!key || wantsNativeMenu(e.target)) return;
    if (show(el)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  el.addEventListener("touchstart", (e) => {
    cancel();
    longPressed = false;
    if (e.touches.length !== 1 || wantsNativeMenu(e.target)) return;
    const t = e.touches[0];
    press = setTimeout(() => {
      press = null;
      if (selectedText().trim()) return;
      longPressed = show({ x: t.clientX, y: t.clientY });
    }, LONG_PRESS_MS);
  }, { passive: true });
  el.addEventListener("touchmove", cancel, { passive: true });
  el.addEventListener("touchcancel", cancel);
  el.addEventListener("touchend", (e) => {
    cancel();
    if (longPressed && e.cancelable) e.preventDefault(); // no emulated click after a long-press (it would close the menu)
  });
  el.addEventListener("click", (e) => {
    if (longPressed) {
      longPressed = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
  return el;
}
