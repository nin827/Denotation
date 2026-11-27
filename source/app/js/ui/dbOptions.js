import { needsValue, opsFor, OP_LABEL, pathCol } from "../dbviews.js";
import { specOf, leafPaths } from "../typespec.js";
import { DISPLAY_MODES, DISPLAY_LABEL, columnDisplay, setViewDisplay } from "../columns.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openModal } from "./modal.js";
import { ROW_HEIGHT_MODES, rowHeightInfo, parseSizeField, SIZE_RANGES } from "../sizes.js";

export function openDbOptions(kind, a, { onDone, redraw }) {
  const { db, view: view } = a;
  const box = h("div", { class: "opt-list" });
  const fill = (...kids) => box.replaceChildren(...kids.filter(Boolean));
  const colSelect = (value, onChange) => h(
    "select",
    { "aria-label": "Property", value, onChange: (e) => onChange(e.target.value) },
    db.columns.map((c) => h("option", { value: c.id }, c.name))
  );
  let uid = 0;
  /** Dotted-path field for a Custom (JSON) column (filters and sorts read a nested field, e.g. stats.hp). */
  function pathInput(col, item, after) {
    if (col?.type !== "json") return null;
    const id = `dbo-paths-${++uid}`;
    const paths = leafPaths(specOf(col.typeText));
    return h(
      "span",
      { class: "opt-path" },
      h("input", { type: "text", list: id, class: "opt-path-input", "aria-label": "Field path (empty = whole value)", placeholder: "field path, e.g. stats.hp", value: item.path ?? "", autocomplete: "off", onChange: (e) => {
        const p = e.target.value.trim().replace(/^\.+|\.+$/g, "");
        if (p) item.path = p;
        else delete item.path;
        after();
      } }),
      h("datalist", { id }, paths.map((p) => h("option", { value: p.path })))
    );
  }
  function valueInput(col, rule) {
    const set = (v) => {
      rule.value = v;
      redraw();
    };
    if (!needsValue(rule.op)) return null;
    if (col.type === "select") {
      return h(
        "select",
        { "aria-label": "Value", value: rule.value ?? "", onChange: (e) => set(e.target.value) },
        h("option", { value: "" }, "(choose)"),
        (col.config?.options || []).map((o) => h("option", { value: o }, o))
      );
    }
    if (col.type === "json" && rule.path) col = pathCol(col, rule.path);
    const type = col.type === "number" ? "number" : col.type === "date" ? "date" : "text";
    return h("input", { type, step: type === "number" ? "any" : null, "aria-label": "Value", value: rule.value ?? "", placeholder: "Value", onInput: (e) => set(e.target.value) });
  }
  function drawFilter() {
    const rules = view.filter.rules;
    fill(
      rules.length ? null : h("p", { class: "hint" }, "No filters. Every row is shown."),
      ...rules.map((rule, i) => {
        const col = db.columns.find((c) => c.id === rule.col);
        return h(
          "div",
          { class: "opt-row" },
          i === 0 ? h("span", { class: "opt-lead" }, "Where") : h("span", { class: "opt-lead" }, view.filter.op === "or" ? "or" : "and"),
          colSelect(rule.col, (id) => {
            const c = db.columns.find((x) => x.id === id);
            rule.col = id;
            rule.op = opsFor(c)[0];
            rule.value = "";
            delete rule.path;
            redraw();
            drawFilter();
          }),
          pathInput(col, rule, () => {
            if (!opsFor(col, rule.path).includes(rule.op)) rule.op = opsFor(col, rule.path)[0];
            redraw();
            drawFilter();
          }),
          h(
            "select",
            { "aria-label": "Condition", value: rule.op, onChange: (e) => {
              rule.op = e.target.value;
              redraw();
              drawFilter();
            } },
            opsFor(col, rule.path).map((op) => h("option", { value: op }, OP_LABEL[op]))
          ),
          valueInput(col, rule),
          h("button", { class: "icon", title: "Remove filter", "aria-label": "Remove filter", onClick: () => {
            rules.splice(i, 1);
            redraw();
            drawFilter();
          } }, ico("x"))
        );
      }),
      rules.length > 1 ? h(
        "div",
        { class: "opt-row" },
        h("span", { class: "opt-lead" }, "Match"),
        h(
          "select",
          { "aria-label": "Match", value: view.filter.op, onChange: (e) => {
            view.filter.op = e.target.value;
            redraw();
            drawFilter();
          } },
          h("option", { value: "and" }, "all of these rules"),
          h("option", { value: "or" }, "any of these rules")
        )
      ) : null,
      h("button", { class: "add-rule", onClick: () => {
        const c = db.columns[0];
        rules.push({ col: c.id, op: opsFor(c)[0], value: "" });
        drawFilter();
      } }, ico("plus"), " Add filter")
    );
  }
  function drawSort() {
    const sorts = view.sorts;
    fill(
      sorts.length ? null : h("p", { class: "hint" }, "No sorting. Rows keep the order they were created in. Empty values always sort last."),
      ...sorts.map((s, i) => h(
        "div",
        { class: "opt-row" },
        h("span", { class: "opt-lead" }, i === 0 ? "Sort by" : "then by"),
        colSelect(s.col, (id) => {
          s.col = id;
          delete s.path;
          redraw();
          drawSort();
        }),
        pathInput(db.columns.find((c) => c.id === s.col), s, () => {
          redraw();
          drawSort();
        }),
        h(
          "select",
          { "aria-label": "Direction", value: s.dir, onChange: (e) => {
            s.dir = e.target.value;
            redraw();
          } },
          h("option", { value: "asc" }, "Ascending"),
          h("option", { value: "desc" }, "Descending")
        ),
        h("button", { class: "icon", title: "Remove sort", "aria-label": "Remove sort", onClick: () => {
          sorts.splice(i, 1);
          redraw();
          drawSort();
        } }, ico("x"))
      )),
      h("button", { class: "add-rule", onClick: () => {
        const used = new Set(sorts.map((s) => s.col));
        const c = db.columns.find((x) => !used.has(x.id)) ?? db.columns[0];
        sorts.push({ col: c.id, dir: "asc" });
        redraw();
        drawSort();
      } }, ico("plus"), " Add sort")
    );
  }
  function drawProps() {
    fill(
      h("p", { class: "hint" }, "Choose which properties this view shows and how. The first property is the title and always stays. Display overrides the column's own setting in this view only."),
      ...db.columns.map((c, i) => h(
        "div",
        { class: "opt-prop" },
        h(
          "label",
          { class: "opt-check" },
          h("input", {
            type: "checkbox",
            checked: i === 0 || !view.hidden.includes(c.id),
            disabled: i === 0,
            onChange: (e) => {
              view.hidden = view.hidden.filter((x) => x !== c.id);
              if (!e.target.checked) view.hidden.push(c.id);
              redraw();
            }
          }),
          ` ${c.name}`
        ),
        h(
          "select",
          { class: "opt-display", "aria-label": `Display of ${c.name} in this view`, value: view.display?.[c.id] ?? "", onChange: (e) => {
            setViewDisplay(view, c.id, e.target.value || null);
            redraw();
          } },
          h("option", { value: "" }, `Default (${DISPLAY_LABEL[columnDisplay(c)]})`),
          DISPLAY_MODES.map((m) => h("option", { value: m }, DISPLAY_LABEL[m]))
        )
      ))
    );
  }
  function drawRowHeight() {
    const cur = rowHeightInfo(view);
    const label = { compact: "Compact", normal: "Normal", tall: "Tall" };
    const set = (v, refocus = false) => {
      if (v === "normal" || v === null) delete view.rowHeight;
      else view.rowHeight = v;
      redraw();
      drawRowHeight();
      if (refocus) box.querySelector("[aria-pressed=true]")?.focus();
    };
    const err = h("p", { class: "hint", role: "alert" });
    const custom = h("input", {
      type: "text",
      class: "size-input",
      "aria-label": "Custom row height",
      placeholder: "for example 48 or 3em",
      autocomplete: "off",
      value: cur.css ?? "",
      style: "font-size:16px",
      onChange: (e) => {
        const r = parseSizeField(e.target.value, { range: SIZE_RANGES.row });
        err.textContent = r.error ?? "";
        if (r.error) return;
        set(r.value);
      }
    });
    fill(h(
      "div",
      { class: "rowh-dialog" },
      h("p", { class: "hint" }, "Row height for this view (table and sheet views). Tall rows are taller, not wrapped; use Wrap in the Layout menu for long text."),
      h("div", { class: "seg", role: "group", "aria-label": "Row height" }, ROW_HEIGHT_MODES.map((m) => h(
        "button",
        { type: "button", "aria-pressed": String(cur.mode === m), onClick: () => set(m, true) },
        cur.mode === m ? ico("check") : null,
        label[m]
      ))),
      h("label", {}, "Or a size (px, em or rem; a bare number is px)", custom),
      err
    ));
  }
  ({ filter: drawFilter, sort: drawSort, props: drawProps, rowheight: drawRowHeight })[kind]();
  return openModal({
    title: { filter: "Filter rows", sort: "Sort rows", props: "Properties", rowheight: "Row height" }[kind],
    content: box,
    actions: [
      ...kind === "filter" ? [{ label: "Clear filters", run: () => {
        view.filter.rules = [];
        redraw();
        drawFilter();
        return false;
      } }] : [],
      ...kind === "sort" ? [{ label: "Clear sorting", run: () => {
        view.sorts = [];
        redraw();
        drawSort();
        return false;
      } }] : [],
      ...kind === "props" && a.editColumnsJson ? [{ label: "Edit columns as JSON\u2026", run: () => {
        setTimeout(() => a.editColumnsJson(), 0);
      } }] : [],
      { label: "Done", class: "primary" }
    ],
    onClose: onDone
  });
}
