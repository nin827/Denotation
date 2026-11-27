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
    // Workspace menu: Settings opens and closes
    if (await page.locator(".side-tools").count()) errs.push("old tool row is still present");
    await page.locator(".act-more").click();
    await page.locator(".menu-item", { hasText: "Settings" }).click();
    await page.waitForSelector(".modal");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".modal", { state: "detached" });
    // Storage dialog (only where the folder adapter is active): opens, lists nothing yet, closes
    await page.locator(".act-more").click();
    if (await page.locator(".menu-item", { hasText: "Storage" }).count()) {
      await page.locator(".menu-item", { hasText: "Storage" }).click();
      await page.waitForSelector(".storage-dialog");
      if (!(await page.locator(".modal-actions .loc-add").count())) errs.push("Storage dialog: no Add location button");
      await page.keyboard.press("Escape");
      await page.waitForSelector(".modal", { state: "detached" });
    } else await page.keyboard.press("Escape");
    // Feedback: write with the block editor, file it, find it in the Feedback database
    await page.locator(".act-more").click();
    await page.locator(".menu-item", { hasText: "Feedback" }).click();
    await page.locator(".feedback-kind", { hasText: "Feature request" }).click();
    await page.fill(".feedback-title", "Smoke feedback");
    await page.press(".feedback-title", "Enter");
    await page.keyboard.type("# Heading");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Details from the smoke test");
    await page.locator(".modal-actions button.primary").click();
    await page.waitForSelector(".modal", { state: "detached" });
    await page.waitForSelector(".side-item", { hasText: "Feedback" });
    await page.waitForFunction(() => [...document.querySelectorAll(".db-body input")].some((i) => i.value === "Smoke feedback"), null, { timeout: 5000 }).catch(() => errs.push("filed feedback is not shown in the Feedback database"));
    // Export as ZIP (Markdown and JSON) and re-import both
    const zips = {};
    for (const [kind, label] of [["md", "ZIP \u2014 Markdown"], ["json", "ZIP \u2014 Denotation JSON"]]) {
      await page.locator(".act-more").click();
      await page.locator(".menu-item", { hasText: /^Export/ }).click();
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
  // PIN lock: set a 4-digit PIN, reload -> lock screen with no titles, wrong PIN refused, right PIN unlocks,
  // Lock now, then "Forgot PIN?" resets the browser with the shown 8-digit number. Settings reset needs the number too.
  {
    const t = targets[0];
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    const openMenuItem = async (re) => {
      await page.locator(".act-more").click();
      await page.locator(".menu-item", { hasText: re }).click();
    };
    const noTitles = async (label) => {
      const leak = await page.evaluate(() => ({
        items: document.querySelectorAll(".side-item").length,
        main: document.getElementById("main").childElementCount,
        text: document.body.innerText.includes("Welcome") || document.body.innerText.includes("Column type demo")
      }));
      if (leak.items || leak.main || leak.text) errs.push(`${label}: workspace content visible while locked ${JSON.stringify(leak)}`);
    };
    await page.goto(`http://127.0.0.1:${PORT}${t}`);
    await page.waitForSelector(".side-item");
    await openMenuItem("Settings");
    await page.locator(".pin-set").click();
    await page.locator(".pin-length button", { hasText: "4 digits" }).click();
    await page.fill(".pin-new", "1357");
    await page.fill(".pin-again", "1357");
    await page.locator(".pin-go").click();
    await page.waitForFunction(() => document.querySelectorAll(".modal").length === 1);
    if (!/on \(4 digits\)/.test(await page.locator(".pin-state").textContent())) errs.push("lock: Settings does not show the PIN as on");
    if (!(await page.locator("#set-idle").count())) errs.push("lock: no idle auto-lock choice");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".modal", { state: "detached" });
    const stored = await page.evaluate(() => localStorage.getItem("denotion:pin"));
    if (!stored || stored.includes("1357") || JSON.parse(stored).iterations < 600000) errs.push("lock: stored PIN record is wrong");
    await page.reload();
    await page.waitForSelector("#lock");
    await page.waitForTimeout(200);
    await noTitles("after reload");
    await page.keyboard.type("0000");
    await page.waitForFunction(() => /Wrong PIN/.test(document.querySelector(".lock-msg")?.textContent || ""), null, { timeout: 8000 }).catch(() => errs.push("lock: wrong PIN was not refused"));
    if (!(await page.locator("#lock").count())) errs.push("lock: wrong PIN unlocked");
    if (!/Try again in 3 s/.test(await page.locator(".lock-msg").textContent())) errs.push("lock: wrong PIN message does not say 3 s");
    if (!(await page.locator('.lock-key[data-key="1"]').isDisabled())) errs.push("lock: keys not blocked right after a wrong PIN");
    await page.waitForFunction(() => !document.querySelector('.lock-key[data-key="1"]')?.disabled, null, { timeout: 4500 }).catch(() => errs.push("lock: still blocked after 3 s"));
    for (const d of "1357") await page.locator(`.lock-key[data-key="${d}"]`).click();
    await page.waitForSelector("#lock", { state: "detached", timeout: 8000 }).catch(() => errs.push("lock: right PIN did not unlock"));
    await page.waitForSelector(".side-item");
    // Lock now: hides the page, unlock restores it
    await page.locator(".side-item", { hasText: "Welcome" }).first().click();
    await page.waitForSelector(".blk-row");
    const welcomeId = await page.evaluate(() => location.hash.replace("#page-", ""));
    await openMenuItem("Lock now");
    await page.waitForSelector("#lock");
    await page.waitForTimeout(200);
    await noTitles("after Lock now");
    await page.keyboard.type("1357");
    await page.waitForSelector("#lock", { state: "detached", timeout: 8000 }).catch(() => errs.push("lock: unlock after Lock now failed"));
    await page.waitForSelector(".blk-row", { timeout: 5000 }).catch(() => errs.push("lock: the page was not restored after unlock"));
    // Settings reset: the button stays disabled until the shown number is typed; export is offered
    await openMenuItem("Settings");
    await page.locator(".reset-open").click();
    await page.waitForSelector(".reset-code");
    const code1 = (await page.locator(".reset-code").textContent()).trim();
    if (!/^[0-9]{8}$/.test(code1)) errs.push(`reset: code is not 8 digits (${code1})`);
    if (!(await page.locator(".reset-export").count())) errs.push("reset: no Export button when unlocked");
    if (!(await page.locator(".reset-go").isDisabled())) errs.push("reset: button enabled before typing the number");
    await page.fill(".reset-input", code1 === "12345678" ? "87654321" : "12345678");
    if (!(await page.locator(".reset-go").isDisabled())) errs.push("reset: wrong number enabled the button");
    await page.fill(".reset-input", code1);
    if (await page.locator(".reset-go").isDisabled()) errs.push("reset: right number did not enable the button");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".modal", { state: "detached" });
    await openMenuItem("Settings");
    await page.locator(".reset-open").click();
    const code2 = (await page.locator(".reset-code").textContent()).trim();
    if (code2 === code1) errs.push("reset: the number did not change between openings");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".modal", { state: "detached" });
    // Forgot PIN on the lock screen: dialog above the lock, no export, reset clears everything
    await openMenuItem("Lock now");
    await page.waitForSelector("#lock");
    await page.locator(".lock-forgot").click();
    await page.waitForSelector(".modal-overlay.over-lock .reset-code");
    if (await page.locator(".reset-export").count()) errs.push("reset: Export offered while locked");
    const code3 = (await page.locator(".reset-code").textContent()).trim();
    await page.fill(".reset-input", code3);
    await Promise.all([page.waitForNavigation(), page.locator(".reset-go").click()]);
    await page.waitForSelector(".side-item");
    if (await page.locator("#lock").count()) errs.push("reset: still locked after reset");
    const left = await page.evaluate(() => Object.keys(localStorage).filter((k) => /^deno(tion|tation)/.test(k) && !/^denotion:(pages|rows):/.test(k)));
    if (left.includes("denotion:pin") || left.includes("denotion:pin-attempts")) errs.push(`reset: PIN keys survived: ${left.join(", ")}`);
    if (await page.evaluate((id) => localStorage.getItem(`denotion:pages:${id}`), welcomeId)) errs.push("reset: old pages survived");
    const ok = errs.length === 0;
    failed ||= !ok;
    console.log(`${ok ? "ok  " : "FAIL"} PIN lock + reset${errs.length ? "\n  " + errs.join("\n  ") : ""}`);
    await ctx.close();
  }
  // Encryption: browser copy on (recovery key shown once), reload + unlock decrypts, PIN change re-wraps,
  // remove PIN refused, a passworded ZIP (WinZip AES) exports and re-imports, storage-location encryption on a
  // folder (OPFS stands in for the folder picker) and off again, browser copy off.
  {
    const t = targets[0];
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("vault", { create: true });
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    const openMenuItem = async (re) => {
      await page.locator(".act-more").click();
      await page.locator(".menu-item", { hasText: re }).click();
    };
    const closeAll = async () => {
      while (await page.locator(".modal").count()) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(50);
      }
    };
    const unlock = async (pin) => {
      await page.waitForSelector("#lock");
      await page.keyboard.type(pin);
      await page.waitForSelector("#lock", { state: "detached", timeout: 10000 }).catch(() => errs.push(`enc: PIN ${pin} did not unlock`));
    };
    const confirmPin = async (pin) => {
      await page.waitForSelector(".pin-confirm");
      await page.fill(".pin-confirm", pin);
      await page.locator(".pin-go").click();
    };
    const records = () => page.evaluate(() => Object.keys(localStorage).filter((k) => /^denotion:(pages|rows):/.test(k)).map((k) => localStorage.getItem(k)));
    await page.goto(`http://127.0.0.1:${PORT}${t}`);
    await page.waitForSelector(".side-item");
    await page.evaluate(async () => (await import("./js/lock.js")).setPin("2468", 4));
    await page.reload();
    await unlock("2468");
    await page.waitForSelector(".side-item");
    await openMenuItem("Settings");
    if (!/keep the files private/.test(await page.locator(".enc-honest").textContent())) errs.push("enc: honest text missing");
    await page.locator(".enc-browser").click();
    await confirmPin("2468");
    await page.waitForSelector(".rk-code");
    const rk = (await page.locator(".rk-code").textContent()).trim();
    if (!/^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/.test(rk)) errs.push(`enc: recovery key format ${rk}`);
    if (await page.locator(".rk-keep").isChecked()) errs.push("enc: keep recovery key is on by default");
    await page.locator(".rk-saved").click();
    await page.waitForFunction(() => /browser copy is encrypted/.test(document.querySelector(".enc-progress")?.textContent || ""), null, { timeout: 15000 }).catch(() => errs.push("enc: browser copy job did not finish"));
    await closeAll();
    let recs = await records();
    if (!recs.length || !recs.every((v) => v.includes('"denotation-enc"'))) errs.push(`enc: browser records not all encrypted (${recs.length})`);
    if (recs.some((v) => v.includes("Welcome"))) errs.push("enc: a title is in clear");
    if (!(await page.evaluate(() => localStorage.getItem("denotion:keys")))) errs.push("enc: no local key file");
    if ((await page.evaluate(() => localStorage.getItem("denotion:prefs") ?? "{}")).includes("denotation-enc")) errs.push("enc: prefs were encrypted");
    await page.reload();
    await unlock("2468");
    await page.waitForSelector(".side-item", { hasText: "Welcome" }, { timeout: 8000 }).catch(() => errs.push("enc: workspace not readable after reload + unlock"));
    // remove PIN is refused while encryption is on
    await openMenuItem("Settings");
    await page.locator(".pin-remove").click();
    await page.fill(".pin-current", "2468");
    await page.locator(".pin-go").click();
    await page.waitForFunction(() => [...document.querySelectorAll(".modal-error")].some((e) => /Turn encryption off first/.test(e.textContent)), null, { timeout: 8000 }).catch(() => errs.push("enc: removing the PIN was not refused"));
    await closeAll();
    // change PIN: re-wraps the key; the new PIN unlocks and decrypts
    await openMenuItem("Settings");
    await page.locator(".pin-change").click();
    await page.fill(".pin-current", "2468");
    await page.fill(".pin-new", "1122");
    await page.fill(".pin-again", "1122");
    await page.locator(".pin-go").click();
    await page.waitForFunction(() => document.querySelectorAll(".modal").length === 1, null, { timeout: 15000 }).catch(() => errs.push("enc: PIN change did not finish"));
    await closeAll();
    await page.reload();
    await unlock("1122");
    await page.waitForSelector(".side-item", { hasText: "Welcome" }, { timeout: 8000 }).catch(() => errs.push("enc: not readable after a PIN change"));
    // passworded ZIP export (AES entries) and import with the password
    await openMenuItem(/^Export/);
    await page.locator(".menu-item", { hasText: "ZIP with options" }).click();
    await page.locator(".zip-protect").check();
    await page.fill(".zip-pw-new", "correct horse");
    await page.fill(".zip-pw-again", "correct horse");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(".zip-export-go").click()]);
    const zbuf = fs.readFileSync(await dl.path());
    if (zbuf.readUInt16LE(8) !== 99 || (zbuf.readUInt16LE(6) & 1) !== 1) errs.push("enc: passworded ZIP entries are not AES (method 99)");
    if (zbuf.includes("Welcome")) errs.push("enc: passworded ZIP has text in clear");
    await page.setInputFiles(".side-footer input[type=file]", { name: "locked.zip", mimeType: "application/zip", buffer: zbuf });
    await page.waitForSelector(".zip-pw");
    await page.fill(".zip-pw", "wrong horse");
    await page.locator(".zip-pw-go").click();
    await page.waitForFunction(() => [...document.querySelectorAll(".modal-error")].some((e) => /Wrong password/.test(e.textContent)), null, { timeout: 8000 }).catch(() => errs.push("enc: wrong ZIP password not refused"));
    await page.fill(".zip-pw", "correct horse");
    await page.locator(".zip-pw-go").click();
    if (!(await page.locator(".toast", { hasText: /Restored \d+ pages/ }).first().textContent({ timeout: 8000 }).catch(() => ""))) errs.push("enc: passworded ZIP import: no success toast");
    // storage location (OPFS folder) encrypted, then decrypted
    if (await page.evaluate(() => typeof showDirectoryPicker === "function")) {
      await openMenuItem("Storage");
      await page.locator(".modal-actions .loc-add").click();
      await page.locator(".menu-item", { hasText: "Folder as main" }).click();
      await page.waitForSelector(".loc-row.main", { timeout: 8000 }).catch(() => errs.push("enc: OPFS folder not added"));
      await closeAll();
      await openMenuItem("Settings");
      await page.locator(".enc-files-on").click();
      await confirmPin("1122");
      await page.waitForSelector(".rk-code");
      await page.locator(".rk-saved").click();
      await page.waitForFunction(() => /locations are encrypted/.test(document.querySelector(".enc-progress")?.textContent || ""), null, { timeout: 20000 }).catch(async () => errs.push(`enc: storage encryption did not finish: ${await page.locator(".enc-progress").textContent().catch(() => "")}`));
      await closeAll();
      const opfs = () => page.evaluate(async () => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("vault");
        const read = async (d, name) => (await (await d.getFileHandle(name)).getFile()).text();
        const pages = await dir.getDirectoryHandle("pages");
        const vals = [];
        for await (const [n] of pages.entries()) vals.push(await read(pages, n));
        let keys = null;
        try { keys = await read(dir, "keys.json"); } catch { keys = null; }
        return { manifest: JSON.parse(await read(dir, "denotation.json")), vals, keys };
      });
      let o = await opfs();
      if (!o.manifest.encrypted || o.manifest.encryption || !o.keys) errs.push(`enc: folder manifest/keys wrong ${JSON.stringify(o.manifest)}`);
      if (!o.vals.length || !o.vals.every((v) => v.includes('"denotation-enc"'))) errs.push("enc: folder pages not all encrypted");
      await openMenuItem("Settings");
      await page.locator(".enc-files-off").click();
      await confirmPin("1122");
      await page.waitForFunction(() => /plain again/.test(document.querySelector(".enc-progress")?.textContent || ""), null, { timeout: 20000 }).catch(() => errs.push("enc: storage decryption did not finish"));
      await closeAll();
      o = await opfs();
      if (o.manifest.encrypted || o.keys || o.vals.some((v) => v.includes('"denotation-enc"'))) errs.push("enc: folder not fully plain after turning off");
    } else errs.push("enc: no folder picker stand-in, folder encryption not tested");
    // browser copy off: plain again, key file removed (no encryption left)
    await openMenuItem("Settings");
    await page.locator(".enc-browser").click();
    await confirmPin("1122");
    await page.waitForFunction(() => /plain again/.test(document.querySelector(".enc-progress")?.textContent || ""), null, { timeout: 15000 }).catch(() => errs.push("enc: browser copy decrypt did not finish"));
    await closeAll();
    recs = await records();
    if (recs.some((v) => v.includes('"denotation-enc"'))) errs.push("enc: browser records still encrypted");
    if (await page.evaluate(() => localStorage.getItem("denotion:keys"))) errs.push("enc: key file left after turning everything off");
    const ok = errs.length === 0;
    failed ||= !ok;
    console.log(`${ok ? "ok  " : "FAIL"} encryption (browser copy, PIN change, ZIP password, folder)${errs.length ? "\n  " + errs.join("\n  ") : ""}`);
    await ctx.close();
  }
  // Phone lock screen: keypad sized for touch, 16px input, no overflow, tapping the keys unlocks
  {
    const t = targets[0];
    const phone = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await phone.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    await page.goto(`http://127.0.0.1:${PORT}${t}`);
    await page.waitForSelector(".side-item", { state: "attached" });
    await page.evaluate(async () => (await import("./js/lock.js")).setPin("2580", 4));
    await page.reload();
    await page.waitForSelector("#lock");
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    if (w[0] > w[1]) errs.push(`phone lock: horizontal overflow ${w.join("/")}`);
    const keyBox = await page.locator(".lock-key").first().boundingBox();
    if (keyBox.width < 44 || keyBox.height < 44) errs.push(`phone lock: keys are ${keyBox.width}x${keyBox.height} (< 44)`);
    const inFont = await page.locator(".lock-input").evaluate((el) => [parseFloat(getComputedStyle(el).fontSize), el.inputMode]);
    if (inFont[0] < 16 || inFont[1] !== "numeric") errs.push(`phone lock: input is ${inFont[0]}px / inputmode ${inFont[1]}`);
    if (await page.locator(".side-item").count()) errs.push("phone lock: sidebar rendered while locked");
    for (const d of "2580") await page.locator(`.lock-key[data-key="${d}"]`).tap();
    await page.waitForSelector("#lock", { state: "detached", timeout: 8000 }).catch(() => errs.push("phone lock: tapping the PIN did not unlock"));
    await page.waitForSelector(".side-item", { state: "attached" });
    const ok = errs.length === 0;
    failed ||= !ok;
    console.log(`${ok ? "ok  " : "FAIL"} phone lock screen 360x740${errs.length ? "\n  " + errs.join("\n  ") : ""}`);
    await phone.close();
  }
  // Phone pass (390x844, touch): overlay sidebar, menus, typing, a database, dialogs above everything, no horizontal overflow
  {
    const t = targets[0];
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await phone.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    const noOverflow = async (label) => {
      const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollWidth, innerWidth]);
      if (w[0] > w[2] || w[1] > w[2]) errs.push(`horizontal overflow on ${label}: ${w.join("/")}`);
    };
    const sideOpen = async () => { if (await page.locator("#side-open").isVisible()) await page.locator("#side-open").tap(); await page.locator("#sidebar").waitFor({ state: "visible" }); };
    await page.goto(`http://127.0.0.1:${PORT}${t}`);
    await page.waitForSelector(".side-item", { state: "attached" });
    await noOverflow("home");
    await sideOpen();
    if (!(await page.locator("#side-scrim").isVisible())) errs.push("phone: sidebar is not an overlay with a scrim");
    await noOverflow("sidebar");
    // workspace menu: touch-sized rows, then a dialog must cover the page (including the sidebar button)
    await page.locator(".act-more").tap();
    const rowH = await page.locator(".menu-item").first().evaluate((el) => el.getBoundingClientRect().height);
    if (rowH < 40) errs.push(`phone: menu rows are ${rowH}px tall (< 40)`);
    await page.locator(".menu-item", { hasText: "Settings" }).tap();
    await page.waitForSelector(".modal");
    if (await page.locator("#side-scrim").isVisible()) errs.push("phone: the overlay sidebar stayed open behind a dialog");
    await noOverflow("settings dialog");
    const covered = await page.evaluate(() => {
      const b = document.getElementById("side-open").getBoundingClientRect();
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return !!top?.closest(".modal-overlay");
    });
    if (!covered) errs.push("phone: the sidebar button shows through an open dialog");
    const fs = await page.locator(".modal select, .modal input[type=text]").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize)).catch(() => 16);
    if (fs < 16) errs.push(`phone: dialog field font is ${fs}px (< 16, iOS would zoom)`);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".modal", { state: "detached" });
    // open a page and type into a block
    await sideOpen();
    await page.locator(".side-item", { hasText: "Welcome" }).first().tap();
    // ".blk-row" may still be the previous page's, so wait for the route to land (hash) and the overlay to go
    await page.waitForFunction(() => /^#page-/.test(location.hash) && document.getElementById("side-scrim").hidden).catch(() => {});
    await page.waitForSelector(".blk-row");
    if (await page.locator("#side-scrim").isVisible()) errs.push("phone: the sidebar did not close after opening a page");
    await page.locator(".doc-tail").tap();
    await page.keyboard.type("Typed on a phone");
    await page.waitForFunction(() => [...document.querySelectorAll(".blk-ta")].some((t) => t.value.includes("Typed on a phone")));
    const taFont = await page.locator(".blk-ta").last().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    if (taFont < 16) errs.push(`phone: block text is ${taFont}px (< 16, iOS would zoom)`);
    await page.keyboard.type("\n/");
    await page.waitForSelector(".menu");
    await noOverflow("slash menu");
    await page.keyboard.press("Escape");
    // the handle menu offers Move up/down (the tap alternative to dragging)
    await page.locator(".gutter").first().tap({ force: true });
    await page.waitForSelector(".menu-item");
    if (!(await page.locator(".menu-item", { hasText: "Move down" }).count())) errs.push("phone: handle menu has no Move down");
    await page.keyboard.press("Escape");
    await noOverflow("page");
    // long-press on a sidebar row opens the page menu without navigating
    await sideOpen();
    const cdp = await phone.newCDPSession(page);
    const box = await page.locator(".side-item", { hasText: "Column type" }).first().boundingBox();
    const pt = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pt] });
    await page.waitForTimeout(700);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(150);
    if (!(await page.locator(".menu-item", { hasText: "Rename" }).count())) errs.push("phone: long-press on a sidebar row did not open its menu");
    await page.keyboard.press("Escape");
    // a database: table, then a board and a calendar, all without horizontal page scroll
    await page.locator(".side-item", { hasText: "Column type" }).first().tap();
    await page.waitForSelector(".db-table");
    await noOverflow("table");
    for (const v of ["Board", "Calendar", "Sheet"]) {
      await page.locator(".add-view").tap();
      await page.locator(".menu-item", { hasText: new RegExp(`^${v}$`) }).tap();
      await page.waitForTimeout(150);
      await noOverflow(v);
    }
    const ok = errs.length === 0;
    failed ||= !ok;
    console.log(`${ok ? "ok  " : "FAIL"} phone 390x844 touch${errs.length ? "\n  " + errs.join("\n  ") : ""}`);
    await phone.close();
  }
  {
    // PWA: manifest, service worker, offline reload, install row, toast icons
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    await page.goto(`http://127.0.0.1:${PORT}/public/index.html`);
    await page.waitForSelector(".side-item");
    const man = await page.evaluate(async () => {
      const href = document.querySelector('link[rel=manifest]')?.getAttribute("href");
      const r = await fetch(href);
      return { href, ok: r.ok, json: await r.json() };
    });
    if (!man.ok || man.json.start_url !== "./" || !man.json.icons?.length) errs.push("pwa: manifest not served or invalid");
    if (/^\//.test(man.href || "/")) errs.push("pwa: manifest link is not relative");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(async () => (await caches.keys()).some((k) => k.startsWith("denotation-")) && (await (await caches.open((await caches.keys())[0])).keys()).length > 50, null, { timeout: 15000 }).catch(() => errs.push("pwa: app shell was not precached"));
    await page.reload();
    await page.waitForSelector(".side-item");
    if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) errs.push("pwa: page is not controlled by the service worker after reload");
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector(".side-item", { timeout: 8000 }).catch(() => errs.push("pwa: offline reload did not show the app"));
    await ctx.setOffline(false);
    // toasts carry an icon by kind
    for (const [kind, n] of [["error", 1], ["success", 1], ["info", 1]]) {
      await page.evaluate(async ([k]) => (await import("./js/ui/dialogs.js")).toast(`smoke ${k}`, k), [kind]);
      if ((await page.locator(`.toast.${kind} .icon-svg`).count()) !== n) errs.push(`toast: ${kind} has no icon`);
    }
    // install row: hidden without a prompt, shown (and working) once the browser offers one
    await page.locator(".act-more").click();
    await page.locator(".menu-item", { hasText: "Settings" }).click();
    await page.waitForSelector(".modal");
    if (await page.locator(".settings .install").count()) errs.push("install: row shown although the browser offered no install");
    await page.evaluate(() => {
      const e = new Event("beforeinstallprompt", { cancelable: true });
      e.prompt = async () => {};
      e.userChoice = Promise.resolve({ outcome: "dismissed" });
      window.dispatchEvent(e);
    });
    await page.waitForSelector(".settings .install .install-btn", { timeout: 3000 }).catch(() => errs.push("install: no Install button after beforeinstallprompt"));
    await page.locator(".install-btn").click().catch(() => {});
    await page.waitForSelector(".settings .install", { state: "detached", timeout: 3000 }).catch(() => errs.push("install: row still shown after the prompt was used"));
    await page.keyboard.press("Escape");
    const ok = errs.length === 0;
    failed ||= !ok;
    console.log(`${ok ? "ok  " : "FAIL"} pwa: manifest, service worker, offline, install row${errs.length ? "\n  " + errs.join("\n  ") : ""}`);
    await ctx.close();
  }
  await browser.close();
  server.kill();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); server.kill(); process.exit(1); });
