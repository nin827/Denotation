// Browser test: the PIN lock reaches every open tab (js/lockSync.js). Two pages in one context share localStorage
// and the BroadcastChannel like two tabs do.
//   set a PIN in A -> B locks (and B's unsaved edit was flushed first); Lock now in B -> A locks;
//   change the PIN (to 6 digits) in A while B is locked -> B's lock screen asks for 6; remove it in A -> B opens.
// usage: node -r ./work/test/e2e/csp-watch.cjs work/test/e2e/lock-tabs.cjs   (Playwright + Chromium, dev-only; port 8097)
const { chromium } = require("playwright");
const { watchCsp } = require("./csp-watch.cjs");
const { spawn } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "../../..");
const PORT = Number(process.env.PORT) || 8097;
const APP = `http://127.0.0.1:${PORT}/source/app/index.html`;
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", root], { stdio: "ignore" });

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const errs = [];
  try {
    const ctx = await browser.newContext();
    const csp = await watchCsp(ctx, []);
    const open = async (name) => {
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errs.push(`${name}: ${e.message}`));
      page.on("console", (m) => m.type() === "error" && errs.push(`${name}: ${m.text()}`));
      await page.goto(APP);
      await page.waitForSelector(".side-item");
      return page;
    };
    const menu = async (page, re) => {
      await page.locator(".act-more").click();
      await page.locator(".menu-item", { hasText: re }).click();
    };
    const locked = (page, label, timeout = 8000) => page.waitForSelector("#lock", { timeout }).then(() => true, () => (errs.push(`${label}: did not lock`), false));
    const unlock = async (page, pin, label) => {
      await page.locator(".lock-input").waitFor();
      await page.keyboard.type(pin);
      await page.waitForSelector("#lock", { state: "detached", timeout: 10000 }).catch(() => errs.push(`${label}: PIN ${pin} did not unlock`));
    };
    const pinDialog = async (page, cls, fields, sixDigits = false) => {
      await menu(page, "Settings");
      await page.locator(cls).click();
      if (await page.locator(".pin-length").count()) await page.locator(".pin-length button", { hasText: sixDigits ? "6 digits" : "4 digits" }).click();
      for (const [sel, v] of fields) await page.fill(sel, v);
      await page.locator(".pin-go").click();
      await page.waitForFunction(() => document.querySelectorAll(".modal").length === 1, null, { timeout: 15000 }).catch(() => errs.push(`${cls}: dialog did not close`));
      await page.keyboard.press("Escape");
      await page.waitForSelector(".modal", { state: "detached" });
    };

    const a = await open("A");
    const b = await open("B");

    // B has an unsaved edit when A sets the PIN: it must be saved before B locks.
    await b.locator(".side-item", { hasText: "Welcome" }).first().click();
    await b.waitForSelector(".blk-row .rendered");
    await b.locator(".blk-row .rendered").first().click();
    await b.keyboard.press("End");
    await b.keyboard.type(" Tab-B-edit");
    await pinDialog(a, ".pin-set", [[".pin-new", "2468"], [".pin-again", "2468"]]);
    if (await locked(b, "B after the PIN was set in A")) {
      const leak = await b.evaluate(() => document.getElementById("main").childElementCount + document.querySelectorAll(".side-item").length);
      if (leak) errs.push("B: workspace still drawn behind the lock screen");
    }
    if (await a.locator("#lock").count()) errs.push("A: the tab that set the PIN locked itself");

    // A new tab opens locked; after unlocking, B's edit is there.
    const c = await ctx.newPage();
    await c.goto(APP);
    await c.waitForSelector("#lock");
    await unlock(c, "2468", "C");
    await c.locator(".side-item", { hasText: "Welcome" }).first().click();
    await c.waitForSelector(".blk-row");
    if (!(await c.evaluate(() => document.getElementById("main").innerText.includes("Tab-B-edit")))) errs.push("B's unsaved edit was lost when it locked");
    await c.close();

    // Lock now in B -> A locks.
    await unlock(b, "2468", "B");
    await b.waitForSelector(".side-item");
    await menu(b, "Lock now");
    await locked(b, "B (Lock now)");
    await locked(a, "A after Lock now in B");

    // Change the PIN in A (to 6 digits) while B stays locked: B's lock screen now asks for 6 digits.
    await unlock(a, "2468", "A");
    await a.waitForSelector(".side-item");
    if (!(await b.locator("#lock").count())) errs.push("B: unlocked when A was unlocked (unlock must stay per tab)");
    await pinDialog(a, ".pin-change", [[".pin-current", "2468"], [".pin-new", "135790"], [".pin-again", "135790"]], true);
    await b.waitForFunction(() => document.querySelector(".lock-input")?.maxLength === 6, null, { timeout: 8000 }).catch(() => errs.push("B: lock screen not redrawn for the 6-digit PIN"));
    await unlock(b, "135790", "B (new PIN)");

    // Changing the PIN while B is open locks B.
    await pinDialog(a, ".pin-change", [[".pin-current", "135790"], [".pin-new", "1111"], [".pin-again", "1111"]]);
    await locked(b, "B after the PIN changed in A");

    // Remove the PIN in A: locked B reloads and opens without asking.
    await pinDialog(a, ".pin-remove", [[".pin-current", "1111"]]);
    await b.waitForSelector(".side-item", { timeout: 10000 }).catch(() => errs.push("B: did not open after the PIN was removed in A"));
    if (await b.locator("#lock").count()) errs.push("B: still locked after the PIN was removed");
    // No PIN: Lock now is gone in B too, and the idle lock can't fire.
    await b.locator(".act-more").click();
    if (await b.locator(".menu-item", { hasText: "Lock now" }).count()) errs.push("B: Lock now still offered without a PIN");
    await b.keyboard.press("Escape");
    errs.push(...csp);
  } catch (e) {
    errs.push(e.stack || String(e));
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(`${errs.length ? "FAIL" : "ok  "} lock across tabs${errs.length ? "\n  " + errs.join("\n  ") : ""}`);
  process.exit(errs.length ? 1 : 0);
})();
