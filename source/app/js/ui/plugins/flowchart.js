// Plug-in module (flowchart): registers the `flow` block body (registerBlockType in ../blockTypes.js) and the /Flowchart
// slash entry (push onto CATALOG in ../../blocks/catalog.js). Imported once by app.js. Layout maths: ../../flow/layout.js.
import { CATALOG } from "../../blocks/catalog.js";
import { newBlock } from "../../blocks/model.js";
import { registerBlockType } from "../blockTypes.js";
import { flowBody } from "../flowBlock.js";

registerBlockType("flow", flowBody);

/** A small starter chart so the new block shows something to edit. */
const starter = () => ({
  layout: "flow", dir: "down", rotate: 0, turn: "cw", spacing: "normal",
  nodes: [
    { id: "start", text: "Start", shape: "pill", hue: 150 },
    { id: "ready", text: "Ready?", shape: "diamond" },
    { id: "wait", text: "Wait", shape: "rounded" },
    { id: "go", text: "Do the thing", shape: "rect" },
    { id: "done", text: "Done", shape: "pill", hue: 240 }
  ],
  edges: [
    { from: "start", to: "ready" },
    { from: "ready", to: "go", label: "yes" },
    { from: "ready", to: "wait", label: "no", style: "dashed" },
    { from: "wait", to: "ready" },
    { from: "go", to: "done" }
  ]
});

if (!CATALOG.some((e) => e.id === "flow")) {
  CATALOG.push({
    id: "flow", label: "Flowchart", group: "Advanced", keywords: "flowchart flow chart diagram process graph nodes arrows decision cycle tree timeline",
    make: () => newBlock("flow", starter()), icon: "workflow"
  });
}
