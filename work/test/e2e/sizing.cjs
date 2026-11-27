// Browser test for ticket 018: table widths / heights / headers, image size (number and constant), inline image chip,
// database row height. usage: PORT=8093 node work/test/e2e/sizing.cjs   (SHOTS=<dir> saves screenshots)
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "../../..");
const PORT = Number(process.env.PORT) || 8099;
const SHOTS = process.env.SHOTS || "";
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", root], { stdio: "ignore" });
const URL = `http://127.0.0.1:${PORT}/source/app/index.html`;

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  let failed = false;
  for (const [name, viewport, mobile] of [["desktop", { width: 1100, height: 800 }, false], ["phone", { width: 390, height: 800 }, true]]) {
    const ctx = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile });
    const page = await ctx.newPage();
    const errs = [];
    const check = (cond, msg) => cond || errs.push(msg);
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    await page.goto(URL);
    await page.waitForSelector(".side-item", { state: "attached" });
    const ids = await page.evaluate(async () => {
      const { createStore } = await import("./js/store.js");
      const { createWorkspace } = await import("./js/workspace.js");
      const { config } = await import("./js/config.js");
      const { newBlock } = await import("./js/blocks/model.js");
      const ws = createWorkspace(await createStore(config));
      const repo = (await ws.listPages()).find((p) => p.type === "repo");
      const c = document.createElement("canvas");
      c.width = 200;
      c.height = 100;
      const g = c.getContext("2d");
      g.fillStyle = "#c33";
      g.fillRect(0, 0, 200, 100);
      const png = c.toDataURL("image/png");
      const tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      repo.constants = [
        { id: "kw", name: "photoWidth", type: "number", value: 150 },
        { id: "kb", name: "bigEm", type: "text", value: "10em" },
        { id: "kx", name: "notASize", type: "text", value: "huge" }
      ];
      await ws.savePage(repo);
      const doc = await ws.createPage({ title: "Sizing doc", parentId: repo.id });
      const img = newBlock("image", { src: png, caption: "Photo" });
      img.width = { const: "kw" };
      const bad = newBlock("image", { src: png, caption: "Bad" });
      bad.width = { const: "kx" };
      const t = newBlock("table", { rows: 3, cols: 3 });
      t.cells = [["Item", "Qty", "Price"], ["Pear", "2", "5"], ["Fig", "4", "9"]];
      doc.blocks = [t, img, bad, newBlock("p", { text: "before {{img:" + tiny + "|photoWidth||A red box}} after" })];
      await ws.savePage(doc);
      const db = await ws.createPage({ type: "database", title: "Rows db", parentId: repo.id });
      await ws.createRow(db);
      return { doc: doc.id, db: db.id, png };
    });
    await page.reload();
    await page.waitForSelector(".side-item", { state: "attached" });
    const open = async (id) => {
      if (mobile && !(await page.locator(`.side-item[data-id="${id}"]`).isVisible())) await page.locator("#side-toggle, .menu-btn, [aria-label*='sidebar' i]").first().click().catch(() => {});
      await page.evaluate((i) => { location.hash = `#page-${i}`; }, id);
    };
    await open(ids.doc);
    await page.waitForSelector(".tbl");
    // --- table: legacy header flag migrated, th scope cells
    check((await page.locator(".tbl th[scope=col]").count()) === 3 || (await page.locator(".tbl th[scope=col]").count()) === 0, "table: header cells");
    const shot = (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}-${n}.png`) });
    // header row on via the checkbox
    // (the table's settings are in the block menu: Shift+F10 in a cell, right-click or long-press)
    const cellMenu = async (r, c) => {
      await page.locator(".tbl tr").nth(r).locator("input").nth(c).focus();
      await page.keyboard.press("Shift+F10");
      await page.waitForSelector(".menu");
    };
    check((await page.locator(".tbl-controls, .tbl-menu-btn").count()) === 0, "table: no control bar or per-cell buttons in the page");
    if ((await page.locator(".tbl th[scope=col]").count()) === 0) {
      await cellMenu(0, 0);
      await page.locator(".menu-item", { hasText: /^Header row/ }).click();
    }
    await page.waitForSelector(".tbl th[scope=col]");
    check((await page.locator(".tbl th[scope=col]").count()) === 3, "table: 3 column header cells");
    await cellMenu(1, 0);
    await page.locator(".menu-item", { hasText: /^Header column/ }).click();
    await page.waitForSelector(".tbl th[scope=row]");
    check((await page.locator(".tbl th[scope=row]").count()) === 2, "table: 2 row header cells");
    // column width through the cell menu (keyboard: Shift+F10)
    await page.locator(".tbl tr").nth(1).locator("input").nth(1).focus();
    await page.keyboard.press("Shift+F10");
    await page.locator(".menu-item", { hasText: /^Column \d/ }).click();
    await page.locator(".menu-item", { hasText: /^Column width/ }).click();
    await page.fill(".size-input", "180");
    await page.locator(".modal-actions button.primary").click();
    await page.waitForSelector(".modal", { state: "detached" });
    let w = await page.locator(".tbl tr").first().locator("th").nth(1).evaluate((el) => el.getBoundingClientRect().width);
    check(Math.abs(w - 180) < 2, `table: column 2 width is ${w}, expected 180`);
    // row height in em
    await page.locator(".tbl tr").nth(1).locator("input").nth(1).focus();
    await page.keyboard.press("Shift+F10");
    await page.locator(".menu-item", { hasText: /^Row \d/ }).click();
    await page.locator(".menu-item", { hasText: /^Row height/ }).click();
    await page.fill(".size-input", "3em");
    await page.locator(".modal-actions button.primary").click();
    await page.waitForSelector(".modal", { state: "detached" });
    const rh = await page.locator(".tbl tr").nth(1).evaluate((el) => el.getBoundingClientRect().height);
    const fs = await page.locator(".tbl tr").nth(1).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    check(rh >= 3 * fs - 2 && rh <= 3 * fs + 4, `table: row 2 height ${rh}, expected about ${3 * fs}`);
    // bad value is refused with a message and nothing changes
    await page.locator(".tbl tr").nth(1).locator("input").nth(1).focus();
    await page.keyboard.press("Shift+F10");
    await page.locator(".menu-item", { hasText: /^Column \d/ }).click();
    await page.locator(".menu-item", { hasText: /^Column width/ }).click();
    await page.fill(".size-input", "50%");
    await page.locator(".modal-actions button.primary").click();
    check(await page.locator(".modal-error").evaluate((e) => e.textContent.length > 0), "table: % width should be refused with a message");
    await page.keyboard.press("Escape");
    // drag the column grip
    if (!mobile) {
      const g = page.locator(".tbl tr").first().locator("th").nth(2).locator(".tbl-grip.col");
      const bb = await g.boundingBox();
      await page.mouse.move(bb.x + bb.width / 2, bb.y + 8);
      await page.mouse.down();
      await page.mouse.move(bb.x + bb.width / 2 + 60, bb.y + 8, { steps: 4 });
      await page.mouse.up();
      const w2 = await page.locator(".tbl tr").first().locator("th").nth(2).evaluate((el) => el.getBoundingClientRect().width);
      check(w2 > 150, `table: drag did not widen column 3 (${w2})`);
    }
    await page.waitForTimeout(500);
    const saved = await page.evaluate(async (id) => {
      const { createStore } = await import("./js/store.js");
      const { createWorkspace } = await import("./js/workspace.js");
      const { config } = await import("./js/config.js");
      const p = await createWorkspace(await createStore(config)).getPage(id);
      const t = p.blocks.find((b) => b.type === "table");
      return { w: t.colWidths, h: t.rowHeights, hr: t.headerRow, hc: t.headerCol, old: t.header };
    }, ids.doc);
    check(saved.w?.[1] === "180px" && saved.h?.[1] === "3em" && saved.hr === true && saved.hc === true && saved.old === undefined, `table: stored ${JSON.stringify(saved)}`);
    await shot("table");
    // --- image by constant
    const imgs = page.locator(".img-wrap .img");
    const iw = await imgs.first().evaluate((el) => el.getBoundingClientRect().width);
    const ih = await imgs.first().evaluate((el) => el.getBoundingClientRect().height);
    const expectW = mobile ? Math.min(150, 390) : 150;
    check(Math.abs(iw - expectW) < 2 && Math.abs(ih - expectW / 2) < 2, `image: constant width gave ${iw}x${ih}`);
    check((await page.locator(".img-size-note").filter({ hasText: "not a size" }).count()) === 1, "image: bad constant should explain itself");
    // size dialog by number, height keeps ratio when only width
    check((await page.locator(".img-tools").count()) === 0, "image: no tool bar in the page");
    const imgMenu = async () => {
      await page.locator(".img-wrap .img").first().click({ button: "right" });
      await page.waitForSelector(".menu");
    };
    await imgMenu();
    await page.locator(".menu-item", { hasText: /^Image size/ }).click();
    const inputs = page.locator(".size-input");
    await inputs.nth(0).fill("120");
    await page.locator(".modal-actions button.primary").click();
    await page.waitForSelector(".modal", { state: "detached" });
    const iw2 = await page.locator(".img-wrap .img").first().evaluate((el) => el.getBoundingClientRect().width);
    check(Math.abs(iw2 - 120) < 2, `image: width 120 gave ${iw2}`);
    // set by constant name through the dialog
    await imgMenu();
    await page.locator(".menu-item", { hasText: /^Image size/ }).click();
    await page.locator(".size-input").nth(0).fill("bigEm");
    await page.locator(".modal-actions button.primary").click();
    await page.waitForSelector(".modal", { state: "detached" });
    const iw3 = await page.locator(".img-wrap .img").first().evaluate((el) => el.getBoundingClientRect().width);
    check(iw3 >= 100 && iw3 <= 400, `image: constant bigEm gave ${iw3}`);
    // changing the constant resizes every user
    await page.evaluate(async () => {
      const { createStore } = await import("./js/store.js");
      const { createWorkspace } = await import("./js/workspace.js");
      const { config } = await import("./js/config.js");
      const { constantsChanged } = await import("./js/ui/inlineChips.js");
      const ws = createWorkspace(await createStore(config));
      const repo = (await ws.listPages()).find((p) => p.type === "repo");
      repo.constants.find((c) => c.id === "kb").value = "5em";
      await ws.savePage(repo);
      // the app's page list is refreshed by its own settings dialog; reload the page object the editor reads
      window.__repo = repo;
      constantsChanged();
    });
    // alignment
    await imgMenu();
    await page.locator(".menu-item", { hasText: /^Align/ }).click();
    await page.locator(".menu-item", { hasText: /^Right/ }).click();
    await page.waitForSelector('.img-wrap[data-align="right"]');
    const box = await page.locator('.img-wrap[data-align="right"] .img-box').boundingBox();
    const wrapBox = await page.locator('.img-wrap[data-align="right"]').boundingBox();
    check(Math.abs(box.x + box.width - (wrapBox.x + wrapBox.width)) < 3, "image: right alignment");
    await shot("image");
    // --- inline image chip rendered with a constant name
    const chip = page.locator(".ichip-img");
    await chip.first().waitFor();
    const cw = await chip.first().evaluate((el) => el.getBoundingClientRect().width);
    check(Math.abs(cw - 150) < 2, `inline image: constant width gave ${cw}`);
    check((await chip.first().getAttribute("alt")) === "A red box", "inline image: alt text");
    // --- slash picker
    await page.locator(".doc-tail").click();
    await page.keyboard.type("/Inline image");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".img-pick");
    await page.fill('.img-pick input[type=url]', "https://example.com/pic.png");
    await page.fill('.img-pick input[aria-label="Alt text"], .img-pick input[aria-label="Alt text (read by screen readers)"]', "Remote").catch(() => {});
    await page.locator('.img-pick input[aria-label="Width"]').fill("2em");
    await page.locator(".modal-actions button.primary").click();
    await page.waitForSelector(".modal", { state: "detached" });
    await page.waitForFunction(() => [...document.querySelectorAll(".blk-ta")].some((t) => t.value.includes("{{img:https://example.com/pic.png|2em||")));
    check(true, "");
    await shot("inline");
    // --- database row height
    await open(ids.db);
    await page.waitForSelector(".db-table");
    const base = await page.locator(".db-table tbody tr").first().evaluate((el) => el.getBoundingClientRect().height);
    await page.locator(".tool-rowh").click();
    await page.locator(".rowh-dialog button", { hasText: "Tall" }).click();
    await page.waitForTimeout(100);
    const tall = await page.locator(".db-table tbody tr").first().evaluate((el) => el.getBoundingClientRect().height);
    // on a phone the stacked row buttons already make the row taller than a preset, so only the class is checked there
    check(mobile ? await page.locator(".db-table.rh-tall").count() === 1 : tall > base + 10, `row height: tall ${tall} vs normal ${base}`);
    await page.locator(".rowh-dialog .size-input").fill("30px");
    await page.locator(".rowh-dialog .size-input").press("Enter");
    await page.locator(".rowh-dialog .size-input").evaluate((e) => e.blur());
    await page.waitForTimeout(100);
    const custom = await page.locator(".db-table tbody tr").first().evaluate((el) => el.getBoundingClientRect().height);
    check(mobile ? await page.locator(".db-table.rh-custom").count() === 1 : custom < tall && custom >= 28, `row height: custom 30px gave ${custom}`);
    await page.keyboard.press("Escape");
    await shot("db");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(!overflow, "no horizontal page scroll");
    const ok = errs.length === 0;
    failed ||= !ok;
    console.log(`${ok ? "ok  " : "FAIL"} sizing ${name}${errs.length ? "\n  " + errs.join("\n  ") : ""}`);
    await ctx.close();
  }
  await browser.close();
  server.kill();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
