// Plug-in module (math): the {{math:<latex>}} chip (registerChipKind in ../inlineChips.js), the `math` display block
// (registerBlockType in ../blockTypes.js) and the /Inline math and /Math block slash entries (CATALOG in ../../blocks/catalog.js).
// Imported once by app.js. KaTeX loads lazily on first render; see ../../math/ and ../mathUi.js.
import { registerChipKind } from "../inlineChips.js";
import { registerBlockType } from "../blockTypes.js";
import { renderInline } from "../inlineView.js";
import { CATALOG } from "../../blocks/catalog.js";
import { newBlock } from "../../blocks/model.js";
import { mathToken, mathTokens, replaceNthMath, mathText } from "../../math/latex.js";
import { mathChip, mathBody, openMathEditor } from "../mathUi.js";

/** Click / Enter on a chip: edit its source and write the token back into the block text it lives in (like typing would). */
function editChip(btn, ctx) {
  const view = btn.closest(".rendered");
  const ta = view?.parentElement?.querySelector("textarea.blk-ta");
  if (!view || !ta) return;
  const own = [...view.querySelectorAll(".ichip-math")].filter((x) => !x.closest(".embed"));
  const index = own.indexOf(btn);
  const tok = mathTokens(ta.value)[index];
  if (!tok) return;
  openMathEditor({
    latex: tok.latex,
    onSave: (latex) => {
      const next = replaceNthMath(ta.value, index, latex);
      if (next === null) return;
      ta.value = next;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      view.replaceChildren(...renderInline(next, ctx));
    },
    onClose: () => view.querySelectorAll(".ichip-math")[index]?.focus()
  });
}

registerChipKind("math", {
  render: (n, ctx) => mathChip(n.args[0], ctx, (btn) => editChip(btn, ctx)),
  /** Search, copy and Markdown export: the source between dollar signs. */
  text: (n) => mathText(n.args[0]),
  /** Slash menu: the editor first, the token is inserted when it closes with a source. */
  pick(ctx, { onPick, onCancel } = {}) {
    let picked = false;
    return openMathEditor({
      latex: "",
      onSave: (latex) => {
        const token = mathToken(latex);
        if (!token) return;
        picked = true;
        onPick?.(token);
      },
      onClose: () => {
        if (!picked) onCancel?.();
      }
    });
  }
});

registerBlockType("math", mathBody);

for (const e of [
  { id: "imath", label: "Inline math", group: "Inline", keywords: "math latex equation formula katex symbol inline chip", make: () => null, inline: "math", icon: "sigma" },
  { id: "math", label: "Math block", group: "Advanced", keywords: "math latex equation formula katex display block", make: () => newBlock("math", { text: "" }), icon: "square-radical" }
]) if (!CATALOG.some((x) => x.id === e.id)) CATALOG.push(e);
