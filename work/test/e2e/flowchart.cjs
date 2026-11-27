// Flowchart block in the real app (Playwright, dev-only): insert with /flowchart, change layout / direction from the block
// menu, edit through the dialog (quick syntax, node and edge lists), node menu, reload persistence, 390px phone width.
// usage: PORT=8093 node work/test/e2e/flowchart.cjs      (screenshots go to SHOTS, default the agent scratchpad flow/ folder)
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "../../..");
const PORT = Number(process.env.PORT) || 8093;
if (PORT === 8080) throw new Error("port 8080 is the owner's data");
const SHOTS = process.env.SHOTS || "/tmp/claude-0/-home-user/56cd73f1-f7cb-5b2e-b506-7c0fd43d795e/scratchpad/flow";
fs.mkdirSync(SHOTS, { recursive: true });
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", root], { stdio: "ignore" });
const url = `http://127.0.0.1:${PORT}/source/app/index.html`;


async function run(browser, { phone = false } = {}) {
  const fails = [];
  const tag = phone ? "-phone" : "";
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" } : { viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errs = [];
  const KNOWN = /reading 'waiting'/; // the PWA code expects a service worker, which this test blocks so it can serve a patched model.js
  page.on("pageerror", (e) => !KNOWN.test(e.message) && errs.push(e.message));
  page.on("console", (m) => m.type() === "error" && !KNOWN.test(m.text()) && errs.push(m.text()));
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}${tag}.png`) });
  const check = async (label, fn) => {
    try {
      if ((await fn()) === false) fails.push(label);
    } catch (e) {
      fails.push(`${label}: ${String(e.message || e).split("\n")[0]}`);
    }
  };
  const openSide = async () => {
    if (await page.locator("#side-open").isVisible().catch(() => false)) await page.locator("#side-open").click();
  };
  const blurEditor = async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(600);
  };
  const nodeCount = () => page.locator(".flow-node").count();
  const center = (id) => page.evaluate((i) => {
    const r = document.querySelector(`.flow-node[data-node="${i}"] .flow-shape`).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  const blockMenu = async () => {
    // right-click on the empty corner of the chart: the block's own context menu (the handle is hover-only on phones)
    await page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove())); // the blocked-service-worker toast
    await page.locator(".flow-svg").first().click({ button: "right", position: { x: 2, y: 2 } });
    await page.waitForSelector(".menu");
  };
  const pick = async (label) => {
    await page.locator(".menu .menu-item", { hasText: label }).first().click();
  };

  await page.goto(url);
  await page.waitForSelector(".side-item", { state: "attached" });
  await openSide();
  await page.locator(".side-item:not(.repo)").first().click();
  await page.waitForSelector(".doc-tail");

  await check("/flowchart inserts the starter chart", async () => {
    await page.locator(".doc-tail").click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("blk-ta"));
    await page.keyboard.type("/flowchart");
    await page.locator(".menu .menu-item", { hasText: "Flowchart" }).first().click();
    await page.waitForSelector(".flow-svg");
    await blurEditor();
    return (await nodeCount()) === 5 && (await page.locator(".flow-edge").count()) === 5;
  });
  await check("starter flows downwards and the arrowheads exist", async () => {
    const a = await center("start");
    const b = await center("done");
    return b.y > a.y && (await page.locator(".flow-edge path[marker-end]").count()) === 5;
  });
  await shot("starter");

  await check("the chart survives a reload", async () => {
    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForSelector(".flow-svg");
    return (await nodeCount()) === 5;
  });

  await check("block menu: Layout > Cycle", async () => {
    await blockMenu();
    await pick("Layout");
    await pick("Cycle");
    await page.waitForTimeout(100);
    const a = await center("start");
    const c = await center("go");
    return Math.abs(a.y - c.y) > 10 || Math.abs(a.x - c.x) > 10;
  });
  await check("block menu has Rotation and Turn for a cycle (no Direction)", async () => {
    await blockMenu();
    const texts = await page.locator(".menu .menu-item").allTextContents();
    await page.keyboard.press("Escape");
    return texts.some((t) => /Rotation/.test(t)) && texts.some((t) => /Turn/.test(t)) && !texts.some((t) => /Direction/.test(t));
  });
  await check("Turn counter-clockwise mirrors the ring", async () => {
    const before = (await center("ready")).x;
    await blockMenu();
    await pick("Turn");
    await pick("Counter-clockwise");
    await page.waitForTimeout(100);
    const after = (await center("ready")).x;
    return before !== after;
  });
  await shot("cycle");
  await check("Layout > Flow, Direction > Right", async () => {
    await blockMenu();
    await pick("Layout");
    await pick("Flow (layers)");
    await blockMenu();
    await pick("Direction");
    await pick("Right");
    await page.waitForTimeout(100);
    const a = await center("start");
    const b = await center("done");
    return b.x > a.x + 50;
  });
  await shot("right");
  await check("Spacing roomy makes the chart larger", async () => {
    const w = await page.locator(".flow-svg").evaluate((s) => Number(s.getAttribute("width")));
    await blockMenu();
    await pick("Spacing");
    await pick("Roomy");
    await page.waitForTimeout(100);
    return (await page.locator(".flow-svg").evaluate((s) => Number(s.getAttribute("width")))) > w;
  });
  await check("every layout draws all nodes", async () => {
    for (const name of ["Tree", "Row", "Grid"]) {
      await blockMenu();
      await pick("Layout");
      await page.locator(".menu .menu-item", { hasText: name }).first().click();
      await page.waitForTimeout(80);
      if ((await nodeCount()) !== 5) throw new Error(`${name} drew ${await nodeCount()} nodes`);
      await shot(`layout-${name.toLowerCase()}`);
    }
    await blockMenu();
    await pick("Layout");
    await pick("Flow (layers)");
    await blockMenu();
    await pick("Direction");
    await pick("Down");
    return true;
  });

  await check("Edit flowchart: quick syntax updates the lists and the chart", async () => {
    await blockMenu();
    await pick("Edit flowchart");
    await page.waitForSelector(".flow-edit");
    const ta = page.locator(".flow-ta");
    await ta.fill("A [circle red]: Hello\nB [cylinder]: World <b>x</b>\nC [document grey]: Third\nA -> B: go\nB -.-> C\nC -> A: loop\n!!! ???");
    await page.locator(".flow-edit h4").first().click(); // blur: the change event parses the text
    await page.waitForFunction(() => document.querySelectorAll(".fe-list")[0].querySelectorAll(".fe-row").length === 3);
    const errs2 = await page.locator(".flow-errs").innerText();
    if (!/Line 7/.test(errs2)) throw new Error(`parse error not shown: ${errs2}`);
    if ((await page.locator(".fe-list").nth(1).locator(".fe-row").count()) !== 3) throw new Error("edge rows");
    await shot("editor");
    await page.locator(".modal-actions button.primary").click();
    await page.waitForSelector(".flow-edit", { state: "detached" });
    return (await nodeCount()) === 3 && (await page.locator(".flow-node text", { hasText: "<b>x</b>" }).count()) === 1 && (await page.locator(".flow-svg b").count()) === 0;
  });
  await check("Edit flowchart: node list rename, colour, reorder, delete", async () => {
    await blockMenu();
    await pick("Edit flowchart");
    await page.waitForSelector(".flow-edit");
    const row = (id) => page.locator(`.fe-row[data-id="${id}"]`);
    await row("A").locator("input[type=text]").fill("Renamed");
    await row("A").locator("input[type=text]").press("Enter");
    await row("A").locator("select").nth(1).selectOption("240");
    await row("B").locator('button[aria-label^="Move B earlier"]').click();
    const order = await page.locator(".fe-list").first().locator(".fe-id").allTextContents();
    if (order.join() !== "B,A,C") throw new Error(`order ${order}`);
    await row("C").locator('button[aria-label^="Delete node"]').click();
    if ((await page.locator(".fe-list").first().locator(".fe-row").count()) !== 2) throw new Error("delete");
    if ((await page.locator(".fe-list").nth(1).locator(".fe-row").count()) !== 1) throw new Error("dangling edges not dropped");
    await page.locator("button.fe-add", { hasText: "Add node" }).click();
    if ((await page.locator(".fe-list").first().locator(".fe-row").count()) !== 3) throw new Error("add node");
    const ta = await page.locator(".flow-ta").inputValue();
    if (!/A \[circle blue\]: Renamed/.test(ta)) throw new Error(`text not synced: ${ta.replace(/\n/g, " | ")}`);
    await page.locator(".modal-actions button.primary").click();
    await page.waitForSelector(".flow-edit", { state: "detached" });
    return (await nodeCount()) === 3 && (await page.locator(".flow-node text", { hasText: "Renamed" }).count()) === 1;
  });
  await check("Edit flowchart: Cancel changes nothing", async () => {
    await blockMenu();
    await pick("Edit flowchart");
    await page.waitForSelector(".flow-edit");
    await page.locator(".flow-ta").fill("X -> Y");
    await page.locator(".flow-edit h4").first().click();
    await page.locator(".modal-actions button", { hasText: "Cancel" }).click();
    return (await nodeCount()) === 3;
  });
  await check("node menu: click opens it, Rename works", async () => {
    await page.locator('.flow-node[data-node="A"]').click();
    await page.waitForSelector(".menu .menu-item");
    const texts = await page.locator(".menu .menu-item").allTextContents();
    if (!["Rename", "Shape", "Outline and text colour", "Fill", "Copy link to box", "Connect to", "Move earlier", "Delete node"].every((t) => texts.some((x) => x.includes(t)))) throw new Error(texts.join("|"));
    await pick("Rename");
    await page.locator('.modal input[aria-label="Node text"]').fill("Second name");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".modal", { state: "detached" });
    return (await page.locator(".flow-node text", { hasText: "Second name" }).count()) === 1;
  });
  await check("node menu by keyboard (Enter on a focused node)", async () => {
    await page.locator('.flow-node[data-node="A"]').focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".menu .menu-item");
    await page.keyboard.press("Escape");
    return true;
  });
  await check("node menu: Fill sets bg separately from the colour, and round trips", async () => {
    await page.locator('.flow-node[data-node="A"]').click();
    await page.waitForSelector(".menu .menu-item");
    await pick("Fill");
    await page.locator(".menu .menu-item", { hasText: "Yellow" }).last().click();
    await page.waitForSelector(".flow-node[data-node=\"A\"].has-bg");
    const st = await page.evaluate(() => {
      const g = document.querySelector('.flow-node[data-node="A"]');
      const sh = g.querySelector(".flow-shape");
      return { fill: getComputedStyle(sh).fill, stroke: getComputedStyle(sh).stroke, hue: g.classList.contains("has-hue") };
    });
    if (!st.hue || !/ 90\)$/.test(st.fill) || !/ 240\)$/.test(st.stroke)) throw new Error(JSON.stringify(st));
    await blockMenu();
    await pick("Edit flowchart");
    await page.waitForSelector(".flow-edit");
    const ta = await page.locator(".flow-ta").inputValue();
    const sel = await page.locator('select[aria-label="Fill of node A"]').inputValue();
    await page.locator(".modal-actions button", { hasText: "Cancel" }).click();
    return /A \[[^\]]*bg=yellow[^\]]*\]/.test(ta) && sel === "90";
  });
  await check("fill stays readable in light, neutral and dark", async () => {
    const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    for (const mode of ["light", "neutral", "dark"]) {
      await page.evaluate((m) => { document.documentElement.dataset.mode = m; }, mode);
      const cols = await page.evaluate(() => {
        const c = document.createElement("canvas").getContext("2d");
        const px = (css) => { c.clearRect(0, 0, 1, 1); c.fillStyle = "#000"; c.fillStyle = css; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
        const g = document.querySelector('.flow-node[data-node="A"]');
        return { fill: px(getComputedStyle(g.querySelector(".flow-shape")).fill), text: px(getComputedStyle(g.querySelector("text")).fill) };
      });
      const [a, b] = [lum(cols.fill), lum(cols.text)].sort((x, y) => y - x);
      if ((a + 0.05) / (b + 0.05) < 4.5) throw new Error(`${mode}: contrast ${((a + 0.05) / (b + 0.05)).toFixed(1)}`);
    }
    await page.evaluate(() => { document.documentElement.dataset.mode = "neutral"; });
    return true;
  });
  await check("Copy link to box, then the link jumps to and highlights the box", async () => {
    const id = await page.evaluate(() => location.hash.match(/^#page-([A-Za-z0-9_-]+)/)[1]);
    await page.evaluate(() => { window.__copied = ""; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
    await page.locator('.flow-node[data-node="A"]').click();
    await page.waitForSelector(".menu .menu-item");
    await pick("Copy link to box");
    const text = await page.evaluate(() => window.__copied);
    if (!text.endsWith(`(#page-${id}~A)`)) throw new Error(text);
    await page.evaluate(() => { location.hash = ""; });
    await page.waitForTimeout(300);
    await page.evaluate((h) => { location.hash = h; }, `#page-${id}~A`);
    await page.waitForSelector('.flow-node[data-node="A"].flow-hit');
    await page.waitForTimeout(900);
    await shot("box-link");
    const ok = await page.evaluate(() => { const r = document.querySelector('.flow-node[data-node="A"]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
    await page.waitForFunction(() => !document.querySelector(".flow-hit"), null, { timeout: 5000 });
    return ok;
  });
  await check("no horizontal page scroll", async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector("#main").scrollWidth <= document.querySelector("#main").clientWidth + 1));
  await check("chart fits the content width", async () => page.evaluate(() => {
    const s = document.querySelector(".flow-svg").getBoundingClientRect();
    const m = document.querySelector("#main").getBoundingClientRect();
    return s.right <= m.right + 1;
  }));
  await shot("final");
  await check("dark mode renders", async () => {
    await page.evaluate(() => { document.documentElement.dataset.mode = "dark"; });
    await shot("dark");
    await page.evaluate(() => { document.documentElement.dataset.mode = "neutral"; });
    return true;
  });
  await check("big chart on this width", async () => {
    await blockMenu();
    await pick("Edit flowchart");
    await page.waitForSelector(".flow-edit");
    const lines = Array.from({ length: 12 }, (_, i) => `s${i} [${["pill", "diamond", "rounded", "circle"][i % 4]}]: Step number ${i}`).concat(Array.from({ length: 11 }, (_, i) => `s${i} -> s${i + 1}`), ["s11 -> s0: again"]);
    await page.locator(".flow-ta").fill(lines.join("\n"));
    await page.locator(".flow-edit h4").first().click();
    await page.locator(".modal-actions button.primary").click();
    await page.waitForSelector(".flow-edit", { state: "detached" });
    await page.waitForFunction(() => document.querySelectorAll(".flow-node").length === 12);
    await shot("big");
    return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector(".flow-svg").getBoundingClientRect().right <= document.querySelector("#main").getBoundingClientRect().right + 1);
  });
  if (errs.length) fails.push(`console errors: ${errs.slice(0, 3).join(" | ")}`);
  await ctx.close();
  return fails.map((f) => `${phone ? "phone " : ""}${f}`);
}

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const fails = [];
  try {
    fails.push(...(await run(browser)));
    fails.push(...(await run(browser, { phone: true })));
  } catch (e) {
    fails.push(String(e?.stack || e));
  }
  await browser.close();
  server.kill();
  if (fails.length) {
    console.log("FAIL\n  " + fails.join("\n  "));
    process.exit(1);
  }
  console.log("ok   flowchart e2e");
})();
