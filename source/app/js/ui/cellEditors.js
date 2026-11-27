import { isErrorValue, formatResult } from "../formula.js";
import { defaultValue, validate, summarize, isComposite } from "../schema.js";
import { toText } from "../dbviews.js";
import { specOf, validate as validateJson, issueText, summary } from "../typespec.js";
import { OBFUSCATED } from "../columns.js";
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { scalarInput } from "./inputs.js";
import { openValueEditor } from "./valueEditors.js";
import { openModal } from "./modal.js";

export function formulaCell(col, value, rowId) {
  return h("span", { class: `formula-val${isErrorValue(value) ? " f-err" : ""}${typeof value === "number" ? " num" : ""}`, "data-frow": rowId, "data-fcol": col.id, title: `= ${col.config?.expr || ""}` }, formatResult(value));
}
/** Plain text of a cell as the table shows it (for marquee, obfuscate and card properties). */
export function cellText(col, v) {
  if (v == null) return "";
  if (col.type === "formula") return formatResult(v);
  if (col.type === "checkbox") return v ? "Yes" : "";
  if (isComposite(col)) return summarize(col, v);
  return toText(col, v);
}
/** Issues of a Custom (JSON) value against its column type ([] for other columns or empty values). */
export const jsonIssues = (col, v) => col.type === "json" ? validateJson(specOf(col.typeText), v) : [];

// ---------- marquee (same idea as the sidebar's long titles: hold, scroll to the end, hold, repeat) ----------
const HOLD_MS = 2e3;
const SPEED = 30;
const calm = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
let mqObserver = null;
function roll(box) {
  const text = box.querySelector(".mq-text");
  if (!text) return;
  text.getAnimations?.().forEach((a) => a.cancel());
  box.classList.remove("roll");
  if (!box.isConnected || calm() || !text.animate) return;
  const over = box.scrollWidth - box.clientWidth;
  if (over <= 1) return;
  const d = over + 12;
  box.classList.add("roll");
  const travel = d / SPEED * 1e3;
  const total = HOLD_MS * 2 + travel;
  text.animate([
    { transform: "translateX(0)", offset: 0 },
    { transform: "translateX(0)", offset: HOLD_MS / total },
    { transform: `translateX(${-d}px)`, offset: (HOLD_MS + travel) / total },
    { transform: `translateX(${-d}px)`, offset: 1 }
  ], { duration: total, iterations: Infinity, easing: "linear" });
}
/** Starts (and keeps sized) the marquee of a box holding a `.mq-text` span. Still under prefers-reduced-motion. */
export function watchMarquee(box) {
  box.classList.add("mq");
  if (typeof ResizeObserver === "undefined") return box;
  mqObserver ?? (mqObserver = new ResizeObserver((entries) => {
    for (const e of entries) {
      if (!e.target.isConnected) {
        mqObserver.unobserve(e.target);
        continue;
      }
      roll(e.target);
    }
  }));
  mqObserver.observe(box);
  return box;
}
const mqText = (box, text) => {
  box.replaceChildren(h("span", { class: "mq-text" }, text));
  return watchMarquee(box);
};

/** Opens one cell's full editor in a dialog (used by "hide contents" columns, too narrow to edit in place). */
export function openCellDialog(col, value, commit, { rowId = "" } = {}) {
  let cur = value;
  const body = col.type === "formula" ? formulaCell(col, value, "") : editorCell(col, value, (v) => {
    cur = v;
  }, { rowId });
  openModal({
    title: col.name,
    content: h("div", { class: "cell-dialog" }, body),
    actions: col.type === "formula" ? [{ label: "Close" }] : [{ label: "Cancel" }, { label: "Save", class: "primary", run: () => {
      if (body.classList?.contains("invalid")) throw new Error(body.title || "That value does not fit the column.");
      commit(cur);
    } }]
  });
  requestAnimationFrame(() => body.focus?.());
}

/**
 * The editable cell of a table (and a row page). `display` is the column's display in this view:
 * "clip" | "wrap" | "marquee" | "obfuscate" | "hide"; marquee, obfuscate and hide show a face that turns into the
 * editor (or a dialog for hide) when opened. Row pages pass nothing, so they always show the real value.
 */
export function renderCell(col, value, commit, opts = {}) {
  const display = opts.display ?? (opts.wrap ? "wrap" : "clip");
  if (value === void 0) value = defaultValue(col);
  if (col.stub) return h("span", { class: "stub-cell" });
  if (opts.readOnly) return readOnlyCell(col, value, display);
  if (display === "hide" || (display === "obfuscate" || display === "marquee") && !isComposite(col)) return shellCell(col, value, commit, display, opts);
  return editorCell(col, value, commit, { ...opts, display });
}
/** A static, non-editable cell (read-only data sources): the text, obfuscated or blank per the display mode. */
function readOnlyCell(col, value, display) {
  const text = cellText(col, value);
  if (display === "hide") return h("span", { class: "cell-ro d-hide", title: "Hidden" });
  if (display === "obfuscate") return h("span", { class: "cell-ro d-obfuscate", title: "Hidden" }, text ? OBFUSCATED : "");
  return h("span", { class: `cell-ro d-${display}`, title: text }, text);
}
function shellCell(col, value, commit, display, { rowId = "" }) {
  let cur = value;
  const host = h("div", { class: "cell-shell" });
  const face = () => {
    const text = cellText(col, cur);
    const hidden = display === "obfuscate" || display === "hide";
    const el = h("div", {
      class: `cell-show d-${display}`,
      tabindex: 0,
      role: "button",
      title: hidden ? text ? `${display === "hide" ? "Hidden" : "Obfuscated"}: open to see or edit` : "Empty" : text,
      "aria-label": `${col.name}: ${hidden ? text ? "hidden value, open to see" : "empty" : text || "empty"}`
    });
    if (display === "obfuscate") el.textContent = text ? OBFUSCATED : "";
    else if (display === "marquee") mqText(el, text);
    const open = (e) => {
      e?.preventDefault?.();
      if (display === "hide" || isComposite(col)) {
        if (isComposite(col)) return openValueEditor(col, cur, (v) => {
          cur = v;
          commit(v);
          host.replaceChildren(face());
        });
        return openCellDialog(col, cur, (v) => {
          cur = v;
          commit(v);
          host.replaceChildren(face());
        }, { rowId });
      }
      if (col.type === "formula") {
        // read-only: open shows the real result until focus leaves
        el.replaceChildren(formulaCell(col, cur, ""));
        el.addEventListener("blur", () => host.replaceChildren(face()), { once: true });
        return;
      }
      const ed = editorCell(col, cur, (v) => {
        cur = v;
        commit(v);
      }, { rowId, display: "clip" });
      host.replaceChildren(ed);
      host.addEventListener("focusout", function back(ev) {
        if (host.contains(ev.relatedTarget)) return;
        host.removeEventListener("focusout", back);
        // let a pending change event commit first
        setTimeout(() => host.isConnected && host.replaceChildren(face()), 0);
      });
      ed.focus();
      ed.select?.();
    };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "F2") open(e);
    });
    return el;
  };
  host.append(face());
  return host;
}
export function editorCell(col, value, commit, { wrap = false, rowId = "", display = "clip" } = {}) {
  if (value === void 0) value = defaultValue(col);
  if (display === "wrap") wrap = true;
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
      el.setAttribute("aria-label", col.name);
      return el;
    }
    case "select": {
      const el = h(
        "select",
        { value: value ?? "", "aria-label": col.name, onChange: (e) => apply(e.target.value, el) },
        h("option", { value: "" }, ""),
        (col.config?.options || []).map((o) => h("option", { value: o }, o))
      );
      return el;
    }
    case "json":
    case "dictionary":
    case "array": {
      const btn = h("button", {
        class: `cell-btn${col.type === "json" ? " je-cell" : ""}`,
        onClick: () => openValueEditor(col, value, (v) => {
          value = v;
          paint();
          commit(v);
        })
      });
      const paint = () => {
        // wrapped cells have room for more of the value
        const text = wrap && col.type === "json" ? summary(specOf(col.typeText), value, 400) : summarize(col, value);
        const issues = jsonIssues(col, value);
        const label = display === "hide" ? "" : display === "obfuscate" ? text ? OBFUSCATED : "" : text || "(empty)";
        const face = h("span", { class: "cell-btn-text" }, label);
        btn.replaceChildren(...[issues.length ? h("span", { class: "je-bad" }, ico("triangle-exclamation-point"), h("span", { class: "sr-only" }, "Does not match the type: ")) : null, face].filter(Boolean));
        if (display === "marquee") mqText(face, label);
        btn.classList.toggle("invalid", issues.length > 0);
        const hidden = display === "hide" || display === "obfuscate";
        btn.title = issues.length ? `Does not match the type: ${issues.slice(0, 3).map(issueText).join("; ")}${issues.length > 3 ? "; …" : ""}` : hidden ? "Open to see the value" : text;
        btn.setAttribute("aria-label", `${col.name}: ${hidden ? text ? "hidden value" : "empty" : text || "empty"}${issues.length ? ", does not match the type" : ""}`);
      };
      paint();
      if (wrap) btn.classList.add("wrap");
      return btn;
    }
    default: {
      if (wrap && col.type === "text") {
        const el2 = h("textarea", { class: "cell-wrap", rows: 1, value: value ?? "", "aria-label": col.name, onChange: (e) => apply(e.target.value, el2) });
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
      el.setAttribute("aria-label", col.name);
      return el;
    }
  }
}
