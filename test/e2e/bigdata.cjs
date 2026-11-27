// Big-data checks for the windowed table / sheet and the chunked card layouts (Playwright, dev-only).
// usage: PORT=8099 node test/e2e/bigdata.cjs   (starts its own static server on PORT, serves public/ with an in-memory seeded store)
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");

const PORT = Number(process.env.PORT) || 8099;
const pub = path.resolve(__dirname, "../../public");
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", pub], { stdio: "ignore" });

const N = 1500;
const col = (id, name, type, config = {}) => ({ id, name, type, config });
const columns = [
  col("c1", "Name", "text"), col("c2", "Status", "select", { options: ["Todo", "Doing", "Done"] }),
  col("c3", "Qty", "number"), col("c4", "Price", "number"), col("c5", "Due", "date"),
  col("c6", "Total", "formula", { expr: "[Qty] * [Price]" })
];
const view = (id, type, extra = {}) => ({ id, name: id, type, filter: { op: "and", rules: [] }, sorts: [], groupBy: null, hidden: [], ...extra });
const pages = [
  { id: "repo", type: "repo", title: "Repo", parentId: null, createdAt: 1, updatedAt: 1 },
  { id: "db", type: "database", title: "Big", parentId: "repo", createdAt: 2, updatedAt: 2, columns,
    views: [view("table", "table"), view("sheet", "sheet"), view("board", "board", { groupBy: "c2" }), view("grouped", "table", { groupBy: "c2" }), view("sorted", "table", { sorts: [{ col: "c3", dir: "desc" }] }), view("wrapped", "table", { wrapAll: true })] }
];
const rows = Array.from({ length: N }, (_, i) => ({
  id: `r${String(i).padStart(5, "0")}`, dbId: "db", createdAt: 10 + i / 1000, updatedAt: 10,
  values: { c1: `Item ${i}`, c2: ["Todo", "Doing", "Done"][i % 3], c3: i % 50, c4: 2, c5: "2026-03-05" }
}));
const STUB = `import { createMemoryAdapter } from "./adapters/memory.js";
export async function createStore() { const s = createMemoryAdapter(); const d = await (await fetch("__seed.json")).json();
  for (const p of d.pages) await s.set("pages", p.id, p); for (const r of d.rows) await s.set("rows", r.id, r); return s; }`;

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errs = [];
  const fail = (m) => { errs.push(m); console.error("FAIL:", m); };
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await page.route("**/js/store.js", (r) => r.fulfill({ contentType: "text/javascript", body: STUB }));
  await page.route("**/__seed.json", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ pages, rows }) }));
  await page.goto(`http://127.0.0.1:${PORT}/index.html#page-db`);
  await page.waitForSelector(".db-table tbody tr:not(.vspacer)");
  const tab = (name) => page.locator(".view-tab .vt-main", { hasText: new RegExp(`^${name}$`) }).click();
  const scrollMain = (frac) => page.evaluate((f) => { const m = document.querySelector("#main"); m.scrollTop = f === 1 ? m.scrollHeight : m.scrollHeight * f; return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(m.scrollTop)))); }, frac);
  const names = (sel) => page.$$eval(sel, (els) => els.map((e) => e.value ?? e.textContent));

  // ---- table: windowed
  const drawn = await page.locator(".db-table tbody tr").count();
  if (drawn > 200 || drawn < 20) fail(`table drew ${drawn} <tr> (expected a window, not all ${N})`);
  const total = await page.evaluate(() => document.querySelector(".db-table").getBoundingClientRect().height);
  if (total < N * 20) fail(`table height ${total} is too small for ${N} rows (spacers broken)`);
  await scrollMain(1);
  const lastNames = await names(".db-table tbody tr:not(.vspacer) td:first-child input");
  if (!lastNames.includes(`Item ${N - 1}`)) fail("the last row is not drawn after scrolling to the bottom");
  if (lastNames.includes("Item 0")) fail("the first row is still drawn at the bottom");
  const totalCell = await page.evaluate(() => { const rows = [...document.querySelectorAll(".db-table tbody tr:not(.vspacer)")]; const r = rows.at(-1); return [r.querySelector("td:first-child input").value, r.querySelector("[data-frow]")?.textContent]; });
  const lastI = Number(totalCell[0].replace("Item ", ""));
  if (totalCell[1] !== String((lastI % 50) * 2)) fail(`formula cell of ${totalCell[0]} shows ${totalCell[1]}`);
  // edit a row in the middle, scroll away and back: the edit is kept
  await scrollMain(0.5);
  const midRow = page.locator(".db-table tbody tr:not(.vspacer)").nth(5);
  const midName = await midRow.locator("td:first-child input").inputValue();
  await midRow.locator("td:first-child input").fill(`${midName} edited`);
  await midRow.locator("td:first-child input").press("Tab");
  await scrollMain(0); await scrollMain(0.5);
  if (!(await names(".db-table tbody td:first-child input")).includes(`${midName} edited`)) fail("an edit in a windowed table row was lost after scrolling away and back");
  // grouped table keeps its group header rows
  await tab("grouped");
  await page.waitForSelector(".group-row");
  await scrollMain(1);
  if (!(await page.locator(".group-row").count())) fail("the last group header is not drawn at the bottom");
  await tab("sorted");
  await page.waitForSelector(".db-table tbody tr:not(.vspacer)");
  const firstQty = await page.locator(".db-table tbody tr:not(.vspacer) td:nth-child(3) input").first().inputValue();
  if (firstQty !== "49") fail(`sorted view starts with Qty ${firstQty}, expected 49`);

  // wrapped cells make rows differ in height: the window still reaches the end
  await tab("wrapped");
  await page.waitForSelector(".db-table tbody tr:not(.vspacer)");
  await scrollMain(1); await page.waitForTimeout(200); await scrollMain(1);
  const wrapNames = await names(".db-table tbody tr:not(.vspacer) td:first-child textarea");
  if (!wrapNames.includes(`Item ${N - 1}`)) fail("wrapped table: the last row is not drawn at the bottom");
  const gap = await page.evaluate(() => { const t = document.querySelector(".db-table").getBoundingClientRect(); const m = document.querySelector("#main").getBoundingClientRect(); return m.bottom - t.bottom; });
  if (gap > 400) fail(`wrapped table: ${gap}px of blank space below the last row`);

  // ---- sheet: windowed, keyboard navigation reaches far rows
  await tab("sheet");
  await page.waitForSelector(".sheet-table tbody tr:not(.vspacer)");
  const sheetDrawn = await page.locator(".sheet-table tbody tr").count();
  if (sheetDrawn > 200) fail(`sheet drew ${sheetDrawn} rows`);
  await page.locator('.sheet td[data-r="0"][data-c="0"]').click();
  for (let i = 0; i < 150; i++) await page.keyboard.press("ArrowDown");
  const focusR = await page.evaluate(() => document.querySelector(".sheet td.focus")?.dataset.r);
  if (focusR !== "150") fail(`after 150 ArrowDown the focus cell is row ${focusR}`);
  const inView = await page.evaluate(() => { const td = document.querySelector(".sheet td.focus"); const m = document.querySelector("#main").getBoundingClientRect(); const r = td.getBoundingClientRect(); return r.top >= m.top - 1 && r.bottom <= m.bottom + 1; });
  if (!inView) fail("the focus cell was not scrolled into view");
  await page.keyboard.press("Control+a");
  const lastFocus = await page.evaluate(() => document.querySelector(".sheet td.focus")?.dataset.r);
  if (lastFocus !== String(N - 1)) fail(`select all focuses row ${lastFocus}, expected ${N - 1}`);
  // typing into a far cell commits and shows
  await page.locator(`.sheet td[data-r="${N - 1}"][data-c="0"]`).click();
  await page.keyboard.type("ZZZ");
  await page.keyboard.press("Enter");
  if (!(await page.locator(`.sheet td[data-r="${N - 1}"][data-c="0"]`).textContent()).includes("ZZZ")) fail("typing into the last sheet row did not stick");

  // ---- board: cards arrive in chunks while scrolling
  await tab("board");
  await page.waitForSelector(".board-col");
  const firstCards = await page.locator(".board .card").count();
  if (firstCards >= N) fail(`board drew all ${N} cards at once`);
  await scrollMain(1); await page.waitForTimeout(150); await scrollMain(1); await page.waitForTimeout(150);
  const moreCards = await page.locator(".board .card").count();
  if (moreCards <= firstCards) fail(`board did not draw more cards after scrolling (${firstCards} -> ${moreCards})`);

  await browser.close();
  server.kill();
  if (errs.length) { console.error(errs.slice(0, 8).join("\n")); process.exit(1); }
  console.log("bigdata e2e: ok");
})().catch((e) => { console.error(e); server.kill(); process.exit(1); });
