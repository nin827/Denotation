import { validate, defaultScalar, coerceScalar } from "../schema.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openModal } from "./modal.js";
import { scalarInput } from "./inputs.js";
import { parseType, validate as validateJson, defaultFor, clamp, shapeIndex, shapeLabel, formatType, issueText } from "../typespec.js";

export function openValueEditor(col, value, onSave) {
  if (col.type === "json") return openJsonEditor(col, value, onSave);
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

// ---------- Custom (JSON) columns: generated nested form + raw JSON tab (ticket 010) ----------

const cloneJson = (v) => v === undefined ? null : JSON.parse(JSON.stringify(v));
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const getIn = (root, path) => path.reduce((v, k) => v == null ? undefined : v[k], root);
let jeUid = 0;

/** Icon + text list of a value's issues against its type (empty list = a quiet "matches" line). */
export function issuesNode(issues, { max = 8 } = {}) {
  if (!issues.length) return h("p", { class: "je-ok" }, ico("circle-check"), " Matches the type");
  return h(
    "ul",
    { class: "je-issues", role: "status" },
    issues.slice(0, max).map((i) => h("li", {}, ico("triangle-exclamation-point"), h("span", {}, issueText(i)))),
    issues.length > max ? h("li", { class: "hint" }, `…and ${issues.length - max} more`) : null
  );
}

/**
 * The editor of one JSON value against a spec: a Form tab built from the type and a Raw JSON tab.
 * onChange(value) runs after every edit with the current value (null when the raw text is empty).
 * Returns { el, value(), rawError() }: rawError() is the parse error of the raw tab, or "".
 */
export function jsonEditor({ spec, value, onChange = () => {}, label = "Value" }) {
  let draft = value == null ? defaultFor(spec) : cloneJson(value);
  let mode = "form";
  let rawErr = "";
  const id = ++jeUid;
  const form = h("div", { class: "je-form", id: `je-form-${id}` });
  const rawArea = h("textarea", { class: "je-raw", rows: 10, spellcheck: false, "aria-label": `${label} as JSON` });
  const rawNote = h("p", { class: "je-raw-err", role: "status" });
  const rawBox = h("div", { class: "je-rawbox", id: `je-raw-${id}`, hidden: true }, rawArea, rawNote);
  const issuesBox = h("div", { class: "je-status" });
  const notes = new Map(); // path -> clamp note, shown once after a commit
  const changed = () => {
    issuesBox.replaceChildren(issuesNode(validateJson(spec, draft)));
    onChange(draft);
  };
  const setIn = (path, v) => {
    if (!path.length) {
      draft = v;
      return;
    }
    const parent = getIn(draft, path.slice(0, -1));
    if (parent && typeof parent === "object") parent[path[path.length - 1]] = v;
  };
  const pathText = (path) => path.join(".");
  const flag = (text) => h("span", { class: "je-flag" }, ico("triangle-exclamation-point"), ` ${text}`);
  const iconBtn = (icon, title, onClick, extra = {}) => h("button", { type: "button", class: "icon", title, "aria-label": title, onClick, ...extra }, ico(icon));
  const replaceBtn = (text, spec2, path) => h("button", { type: "button", class: "je-fix", onClick: () => {
    setIn(path, defaultFor(spec2));
    redraw();
    changed();
  } }, text);

  function field(s, path, name) {
    const v = getIn(draft, path);
    const aria = name || label;
    switch (s.kind) {
      case "string": {
        const bad = typeof v !== "string";
        return h("div", { class: "je-leaf" }, h("input", { type: "text", "aria-label": aria, value: bad ? (v == null ? "" : JSON.stringify(v)) : v, onInput: (e) => {
          setIn(path, e.target.value);
          changed();
        } }), bad && v != null ? flag("not text") : null);
      }
      case "bool":
        return h("label", { class: "je-check" }, h("input", { type: "checkbox", checked: v === true, onChange: (e) => {
          setIn(path, e.target.checked);
          changed();
        } }), h("span", {}, v === true ? "Yes" : "No"), typeof v !== "boolean" && v != null ? flag("not yes/no") : null);
      case "int":
      case "float": {
        const step = s.kind === "int" ? "1" : "any";
        const hasRange = s.min !== undefined && s.max !== undefined;
        const note = h("span", { class: "je-note", role: "status" }, notes.get(pathText(path)) || "");
        notes.delete(pathText(path));
        const numInput = h("input", {
          type: "number", step, inputmode: s.kind === "int" ? "numeric" : "decimal", "aria-label": aria,
          min: s.min ?? null, max: s.max ?? null,
          value: typeof v === "number" ? String(v) : ""
        });
        const slider = hasRange ? h("input", { type: "range", min: s.min, max: s.max, step: s.kind === "int" ? 1 : (s.max - s.min) / 100 || "any", "aria-label": `${aria} slider`, value: typeof v === "number" ? String(v) : String(s.min) }) : null;
        const read = (t) => t.trim() === "" ? null : Number(t);
        numInput.addEventListener("input", () => {
          const n = read(numInput.value);
          setIn(path, Number.isFinite(n) ? n : null);
          if (slider && Number.isFinite(n)) slider.value = String(n);
          note.textContent = "";
          changed();
        });
        numInput.addEventListener("change", () => {
          const n = read(numInput.value);
          if (!Number.isFinite(n)) return;
          const c = clamp(s, n);
          if (c !== n) {
            setIn(path, c);
            numInput.value = String(c);
            if (slider) slider.value = String(c);
            note.textContent = `Clamped to ${c}`;
            changed();
          }
        });
        slider?.addEventListener("input", () => {
          const n = Number(slider.value);
          const c = clamp(s, n);
          setIn(path, c);
          numInput.value = String(c);
          note.textContent = "";
          changed();
        });
        const range = s.min !== undefined || s.max !== undefined ? h("span", { class: "je-range" }, `${s.min ?? ""}..${s.max ?? ""}`) : null;
        const own = v != null && typeof v === "number" ? validateJson(s, v) : [];
        return h("div", { class: "je-leaf je-num" }, numInput, slider, range, note, v != null && typeof v !== "number" ? flag("not a number") : own.length ? flag(own[0].message) : null);
      }
      case "enum": {
        const known = s.choices.includes(v);
        const sel = h("select", { "aria-label": aria, value: known ? v : v == null ? "" : "__bad", onChange: (e) => {
          if (e.target.value === "__bad") return;
          setIn(path, e.target.value === "" && !s.choices.includes("") ? null : e.target.value);
          redraw();
          changed();
        } },
        v == null ? h("option", { value: "" }, "(none)") : null,
        !known && v != null ? h("option", { value: "__bad" }, `${typeof v === "string" ? v : JSON.stringify(v)} (not allowed)`) : null,
        s.choices.map((c) => h("option", { value: c }, c)));
        return h("div", { class: "je-leaf" }, sel, !known && v != null ? flag("not one of the choices") : null);
      }
      case "enumlist": {
        if (!Array.isArray(v) && v != null) return h("div", { class: "je-leaf" }, flag("not a list"), replaceBtn("Start an empty list", s, path));
        const list = v ?? [];
        return h("div", { class: "je-chips", role: "group", "aria-label": aria }, s.choices.map((c) => h("label", { class: "je-chip" }, h("input", { type: "checkbox", checked: list.includes(c), onChange: (e) => {
          const cur = Array.isArray(getIn(draft, path)) ? getIn(draft, path) : [];
          const next = e.target.checked ? [...cur.filter((x) => x !== c), c] : cur.filter((x) => x !== c);
          setIn(path, s.choices.filter((x) => next.includes(x)).concat(next.filter((x) => !s.choices.includes(x))));
          changed();
        } }), h("span", {}, c))), list.filter((x) => !s.choices.includes(x)).map((x) => flag(`${JSON.stringify(x)} is not a choice`)));
      }
      case "array": {
        if (!Array.isArray(v)) return h("div", { class: "je-leaf" }, v != null ? flag("not a list") : null, replaceBtn(v == null ? "Start a list" : "Replace with an empty list", s, path));
        const move = (i, d) => () => {
          const j = i + d;
          if (j < 0 || j >= v.length) return;
          [v[i], v[j]] = [v[j], v[i]];
          redraw(`${pathText(path)}.${j}`);
          changed();
        };
        return h(
          "div",
          { class: "je-array" },
          h("ol", { class: "je-items" }, v.map((_, i) => h(
            "li",
            { class: "je-item", "data-path": `${pathText(path)}.${i}` },
            h("span", { class: "je-idx" }, String(i + 1)),
            h("div", { class: "je-item-body" }, field(s.of, [...path, i], `${aria} item ${i + 1}`)),
            h(
              "span",
              { class: "je-item-tools" },
              iconBtn("arrow-up", "Move up", move(i, -1), { disabled: i === 0 }),
              iconBtn("arrow-down", "Move down", move(i, 1), { disabled: i === v.length - 1 }),
              iconBtn("x", "Remove item", () => {
                v.splice(i, 1);
                redraw();
                changed();
              })
            )
          ))),
          h("button", { type: "button", class: "je-add", onClick: () => {
            v.push(defaultFor(s.of));
            redraw(`${pathText(path)}.${v.length - 1}`);
            changed();
          } }, ico("plus"), " Add item")
        );
      }
      case "struct": {
        if (!isPlain(v)) return h("div", { class: "je-leaf" }, v != null ? flag("not an object") : null, replaceBtn(v == null ? "Fill in the fields" : "Replace with the fields", s, path));
        const extra = Object.keys(v).filter((k) => !s.keys.some((x) => x.key === k));
        return h(
          "div",
          { class: `je-struct${path.length ? " nested" : ""}` },
          s.keys.map(({ key, spec: sub }) => h(
            "div",
            { class: "je-field", "data-path": pathText([...path, key]) },
            h("div", { class: "je-key", title: formatType(sub) }, key, h("small", {}, formatType(sub))),
            Object.hasOwn(v, key) ? field(sub, [...path, key], key) : h("div", { class: "je-leaf" }, flag("missing"), h("button", { type: "button", class: "je-fix", onClick: () => {
              v[key] = defaultFor(sub);
              redraw();
              changed();
            } }, `Add ${key}`))
          )),
          extra.map((k) => h(
            "div",
            { class: "je-field" },
            h("div", { class: "je-key" }, k),
            h("div", { class: "je-leaf" }, h("code", { class: "je-code" }, JSON.stringify(v[k])), flag("unknown key"), iconBtn("x", `Remove ${k}`, () => {
              delete v[k];
              redraw();
              changed();
            }))
          ))
        );
      }
      case "map": {
        if (!isPlain(v)) return h("div", { class: "je-leaf" }, v != null ? flag("not an object") : null, replaceBtn("Start an empty object", s, path));
        const keys = Object.keys(v);
        return h(
          "div",
          { class: "je-array" },
          h("div", { class: "je-items" }, keys.map((k) => h(
            "div",
            { class: "je-field" },
            h("input", { type: "text", class: "je-mapkey", value: k, "aria-label": "Key", onChange: (e) => {
              const nk = e.target.value.trim();
              if (!nk || nk === k || Object.hasOwn(v, nk)) {
                e.target.value = k;
                return;
              }
              const entries = Object.entries(v).map(([x, y]) => [x === k ? nk : x, y]);
              for (const x of Object.keys(v)) delete v[x];
              Object.assign(v, Object.fromEntries(entries));
              redraw();
              changed();
            } }),
            h("div", { class: "je-item-body" }, field(s.of, [...path, k], k)),
            iconBtn("x", `Remove ${k}`, () => {
              delete v[k];
              redraw();
              changed();
            })
          ))),
          h("button", { type: "button", class: "je-add", onClick: () => {
            let n = keys.length + 1;
            while (Object.hasOwn(v, `key${n}`)) n++;
            v[`key${n}`] = defaultFor(s.of);
            redraw();
            changed();
          } }, ico("plus"), " Add entry")
        );
      }
      case "union": {
        const at = shapeIndex(s, v);
        const labels = s.alts.map(shapeLabel);
        const named = labels.map((l, i) => labels.filter((x) => x === l).length > 1 ? `${l} ${labels.slice(0, i + 1).filter((x) => x === l).length}` : l);
        return h(
          "div",
          { class: "je-union" },
          h("div", { class: "seg je-shape", role: "group", "aria-label": `${aria} shape` }, s.alts.map((alt, i) => h("button", {
            type: "button",
            "aria-pressed": String(i === at),
            title: formatType(alt),
            onClick: () => {
              if (i === shapeIndex(s, getIn(draft, path))) return;
              setIn(path, defaultFor(alt));
              redraw();
              changed();
            }
          }, named[i]))),
          at < 0 ? h("div", { class: "je-leaf" }, v == null ? h("span", { class: "hint" }, "Pick a shape") : flag("does not match any shape")) : field(s.alts[at], path, name)
        );
      }
      default: {
        // free JSON (any / Dictionary without fields): a small JSON box
        const box = h("textarea", { class: "je-mini", rows: 2, spellcheck: false, "aria-label": aria, value: v === undefined ? "" : JSON.stringify(v) });
        const err = h("span", { class: "je-note" });
        box.addEventListener("input", () => {
          if (!box.value.trim()) {
            setIn(path, null);
            err.replaceChildren();
            changed();
            return;
          }
          try {
            setIn(path, JSON.parse(box.value));
            err.replaceChildren();
            changed();
          } catch {
            err.replaceChildren(flag("not valid JSON yet"));
          }
        });
        return h("div", { class: "je-leaf je-anybox" }, box, err);
      }
    }
  }
  function redraw(focusPath) {
    form.replaceChildren(field(spec, [], label));
    if (focusPath) form.querySelector(`[data-path="${CSS.escape(focusPath)}"] :is(input,select,textarea,button)`)?.focus();
  }
  const setMode = (m) => {
    if (m === mode) return;
    if (m === "form") {
      if (rawErr) {
        rawNote.replaceChildren(ico("triangle-exclamation-point"), ` ${rawErr} Fix it to go back to the form.`);
        return;
      }
      redraw();
    } else {
      rawArea.value = draft == null ? "" : JSON.stringify(draft, null, 2);
      rawNote.replaceChildren();
    }
    mode = m;
    form.hidden = m !== "form";
    rawBox.hidden = m !== "raw";
    for (const b of tabs.children) b.setAttribute("aria-pressed", String(b.dataset.mode === m));
  };
  rawArea.addEventListener("input", () => {
    const t = rawArea.value;
    if (!t.trim()) {
      rawErr = "";
      draft = null;
      rawNote.replaceChildren(h("span", { class: "hint" }, "Empty: the cell will be cleared."));
      changed();
      return;
    }
    try {
      draft = JSON.parse(t);
      rawErr = "";
      rawNote.replaceChildren();
      changed();
    } catch (e) {
      rawErr = `Not valid JSON: ${e.message}.`;
      rawNote.replaceChildren(ico("triangle-exclamation-point"), ` ${rawErr}`);
    }
  });
  const tabs = h(
    "div",
    { class: "seg je-tabs", role: "group", "aria-label": "Editor" },
    h("button", { type: "button", "data-mode": "form", "aria-pressed": "true", "aria-controls": form.id, onClick: () => setMode("form") }, ico("list"), " Form"),
    h("button", { type: "button", "data-mode": "raw", "aria-pressed": "false", "aria-controls": rawBox.id, onClick: () => setMode("raw") }, ico("braces"), " Raw JSON")
  );
  redraw();
  issuesBox.replaceChildren(issuesNode(validateJson(spec, draft)));
  const el = h("div", { class: "je" }, tabs, form, rawBox, issuesBox);
  return { el, value: () => draft, rawError: () => rawErr };
}

/** Dialog editor of a Custom (JSON) cell. Values that do not match the type are saved as written and flagged. */
export function openJsonEditor(col, value, onSave) {
  const r = parseType(col.typeText ?? "");
  const spec = r.ok ? r.spec : { kind: "any" };
  const ed = jsonEditor({ spec, value, label: col.name });
  openModal({
    title: col.name,
    content: h(
      "div",
      { class: "je-modal" },
      h("p", { class: "hint je-type" }, ico("braces"), " ", h("code", {}, col.typeText?.trim() || "any")),
      r.ok ? null : h("p", { class: "je-flag" }, ico("triangle-exclamation-point"), ` The column type does not parse (${r.error}); editing as plain JSON.`),
      ed.el
    ),
    actions: [
      { label: "Clear", run: () => onSave(null) },
      { label: "Cancel" },
      { label: "Save", class: "primary", run: () => {
        if (ed.rawError()) throw new Error(ed.rawError());
        onSave(cloneJson(ed.value()));
      } }
    ]
  });
}
