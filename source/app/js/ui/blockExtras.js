// Block settings live in the block menu (the ≡ handle, right-click, long-press, Shift+F10), never in a bar in the page flow.
// A block body registers a function for its block object; openBlockMenu asks for the items every time the menu opens, so
// they always reflect the current state. fn({ target }) gets the element that was right-clicked (a table cell, say) or null.
// Items flagged viewOnly stay available on locked pages (copying code, switching a graph between canvas and list).
const registry = new WeakMap();

export function setBlockMenu(block, fn) {
  registry.set(block, fn);
}
/** The block's own menu items ([] when it has none). Never throws: a broken body must not break the menu. */
export function blockMenuExtras(block, opts = {}) {
  try {
    return registry.get(block)?.(opts) ?? [];
  } catch {
    return [];
  }
}
