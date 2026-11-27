// Page properties panel (under the title) and the property dialog. Data rules live in ../pageProps.js.
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { openModal } from "./modal.js";
import { confirmDialog } from "./dialogs.js";
import { bindContextMenu } from "./contextMenu.js";
import { editorCell } from "./cellEditors.js";
import { PROP_TYPES, typeLabel, hasOptions, newProp, convertProp, cleanProp, cleanValue, safeUrl, PROPS_MAX } from "../pageProps.js";

const typeIcon = (type) => PROP_TYPES.find((t) => t.id === type)?.icon ?? "text-initial";

/**
 * Add or edit a property. `onSave(prop)` gets the cleaned property. `prop` null = new.
 */
export function openPropDialog(prop, onSave, { taken = [] } = {}) {
  const name = h("input", { type: "text", class: "prop-name-in", value: prop?.name ?? "", maxlength: 80, placeholder: "Status, Due date, Tags…", "aria-label": "Property name" });
  const type = h("select", { class: "prop-type-in", value: prop?.type ?? "text", "aria-label": "Property type" }, PROP_TYPES.map((t) => h("option", { value: t.id }, t.label)));
  type.value = prop?.type ?? "text";
  const options = h("textarea", { class: "prop-options-in", rows: 4, placeholder: "One option per line", "aria-label": "Options, one per line" });
  options.value = (prop?.options ?? []).join("\n");
  const optWrap = h("label", { class: "prop-opts" }, "Options (one per line)", options);
  const sync = () => {
    optWrap.hidden = !hasOptions(type.value);
  };
  type.addEventListener("change", sync);
  sync();
  openModal({
    title: prop ? "Edit property" : "Add a property",
    content: h("div", { class: "prop-dialog" }, h("label", {}, "Name", name), h("label", {}, "Type", type), optWrap),
    actions: [{ label: "Cancel" }, { label: prop ? "Save" : "Add", class: "primary prop-save", run: () => {
      const n = name.value.trim();
      if (!n) throw new Error("Give the property a name.");
      if (taken.some((t) => t.toLowerCase() === n.toLowerCase() && t.toLowerCase() !== (prop?.name ?? "").toLowerCase())) throw new Error(`There is already a property called "${n}".`);
      const opts = options.value.split("\n").map((s) => s.trim()).filter(Boolean);
      let next;
      if (!prop) next = newProp(n, type.value, opts);
      else {
        next = prop.type === type.value ? { ...prop } : convertProp(prop, type.value);
        next.name = n;
        if (hasOptions(type.value)) next.options = [...new Set([...opts])];
        next = cleanProp(next);
      }
      onSave(next);
    } }]
  });
  name.focus();
  name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.querySelector(".modal-actions .prop-save")?.click();
  });
}

/** Multi-select chooser: a checkbox list plus a field for a new option. */
function openMultiDialog(prop, onSave) {
  const chosen = new Set(prop.value ?? []);
  const list = h("div", { class: "multi-list", role: "group", "aria-label": prop.name });
  const draw = () => list.replaceChildren(...(prop.options.length ? prop.options.map((o) => h("label", { class: "multi-opt" },
    h("input", { type: "checkbox", checked: chosen.has(o), onChange: (e) => (e.target.checked ? chosen.add(o) : chosen.delete(o)) }),
    h("span", {}, o))) : [h("p", { class: "hint" }, "No options yet. Add one below.")]));
  draw();
  const add = h("input", { type: "text", maxlength: 80, placeholder: "New option", "aria-label": "New option" });
  const addIt = () => {
    const v = add.value.trim();
    if (!v) return;
    if (!prop.options.includes(v)) prop.options.push(v);
    chosen.add(v);
    add.value = "";
    draw();
  };
  add.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addIt();
    }
  });
  openModal({
    title: prop.name,
    content: h("div", { class: "multi-dialog" }, list, h("div", { class: "multi-add" }, add, h("button", { type: "button", onClick: addIt }, ico("plus"), " Add"))),
    actions: [{ label: "Cancel" }, { label: "Done", class: "primary", run: () => onSave(prop.options.filter((o) => chosen.has(o)), prop.options) }]
  });
}

/** The value editor of one property. `commit(value, patch?)` saves; `patch` may carry new options. */
function valueEditor(prop, { locked, pages, commit, openPage }) {
  const col = { id: prop.id, name: prop.name, type: prop.type, config: { options: prop.options ?? [] } };
  if (locked) {
    const text = prop.type === "checkbox" ? (prop.value ? "Yes" : "No") : prop.type === "multi" ? (prop.value ?? []).join(", ") : prop.type === "page" ? pages.find((p) => p.id === prop.value)?.title || (prop.value ? "Untitled" : "") : String(prop.value ?? "");
    if (prop.type === "url" && safeUrl(prop.value)) return h("a", { class: "prop-ro", href: safeUrl(prop.value), target: "_blank", rel: "noopener noreferrer" }, prop.value);
    return h("span", { class: "prop-ro" }, text || h("span", { class: "hint" }, "Empty"));
  }
  switch (prop.type) {
    case "text":
    case "number":
    case "date":
    case "checkbox":
    case "select":
      return editorCell(col, prop.value, (v) => commit(v));
    case "multi": {
      const btn = h("button", { type: "button", class: "prop-multi", "aria-label": `${prop.name}: ${(prop.value ?? []).join(", ") || "empty"}. Choose options`, onClick: () => openMultiDialog({ ...prop, options: [...(prop.options ?? [])] }, (v, options) => commit(v, { options })) },
        ...((prop.value ?? []).length ? prop.value.map((v) => h("span", { class: "prop-tag" }, v)) : [h("span", { class: "hint" }, "Choose…")]));
      return btn;
    }
    case "url": {
      const input = h("input", { type: "url", value: prop.value ?? "", placeholder: "https://…", "aria-label": prop.name, onChange: (e) => {
        const v = e.target.value.trim();
        const ok = !v || !!safeUrl(v);
        input.classList.toggle("invalid", !ok);
        input.title = ok ? "" : "Only http, https, mailto and relative links";
        if (ok) commit(v);
      } });
      const href = safeUrl(prop.value);
      return h("div", { class: "prop-url" }, input, href ? h("a", { class: "icon prop-open", href, target: "_blank", rel: "noopener noreferrer", title: "Open link", "aria-label": "Open link" }, ico("external-link")) : null);
    }
    case "page": {
      const sel = h("select", { "aria-label": prop.name, onChange: (e) => commit(e.target.value || null) },
        h("option", { value: "" }, ""),
        pages.map((p) => h("option", { value: p.id }, p.title || "Untitled")));
      sel.value = prop.value ?? "";
      if (prop.value && !pages.some((p) => p.id === prop.value)) sel.append(h("option", { value: prop.value, selected: true }, "(page not available)"));
      const target = pages.find((p) => p.id === prop.value);
      return h("div", { class: "prop-url" }, sel, target ? h("button", { type: "button", class: "icon prop-open", title: `Open ${target.title || "Untitled"}`, "aria-label": `Open ${target.title || "Untitled"}`, onClick: () => openPage(target.id) }, ico("arrow-up-right")) : null);
    }
    default:
      return h("span", {}, String(prop.value ?? ""));
  }
}

/**
 * The properties panel of a page. `save()` stores the page; `onChange()` runs after any change (automatic callouts).
 * Returns the element; it redraws itself.
 */
export function propsPanel(page, { locked = false, pages = () => [], save, onChange = () => {}, openPage = () => {} }) {
  const root = h("section", { class: "page-props", "aria-label": "Properties" });
  const changed = async () => {
    await save();
    onChange();
  };
  const props = () => (page.props ??= []);
  const names = () => props().map((p) => p.name);
  const move = async (i, d) => {
    const list = props();
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await changed();
    draw();
    root.querySelectorAll(".pp-name")[j]?.focus();
  };
  const edit = (prop) => openPropDialog(prop, async (next) => {
    const i = props().findIndex((p) => p.id === prop.id);
    if (i >= 0) props()[i] = next;
    await changed();
    draw();
  }, { taken: names() });
  const remove = async (prop) => {
    if (!await confirmDialog(`Delete the property "${prop.name}" and its value on this page?`, { title: "Delete property" })) return;
    page.props = props().filter((p) => p.id !== prop.id);
    if (!page.props.length) delete page.props;
    await changed();
    draw();
  };
  const menuFor = (prop, i) => [
    { label: "Edit property…", icon: ico("pencil"), onSelect: () => edit(prop) },
    { label: "Move up", icon: ico("arrow-up"), disabled: i === 0, onSelect: () => move(i, -1) },
    { label: "Move down", icon: ico("arrow-down"), disabled: i === props().length - 1, onSelect: () => move(i, 1) },
    { separator: true },
    { label: "Delete property", icon: ico("trash"), danger: true, onSelect: () => remove(prop) }
  ];
  function draw() {
    const list = page.props ?? [];
    const open = !page.propsCollapsed;
    root.hidden = !list.length;
    root.classList.toggle("collapsed", !open);
    const live = pages().filter((p) => p.id !== page.id);
    const head = h("button", {
      type: "button",
      class: "pp-toggle",
      "aria-expanded": String(open),
      onClick: async () => {
        if (open) page.propsCollapsed = true;
        else delete page.propsCollapsed;
        draw();
        if (!locked) await save();
      }
    }, h("span", { class: `pp-caret${open ? " open" : ""}` }, ico("chevron-right")), h("span", {}, "Properties"), h("span", { class: "hint" }, ` ${list.length}`));
    const rows = open ? list.map((prop, i) => {
      const nameBtn = h("button", {
        type: "button",
        class: "pp-name",
        title: locked ? typeLabel(prop.type) : `${typeLabel(prop.type)}. Click for options`,
        "aria-label": `${prop.name}, ${typeLabel(prop.type)}${locked ? "" : ", property options"}`,
        "aria-haspopup": locked ? null : "menu",
        disabled: locked,
        onClick: (e) => openMenu(e.currentTarget, menuFor(prop, i), { width: 210 })
      }, ico(typeIcon(prop.type)), h("span", { class: "pp-name-text" }, prop.name));
      if (!locked) bindContextMenu(nameBtn, () => menuFor(prop, i));
      const val = valueEditor(prop, {
        locked,
        pages: live,
        openPage,
        commit: async (v, patch = {}) => {
          if (patch.options) prop.options = patch.options;
          prop.value = cleanValue(prop.type, v, prop.options ?? []);
          await changed();
          if (prop.type === "multi" || prop.type === "page" || prop.type === "url") draw();
        }
      });
      return h("div", { class: `pp-row t-${prop.type}`, "data-prop": prop.id }, nameBtn, h("div", { class: "pp-val" }, val));
    }) : [];
    root.replaceChildren(...[
      head,
      open ? h("div", { class: "pp-list" }, rows) : null,
      open && !locked && list.length < PROPS_MAX ? h("button", { type: "button", class: "pp-add", onClick: () => addProperty() }, ico("plus"), " Add a property") : null
    ].filter(Boolean));
  }
  function addProperty() {
    openPropDialog(null, async (prop) => {
      props().push(prop);
      delete page.propsCollapsed;
      await changed();
      draw();
      root.querySelector(`[data-prop="${prop.id}"] .pp-val input, [data-prop="${prop.id}"] .pp-val select, [data-prop="${prop.id}"] .pp-val button`)?.focus();
    }, { taken: names() });
  }
  draw();
  root.addProperty = addProperty;
  return root;
}
