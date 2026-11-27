// Plug-in module (links): page links, hidden links and embeds as inline chips ({{link}}, {{xlink}}, {{embed}}; see
// js/links.js), their slash entries ("Link to page", "Embed page") and the `graph` block ("Graph"). Imported once by app.js.
import { registerChipKind } from "../inlineChips.js";
import { CATALOG } from "../../blocks/catalog.js";
import { newBlock } from "../../blocks/model.js";
import { registerBlockType } from "../blockTypes.js";
import { linkChip, linkText, embedChip, embedText } from "../linkChips.js";
import { pickLink, pickEmbed } from "../linkPicker.js";
import { graphBlockBody } from "../graphView.js";

registerChipKind("link", { render: linkChip, text: linkText, pick: (ctx, cb) => pickLink(ctx, cb, "link") });
registerChipKind("xlink", { render: linkChip, text: linkText, pick: (ctx, cb) => pickLink(ctx, cb, "xlink") });
registerChipKind("embed", { render: embedChip, text: embedText, pick: (ctx, cb) => pickEmbed(ctx, cb) });

const entry = (e) => {
  if (!CATALOG.some((x) => x.id === e.id)) CATALOG.push(e);
};
entry({ id: "ilink", label: "Link to page", group: "Inline", keywords: "link page wiki backlink [[ reference connect", make: () => null, inline: "link", icon: "link" });
entry({ id: "iembed", label: "Embed page", group: "Inline", keywords: "embed transclude include section heading blocks ![[ quote page", make: () => null, inline: "embed", icon: "file-input" });
entry({ id: "graph", label: "Graph", group: "Advanced", keywords: "graph network links map nodes local connections", make: () => newBlock("graph"), icon: "waypoints" });

registerBlockType("graph", graphBlockBody);
