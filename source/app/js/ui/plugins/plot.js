// Plug-in module (function graphs): registers the `plot` block body (registerBlockType in ../blockTypes.js), the
// {{plot:<json>}} chip kind (registerChipKind in ../inlineChips.js) and the /Function graph and /Inline function graph
// slash entries (push onto CATALOG in ../../blocks/catalog.js). Imported once by app.js. Maths: ../../plot/plot.js.
import { CATALOG } from "../../blocks/catalog.js";
import { newBlock } from "../../blocks/model.js";
import { registerBlockType } from "../blockTypes.js";
import { registerChipKind } from "../inlineChips.js";
import { plotBody, plotChip, plotChipAction, plotAlt, pickPlot } from "../plotUi.js";
import { plotFromArg, starterPlot } from "../../plot/plot.js";

registerBlockType("plot", plotBody);
registerChipKind("plot", {
  render: plotChip,
  action: plotChipAction,
  text: (n) => {
    const spec = plotFromArg(n.args[0]);
    return spec ? `[graph: ${plotAlt(spec)}]` : "[graph]";
  },
  pick: (ctx, cbs) => pickPlot(ctx, cbs, starterPlot(true))
});

if (!CATALOG.some((e) => e.id === "plot")) {
  CATALOG.push({
    id: "plot", label: "Function graph", group: "Advanced", keywords: "function graph plot chart curve math y equals x axis grid sine parabola line",
    make: () => newBlock("plot", starterPlot()), icon: "chart-spline"
  });
}
if (!CATALOG.some((e) => e.id === "iplot")) {
  CATALOG.push({
    id: "iplot", label: "Inline function graph", group: "Inline", keywords: "function graph plot sparkline curve math inline chip",
    make: () => null, inline: "plot", icon: "chart-spline"
  });
}
