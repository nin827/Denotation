import { needsValue, opsFor, OP_LABEL } from "../dbviews.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openModal } from "./modal.js";

export function openDbOptions(kind, a, { onDone, redraw }) {
  const { db, view: view } = a;
  const box = h("div", { class: "opt-list" });
  const fill = (...kids) => box.replaceChildren(...kids.filter(Boolean));
  const colSelect = (value, onChange) => h(
    "select",
    { "aria-label": "Property", value, onChange: (e) => onChange(e.target.value) },
    db.columns.map((c) => h("option", { value: c.id }, c.name))
  );
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
            opsFor(col).map((op) => h("option", { value: op }, OP_LABEL[op]))
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
          redraw();
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
      h("p", { class: "hint" }, "Choose which properties this view shows. The first property is the title and always stays."),
      ...db.columns.map((c, i) => h(
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
      ))
    );
  }
  ({ filter: drawFilter, sort: drawSort, props: drawProps })[kind]();
  return openModal({
    title: { filter: "Filter rows", sort: "Sort rows", props: "Properties" }[kind],
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
      { label: "Done", class: "primary" }
    ],
    onClose: onDone
  });
}
