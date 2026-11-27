// The /table block: an editable grid with header row / column, per-column widths and per-row heights.
// Its settings (headers, rows and columns, sizes) are in the block menu: right-click or long-press a cell, Shift+F10 in a cell, or the ≡ handle.
// Stored: cells, headerRow, headerCol, colWidths: [size|null], rowHeights: [size|null] (size = "320px" / "20em" / "12rem").
import { TABLE_LIMITS, tableResize, tableInsertRow, tableDeleteRow, tableInsertCol, tableDeleteCol } from "../blocks/model.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openModal } from "./modal.js";
import { setBlockMenu } from "./blockExtras.js";
import { isTableSource, sourceNameOf } from "../sources.js";
import { resolveSize, normSize, SIZE_RANGES } from "../sizes.js";
import { openSizeDialog, dragHandle } from "./sizing.js";
import { toast } from "./dialogs.js";

const AUTO_COL_PX = 110; // what an automatic column counts for in a table that has sized columns
const PRESET_NOTE = "Use px, em or rem. A bare number means px. Leave empty for automatic.";

export function tableBody(b, inst, a) {
  const { ctx } = inst;
  const locked = ctx.locked;
  const isSource = isTableSource(b);
  const nCols = () => b.cells[0].length;
  const headRow = () => !!b.headerRow || isSource; // a data source always reads its first row as column names
  const widthCss = (i) => resolveSize(b.colWidths?.[i], [], SIZE_RANGES.column).css;
  const heightCss = (i) => resolveSize(b.rowHeights?.[i], [], SIZE_RANGES.row).css;
  const sizeList = (key, n) => Array.from({ length: n }, (_, i) => b[key]?.[i] ?? null);
  const commit = (key, list) => {
    if (list.some(Boolean)) b[key] = list;
    else delete b[key];
    a.save();
    apply();
  };
  const setCol = (c, v) => {
    const list = sizeList("colWidths", nCols());
    list[c] = v;
    commit("colWidths", list);
  };
  const setRow = (r, v) => {
    const list = sizeList("rowHeights", b.cells.length);
    list[r] = v;
    commit("rowHeights", list);
  };
  const colEls = b.cells[0].map(() => h("col"));
  const rowEls = [];
  /** Push the stored sizes onto the <col> and <tr> elements (also used live while dragging). */
  function apply() {
    const parts = [];
    let auto = 0;
    colEls.forEach((el, i) => {
      const css = widthCss(i);
      el.style.width = css ?? "";
      if (css) parts.push(css);
      else auto++;
    });
    grid.classList.toggle("sized", parts.length > 0);
    grid.style.width = parts.length ? `calc(${parts.join(" + ")} + ${auto * AUTO_COL_PX}px)` : "";
    grid.style.minWidth = parts.length && !auto ? "0" : "";
    rowEls.forEach((tr, i) => {
      const css = heightCss(i);
      tr.classList.toggle("rh", !!css);
      if (css) tr.style.setProperty("--rh", css);
      else tr.style.removeProperty("--rh");
    });
  }
  const askWidth = (c) => openSizeDialog({
    title: `Width of column ${c + 1}`,
    fields: [{ key: "v", label: "Width", value: b.colWidths?.[c] ?? null, placeholder: "auto", range: SIZE_RANGES.column }],
    range: SIZE_RANGES.column,
    hint: PRESET_NOTE,
    onSave: ({ v }) => setCol(c, v),
    onReset: () => setCol(c, null)
  });
  const askHeight = (r) => openSizeDialog({
    title: `Height of row ${r + 1}`,
    fields: [{ key: "v", label: "Height", value: b.rowHeights?.[r] ?? null, placeholder: "auto", range: SIZE_RANGES.row }],
    range: SIZE_RANGES.row,
    hint: PRESET_NOTE,
    onSave: ({ v }) => setRow(r, v),
    onReset: () => setRow(r, null)
  });
  const toggle = (key) => {
    b[key] = !b[key];
    a.save();
    a.redraw();
  };
  const sizesSet = () => !!(b.colWidths || b.rowHeights);
  let last = null; // the cell that last had focus: what the menu acts on when it was opened from the handle
  const askCount = (kind) => {
    const isRows = kind === "rows";
    const max = isRows ? TABLE_LIMITS.maxRows : TABLE_LIMITS.maxCols;
    const input = h("input", { type: "number", min: 1, max, value: isRows ? b.cells.length : nCols(), "aria-label": isRows ? "Rows" : "Columns", style: "font-size:16px;width:100%" });
    const modal = openModal({
      title: isRows ? "Number of rows" : "Number of columns",
      content: h("div", { class: "size-dialog" }, h("label", { class: "size-field" }, `${isRows ? "Rows" : "Columns"} (1 to ${max})`, input)),
      actions: [{ label: "Cancel" }, { label: "Apply", class: "primary", run: () => {
        const n = Math.min(max, Math.max(1, Math.round(Number(input.value) || 1)));
        const fewer = isRows ? n < b.cells.length : n < nCols();
        if (fewer) toast(`Removed the last ${isRows ? "rows" : "columns"}.`, "info");
        tableResize(b, isRows ? n : b.cells.length, isRows ? nCols() : n);
        a.save();
        a.redraw();
      } }]
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        input.closest(".modal-overlay")?.querySelector("button.primary")?.click();
      }
    });
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return modal;
  };
  const focusCell = (r, c) => requestAnimationFrame(() => inst.root.querySelector(`.blk-wrap[data-id="${b.id}"] .tbl-cell[data-r="${r}"][data-c="${c}"] input`)?.focus());
  const applyEdit = (fn, r, c) => () => {
    if (fn() === false) return;
    a.save();
    a.redraw();
    focusCell(Math.min(r, b.cells.length - 1), Math.min(c, nCols() - 1));
  };
  /** Menu items; `target` is the right-clicked cell (or null: the cell that last had focus, else the last row and column). */
  const menuItems = ({ target = null } = {}) => {
    const el = target?.closest?.(".tbl-cell");
    let r = el ? Number(el.dataset.r) : last ? last.r : b.cells.length - 1;
    let c = el ? Number(el.dataset.c) : last ? last.c : nCols() - 1;
    r = Math.min(Math.max(0, r), b.cells.length - 1);
    c = Math.min(Math.max(0, c), nCols() - 1);
    const rows = b.cells.length;
    const cols = nCols();
    return [
      { header: true, label: "Table" },
      { label: "Header row", icon: ico(headRow() ? "square-check" : "square"), hint: isSource ? "data source" : null, disabled: isSource, onSelect: () => toggle("headerRow") },
      { label: "Header column", icon: ico(b.headerCol ? "square-check" : "square"), onSelect: () => toggle("headerCol") },
      { label: `Row ${r + 1}`, icon: ico("rows-3"), items: [
        { label: "Add row above", icon: ico("arrow-up"), disabled: rows >= TABLE_LIMITS.maxRows, onSelect: applyEdit(() => tableInsertRow(b, r), r, c) },
        { label: "Add row below", icon: ico("arrow-down"), disabled: rows >= TABLE_LIMITS.maxRows, onSelect: applyEdit(() => tableInsertRow(b, r + 1), r + 1, c) },
        { label: "Delete row", icon: ico("trash"), danger: true, disabled: rows <= 1, onSelect: applyEdit(() => tableDeleteRow(b, r), r, c) },
        { label: "Row height\u2026", icon: ico("move-vertical"), hint: b.rowHeights?.[r] ?? "auto", onSelect: () => askHeight(r) },
        { label: "Reset row height", icon: ico("rotate-ccw"), disabled: !b.rowHeights?.[r], onSelect: () => setRow(r, null) }
      ] },
      { label: `Column ${c + 1}`, icon: ico("columns-3"), items: [
        { label: "Add column left", icon: ico("arrow-left"), disabled: cols >= TABLE_LIMITS.maxCols, onSelect: applyEdit(() => tableInsertCol(b, c), r, c) },
        { label: "Add column right", icon: ico("arrow-right"), disabled: cols >= TABLE_LIMITS.maxCols, onSelect: applyEdit(() => tableInsertCol(b, c + 1), r, c + 1) },
        { label: "Delete column", icon: ico("trash"), danger: true, disabled: cols <= 1, onSelect: applyEdit(() => tableDeleteCol(b, c), r, c) },
        { label: "Column width\u2026", icon: ico("move-horizontal"), hint: b.colWidths?.[c] ?? "auto", onSelect: () => askWidth(c) },
        { label: "Reset column width", icon: ico("rotate-ccw"), disabled: !b.colWidths?.[c], onSelect: () => setCol(c, null) }
      ] },
      { label: "Rows\u2026", icon: ico("rows-3"), hint: String(rows), onSelect: () => askCount("rows") },
      { label: "Columns\u2026", icon: ico("columns-3"), hint: String(cols), onSelect: () => askCount("columns") },
      sizesSet() ? { label: "Reset column widths and row heights", icon: ico("rotate-ccw"), onSelect: () => {
        delete b.colWidths;
        delete b.rowHeights;
        a.save();
        apply();
      } } : null
    ].filter(Boolean);
  };
  setBlockMenu(b, (opts) => locked ? [] : menuItems(opts));
  const colGrip = (c) => {
    const el = h("span", { class: "tbl-grip col", "aria-hidden": "true", title: "Drag to resize, double-click to reset" });
    el.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      setCol(c, null);
    });
    dragHandle(el, {
      begin: () => ({ w0: el.parentElement.getBoundingClientRect().width }),
      move: (st, dx) => {
        b.colWidths = Object.assign(sizeList("colWidths", nCols()), { [c]: normSize(st.w0 + dx, SIZE_RANGES.column) });
        apply();
      },
      end: (st, moved) => moved && a.save()
    });
    return el;
  };
  const rowGrip = (r) => {
    const el = h("span", { class: "tbl-grip row", "aria-hidden": "true", title: "Drag to resize, double-click to reset" });
    el.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      setRow(r, null);
    });
    dragHandle(el, {
      begin: () => ({ h0: el.parentElement.parentElement.getBoundingClientRect().height }),
      move: (st, _dx, dy) => {
        b.rowHeights = Object.assign(sizeList("rowHeights", b.cells.length), { [r]: normSize(st.h0 + dy, SIZE_RANGES.row) });
        apply();
      },
      end: (st, moved) => moved && a.save()
    });
    return el;
  };
  const cell = (r, c) => {
    const colHead = headRow() && r === 0;
    const isHead = colHead || b.headerCol && c === 0;
    const input = h("input", {
      type: "text",
      class: `cell${isHead ? " head" : ""}`,
      value: b.cells[r][c],
      readonly: locked,
      "aria-label": `Row ${r + 1}, column ${c + 1}`,
      onInput: (e) => {
        b.cells[r][c] = e.target.value;
        a.save();
      },
      onKeydown: (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          grid.querySelectorAll("tr")[r + 1]?.children[c]?.querySelector("input")?.focus();
        }
      },
      onFocus: () => {
        last = { r, c };
      },
      onPaste: (e) => {
        const t = e.clipboardData?.getData("text/plain") ?? "";
        if (!/[\t\n]/.test(t.trim())) return;
        e.preventDefault();
        const rows = t.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
        const needRows = Math.min(TABLE_LIMITS.maxRows, r + rows.length);
        const needCols = Math.min(TABLE_LIMITS.maxCols, c + Math.max(...rows.map((x) => x.length)));
        tableResize(b, Math.max(needRows, b.cells.length), Math.max(needCols, b.cells[0].length));
        rows.forEach((line, i) => line.forEach((v, j) => {
          if (b.cells[r + i]?.[c + j] !== void 0) b.cells[r + i][c + j] = v;
        }));
        a.save();
        a.redraw();
      }
    });
    const edit = !locked;
    return h(
      isHead ? "th" : "td",
      isHead ? { scope: colHead ? "col" : "row", class: "tbl-cell", "data-r": r, "data-c": c } : { class: "tbl-cell", "data-r": r, "data-c": c },
      input,
      edit && r === 0 ? colGrip(c) : null,
      edit && c === 0 ? rowGrip(r) : null
    );
  };
  const body = h("tbody", {}, b.cells.map((row, r) => {
    const tr = h("tr", {}, row.map((_, c) => cell(r, c)));
    rowEls.push(tr);
    return tr;
  }));
  const grid = h("table", { class: `tbl${locked ? "" : " tbl-edit"}` }, h("colgroup", {}, colEls), body);
  const tag = isSource ? h("div", { class: "tbl-source", title: "Used as a data source (first row = column names)" }, ico("database-zap"), h("span", {}, ` Data source: ${sourceNameOf(b)}`)) : null;
  apply();
  return h("div", { class: "tbl-box" }, tag, h("div", { class: "tbl-wrap" }, grid));
}
