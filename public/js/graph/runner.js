// Runs a layout in a module Web Worker (layout.worker.js) when possible, else on the main thread in small
// setTimeout slices, and reports positions through onTick(xy, settled).
import { createLayout } from "./layout.js";

let genCounter = 0;

/**
 * @param {object} spec  createLayout() spec
 * @param {{ onTick: (xy: Float32Array, settled: boolean) => void, worker?: boolean, quiet?: boolean, sliceMs?: number }} opts
 *   quiet: no intermediate ticks, only the settled result (prefers-reduced-motion)
 * @returns {{ pin(i,x,y,alpha?), unpin(i), reheat(alpha), stop(), readonly xy: Float32Array, readonly settled: boolean,
 *            readonly usingWorker: boolean, readonly startedAt: number, readonly settledAt: number }}
 */
export function createLayoutRunner(spec, { onTick, worker = true, quiet = false, sliceMs = 8 } = {}) {
  const gen = ++genCounter;
  let xy = new Float32Array(2 * spec.n), settled = false, stopped = false, w = null, L = null, timer = 0;
  const startedAt = performance.now();
  let settledAt = 0;
  const emit = (buf, s) => {
    xy = buf; settled = s;
    if (s && !settledAt) settledAt = performance.now();
    if (!s) settledAt = 0;
    onTick?.(xy, s);
  };

  // main-thread fallback: time slices scheduled as tasks (not tied to frames, so a slow frame rate does not slow
  // the layout); the renderer draws emitted positions on its own requestAnimationFrame
  // (each emitted frame costs a redraw on this same thread, so emit at ~20 fps while laying out)
  let lastEmit = 0;
  const emitMs = 50;
  // zero-delay task (MessageChannel avoids setTimeout's 4 ms nesting clamp); input and frames still run between slices
  const mc = typeof MessageChannel === "function" ? new MessageChannel() : null;
  let queued = null;
  if (mc) mc.port1.onmessage = () => { const f = queued; queued = null; f?.(); };
  const later = (f) => { if (mc) { queued = f; mc.port2.postMessage(0); return 1; } return setTimeout(f, 0); };
  const mainLoop = () => {
    if (stopped || !L || timer) return;
    if (L.isSettled()) { emit(L.positions(new Float32Array(2 * L.n)), true); return; }
    const slice = () => {
      timer = 0;
      if (stopped) return;
      L.run(quiet ? 40 : sliceMs);
      const s = L.isSettled(), t = performance.now();
      if (s || (!quiet && t - lastEmit >= emitMs)) { lastEmit = t; emit(L.positions(new Float32Array(2 * L.n)), s); }
      if (!s) timer = later(slice);
    };
    timer = later(slice);
  };
  const startMain = () => {
    w = null;
    L = createLayout(spec);
    mainLoop();
  };

  if (worker && typeof Worker === "function") {
    try {
      w = new Worker(new URL("./layout.worker.js", import.meta.url), { type: "module" });
      let heard = false;
      w.onmessage = (e) => {
        heard = true;
        const m = e.data;
        if (stopped || m?.gen !== gen || m.type !== "tick") return;
        emit(m.xy, m.settled);
      };
      w.onerror = (e) => {
        e.preventDefault?.();
        if (!heard && !stopped) { w.terminate(); startMain(); }
      };
      // spec arrays are copied (structured clone); positions may be large, so send typed arrays
      w.postMessage({ type: "init", gen, quiet, spec: { ...spec, source: Uint32Array.from(spec.source), target: Uint32Array.from(spec.target) } });
    } catch {
      startMain();
    }
  } else startMain();

  return {
    pin(i, x, y, alpha = 0) {
      xy[2 * i] = x; xy[2 * i + 1] = y;
      if (w) w.postMessage({ type: "pin", i, x, y, alpha });
      else if (L) { L.pin(i, x, y); if (alpha) L.reheat(alpha); mainLoop(); }
    },
    unpin(i) { if (w) w.postMessage({ type: "unpin", i }); else L?.unpin(i); },
    reheat(alpha = 0.3) {
      if (w) w.postMessage({ type: "reheat", alpha });
      else if (L) { L.reheat(alpha); mainLoop(); }
    },
    stop() {
      stopped = true;
      if (w) { w.postMessage({ type: "stop" }); w.terminate(); w = null; }
      clearTimeout(timer); queued = null; mc?.port1.close();
    },
    get xy() { return xy; },
    get settled() { return settled; },
    get usingWorker() { return !!w; },
    get startedAt() { return startedAt; },
    get settledAt() { return settledAt; }
  };
}
