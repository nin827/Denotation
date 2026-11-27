// Lazy KaTeX loader and the one place its safety options are set. The library (vendor/katex/, MIT) is imported on first use
// only; its stylesheet and css/math.css are linked then too. Works in Node (tests) where only renderToString is used.
const OPTIONS = {
  trust: false, // \href, \url, \htmlClass, \htmlStyle, \htmlData, \includegraphics and friends stay inert
  throwOnError: false,
  strict: "ignore",
  maxSize: 20, // em: no giant \rule / \rule-like boxes
  maxExpand: 200, // macro expansions: a \def loop becomes an error, not a hang
  output: "htmlAndMathml",
  errorColor: "currentColor"
};
export const MATH_OPTIONS = Object.freeze({ ...OPTIONS });

let loading = null;
/** Resolves to the KaTeX module (cached). Rejects when the vendored files cannot be loaded. */
export function loadKatex() {
  loading ??= import("../../vendor/katex/katex.esm.js").then((m) => m.default ?? m).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

let styled = false;
/** Link the KaTeX stylesheet (fonts load from vendor/katex/fonts) and css/math.css once. No-op without a document. */
export function ensureMathStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  for (const href of ["../../vendor/katex/katex.min.css", "../../css/math.css"]) {
    const url = new URL(href, import.meta.url).href;
    if ([...document.styleSheets].some((s) => s.href === url) || document.querySelector(`link[href="${url}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    document.head.append(link);
  }
}

/** Nothing here is trusted: a LaTeX source is data. A stack overflow from absurd nesting is caught like a parse error. */
function messageOf(e) {
  const m = String(e?.message ?? e ?? "Invalid LaTeX");
  return m.replace(/^KaTeX parse error:\s*/, "").slice(0, 200);
}

/** Check a source: { ok: true } or { ok: false, error } (the readable KaTeX message). Async because KaTeX loads lazily. */
export async function checkLatex(latex, { display = false } = {}) {
  const katex = await loadKatex();
  try {
    katex.renderToString(String(latex ?? ""), { ...OPTIONS, throwOnError: true, displayMode: display });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: messageOf(e) };
  }
}

/** The HTML string for a source ({ ok, html, error }); used by tests and plain-text previews, never put in the page with innerHTML. */
export async function latexToHtml(latex, { display = false } = {}) {
  const katex = await loadKatex();
  try {
    return { ok: true, html: katex.renderToString(String(latex ?? ""), { ...OPTIONS, throwOnError: true, displayMode: display }) };
  } catch (e) {
    return { ok: false, error: messageOf(e), html: "" };
  }
}

/**
 * Draw a source into `el` with DOM calls (katex.render builds nodes; no innerHTML). Returns { ok, error }; on an error `el` is left
 * empty so the caller can show its own error chip.
 */
export async function renderLatexInto(el, latex, { display = false } = {}) {
  ensureMathStyles();
  const katex = await loadKatex();
  try {
    katex.render(String(latex ?? ""), el, { ...OPTIONS, throwOnError: true, displayMode: display });
    return { ok: true };
  } catch (e) {
    el.textContent = "";
    return { ok: false, error: messageOf(e) };
  }
}
