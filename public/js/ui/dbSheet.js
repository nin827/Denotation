import {
  toText,
  fromText,
  toTsv,
  parseTsv,
  calculate,
  CALCS,
  isNumeric,
  colWidth,
  colLetter
} from "../dbviews.js";
import { parseCsv } from "../csv.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openValueEditor } from "./valueEditors.js";
import { formulaCell, openCellDialog, jsonIssues, cellText, watchMarquee } from "./cellEditors.js";
import { headerRows, OBFUSCATED } from "../columns.js";
import { groupHeaderCell } from "./dbGroups.js";
import { toast } from "./dialogs.js";
import { bindContextMenu } from "./contextMenu.js";
import { bindRowMenu } from "./dbMenus.js";
import { frozenClass, wrapClass, displayClass, cellStyle, tableWidth, resizeHandle } from "./dbCols.js";
import { windowedRows } from "./bigLists.js";

const sel = new Map();
const RN = 38;
const COMPOSITE = (c) => c.type === "array" || c.type === "dictionary" || c.type === "json";
export function renderSheet(a) {
  const R = a.rows.length;
  const C = a.cols.length;
  const s = sel.get(a.db.id) ?? { a: { r: 0, c: 0 }, f: { r: 0, c: 0 } };
  sel.set(a.db.id, s);
  const clamp = () => {
    for (const p of [s.a, s.f]) {
      p.r = Math.max(0, Math.min(R - 1, p.r));
      p.c = Math.max(0, Math.min(C - 1, p.c));
    }
  };
  clamp();
  const range = () => ({ r1: Math.min(s.a.r, s.f.r), r2: Math.max(s.a.r, s.f.r), c1: Math.min(s.a.c, s.f.c), c2: Math.max(s.a.c, s.f.c) });
  const tbody = h("tbody");
  let rowsView = null; // windowedRows controller: only the rows near the viewport exist in a long sheet
  const cellAt = (r, c) => rowsView?.rowAt(r)?.querySelectorAll("td.sheet-cell")[c] ?? null;
  const paintClasses = () => {
    if (!rowsView) return;
    const g = range();
    const [from, to] = rowsView.range();
    for (let r = from; r < to; r++) {
      const tds = rowsView.rowAt(r)?.querySelectorAll("td.sheet-cell");
      if (!tds) continue;
      tds.forEach((td, c) => {
        const inR = r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2;
        td.classList.toggle("sel", inR);
        td.classList.toggle("focus", r === s.f.r && c === s.f.c);
      });
    }
  };
  const paint = () => {
    rowsView?.ensureVisible(s.f.r);
    paintClasses();
    cellAt(s.f.r, s.f.c)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  const select = (r, c, extend) => {
    s.f = { r, c };
    if (!extend) s.a = { r, c };
    clamp();
    paint();
    root.focus({ preventScroll: true });
  };
  const display = (col, v, rowId) => {
    if (col.stub) return document.createTextNode("");
    const mode = a.displayOf ? a.displayOf(col) : "clip";
    if (mode === "hide") return document.createTextNode("");
    if (mode === "obfuscate") return document.createTextNode(cellText(col, v) ? OBFUSCATED : "");
    if (mode === "marquee") return watchMarquee(h("div", { class: "mq-box" }, h("span", { class: "mq-text" }, cellText(col, v))));
    if (col.type === "formula") return formulaCell(col, v, rowId);
    if (col.type === "checkbox") return h("span", { class: `sheet-check${v ? " on" : ""}` }, v ? ico("check") : null);
    if (col.type === "json") {
      const bad = jsonIssues(col, v).length;
      const text = document.createTextNode(cellText(col, v));
      return bad ? h("span", { class: "je-sheet invalid", title: "Does not match the type" }, h("span", { class: "je-bad" }, ico("triangle-exclamation-point"), h("span", { class: "sr-only" }, "Does not match the type: ")), text) : text;
    }
    return document.createTextNode(toText(col, v));
  };
  const setText = (r, c, text, opts) => {
    const col = a.cols[c];
    const row = a.rows[r];
    if (!col || !row || col.type === "formula" || col.stub) return { ok: true };
    const v = fromText(col, text);
    if (v === void 0) return { ok: false, error: `${col.name}: cannot read that value.` };
    return a.setCell(row, col, v, opts);
  };
  const refreshCell = (r, c) => {
    const td = cellAt(r, c);
    if (!td) return;
    td.replaceChildren(display(a.cols[c], a.rows[r].values[a.cols[c].id], a.rows[r].id));
  };
  function edit(r, c, seed) {
    const col = a.cols[c];
    const row = a.rows[r];
    const td = cellAt(r, c);
    if (!col || !row || !td) return;
    if (col.stub) return a.toggleGroup?.(col.groupId);
    if (a.displayOf?.(col) === "hide" && !COMPOSITE(col)) {
      return openCellDialog(col, row.values[col.id], (v) => {
        const x = a.setCell(row, col, v);
        if (!x.ok) toast(x.error, "error");
        refreshCell(r, c);
      }, { rowId: row.id });
    }
    if (col.type === "formula") {
      toast("Formula cells are computed. Click the column name to edit the formula.");
      return;
    }
    if (td.querySelector("input, select")) return; // already editing (a double tap fires mousedown and dblclick)
    const cur = row.values[col.id];
    if (col.type === "checkbox") {
      a.setCell(row, col, !cur);
      refreshCell(r, c);
      return;
    }
    if (COMPOSITE(col)) {
      openValueEditor(col, cur, (v) => {
        const x = a.setCell(row, col, v);
        if (!x.ok) toast(x.error, "error");
        refreshCell(r, c);
      });
      return;
    }
    let input;
    if (col.type === "select") {
      input = h("select", {}, h("option", { value: "" }, ""), (col.config?.options || []).map((o) => h("option", { value: o }, o)));
      input.value = cur ?? "";
    } else {
      input = h("input", { type: col.type === "date" ? "date" : "text", class: "sheet-input" });
      input.value = seed !== void 0 ? seed : toText(col, cur);
    }
    let done = false;
    const finish = (commit, move) => {
      if (done) return;
      done = true;
      if (commit) {
        const res = setText(r, c, input.value);
        if (!res.ok) toast(res.error, "error");
      }
      refreshCell(r, c);
      if (move) select(Math.min(R - 1, r + move.r), Math.min(C - 1, c + move.c));
      else root.focus({ preventScroll: true });
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true, { r: e.shiftKey ? -1 : 1, c: 0 });
      } else if (e.key === "Tab") {
        e.preventDefault();
        finish(true, { r: 0, c: e.shiftKey ? -1 : 1 });
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    td.replaceChildren(input);
    input.focus();
    if (seed === void 0 && input.select) input.select();
  }
  function clear() {
    const g = range();
    let bad = 0;
    const touched = [];
    for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) {
      if (!setText(r, c, "", { defer: true }).ok) bad++;
      else if (a.rows[r] && a.cols[c] && a.cols[c].type !== "formula" && !a.cols[c].stub) touched.push(a.rows[r]);
    }
    a.commitRows(touched);
    for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) refreshCell(r, c);
    if (bad) toast(`${bad} cell${bad > 1 ? "s" : ""} cannot be empty.`, "error");
  }
  const gridText = () => {
    const g = range();
    const out = [];
    for (let r = g.r1; r <= g.r2; r++) {
      const line = [];
      for (let c = g.c1; c <= g.c2; c++) line.push(a.cols[c].stub ? "" : toText(a.cols[c], a.rows[r].values[a.cols[c].id]));
      out.push(line);
    }
    return toTsv(out);
  };
  async function paste(text) {
    let grid = parseTsv(text);
    if (!/\t/.test(text)) {
      const csv = parseCsv(text);
      if (csv.length >= 2 && csv[0].length >= 2) grid = csv;
    }
    if (!grid.length) return;
    const g = range();
    const single = grid.length === 1 && grid[0].length === 1;
    const rows = single ? Array.from({ length: g.r2 - g.r1 + 1 }, () => Array(g.c2 - g.c1 + 1).fill(grid[0][0])) : grid;
    const targets = a.rows.slice();
    while (g.r1 + rows.length > targets.length) targets.push(await a.addRow());
    let bad = 0;
    const touched = [];
    rows.forEach((line, i) => line.forEach((t, j) => {
      const c = g.c1 + j;
      const row = targets[g.r1 + i];
      if (c >= C || !row) return;
      const col = a.cols[c];
      if (col.stub || col.type === "formula") return;
      const v = fromText(col, t);
      if (v === void 0 || !a.setCell(row, col, v, { defer: true }).ok) bad++;
      else touched.push(row);
    }));
    a.commitRows(touched);
    a.redraw();
    if (bad) toast(`${bad} value${bad > 1 ? "s" : ""} skipped (invalid for the column type).`, "error");
  }
  const onKey = (e) => {
    if (!R || !C) return;
    const mod = e.ctrlKey || e.metaKey;
    const move = (dr, dc) => {
      e.preventDefault();
      select(s.f.r + dr, s.f.c + dc, e.shiftKey);
    };
    switch (e.key) {
      case "ArrowUp":
        return move(-1, 0);
      case "ArrowDown":
        return move(1, 0);
      case "ArrowLeft":
        return move(0, -1);
      case "ArrowRight":
        return move(0, 1);
      case "Tab":
        return move(0, e.shiftKey ? -1 : 1);
      case "Enter":
        e.preventDefault();
        return edit(s.f.r, s.f.c);
      case "F2":
        e.preventDefault();
        return edit(s.f.r, s.f.c);
      case "Delete":
      case "Backspace":
        e.preventDefault();
        return clear();
      case "Escape":
        return select(s.f.r, s.f.c);
      case " ":
        if (a.cols[s.f.c]?.type === "checkbox") {
          e.preventDefault();
          return edit(s.f.r, s.f.c);
        }
        break;
      default:
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      s.a = { r: 0, c: 0 };
      s.f = { r: R - 1, c: C - 1 };
      paint();
      return;
    }
    if (!mod && !e.altKey && e.key.length === 1 && !COMPOSITE(a.cols[s.f.c] || {}) && !a.cols[s.f.c]?.stub && a.displayOf?.(a.cols[s.f.c]) !== "hide" && a.cols[s.f.c]?.type !== "checkbox" && a.cols[s.f.c]?.type !== "select") {
      e.preventDefault();
      edit(s.f.r, s.f.c, e.key);
    }
  };
  const root = h("div", { class: "sheet", tabindex: 0, role: "grid", "aria-label": "Sheet", onKeydown: onKey });
  root.addEventListener("copy", (e) => {
    if (!R) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", gridText());
  });
  root.addEventListener("cut", (e) => {
    if (!R) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", gridText());
    clear();
  });
  root.addEventListener("paste", (e) => {
    if (e.target.closest?.("input,select")) return;
    e.preventDefault();
    paste(e.clipboardData.getData("text/plain"));
  });
  let touchTap = false;
  const renderRow = (r) => {
    const row = a.rows[r];
    const tds = a.cols.map((col, c) => {
      const td = h("td", {
        class: `sheet-cell t-${col.type}${frozenClass(a, c)}${wrapClass(a, col)}${displayClass(a, col)}`,
        style: cellStyle(a, col, c, RN),
        "data-r": r,
        "data-c": c,
        role: "gridcell",
        onPointerdown: (e) => {
          touchTap = e.pointerType !== "mouse";
        },
        onMousedown: (e) => {
          if (e.target.closest("input,select")) return;
          e.preventDefault();
          // touch has no double-click: a tap on the cell that is already selected edits it
          const again = touchTap && !e.shiftKey && s.f.r === r && s.f.c === c && s.a.r === r && s.a.c === c;
          select(r, c, e.shiftKey);
          if (again) return edit(r, c);
          dragging = true;
        },
        onMouseenter: () => {
          if (dragging) {
            s.f = { r, c };
            paint();
          }
        },
        onDblclick: () => edit(r, c)
      }, display(col, row.values[col.id], row.id));
      return td;
    });
    return bindRowMenu(h(
      "tr",
      {},
      h("th", { class: "sheet-rn", title: "Select row; double-click (or tap again) to open as page", onPointerdown: (e) => {
        touchTap = e.pointerType !== "mouse";
      }, onMousedown: (e) => {
        e.preventDefault();
        if (touchTap && s.a.r === r && s.f.r === r && s.a.c === 0 && s.f.c === C - 1) return a.onOpenRow?.(row.id);
        s.a = { r, c: 0 };
        s.f = { r, c: C - 1 };
        paint();
        root.focus({ preventScroll: true });
      }, onDblclick: () => a.onOpenRow?.(row.id) }, String(r + 1)),
      tds
    ), a, row);
  };
  rowsView = windowedRows(tbody, { count: R, colSpan: C + 1, estimate: [matchMedia("(hover: none)").matches ? 40 : 28, 28], render: renderRow, onRender: paintClasses });
  let dragging = false;
  const stop = () => {
    dragging = false;
  };
  document.addEventListener("mouseup", stop);
  const cleanup = new MutationObserver(() => {
    if (!root.isConnected) {
      document.removeEventListener("mouseup", stop);
      cleanup.disconnect();
    }
  });
  queueMicrotask(() => root.isConnected && cleanup.observe(root.parentNode || document.body, { childList: true, subtree: true }));
  const footer = h("tr", { class: "sheet-foot" }, h("th", {}), a.cols.map((col, ci) => {
    if (col.stub) return h("td", { class: `${frozenClass(a, ci).trim()} stub`, style: cellStyle(a, col, ci, RN) });
    const cur = a.view.calc?.[col.id] || "none";
    const val = cur === "none" ? null : calculate(col, a.rows, cur);
    const opts = CALCS.filter((k) => !k.numeric || isNumeric(col));
    const pick = h("select", {
      class: "sheet-calc",
      "aria-label": `Calculate ${col.name}`,
      onChange: async (e) => {
        a.view.calc = { ...a.view.calc || {}, [col.id]: e.target.value };
        await a.saveView?.();
        a.redraw();
      }
    }, opts.map((k) => h("option", { value: k.id, selected: k.id === cur }, k.id === "none" ? "Calculate" : k.label)));
    return h("td", { class: frozenClass(a, ci).trim(), style: cellStyle(a, col, ci, RN) }, cur !== "none" && val !== null ? h("span", { class: "calc-val" }, `${CALCS.find((k) => k.id === cur).label}: ${val}`) : null, pick);
  }));
  const cg = a.cols.map((col) => {
    const c = h("col");
    c.style.width = `${colWidth(a.view, col)}px`;
    return c;
  });
  const table = h(
    "table",
    { class: "sheet-table fixed", style: `width:${tableWidth(a, RN)}px` },
    h(
      "thead",
      {},
      h("tr", { class: "sheet-letters" }, h("th", {}), a.cols.map((col, i) => h("th", { class: frozenClass(a, i).trim(), style: cellStyle(a, col, i, RN) }, colLetter(i)))),
      headerRows(a.cols, a.groups || []).map((cells, level) => h("tr", { class: `grp-row lvl-${level}` }, h("th", { "aria-hidden": "true" }), cells.map((cell) => groupHeaderCell(a, cell, level)), h("th", { class: "grp-blank", "aria-hidden": "true" }))),
      h("tr", {}, h("th", {}), a.cols.map((col, i) => bindContextMenu(col.stub ? h("th", { class: `sheet-name stub-head${frozenClass(a, i)}`, style: cellStyle(a, col, i, RN), title: `${col.name}: collapsed group, click to expand` }, h("button", { class: "stub-btn", "aria-expanded": "false", onClick: () => a.toggleGroup(col.groupId) }, ico("chevrons-left-right"), h("span", {}, col.name))) : h("th", { class: `sheet-name${frozenClass(a, i)}${displayClass(a, col)}`, style: cellStyle(a, col, i, RN), title: "Edit column", tabindex: 0, onClick: () => a.editColumn(col), onKeydown: (e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) a.editColumn(col);
      } }, h("span", {}, col.name), resizeHandle(a, col, { colEl: cg[i], tableEl: () => table, extra: RN })), () => a.columnMenu(col))), h("th", { class: "sheet-addcol", title: "Add column", "aria-label": "Add column", onClick: () => a.editColumn(null) }, ico("plus")))
    ),
    tbody,
    h("tfoot", {}, footer)
  );
  table.prepend(h("colgroup", {}, h("col", { style: `width:${RN}px` }), cg, h("col", { style: "width:40px" })));
  root.append(
    h("div", { class: "tbl-scroll" }, table),
    h("button", { class: "add-row sheet-add", onClick: async () => {
      await a.addRow();
      sel.set(a.db.id, { a: { r: R, c: 0 }, f: { r: R, c: 0 } });
      a.redraw();
    } }, ico("plus"), " New row"),
    h("div", { class: "hint sheet-hint" }, "Arrows move, Shift extends, Enter or typing edits, Ctrl+C / V copy and paste from Excel or Sheets.")
  );
  paintClasses();
  return root;
}
