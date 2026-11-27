// Canvas renderer for a built graph (model.buildGraph) with styles (style.styleGraph) and positions (interleaved
// Float32Array). Draws only when something changed (one requestAnimationFrame per change), culls offscreen items,
// and keeps level of detail: dots below ~1 px, icons only when a node is big on screen, labels only when zoomed in
// (or for the hovered / focused node and its neighbours), arrows only when edges are long enough to read.
// Input: pointer events are stored and applied once per frame (coalesced); hit-testing uses a uniform grid.

const TAU = Math.PI * 2;
const LABEL_ZOOM = 1.1;      // labels for everything visible from this zoom up
const LABEL_CAP = 350;       // most labels drawn in one frame
const ICON_MIN_PX = 9;       // node screen radius before its icon shows
const DOT_PX = 1.25;         // below this screen radius nodes are drawn as squares (cheaper)
const MIN_K = 0.01, MAX_K = 8;
// Paths are filled / stroked in chunks: rasterising one path with thousands of sub-paths is super-linear
// (measured in Chromium's software rasteriser: 2500 arrow triangles = 22 ms in one path, 1 ms in chunks of 32).
const EDGE_CHUNK = 512, NODE_CHUNK = 128, ARROW_CHUNK = 32;

/** Reads theme colours from CSS custom properties (resolved through a probe element, so var() chains work). */
export function readTheme(el) {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden";
  el.appendChild(probe);
  const get = (v, fb) => {
    probe.style.color = fb;
    probe.style.color = `var(${v}, ${fb})`;
    return getComputedStyle(probe).color || fb;
  };
  const t = {
    bg: get("--bg", "#ffffff"), text: get("--text", "#1f2530"), muted: get("--muted", "#5b6577"),
    border: get("--border-ctl", "#848d9d"), accent: get("--accent", "#3b6fd8"), accentSoft: get("--accent-soft", "#e3ebfb"),
    font: getComputedStyle(el).fontFamily || "system-ui, sans-serif"
  };
  probe.remove();
  t.dark = luminance(t.bg) < 0.4;
  return t;
}
function luminance(css) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
  if (m) return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
  const o = /oklch\(\s*([\d.]+)(%?)/.exec(css);
  if (o) return o[2] ? o[1] / 100 : +o[1];
  return 1;
}

/** CSS colour for a normalised style colour ({hue}|{hex}|{grey}) in the current theme. */
export function colorCss(c, theme) {
  if (!c) return null;
  if (c.hex) return c.hex;
  if (c.grey) return theme.muted;
  return theme.dark ? `oklch(0.74 0.13 ${c.hue})` : `oklch(0.60 0.15 ${c.hue})`;
}

/**
 * @param {HTMLCanvasElement} canvas  sized by its CSS box (the renderer sets width/height attributes)
 * @param {{ onOpen?: (i:number)=>void, onHover?: (i:number)=>void, onDragStart?: (i:number)=>void,
 *           onDrag?: (i:number,x:number,y:number)=>void, onDragEnd?: (i:number)=>void,
 *           iconImage?: (icon:string, color:string)=>CanvasImageSource|null, theme?: object, arrows?: boolean }} [opts]
 */
export function createRenderer(canvas, opts = {}) {
  const ctx = canvas.getContext("2d", { alpha: false });
  let g = null, radius = new Float32Array(0), icons = [], nodeColor = [], styleColors = [];
  let colorIdx = new Uint16Array(0), palette = [];
  let xy = new Float32Array(0), posVersion = 0, gridVersion = -1;
  let theme = opts.theme || readTheme(canvas.parentElement || document.body);
  let cssW = 1, cssH = 1, dpr = 1;
  let k = 1, tx = 0, ty = 0; // screen = world * k + t (CSS px)
  let autoFit = true, hover = -1, dragNode = -1, maxR = 4;
  let raf = 0, dirty = true;
  const stats = { frames: 0, drawMs: 0, maxDrawMs: 0, draws: [], visibleNodes: 0, visibleEdges: 0, labels: 0 };
  const listeners = [];
  const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); listeners.push([t, ev, fn, o]); };

  // ---------- colours ----------
  function computeColors() {
    if (!g) return;
    const n = g.nodes.length;
    const map = new Map();
    palette = [];
    colorIdx = new Uint16Array(n);
    nodeColor = new Array(n);
    for (let i = 0; i < n; i++) {
      const kind = g.nodes[i].kind;
      const c = colorCss(styleColors[i], theme) || (i === g.focus ? theme.accent : kind === "row" ? theme.border : kind === "database" ? theme.text : theme.muted);
      nodeColor[i] = c;
      let ci = map.get(c);
      if (ci === undefined) { ci = palette.length; palette.push(c); map.set(c, ci); }
      colorIdx[i] = ci;
    }
  }

  // ---------- view ----------
  function resize() {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height), d = Math.min(3, window.devicePixelRatio || 1);
    if (w === cssW && h === cssH && d === dpr) return;
    const cx = (cssW / 2 - tx) / k, cy = (cssH / 2 - ty) / k; // keep the centre
    cssW = w; cssH = h; dpr = d;
    canvas.width = Math.round(w * d); canvas.height = Math.round(h * d);
    if (autoFit) fit(); else { tx = cssW / 2 - cx * k; ty = cssH / 2 - cy * k; }
    invalidate();
  }
  function bounds() {
    const n = g ? g.nodes.length : 0;
    if (!n || xy.length < 2 * n) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = xy[2 * i], y = xy[2 * i + 1], r = radius[i];
      if (x - r < x0) x0 = x - r; if (x + r > x1) x1 = x + r;
      if (y - r < y0) y0 = y - r; if (y + r > y1) y1 = y + r;
    }
    return { x0, y0, x1, y1 };
  }
  function fit(pad = 24) {
    const b = bounds();
    if (!b) { k = 1; tx = cssW / 2; ty = cssH / 2; invalidate(); return; }
    const bw = Math.max(b.x1 - b.x0, 1), bh = Math.max(b.y1 - b.y0, 1);
    k = clamp(Math.min((cssW - 2 * pad) / bw, (cssH - 2 * pad) / bh), MIN_K, 2);
    tx = cssW / 2 - ((b.x0 + b.x1) / 2) * k;
    ty = cssH / 2 - ((b.y0 + b.y1) / 2) * k;
    invalidate();
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function zoomAt(sx, sy, factor) {
    const nk = clamp(k * factor, MIN_K, MAX_K);
    const wx = (sx - tx) / k, wy = (sy - ty) / k;
    k = nk; tx = sx - wx * k; ty = sy - wy * k;
    invalidate();
  }

  // ---------- hit-testing grid ----------
  let gridCell = 32, gx0 = 0, gy0 = 0, gcols = 1, grows = 1, gStart = new Uint32Array(2), gItems = new Uint32Array(0);
  function buildGrid() {
    gridVersion = posVersion;
    const n = g ? g.nodes.length : 0;
    const b = bounds();
    if (!b) { gcols = grows = 0; return; }
    gridCell = Math.max(maxR * 2, 8);
    let cols = Math.ceil((b.x1 - b.x0) / gridCell) + 1, rws = Math.ceil((b.y1 - b.y0) / gridCell) + 1;
    while (cols * rws > 4 * n + 64) { gridCell *= 1.5; cols = Math.ceil((b.x1 - b.x0) / gridCell) + 1; rws = Math.ceil((b.y1 - b.y0) / gridCell) + 1; }
    gx0 = b.x0; gy0 = b.y0; gcols = cols; grows = rws;
    const cellOf = new Uint32Array(n);
    gStart = new Uint32Array(cols * rws + 1);
    for (let i = 0; i < n; i++) {
      const c = Math.floor((xy[2 * i] - gx0) / gridCell) + Math.floor((xy[2 * i + 1] - gy0) / gridCell) * cols;
      cellOf[i] = c; gStart[c + 1]++;
    }
    for (let c = 0; c < cols * rws; c++) gStart[c + 1] += gStart[c];
    const fill = gStart.slice(0, cols * rws);
    gItems = new Uint32Array(n);
    for (let i = 0; i < n; i++) gItems[fill[cellOf[i]]++] = i;
  }
  /** Node under the screen point (CSS px), or -1. `slop` = extra screen px of tolerance (touch). */
  function hitTest(sx, sy, slop = 4) {
    if (!g || !g.nodes.length) return -1;
    if (gridVersion !== posVersion) buildGrid();
    if (!gcols) return -1;
    const wx = (sx - tx) / k, wy = (sy - ty) / k, tol = slop / k;
    const reach = maxR + tol;
    const c0 = Math.max(0, Math.floor((wx - reach - gx0) / gridCell)), c1 = Math.min(gcols - 1, Math.floor((wx + reach - gx0) / gridCell));
    const r0 = Math.max(0, Math.floor((wy - reach - gy0) / gridCell)), r1 = Math.min(grows - 1, Math.floor((wy + reach - gy0) / gridCell));
    let best = -1, bestD = Infinity;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const cell = c + r * gcols;
      for (let j = gStart[cell]; j < gStart[cell + 1]; j++) {
        const i = gItems[j], dx = xy[2 * i] - wx, dy = xy[2 * i + 1] - wy;
        const d = Math.sqrt(dx * dx + dy * dy) - radius[i];
        if (d <= tol && d < bestD) { best = i; bestD = d; }
      }
    }
    return best;
  }

  // ---------- drawing ----------
  let vis = new Uint32Array(0), bucket = new Uint32Array(0), lit = new Uint8Array(0), occ = new Uint8Array(0);
  function draw() {
    const t0 = performance.now();
    dirty = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, cssW, cssH);
    const n = g ? g.nodes.length : 0;
    if (!n || xy.length < 2 * n) { finish(t0); return; }
    if (lit.length !== n) lit = new Uint8Array(n);
    const hl = hover >= 0 ? hover : dragNode;
    if (hl >= 0) {
      lit.fill(0);
      lit[hl] = 1;
      for (let j = g.adjOffset[hl]; j < g.adjOffset[hl + 1]; j++) lit[g.adj[j]] = 1;
    }
    const dim = hl >= 0;
    const m = maxR;
    const wx0 = -tx / k - m, wy0 = -ty / k - m, wx1 = (cssW - tx) / k + m, wy1 = (cssH - ty) / k + m;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);

    // edges: one batched path (dimmed while hovering), then the hovered node's edges on top
    const S = g.source, T = g.target, E = g.edgeCount;
    // exactly one device pixel: the rasteriser's hairline path, many times cheaper than wider strokes
    ctx.lineWidth = 1 / (k * dpr);
    ctx.strokeStyle = theme.muted;
    ctx.globalAlpha = dim ? 0.15 : dpr > 1 ? 0.75 : 0.55;
    ctx.beginPath();
    let ve = 0;
    const arrows = opts.arrows !== false && k * 34 > 22;
    for (let e = 0; e < E; e++) {
      const s = S[e], t = T[e];
      const ax = xy[2 * s], ay = xy[2 * s + 1], bx = xy[2 * t], by = xy[2 * t + 1];
      if ((ax < wx0 && bx < wx0) || (ax > wx1 && bx > wx1) || (ay < wy0 && by < wy0) || (ay > wy1 && by > wy1)) continue;
      if (dim && (s === hl || t === hl)) continue;
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      if (++ve % EDGE_CHUNK === 0) { ctx.stroke(); ctx.beginPath(); }
    }
    ctx.stroke();
    if (arrows) drawArrows(wx0, wy0, wx1, wy1, dim ? hl : -1, false);
    const tEdges = performance.now();
    if (dim) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1.6 / k;
      ctx.beginPath();
      for (let j = 0; j < E; j++) {
        if (S[j] !== hl && T[j] !== hl) continue;
        ctx.moveTo(xy[2 * S[j]], xy[2 * S[j] + 1]); ctx.lineTo(xy[2 * T[j]], xy[2 * T[j] + 1]);
      }
      ctx.stroke();
      if (arrows) drawArrows(wx0, wy0, wx1, wy1, hl, true);
    }

    // visible nodes, bucketed by colour (counting sort) so each colour is one path + fill
    if (vis.length < n) { vis = new Uint32Array(n); bucket = new Uint32Array(n); }
    let nv = 0;
    for (let i = 0; i < n; i++) {
      const x = xy[2 * i], y = xy[2 * i + 1], r = radius[i];
      if (x + r < wx0 + m || x - r > wx1 - m || y + r < wy0 + m || y - r > wy1 - m) continue;
      vis[nv++] = i;
    }
    const P = palette.length, counts = new Uint32Array(P + 1);
    for (let j = 0; j < nv; j++) counts[colorIdx[vis[j]] + 1]++;
    for (let c = 0; c < P; c++) counts[c + 1] += counts[c];
    const fillAt = counts.slice(0, P);
    for (let j = 0; j < nv; j++) bucket[fillAt[colorIdx[vis[j]]]++] = vis[j];
    for (let pass = 0; pass < (dim ? 2 : 1); pass++) {
      ctx.globalAlpha = dim && pass === 0 ? 0.25 : 1;
      for (let c = 0; c < P; c++) {
        if (counts[c] === counts[c + 1]) continue;
        ctx.fillStyle = palette[c];
        ctx.beginPath();
        let any = 0;
        for (let j = counts[c]; j < counts[c + 1]; j++) {
          const i = bucket[j];
          if (dim && (pass === 0) === !!lit[i]) continue;
          const x = xy[2 * i], y = xy[2 * i + 1], r = radius[i];
          if (r * k < DOT_PX) ctx.rect(x - r, y - r, 2 * r, 2 * r);
          else { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); }
          if (++any % NODE_CHUNK === 0) { ctx.fill(); ctx.beginPath(); }
        }
        if (any % NODE_CHUNK) ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    const tNodes = performance.now();
    // focus ring and hovered ring (state is also shown by the label, not by colour alone)
    for (const [i, w] of [[g.focus, 2.5], [hl, 2]]) {
      if (i < 0) continue;
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = w / k;
      ctx.beginPath();
      ctx.arc(xy[2 * i], xy[2 * i + 1], radius[i] + 3 / k, 0, TAU);
      ctx.stroke();
    }
    // icons (only when big enough on screen)
    if (opts.iconImage) {
      for (let j = 0; j < nv; j++) {
        const i = vis[j], ic = icons[i];
        if (!ic || radius[i] * k < ICON_MIN_PX) continue;
        ctx.globalAlpha = dim && !lit[i] ? 0.3 : 1;
        const r = radius[i], s = r * 1.15;
        if (ic.startsWith("icon:")) {
          const img = opts.iconImage(ic.slice(5), theme.bg);
          if (img) ctx.drawImage(img, xy[2 * i] - s / 2, xy[2 * i + 1] - s / 2, s, s);
        } else {
          ctx.fillStyle = theme.bg;
          ctx.font = `${Math.round(r * 1.1 * k)}px ${theme.font}`;
          ctx.save();
          ctx.setTransform(dpr, 0, 0, dpr, dpr * (xy[2 * i] * k + tx), dpr * (xy[2 * i + 1] * k + ty));
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(ic, 0, 0);
          ctx.restore();
        }
      }
      ctx.globalAlpha = 1;
    }
    const tIcons = performance.now();
    drawLabels(nv, hl, dim);
    stats.parts = { edges: tEdges - t0, nodes: tNodes - tEdges, icons: tIcons - tNodes, labels: performance.now() - tIcons };
    stats.visibleNodes = nv; stats.visibleEdges = ve;
    finish(t0);
  }
  function drawArrows(wx0, wy0, wx1, wy1, hl, onlyHl) {
    const S = g.source, T = g.target, W = g.twoWay, a = 5 / k;
    ctx.fillStyle = onlyHl ? theme.accent : theme.muted;
    ctx.beginPath();
    let count = 0;
    for (let e = 0; e < g.edgeCount; e++) {
      if (W[e]) continue;
      const s = S[e], t = T[e];
      if (onlyHl ? s !== hl && t !== hl : s === hl || t === hl) continue;
      const bx = xy[2 * t], by = xy[2 * t + 1];
      if (bx < wx0 || bx > wx1 || by < wy0 || by > wy1) continue;
      let dx = bx - xy[2 * s], dy = by - xy[2 * s + 1];
      const L = Math.sqrt(dx * dx + dy * dy);
      if (L * k < 24) continue;
      dx /= L; dy /= L;
      const px = bx - dx * (radius[t] + 1 / k), py = by - dy * (radius[t] + 1 / k);
      ctx.moveTo(px, py);
      ctx.lineTo(px - dx * a * 1.6 - dy * a * 0.7, py - dy * a * 1.6 + dx * a * 0.7);
      ctx.lineTo(px - dx * a * 1.6 + dy * a * 0.7, py - dy * a * 1.6 - dx * a * 0.7);
      ctx.closePath();
      if (++count % ARROW_CHUNK === 0) { ctx.fill(); ctx.beginPath(); }
    }
    ctx.fill();
  }
  function drawLabels(nv, hl, dim) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `12px ${theme.font}`;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.lineJoin = "round"; ctx.lineWidth = 3;
    ctx.strokeStyle = theme.bg; ctx.fillStyle = theme.text;
    let count = 0;
    // labels never overlap: a coarse occupancy grid (8 CSS px cells) over the viewport; hovered / focused labels
    // go first, then bigger nodes first, and a label that would collide is skipped
    const cw = Math.ceil(cssW / 8) + 1, ch = Math.ceil(cssH / 8) + 1;
    if (occ.length < cw * ch) occ = new Uint8Array(cw * ch); else occ.fill(0, 0, cw * ch);
    const one = (i, strong, force = false) => {
      const t = labelOf(i);
      if (!t) return;
      const sx = xy[2 * i] * k + tx, sy = (xy[2 * i + 1] + radius[i]) * k + ty + 3;
      if (sx < -100 || sx > cssW + 100 || sy < -20 || sy > cssH + 20) return;
      const hw = t.length * 3.4 + 2;
      const c0 = Math.max(0, Math.floor((sx - hw) / 8)), c1 = Math.min(cw - 1, Math.floor((sx + hw) / 8));
      const r0 = Math.max(0, Math.floor(sy / 8)), r1 = Math.min(ch - 1, Math.floor((sy + 14) / 8));
      if (!force) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (occ[r * cw + c]) return;
      for (let r = r0; r <= r1; r++) occ.fill(1, r * cw + c0, r * cw + c1 + 1);
      ctx.globalAlpha = dim && !strong ? 0.3 : 1;
      ctx.strokeText(t, sx, sy);
      ctx.fillText(t, sx, sy);
      count++;
    };
    const forced = new Set();
    if (hl >= 0) { forced.add(hl); for (let j = g.adjOffset[hl]; j < g.adjOffset[hl + 1]; j++) forced.add(g.adj[j]); }
    if (g.focus >= 0) forced.add(g.focus);
    if (hl >= 0) one(hl, true, true);
    if (g.focus >= 0 && g.focus !== hl) one(g.focus, true, true);
    for (const i of forced) if (i !== hl && i !== g.focus) one(i, true);
    if (k >= LABEL_ZOOM || nv <= 40) {
      const list = Array.from(vis.subarray(0, nv)).sort((a, b) => radius[b] - radius[a]);
      for (const i of list) {
        if (count >= LABEL_CAP) break;
        if (!forced.has(i)) one(i, false);
      }
    }
    ctx.globalAlpha = 1;
    stats.labels = count;
  }
  const labelCache = new Map();
  function labelOf(i) {
    const id = g.nodes[i].id;
    let t = labelCache.get(id);
    if (t === undefined) {
      t = String(g.nodes[i].title ?? "").trim() || "Untitled";
      if (t.length > 40) t = t.slice(0, 39) + "…";
      labelCache.set(id, t);
    }
    return t;
  }
  function finish(t0) {
    const ms = performance.now() - t0;
    stats.frames++; stats.drawMs = ms; stats.maxDrawMs = Math.max(stats.maxDrawMs, ms);
    if (stats.draws.length < 5000) stats.draws.push(ms);
  }

  // ---------- frame loop ----------
  function invalidate() {
    dirty = true;
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function frame() {
    raf = 0;
    applyInput();
    if (dirty) draw();
  }

  // ---------- input (coalesced: handlers record, the frame applies) ----------
  const pointers = new Map(); // pointerId -> { x, y, type }
  let mode = null; // "pan" | "node" | "pinch"
  let start = null, moved = false, hoverPos = null, pendingHover = false;
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, type: e.pointerType }; };
  function beginGesture() {
    const pts = [...pointers.values()];
    if (pts.length >= 2) {
      if (mode === "node") endDrag();
      const [a, b] = pts;
      mode = "pinch";
      start = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, k, tx, ty };
    } else if (pts.length === 1) {
      const p = pts[0];
      const i = hitTest(p.x, p.y, p.type === "mouse" ? 3 : 12);
      if (i >= 0) {
        mode = "node";
        start = { x: p.x, y: p.y, i, ox: xy[2 * i] - (p.x - tx) / k, oy: xy[2 * i + 1] - (p.y - ty) / k };
      } else {
        mode = "pan";
        start = { x: p.x, y: p.y, tx, ty };
      }
    } else mode = null;
  }
  function endDrag() {
    if (dragNode >= 0) { const i = dragNode; dragNode = -1; opts.onDragEnd?.(i); invalidate(); }
  }
  function applyInput() {
    if (mode === "pan") {
      const p = pointers.values().next().value;
      if (p) {
        if (Math.abs(p.x - start.x) + Math.abs(p.y - start.y) > 3) moved = true;
        if (moved) { tx = start.tx + p.x - start.x; ty = start.ty + p.y - start.y; autoFit = false; dirty = true; }
      }
    } else if (mode === "node") {
      const p = pointers.values().next().value;
      if (p) {
        if (!moved && Math.abs(p.x - start.x) + Math.abs(p.y - start.y) > 4) {
          moved = true; dragNode = start.i; hover = -1; opts.onDragStart?.(start.i);
        }
        if (moved) {
          const wx = (p.x - tx) / k + start.ox, wy = (p.y - ty) / k + start.oy;
          xy[2 * start.i] = wx; xy[2 * start.i + 1] = wy;
          posVersion++;
          opts.onDrag?.(start.i, wx, wy);
          dirty = true;
        }
      }
    } else if (mode === "pinch") {
      const [a, b] = [...pointers.values()];
      if (a && b) {
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        const nk = clamp(start.k * d / start.d, MIN_K, MAX_K);
        const wx = (start.cx - start.tx) / start.k, wy = (start.cy - start.ty) / start.k;
        k = nk; tx = cx - wx * k; ty = cy - wy * k;
        moved = true; autoFit = false; dirty = true;
      }
    }
    if (pendingHover && !mode) {
      pendingHover = false;
      const i = hoverPos ? hitTest(hoverPos.x, hoverPos.y, 3) : -1;
      if (i !== hover) { hover = i; canvas.style.cursor = i >= 0 ? "pointer" : ""; dirty = true; opts.onHover?.(i); }
    }
  }
  on(canvas, "pointerdown", (e) => {
    if (e.button > 0) return;
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, local(e));
    moved = false;
    beginGesture();
    invalidate();
  });
  on(canvas, "pointermove", (e) => {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    else if (e.pointerType === "mouse") { hoverPos = p; pendingHover = true; }
    if (!raf) raf = requestAnimationFrame(frame);
  });
  const up = (e) => {
    if (!pointers.has(e.pointerId)) return;
    applyInput();
    const wasMode = mode, wasMoved = moved, i = start?.i ?? -1;
    pointers.delete(e.pointerId);
    if (wasMode === "node") {
      if (wasMoved) endDrag();
      else if (e.type === "pointerup" && i >= 0) opts.onOpen?.(i);
    }
    if (pointers.size) { beginGesture(); moved = true; } else mode = null;
    if (e.pointerType === "mouse") { hoverPos = local(e); pendingHover = true; }
    invalidate();
  };
  on(canvas, "pointerup", up);
  on(canvas, "pointercancel", up);
  on(canvas, "pointerleave", (e) => { if (e.pointerType === "mouse" && !pointers.size) { hoverPos = null; pendingHover = true; invalidate(); } });
  on(canvas, "wheel", (e) => {
    e.preventDefault();
    const p = local(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * cssH : e.deltaY;
    autoFit = false;
    zoomAt(p.x, p.y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
  }, { passive: false });
  on(canvas, "keydown", (e) => {
    const step = 60;
    const keys = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (keys[e.key]) { tx += keys[e.key][0]; ty += keys[e.key][1]; autoFit = false; invalidate(); }
    else if (e.key === "+" || e.key === "=") { autoFit = false; zoomAt(cssW / 2, cssH / 2, 1.25); }
    else if (e.key === "-" || e.key === "_") { autoFit = false; zoomAt(cssW / 2, cssH / 2, 0.8); }
    else if (e.key === "0") { autoFit = true; fit(); }
    else if (e.key === "Enter" && hover >= 0) opts.onOpen?.(hover);
    else return;
    e.preventDefault();
  });
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);
  resize();

  return {
    canvas, stats,
    /** New graph + styles ({ radius, icon, color } from styleGraph) + positions. */
    setGraph(graph, style, positions) {
      g = graph;
      radius = style.radius; icons = style.icon; styleColors = style.color;
      maxR = 4;
      for (let i = 0; i < radius.length; i++) if (radius[i] > maxR) maxR = radius[i];
      hover = -1; dragNode = -1; mode = null; pointers.clear();
      labelCache.clear();
      computeColors();
      if (positions) this.setPositions(positions);
      else invalidate();
    },
    /** New positions (interleaved Float32Array, length 2n). The node being dragged keeps the pointer's position. */
    setPositions(p) {
      if (dragNode >= 0 && xy.length === p.length) { p[2 * dragNode] = xy[2 * dragNode]; p[2 * dragNode + 1] = xy[2 * dragNode + 1]; }
      xy = p; posVersion++;
      if (autoFit) fit(); else invalidate();
    },
    get positions() { return xy; },
    setTheme(t) { theme = t || readTheme(canvas.parentElement || document.body); computeColors(); invalidate(); },
    get theme() { return theme; },
    /** Zooms to show everything; auto-fit stays on until the user pans or zooms. */
    fit() { autoFit = true; fit(); },
    get view() { return { k, tx, ty, width: cssW, height: cssH, autoFit }; },
    setView(v) { k = clamp(v.k ?? k, MIN_K, MAX_K); tx = v.tx ?? tx; ty = v.ty ?? ty; autoFit = false; invalidate(); },
    /** Highlights a node as if hovered (keyboard list focus), -1 to clear. */
    setHover(i) { hover = i; invalidate(); },
    get hover() { return hover; },
    /** Centres the view on node i (without changing zoom). */
    centerOn(i) { if (i >= 0 && 2 * i < xy.length) { tx = cssW / 2 - xy[2 * i] * k; ty = cssH / 2 - xy[2 * i + 1] * k; autoFit = false; invalidate(); } },
    hitTest, invalidate,
    /** Current gesture (for tests): { mode: null | "pan" | "node" | "pinch", pointers, dragNode } */
    get gesture() { return { mode, pointers: pointers.size, dragNode }; },
    /** Screen (CSS px) position of node i. */
    toScreen: (i) => ({ x: xy[2 * i] * k + tx, y: xy[2 * i + 1] * k + ty }),
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      for (const [t, ev, fn, o] of listeners) t.removeEventListener(ev, fn, o);
    }
  };
}
