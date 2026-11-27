// Force-directed layout (pure, no DOM; runs on the main thread, in layout.worker.js, or in Node).
// Forces per tick: Barnes–Hut many-body repulsion (flat typed-array quadtree, O(n log n)), springs along edges
// (d3-style strength 1/min(degree) and degree bias), a weak pull to the origin so separate components stay close,
// and re-centring. Velocity Verlet with velocity decay; alpha cools each tick and the simulation stops once it is
// below alphaMin (isSettled). Deterministic for a given seed and input (no Math.random).

export const DEFAULTS = Object.freeze({
  charge: -40,        // many-body strength (negative = repel)
  theta: 0.9,         // Barnes–Hut accuracy (larger = faster, rougher)
  linkDistance: 34,   // spring rest length (plus the two radii)
  linkStrength: 1,    // multiplier on 1/min(degree)
  gravity: 0.045,     // pull towards the origin
  alphaDecay: 0.035,  // ≈ 180 ticks from alpha 1 to alphaMin
  alphaMin: 0.002,
  velocityDecay: 0.4,
  distanceMin: 1
});

/** Seeded PRNG (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {{ n: number, source: ArrayLike<number>, target: ArrayLike<number>, radius?: ArrayLike<number>,
 *           seed?: number, positions?: ArrayLike<number> | null, known?: ArrayLike<number> | null, options?: object }} spec
 *   positions: interleaved [x0, y0, x1, y1, …] warm-start positions; `known[i]` = 1 where positions[i] is real
 *   (omit `known` when every position is real). Unknown nodes are placed next to a known neighbour.
 */
export function createLayout(spec) {
  const o = { ...DEFAULTS, ...(spec.options || {}) };
  const n = spec.n | 0;
  const S = Uint32Array.from(spec.source || []), T = Uint32Array.from(spec.target || []);
  const m = Math.min(S.length, T.length);
  const R = new Float32Array(n);
  if (spec.radius) for (let i = 0; i < n; i++) R[i] = spec.radius[i] || 0;
  const rand = rng(spec.seed ?? 1);
  const x = new Float64Array(n), y = new Float64Array(n), vx = new Float64Array(n), vy = new Float64Array(n);
  const fx = new Float64Array(n).fill(NaN), fy = new Float64Array(n).fill(NaN);

  // spring constants
  const count = new Uint32Array(n);
  for (let e = 0; e < m; e++) { count[S[e]]++; count[T[e]]++; }
  const bias = new Float64Array(m), strength = new Float64Array(m), dist = new Float64Array(m);
  for (let e = 0; e < m; e++) {
    const a = count[S[e]], b = count[T[e]];
    bias[e] = a / (a + b);
    strength[e] = o.linkStrength / Math.min(a, b);
    dist[e] = o.linkDistance + R[S[e]] + R[T[e]];
  }

  // initial placement: phyllotaxis spiral (as d3), then warm-start positions where known
  let knownCount = 0;
  const step0 = 10, golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = step0 * Math.sqrt(0.5 + i), a = i * golden;
    x[i] = r * Math.cos(a); y[i] = r * Math.sin(a);
  }
  if (spec.positions) {
    const P = spec.positions, K = spec.known;
    const isKnown = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (K && !K[i]) continue;
      const px = P[2 * i], py = P[2 * i + 1];
      if (Number.isFinite(px) && Number.isFinite(py)) { x[i] = px; y[i] = py; isKnown[i] = 1; knownCount++; }
    }
    if (knownCount && knownCount < n) {
      // place new nodes beside a placed neighbour (repeat so chains of new nodes fill in), else on the outer ring
      let cx = 0, cy = 0, maxR = 0;
      for (let i = 0; i < n; i++) if (isKnown[i]) { cx += x[i]; cy += y[i]; }
      cx /= knownCount; cy /= knownCount;
      for (let i = 0; i < n; i++) if (isKnown[i]) maxR = Math.max(maxR, Math.hypot(x[i] - cx, y[i] - cy));
      for (let pass = 0; pass < 4; pass++) {
        let placed = 0;
        for (let e = 0; e < m; e++) {
          const a = S[e], b = T[e];
          const from = isKnown[a] && !isKnown[b] ? a : isKnown[b] && !isKnown[a] ? b : -1;
          if (from < 0) continue;
          const to = from === a ? b : a, ang = rand() * Math.PI * 2;
          x[to] = x[from] + Math.cos(ang) * o.linkDistance; y[to] = y[from] + Math.sin(ang) * o.linkDistance;
          isKnown[to] = 2; placed++;
        }
        if (!placed) break;
      }
      for (let i = 0; i < n; i++) if (!isKnown[i]) {
        const ang = rand() * Math.PI * 2, r = maxR + o.linkDistance * (1 + rand());
        x[i] = cx + Math.cos(ang) * r; y[i] = cy + Math.sin(ang) * r;
      }
    }
  }
  // a warm start (most positions known) only needs a short, gentle settle
  // (every position known = already laid out; pass spec.alpha to override, e.g. after edges changed)
  let alpha = spec.alpha != null ? +spec.alpha : n === 0 || knownCount === n ? 0 : knownCount >= n * 0.9 ? 0.12 : knownCount ? 0.5 : 1;
  let ticks = 0;

  // quadtree storage (grown on demand)
  let cap = 0, child, mass, mx, my, bx, by, bs;
  const next = new Int32Array(n);
  let stack = new Int32Array(256);
  const grow = (need) => {
    if (need <= cap) return;
    const c = Math.max(need, cap * 2, 64);
    const nc = new Int32Array(c * 4); if (child) nc.set(child); child = nc;
    for (const k of ["mass", "mx", "my", "bx", "by", "bs"]) {
      const a = new Float64Array(c);
      const old = { mass, mx, my, bx, by, bs }[k];
      if (old) a.set(old);
      if (k === "mass") mass = a; else if (k === "mx") mx = a; else if (k === "my") my = a;
      else if (k === "bx") bx = a; else if (k === "by") by = a; else bs = a;
    }
    cap = c;
  };
  let cells = 0;
  const newCell = (x0, y0, s) => {
    if (cells >= cap) grow(cells + 1);
    const c = cells++;
    child[4 * c] = child[4 * c + 1] = child[4 * c + 2] = child[4 * c + 3] = -1;
    bx[c] = x0; by[c] = y0; bs[c] = s;
    return c;
  };
  function buildTree() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const a = x[i], b = y[i];
      if (a < x0) x0 = a; if (a > x1) x1 = a; if (b < y0) y0 = b; if (b > y1) y1 = b;
    }
    const s = Math.max(x1 - x0, y1 - y0, 1) * 1.0001 + 1e-6;
    grow(n * 2 + 8);
    cells = 0;
    newCell(x0, y0, s);
    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = y[i];
      let c = 0, depth = 0;
      for (;;) {
        const h = bs[c] / 2, midx = bx[c] + h, midy = by[c] + h;
        const q = (xi >= midx ? 1 : 0) | (yi >= midy ? 2 : 0);
        const k = 4 * c + q, slot = child[k];
        if (slot === -1) { child[k] = -(i + 2); next[i] = -1; break; }
        if (slot >= 0) { c = slot; depth++; continue; }
        const j = -slot - 2;
        if ((x[j] === xi && y[j] === yi) || depth > 48) { next[i] = j; child[k] = -(i + 2); break; }
        const nc = newCell(q & 1 ? midx : bx[c], q & 2 ? midy : by[c], h);
        child[k] = nc;
        const h2 = h / 2;
        const qj = (x[j] >= bx[nc] + h2 ? 1 : 0) | (y[j] >= by[nc] + h2 ? 2 : 0);
        child[4 * nc + qj] = slot;
        c = nc; depth++;
      }
    }
    // centres of mass, children before parents (children always have larger indices)
    for (let c = cells - 1; c >= 0; c--) {
      let ms = 0, sx = 0, sy = 0;
      for (let q = 0; q < 4; q++) {
        const slot = child[4 * c + q];
        if (slot >= 0) { const w = mass[slot]; ms += w; sx += mx[slot] * w; sy += my[slot] * w; }
        else if (slot <= -2) for (let p = -slot - 2; p >= 0; p = next[p]) { ms++; sx += x[p]; sy += y[p]; }
      }
      mass[c] = ms; mx[c] = sx / ms; my[c] = sy / ms;
    }
  }

  const jiggle = () => (rand() - 0.5) * 1e-6;
  function manyBody() {
    if (n < 2) return;
    buildTree();
    const th2 = o.theta * o.theta, dmin2 = o.distanceMin * o.distanceMin, k = o.charge * alpha;
    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = y[i];
      let ax = 0, ay = 0, sp = 0;
      stack[sp++] = 0;
      while (sp) {
        const c = stack[--sp];
        let dx = mx[c] - xi, dy = my[c] - yi, d2 = dx * dx + dy * dy;
        const w = bs[c];
        if (w * w < th2 * d2) {
          if (d2 < dmin2) d2 = Math.sqrt(dmin2 * d2);
          const f = k * mass[c] / d2;
          ax += dx * f; ay += dy * f;
          continue;
        }
        for (let q = 0; q < 4; q++) {
          const slot = child[4 * c + q];
          if (slot >= 0) {
            if (sp >= stack.length) { const ns = new Int32Array(stack.length * 2); ns.set(stack); stack = ns; }
            stack[sp++] = slot;
          } else if (slot <= -2) {
            for (let p = -slot - 2; p >= 0; p = next[p]) {
              if (p === i) continue;
              dx = x[p] - xi; dy = y[p] - yi;
              if (dx === 0) dx = jiggle();
              if (dy === 0) dy = jiggle();
              d2 = dx * dx + dy * dy;
              if (d2 < dmin2) d2 = Math.sqrt(dmin2 * d2);
              const f = k / d2;
              ax += dx * f; ay += dy * f;
            }
          }
        }
      }
      vx[i] += ax; vy[i] += ay;
    }
  }

  function springs() {
    for (let e = 0; e < m; e++) {
      const s = S[e], t = T[e];
      let dx = x[t] + vx[t] - x[s] - vx[s], dy = y[t] + vy[t] - y[s] - vy[s];
      if (dx === 0) dx = jiggle();
      if (dy === 0) dy = jiggle();
      let l = Math.sqrt(dx * dx + dy * dy);
      l = (l - dist[e]) / l * alpha * strength[e];
      dx *= l; dy *= l;
      const b = bias[e];
      vx[t] -= dx * b; vy[t] -= dy * b;
      vx[s] += dx * (1 - b); vy[s] += dy * (1 - b);
    }
  }

  function tick() {
    alpha += (0 - alpha) * o.alphaDecay;
    springs();
    manyBody();
    const g = o.gravity * alpha;
    for (let i = 0; i < n; i++) { vx[i] -= x[i] * g; vy[i] -= y[i] * g; }
    const keep = 1 - o.velocityDecay;
    let pinned = 0;
    for (let i = 0; i < n; i++) {
      if (fx[i] === fx[i]) { x[i] = fx[i]; y[i] = fy[i]; vx[i] = vy[i] = 0; pinned++; continue; }
      vx[i] *= keep; vy[i] *= keep;
      x[i] += vx[i]; y[i] += vy[i];
    }
    if (!pinned && n) {
      // re-centre (only when nothing is held, so a dragged node never slides under the pointer)
      let cx = 0, cy = 0;
      for (let i = 0; i < n; i++) { cx += x[i]; cy += y[i]; }
      cx /= n; cy /= n;
      for (let i = 0; i < n; i++) { x[i] -= cx; y[i] -= cy; }
    }
    ticks++;
  }

  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const layout = {
    n, x, y,
    get alpha() { return alpha; },
    get ticks() { return ticks; },
    options: o,
    /** Runs k ticks (even when settled). */
    step(k = 1) { for (let i = 0; i < k; i++) tick(); return layout; },
    /** Ticks until settled or `maxMs` (default 16) / `maxTicks` is used up. Returns the ticks run. */
    run(maxMs = 16, maxTicks = Infinity) {
      const t0 = now();
      let k = 0;
      while (!layout.isSettled() && k < maxTicks) {
        tick(); k++;
        if ((k & 1) === 0 && now() - t0 >= maxMs) break;
      }
      return k;
    },
    isSettled: () => alpha < o.alphaMin,
    /** Raises alpha (e.g. while dragging) so the layout moves again. */
    reheat(a = 0.3) { alpha = Math.max(alpha, a); return layout; },
    /** Sets alpha exactly (use 0 to stop). */
    setAlpha(a) { alpha = Math.max(0, a); return layout; },
    /** Holds node i at (px, py) until unpin(i). */
    pin(i, px, py) { if (i >= 0 && i < n) { fx[i] = px; fy[i] = py; x[i] = px; y[i] = py; vx[i] = vy[i] = 0; } return layout; },
    unpin(i) { if (i >= 0 && i < n) { fx[i] = NaN; fy[i] = NaN; } return layout; },
    isPinned: (i) => fx[i] === fx[i],
    /** Writes interleaved positions into `out` (Float32Array(2n), allocated when omitted) and returns it. */
    positions(out) {
      out = out || new Float32Array(2 * n);
      for (let i = 0; i < n; i++) { out[2 * i] = x[i]; out[2 * i + 1] = y[i]; }
      return out;
    },
    /** { [id]: [x, y] } for caching (rounded to 0.1). `ids[i]` names node i. */
    exportPositions(ids) {
      const outObj = {};
      for (let i = 0; i < n; i++) outObj[ids[i]] = [Math.round(x[i] * 10) / 10, Math.round(y[i] * 10) / 10];
      return outObj;
    }
  };
  return layout;
}

/**
 * Turns a cache { [id]: [x, y] } into warm-start arrays for createLayout: { positions, known, count }.
 * @param {string[]} ids  ids[i] names node i
 */
export function importPositions(ids, cache) {
  const n = ids.length;
  const positions = new Float32Array(2 * n), known = new Uint8Array(n);
  let count = 0;
  if (cache && typeof cache === "object") {
    for (let i = 0; i < n; i++) {
      const p = Object.hasOwn(cache, ids[i]) ? cache[ids[i]] : null;
      if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
        positions[2 * i] = p[0]; positions[2 * i + 1] = p[1]; known[i] = 1; count++;
      }
    }
  }
  return { positions: count ? positions : null, known: count ? known : null, count };
}
