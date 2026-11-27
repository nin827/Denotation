// The /table block: an editable grid with header row / column, per-column widths and per-row heights.
// Stored: cells, headerRow, headerCol, colWidths: [size|null], rowHeights: [size|null] (size = "320px" / "20em" / "12rem").
import { TABLE_LIMITS, tableResize } from "../blocks/model.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { isTableSource, sourceNameOf } from "../sources.js";
import { resolveSize, normSize, SIZE_RANGES } from "../sizes.js";
import { openSizeDialog, dragHandle } from "./sizing.js";

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
    resetBtn?.toggleAttribute("hidden", !(b.colWidths || b.rowHeights));
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
  const cellMenu = (r, c) => [
    { header: true, label: `Column ${c + 1}` },
    { label: "Column width…", icon: ico("move-horizontal"), hint: b.colWidths?.[c] ?? "auto", onSelect: () => askWidth(c) },
    { label: "Reset column width", icon: ico("rotate-ccw"), disabled: !b.colWidths?.[c], onSelect: () => setCol(c, null) },
    { header: true, label: `Row ${r + 1}` },
    { label: "Row height…", icon: ico("move-vertical"), hint: b.rowHeights?.[r] ?? "auto", onSelect: () => askHeight(r) },
    { label: "Reset row height", icon: ico("rotate-ccw"), disabled: !b.rowHeights?.[r], onSelect: () => setRow(r, null) },
    { header: true, label: "Headers" },
    { label: "Header row", icon: ico(b.headerRow ? "square-check" : "square"), disabled: isSource, onSelect: () => toggle("headerRow") },
    { label: "Header column", icon: ico(b.headerCol ? "square-check" : "square"), onSelect: () => toggle("headerCol") }
  ];
  const menuBtn = (kind, r, c, label) => h("button", {
    type: "button",
    class: `tbl-menu-btn ${kind}`,
    tabindex: -1,
    title: label,
    "aria-label": label,
    "aria-haspopup": "menu",
    onClick: (e) => {
      e.stopPropagation();
      openMenu(e.currentTarget, cellMenu(r, c), { width: 230 });
    }
  }, ico(kind === "col" ? "chevron-down" : "chevron-right"));
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
        } else if (!locked && (e.key === "ContextMenu" || e.key === "F10" && e.shiftKey)) {
          e.preventDefault();
          e.stopPropagation();
          openMenu(input, cellMenu(r, c), { width: 230 });
        }
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
      isHead ? { scope: colHead ? "col" : "row", class: "tbl-cell" } : { class: "tbl-cell" },
      input,
      edit && r === 0 ? menuBtn("col", r, c, `Column ${c + 1} options`) : null,
      edit && r === 0 ? colGrip(c) : null,
      edit && c === 0 ? menuBtn("row", r, c, `Row ${r + 1} options`) : null,
      edit && c === 0 ? rowGrip(r) : null
    );
  };
  const body = h("tbody", {}, b.cells.map((row, r) => {
    const tr = h("tr", {}, row.map((_, c) => cell(r, c)));
    rowEls.push(tr);
    return tr;
  }));
  const grid = h("table", { class: `tbl${locked ? "" : " tbl-edit"}` }, h("colgroup", {}, colEls), body);
  const num = (label, value, max, onChange) => h(
    "label",
    { class: "tbl-num" },
    label,
    h("input", {
      type: "number",
      min: 1,
      max,
      value,
      disabled: locked,
      onChange: (e) => {
        const n = Math.min(max, Math.max(1, Math.round(Number(e.target.value) || 1)));
        e.target.value = n;
        onChange(n);
      }
    })
  );
  const check = (label, key, disabled = false, title = null) => h(
    "label",
    { class: "tbl-check", title },
    h("input", { type: "checkbox", checked: key === "headerRow" ? headRow() : b[key], disabled: locked || disabled, onChange: (e) => {
      b[key] = e.target.checked;
      a.save();
      a.redraw();
    } }),
    label
  );
  const resetBtn = locked ? null : h("button", { type: "button", class: "tbl-reset", hidden: !(b.colWidths || b.rowHeights), title: "Back to automatic column widths and row heights", onClick: () => {
    delete b.colWidths;
    delete b.rowHeights;
    a.save();
    apply();
  } }, ico("rotate-ccw"), " Reset sizes");
  const controls = locked ? null : h(
    "div",
    { class: "tbl-controls" },
    num("Rows", b.cells.length, TABLE_LIMITS.maxRows, (n) => {
      tableResize(b, n, b.cells[0].length);
      a.save();
      a.redraw();
    }),
    num("Columns", b.cells[0].length, TABLE_LIMITS.maxCols, (n) => {
      tableResize(b, b.cells.length, n);
      a.save();
      a.redraw();
    }),
    check("Header row", "headerRow", isSource, isSource ? "A data source always uses its first row as column names" : null),
    check("Header column", "headerCol"),
    resetBtn
  );
  const tag = isSource ? h("div", { class: "tbl-source", title: "Used as a data source (first row = column names)" }, ico("database-zap"), h("span", {}, ` Data source: ${sourceNameOf(b)}`)) : null;
  apply();
  return h("div", { class: "tbl-box" }, tag, h("div", { class: "tbl-wrap" }, grid), controls);
}
