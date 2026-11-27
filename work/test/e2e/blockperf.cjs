// Long-document experiment (Playwright, dev-only, report only): a 600-block page with and without
// `.blk-wrap { content-visibility: auto; contain-intrinsic-size: auto 28px }` (injected here, it is NOT in style.css).
// Prints open time (median of RUNS) for both, then checks drag, handle hit-testing, focus scrolling and the TOC jump with
// the rule on. Result when it was tried (ticket 016 item 1): ~50% slower to first frame, gutter clipped, TOC jump off by
// thousands of px, so the rule was not adopted. Exit code is 0; read the FAIL lines.
// usage: PORT=8094 node work/test/e2e/blockperf.cjs   (RUNS=5 by default; starts its own static server on PORT)
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");

const PORT = Number(process.env.PORT) || 8099;
const RUNS = Number(process.env.RUNS) || 5;
const N = 600;
const pub = path.resolve(__dirname, "../../../source/app");
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", pub], { stdio: "ignore" });

const blk = (i) => {
  const id = `b${String(i).padStart(4, "0")}`;
  if (i % 40 === 0) return { id, type: "h2", text: `Section ${i / 40}` };
  if (i % 7 === 0) return { id, type: "todo", text: `Task ${i} with **bold** and a [link](https://example.com)`, checked: false };
  if (i % 5 === 0) return { id, type: "bullet", text: `Bullet ${i} some longer text to make the line wrap sometimes, ${"word ".repeat(i % 30)}` };
  if (i % 97 === 0) return { id, type: "callout", text: `Callout ${i}`, icon: "icon:lightbulb", bg: "grey" };
  return { id, type: "p", text: `Paragraph ${i}. ${"Lorem ipsum dolor sit amet. ".repeat(1 + (i % 4))}` };
};
const blocks = Array.from({ length: N }, (_, i) => blk(i));
const pages = [
  { id: "repo", type: "repo", title: "Repo", parentId: null, createdAt: 1, updatedAt: 1 },
  { id: "doc", type: "doc", title: "Long", parentId: "repo", createdAt: 2, updatedAt: 2, blocks: [{ id: "toc", type: "toc" }, ...blocks] }
];
const STUB = `import { createMemoryAdapter } from "./adapters/memory.js";
export async function createStore() { const s = createMemoryAdapter(); const d = await (await fetch("__seed.json")).json();
  for (const p of d.pages) await s.set("pages", p.id, p); return s; }`;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const errs = [];
  const fail = (m) => { errs.push(m); console.error("FAIL:", m); };
  const open = async (on) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    page.on("pageerror", (e) => errs.push(e.message));
    await page.route("**/js/store.js", (r) => r.fulfill({ contentType: "text/javascript", body: STUB }));
    await page.route("**/__seed.json", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ pages }) }));
    await page.route("**/css/style.css", async (r) => {
      const res = await r.fetch();
      const css = (await res.text()) + (on ? "\n.blk-wrap { content-visibility: auto; contain-intrinsic-size: auto 28px; }\n" : "");
      r.fulfill({ response: res, body: css });
    });
    await page.addInitScript(() => { window.__t0 = performance.now(); });
    await page.goto(`http://127.0.0.1:${PORT}/index.html#page-doc`);
    return page;
  };
  const openTime = async (on) => {
    const page = await open(on);
    const ms = await page.evaluate((n) => new Promise((resolve) => {
      const check = () => {
        if (document.querySelectorAll(".blk-wrap").length >= n) {
          const built = performance.now() - window.__t0;
          document.body.offsetHeight; // force layout
          const laid = performance.now() - window.__t0;
          requestAnimationFrame(() => requestAnimationFrame(() => resolve({ ms: performance.now() - window.__t0, built, laid })));
        } else setTimeout(check, 5);
      };
      check();
    }), N);
    await page.context().close();
    return ms;
  };
  for (const on of [false, true, false, true]) await openTime(on); // warm up the server and disk cache
  const off = [], onT = [];
  for (let i = 0; i < RUNS; i++) {
    const a = await openTime(false);
    const b = await openTime(true);
    off.push(a.ms);
    onT.push(b.ms);
    if (process.env.DETAIL) console.log(JSON.stringify([a, b]));
  }
  console.log(`open ${N}-block doc: before ${median(off).toFixed(0)} ms, after ${median(onT).toFixed(0)} ms (runs: ${off.map((x) => x.toFixed(0))} / ${onT.map((x) => x.toFixed(0))})`);

  // ---- behaviour with the rule on
  const page = await open(true);
  await page.waitForSelector(".blk-wrap");
  await page.waitForFunction((n) => document.querySelectorAll(".blk-wrap").length >= n, N);
  const cv = await page.evaluate(() => getComputedStyle(document.querySelector(".blk-wrap")).contentVisibility);
  if (cv !== "auto") fail(`content-visibility is "${cv}", expected auto`);

  // gutter handle stays visible and left of the text (not clipped by the wrap's paint containment)
  const gutter = await page.evaluate(() => {
    const w = document.querySelector(`.blk-wrap[data-id="b0001"]`);
    const g = w.querySelector(":scope > .blk-row > .gutter");
    const t = w.querySelector(".blk-content");
    w.querySelector(".blk-row").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    const gr = g.getBoundingClientRect(), tr = t.getBoundingClientRect(), wr = w.getBoundingClientRect();
    const hit = document.elementFromPoint(gr.left + gr.width / 2, gr.top + gr.height / 2);
    return { gl: gr.left, gr: gr.right, tl: tr.left, wl: wr.left, hit: hit === g || g.contains(hit) };
  });
  if (!(gutter.gr <= gutter.tl)) fail(`gutter overlaps text: ${JSON.stringify(gutter)}`);
  if (!gutter.hit) fail(`gutter is not hit-testable (clipped?): ${JSON.stringify(gutter)}`);

  // drag: move block b0003 before b0001 (HTML5 drag events)
  const before = await page.evaluate(() => [...document.querySelectorAll(".blocks > .blk-wrap")].slice(1, 6).map((e) => e.dataset.id));
  await page.evaluate(() => {
    const dt = new DataTransfer();
    const src = document.querySelector(`.blk-wrap[data-id="b0003"] > .blk-row > .gutter`);
    const dst = document.querySelector(`.blk-wrap[data-id="b0001"] > .blk-row`);
    src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    const r = dst.getBoundingClientRect();
    dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 5, clientY: r.top + 2 }));
    dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 5, clientY: r.top + 2 }));
    src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
  });
  await page.waitForTimeout(300);
  const afterDrag = await page.evaluate(() => [...document.querySelectorAll(".blocks > .blk-wrap")].slice(1, 6).map((e) => e.dataset.id));
  if (afterDrag[1] !== "b0003") fail(`drag did not reorder: ${before} -> ${afterDrag}`);

  // drop indicator is not clipped at the top of a wrap
  const shadow = await page.evaluate(() => {
    const w = document.querySelector(`.blk-wrap[data-id="b0010"]`);
    const row = w.querySelector(":scope > .blk-row");
    row.classList.add("drop-before");
    const wr = w.getBoundingClientRect(), rr = row.getBoundingClientRect();
    row.classList.remove("drop-before");
    return { wrapTop: wr.top, rowTop: rr.top };
  });
  console.log("drop-indicator geometry", JSON.stringify(shadow));

  // focus scrolling: focusing a far block scrolls it into view
  await page.evaluate(() => { document.querySelector("#main").scrollTop = 0; });
  const focused = await page.evaluate(async () => {
    const w = document.querySelector(`.blk-wrap[data-id="b0500"]`);
    w.querySelector(".rendered")?.click();
    await new Promise((r) => setTimeout(r, 300));
    const ta = w.querySelector("textarea.blk-ta");
    ta?.focus();
    ta?.scrollIntoView({ block: "center" });
    await new Promise((r) => setTimeout(r, 300));
    const r = (ta ?? w).getBoundingClientRect();
    return { top: r.top, h: innerHeight, active: document.activeElement === ta };
  });
  if (!(focused.top >= 0 && focused.top < focused.h)) fail(`focused block not in view: ${JSON.stringify(focused)}`);

  // TOC jump (smooth scroll to a heading far below): it must end centred on the heading
  await page.evaluate(() => { document.querySelector("#main").scrollTop = 0; });
  const target = "b0480";
  await page.locator(".toc-item", { hasText: "Section 12" }).click();
  await page.waitForTimeout(2500);
  const toc = await page.evaluate((id) => {
    const r = document.querySelector(`.blk-wrap[data-id="${id}"]`).getBoundingClientRect();
    return { mid: r.top + r.height / 2, h: innerHeight };
  }, target);
  const off2 = Math.abs(toc.mid - toc.h / 2);
  console.log(`TOC jump to ${target}: heading centre ${toc.mid.toFixed(0)}px of ${toc.h}px viewport (off by ${off2.toFixed(0)}px)`);
  if (off2 > 150) fail(`TOC jump landed ${off2.toFixed(0)}px away from centre`);

  await browser.close();
  server.kill();
  console.log(errs.length ? `${errs.length} problem(s) with the rule on` : "no problems with the rule on");
})().catch((e) => { console.error(e); server.kill(); process.exit(1); });
