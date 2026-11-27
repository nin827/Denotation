// Function graphs in the real app (Playwright, dev-only): /Function graph block, editor (add function, colour, range, points,
// inline errors, Esc saves, Cancel restores), reload persistence, /Inline function graph chip, hostile text, phone width.
// usage: PORT=8091 node work/test/e2e/plot.cjs      (screenshots go to SHOTS, default the agent scratchpad plot/ folder)
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "../../..");
const PORT = Number(process.env.PORT) || 8091;
if (PORT === 8080) throw new Error("port 8080 is the owner's data");
const SHOTS = process.env.SHOTS || "/tmp/claude-0/-home-user/56cd73f1-f7cb-5b2e-b506-7c0fd43d795e/scratchpad/plot";
fs.mkdirSync(SHOTS, { recursive: true });
const app = (f) => path.join(root, "source/app", f);

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", root], { stdio: "ignore" });
const url = `http://127.0.0.1:${PORT}/source/app/index.html`;

async function run(browser, { phone = false } = {}) {
  const fails = [];
  const tag = phone ? "-phone" : "";
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" } : { viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errs = [];
  const KNOWN = /$^/;
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
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const dismissToasts = () => page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
  const lineCount = () => page.locator(".plot .plot-line").count();
  const legendText = () => page.locator(".plot .plot-legend").first().innerText();
  const rowInput = (i) => page.locator('.pe-list[aria-label="Functions"] input').nth(i);

  await page.goto(url);
  await page.waitForSelector(".side-item", { state: "attached" });
  await openSide();
  await page.locator(".side-item:not(.repo)").first().click();
  await page.waitForSelector(".doc-tail");

  await check("/Function graph inserts the starter graph with a y = list", async () => {
    await page.locator(".doc-tail").click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("blk-ta"));
    await page.keyboard.type("/function graph");
    await page.locator(".menu .menu-item", { hasText: /^\s*Function graph/ }).first().click();
    await page.waitForSelector(".plot .plot-svg");
    await blurEditor();
    const t = await legendText();
    return (await lineCount()) === 2 && /y = sin\(x\)/.test(t) && /y = x\/4/.test(t) && (await page.locator(".plot-ticks text").count()) > 4;
  });
  await check("editor: add function, live preview, inline errors with icon and text", async () => {
    await page.locator(".plot-hit").first().click();
    await page.waitForSelector(".plot-edit");
    await page.locator("button.pe-add", { hasText: "Add function" }).click();
    await rowInput(2).fill("nosuch(x)");
    await page.waitForSelector(".pe-row .pe-err svg");
    const err = await page.locator(".pe-row .pe-err").nth(2).innerText();
    if (!/NAME/.test(err)) throw new Error(`error text: ${err}`);
    await rowInput(2).fill("tan(x)");
    await page.waitForFunction(() => document.querySelectorAll(".pe-preview .plot-line").length === 3);
    await rowInput(1).fill("x^3 / 20");
    await page.locator('select[aria-label="Colour of function 2"]').selectOption("90");
    await page.locator('input[aria-label="y min"]').fill("-4");
    await page.locator('input[aria-label="y max"]').fill("4");
    await page.locator("button.pe-add", { hasText: "Add point" }).click();
    await page.locator('input[aria-label="Point 1 x"]').fill("1.5");
    await page.locator('input[aria-label="Point 1 y"]').fill("1");
    await page.locator('input[aria-label="Point 1 label"]').fill("<b>peak</b>");
    await page.waitForFunction(() => document.querySelectorAll(".pe-preview .plot-point").length === 1);
    await shot("editor");
    if (!(await noHScroll())) throw new Error("horizontal scroll with the editor open");
    const box = await page.locator(".modal, .aed").boundingBox();
    const vw = await page.evaluate(() => window.innerWidth);
    return box.x >= -1 && box.x + box.width <= vw + 1;
  });
  if (!phone) await check("desktop: the editor is a popover beside the graph, not centred", async () => {
    const ed = await page.locator(".aed").boundingBox();
    const hit = await page.locator(".plot-hit").first().boundingBox();
    const near = Math.abs(ed.y - (hit.y + hit.height)) < 20 || Math.abs(ed.y + ed.height - hit.y) < 20 || (ed.y < hit.y + hit.height && ed.y + ed.height > hit.y);
    const role = await page.locator(".aed").getAttribute("role");
    const label = await page.locator(".aed").evaluate((el) => el.getAttribute("aria-label") || document.getElementById(el.getAttribute("aria-labelledby"))?.textContent);
    await shot("popover");
    return near && Math.abs(ed.x - hit.x) < 400 && role === "dialog" && !!label && (await page.locator(".modal-overlay").count()) === 0;
  });
  if (phone) await check("phone: the editor is a bottom sheet", async () => {
    const r = await page.locator(".modal").boundingBox();
    return r.y + r.height >= 840 && r.width >= 389 && (await page.locator(".aed").count()) === 0;
  });
  await check("a bad range shows an inline error and keeps the last good graph", async () => {
    await page.locator('input[aria-label="x min"]').fill("5");
    await page.locator('input[aria-label="x max"]').fill("1");
    await page.waitForSelector(".pe-range ~ .pe-err svg");
    const t = await page.locator(".pe-range ~ .pe-err").innerText();
    await page.locator('input[aria-label="x min"]').fill("-6.28");
    await page.locator('input[aria-label="x max"]').fill("6.28");
    await page.waitForFunction(() => !document.querySelector(".pe-range ~ .pe-err svg"));
    return /x range/.test(t);
  });
  await check("Esc saves: three lines, a point, no HTML from the label", async () => {
    await page.keyboard.press("Escape");
    await page.waitForSelector(".plot-edit", { state: "detached" });
    const t = await legendText();
    const pts = await page.locator(".plot .plot-point").count();
    const label = await page.locator(".plot .plot-point text").first().textContent();
    const bold = await page.locator(".plot b, .plot-svg b").count();
    await shot("block");
    return (await lineCount()) === 3 && /tan\(x\)/.test(t) && /x\^3 \/ 20/.test(t) && pts === 1 && label === "<b>peak</b>" && bold === 0 && (await noHScroll());
  });
  await check("tan(x) is drawn in pieces (path breaks at the asymptotes)", async () => {
    const runs = await page.evaluate(() => [...document.querySelectorAll(".plot .plot-line")].map((p) => (p.getAttribute("d").match(/M/g) || []).length));
    return runs[2] >= 4 && !(await page.evaluate(() => [...document.querySelectorAll(".plot .plot-line")].some((p) => /NaN|Infinity/.test(p.getAttribute("d")))));
  });
  await check("Cancel restores the graph", async () => {
    await page.locator(".plot-hit").first().focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".plot-edit");
    await rowInput(0).fill("cos(x)");
    await page.locator("button.pe-add", { hasText: "Add function" }).click();
    await page.locator(".modal-actions button", { hasText: "Cancel" }).click();
    await page.waitForSelector(".plot-edit", { state: "detached" });
    const t = await legendText();
    return /y = sin\(x\)/.test(t) && !/cos/.test(t) && (await lineCount()) === 3;
  });
  await check("Outside click saves too", async () => {
    await page.locator(".plot-hit").first().click();
    await page.waitForSelector(".plot-edit");
    await rowInput(0).fill("sin(2x)");
    await page.mouse.click(2, 2);
    await page.waitForSelector(".plot-edit", { state: "detached" });
    return /sin\(2x\)/.test(await legendText());
  });
  await check("block menu: hide grid and automatic y range", async () => {
    await dismissToasts();
    await page.locator(".plot-svg").first().click({ button: "right", position: { x: 2, y: 2 } });
    await page.waitForSelector(".menu");
    await page.locator(".menu .menu-item", { hasText: "Hide grid" }).click();
    await page.waitForFunction(() => !document.querySelector(".plot .plot-grid"));
    await page.locator(".plot-svg").first().click({ button: "right", position: { x: 2, y: 2 } });
    await page.waitForSelector(".menu");
    await page.locator(".menu .menu-item", { hasText: "Automatic y range" }).click();
    await page.waitForTimeout(150);
    await page.locator(".plot-svg").first().click({ button: "right", position: { x: 2, y: 2 } });
    await page.waitForSelector(".menu");
    return (await page.locator(".menu .menu-item", { hasText: "Automatic y range" }).count()) === 0 && (await page.keyboard.press("Escape"), true);
  });
  await check("the graph survives a reload", async () => {
    await blurEditor();
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForSelector(".side-item", { state: "attached" });
    await openSide();
    await page.locator(".side-item:not(.repo)").first().click();
    await page.waitForSelector(".plot .plot-svg");
    return (await lineCount()) === 3 && /sin\(2x\)/.test(await legendText()) && (await page.locator(".plot .plot-grid").count()) === 0;
  });
  await check("dark mode keeps the lines readable (screenshot)", async () => {
    await page.evaluate(() => { document.documentElement.dataset.mode = "dark"; });
    await page.locator(".plot-hit").first().scrollIntoViewIfNeeded();
    await shot("dark");
    const stroke = await page.evaluate(() => getComputedStyle(document.querySelector(".plot .plot-line")).stroke);
    await page.evaluate(() => { document.documentElement.dataset.mode = "neutral"; });
    return /^oklch|^rgb|^color/.test(stroke);
  });

  await check("/Inline function graph: editor opens, Done inserts a chip with a text alternative", async () => {
    await page.locator(".doc-tail").click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("blk-ta"));
    await page.keyboard.type("Wave /inline function graph");
    await page.locator(".menu .menu-item", { hasText: "Inline function graph" }).first().click();
    await page.waitForSelector(".plot-edit");
    await page.locator(".modal-actions button.primary").click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("blk-ta"));
    await blurEditor();
    await page.waitForSelector(".ichip-plot");
    const c = page.locator(".ichip-plot").first();
    const title = await c.getAttribute("title");
    const aria = await c.getAttribute("aria-label");
    await shot("inline");
    return title === "y = sin(x)" && /Function graph: y = sin\(x\)/.test(aria) && (await c.locator("svg .plot-line").count()) === 1 && (await noHScroll());
  });
  await check("chip: click opens the editor, Esc saves the change into the text", async () => {
    await page.locator(".ichip-plot").first().click();
    await page.waitForSelector(".plot-edit");
    await rowInput(0).fill("cos(x)^2");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".plot-edit", { state: "detached" });
    await page.waitForFunction(() => document.querySelector(".ichip-plot")?.title === "y = cos(x)^2");
    await page.locator(".ichip-plot").first().focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".plot-edit");
    await page.locator(".modal-actions button", { hasText: "Cancel" }).click();
    return (await page.locator(".ichip-plot").first().getAttribute("title")) === "y = cos(x)^2";
  });
  await check("chip survives a reload and hostile text stays text", async () => {
    await blurEditor();
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForSelector(".side-item", { state: "attached" });
    await openSide();
    await page.locator(".side-item:not(.repo)").first().click();
    await page.waitForSelector(".ichip-plot");
    // an expression that is HTML shows as an error, never as markup
    await page.locator(".ichip-plot").first().click();
    await page.waitForSelector(".plot-edit");
    await rowInput(0).fill('<img src=x onerror="window.__plotXss=1">');
    await page.waitForSelector(".pe-row .pe-err svg");
    const imgs = await page.locator(".plot-edit img, .plot-svg img").count();
    await page.keyboard.press("Escape");
    await page.waitForSelector(".plot-edit", { state: "detached" });
    await page.waitForTimeout(300);
    return imgs === 0 && !(await page.evaluate(() => window.__plotXss)) && (await page.locator(".blocks img").count()) === 0;
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
  console.log("ok   plot e2e");
})();
