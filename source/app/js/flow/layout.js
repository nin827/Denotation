// Flowchart engine (pure: no DOM, imported by the browser UI and by the Node tests).
//   cleanFlow(block)       validate / repair stored data (idempotent, always returns a fresh plain object)
//   parseFlow(text)        quick syntax -> { nodes, edges, errors };  serializeFlow(flow) -> quick syntax
//   layoutFlow(block)      automatic placement -> { width, height, nodes: [box], edges: [{ d, mid, ... }] }
//   shapeGeometry(...)     the SVG element description of a node shape
//
// Stored form: { type: "flow", layout, dir, rotate, turn, spacing, nodes: [{ id, text, shape, hue?, bg? }],
//                edges: [{ from, to, label?, style?, arrow? }] }
//   layout  flow | cycle | tree | row | grid          dir      down | up | right | left (not used by cycle)
//   rotate  start angle of a cycle in degrees (0 = first node at the top)   turn  cw | ccw
//   spacing compact | normal | roomy                  hue / bg  0..330 step 30 (the app's 12 hues) or "grey"; hue
//   colours the outline and text, bg only the fill (when absent the fill follows hue)
//   edge    style "dashed" (omitted = solid), arrow "none" | "both" (omitted = arrow at the end)
//
// Quick syntax, one statement per line ("#" or "//" starts a comment line):
//   A -> B: yes          edge A to B with the label "yes"       A -- B     no arrowhead
//   A <-> B              arrowheads at both ends                A <- B     same as B -> A
//   A -.-> B             dashed edge (-.- dashed, no head)      A: Some text   node text
//   A [diamond] Is it ok?    node shape and text. [ ] may also hold a colour (red, blue, grey ...) or bg=<colour>;
//                            "A [diamond blue]: Text" is the form serializeFlow writes.
// A node id is letters, digits and "_" (up to 32). A node that only appears in an edge is created with its id as text.
// A bare "A" line, or "A [shape]", keeps the text already given; "A:" with nothing after sets an empty text.

export const LIMITS = { nodes: 200, edges: 400, text: 200, label: 80, lines: 2000 };
export const SHAPES = ["rect", "rounded", "pill", "diamond", "circle", "parallelogram", "cylinder", "document"];
export const LAYOUTS = ["flow", "cycle", "tree", "row", "grid"];
export const DIRS = ["down", "up", "right", "left"];
export const SPACINGS = ["compact", "normal", "roomy"];
export const TURNS = ["cw", "ccw"];
/** The app's 12 block hues (same values as HUES in blocks/model.js). */
export const FLOW_HUES = [
  [0, "Rose"], [30, "Red"], [60, "Orange"], [90, "Yellow"], [120, "Lime"], [150, "Green"],
  [180, "Teal"], [210, "Cyan"], [240, "Blue"], [270, "Violet"], [300, "Purple"], [330, "Pink"]
];
const HUE_NAME = new Map(FLOW_HUES.map(([v, n]) => [v, n.toLowerCase()]));
const NAME_HUE = new Map(FLOW_HUES.map(([v, n]) => [n.toLowerCase(), v]));

const ID = "[\\p{L}\\p{N}_]{1,32}";
const ID_RE = new RegExp(`^${ID}$`, "u");
const cut = (s, n) => {
  const a = [...s];
  return a.length > n ? a.slice(0, n).join("") : s;
};
const pickOf = (list, v, def) => (list.includes(v) ? v : def);

/** One line of text: control characters become spaces, capped, trimmed. */
export function cleanText(v, max = LIMITS.text) {
  if (typeof v !== "string" && typeof v !== "number") return "";
  return cut(String(v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " "), max).trim();
}
export function cleanColour(v) {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "grey" || s === "gray") return "grey";
    if (NAME_HUE.has(s)) return NAME_HUE.get(s);
    if (/^\d{1,3}$/.test(s)) v = Number(s);
  }
  return Number.isInteger(v) && v >= 0 && v < 360 && v % 30 === 0 ? v : undefined;
}
const cleanId = (v) => (typeof v === "string" || typeof v === "number" ? cut(String(v).replace(/[^\p{L}\p{N}_]/gu, ""), 32) : "");
/** The smallest unused id of the form n1, n2, ... */
export function nextNodeId(nodes) {
  const used = new Set((nodes ?? []).map((n) => n.id));
  let i = 1;
  while (used.has(`n${i}`)) i++;
  return `n${i}`;
}

/** Validate and repair a flow block (or any object). Returns { type, layout, dir, rotate, turn, spacing, nodes, edges }. */
export function cleanFlow(block) {
  const src = block && typeof block === "object" ? block : {};
  const rot = Number(src.rotate);
  const out = {
    type: "flow",
    layout: pickOf(LAYOUTS, src.layout, "flow"),
    dir: pickOf(DIRS, src.dir, "down"),
    rotate: Number.isFinite(rot) ? (((Math.round(rot) % 360) + 360) % 360) : 0,
    turn: pickOf(TURNS, src.turn, "cw"),
    spacing: pickOf(SPACINGS, src.spacing, "normal"),
    nodes: [],
    edges: []
  };
  const ids = new Set();
  for (const n of (Array.isArray(src.nodes) ? src.nodes : []).slice(0, LIMITS.nodes)) {
    if (!n || typeof n !== "object") continue;
    let id = cleanId(n.id);
    if (!id || ids.has(id)) {
      id = nextNodeId([...ids].map((x) => ({ id: x })));
    }
    ids.add(id);
    const node = { id, text: cleanText(n.text), shape: pickOf(SHAPES, n.shape, "rect") };
    const hue = cleanColour(n.hue);
    const bg = cleanColour(n.bg);
    if (hue !== undefined) node.hue = hue;
    if (bg !== undefined) node.bg = bg;
    out.nodes.push(node);
  }
  for (const e of (Array.isArray(src.edges) ? src.edges : []).slice(0, LIMITS.edges * 2)) {
    if (out.edges.length >= LIMITS.edges) break;
    if (!e || typeof e !== "object") continue;
    const from = cleanId(e.from);
    const to = cleanId(e.to);
    if (!ids.has(from) || !ids.has(to)) continue;
    const edge = { from, to };
    const label = cleanText(e.label, LIMITS.label);
    if (label) edge.label = label;
    if (e.style === "dashed") edge.style = "dashed";
    if (e.arrow === "none" || e.arrow === "both") edge.arrow = e.arrow;
    out.edges.push(edge);
  }
  return out;
}

// ---------------------------------------------------------------- quick syntax
const EDGE_RE = new RegExp(`^(${ID})\\s*(<?)(-\\.+-|-{1,3})(>?)\\s*(${ID})\\s*(?::\\s*(.*))?$`, "u");
const NODE_RE = new RegExp(`^(${ID})\\s*(?:\\[([^\\]]*)\\])?\\s*(:)?\\s*(.*)$`, "u");

/** Parse quick syntax. Never throws; lines it cannot use are listed in errors ({ line, message }). */
export function parseFlow(text) {
  const nodes = new Map();
  const edges = [];
  const errors = [];
  const touch = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, text: id, shape: "rect" });
    return nodes.get(id);
  };
  const lines = String(text ?? "").split(/\r\n|\r|\n/).slice(0, LIMITS.lines);
  lines.forEach((raw, i) => {
    const line = cut(raw, 2000).trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) return;
    const m = EDGE_RE.exec(line);
    if (m && !(m[3] === "-" && !m[2] && !m[4])) {
      let [, a, l, op, r, b, label] = m;
      if (l && !r) [a, b] = [b, a];
      touch(a);
      touch(b);
      const e = { from: a, to: b };
      const lab = cleanText(label ?? "", LIMITS.label);
      if (lab) e.label = lab;
      if (op.includes(".")) e.style = "dashed";
      if (l && r) e.arrow = "both";
      else if (!l && !r) e.arrow = "none";
      edges.push(e);
      return;
    }
    const n = NODE_RE.exec(line);
    if (!n) {
      errors.push({ line: i + 1, message: "Not understood (expected: A -> B: label, or A [shape]: text)" });
      return;
    }
    const [, id, tokens, colon, rest] = n;
    const node = touch(id);
    for (const tok of (tokens ?? "").split(/[\s,]+/).filter(Boolean)) {
      const t = tok.toLowerCase();
      if (SHAPES.includes(t)) node.shape = t;
      else if (t.startsWith("bg=") && cleanColour(t.slice(3)) !== undefined) node.bg = cleanColour(t.slice(3));
      else if (cleanColour(t) !== undefined) node.hue = cleanColour(t);
      else errors.push({ line: i + 1, message: `Unknown option "${cut(tok, 20)}"` });
    }
    if (rest || colon) node.text = cleanText(rest);
  });
  return { nodes: [...nodes.values()], edges, errors };
}

/** Quick syntax for a flow (cleaned first). parseFlow(serializeFlow(f)) gives back f's nodes and edges. */
export function serializeFlow(flow) {
  const f = cleanFlow(flow);
  const lines = [];
  for (const n of f.nodes) {
    const tok = [];
    if (n.shape !== "rect") tok.push(n.shape);
    if (n.hue !== undefined) tok.push(n.hue === "grey" ? "grey" : HUE_NAME.get(n.hue));
    if (n.bg !== undefined) tok.push(`bg=${n.bg === "grey" ? "grey" : HUE_NAME.get(n.bg)}`);
    let s = n.id + (tok.length ? ` [${tok.join(" ")}]` : "");
    if (n.text !== n.id) s += `: ${n.text}`;
    lines.push(s);
  }
  for (const e of f.edges) {
    const dashed = e.style === "dashed";
    const op = e.arrow === "both" ? (dashed ? "<-.->" : "<->") : e.arrow === "none" ? (dashed ? "-.-" : "--") : dashed ? "-.->" : "->";
    lines.push(`${e.from} ${op} ${e.to}${e.label ? `: ${e.label}` : ""}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- measuring
const FONT = 14;
const LH = 18;
const charW = (c) => {
  const k = c.codePointAt(0);
  if (k >= 0x2e80) return FONT;
  if (c === " ") return 4;
  if (/[MW@%]/.test(c)) return 12;
  if (/[A-Z]/.test(c)) return 9.4;
  if (/[il.,;:'|!ft]/.test(c)) return 4.2;
  return 7.6;
};
const widthOf = (s, scale = 1) => {
  let w = 0;
  for (const c of s) w += charW(c);
  return w * scale;
};
/** Word-wrap to at most maxPx wide (long words are split). Always returns at least one line. */
export function wrapLines(text, maxPx = 176, scale = 1) {
  const lines = [];
  let cur = "";
  const push = () => {
    lines.push(cur);
    cur = "";
  };
  for (const word of String(text).split(/ +/)) {
    if (!word && !cur) continue;
    const joined = cur ? `${cur} ${word}` : word;
    if (widthOf(joined, scale) <= maxPx) {
      cur = joined;
      continue;
    }
    if (cur) push();
    if (widthOf(word, scale) <= maxPx) {
      cur = word;
      continue;
    }
    for (const c of word) {
      if (cur && widthOf(cur + c, scale) > maxPx) push();
      cur += c;
    }
  }
  if (cur || !lines.length) push();
  return lines.slice(0, 8);
}

/** Size and text lines of a node. */
export function measureNode(n) {
  const lines = wrapLines(n.text);
  const tw = Math.max(0, ...lines.map((l) => widthOf(l)));
  const th = lines.length * LH;
  let w;
  let h;
  let dy = 0;
  switch (n.shape) {
    case "pill": w = Math.max(80, tw + 40); h = Math.max(40, th + 22); break;
    case "diamond": w = Math.max(96, tw * 1.55 + 40); h = Math.max(64, th * 1.6 + 34); break;
    case "circle": w = h = Math.max(64, Math.hypot(tw, th) + 24); break;
    case "parallelogram": w = Math.max(88, tw + 56); h = Math.max(40, th + 22); break;
    case "cylinder": w = Math.max(72, tw + 28); h = Math.max(54, th + 38); dy = 6; break;
    case "document": w = Math.max(72, tw + 28); h = Math.max(48, th + 32); dy = -4; break;
    default: w = Math.max(72, tw + 28); h = Math.max(40, th + 22);
  }
  return { w: Math.ceil(w), h: Math.ceil(h), lines, lineHeight: LH, dy };
}

/** SVG element for a node shape at (x, y, w, h): { tag, attrs }. */
export function shapeGeometry(shape, x, y, w, h) {
  const r = (v) => Math.round(v * 10) / 10;
  switch (shape) {
    case "rounded": return { tag: "rect", attrs: { x: r(x), y: r(y), width: w, height: h, rx: 12 } };
    case "pill": return { tag: "rect", attrs: { x: r(x), y: r(y), width: w, height: h, rx: r(h / 2) } };
    case "diamond": return { tag: "polygon", attrs: { points: `${r(x + w / 2)},${r(y)} ${r(x + w)},${r(y + h / 2)} ${r(x + w / 2)},${r(y + h)} ${r(x)},${r(y + h / 2)}` } };
    case "circle": return { tag: "ellipse", attrs: { cx: r(x + w / 2), cy: r(y + h / 2), rx: r(w / 2), ry: r(h / 2) } };
    case "parallelogram": {
      const s = Math.min(18, w / 4);
      return { tag: "polygon", attrs: { points: `${r(x + s)},${r(y)} ${r(x + w)},${r(y)} ${r(x + w - s)},${r(y + h)} ${r(x)},${r(y + h)}` } };
    }
    case "cylinder": {
      const ry = 8;
      const rx = r(w / 2);
      return { tag: "path", attrs: { d: `M${r(x)} ${r(y + ry)}A${rx} ${ry} 0 0 1 ${r(x + w)} ${r(y + ry)}V${r(y + h - ry)}A${rx} ${ry} 0 0 1 ${r(x)} ${r(y + h - ry)}ZM${r(x)} ${r(y + ry)}A${rx} ${ry} 0 0 0 ${r(x + w)} ${r(y + ry)}` } };
    }
    case "document":
      return { tag: "path", attrs: { d: `M${r(x)} ${r(y)}H${r(x + w)}V${r(y + h - 10)}Q${r(x + w * 0.75)} ${r(y + h - 20)} ${r(x + w / 2)} ${r(y + h - 10)}T${r(x)} ${r(y + h - 10)}Z` } };
    default: return { tag: "rect", attrs: { x: r(x), y: r(y), width: w, height: h, rx: 3 } };
  }
}

// ---------------------------------------------------------------- layout helpers
const SPACE = { compact: { rank: 36, node: 30 }, normal: { rank: 58, node: 36 }, roomy: { rank: 90, node: 56 } };
const fx = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 || 0 : 0);
const mkMapper = (dir, total) => {
  const vertical = dir === "down" || dir === "up";
  const flip = dir === "up" || dir === "left";
  return { vertical, xy: (a, c) => {
    const A = flip ? total - a : a;
    return vertical ? { x: c, y: A } : { x: A, y: c };
  } };
};

/** Place boxes of the given sizes along a line, in order, as close to the wanted centres as possible (isotonic fit). */
function placeLayer(sizes, desired, gap) {
  const n = sizes.length;
  const o = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    o[i] = acc + sizes[i] / 2;
    acc += sizes[i] + gap;
  }
  const blocks = [];
  for (let i = 0; i < n; i++) {
    blocks.push({ sum: desired[i] - o[i], n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.n <= b.sum / b.n) break;
      a.sum += b.sum;
      a.n += b.n;
      blocks.pop();
    }
  }
  const out = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.sum / b.n + o[out.length]);
  return out;
}

/** Where the line from the centre of box b towards (tx, ty) leaves its outline. */
function clip(b, tx, ty) {
  const dx = tx - b.cx;
  const dy = ty - b.cy;
  if (!dx && !dy) return { x: b.cx, y: b.cy };
  const hw = b.w / 2;
  const hh = b.h / 2;
  let s;
  if (b.shape === "diamond") s = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else if (b.shape === "circle") s = 1 / Math.hypot(dx / hw, dy / hh);
  else s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: b.cx + dx * s, y: b.cy + dy * s };
}
const pathOf = (pts) => `M${fx(pts[0].x)} ${fx(pts[0].y)}${pts.slice(1).map((p) => `L${fx(p.x)} ${fx(p.y)}`).join("")}`;
/** Straight or quadratic connection between two boxes; cp (optional) is the control point. */
function chord(A, B, cp) {
  if (!cp) {
    const p = clip(A, B.cx, B.cy);
    const q = clip(B, A.cx, A.cy);
    return { d: pathOf([p, q]), mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, box: [p, q] };
  }
  const p = clip(A, cp.x, cp.y);
  const q = clip(B, cp.x, cp.y);
  const mid = { x: 0.25 * p.x + 0.5 * cp.x + 0.25 * q.x, y: 0.25 * p.y + 0.5 * cp.y + 0.25 * q.y };
  return { d: `M${fx(p.x)} ${fx(p.y)}Q${fx(cp.x)} ${fx(cp.y)} ${fx(q.x)} ${fx(q.y)}`, mid, box: [p, q, mid] };
}
/** Chord bent sideways by `bend` px (0 = straight), plus an optional pull towards a point. */
function bentChord(A, B, bend, pull) {
  const mx = (A.cx + B.cx) / 2;
  const my = (A.cy + B.cy) / 2;
  const dx = B.cx - A.cx;
  const dy = B.cy - A.cy;
  const len = Math.hypot(dx, dy) || 1;
  let cx = mx + (-dy / len) * bend * 2;
  let cy = my + (dx / len) * bend * 2;
  if (pull) {
    cx += (pull.x - mx) * pull.k;
    cy += (pull.y - my) * pull.k;
  }
  return chord(A, B, bend || pull ? { x: cx, y: cy } : null);
}
function loopRoute(A) {
  const p = clip(A, A.cx + 100, A.cy - 30);
  const q = clip(A, A.cx + 100, A.cy + 30);
  const reach = 40;
  const mid = { x: Math.max(p.x, q.x) + reach * 0.75, y: (p.y + q.y) / 2 };
  return { d: `M${fx(p.x)} ${fx(p.y)}C${fx(p.x + reach)} ${fx(p.y - 24)} ${fx(q.x + reach)} ${fx(q.y + 24)} ${fx(q.x)} ${fx(q.y)}`, mid, box: [p, q, mid, { x: mid.x, y: p.y - 14 }, { x: mid.x, y: q.y + 14 }] };
}
const smooth = (pts, vertical) => {
  let d = `M${fx(pts[0].x)} ${fx(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    if (vertical) {
      const m = (p.y + q.y) / 2;
      d += `C${fx(p.x)} ${fx(m)} ${fx(q.x)} ${fx(m)} ${fx(q.x)} ${fx(q.y)}`;
    } else {
      const m = (p.x + q.x) / 2;
      d += `C${fx(m)} ${fx(p.y)} ${fx(m)} ${fx(q.y)} ${fx(q.x)} ${fx(q.y)}`;
    }
  }
  const m = Math.floor((pts.length - 1) / 2);
  return { d, mid: { x: (pts[m].x + pts[m + 1].x) / 2, y: (pts[m].y + pts[m + 1].y) / 2 }, box: pts };
};

// ---------------------------------------------------------------- layouts
/** Layered layout: longest-path ranks (back edges of cycles ignored), dummy nodes for long edges, barycentre ordering. */
function layoutLayered(f, boxes, sp) {
  const n = boxes.length;
  const { vertical } = mkMapper(f.dir, 0);
  const idx = new Map(f.nodes.map((nd, i) => [nd.id, i]));
  const E = f.edges.map((e, k) => ({ k, u: idx.get(e.from), v: idx.get(e.to) }));
  const out = Array.from({ length: n }, () => []);
  const indeg = new Array(n).fill(0);
  for (const e of E) if (e.u !== e.v) {
    out[e.u].push(e.v);
    indeg[e.v]++;
  }
  // back edges: found by an iterative depth-first search that starts at the sources
  const state = new Uint8Array(n);
  const back = new Set();
  const starts = [...boxes.keys()].filter((i) => !indeg[i]).concat([...boxes.keys()].filter((i) => indeg[i]));
  for (const s of starts) {
    if (state[s]) continue;
    state[s] = 1;
    const stack = [[s, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const u = top[0];
      if (top[1] < out[u].length) {
        const v = out[u][top[1]++];
        if (state[v] === 0) {
          state[v] = 1;
          stack.push([v, 0]);
        } else if (state[v] === 1) back.add(u * n + v);
      } else {
        state[u] = 2;
        stack.pop();
      }
    }
  }
  // longest-path ranks over the remaining acyclic graph (Kahn)
  const rank = new Array(n).fill(0);
  const deg = new Array(n).fill(0);
  for (let u = 0; u < n; u++) for (const v of out[u]) if (!back.has(u * n + v)) deg[v]++;
  const queue = [];
  for (let i = 0; i < n; i++) if (!deg[i]) queue.push(i);
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const v of out[u]) {
      if (back.has(u * n + v)) continue;
      rank[v] = Math.max(rank[v], rank[u] + 1);
      if (--deg[v] === 0) queue.push(v);
    }
  }
  const L = Math.max(0, ...rank) + 1;
  // items: real nodes 0..n-1, then dummies
  const layerOf = rank.slice();
  const layers = Array.from({ length: L }, () => []);
  for (let i = 0; i < n; i++) layers[rank[i]].push(i);
  const ups = Array.from({ length: n }, () => []);
  const downs = Array.from({ length: n }, () => []);
  const chains = new Map();
  let dummies = 0;
  for (const e of E) {
    if (e.u === e.v) continue;
    const rev = rank[e.u] > rank[e.v];
    const lo = rev ? e.v : e.u;
    const hi = rev ? e.u : e.v;
    const span = rank[hi] - rank[lo];
    if (span < 1) continue;
    const chain = [lo];
    if (span > 1 && dummies + span - 1 <= 2000) {
      for (let r = rank[lo] + 1; r < rank[hi]; r++) {
        const id = n + dummies++;
        layerOf[id] = r;
        ups[id] = [];
        downs[id] = [];
        layers[r].push(id);
        chain.push(id);
      }
    }
    chain.push(hi);
    for (let i = 1; i < chain.length; i++) {
      if (layerOf[chain[i]] === layerOf[chain[i - 1]] + 1) {
        downs[chain[i - 1]].push(chain[i]);
        ups[chain[i]].push(chain[i - 1]);
      }
    }
    chains.set(e.k, { chain, rev });
  }
  // ordering: barycentre sweeps
  const pos = new Array(n + dummies).fill(0);
  const renumber = () => layers.forEach((l) => l.forEach((it, i) => { pos[it] = i; }));
  renumber();
  const bary = (it, nbs) => (nbs.length ? nbs.reduce((s, x) => s + pos[x], 0) / nbs.length : pos[it]);
  for (let round = 0; round < 4; round++) {
    for (let r = 1; r < L; r++) {
      const keyed = layers[r].map((it) => [bary(it, ups[it]), pos[it], it]);
      keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      layers[r] = keyed.map((x) => x[2]);
      renumber();
    }
    for (let r = L - 2; r >= 0; r--) {
      const keyed = layers[r].map((it) => [bary(it, downs[it]), pos[it], it]);
      keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      layers[r] = keyed.map((x) => x[2]);
      renumber();
    }
  }
  // across coordinates
  const size = (it) => (it < n ? (vertical ? boxes[it].w : boxes[it].h) : 6);
  const along = (it) => (it < n ? (vertical ? boxes[it].h : boxes[it].w) : 0);
  const c = new Array(n + dummies).fill(0);
  const setLayer = (r, want) => {
    const items = layers[r];
    const res = placeLayer(items.map(size), items.map(want), sp.node);
    items.forEach((it, i) => { c[it] = res[i]; });
  };
  for (let r = 0; r < L; r++) setLayer(r, () => 0);
  const avg = (it, nbs) => (nbs.length ? nbs.reduce((s, x) => s + c[x], 0) / nbs.length : c[it]);
  for (let round = 0; round < 3; round++) {
    for (let r = 1; r < L; r++) setLayer(r, (it) => avg(it, ups[it]));
    for (let r = L - 2; r >= 0; r--) setLayer(r, (it) => avg(it, downs[it]));
  }
  // along coordinates
  const thick = layers.map((l) => Math.max(0, ...l.map(along)));
  const a = [];
  let cursor = 0;
  for (let r = 0; r < L; r++) {
    cursor += (r ? thick[r - 1] / 2 + sp.rank : 0) + thick[r] / 2;
    a.push(cursor);
  }
  const total = cursor + (thick[L - 1] ?? 0) / 2;
  const M = mkMapper(f.dir, total);
  const place = boxes.map((_, i) => M.xy(a[rank[i]], c[i]));
  const route = (e, off) => {
    const info = chains.get(e.k);
    if (!info) return null;
    const { chain, rev } = info;
    const pts = chain.map((it, i) => {
      const half = it < n ? along(it) / 2 : 0;
      const sideShift = i === 0 || i === chain.length - 1 ? off : 0;
      if (i === 0) return M.xy(a[layerOf[it]] + half, c[it] + sideShift);
      if (i === chain.length - 1) return M.xy(a[layerOf[it]] - half, c[it] + sideShift);
      return M.xy(a[layerOf[it]], c[it]);
    });
    if (rev) pts.reverse();
    return smooth(pts, vertical);
  };
  return { place, route, rank, vertical };
}

function layoutTree(f, boxes, sp) {
  const n = boxes.length;
  const M0 = mkMapper(f.dir, 0);
  const vertical = M0.vertical;
  const idx = new Map(f.nodes.map((nd, i) => [nd.id, i]));
  const out = Array.from({ length: n }, () => []);
  const indeg = new Array(n).fill(0);
  for (const e of f.edges) {
    const u = idx.get(e.from);
    const v = idx.get(e.to);
    if (u === v) continue;
    out[u].push(v);
    indeg[v]++;
  }
  const seen = new Uint8Array(n);
  const kids = Array.from({ length: n }, () => []);
  const depth = new Array(n).fill(0);
  const roots = [];
  const grow = (r) => {
    seen[r] = 1;
    roots.push(r);
    const queue = [r];
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi];
      for (const v of [...out[u]].sort((x, y) => x - y)) {
        if (seen[v]) continue;
        seen[v] = 1;
        depth[v] = depth[u] + 1;
        kids[u].push(v);
        queue.push(v);
      }
    }
  };
  for (let i = 0; i < n; i++) if (!indeg[i] && !seen[i]) grow(i);
  for (let i = 0; i < n; i++) if (!seen[i]) grow(i);
  const across = (i) => (vertical ? boxes[i].w : boxes[i].h) + sp.node;
  const along = (i) => (vertical ? boxes[i].h : boxes[i].w);
  const sw = new Array(n).fill(0);
  const measure = (u) => {
    let sum = 0;
    for (const k of kids[u]) sum += measure(k);
    sw[u] = Math.max(across(u), sum);
    return sw[u];
  };
  const c = new Array(n).fill(0);
  const lay = (u, start) => {
    c[u] = start + sw[u] / 2;
    const sum = kids[u].reduce((s, k) => s + sw[k], 0);
    let at = start + (sw[u] - sum) / 2;
    for (const k of kids[u]) {
      lay(k, at);
      at += sw[k];
    }
  };
  let cur = 0;
  for (const r of roots) {
    measure(r);
    lay(r, cur);
    cur += sw[r];
  }
  const D = Math.max(0, ...depth) + 1;
  const thick = new Array(D).fill(0);
  for (let i = 0; i < n; i++) thick[depth[i]] = Math.max(thick[depth[i]], along(i));
  const a = [];
  let cursor = 0;
  for (let r = 0; r < D; r++) {
    cursor += (r ? thick[r - 1] / 2 + sp.rank : 0) + thick[r] / 2;
    a.push(cursor);
  }
  const M = mkMapper(f.dir, cursor + thick[D - 1] / 2);
  const place = boxes.map((_, i) => M.xy(a[depth[i]], c[i]));
  const route = (e, off) => {
    const u = idx.get(e.from);
    const v = idx.get(e.to);
    if (u === v || depth[v] !== depth[u] + 1) return null;
    return smooth([M.xy(a[depth[u]] + along(u) / 2, c[u] + off), M.xy(a[depth[v]] - along(v) / 2, c[v] + off)], vertical);
  };
  return { place, route };
}

function layoutRing(f, boxes, sp) {
  const n = boxes.length;
  if (n === 1) return { place: [{ x: 0, y: 0 }] };
  const maxW = Math.max(...boxes.map((b) => b.w));
  const maxH = Math.max(...boxes.map((b) => b.h));
  const chordMin = Math.hypot(maxW, maxH) + sp.node;
  const r = n === 2 ? chordMin / 2 : chordMin / (2 * Math.sin(Math.PI / n));
  const sign = f.turn === "ccw" ? -1 : 1;
  const place = boxes.map((_, i) => {
    const ang = ((-90 + f.rotate + sign * i * 360 / n) * Math.PI) / 180;
    return { x: r * Math.cos(ang), y: r * Math.sin(ang) };
  });
  return { place, ring: true };
}

function layoutRow(f, boxes, sp) {
  const M0 = mkMapper(f.dir, 0);
  const along = (b) => (M0.vertical ? b.h : b.w);
  let cursor = 0;
  const a = boxes.map((b, i) => {
    cursor += (i ? along(boxes[i - 1]) / 2 + sp.rank : 0) + along(b) / 2;
    return cursor;
  });
  const M = mkMapper(f.dir, cursor + along(boxes[boxes.length - 1]) / 2);
  return { place: a.map((v) => M.xy(v, 0)), row: true, vertical: M0.vertical };
}

function layoutGrid(f, boxes, sp) {
  const n = boxes.length;
  const vertical = f.dir === "down" || f.dir === "up";
  const side = Math.ceil(Math.sqrt(n));
  const R = vertical ? side : Math.ceil(n / side);
  const C = vertical ? Math.ceil(n / side) : side;
  const cw = Math.max(...boxes.map((b) => b.w)) + sp.node;
  const ch = Math.max(...boxes.map((b) => b.h)) + Math.max(20, sp.rank - 10);
  const place = boxes.map((_, i) => {
    let row;
    let col;
    if (vertical) {
      row = i % R;
      col = Math.floor(i / R);
      if (f.dir === "up") row = R - 1 - row;
    } else {
      col = i % C;
      row = Math.floor(i / C);
      if (f.dir === "left") col = C - 1 - col;
    }
    return { x: col * cw, y: row * ch };
  });
  return { place, grid: true };
}

// ---------------------------------------------------------------- main
/** Automatic placement. Returns { width, height, nodes, edges } in a coordinate space starting at 0,0. */
export function layoutFlow(input) {
  const f = cleanFlow(input);
  const sp = SPACE[f.spacing];
  const boxes = f.nodes.map((nd) => ({ ...nd, ...measureNode(nd) }));
  const empty = { width: 0, height: 0, nodes: [], edges: [] };
  if (!boxes.length) return empty;
  const idx = new Map(f.nodes.map((nd, i) => [nd.id, i]));
  const L = (f.layout === "cycle" ? layoutRing : f.layout === "tree" ? layoutTree : f.layout === "row" ? layoutRow : f.layout === "grid" ? layoutGrid : layoutLayered)(f, boxes, sp);
  boxes.forEach((b, i) => {
    b.cx = L.place[i].x;
    b.cy = L.place[i].y;
  });
  // parallel edges between the same two nodes fan out sideways
  const groups = new Map();
  for (const e of f.edges) {
    const u = idx.get(e.from);
    const v = idx.get(e.to);
    const key = u < v ? `${u}:${v}` : `${v}:${u}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const seenIn = new Map();
  const edges = f.edges.map((e, k) => {
    const u = idx.get(e.from);
    const v = idx.get(e.to);
    const key = u < v ? `${u}:${v}` : `${v}:${u}`;
    const j = seenIn.get(key) ?? 0;
    seenIn.set(key, j + 1);
    const cnt = groups.get(key);
    const off = Math.max(-24, Math.min(24, (j - (cnt - 1) / 2) * 16));
    const A = boxes[u];
    const B = boxes[v];
    let r = null;
    if (u === v) r = loopRoute(A);
    else if (L.route) r = L.route({ ...e, k }, off);
    if (!r && !L.route && L.ring) {
      const d = (v - u + boxes.length) % boxes.length;
      const adjacent = d === 1 || d === boxes.length - 1;
      r = bentChord(A, B, off, adjacent ? null : { x: 0, y: 0, k: 0.35 });
    } else if (!r && L.row) {
      const span = Math.abs(v - u);
      if (span === 1) r = bentChord(A, B, off);
      else {
        const maxAcross = Math.max(...boxes.map((b) => (L.vertical ? b.w : b.h)));
        const side = v > u ? 1 : -1;
        const bulge = (maxAcross / 2 + 10 + 8 * Math.min(span, 6)) * side + off;
        const dx = B.cx - A.cx;
        const dy = B.cy - A.cy;
        const len = Math.hypot(dx, dy) || 1;
        // the quadratic control point reaches 2x the apex offset
        r = chord(A, B, { x: (A.cx + B.cx) / 2 + (-dy / len) * bulge * 2, y: (A.cy + B.cy) / 2 + (dx / len) * bulge * 2 });
      }
    } else if (!r) r = bentChord(A, B, off || (L.grid && Math.abs(u - v) > 1 ? 14 : 0));
    const lines = e.label ? wrapLines(e.label, 120, 12 / FONT) : [];
    const lw = lines.length ? Math.ceil(Math.max(...lines.map((l) => widthOf(l, 12 / FONT)))) + 12 : 0;
    const lh = lines.length * 15 + 6;
    return { from: e.from, to: e.to, d: r.d, mid: r.mid, box: r.box, label: e.label ?? "", labelLines: lines, lw, lh, dashed: e.style === "dashed", arrow: e.arrow ?? "end" };
  });
  // normalise to a 0,0 origin with padding
  const PAD = 16;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (x, y) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const b of boxes) {
    grow(b.cx - b.w / 2, b.cy - b.h / 2);
    grow(b.cx + b.w / 2, b.cy + b.h / 2);
  }
  for (const e of edges) {
    for (const p of e.box) grow(p.x, p.y);
    if (e.label) {
      grow(e.mid.x - e.lw / 2, e.mid.y - e.lh / 2);
      grow(e.mid.x + e.lw / 2, e.mid.y + e.lh / 2);
    }
  }
  const dx = PAD - x0;
  const dy = PAD - y0;
  const shift = (p) => ({ x: p.x + dx, y: p.y + dy });
  // route paths hold only absolute x y pairs after M, L, Q and C, so shifting alternates x and y
  const shiftD = (d) => {
    let isX = true;
    return d.replace(/-?\d+(?:\.\d+)?/g, (m) => {
      const v = fx(Number(m) + (isX ? dx : dy));
      isX = !isX;
      return String(v);
    });
  };
  return {
    width: Math.ceil(x1 - x0 + 2 * PAD),
    height: Math.ceil(y1 - y0 + 2 * PAD),
    nodes: boxes.map((b) => ({ id: b.id, text: b.text, shape: b.shape, hue: b.hue, bg: b.bg, x: fx(b.cx - b.w / 2 + dx), y: fx(b.cy - b.h / 2 + dy), w: b.w, h: b.h, cx: fx(b.cx + dx), cy: fx(b.cy + dy), lines: b.lines, lineHeight: b.lineHeight, dy: b.dy })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, d: shiftD(e.d), mid: shift(e.mid), label: e.label, labelLines: e.labelLines, lw: e.lw, lh: e.lh, dashed: e.dashed, arrow: e.arrow }))
  };
}
