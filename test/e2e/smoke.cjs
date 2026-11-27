// Minimal browser smoke test: loads public/ (ES modules),
// clicks through the sidebar and quick find, and fails on any page/console error.
// usage: node test/e2e/smoke.cjs   (needs Playwright + Chromium, dev-only)
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const PORT = Number(process.env.PORT) || 8099;
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
    // Export as ZIP (Markdown and JSON) and re-import both
    const zips = {};
    for (const [kind, label] of [["md", "ZIP \u2014 Markdown"], ["json", "ZIP \u2014 Denotation JSON"]]) {
      await page.locator(".side-footer button", { hasText: "Export" }).click();
      const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(".menu-item", { hasText: label }).click()]);
      zips[kind] = await dl.path();
      if (fs.readFileSync(zips[kind]).subarray(0, 2).toString() !== "PK") errs.push(`${kind} export is not a ZIP`);
    }
    const toastText = async (re) => (await page.locator(".toast", { hasText: re }).first().textContent({ timeout: 5000 }).catch(() => "")) || "";
    await page.setInputFiles(".side-footer input[type=file]", { name: "backup.zip", mimeType: "application/zip", buffer: fs.readFileSync(zips.json) });
    if (!(await toastText(/Restored \d+ pages/))) errs.push("JSON ZIP import: no success toast");
    const before = await page.locator(".side-item").count();
    await page.setInputFiles(".side-footer input[type=file]", { name: "notes-md.zip", mimeType: "application/zip", buffer: fs.readFileSync(zips.md) });
    if (!(await toastText(/Imported \d+ page/))) errs.push("Markdown ZIP import: no success toast");
    await page.waitForTimeout(300);
    if (!(await page.locator(".side-item", { hasText: "notes-md" }).count())) errs.push("Markdown ZIP import: no new repository");
    if ((await page.locator(".side-item").count()) <= before) errs.push("Markdown ZIP import: sidebar did not grow");
    const ok = errs.length === 0 && n > 0;
    failed ||= !ok;
    console.log(`${ok ? "ok  " : "FAIL"} ${t} (${n} sidebar items)${errs.length ? "\n  " + errs.join("\n  ") : ""}`);
  }
  await browser.close();
  server.kill();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); server.kill(); process.exit(1); });
