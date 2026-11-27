// Graph engine in Chromium (Playwright, dev-only): layout settle time (worker and main thread), frame cost while
// scripting pan / zoom / pinch / node drag, with and without 4x CPU throttling, and no console errors.
// usage: PORT=8094 node work/test/e2e/graph.cjs            (1000 nodes / 3000 edges, asserts targets)
//        GRAPH_SIZES=1000,5000 SHOTS=/some/dir PORT=8094 node work/test/e2e/graph.cjs   (more sizes, screenshots)
// Starts its own static server on PORT over the repo root; the harness page is served by a Playwright route.
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "../../..");
const PORT = Number(process.env.PORT) || 8099;
const SIZES = (process.env.GRAPH_SIZES || "1000").split(",").map(Number);
const SHOTS = process.env.SHOTS || "";
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", root], { stdio: "ignore" });
const base = `http://127.0.0.1:${PORT}`;

const HARNESS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Graph harness</title>
<style>
:root { --bg:#ffffff; --text:#1f2530; --muted:#5b6577; --border-ctl:#848d9d; --accent:oklch(0.5 0.16 250); --accent-soft:oklch(0.95 0.035 250); }
:root[data-mode=dark] { --bg:#14171c; --text:#e6e9ee; --muted:#8d97a6; --border-ctl:#667185; --accent:oklch(0.72 0.16 250); }
html, body { margin:0; height:100%; background:var(--bg); color:var(--text); font-family:system-ui, sans-serif; }
#g { position:fixed; inset:0; }
</style></head><body><div id="g"></div>
<script type="module">
import { createGraphView } from "/source/app/js/graph/index.js";
import { rng } from "/source/app/js/graph/layout.js";
const q = new URLSearchParams(location.search);
const n = +q.get("n") || 1000, m = +q.get("m") || n * 3;
if (q.get("dark")) document.documentElement.dataset.mode = "dark";
const r = rng(3), links = [], seen = new Set();
for (let i = 1; i < n; i++) { const j = Math.floor(r() * i); links.push({ from: "p" + i, to: "p" + j }); seen.add(i * n + j); }
while (links.length < m) {
  const a = Math.floor(r() * n), b = r() < 0.7 ? Math.min(n - 1, Math.max(0, a + Math.floor((r() - 0.5) * 40))) : Math.floor(r() * n);
  if (a === b || seen.has(a * n + b) || seen.has(b * n + a)) continue;
  seen.add(a * n + b); links.push({ from: "p" + a, to: "p" + b });
  if (r() < 0.15) links.push({ from: "p" + b, to: "p" + a });          // some mutual links
}
const status = ["Todo", "Doing", "Done"], type = ["Note", "Person", "Project"];
const pages = Array.from({ length: n }, (_, i) => ({ id: "p" + i, title: "Page " + i + (i % 7 === 0 ? " with a longer title" : ""), kind: "page", repo: "r" + (i % 3),
  props: { Status: status[i % 3], Type: type[Math.floor(i / 3) % 3] }, graph: i === 0 ? { color: "orange", icon: "star", size: 2 } : undefined }));
const rules = [{ when: { prop: "Status", op: "is", value: "Done" }, color: "green", icon: "check" }, { when: { prop: "Type", op: "is", value: "Person" }, color: "purple", icon: "user", size: 1.5 }];
const t0 = performance.now();
window.__opened = [];
const view = createGraphView(document.getElementById("g"), {
  data: { pages, links }, styleRules: rules, worker: q.get("worker") !== "0", seed: 1,
  onOpen: (id) => window.__opened.push(id),
  local: q.get("focus") ? { focusId: q.get("focus"), depth: +q.get("depth") || 2 } : null
});
view.onSettled = () => { if (!window.__settleMs) window.__settleMs = performance.now() - t0; };
window.__view = view;
</script></body></html>`;

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const fmt = (a) => `p50 ${pct(a, 0.5).toFixed(2)} / p95 ${pct(a, 0.95).toFixed(2)} / max ${Math.max(0, ...a).toFixed(2)} ms (${a.length} frames)`;

const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, hasTouch: true };
const PHONE = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, hasTouch: true, isMobile: true };
async function run(browser, { n, worker = true, throttle = 1, dark = false, shot = "", phone = false }) {
  const ctx = await browser.newContext(phone ? PHONE : DESKTOP);
  const W = phone ? 412 : 1280, H = phone ? 915 : 800, cx = W / 2, cy = H / 2;
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (msg) => msg.type() === "error" && errs.push(msg.text()));
  await page.route(`${base}/__graph.html*`, (r) => r.fulfill({ contentType: "text/html", body: HARNESS }));
  const cdp = await ctx.newCDPSession(page);
  if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  await page.goto(`${base}/__graph.html?n=${n}&worker=${worker ? 1 : 0}${dark ? "&dark=1" : ""}`);
  await page.waitForFunction(() => window.__settleMs, null, { timeout: 120000 }).catch(async (e) => { throw new Error(e.message + " state: " + JSON.stringify(await page.evaluate(() => ({ view: !!window.__view, settled: window.__view?.runner?.settled, worker: window.__view?.runner?.usingWorker, n: window.__view?.graph?.nodes.length, errs: window.__errs })))); });
  const settleMs = await page.evaluate(() => window.__settleMs);
  const usingWorker = await page.evaluate(() => window.__view.runner.usingWorker);
  // pure layout compute on this (possibly throttled) main thread: what a phone's worker would spend
  const computeMs = await page.evaluate(async () => {
    const { createLayout } = await import("/source/app/js/graph/layout.js");
    const g = window.__view.graph;
    const L = createLayout({ n: g.nodes.length, source: g.source, target: g.target, seed: 1 });
    const t0 = performance.now();
    while (!L.isSettled()) L.step();
    return performance.now() - t0;
  });
  await page.waitForTimeout(300);
  if (shot) await page.screenshot({ path: `${shot}-fit.png` });

  // frame measurement: rAF deltas + the renderer's own draw cost
  const startMeasure = () => page.evaluate(() => {
    const v = window.__view;
    v.renderer.stats.draws.length = 0;
    window.__deltas = [];
    let last = performance.now();
    window.__measuring = true;
    const loop = (t) => { window.__deltas.push(t - last); last = t; if (window.__measuring) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  const stopMeasure = () => page.evaluate(() => { window.__measuring = false; return { deltas: window.__deltas.slice(2), draws: window.__view.renderer.stats.draws.slice() }; });

  // input helpers: mouse on desktop, CDP touch on the phone profile (pinch uses touch on both)
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  const dragPath = async (x0, y0, steps, at) => {
    if (phone) {
      await touch("touchStart", [[x0, y0]]);
      for (let i = 1; i <= steps; i++) await touch("touchMove", [at(i)]);
    } else {
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) await page.mouse.move(...at(i));
    }
  };
  const release = () => (phone ? touch("touchEnd", []) : page.mouse.up());
  const empty = await page.evaluate(([W, H]) => {
    const R = window.__view.renderer;
    for (let y = 20; y < H; y += 23) for (let x = 20; x < W / 2; x += 23) if (R.hitTest(x, y, 20) < 0) return [x, y];
    return [5, 5];
  }, [W, H]);

  await startMeasure();
  // pan on empty space
  await dragPath(empty[0], empty[1], 60, (i) => [empty[0] + i * (phone ? 2 : 6), empty[1] + i * 3]);
  await release();
  // wheel zoom in and out around the centre (desktop)
  if (!phone) {
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 25; i++) await page.mouse.wheel(0, -60);
    if (shot) await page.screenshot({ path: `${shot}-zoomed.png` });
    for (let i = 0; i < 25; i++) await page.mouse.wheel(0, 60);
  }
  // pinch out then in (two touch points)
  await touch("touchStart", [[cx - 40, cy], [cx + 40, cy]]);
  for (let i = 1; i <= 20; i++) await touch("touchMove", [[cx - 40 - i * 6, cy], [cx + 40 + i * 6, cy]]);
  if (phone && shot) await page.screenshot({ path: `${shot}-zoomed.png` });
  for (let i = 19; i >= 0; i--) await touch("touchMove", [[cx - 40 - i * 6, cy], [cx + 40 + i * 6, cy]]);
  await touch("touchEnd", []);
  // let queued input (wheel, touch) land and the view come to rest before picking a node on screen
  await page.waitForTimeout(throttle > 1 ? 400 : 100);
  await page.evaluate(async () => {
    const R = window.__view.renderer, key = () => JSON.stringify(R.view);
    let last = "";
    for (let i = 0; i < 100 && key() !== last; i++) { last = key(); await new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 50)); }
  });
  // node drag: pick the node nearest the centre that is on screen
  const target = await page.evaluate(([cx, cy]) => {
    const v = window.__view, R = v.renderer, n = v.graph.nodes.length;
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++) { const p = R.toScreen(i); const d = Math.hypot(p.x - cx, p.y - cy); if (d < bd && R.hitTest(p.x, p.y, 1) === i) { bd = d; best = i; } }
    return best >= 0 ? { i: best, ...R.toScreen(best) } : null;
  }, [cx, cy]);
  let dragged = false, gesture = null;
  if (target) {
    const at = (i) => [target.x + i * 2, target.y + Math.sin(i / 6) * 40];
    await dragPath(target.x, target.y, 1, at);
    gesture = await page.evaluate(() => window.__view.renderer.gesture);
    for (let i = 2; i <= 60; i++) phone ? await touch("touchMove", [at(i)]) : await page.mouse.move(...at(i));
    await page.waitForTimeout(throttle > 1 ? 300 : 50);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    if (shot) await page.screenshot({ path: `${shot}-drag.png` });
    const pos = await page.evaluate((i) => window.__view.renderer.toScreen(i), target.i);
    dragged = Math.hypot(pos.x - at(60)[0], pos.y - at(60)[1]) < 6;
    await release();
  }
  const { deltas, draws } = await stopMeasure();
  // hover highlight + click opens
  let opened = null;
  if (target) {
    await page.waitForFunction(() => window.__view.runner.settled, null, { timeout: 60000 });
    await page.waitForTimeout(50);
    const p = await page.evaluate((i) => window.__view.renderer.toScreen(i), target.i);
    if (phone) await page.touchscreen.tap(p.x, p.y);
    else {
      await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(50);
      if (shot) await page.screenshot({ path: `${shot}-hover.png` });
      await page.mouse.click(p.x, p.y);
    }
    opened = await page.evaluate(() => window.__opened[0] || null);
  }
  // keyboard list fallback renders and opens
  const listOk = await page.evaluate(() => {
    const v = window.__view;
    v.setMode("list");
    const b = document.querySelector(".graph-list-open");
    b?.focus();
    b?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const moved = document.activeElement !== b && document.activeElement?.classList.contains("graph-list-open");
    v.setMode("canvas");
    return !!b && moved;
  });
  await ctx.close();
  return { gesture, n, worker: usingWorker, throttle, settleMs, computeMs, deltas, draws, dragged, opened, target: target?.i, listOk, errs };
}

// Reduced motion (no intermediate layout frames), warm reopen from cached positions, theme switch, local graph.
async function extras(browser) {
  const fails = [];
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (msg) => msg.type() === "error" && errs.push(msg.text()));
  await page.route(`${base}/__graph.html*`, (r) => r.fulfill({ contentType: "text/html", body: HARNESS }));
  await page.goto(`${base}/__graph.html?n=1000`);
  await page.waitForFunction(() => window.__settleMs, null, { timeout: 60000 });
  const r = await page.evaluate(async () => {
    const v = window.__view, out = {};
    out.reducedFrames = v.renderer.stats.frames; // only drawn once the layout is done (plus the initial empty frame)
    // warm reopen: same data, cached positions -> no layout work
    let saved = null;
    const host = document.getElementById("g");
    const data = { pages: v.graph.nodes, links: [] };
    for (let e = 0; e < v.graph.edgeCount; e++) data.links.push({ from: v.graph.nodes[v.graph.source[e]].id, to: v.graph.nodes[v.graph.target[e]].id });
    const cache = { load: () => saved, save: (o) => { saved = o; } };
    const { createGraphView } = await import("/source/app/js/graph/index.js");
    v.destroy();
    const a = createGraphView(host, { data, positionsCache: cache, reducedMotion: true });
    await new Promise((res) => { a.onSettled = res; });
    a.destroy(); // saves
    out.cached = saved ? Object.keys(saved).length : 0;
    const t0 = performance.now();
    const b = createGraphView(host, { data, positionsCache: cache });
    await new Promise((res) => { if (b.runner.settled) res(); else b.onSettled = res; });
    out.warmMs = performance.now() - t0;
    // theme follows <html data-mode>
    const before = b.renderer.theme.bg;
    document.documentElement.dataset.mode = "dark";
    await new Promise((res) => setTimeout(res, 50));
    out.themeChanged = b.renderer.theme.bg !== before && b.renderer.theme.dark;
    // local graph around p0, depth 1
    b.setLocal({ focusId: "p0", depth: 1 });
    out.localNodes = b.graph.nodes.length;
    out.localFocus = b.graph.nodes[b.graph.focus]?.id;
    out.expectLocal = 1 + new Set(data.links.filter((l) => l.from === "p0" || l.to === "p0").map((l) => (l.from === "p0" ? l.to : l.from))).size;
    window.__view = b;
    return out;
  });
  await page.waitForTimeout(400);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "graph-local-dark.png") });
  console.log(`extras: reduced-motion frames ${r.reducedFrames}, warm reopen ${r.warmMs.toFixed(1)} ms (${r.cached} cached), local graph ${r.localNodes} nodes`);
  if (r.reducedFrames > 3) fails.push(`reduced motion drew ${r.reducedFrames} frames during layout`);
  if (r.cached !== 1000) fails.push(`positions cache saved ${r.cached} of 1000`);
  if (r.warmMs > 150) fails.push(`warm reopen took ${r.warmMs.toFixed(0)} ms`);
  if (!r.themeChanged) fails.push("theme did not follow data-mode");
  if (r.localNodes !== r.expectLocal || r.localFocus !== "p0") fails.push(`local graph: ${r.localNodes} nodes (want ${r.expectLocal}), focus ${r.localFocus}`);
  if (errs.length) fails.push(`extras: console errors: ${errs.join(" | ")}`);
  await ctx.close();
  return fails;
}

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const fails = [];
  try {
    for (const n of SIZES) {
      for (const [worker, throttle, phone] of [[true, 1, false], [false, 1, false], [true, 4, false], [false, 4, false], [true, 4, true]]) {
        const shot = SHOTS && worker && (throttle === 1 || phone) ? path.join(SHOTS, `graph-${n}${phone ? "-phone" : ""}`) : "";
        const r = await run(browser, { n, worker, throttle, shot, phone });
        console.log(`${n} nodes, ${phone ? "phone 412x915@2.6" : "desktop 1280x800@2"}, ${r.worker ? "worker" : "main thread"}, CPU ${throttle}x: settle ${r.settleMs.toFixed(0)} ms (layout compute alone ${r.computeMs.toFixed(0)} ms)`);
        console.log(`  draw  ${fmt(r.draws)}`);
        console.log(`  frame ${fmt(r.deltas)}`);
        const label = `${n}/${worker ? "worker" : "main"}/${throttle}x${phone ? "/phone" : ""}`;
        if (r.errs.length) fails.push(`${label}: console errors: ${r.errs.join(" | ")}`);
        if (worker && !r.worker) fails.push(`${label}: the worker did not start`);
        if (!r.dragged) fails.push(`${label}: dragged node did not follow the pointer (${JSON.stringify(r.gesture)})`);
        if (r.opened !== `p${r.target}`) fails.push(`${label}: click did not open the node (${r.opened})`);
        if (!r.listOk) fails.push(`${label}: list fallback did not render or navigate`);
        if (n <= 1000) {
          const limit = worker ? 1000 : 2500; // the main-thread fallback shares its thread with drawing
          if (throttle === 1 && r.settleMs > limit) fails.push(`${label}: settle ${r.settleMs.toFixed(0)} ms > ${limit}`);
          if (pct(r.draws, 0.95) > 16) fails.push(`${label}: draw p95 ${pct(r.draws, 0.95).toFixed(1)} ms > 16`);
        }
      }
      if (SHOTS) {
        const r = await run(browser, { n, dark: true, shot: path.join(SHOTS, `graph-${n}-dark`) });
        if (r.errs.length) fails.push(`${n}/dark: console errors: ${r.errs.join(" | ")}`);
      }
    }
    fails.push(...(await extras(browser)));
  } catch (e) {
    fails.push(String(e?.stack || e));
  }
  await browser.close();
  server.kill();
  if (fails.length) { console.log("FAIL\n  " + fails.join("\n  ")); process.exit(1); }
  console.log("ok   graph e2e");
})();
