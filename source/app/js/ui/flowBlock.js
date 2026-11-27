// Flowchart block body: draws the laid-out chart as inline SVG (built with createElementNS, text via textContent),
// puts every setting in the block menu and offers the "Edit flowchart…" dialog (quick syntax + node / edge lists)
// and a small menu on each node. Layout maths live in ../flow/layout.js (pure).
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { setBlockMenu } from "./blockExtras.js";
import { openModal } from "./modal.js";
import { openMenu } from "./popover.js";
import { bindContextMenu } from "./contextMenu.js";
import { toast } from "./dialogs.js";
import {
  SHAPES, FLOW_HUES, cleanFlow, parseFlow, serializeFlow, layoutFlow, shapeGeometry, nextNodeId
} from "../flow/layout.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const kid of kids) if (kid != null) el.append(kid);
  return el;
};
const textNode = (s) => document.createTextNode(String(s));

const LAYOUT_LABELS = { flow: "Flow (layers)", cycle: "Cycle (ring)", tree: "Tree", row: "Row (timeline)", grid: "Grid" };
const DIR_LABELS = { down: "Down", up: "Up", right: "Right", left: "Left" };
const DIR_ICONS = { down: "arrow-down", up: "arrow-up", right: "arrow-right", left: "arrow-left" };
const SPACING_LABELS = { compact: "Compact", normal: "Normal", roomy: "Roomy" };
const TURN_LABELS = { cw: "Clockwise", ccw: "Counter-clockwise" };
const ROTATIONS = [0, 45, 90, 135, 180, 225, 270, 315];
const SHAPE_LABELS = { rect: "Rectangle", rounded: "Rounded", pill: "Pill", diamond: "Diamond (decision)", circle: "Circle", parallelogram: "Parallelogram (input)", cylinder: "Cylinder (data)", document: "Document" };
const ARROW_LABELS = { end: "Arrow →", none: "No arrow —", both: "Both ↔" };
const hueName = (v) => (v === "grey" ? "Grey" : FLOW_HUES.find((x) => x[0] === v)?.[1] ?? "");
const swatch = (v) => (v === "grey" ? "var(--muted)" : `oklch(0.64 0.15 ${v})`);
const short = (s, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s) || "(empty)";

export function flowBody(b, inst, a) {
  const locked = !!inst.ctx.locked;
  Object.assign(b, cleanFlow(b));
  const wrap = h("div", { class: "flow" });
  const markerId = `flow-arrow-${String(b.id).replace(/[^\w-]/g, "")}`;

  /** Change the chart through a cleaned copy (dangling edges vanish by themselves), then save and redraw. */
  const mutate = (fn) => {
    const f = cleanFlow(b);
    fn(f);
    Object.assign(b, cleanFlow(f));
    a.save();
    render();
  };
  const choice = (label, icon, cur, options, apply) => ({
    label, icon: ico(icon), hint: options.find((o) => o.value === cur)?.label ?? null,
    items: options.map((o) => ({ label: o.label, hint: o.value === cur ? "✓ current" : null, onSelect: () => apply(o.value) }))
  });

  // ---------- block menu: every setting lives here ----------
  setBlockMenu(b, () => {
    if (locked) return [];
    const items = [
      { header: true, label: "Flowchart" },
      choice("Layout", "workflow", b.layout, Object.entries(LAYOUT_LABELS).map(([value, label]) => ({ value, label })), (v) => mutate((f) => { f.layout = v; }))
    ];
    if (b.layout === "cycle") {
      items.push(
        choice("Rotation", "rotate-cw", b.rotate, ROTATIONS.map((v) => ({ value: v, label: v ? `${v}°` : "0° (first node on top)" })), (v) => mutate((f) => { f.rotate = v; })),
        choice("Turn", "refresh-cw", b.turn, Object.entries(TURN_LABELS).map(([value, label]) => ({ value, label })), (v) => mutate((f) => { f.turn = v; }))
      );
    } else {
      items.push(choice("Direction", DIR_ICONS[b.dir], b.dir, Object.entries(DIR_LABELS).map(([value, label]) => ({ value, label })), (v) => mutate((f) => { f.dir = v; })));
    }
    items.push(
      choice("Spacing", "ruler", b.spacing, Object.entries(SPACING_LABELS).map(([value, label]) => ({ value, label })), (v) => mutate((f) => { f.spacing = v; })),
      { separator: true },
      { label: "Edit flowchart…", icon: ico("pencil"), onSelect: () => openEditor() }
    );
    return items;
  });

  // ---------- node menu ----------
  const nodeItems = (id) => {
    const f = cleanFlow(b);
    const i = f.nodes.findIndex((n) => n.id === id);
    const n = f.nodes[i];
    if (!n) return [];
    const colours = [{ v: undefined, label: "None" }, { v: "grey", label: "Grey" }, ...FLOW_HUES.map(([v, label]) => ({ v, label }))];
    return [
      { header: true, label: short(n.text || n.id) },
      { label: "Rename…", icon: ico("pencil"), onSelect: () => renameNode(id) },
      { label: "Shape", icon: ico("shapes"), hint: SHAPE_LABELS[n.shape], items: SHAPES.map((s) => ({ label: SHAPE_LABELS[s], hint: s === n.shape ? "✓ current" : null, onSelect: () => mutate((g) => { g.nodes.find((x) => x.id === id).shape = s; }) })) },
      { label: "Outline and text colour", icon: ico("palette"), hint: n.hue === undefined ? "None" : hueName(n.hue), items: colours.map((c) => ({ label: c.label, swatch: c.v === undefined ? null : swatch(c.v), hint: c.v === n.hue ? "✓ current" : null, onSelect: () => mutate((g) => {
        const t = g.nodes.find((x) => x.id === id);
        if (c.v === undefined) delete t.hue;
        else t.hue = c.v;
      }) })) },
      { label: "Fill", icon: ico("paint-bucket"), hint: n.bg === undefined ? "None" : hueName(n.bg), items: colours.map((c) => ({ label: c.label, swatch: c.v === undefined ? null : swatch(c.v), hint: c.v === n.bg ? "✓ current" : null, onSelect: () => mutate((g) => {
        const t = g.nodes.find((x) => x.id === id);
        if (c.v === undefined) delete t.bg;
        else t.bg = c.v;
      }) })) },
      { label: "Connect to…", icon: ico("link"), items: f.nodes.map((t) => ({ label: short(t.text || t.id), hint: t.id === id ? "itself" : null, onSelect: () => mutate((g) => { g.edges.push({ from: id, to: t.id }); }) })) },
      { label: "Copy link to box", icon: ico("link"), onSelect: () => copyBoxLink(id) },
      { separator: true },
      { label: "Move earlier", icon: ico("arrow-up"), disabled: i === 0, onSelect: () => mutate((g) => { [g.nodes[i - 1], g.nodes[i]] = [g.nodes[i], g.nodes[i - 1]]; }) },
      { label: "Move later", icon: ico("arrow-down"), disabled: i === f.nodes.length - 1, onSelect: () => mutate((g) => { [g.nodes[i + 1], g.nodes[i]] = [g.nodes[i], g.nodes[i + 1]]; }) },
      { separator: true },
      { label: "Delete node", icon: ico("trash"), danger: true, onSelect: () => mutate((g) => { g.nodes = g.nodes.filter((x) => x.id !== id); }) }
    ];
  };
  /** `[Page › text](#page-<id>~<node id>)`: opens the page and highlights the box (see focusFlowBox). */
  async function copyBoxLink(id) {
    const n = b.nodes.find((x) => x.id === id);
    const c = inst.ctx;
    if (!n || !c?.pageId) return;
    const clean = (t) => String(t ?? "").replace(/[\[\]\\\r\n]+/g, " ").trim();
    const title = clean(c.pageInfo?.(c.pageId)?.title) || "Untitled";
    const text = `[${title} › ${clean(n.text || n.id) || n.id}](#page-${c.pageId}~${n.id})`;
    try {
      await navigator.clipboard.writeText(text);
      toast("Link to box copied");
    } catch {
      toast(text);
    }
  }
  function renameNode(id) {
    const n = b.nodes.find((x) => x.id === id);
    if (!n) return;
    const input = h("input", { type: "text", value: n.text, maxlength: "200", style: "font-size:16px", "aria-label": "Node text" });
    const save = () => {
      mutate((g) => { g.nodes.find((x) => x.id === id).text = input.value; });
      m.close();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
    });
    const m = openModal({ title: "Rename node", content: h("label", {}, "Text", input), actions: [{ label: "Cancel" }, { label: "Save", class: "primary", run: () => { save(); return false; } }] });
    input.focus();
    input.select();
  }

  // ---------- drawing ----------
  function render() {
    const lay = layoutFlow(b);
    if (!lay.nodes.length) {
      wrap.replaceChildren(h("div", { class: "hint flow-empty" }, locked ? "Empty flowchart." : "Empty flowchart. Open the block menu (the ≡ handle, or right-click) and choose Edit flowchart…."));
      return;
    }
    const heads = svgEl("marker", { id: markerId, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" }, svgEl("path", { d: "M0 0L10 5L0 10z", class: "flow-head" }));
    const svg = svgEl("svg", { class: "flow-svg", viewBox: `0 0 ${lay.width} ${lay.height}`, width: lay.width, height: lay.height, role: "group", "aria-label": `Flowchart with ${lay.nodes.length} nodes and ${lay.edges.length} connections` }, svgEl("defs", {}, heads));
    const gEdges = svgEl("g", { class: "flow-edges" });
    for (const e of lay.edges) {
      const g = svgEl("g", { class: `flow-edge${e.dashed ? " is-dashed" : ""}` });
      g.append(svgEl("path", { d: e.d, "marker-end": e.arrow !== "none" ? `url(#${markerId})` : null, "marker-start": e.arrow === "both" ? `url(#${markerId})` : null }));
      if (e.label) {
        const lab = svgEl("g", { class: "flow-label" }, svgEl("rect", { x: e.mid.x - e.lw / 2, y: e.mid.y - e.lh / 2, width: e.lw, height: e.lh, rx: 4 }));
        const t = svgEl("text", { "text-anchor": "middle" });
        e.labelLines.forEach((line, i) => {
          const ts = svgEl("tspan", { x: e.mid.x, y: e.mid.y - (e.labelLines.length - 1) * 7.5 + i * 15, "dominant-baseline": "central" }, textNode(line));
          t.append(ts);
        });
        lab.append(t);
        g.append(lab);
      }
      gEdges.append(g);
    }
    svg.append(gEdges);
    for (const n of lay.nodes) {
      const attrs = { class: `flow-node${n.hue !== undefined ? n.hue === "grey" ? " is-grey" : " has-hue" : ""}${n.bg !== undefined ? n.bg === "grey" ? " bg-grey" : " has-bg" : ""}`, "data-node": n.id };
      const style = [typeof n.hue === "number" ? `--fh:${n.hue}` : "", typeof n.bg === "number" ? `--fb:${n.bg}` : ""].filter(Boolean).join(";");
      if (style) attrs.style = style;
      if (!locked) Object.assign(attrs, { tabindex: 0, role: "button", "aria-label": `${n.text || n.id} (${SHAPE_LABELS[n.shape]}). Enter opens the node menu` });
      const g = svgEl("g", attrs);
      const geo = shapeGeometry(n.shape, n.x, n.y, n.w, n.h);
      g.append(svgEl(geo.tag, { ...geo.attrs, class: "flow-shape" }));
      const t = svgEl("text", { "text-anchor": "middle" });
      n.lines.forEach((line, i) => {
        t.append(svgEl("tspan", { x: n.cx, y: n.cy + n.dy - (n.lines.length - 1) * n.lineHeight / 2 + i * n.lineHeight, "dominant-baseline": "central" }, textNode(line)));
      });
      g.append(t);
      g.append(svgEl("title", {}, textNode(n.text || n.id)));
      if (!locked) {
        bindContextMenu(g, () => nodeItems(n.id), { width: 230 });
        g.addEventListener("click", (e) => openMenu({ x: e.clientX, y: e.clientY }, nodeItems(n.id), { width: 230 }));
        g.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          openMenu(g, nodeItems(n.id), { width: 230 });
        });
      }
      svg.append(g);
    }
    wrap.replaceChildren(svg);
  }

  // ---------- the edit dialog ----------
  function openEditor() {
    let work = cleanFlow(b);
    const ta = h("textarea", { class: "flow-ta", rows: "9", spellcheck: "false", autocapitalize: "off", autocomplete: "off", "aria-label": "Flowchart quick syntax", style: "font-size:16px" });
    const errs = h("div", { class: "flow-errs", role: "status" });
    const nodeList = h("ul", { class: "fe-list", "aria-label": "Nodes" });
    const edgeList = h("ul", { class: "fe-list", "aria-label": "Connections" });
    const refreshText = () => {
      ta.value = serializeFlow(work);
      errs.textContent = "";
    };
    const focusLater = (sel) => queueMicrotask(() => nodeList.parentElement?.querySelector(sel)?.focus());
    const sel = (label, options, value, onChange) => {
      const s = h("select", { "aria-label": label, style: "font-size:16px" }, options.map(([v, text]) => h("option", { value: v, selected: String(v) === String(value) }, text)));
      s.addEventListener("change", () => onChange(s.value));
      return s;
    };
    const iconBtn = (name, label, onClick, cls = "icon") => {
      const btn = h("button", { type: "button", class: cls, "aria-label": label, title: label }, ico(name));
      btn.addEventListener("click", onClick);
      return btn;
    };
    function drawLists() {
      nodeList.replaceChildren(...work.nodes.map((n, i) => {
        const text = h("input", { type: "text", value: n.text, maxlength: "200", "aria-label": `Text of node ${n.id}`, style: "font-size:16px" });
        text.addEventListener("change", () => {
          n.text = text.value; // in place: the rows hold these objects
          refreshText();
        });
        return h("li", { class: "fe-row", "data-id": n.id },
          h("span", { class: "fe-id", title: "Id used in the quick syntax" }, n.id),
          text,
          sel(`Shape of node ${n.id}`, SHAPES.map((s) => [s, SHAPE_LABELS[s]]), n.shape, (v) => { n.shape = v; refreshText(); }),
          sel(`Outline and text colour of node ${n.id}`, [["", "No colour"], ["grey", "Grey"], ...FLOW_HUES.map(([v, name]) => [v, name])], n.hue ?? "", (v) => {
            if (v === "") delete n.hue;
            else n.hue = v === "grey" ? "grey" : Number(v);
            refreshText();
          }),
          sel(`Fill of node ${n.id}`, [["", "No fill"], ["grey", "Grey fill"], ...FLOW_HUES.map(([v, name]) => [v, `${name} fill`])], n.bg ?? "", (v) => {
            if (v === "") delete n.bg;
            else n.bg = v === "grey" ? "grey" : Number(v);
            refreshText();
          }),
          h("span", { class: "fe-btns" },
            iconBtn("arrow-up", `Move ${n.id} earlier`, () => { if (i) { [work.nodes[i - 1], work.nodes[i]] = [work.nodes[i], work.nodes[i - 1]]; refreshText(); drawLists(); focusLater(`[data-id="${n.id}"] [aria-label^="Move ${n.id} earlier"]`); } }),
            iconBtn("arrow-down", `Move ${n.id} later`, () => { if (i < work.nodes.length - 1) { [work.nodes[i + 1], work.nodes[i]] = [work.nodes[i], work.nodes[i + 1]]; refreshText(); drawLists(); focusLater(`[data-id="${n.id}"] [aria-label^="Move ${n.id} later"]`); } }),
            iconBtn("trash", `Delete node ${n.id}`, () => { work.nodes.splice(i, 1); work = cleanFlow(work); refreshText(); drawLists(); }, "icon danger")));
      }));
      if (!work.nodes.length) nodeList.append(h("li", { class: "hint" }, "No nodes yet."));
      const opts = work.nodes.map((n) => [n.id, `${n.id}: ${short(n.text, 18)}`]);
      edgeList.replaceChildren(...work.edges.map((e, i) => h("li", { class: "fe-row fe-edge" },
        sel(`Edge ${i + 1} from`, opts, e.from, (v) => { e.from = v; refreshText(); }),
        h("span", { class: "fe-arrow", "aria-hidden": "true" }, "→"),
        sel(`Edge ${i + 1} to`, opts, e.to, (v) => { e.to = v; refreshText(); }),
        (() => {
          const lab = h("input", { type: "text", value: e.label ?? "", maxlength: "80", placeholder: "Label", "aria-label": `Edge ${i + 1} label`, style: "font-size:16px" });
          lab.addEventListener("change", () => {
            if (lab.value.trim()) e.label = lab.value;
            else delete e.label;
            refreshText();
          });
          return lab;
        })(),
        sel(`Edge ${i + 1} line`, [["solid", "Solid"], ["dashed", "Dashed"]], e.style ?? "solid", (v) => { if (v === "dashed") e.style = "dashed"; else delete e.style; refreshText(); }),
        sel(`Edge ${i + 1} arrow`, Object.entries(ARROW_LABELS), e.arrow ?? "end", (v) => { if (v === "end") delete e.arrow; else e.arrow = v; refreshText(); }),
        iconBtn("trash", `Delete edge ${i + 1}`, () => { work.edges.splice(i, 1); refreshText(); drawLists(); }, "icon danger"))));
      if (!work.edges.length) edgeList.append(h("li", { class: "hint" }, "No connections yet."));
    }
    ta.addEventListener("change", () => {
      const p = parseFlow(ta.value);
      work = cleanFlow({ ...work, nodes: p.nodes, edges: p.edges });
      errs.textContent = p.errors.map((e) => `Line ${e.line}: ${e.message}`).join("\n");
      drawLists();
    });
    const addNode = h("button", { type: "button", class: "fe-add" }, ico("plus"), " Add node");
    addNode.addEventListener("click", () => {
      const id = nextNodeId(work.nodes);
      work.nodes.push({ id, text: "New node", shape: "rect" });
      work = cleanFlow(work);
      refreshText();
      drawLists();
      focusLater(`[data-id="${id}"] input`);
    });
    const addEdge = h("button", { type: "button", class: "fe-add" }, ico("plus"), " Add connection");
    addEdge.addEventListener("click", () => {
      if (!work.nodes.length) return;
      const n = work.nodes.length;
      work.edges.push({ from: work.nodes[n - 1 > 0 ? n - 2 : 0].id, to: work.nodes[n - 1].id });
      refreshText();
      drawLists();
    });
    const help = h("details", { class: "flow-help" }, h("summary", {}, "Quick syntax"),
      h("pre", {}, "A -> B: yes         arrow with a label\nA -- B              no arrowhead\nA <-> B             both ends\nA -.-> B            dashed\nA [diamond] Is it ok?\nA [pill blue]: Start   shape, outline colour, text\nA [bg=yellow]          fill (a colour name or grey)\nShapes: rect rounded pill diamond circle parallelogram cylinder document"));
    refreshText();
    drawLists();
    const body = h("div", { class: "flow-edit" },
      h("label", {}, "Quick syntax (one line per node or connection)", ta), errs, help,
      h("h4", {}, "Nodes"), nodeList, h("div", { class: "fe-actions" }, addNode),
      h("h4", {}, "Connections"), edgeList, h("div", { class: "fe-actions" }, addEdge));
    openModal({
      title: "Edit flowchart",
      content: body,
      actions: [{ label: "Cancel" }, { label: "Apply", class: "primary", run: () => {
        if (ta.value !== serializeFlow(work)) ta.dispatchEvent(new Event("change"));
        mutate((f) => { f.nodes = work.nodes; f.edges = work.edges; });
      } }]
    });
  }

  render();
  return wrap;
}

/** Jump to a box: scroll the flow block holding node `nodeId` (inside `root`) into view and highlight that box. Returns false when no such box. */
export function focusFlowBox(root, nodeId) {
  const id = String(nodeId ?? "");
  const el = id ? [...root.querySelectorAll(".flow-node[data-node]")].find((n) => n.getAttribute("data-node") === id) : null;
  if (!el) return false;
  const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: reduce ? "auto" : "smooth" });
  if (el.hasAttribute("tabindex")) el.focus({ preventScroll: true });
  el.classList.add("flow-hit");
  setTimeout(() => el.classList.remove("flow-hit"), 2600);
  return true;
}
