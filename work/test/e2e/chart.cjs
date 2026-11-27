// Inline charts and the chart block in the real app (Playwright, dev-only): insert with the slash menu, edit in the dedicated
// editor (Esc saves, Cancel restores, inline errors), a database-fed chip that follows a cell edit, the block menu, reload
// persistence, hostile labels, and the phone width (390px, no horizontal scroll, editor as a sheet).
// usage: PORT=8092 node work/test/e2e/chart.cjs      (screenshots go to SHOTS, default the agent scratchpad chart/ folder)
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "../../..");
const PORT = Number(process.env.PORT) || 8092;
if (PORT === 8080) throw new Error("port 8080 is the owner's data");
const SHOTS = process.env.SHOTS || "/tmp/claude-0/-home-user/56cd73f1-f7cb-5b2e-b506-7c0fd43d795e/scratchpad/chart";
fs.mkdirSync(SHOTS, { recursive: true });
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", root], { stdio: "ignore" });
const url = `http://127.0.0.1:${PORT}/source/app/index.html`;
const EVIL = "<img src=x onerror=\"window.__chartXss=1\">";

async function run(browser, { phone = false } = {}) {
  const fails = [];
  const tag = phone ? "-phone" : "";
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" } : { viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errs = [];
  const KNOWN = /reading 'waiting'/; // the PWA code expects a service worker, which this test blocks
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
  const noXScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);
  const dismissToasts = () => page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
  const chipLabel = (i = 0) => page.locator(".ichip-chart").nth(i).getAttribute("aria-label");
  const slash = async (text, label) => {
    await page.keyboard.type(text);
    await page.locator(".menu .menu-item", { hasText: label }).first().click();
  };
  const ownToken = () => page.evaluate(() => Object.values(localStorage).map((v) => v.match(/\{\{chart:[^]*?\}\}\}/)?.[0]).find(Boolean) ?? "");

  await page.goto(url);
  await page.waitForSelector(".side-item", { state: "attached" });
  await openSide();
  await page.locator(".side-item:not(.repo)").first().click();
  await page.waitForSelector(".doc-tail");

  // ---------- inline: insert ----------
  await check("/Inline chart opens the editor with a preview of the sample", async () => {
    await page.locator(".doc-tail").click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("blk-ta"));
    await slash("/inline chart", "Inline chart");
    await page.waitForSelector(".chart-ed");
    await page.waitForSelector(".chart-ed-preview .ichip-chart svg.chart-spark");
    await shot("editor-new");
    return (await noXScroll()) && (await page.locator(".chart-ed .chart-radio").count()) >= 7;
  });
  await check("Insert adds a sparkline chip with a data summary as its text alternative", async () => {
    await page.locator(".modal-actions button.primary").click();
    await blurEditor();
    await page.waitForSelector(".ichip-chart svg.chart-spark");
    return /^Sparkline of 7 values, min 3, max 12, last 12$/.test(await chipLabel());
  });
  await check("the chip's token is saved and survives a reload", async () => {
    const t = await ownToken();
    await page.reload();
    await page.waitForSelector(".ichip-chart svg.chart-spark");
    return t.startsWith("{{chart:") && (await page.locator(".ichip-chart").count()) === 1;
  });
  await dismissToasts();

  // ---------- inline: edit ----------
  const openChip = async () => {
    await dismissToasts();
    await page.locator(".ichip-chart").first().click();
    await page.waitForSelector(".chart-ed");
  };
  await check("click on the chip opens the editor; Esc saves a change (bar chart, new numbers)", async () => {
    await openChip();
    await page.locator(".chart-radio", { hasText: "Mini bar" }).click();
    await page.locator(".chart-ed textarea").fill("5 10 15 20");
    await page.waitForSelector(".chart-ed-preview svg.chart-bar");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".chart-ed", { state: "detached" });
    await page.waitForSelector(".ichip-chart svg.chart-bar");
    return /^Bar chart of 4 values, min 5, max 20, last 20$/.test(await chipLabel());
  });
  await check("Cancel restores the chip", async () => {
    await page.waitForTimeout(800);
    const before = await ownToken();
    await openChip();
    await page.locator(".chart-radio", { hasText: "Pie" }).click();
    await page.locator(".chart-hue").nth(3).click();
    await page.locator(".modal-actions button", { hasText: "Cancel" }).click();
    await page.waitForTimeout(500);
    return (await page.locator(".ichip-chart svg.chart-bar").count()) === 1 && (await ownToken()) === before;
  });
  await check("keyboard: Enter on the focused chip opens the editor", async () => {
    await page.locator("button.ichip-chart").first().focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".chart-ed");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".chart-ed", { state: "detached" });
  });
  await check("errors show inline with an icon and text, and the preview says what is missing", async () => {
    await openChip();
    await page.locator(".chart-radio", { hasText: "Database" }).click();
    await page.waitForSelector(".chart-ed-err");
    const err = page.locator(".chart-ed-err").first();
    const ok = (await err.locator(".icon-svg").count()) === 1 && /Pick a database/.test(await err.textContent());
    await page.locator(".chart-radio", { hasText: "Numbers" }).click();
    await page.locator(".chart-ed textarea").fill("abc 1 x");
    await page.waitForFunction(() => /Ignored \(not numbers\): abc, x/.test(document.querySelector(".chart-ed-errors")?.textContent ?? ""));
    await shot("editor-error");
    await page.locator(".modal-actions button", { hasText: "Cancel" }).click();
    return ok;
  });
  await check("Progress chip: maximum field, percentage text", async () => {
    await openChip();
    await page.locator(".chart-radio", { hasText: "Progress" }).click();
    await page.locator(".chart-ed textarea").fill("30 12");
    await page.locator(".chart-ed-options input[placeholder='100']").fill("84");
    await page.waitForFunction(() => /50%/.test(document.querySelector(".chart-ed-preview")?.textContent ?? ""));
    await page.keyboard.press("Escape");
    await page.waitForSelector(".ichip-chart svg.chart-progress");
    return /^Progress 50%, 42 of 84$/.test(await chipLabel()) && /50%/.test(await page.locator(".ichip-chart").first().textContent());
  });

  // ---------- block ----------
  await check("/Chart block inserts a bar chart block that opens the editor", async () => {
    await page.locator(".doc-tail").click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("blk-ta"));
    await slash("/chart block", "Chart block");
    await page.waitForSelector(".chart-block svg.chart-bar");
    await blurEditor();
    await page.locator(".chart-block").click();
    await page.waitForSelector(".chart-ed");
    const sized = (await page.locator(".chart-ed-options select").count()) === 1;
    await page.locator(".chart-ed-options select").selectOption("l");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".chart-ed", { state: "detached" });
    return sized && /^Bar chart of 5 values/.test((await page.locator(".chart-block").getAttribute("aria-label")) ?? "");
  });
  await check("block menu: Type > Pie, Colour > Teal, Size", async () => {
    await dismissToasts();
    await page.locator(".chart-block svg").click({ button: "right", position: { x: 4, y: 4 } });
    await page.waitForSelector(".menu");
    await page.locator(".menu .menu-item", { hasText: "Type" }).first().click();
    await page.locator(".menu .menu-item", { hasText: "Pie" }).first().click();
    await page.waitForSelector(".chart-block svg.chart-pie");
    await page.locator(".chart-block svg").click({ button: "right", position: { x: 4, y: 4 } });
    await page.locator(".menu .menu-item", { hasText: "Colour" }).first().click();
    await page.locator(".menu .menu-item", { hasText: "Teal" }).first().click();
    await page.waitForTimeout(200);
    const style = await page.locator(".chart-block svg").getAttribute("style");
    return /--ch:180/.test(style ?? "") && (await page.locator(".chart-block .c-leg").count()) === 5;
  });
  await shot("block-pie");
  await check("the block survives a reload (and keeps its settings)", async () => {
    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForSelector(".chart-block svg.chart-pie");
    return /--ch:180/.test((await page.locator(".chart-block svg").getAttribute("style")) ?? "");
  });
  await check("block: 4 chart types draw (spark, bar, pie, progress) with no errors", async () => {
    for (const [label, cls] of [["Sparkline", "chart-spark"], ["Bar", "chart-bar"], ["Progress", "chart-progress"]]) {
      await page.locator(".chart-block svg").click({ button: "right", position: { x: 2, y: 2 } });
      await page.locator(".menu .menu-item", { hasText: "Type" }).first().click();
      await page.locator(".menu .menu-item", { hasText: label }).first().click();
      await page.waitForSelector(`.chart-block svg.${cls}`);
    }
    return true;
  });

  // ---------- database-fed, hostile labels ----------
  const seeded = await page.evaluate(async (evil) => {
    const { createStore } = await import("./js/store.js");
    const { createWorkspace } = await import("./js/workspace.js");
    const { config } = await import("./js/config.js");
    const { newBlock } = await import("./js/blocks/model.js");
    const { buildToken } = await import("./js/blocks/inline.js");
    const ws = createWorkspace(await createStore(config));
    const repo = (await ws.listPages()).find((p) => p.type === "repo");
    const db = await ws.createPage({ type: "database", title: "Sales data", parentId: repo.id });
    const amt = { ...db.columns[0], id: "amt", name: "Amount", type: "number", config: {} };
    db.columns = [db.columns[0], amt];
    await ws.savePage(db);
    for (const [name, v] of [["Mon", 4], ["Tue", 9], ["Wed", 6]]) await ws.createRow(db, { [db.columns[0].id]: name, amt: v });
    const doc = await ws.createPage({ title: "Chart doc", parentId: repo.id });
    const tok = (spec) => buildToken("chart", [JSON.stringify(spec)]);
    doc.blocks = [
      newBlock("p", { text: `Revenue ${tok({ k: "spark", s: "d", d: db.id, c: "amt", a: "rows", h: 240 })} total ${tok({ k: "progress", s: "d", d: db.id, c: "amt", a: "sum", m: 50, h: 150 })} and ${tok({ k: "pie", n: [1, 2, 3], l: [evil, "b", "c"], t: evil })}` }),
      newBlock("dbview", { sourceId: db.id }),
      newBlock("chart", { k: "bar", s: "d", d: db.id, c: "amt", a: "rows", z: "s" }),
      newBlock("p", { text: "end" })
    ];
    await ws.savePage(doc);
    return { doc: doc.id, db: db.id, nameCol: db.columns[0].id };
  }, EVIL);
  await page.reload();
  await page.waitForSelector(".side-item", { state: "attached" });
  await openSide();
  await page.locator(".side-item", { hasText: "Chart doc" }).click();
  await page.waitForSelector(".ichip-chart svg");
  await dismissToasts();
  await check("database-fed chips and block read the column", async () => {
    await page.waitForFunction(() => /^Sparkline of 3 values, min 4, max 9, last 6$/.test(document.querySelector(".ichip-chart")?.getAttribute("aria-label") ?? ""));
    const second = await chipLabel(1);
    const block = await page.locator(".chart-block").getAttribute("aria-label");
    return /^Progress 38%, 19 of 50$/.test(second) && /^Bar chart of 3 values, min 4, max 9, last 6/.test(block);
  });
  await check("hostile labels stay text: no script ran, the caption is kept as data", async () => {
    const label = await chipLabel(2);
    return label.startsWith(EVIL) && (await page.evaluate(() => window.__chartXss)) === undefined && (await page.locator(".ichip-chart img").count()) === 0;
  });
  await shot("db-fed");
  await check("a cell edit in the embedded view updates the chips and the block (debounced)", async () => {
    const cell = page.locator(".db-body input[type=number], .vb input[type=number], .db-body input").filter({ hasText: "" });
    const inputs = await page.locator("input").evaluateAll((els) => els.map((e) => ({ v: e.value, t: e.type })));
    const idx = inputs.findIndex((x) => x.v === "6");
    if (idx < 0) throw new Error(`no cell with 6 among ${JSON.stringify(inputs).slice(0, 200)}`);
    const input = page.locator("input").nth(idx);
    await input.fill("30");
    await input.press("Tab");
    await page.waitForFunction(() => /last 30$/.test(document.querySelector(".ichip-chart")?.getAttribute("aria-label") ?? ""), null, { timeout: 5000 });
    await page.waitForFunction(() => /Progress 86%, 43 of 50/.test(document.querySelectorAll(".ichip-chart")[1]?.getAttribute("aria-label") ?? ""), null, { timeout: 5000 });
    await page.waitForFunction(() => /last 30/.test(document.querySelector(".chart-block")?.getAttribute("aria-label") ?? ""), null, { timeout: 5000 });
    void cell;
  });
  await check("the database editor offers the database, column, saved view and aggregation", async () => {
    await dismissToasts();
    await page.locator(".ichip-chart").first().click();
    await page.waitForSelector(".chart-ed");
    const selects = await page.locator(".chart-ed-source select").count();
    const sel = await page.locator(".chart-ed-source select").first().inputValue();
    await page.locator(".chart-ed-source select").nth(1).selectOption("amt");
    await page.waitForFunction(() => /Sparkline of 3 values/.test(document.querySelector(".chart-ed-preview .ichip-chart")?.getAttribute("title") ?? ""));
    await page.locator(".modal-actions button", { hasText: "Cancel" }).click();
    return selects === 4 && sel === seeded.db;
  });
  await check("a database-fed chip stops listening once it is off the page (only while connected)", async () => {
    return page.evaluate(async () => {
      const { watchChart } = await import("./js/ui/chartUi.js");
      let subs = 0;
      let fire = () => {};
      const ws = { onDataChange: (f) => { subs++; fire = f; return () => { subs--; }; }, listRows: async () => [] };
      const ctx = { ws, livePages: () => [], pageInfo: () => ({ state: "missing" }) };
      const el = document.createElement("span");
      document.body.append(el);
      let paints = 0;
      watchChart(el, { k: "spark", s: "d", d: "x", c: "y", a: "rows" }, ctx, () => { paints++; });
      await new Promise((r) => setTimeout(r, 50));
      const first = paints;
      fire();
      await new Promise((r) => setTimeout(r, 500));
      const afterConnected = paints;
      el.remove();
      fire();
      await new Promise((r) => setTimeout(r, 500));
      return subs === 0 && afterConnected > first && paints === afterConnected;
    });
  });

  // ---------- layout ----------
  await page.locator(".side-item", { hasText: "Chart doc" }).click().catch(async () => {
    await openSide();
    await page.locator(".side-item", { hasText: "Chart doc" }).click();
  });
  await page.waitForSelector(".ichip-chart svg");
  await check("no horizontal page scroll", noXScroll);
  if (phone) {
    await check("phone: the editor is a bottom sheet that fits the screen", async () => {
      await dismissToasts();
      await page.locator(".ichip-chart").first().tap();
      await page.waitForSelector(".chart-ed");
      await page.waitForTimeout(400); // the dialog pops in
      const r = await page.locator(".chart-ed-modal").evaluate((el) => {
        const b = el.getBoundingClientRect();
        return { w: b.width, bottom: b.bottom, vh: window.innerHeight, sw: document.documentElement.scrollWidth, fs: getComputedStyle(el.querySelector("input,select,textarea")).fontSize };
      });
      await shot("editor-sheet");
      const ok = r.w >= 388 && Math.abs(r.bottom - r.vh) < 2 && r.sw <= 391 && parseFloat(r.fs) >= 16;
      await page.locator(".modal-actions button", { hasText: "Cancel" }).tap();
      return ok;
    });
  }
  await shot("final");
  await check("no page errors", async () => errs.length === 0 || (console.log(errs.slice(0, 5)), false));
  await ctx.close();
  return fails;
}

(async () => {
  const browser = await chromium.launch();
  let all = [];
  try {
    for (const phone of [false, true]) {
      const f = await run(browser, { phone });
      all = all.concat(f.map((x) => `${phone ? "[phone] " : ""}${x}`));
    }
  } finally {
    await browser.close();
    server.kill();
  }
  if (all.length) {
    console.log("FAIL:\n - " + all.join("\n - "));
    process.exit(1);
  }
  console.log("chart e2e: all checks passed");
})().catch((e) => {
  server.kill();
  console.error(e);
  process.exit(1);
});
