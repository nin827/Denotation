// Links, embeds, backlinks and the graph UI in the real app (Playwright, dev-only).
// usage: PORT=8090 node work/test/e2e/links.cjs        (SHOTS=/some/dir to save desktop + 390px phone screenshots)
// Starts its own static server on PORT over the repo root and uses a fresh browser profile (the seeded workspace).
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "../../..");
const PORT = Number(process.env.PORT) || 8099;
const SHOTS = process.env.SHOTS || "";
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", root], { stdio: "ignore" });
const url = `http://127.0.0.1:${PORT}/source/app/index.html`;

async function flow(browser, { phone = false } = {}) {
  const fails = [];
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `links-${name}${phone ? "-phone" : ""}.png`) });
  const check = async (label, fn) => {
    try {
      const ok = await fn();
      if (ok === false) fails.push(label);
    } catch (e) {
      fails.push(`${label}: ${String(e.message || e).split("\n")[0]}`);
    }
  };
  const openSide = async () => {
    if (await page.locator("#side-open").isVisible().catch(() => false)) await page.locator("#side-open").click();
  };
  const openPage = async (title) => {
    await openSide();
    await page.locator(".side-item", { hasText: title }).first().click();
    await page.waitForFunction((t) => document.querySelector(".page-title")?.value === t, title);
  };
  const newLine = async () => {
    await page.locator(".doc-tail").click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("blk-ta"));
  };
  const blurEditor = async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(500); // debounced save (400 ms)
  };

  await page.goto(url);
  await page.waitForSelector(".side-item", { state: "attached" });
  await openPage("Welcome to Denotation");

  // 1. [[ autocomplete: keyboard pick -> link chip with the live title
  await check("[[ menu inserts a link chip", async () => {
    await newLine();
    await page.keyboard.type("See [[A sub");
    await page.waitForSelector(".menu .menu-item", { hasText: "A sub-page" });
    await page.keyboard.press("Enter");
    await page.keyboard.type(" and x[[A sub");
    await page.waitForSelector(".menu .menu-item", { hasText: "A sub-page" });
    await page.keyboard.press("Enter");
    const raw = await page.evaluate(() => document.activeElement.value);
    if (!/^See \{\{link:[\w-]+\}\} and \{\{xlink:[\w-]+\}\}$/.test(raw)) throw new Error(`text is ${raw}`);
    await blurEditor();
    const chips = await page.locator(".rendered .ichip-link").allTextContents();
    return chips.length === 2 && chips.every((t) => t.includes("A sub-page")) && !(await page.locator(".rendered", { hasText: "x" + "A sub-page" }).count());
  });
  // 2. typed wiki syntax converts on the closing ]]
  await check("typed [[Title]] converts to a token", async () => {
    await newLine();
    await page.keyboard.type("Typed [[a sub-page]] here");
    await page.keyboard.press("Escape");
    const raw = await page.evaluate(() => document.activeElement.value);
    if (!/^Typed \{\{link:[\w-]+\}\} here$/.test(raw)) throw new Error(`text is ${raw}`);
    await blurEditor();
    return true;
  });
  await shot("chips");
  // 3. a chip opens its page; backlinks list the linking page (and mark the hidden link)
  await check("link chip opens the page and backlinks list the source", async () => {
    await page.locator(".rendered .ichip-link").first().click();
    await page.waitForFunction(() => document.querySelector(".page-title")?.value === "A sub-page");
    await page.waitForSelector(".backlinks .backlink", { hasText: "Welcome to Denotation" });
    return true;
  });
  // 4. embeds: a heading section from another page, and a self-including section shows a warning
  await check("![[Page][Heading]] embeds the section", async () => {
    await newLine();
    await page.keyboard.type("![[Welcome to Denotation][Layout]]");
    await blurEditor();
    await page.waitForSelector(".rendered .embed[data-embed]");
    const t = await page.locator(".rendered .embed").first().textContent();
    return t.includes("Layout") && t.includes("Open source");
  });
  await check("recursive embed shows a warning", async () => {
    await newLine();
    await page.keyboard.type("## Loop");
    await page.keyboard.press("Enter");
    await page.keyboard.type("![[A sub-page][Loop]]");
    await blurEditor();
    await page.waitForSelector(".rendered .embed-warn", { hasText: "Recursive" });
    return true;
  });
  // 5. ![[ menu: page, then a heading
  await check("![[ menu picks a heading section", async () => {
    await newLine();
    await page.keyboard.type("![[Welcome");
    await page.waitForSelector(".menu .menu-item", { hasText: "Welcome to Denotation" });
    await page.keyboard.press("Enter");
    await page.waitForSelector(".menu .menu-item", { hasText: "Blocks" });
    await page.locator(".menu .menu-item", { hasText: "Blocks" }).first().click();
    const raw = await page.evaluate(() => document.activeElement.value);
    if (!/^\{\{embed:[\w-]+\|h\|[\w-]+\}\}$/.test(raw)) throw new Error(`text is ${raw}`);
    await blurEditor();
    return true;
  });
  await shot("embeds");
  // 6. graph block from the slash menu
  await check("/graph inserts a graph block", async () => {
    await newLine();
    await page.keyboard.type("/graph");
    await page.locator(".menu .menu-item", { hasText: /^Graph/ }).first().click();
    await page.waitForSelector(".graph-block canvas.graph-canvas");
    await page.waitForFunction(() => /\d+ pages?/.test(document.querySelector(".graph-block .graph-count")?.textContent || ""));
    return true;
  });
  await page.waitForTimeout(600);
  await shot("block");
  // 7. local graph panel
  await check("page menu opens the local graph", async () => {
    await page.locator(".page-actions button[aria-label='Page options']").click();
    await page.locator(".menu-item", { hasText: "Local graph" }).click();
    await page.waitForSelector(".graph-panel canvas.graph-canvas");
    await page.waitForFunction(() => /^[2-9]\d* pages/.test(document.querySelector(".graph-panel .graph-count")?.textContent || ""));
    return true;
  });
  await page.waitForTimeout(600);
  await shot("local");
  await check("local graph closes", async () => {
    await page.locator(".graph-panel-close").click();
    return (await page.locator(".graph-panel").count()) === 0;
  });
  // 8. graph appearance
  await check("graph appearance saves a colour", async () => {
    await page.locator(".page-actions button[aria-label='Page options']").click();
    await page.locator(".menu-item", { hasText: "Graph appearance" }).click();
    await page.locator(".graph-swatch[aria-label='Green']").click();
    if ((await page.locator(".graph-swatch[aria-label='Green']").getAttribute("aria-pressed")) !== "true") throw new Error("swatch not pressed");
    await shot("appearance");
    await page.locator(".modal-actions button.primary").click();
    await page.waitForSelector(".toast", { hasText: "Graph appearance saved" });
    return true;
  });
  // 9. the Graph page: canvas, list mode, search filter, rules dialog for a repository
  await check("workspace menu opens the Graph page", async () => {
    await openSide();
    await page.locator(".act-more").click();
    await page.locator(".menu-item", { hasText: /^Graph$/ }).click();
    await page.waitForSelector(".graph-page canvas.graph-canvas");
    await page.waitForFunction(() => /\d+ pages?, \d+ links?/.test(document.querySelector(".graph-page .graph-count")?.textContent || ""));
    return true;
  });
  await page.waitForTimeout(900);
  await shot("graph");
  await check("list view lists the linked pages", async () => {
    await page.locator(".graph-page .graph-seg-btn[data-mode='list']").click();
    await page.waitForSelector(".graph-list-open", { hasText: "A sub-page" });
    await page.locator(".graph-page .graph-seg-btn[data-mode='canvas']").click();
    return true;
  });
  await check("search narrows the graph", async () => {
    await page.fill(".graph-search", "sub-page");
    await page.waitForFunction(() => /^1 page/.test(document.querySelector(".graph-page .graph-count")?.textContent || ""));
    await page.fill(".graph-search", "");
    return true;
  });
  await check("repository graph and rules dialog", async () => {
    const repo = await page.locator(".graph-repo option").nth(1).getAttribute("value");
    await page.selectOption(".graph-repo", repo);
    await page.waitForFunction((r) => location.hash === `#graph-${r}`, repo);
    await page.waitForSelector(".graph-rules-btn:not([disabled])");
    await page.locator(".graph-rules-btn").click();
    await page.locator(".modal button", { hasText: "Add rule" }).click();
    await page.locator(".graph-rule input[type=text]").fill("page");
    await page.locator(".graph-rule .graph-swatch[aria-label='Orange']").click();
    await shot("rules");
    await page.locator(".modal-actions button.primary").click();
    await page.waitForSelector(".toast", { hasText: "1 graph rule saved" });
    return true;
  });
  // no horizontal page scroll on the graph page
  await check("no horizontal scroll", () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  if (errs.length) fails.push(`console errors: ${errs.join(" | ")}`);
  await ctx.close();
  return fails.map((f) => `${phone ? "phone" : "desktop"}: ${f}`);
}

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const fails = [];
  try {
    fails.push(...(await flow(browser)));
    fails.push(...(await flow(browser, { phone: true })));
  } catch (e) {
    fails.push(String(e?.stack || e));
  }
  await browser.close();
  server.kill();
  if (fails.length) {
    console.log("FAIL\n  " + fails.join("\n  "));
    process.exit(1);
  }
  console.log("ok   links e2e");
})();
