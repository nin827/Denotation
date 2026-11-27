import { h } from "./dom.js";

const cap = (s) => s[0].toUpperCase() + s.slice(1);
export function scalarInput(type, value, onInput, eventName = "input") {
  const on = `on${cap(eventName)}`;
  switch (type) {
    case "checkbox":
      return h("input", { type: "checkbox", checked: !!value, onChange: (e) => onInput(e.target.checked) });
    case "number":
      return h("input", { type: "number", step: "any", value: value ?? "", [on]: (e) => onInput(e.target.value) });
    case "date":
      return h("input", { type: "date", value: value ?? "", [on]: (e) => onInput(e.target.value) });
    default:
      return h("input", { type: "text", value: value ?? "", [on]: (e) => onInput(e.target.value) });
  }
}
