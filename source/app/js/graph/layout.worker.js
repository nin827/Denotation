// Module worker running graph/layout.js off the main thread (see runner.js, which falls back to the main thread).
// In:  { type: "init", gen, spec, quiet }  spec as createLayout(); quiet = post only once settled (reduced motion)
//      { type: "pin", i, x, y, alpha? } | { type: "unpin", i } | { type: "reheat", alpha } | { type: "stop" }
// Out: { type: "tick", gen, xy: Float32Array (transferred, interleaved x/y), settled, alpha, ticks }
import { createLayout } from "./layout.js";

let L = null, gen = 0, quiet = false, timer = 0;
const post = () => {
  const xy = L.positions();
  self.postMessage({ type: "tick", gen, xy, settled: L.isSettled(), alpha: L.alpha, ticks: L.ticks }, [xy.buffer]);
};
const frame = () => {
  timer = 0;
  if (!L) return;
  L.run(quiet ? 50 : 15); // about one display frame of work, then post and yield for incoming pin/stop messages
  const settled = L.isSettled();
  if (!quiet || settled) post();
  if (!settled) timer = setTimeout(frame, 0);
};
const loop = () => { if (!timer && L && !L.isSettled()) timer = setTimeout(frame, 0); };

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === "init") {
    clearTimeout(timer); timer = 0;
    gen = m.gen; quiet = !!m.quiet;
    L = createLayout(m.spec);
    if (L.isSettled()) post(); else loop();
  } else if (!L) return;
  else if (m.type === "pin") { L.pin(m.i, m.x, m.y); if (m.alpha) L.reheat(m.alpha); if (L.isSettled()) post(); else loop(); }
  else if (m.type === "unpin") L.unpin(m.i);
  else if (m.type === "reheat") { L.reheat(m.alpha ?? 0.3); loop(); }
  else if (m.type === "stop") { clearTimeout(timer); timer = 0; L = null; }
};
