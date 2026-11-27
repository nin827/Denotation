// Browser test: Settings → Privacy → Linked images "Click to load". A linked picture (image block, inline image chip)
// shows a placeholder and nothing is fetched from its site until its Load image button is used; embedded (data:)
// pictures always show. The picture host is emulated with page.route, which also counts the requests.
// usage: node -r ./work/test/e2e/csp-watch.cjs work/test/e2e/remote-images.cjs   (Playwright + Chromium, dev-only; port 8097)
const { chromium } = require("playwright");
const { watchCsp } = require("./csp-watch.cjs");
const { spawn } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "../../..");
const PORT = Number(process.env.PORT) || 8097;
const APP = `http://127.0.0.1:${PORT}/source/app/index.html`;
const HOST = "images.example.test";
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", root], { stdio: "ignore" });
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MD = [
  "![Block picture](https://images.example.test/a.png)",
  "",
  "Text with {{img:https://images.example.test/b.png|||Inline picture}} inside.",
  "",
  `![Embedded](data:image/png;base64,${PNG_B64})`,
  ""
].join("\n");

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const errs = [];
  const hits = [];
  try {
    const ctx = await browser.newContext();
    const csp = await watchCsp(ctx, []);
    await ctx.route(`https://${HOST}/**`, (r) => {
      hits.push(new URL(r.request().url()).pathname);
      return r.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG_B64, "base64") });
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    await page.goto(APP);
    await page.waitForSelector(".side-item");
    const setMode = async (value) => {
      await page.locator(".act-more").click();
      await page.locator(".menu-item", { hasText: "Settings" }).click();
      await page.locator("#set-remote-images").selectOption(value);
      await page.keyboard.press("Escape");
      await page.waitForSelector(".modal", { state: "detached" });
    };
    await setMode("click");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("denotion:prefs") || "{}").remoteImages === "click", null, { timeout: 3000 }).catch(() => errs.push("setting not saved"));

    await page.setInputFiles(".side-footer input[type=file]", { name: "remote-pics.md", mimeType: "text/markdown", buffer: Buffer.from(MD) });
    await page.waitForSelector(".side-item:has-text('remote-pics')", { timeout: 8000 });
    await page.locator(".side-item", { hasText: "remote-pics" }).first().click();
    await page.waitForSelector(".rimg-ph", { timeout: 8000 }).catch(() => errs.push("no placeholder for linked pictures"));
    await page.waitForTimeout(400);
    const ph = await page.locator(".rimg-ph").evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
    if (ph.length !== 2) errs.push(`expected 2 placeholders, got ${ph.length}: ${JSON.stringify(ph)}`);
    if (!ph.some((t) => t.includes("Block picture") && t.includes(HOST))) errs.push(`block placeholder lacks alt text or host: ${JSON.stringify(ph)}`);
    if (!ph.some((t) => t.includes("Inline picture"))) errs.push("inline placeholder lacks alt text");
    if (hits.length) errs.push(`fetched before any click: ${hits.join(", ")}`);
    if (!(await page.locator(`img[src^="data:image/png"]`).count())) errs.push("embedded (data:) picture did not show");

    // Keyboard: focus the block's Load image button and press Enter -> only that picture loads.
    const blockBtn = page.locator(".img-box .rimg-load");
    await blockBtn.focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(`.img-box img.img[src="https://${HOST}/a.png"]`, { timeout: 5000 }).catch(() => errs.push("block picture did not load after Load image"));
    await page.waitForTimeout(300);
    if (hits.join() !== "/a.png") errs.push(`after the first click expected only /a.png, got ${hits.join(", ")}`);
    // The inline chip's button: click it.
    await page.locator(".ichip-img-wrap .rimg-load").click();
    await page.waitForSelector(`img.ichip-img[src="https://${HOST}/b.png"]`, { timeout: 5000 }).catch(() => errs.push("inline picture did not load after Load image"));
    if (await page.locator("textarea.blk-ta:focus").count()) errs.push("clicking Load image put the text block into edit mode");

    // Back to "Load automatically": no placeholders.
    await setMode("auto");
    await page.waitForFunction(() => !document.querySelector(".rimg-ph"), null, { timeout: 5000 }).catch(() => errs.push("placeholders left after Load automatically"));
    // Click to load again, then a fresh page view forgets earlier clicks.
    await setMode("click");
    await page.locator(".side-item", { hasText: "Welcome" }).first().click();
    await page.locator(".side-item", { hasText: "remote-pics" }).first().click();
    await page.waitForSelector(".rimg-ph", { timeout: 5000 }).catch(() => errs.push("a new page view did not ask again"));
    errs.push(...csp);
  } catch (e) {
    errs.push(e.stack || String(e));
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(`${errs.length ? "FAIL" : "ok  "} linked images: click to load${errs.length ? "\n  " + errs.join("\n  ") : ""}`);
  process.exit(errs.length ? 1 : 0);
})();
