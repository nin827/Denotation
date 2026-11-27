import { validate, defaultScalar, coerceScalar } from "../schema.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openModal } from "./modal.js";
import { scalarInput } from "./inputs.js";

export function openValueEditor(col, value, onSave) {
  return col.type === "dictionary" ? openDictionaryEditor(col, value, onSave) : openArrayEditor(col, value, onSave);
}
function saveAction(col, getDraft, onSave) {
  return {
    label: "Save",
    class: "primary",
    run: () => {
      const r = validate(col, getDraft());
      if (!r.ok) throw new Error(r.error);
      onSave(r.value);
    }
  };
}
function openArrayEditor(col, value, onSave) {
  const cfg = col.config || {};
  const itemType = cfg.itemType || "text";
  const fixed = cfg.size != null;
  const items = [...value || []];
  const list = h("div", { class: "ve-list" });
  const draw = () => {
    list.replaceChildren(...items.map((item, i) => h(
      "div",
      { class: "ve-row" },
      h("span", { class: "ve-idx" }, i + 1),
      scalarInput(itemType, item, (v) => {
        items[i] = v;
      }),
      fixed ? null : h("button", { class: "icon", title: "Remove item", onClick: () => {
        items.splice(i, 1);
        draw();
      } }, ico("x"))
    )));
  };
  draw();
  const content = h(
    "div",
    {},
    h("p", { class: "hint" }, fixed ? `Fixed size: exactly ${cfg.size} ${itemType} items.` : `Any number of ${itemType} items.`),
    list,
    fixed ? null : h("button", { onClick: () => {
      items.push(defaultScalar(itemType));
      draw();
    } }, ico("plus"), " Add item")
  );
  openModal({
    title: col.name,
    content,
    actions: [{ label: "Cancel" }, saveAction(col, () => items, onSave)]
  });
}
function openDictionaryEditor(col, value, onSave) {
  const cfg = col.config || {};
  return cfg.mode === "strict" ? openStrictDictionary(col, cfg, value, onSave) : openLooseDictionary(col, value, onSave);
}
function openStrictDictionary(col, cfg, value, onSave) {
  const draft = { ...value || {} };
  const rows = (cfg.fields || []).map((f) => h(
    "div",
    { class: "ve-row" },
    h("div", { class: "ve-key" }, f.key, h("small", {}, f.type)),
    scalarInput(f.type, draft[f.key], (v) => {
      draft[f.key] = v;
    })
  ));
  openModal({
    title: col.name,
    content: h(
      "div",
      {},
      h("p", { class: "hint" }, "Strict: these keys are fixed and each value is typed."),
      h("div", { class: "ve-list" }, rows)
    ),
    actions: [{ label: "Cancel" }, saveAction(col, () => draft, onSave)]
  });
}
const typeOfValue = (v) => typeof v === "number" ? "number" : typeof v === "boolean" ? "checkbox" : "text";
function openLooseDictionary(col, value, onSave) {
  const entries = Object.entries(value || {}).map(([key, v]) => ({ key, type: typeOfValue(v), value: v }));
  const list = h("div", { class: "ve-list" });
  const draw = () => {
    list.replaceChildren(...entries.map((e, i) => h(
      "div",
      { class: "ve-row" },
      h("input", { type: "text", value: e.key, placeholder: "key", onInput: (ev) => {
        e.key = ev.target.value;
      } }),
      h("select", {
        value: e.type,
        onChange: (ev) => {
          e.type = ev.target.value;
          try {
            e.value = coerceScalar(e.type, e.value);
          } catch {
            e.value = defaultScalar(e.type);
          }
          draw();
        }
      }, ["text", "number", "checkbox"].map((t) => h("option", { value: t }, t))),
      scalarInput(e.type, e.value, (v) => {
        e.value = v;
      }),
      h("button", { class: "icon", title: "Remove key", onClick: () => {
        entries.splice(i, 1);
        draw();
      } }, ico("x"))
    )));
  };
  draw();
  const build = () => {
    const out = {};
    for (const e of entries) {
      if (e.key.trim() === "") throw new Error("Keys cannot be empty");
      if (e.key in out) throw new Error(`Duplicate key "${e.key}"`);
      try {
        out[e.key] = coerceScalar(e.type, e.value);
      } catch (err) {
        throw new Error(`${e.key}: ${err.message}`);
      }
    }
    return out;
  };
  openModal({
    title: col.name,
    content: h(
      "div",
      {},
      h("p", { class: "hint" }, "Loose: add any keys; values can be text, number or checkbox."),
      list,
      h("button", { onClick: () => {
        entries.push({ key: "", type: "text", value: "" });
        draw();
      } }, ico("plus"), " Add key")
    ),
    actions: [{ label: "Cancel" }, saveAction(col, build, onSave)]
  });
}
