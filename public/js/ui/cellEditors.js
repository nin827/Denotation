import { isErrorValue, formatResult } from "../formula.js";
import { defaultValue, validate, summarize } from "../schema.js";
import { h } from "./dom.js";
import { scalarInput } from "./inputs.js";
import { openValueEditor } from "./valueEditors.js";

export function formulaCell(col, value, rowId) {
  return h("span", { class: `formula-val${isErrorValue(value) ? " f-err" : ""}${typeof value === "number" ? " num" : ""}`, "data-frow": rowId, "data-fcol": col.id, title: `= ${col.config?.expr || ""}` }, formatResult(value));
}
export function renderCell(col, value, commit, { wrap = false, rowId = "" } = {}) {
  if (value === void 0) value = defaultValue(col);
  const apply = (raw, el) => {
    const r = validate(col, raw);
    if (!r.ok) {
      el.classList.add("invalid");
      el.title = r.error;
      return;
    }
    el.classList.remove("invalid");
    el.title = "";
    commit(r.value);
  };
  switch (col.type) {
    case "formula":
      return formulaCell(col, value, rowId);
    case "checkbox": {
      const el = scalarInput("checkbox", value, (v) => apply(v, el));
      return el;
    }
    case "select": {
      const el = h(
        "select",
        { value: value ?? "", onChange: (e) => apply(e.target.value, el) },
        h("option", { value: "" }, ""),
        (col.config?.options || []).map((o) => h("option", { value: o }, o))
      );
      return el;
    }
    case "dictionary":
    case "array": {
      const label = () => summarize(col, value) || "(empty)";
      const btn = h("button", {
        class: "cell-btn",
        onClick: () => openValueEditor(col, value, (v) => {
          value = v;
          btn.textContent = label();
          commit(v);
        })
      }, label());
      if (wrap) btn.classList.add("wrap");
      return btn;
    }
    default: {
      if (wrap && col.type === "text") {
        const el2 = h("textarea", { class: "cell-wrap", rows: 1, value: value ?? "", onChange: (e) => apply(e.target.value, el2) });
        const fit = () => {
          el2.style.height = "auto";
          el2.style.height = `${el2.scrollHeight}px`;
        };
        el2.addEventListener("input", fit);
        el2.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            el2.blur();
          }
        });
        queueMicrotask(fit);
        requestAnimationFrame(fit);
        return el2;
      }
      const el = scalarInput(col.type, value, (raw) => apply(raw, el), "change");
      return el;
    }
  }
}
