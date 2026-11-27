import { h } from "./dom.js";
import { searchIcons, iconValue, svgFor, iconCount } from "../icons/index.js";
import { openModal } from "./modal.js";

const PAGE = 120;
export function pickEmoji(anchor, onPick, { removable = true } = {}) {
  let shown = PAGE;
  let query = "";
  const search = h("input", {
    type: "search",
    placeholder: "Search icons (e.g. rocket, calendar, chart)\u2026",
    "aria-label": "Search icons",
    onInput: (e) => {
      query = e.target.value;
      shown = PAGE;
      drawGrid();
    }
  });
  const count = h("div", { class: "hint" });
  const grid = h("div", { class: "icon-grid" });
  const more = h("button", { class: "pick-more", onClick: () => {
    shown += PAGE;
    drawGrid();
  } }, "Show more");
  const choose = (v) => {
    dialog.close();
    onPick(v);
  };
  function drawGrid() {
    const list = searchIcons(query);
    grid.replaceChildren(...list.length ? list.slice(0, shown).map((n) => h("button", { class: "icon", type: "button", title: n, "aria-label": n, onClick: () => choose(iconValue(n)) }, svgFor(n))) : [h("p", { class: "hint" }, "No icons match.")]);
    more.hidden = list.length <= shown;
    count.textContent = `${list.length} of ${iconCount()} icons`;
  }
  const dialog = openModal({
    title: "Choose an icon",
    content: h("div", { class: "pick-body" }, search, count, grid, more),
    actions: removable ? [{ label: "Remove icon", run: () => onPick(null) }, { label: "Cancel" }] : [{ label: "Cancel" }]
  });
  drawGrid();
}
