// Math in the real app (Playwright, dev-only): insert an inline chip and a block, edit through the dedicated editor (palette,
// live preview, inline error, Esc saves, Cancel restores, Enter on a chip), reload persistence, local fonts only, 390px phone.
// The files the math change does not own are served patched (work/test/math-patches.cjs); once they carry the patch, they pass untouched.
// usage: PORT=8090 node work/test/e2e/math.cjs      (screenshots go to SHOTS)
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const patches = require("../math-patches.cjs");

const root = path.resolve(__dirname, "../../..");
const PORT = Number(process.env.PORT) || 8090;
if (PORT === 8080) throw new Error("port 8080 is the owner's data");
const SHOTS = process.env.SHOTS || "/tmp/claude-0/-home-user/56cd73f1-f7cb-5b2e-b506-7c0fd43d795e/scratchpad/math";
fs.mkdirSync(SHOTS, { recursive: true });
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", root], { stdio: "ignore" });
const url = `http://127.0.0.1:${PORT}/source/app/index.html`;

async function patchOwned(context) {
  for (const p of patches) {
    await context.route(`**/source/app/${p.file}`, async (route) => {
      let text = fs.readFileSync(path.join(root, "source/app", p.file), "utf8");
      if (!text.includes(p.marker)) for (const [from, to] of p.edits) text = text.replace(from, () => to);
      await route.fulfill({ body: text, contentType: "text/javascript" });
    });
  }
}

async function run(browser, { phone = false } = {}) {
  const fails = [];
  const tag = phone ? "-phone" : "";
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" } : { viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  await patchOwned(ctx);
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errs = [];
  const external = [];
  const fonts = [];
  const KNOWN = /reading 'waiting'/; // the PWA code expects a service worker, which this test blocks so it can serve patched copies
  page.on("pageerror", (e) => !KNOWN.test(e.message) && errs.push(e.message));
  page.on("console", (m) => m.type() === "error" && !KNOWN.test(m.text()) && errs.push(m.text()));
  page.on("request", (r) => { if (!r.url().startsWith(`http://127.0.0.1:${PORT}/`) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) external.push(r.url()); });
  page.on("response", (r) => { if (/\.woff2?$/.test(r.url())) fonts.push([r.url(), r.status()]); });
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}${tag}.png`) });
  const check = async (label, fn) => {
    try {
      if ((await fn()) === false) fails.push(label);
    } catch (e) {
      fails.push(`${label}: ${String(e.message || e).split("\n").slice(0, process.env.VERBOSE ? 14 : 1).join(" / ")}`);
    }
  };
  const openSide = async () => {
    if (await page.locator("#side-open").isVisible().catch(() => false)) await page.locator("#side-open").click();
  };
  const blurEditor = async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(600);
  };
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const editor = page.locator(".math-ed");
  const ta = () => page.locator(".math-ed .math-ta");
  const setSource = async (s) => {
    await ta().fill(s);
    await page.waitForTimeout(350);
  };
  const openPalette = async () => {
    if (!(await page.locator(".math-pal-wrap").evaluate((d) => d.open))) await page.locator(".math-pal-wrap > summary").click();
  };
  const dismissToasts = () => page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
  const blockText = () => page.evaluate(() => [...document.querySelectorAll("textarea.blk-ta")].map((t) => t.value));

  await page.goto(url);
  await page.waitForSelector(".side-item", { state: "attached" });
  await openSide();
  await page.locator(".side-item:not(.repo)").first().click();
  await page.waitForSelector(".doc-tail");
  await dismissToasts();

  // ----- inline chip -----
  await check("/Inline math opens the editor, a source inserts a chip", async () => {
    await page.locator(".doc-tail").click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("blk-ta"));
    await page.keyboard.type("area is /inline math");
    await page.locator(".menu .menu-item", { hasText: "Inline math" }).first().click();
    await editor.waitFor();
    await setSource("\\frac{a|b}{c}");
    if ((await page.locator(".math-ed .math-preview .katex").count()) !== 1) return false;
    await page.locator(".modal-actions button", { hasText: "Done" }).click();
    await blurEditor();
    await page.waitForSelector(".rendered .ichip-math .katex");
    return (await blockText()).some((t) => t.includes("{{math:\\\\frac{a\\|b\\}{c\\}}}"));
  });
  await shot("inline");
  await check("the chip has the LaTeX as its text alternative", async () => (await page.locator(".ichip-math").first().getAttribute("aria-label")) === "Math: \\frac{a|b}{c}");
  await check("Esc saves an edit (palette inserts, preview updates)", async () => {
    await page.locator(".rendered .ichip-math").first().click();
    await editor.waitFor();
    if ((await ta().inputValue()) !== "\\frac{a|b}{c}") return false;
    await ta().fill("");
    await openPalette();
    await page.locator('.math-pal-btn[title="Square root"]').click();
    await page.keyboard.type("x+1");
    await page.waitForTimeout(350);
    if ((await ta().inputValue()) !== "\\sqrt{x+1}") return false;
    await page.keyboard.press("Escape");
    await editor.waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    return (await page.locator(".ichip-math").first().getAttribute("aria-label")) === "Math: \\sqrt{x+1}" && (await blockText()).some((t) => t.includes("{{math:\\\\sqrt{x+1\\}}}"));
  });
  await check("Cancel restores the source", async () => {
    await page.locator(".rendered .ichip-math").first().click();
    await editor.waitFor();
    await setSource("z^9");
    await page.locator(".modal-actions button", { hasText: "Cancel" }).click();
    await editor.waitFor({ state: "detached" });
    return (await page.locator(".ichip-math").first().getAttribute("aria-label")) === "Math: \\sqrt{x+1}";
  });
  await check("a click outside saves", async () => {
    await page.locator(".rendered .ichip-math").first().click();
    await editor.waitFor();
    await setSource("y^2");
    await page.mouse.click(3, 3);
    await editor.waitFor({ state: "detached" });
    return (await page.locator(".ichip-math").first().getAttribute("aria-label")) === "Math: y^2";
  });
  await check("Enter on a focused chip opens the editor; bad LaTeX shows an inline error and an error chip", async () => {
    await page.locator(".rendered .ichip-math").first().focus();
    await page.keyboard.press("Enter");
    await editor.waitFor();
    await setSource("\\frac{a");
    const err = await page.locator(".math-error").innerText();
    if (!/LaTeX error/.test(err) || (await page.locator(".math-error .icon-svg").count()) !== 1) return false;
    await shot("error-editor");
    await page.locator(".modal-actions button", { hasText: "Done" }).click();
    await editor.waitFor({ state: "detached" });
    const chip = page.locator(".ichip-math .ichip-math-err").first();
    await chip.waitFor();
    return /Math error/.test(await chip.innerText()) && (await chip.locator(".icon-svg").count()) === 1;
  });
  await shot("error-chip");
  await check("an emptied source removes the chip", async () => {
    await page.locator(".rendered .ichip-math").first().click();
    await editor.waitFor();
    await setSource("");
    await page.keyboard.press("Escape");
    await editor.waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    return (await page.locator(".ichip-math").count()) === 0;
  });

  // ----- block -----
  await check("/Math block inserts an empty block, clicking it opens the editor", async () => {
    await page.locator(".doc-tail").click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("blk-ta"));
    await page.keyboard.type("/math block");
    await page.locator(".menu .menu-item", { hasText: "Math block" }).first().click();
    await page.waitForSelector(".math-block .is-empty");
    await page.locator(".math-block .is-empty").click();
    await editor.waitFor();
    await setSource("\\int_0^1 x\\,dx = \\tfrac12");
    await openPalette();
    await page.locator('.math-pal-btn[title="alpha"]').click();
    await page.waitForTimeout(350);
    await page.locator(".modal-actions button", { hasText: "Done" }).click();
    await page.waitForSelector(".math-block .katex-display");
    return true;
  });
  await shot("block");
  await check("the block menu has Edit equation and Copy LaTeX", async () => {
    await page.locator(".math-block").first().click({ button: "right" });
    await page.waitForSelector(".menu");
    const labels = await page.locator(".menu .menu-item").allInnerTexts();
    await page.keyboard.press("Escape");
    return labels.some((l) => /Edit equation/.test(l)) && labels.some((l) => /Copy LaTeX/.test(l));
  });
  await check("the equation survives a reload and is lazy-loaded from vendor", async () => {
    await page.waitForTimeout(900);
    await page.reload();
    await page.waitForSelector(".math-block .katex-display");
    return (await page.locator(".math-block .katex-display").count()) === 1;
  });
  await check("no horizontal page scroll", noHScroll);
  await check("a long equation scrolls inside its block, not the page", async () => {
    await page.locator(".math-block-btn").first().click();
    await editor.waitFor();
    await setSource("a_1+a_2+a_3+a_4+a_5+a_6+a_7+a_8+a_9+a_10+a_11+a_12+a_13+a_14+a_15+a_16+a_17+a_18+a_19+a_20+a_21+a_22+a_23+a_24+a_25+a_26");
    if (!(await noHScroll())) return false;
    await shot("editor-long");
    await page.locator(".modal-actions button", { hasText: "Done" }).click();
    await page.waitForSelector(".math-block .katex-display");
    return noHScroll();
  });
  if (!phone) await check("desktop: the editor is a popover next to the block, Esc saves, Cancel restores", async () => {
    const blk = page.locator(".math-block-btn").first();
    const bb = await blk.boundingBox();
    await blk.click();
    await editor.waitFor();
    await page.waitForTimeout(300);
    const ed = await page.locator(".aed").boundingBox();
    const role = await page.locator(".aed").getAttribute("role");
    const near = Math.abs(ed.y - (bb.y + bb.height)) < 24 || Math.abs(ed.y + ed.height - bb.y) < 24;
    await shot("popover");
    const ok = near && role === "dialog" && (await noHScroll()) && (await page.locator(".modal-overlay").count()) === 0;
    await page.keyboard.press("Escape");
    await page.waitForSelector(".aed", { state: "detached" });
    return ok;
  });
  if (phone) await check("the editor is a bottom sheet on phones", async () => {
    await page.locator(".math-block-btn").first().click();
    await editor.waitFor();
    await page.waitForTimeout(400);
    const r = await page.locator(".modal:has(.math-ed)").boundingBox();
    const ok = r.y + r.height >= 840 && r.width >= 389 && (await noHScroll());
    await shot("sheet");
    await page.keyboard.press("Escape");
    return ok;
  });
  await check("fonts come from vendor/katex, nothing external was requested", async () => {
    if (external.length) throw new Error(`external requests: ${external.slice(0, 3).join(", ")}`);
    return fonts.length > 0 && fonts.every(([u, s]) => /\/vendor\/katex\/fonts\//.test(u) && s === 200);
  });
  await check("KaTeX fonts are applied", async () => page.evaluate(async () => { await document.fonts.ready; return document.fonts.check("1em KaTeX_Main"); }));
  await check("no console errors", async () => { if (errs.length) throw new Error(errs.slice(0, 3).join(" | ")); });
  await ctx.close();
  return fails;
}

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  let bad = 0;
  for (const phone of process.env.ONLY === "phone" ? [true] : process.env.ONLY === "desktop" ? [false] : [false, true]) {
    const fails = await run(browser, { phone });
    console.log(`${phone ? "phone" : "desktop"}: ${fails.length ? "FAIL" : "ok"}`);
    for (const f of fails) console.log("  -", f);
    bad += fails.length;
  }
  await browser.close();
  server.kill();
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); server.kill(); process.exit(1); });
