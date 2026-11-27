import { previewFormula, formatResult, FUNCTIONS } from "../formula.js";
import { COLUMN_TYPES, SCALAR_TYPES, validateColumn } from "../schema.js";
import { newId } from "../ids.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openModal } from "./modal.js";
import { confirmDialog } from "./dialogs.js";

const FUNCTION_GROUPS = {
  Math: "SUM AVERAGE MIN MAX COUNT COUNTA COUNTBLANK PRODUCT MEDIAN LARGE SMALL ABS ROUND ROUNDUP ROUNDDOWN INT TRUNC CEILING FLOOR MOD POWER SQRT EXP LN LOG LOG10 SIGN PI FACT",
  Logic: "IF IFS AND OR NOT XOR IFERROR IFNA SWITCH ISBLANK ISNUMBER ISTEXT ISERROR",
  Text: "CONCAT CONCATENATE TEXTJOIN LEFT RIGHT MID LEN UPPER LOWER PROPER TRIM SUBSTITUTE REPLACE FIND SEARCH REPT EXACT VALUE TEXT",
  Date: "TODAY NOW DATE YEAR MONTH DAY WEEKDAY DAYS DATEDIF EDATE EOMONTH",
  Rows: "ALL INDEX SUMIF COUNTIF AVERAGEIF ROW ROWS"
};
const defaultConfig = (type) => structuredClone({
  select: { options: [] },
  dictionary: { mode: "strict", fields: [{ key: "key", type: "text" }] },
  array: { itemType: "text", size: null },
  formula: { expr: "" }
}[type] || {});
const typeOptions = (types) => types.map((t) => h("option", { value: t }, t));
export function openColumnEditor({ column, columns = [], rows = [], onSave, onDelete }) {
  const draft = column ? structuredClone(column) : { id: newId(), name: "", type: "text", config: {} };
  const configBox = h("div", {});
  const nameInput = h("input", {
    type: "text",
    value: draft.name,
    placeholder: "Column name",
    onInput: (e) => {
      draft.name = e.target.value;
    }
  });
  const typeSelect = h("select", {
    value: draft.type,
    onChange: (e) => {
      if (e.target.value !== draft.type) {
        draft.type = e.target.value;
        draft.config = defaultConfig(draft.type);
      }
      drawConfig();
    }
  }, typeOptions(COLUMN_TYPES));
  function drawConfig() {
    const c = draft.config;
    const parts = [];
    if (draft.type === "select") {
      parts.push(h(
        "label",
        {},
        "Options (one per line)",
        h("textarea", {
          rows: 5,
          value: (c.options || []).join("\n"),
          onInput: (e) => {
            c.options = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
          }
        })
      ));
    }
    if (draft.type === "formula") {
      const status = h("p", { class: "hint formula-status" });
      const input = h("textarea", {
        class: "formula-input",
        rows: 3,
        spellcheck: false,
        placeholder: 'e.g. [Price] * [Qty]   or   IF([Status]="Done", 1, 0)',
        value: c.expr || "",
        onInput: (e) => {
          c.expr = e.target.value;
          refresh();
        }
      });
      const refresh = () => {
        if (!(c.expr || "").trim()) {
          status.textContent = "Write a formula. Click a column to insert it.";
          status.classList.remove("bad");
          return;
        }
        const r = previewFormula(c.expr, columns, rows, 0);
        status.classList.toggle("bad", !r.ok);
        status.textContent = r.ok ? `Row 1 result: ${r.note ?? (formatResult(r.value) || "(blank)")}` : r.error;
      };
      const insert = (text) => {
        const a = input.selectionStart ?? input.value.length;
        const b = input.selectionEnd ?? a;
        input.value = input.value.slice(0, a) + text + input.value.slice(b);
        c.expr = input.value;
        input.focus();
        input.selectionStart = input.selectionEnd = a + text.length;
        refresh();
      };
      parts.push(
        h("label", {}, "Formula", input),
        status,
        h("div", { class: "formula-cols" }, columns.filter((x) => x.id !== draft.id).map((x) => h("button", { class: "chip-btn", type: "button", title: `Insert [${x.name}]`, onClick: () => insert(`[${x.name}]`) }, x.name))),
        h(
          "details",
          { class: "formula-help" },
          h("summary", {}, "Functions"),
          h("p", { class: "hint" }, 'Use [Column name] for this row, ALL([Column]) for every row, & to join text, dates as "YYYY-MM-DD". Errors look like #DIV/0!.'),
          Object.entries(FUNCTION_GROUPS).map(([g, names]) => h("p", {}, h("strong", {}, `${g}: `), names.split(" ").filter((n) => n in FUNCTIONS || ["IF", "IFS", "AND", "OR", "IFERROR", "IFNA", "SWITCH", "ALL", "ROW", "ROWS"].includes(n)).join(", ")))
        )
      );
      refresh();
    }
    if (draft.type === "dictionary") {
      parts.push(h(
        "label",
        {},
        "Mode",
        h(
          "select",
          {
            value: c.mode,
            onChange: (e) => {
              c.mode = e.target.value;
              if (c.mode === "strict" && !(c.fields || []).length) c.fields = [{ key: "key", type: "text" }];
              drawConfig();
            }
          },
          h("option", { value: "strict" }, "Strict: fixed keys with types"),
          h("option", { value: "loose" }, "Loose: any keys")
        )
      ));
      if (c.mode === "strict") {
        parts.push(
          h("div", { class: "ve-list" }, (c.fields || []).map((f, i) => h(
            "div",
            { class: "ve-row" },
            h("input", { type: "text", value: f.key, placeholder: "key", onInput: (e) => {
              f.key = e.target.value;
            } }),
            h("select", { value: f.type, onChange: (e) => {
              f.type = e.target.value;
            } }, typeOptions(SCALAR_TYPES)),
            h("button", { class: "icon", title: "Remove key", onClick: () => {
              c.fields.splice(i, 1);
              drawConfig();
            } }, ico("x"))
          ))),
          h("button", { onClick: () => {
            (c.fields || (c.fields = [])).push({ key: "", type: "text" });
            drawConfig();
          } }, ico("plus"), " Add key")
        );
      } else {
        parts.push(h("p", { class: "hint" }, "Keys are free-form; values can be text, number or checkbox."));
      }
    }
    if (draft.type === "array") {
      const fixed = c.size != null;
      parts.push(
        h(
          "label",
          {},
          "Item type",
          h("select", { value: c.itemType, onChange: (e) => {
            c.itemType = e.target.value;
          } }, typeOptions(SCALAR_TYPES))
        ),
        h(
          "label",
          {},
          "Size",
          h(
            "select",
            {
              value: fixed ? "fixed" : "free",
              onChange: (e) => {
                c.size = e.target.value === "fixed" ? c.size ?? 3 : null;
                drawConfig();
              }
            },
            h("option", { value: "free" }, "Free: any length"),
            h("option", { value: "fixed" }, "Fixed length")
          )
        ),
        fixed ? h(
          "label",
          {},
          "Length",
          h("input", {
            type: "number",
            min: 1,
            max: 1e3,
            value: c.size,
            onInput: (e) => {
              c.size = e.target.value === "" ? NaN : Number(e.target.value);
            }
          })
        ) : null
      );
    }
    configBox.replaceChildren(...parts);
  }
  drawConfig();
  const actions = [];
  if (onDelete) {
    actions.push({
      label: "Delete column",
      class: "danger",
      run: async () => {
        const ok = await confirmDialog(`Delete column "${draft.name}" and its data?`, { title: "Delete column", confirmLabel: "Delete column" });
        if (!ok) return false;
        await onDelete();
      }
    });
  }
  actions.push({ label: "Cancel" }, {
    label: "Save",
    class: "primary",
    run: async () => {
      draft.name = draft.name.trim();
      if (draft.type === "dictionary" && draft.config.mode === "strict") {
        for (const f of draft.config.fields || []) f.key = f.key.trim();
      }
      const err = validateColumn(draft);
      if (err) throw new Error(err);
      await onSave(draft);
    }
  });
  openModal({
    title: column ? "Edit column" : "New column",
    content: h(
      "div",
      {},
      h("label", {}, "Name", nameInput),
      h("label", {}, "Type", typeSelect),
      configBox
    ),
    actions
  });
  nameInput.focus();
}
