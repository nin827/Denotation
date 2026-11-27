// Terms e2e: manage terms in the repository dialog, insert chips with /Term and @, hover / focus / tap cards, live updates,
// branch rules and deletion. usage: PORT=8094 node work/test/e2e/terms.cjs [shotDir]   (Playwright + Chromium, dev-only)
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "../../..");
const PORT = Number(process.env.PORT) || 8095;
if (PORT === 8080) throw new Error("port 8080 is the owner's data");
const SHOTS = process.argv[2] || "";
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", root], { stdio: "ignore" });
const URL = `http://127.0.0.1:${PORT}/source/app/index.html`;
const errs = [];
let livePage = null;
const KNOWN = /reading 'waiting'/; // the PWA code expects a service worker, which this test blocks so it can serve patched copies
const check = (ok, msg) => { if (!ok) errs.push(msg); };
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };

async function openTerms(page) {
  await page.locator(".side-item.repo").first().click({ button: "right" });
  const terms = page.locator(".menu-item", { hasText: "Terms" });
  if (await terms.count()) await terms.first().click();
  else {
    await page.locator(".menu-item", { hasText: "Constants" }).first().click();
    await page.locator(".rs-tab", { hasText: "Terms" }).click();
  }
  await page.waitForSelector(".tm");
}
async function addTerm(page, text, { def = "", category = "", branchOf = null, hue = null } = {}) {
  if (branchOf) {
    await page.locator(`.tm-row[data-term="${branchOf}"] .tm-more`).click();
    await page.locator(".menu-item", { hasText: "Add branch" }).click();
  } else await page.locator(".rs-add-term").click();
  const box = page.locator(".tm-editor");
  await box.locator('input[aria-label="Term text"]').fill(text);
  await box.locator('input[aria-label="Term text"]').blur();
  if (def) await page.locator(".tm-editor textarea").fill(def);
  if (category) { await page.locator('.tm-editor input[aria-label="Category"]').fill(category); await page.locator('.tm-editor input[aria-label="Category"]').blur(); }
  if (hue !== null) await page.locator('.tm-editor select[aria-label="Colour"]').selectOption(String(hue));
  await page.locator(".tm-done").click();
}

// The editor's @ menu and the sidebar menu are owned elsewhere; until their one-line patches land, serve patched copies so
// this test covers them (when the real files already have the patch, they are served untouched).
async function patchOwned(context) {
  const patch = (file, marker, edits) => context.route(`**/${file}`, async (route) => {
    let text = fs.readFileSync(path.join(root, "source/app", file), "utf8");
    if (!text.includes(marker)) for (const [from, to] of edits) text = text.replace(from, to);
    await route.fulfill({ body: text, contentType: "text/javascript" });
  });
  await patch("js/ui/blockEditor.js", "termMentionItems", [
    ['import { findRepo, constantsOf, formatConstant } from "../constants.js";', 'import { findRepo, constantsOf, formatConstant } from "../constants.js";\nimport { termMentionItems } from "./termsUi.js";'],
    ["return [...consts, ...links, ...chips];", "return [...consts, ...termMentionItems(ctx, query, (tok) => put(`${tok} `)), ...links, ...chips];"]
  ]);
  await patch("js/ui/sidebar.js", "\"terms\")", [
    ['p.type === "repo" ? { label: "Statuses\\u2026", icon: ico("circle-dot"), onSelect: () => onRepoSettings(p, "statuses") } : null,', 'p.type === "repo" ? { label: "Statuses\\u2026", icon: ico("circle-dot"), onSelect: () => onRepoSettings(p, "statuses") } : null,\n        p.type === "repo" ? { label: "Terms\\u2026", icon: ico("book-a"), onSelect: () => onRepoSettings(p, "terms") } : null,']
  ]);
}

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, serviceWorkers: "block" });
  await patchOwned(ctx);
  const page = livePage = await ctx.newPage();
  page.on("pageerror", (e) => !KNOWN.test(e.message) && errs.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errs.push(`console: ${m.text()}`));
  await page.goto(URL);
  await page.waitForSelector(".side-item");

  // ----- manage -----
  await openTerms(page);
  check(await page.locator(".tm .ip-empty", { hasText: "No terms yet" }).count() === 1, "empty state");
  await addTerm(page, "Branch", { def: "A part that grows off the trunk.", category: "Plants", hue: 120 });
  await addTerm(page, "Long Branch", { branchOf: "Branch", def: "Reaches far." });
  await addTerm(page, "Short Branch", { branchOf: "Branch" });
  await addTerm(page, "Solo", { category: "Misc" });
  check(await page.locator(".tm-row.is-branch").count() === 2, "two branches indented");
  check(await page.locator('.tm-row[data-term="Branch"] .tm-count').count() === 1, "branch count shown");
  check((await page.locator(".tm-cat").allTextContents()).map((s) => s.trim()).join("|") === "Misc|Plants", "grouped by category: " + (await page.locator(".tm-cat").allTextContents()));
  // a branch cannot get branches: no "Add branch" on a branch
  await page.locator('.tm-row[data-term="Long Branch"] .tm-more').click();
  check(await page.locator(".menu-item", { hasText: "Add branch" }).count() === 0, "no Add branch on a branch");
  await page.keyboard.press("Escape");
  // inherited hue shown on the branch chip
  const hueVar = await page.locator('.tm-row[data-term="Long Branch"] .ichip-term').evaluate((el) => el.style.getPropertyValue("--term-h"));
  check(hueVar === "120", "branch inherits hue, got " + hueVar);
  // search
  await page.locator(".tm-search").fill("far");
  check(await page.locator(".tm-row").count() === 2, "search keeps the parent of a matching branch");
  await page.locator(".tm-search").fill("");
  // category default icon
  await page.locator(".tm-defaults summary").click();
  await page.locator('.tm-def-row[data-category="Plants"] .tm-icon-btn').click();
  await page.locator(".icon-grid button").first().click();
  check(await page.locator('.tm-row[data-term="Short Branch"] .ichip-term .term-icon').count() === 1, "branch inherits category icon");
  await shot(page, "dialog-desktop");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".modal", { state: "detached" });
  await page.keyboard.press("Escape");

  // ----- insert on a page -----
  const docs = page.locator(".side-item:not(.repo)");
  await docs.first().click();
  await page.waitForSelector(".rendered", { state: "attached" });
  const addPara = async () => {
    if (!await page.locator(".blk-content.editing textarea.blk-ta").count()) await page.locator(".rendered").last().click({ force: true });
    const ta = page.locator(".blk-content.editing textarea.blk-ta");
    await ta.waitFor();
    return ta;
  };
  let ta = await addPara();
  await ta.type("See /Term");
  await page.locator(".menu-item", { hasText: "Term" }).first().click();
  await page.waitForSelector(".term-pick");
  check(await page.locator(".term-pick-item").count() === 4, "picker lists all terms");
  check(await page.locator(".term-pick-item.is-branch").count() === 2, "picker indents branches");
  await page.locator(".term-pick .ip-search").fill("long");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".modal", { state: "detached" });
  ta = await addPara();
  await ta.press("End");
  await ta.type(" and @solo");
  await page.waitForSelector(".menu-item .menu-hint:text('term')");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.mouse.click(1000, 700);
  await page.waitForSelector(".ichip-term");
  const chipTexts = await page.locator(".rendered .ichip-term .term-text").allTextContents();
  check(chipTexts.join("|") === "Long Branch|Solo", "chips inserted: " + chipTexts);
  const weight = await page.locator(".rendered .ichip-term .term-text").first().evaluate((el) => getComputedStyle(el).fontWeight);
  check(Number(weight) >= 700, "bold " + weight);

  // ----- card: hover, Esc, focus, tap -----
  const chip = page.locator(".rendered .ichip-term").first();
  await chip.hover();
  await page.waitForSelector(".term-card:not([hidden])");
  const cardText = await page.locator(".term-card").innerText();
  check(/Branch of Branch/.test(cardText) && /Reaches far/.test(cardText) && /part that grows/.test(cardText), "card shows branch info: " + cardText);
  check(await chip.getAttribute("aria-describedby") === "term-card", "aria-describedby while shown");
  check(await page.locator(".term-card").getAttribute("role") === "tooltip", "tooltip role");
  await shot(page, "card-desktop");
  await page.keyboard.press("Escape");
  check(await page.locator(".term-card:not([hidden])").count() === 0, "Esc closes the card");
  check(await chip.getAttribute("aria-describedby") === null, "aria-describedby removed");
  await page.mouse.move(5, 5);
  await page.locator(".rendered .ichip-term").nth(1).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  check(await page.locator(".term-card:not([hidden])").count() === 1, "keyboard focus shows the card");
  await page.keyboard.press("Escape");

  // ----- live update -----
  await openTerms(page);
  await page.locator('.tm-row[data-term="Long Branch"] .icon[aria-label^="Edit"]').click();
  await page.locator('.tm-editor input[aria-label="Term text"]').fill("Lengthy Branch");
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".modal", { state: "detached" });
  check((await page.locator(".rendered .ichip-term .term-text").first().textContent()) === "Lengthy Branch", "chip updates live");

  // ----- delete parent: keep branches -----
  await openTerms(page);
  await page.locator('.tm-row[data-term="Branch"] .tm-more').click();
  await page.locator(".menu-item", { hasText: "Delete" }).click();
  check(/Keep branches/.test(await page.locator(".modal").last().innerText()), "delete asks about branches");
  await shot(page, "delete-branches");
  await page.locator(".modal-actions button", { hasText: "Keep branches" }).click();
  await page.waitForTimeout(300);
  check(await page.locator(".tm-row.is-branch").count() === 0, "branches became plain terms");
  check(await page.locator(".tm-row", { hasText: "Lengthy Branch" }).count() === 1, "kept branch still listed");
  check((await page.locator('.tm-row[data-term="Lengthy Branch"] .ichip-term').evaluate((el) => el.style.getPropertyValue("--term-h"))) === "120", "kept branch keeps its inherited hue");
  // delete a used term: count shown, chips show Not found
  await page.locator('.tm-row[data-term="Solo"] .tm-more').click();
  await page.locator(".menu-item", { hasText: "Delete" }).click();
  check(/1 chip/.test(await page.locator(".modal").last().innerText()), "delete shows usage count: " + (await page.locator(".modal").last().innerText()));
  await page.locator(".modal-actions button", { hasText: "Delete" }).last().click();
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".modal", { state: "detached" });
  check(await page.locator(".rendered .ichip-miss", { hasText: "Not found" }).count() === 1, "deleted term chip shows Not found");

  // ----- reload: data persists -----
  await page.waitForTimeout(800);
  check(await page.evaluate(() => Object.values(localStorage).some((v) => v.includes("{{term:"))), "chip tokens were saved");
  await page.reload();
  await page.waitForSelector(".side-item");
  await page.locator(".side-item:not(.repo)").first().click();
  await page.waitForSelector(".ichip-term", { state: "attached" });
  check(await page.locator(".rendered .ichip-term .term-text").first().textContent() === "Lengthy Branch", "persists after reload");

  // ----- phone: tap shows the card, tap elsewhere hides it -----
  const phone = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, storageState: await ctx.storageState(), serviceWorkers: "block" });
  await patchOwned(phone);
  const mp = await phone.newPage();
  mp.on("pageerror", (e) => !KNOWN.test(e.message) && errs.push(`phone pageerror: ${e.message}`));
  await mp.goto(URL);
  await mp.waitForSelector(".side-item", { state: "attached" });
  const open = mp.locator("#side-open, .side-toggle, [aria-label='Open sidebar'], [aria-label='Menu']").first();
  await mp.evaluate(() => { const r = [...document.querySelectorAll(".side-item")].find((x) => !x.classList.contains("repo")); r?.click(); });
  await mp.waitForSelector(".ichip-term", { state: "attached" });
  await mp.locator(".rendered .ichip-term").first().scrollIntoViewIfNeeded();
  await mp.locator(".rendered .ichip-term").first().tap();
  await mp.waitForSelector(".term-card:not([hidden])");
  const box = await mp.locator(".term-card").boundingBox();
  check(box && box.x >= 0 && box.x + box.width <= 390, "card fits the phone width");
  await shot(mp, "card-phone");
  await mp.locator(".page-title, h1, body").first().tap({ position: { x: 5, y: 5 }, force: true });
  await mp.waitForTimeout(200);
  check(await mp.locator(".term-card:not([hidden])").count() === 0, "tap elsewhere hides the card");
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  check(!overflow, "no horizontal scroll on phone");
  await mp.evaluate(() => [...document.querySelectorAll(".side-item.repo")][0]?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 })));
  await mp.locator(".menu-item", { hasText: /Constants|Terms/ }).first().click();
  await mp.locator(".rs-tab", { hasText: "Terms" }).click();
  await mp.waitForSelector(".tm");
  await shot(mp, "dialog-phone");
  const o2 = await mp.evaluate(() => { const m = document.querySelector(".modal"); return m.scrollWidth > m.clientWidth; });
  check(!o2, "dialog has no horizontal scroll on phone");

  await browser.close();
  server.kill();
  if (errs.length) {
    console.error("terms e2e FAILED:\n- " + errs.join("\n- "));
    process.exit(1);
  }
  console.log("terms e2e OK");
})().catch(async (e) => { console.error(e, "\nrecorded:", errs); if (SHOTS && livePage) await livePage.screenshot({ path: path.join(SHOTS, "failure.png") }).catch(() => {}); server.kill(); process.exit(1); });
