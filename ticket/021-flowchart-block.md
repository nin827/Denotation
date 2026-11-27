# 021: Flowchart block (future)

Status: future (not scheduled)
Raised: 2026-11-27

Request: a flowchart block.
- **Nodes** can set a **colour** (12-hue set or grey, label too, never colour alone), a **shape** (rectangle, rounded,
  pill, diamond/decision, circle, parallelogram/input, cylinder/data, document) and text.
- **Layout presets:** flow (layered, top-down), cycle (ring), tree, timeline/row, grid.
- **Placement is automatic** (no free dragging of positions). The user steers it instead:
  - **flow direction:** down, up, right, left;
  - **cycle rotation** (start angle) and **turn** (clockwise / counter-clockwise);
  - **order** of siblings (move earlier/later), spacing (compact/normal/roomy).
- Edges: arrow / no arrow / both, solid or dashed, optional label.

## Default plan (when scheduled)
- Block `{ type: "flow", layout, dir, rotate, turn, spacing, nodes: [{ id, text, shape, hue?, bg? }],
  edges: [{ from, to, label?, style?, arrow? }] }`, ids like other blocks (links can target nodes later).
- Pure layout module `js/flow/layout.js` (layered: longest-path ranks + barycentre ordering; cycle: ring by order;
  tree: tidy tree), unit-tested with seeded fuzz; render as SVG (escaped text), reuse the graph engine's canvas helpers
  only if they fit.
- Editing: a side list of nodes and edges (add/rename/reorder/connect), keyboard-first, works on phones.
- Optional quick syntax in a text box, e.g. `A -> B: yes`, converted to the stored form.
- Markdown export: a nested list or a fenced text form; open question whether to export Mermaid-style text.
