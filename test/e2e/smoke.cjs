// Minimal browser smoke test: loads public/ (ES modules),
// clicks through the sidebar and quick find, and fails on any page/console error.
// usage: node test/e2e/smoke.cjs   (needs Playwright + Chromium, dev-only)
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const PORT = 8099;
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", root], { stdio: "ignore" });

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const targets = ["/public/index.html"];
  
  const browser = await chromium.launch();
  let failed = false;
  for (const t of targets) {
    const page = await (await browser.newContext()).newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    await page.goto(`http://127.0.0.1:${PORT}${t}`);
    await page.waitForSelector(".side-item");
    const n = await page.locator(".side-item").count();
    for (let i = 0; i < n; i++) { await page.locator(".side-item").nth(i).click(); await page.waitForTimeout(100); }
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".qf-input");
    await page.keyboard.press("Escape");
    const ok = errs.length === 0 && n > 0;
    failed ||= !ok;
    console.log(`${ok ? "ok  " : "FAIL"} ${t} (${n} sidebar items)${errs.length ? "\n  " + errs.join("\n  ") : ""}`);
  }
  await browser.close();
  server.kill();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); server.kill(); process.exit(1); });
