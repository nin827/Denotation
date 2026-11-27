// Math UI: the inline chip, the display block body and the dedicated editor (LaTeX box, live preview, inline error,
// symbol palette). KaTeX loads lazily through ../math/katex.js; pure token helpers are in ../math/latex.js.
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openAnchoredEditor } from "./anchoredEditor.js";
import { toast } from "./dialogs.js";
import { setBlockMenu } from "./blockExtras.js";
import { renderLatexInto, checkLatex, ensureMathStyles } from "../math/katex.js";
import { cleanLatex, MAX_INLINE_LATEX, MAX_BLOCK_LATEX } from "../math/latex.js";

// § marks where the caret goes (the selection is wrapped there); other § become empty.
export const PALETTE = [
  { group: "Structure", items: [
    ["a/b", "Fraction", "\\frac{§}{§}"], ["√", "Square root", "\\sqrt{§}"], ["ⁿ√", "Nth root", "\\sqrt[§]{§}"],
    ["x²", "Power", "^{§}"], ["xₙ", "Subscript", "_{§}"], ["( )", "Brackets that grow", "\\left(§\\right)"],
    ["|x|", "Absolute value", "\\left|§\\right|"], ["x̄", "Overline", "\\overline{§}"]
  ] },
  { group: "Big operators", items: [
    ["∑", "Sum", "\\sum_{i=1}^{n} §"], ["∏", "Product", "\\prod_{i=1}^{n} §"], ["∫", "Integral", "\\int_{a}^{b} § \\, dx"],
    ["∮", "Contour integral", "\\oint §"], ["lim", "Limit", "\\lim_{x \\to \\infty} §"], ["∂", "Partial derivative", "\\frac{\\partial §}{\\partial x}"]
  ] },
  { group: "Greek", items: ["alpha", "beta", "gamma", "delta", "epsilon", "theta", "lambda", "mu", "pi", "rho", "sigma", "phi", "omega", "Delta", "Sigma", "Omega"]
    .map((n) => [{ alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", theta: "θ", lambda: "λ", mu: "μ", pi: "π", rho: "ρ", sigma: "σ", phi: "φ", omega: "ω", Delta: "Δ", Sigma: "Σ", Omega: "Ω" }[n], n, `\\${n} `]) },
  { group: "Relations and arrows", items: [
    ["≤", "Less or equal", "\\le "], ["≥", "Greater or equal", "\\ge "], ["≠", "Not equal", "\\ne "], ["≈", "Approximately", "\\approx "],
    ["±", "Plus or minus", "\\pm "], ["×", "Times", "\\times "], ["∞", "Infinity", "\\infty "], ["∈", "Element of", "\\in "],
    ["→", "Right arrow", "\\to "], ["⇒", "Implies", "\\Rightarrow "], ["⇔", "If and only if", "\\Leftrightarrow "], ["↦", "Maps to", "\\mapsto "]
  ] },
  { group: "Matrices", items: [
    ["(2×2)", "Matrix with round brackets", "\\begin{pmatrix} § & § \\\\ § & § \\end{pmatrix}"],
    ["[2×2]", "Matrix with square brackets", "\\begin{bmatrix} § & § \\\\ § & § \\end{bmatrix}"],
    ["{cases}", "Cases", "\\begin{cases} § & \\text{if } § \\\\ § & \\text{otherwise} \\end{cases}"],
    ["align", "Aligned lines", "\\begin{aligned} § &= § \\\\ &= § \\end{aligned}"]
  ] }
];

/** Put `snippet` into a textarea: § marks the caret (the selected text goes there); returns nothing, fires `input`. */
export function insertSnippet(ta, snippet) {
  const a = ta.selectionStart ?? ta.value.length;
  const b = ta.selectionEnd ?? a;
  const picked = ta.value.slice(a, b);
  const first = snippet.indexOf("§");
  const body = snippet.replace(/§/g, (m, off) => (off === first ? picked : ""));
  ta.setRangeText(body, a, b, "end");
  const caret = first < 0 ? a + body.length : a + first + picked.length;
  ta.setSelectionRange(caret, caret);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
}

const errChip = (msg) => h("span", { class: "ichip ichip-err ichip-math-err", title: msg }, ico("info"), h("span", {}, "Math error"));

/** Fill `el` with the rendered source, or an error chip (icon + text; the KaTeX message is the tooltip). */
export async function paintMath(el, latex, display) {
  const holder = h("span", { class: display ? "math-display" : "math-inline" });
  const res = await renderLatexInto(holder, latex, { display });
  if (res.ok) el.replaceChildren(holder);
  else el.replaceChildren(errChip(res.error));
  return res;
}

/**
 * The dedicated editor. Esc, a click outside and "Done" save; "Cancel" restores. onSave(latex) runs once, only when the
 * source changed (an empty source is passed on as "" so the caller can remove the chip or leave the block empty).
 */
export function openMathEditor({ latex = "", display = false, onSave, onClose, anchor }) {
  ensureMathStyles();
  const max = display ? MAX_BLOCK_LATEX : MAX_INLINE_LATEX;
  const start = latex;
  let cancelled = false;
  const ta = h("textarea", {
    class: "math-ta", rows: display ? 6 : 3, spellcheck: "false", autocapitalize: "off", autocomplete: "off", autocorrect: "off",
    "aria-label": "LaTeX source", maxlength: String(max), placeholder: "LaTeX, for example \\frac{a}{b}", value: latex
  });
  const preview = h("div", { class: `math-preview${display ? " is-display" : ""}`, "aria-live": "polite", "aria-label": "Preview" });
  const error = h("div", { class: "math-error", role: "alert" });
  let seq = 0;
  const update = async () => {
    const mine = ++seq;
    const src = ta.value.trim();
    if (!src) {
      preview.replaceChildren(h("span", { class: "math-empty" }, "Preview appears here"));
      error.replaceChildren();
      return;
    }
    const holder = h("span", {});
    const res = await renderLatexInto(holder, src, { display });
    if (mine !== seq) return;
    if (res.ok) {
      preview.replaceChildren(holder);
      error.replaceChildren();
    } else {
      preview.replaceChildren(h("span", { class: "math-empty" }, "No preview"));
      error.replaceChildren(ico("info"), h("span", {}, `LaTeX error: ${res.error}`));
    }
  };
  let timer = 0;
  ta.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(update, 120);
  });
  const palette = h("div", { class: "math-palette", role: "group", "aria-label": "Symbols" }, PALETTE.map((g) => h(
    "div", { class: "math-pal-group" },
    h("span", { class: "math-pal-title" }, g.group),
    h("span", { class: "math-pal-items" }, g.items.map(([label, name, snippet]) => h("button", {
      type: "button", class: "math-pal-btn", title: name, "aria-label": name,
      onMousedown: (e) => e.preventDefault(), // keep the caret and selection in the textarea
      onClick: () => insertSnippet(ta, snippet)
    }, label)))
  )));
  const body = h("div", { class: "math-ed" }, ta, preview, error, h("details", { class: "math-pal-wrap", open: matchMedia?.("(min-width: 600px)").matches ?? true }, h("summary", {}, "Symbols"), palette));
  const modal = openAnchoredEditor({
    anchor, width: 560,
    title: display ? "Math block" : "Inline math",
    content: body,
    actions: [{ label: "Cancel", run: () => { cancelled = true; } }, { label: "Done", class: "primary" }],
    onClose: () => {
      clearTimeout(timer);
      const next = cancelled ? start : ta.value;
      if (next !== start) onSave?.(cleanLatex(next, max));
      onClose?.();
    }
  });
  update();
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  return modal;
}

// ---------- inline chip ----------
export function mathChip(latex, ctx, onEdit) {
  const btn = h("button", {
    type: "button", class: "ichip ichip-btn ichip-math", "aria-label": `Math: ${latex}`, title: latex, disabled: !!ctx?.locked,
    "aria-haspopup": "dialog",
    onClick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!ctx?.locked) onEdit?.(btn);
    }
  }, h("span", { class: "math-loading" }, latex));
  btn.__math = true;
  paintMath(btn, latex, false).catch(() => btn.replaceChildren(errChip("KaTeX could not be loaded")));
  return btn;
}

// ---------- display block ----------
export function mathBody(b, inst, a) {
  const locked = !!inst.ctx.locked;
  if (typeof b.text !== "string") b.text = "";
  const wrap = h("div", { class: "math-block" });
  const draw = () => {
    const src = b.text.trim();
    if (!src) {
      const hint = h("button", { type: "button", class: "math-block-btn is-empty", disabled: locked, onClick: edit }, ico("sigma"), h("span", {}, locked ? "Empty equation" : "Empty equation. Click to add LaTeX."));
      wrap.replaceChildren(hint);
      return;
    }
    const btn = h("button", {
      type: "button", class: "math-block-btn", "aria-label": `Equation: ${src}`, title: locked ? src : "Edit equation", disabled: locked, "aria-haspopup": "dialog", onClick: edit
    }, h("span", { class: "math-loading" }, src));
    btn.__math = true;
    wrap.replaceChildren(btn);
    paintMath(btn, src, true).catch(() => btn.replaceChildren(errChip("KaTeX could not be loaded")));
  };
  function edit() {
    if (locked) return;
    openMathEditor({
      latex: b.text, display: true,
      onSave: (latex) => { b.text = latex; a.save(); },
      anchor: wrap,
      onClose: () => { draw(); wrap.querySelector("button")?.focus(); }
    });
  }
  setBlockMenu(b, () => [
    { header: true, label: "Math" },
    locked ? null : { label: "Edit equation…", icon: ico("pencil"), onSelect: edit },
    b.text.trim() ? { label: "Copy LaTeX", icon: ico("copy"), viewOnly: true, onSelect: async () => {
      try {
        await navigator.clipboard.writeText(b.text);
        toast("LaTeX copied");
      } catch {
        toast("Copy is not available here", "error");
      }
    } } : null
  ].filter(Boolean));
  draw();
  return wrap;
}
export { checkLatex };
