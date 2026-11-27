// Plug-in module (charts): registers the {{chart:<json>}} chip kind (registerChipKind in ../inlineChips.js), the `chart` block
// body (registerBlockType in ../blockTypes.js) and the /Inline chart and /Chart block slash entries (push onto CATALOG in
// ../../blocks/catalog.js). Imported once by app.js. Maths: ../../chart/chart.js (pure); drawing, live data, editor: ../chartUi.js.
import { h } from "../dom.js";
import { ico } from "../../icons/index.js";
import { registerChipKind } from "../inlineChips.js";
import { registerBlockType } from "../blockTypes.js";
import { setBlockMenu } from "../blockExtras.js";
import { toast } from "../dialogs.js";
import { CATALOG } from "../../blocks/catalog.js";
import { newBlock } from "../../blocks/model.js";
import { buildToken, scanTokens, tokenFallback } from "../../blocks/inline.js";
import { KINDS, SIZES, HUES, cleanSpec, specJson, specFromJson, sourceOf, describe, plainText, literalData } from "../../chart/chart.js";
import { watchChart, chipNodes, blockNode, openChartEditor, lastResolved } from "../chartUi.js";

const SPEC_KEYS = ["k", "s", "n", "l", "d", "c", "v", "a", "f", "h", "t", "m", "z"];
const INLINE_STARTER = { k: "spark", n: [3, 5, 4, 8, 6, 9, 12], h: 240 };
const BLOCK_STARTER = { k: "bar", n: [12, 19, 8, 15, 22], l: ["Mon", "Tue", "Wed", "Thu", "Fri"], h: 240, z: "m" };

// ---------- inline chip ----------
const specOfChip = new WeakMap();

function render(n, ctx) {
  const wrap = h("span", { class: "ichip-wrap" });
  const spec = specFromJson(n.args[0]);
  if (!spec) {
    wrap.append(h("span", { class: "ichip ichip-miss", title: "This chart's data is not valid" }, ico("info"), h("span", {}, "Chart error")));
    return wrap;
  }
  watchChart(wrap, spec, ctx, (data) => {
    const desc = describe(spec, data);
    const btn = h("button", {
      type: "button", class: `ichip ichip-btn ichip-chart${data.error ? " ichip-err" : ""}`, "data-tok": "chart", "aria-label": desc, title: desc, disabled: !!ctx.locked
    }, ...chipNodes(spec, data));
    specOfChip.set(btn, spec);
    wrap.replaceChildren(btn);
  }, n.args[0]);
  return wrap;
}

/** Markdown export, search and copy: the numbers (database and formula charts use what the chip last showed). */
function exportText(n) {
  const spec = specFromJson(n.args[0]);
  if (!spec) return tokenFallback(n);
  if (sourceOf(spec) === "n") return plainText(spec, literalData(spec));
  return plainText(spec, lastResolved(n.args[0]) ?? { values: [], labels: [], error: "data not loaded" });
}

/** The token text for a spec, or null when it cannot sit in text (too long once escaped: it must scan back as one token). */
function tokenOf(spec) {
  const token = buildToken("chart", [specJson(spec)]);
  if (!token) return null;
  const back = scanTokens(token);
  return back.length === 1 && back[0].end === token.length ? token : null;
}

/** Click or Enter on a chip (called by chipAction in ../inlineChips.js): edit it, then rewrite its token. */
function act(el, ctx, apply) {
  const spec = specOfChip.get(el);
  if (!spec) return;
  openChartEditor({
    spec, ctx,
    onSave: (sp) => {
      if (!sp) return;
      const token = tokenOf(sp);
      if (!token) return toast("That chart is too large to place inside text.", "error");
      apply(token);
    }
  });
}

/** Slash entry /Inline chart: the editor opens with a sample; Insert (or Esc after a change) adds the chip. */
function pick(ctx, { onPick, onCancel } = {}) {
  openChartEditor({
    spec: INLINE_STARTER, ctx, isNew: true,
    onSave: (sp) => {
      const token = tokenOf(sp);
      if (!token) {
        toast("That chart is too large to place inside text. Use fewer numbers, or the Chart block.", "error");
        return onCancel?.();
      }
      onPick?.(token);
    },
    onCancel
  });
}

registerChipKind("chart", { render, text: exportText, pick, action: act });

// ---------- block ----------
const choice = (label, icon, cur, options, apply) => ({
  label, icon: ico(icon), hint: options.find((o) => o.value === cur)?.label ?? null,
  items: options.map((o) => ({ label: o.label, hint: o.value === cur ? "✓ current" : null, onSelect: () => apply(o.value) }))
});

function chartBody(b, inst, a) {
  const ctx = inst.ctx;
  const locked = !!ctx.locked;
  const wrap = h("div", { class: "chart-block" });
  let stop = null;
  const assign = (spec) => {
    const clean = cleanSpec(spec, { block: true });
    for (const k of SPEC_KEYS) delete b[k];
    Object.assign(b, clean);
  };
  const mutate = (fn) => {
    const s = cleanSpec(b, { block: true });
    fn(s);
    assign(s);
    a.save();
    draw();
  };
  const edit = () => {
    if (locked) return;
    openChartEditor({ spec: cleanSpec(b, { block: true }), ctx, block: true, onSave: (sp) => {
      if (!sp) return;
      assign(sp);
      a.save();
      draw();
    } });
  };
  setBlockMenu(b, () => {
    if (locked) return [];
    return [
      { header: true, label: "Chart" },
      choice("Type", "chart-column", b.k, KINDS.map((x) => ({ value: x.id, label: x.label })), (v) => mutate((s) => { s.k = v; })),
      choice("Colour", "palette", b.h, [...HUES.map(([value, label]) => ({ value, label })), { value: "grey", label: "Grey" }], (v) => mutate((s) => { s.h = v; })),
      choice("Size", "ruler", b.z, SIZES.map((x) => ({ value: x.id, label: x.label })), (v) => mutate((s) => { s.z = v; })),
      { separator: true },
      { label: "Edit chart…", icon: ico("pencil"), onSelect: edit }
    ];
  });
  function draw() {
    stop?.();
    assign(b);
    const spec = cleanSpec(b, { block: true });
    stop = watchChart(wrap, spec, ctx, (data) => {
      const desc = describe(spec, data);
      wrap.replaceChildren(blockNode(spec, data));
      wrap.setAttribute("aria-label", locked ? desc : `${desc}. Press Enter to edit the chart.`);
      if (spec.t) wrap.title = spec.t;
    }, b.id);
  }
  wrap.setAttribute("role", locked ? "img" : "button");
  if (!locked) {
    wrap.tabIndex = 0;
    wrap.addEventListener("click", edit);
    wrap.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === wrap) {
        e.preventDefault();
        edit();
      }
    });
  }
  draw();
  return wrap;
}
registerBlockType("chart", chartBody);

// ---------- slash entries ----------
if (!CATALOG.some((e) => e.id === "ichart")) {
  CATALOG.push({
    id: "ichart", label: "Inline chart", group: "Inline", keywords: "chart sparkline bar pie progress graph mini inline chip data trend percent",
    make: () => null, inline: "chart", icon: "chart-line"
  });
}
if (!CATALOG.some((e) => e.id === "chart")) {
  CATALOG.push({
    id: "chart", label: "Chart block", group: "Advanced", keywords: "chart graph bar line pie progress sparkline plot data statistics block",
    make: () => newBlock("chart", { ...BLOCK_STARTER }), icon: "chart-column"
  });
}
