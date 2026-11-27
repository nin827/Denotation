// Browser test for the Google Drive / OneDrive storage locations, with no real accounts and no network:
// Google's and Microsoft's sign-in pages, the Microsoft token endpoint, Drive v3 and Graph are emulated with
// page.route (fakes in work/test/fixtures/cloud-fakes.js). config.js gets test client IDs, and app.js gets the boot hook
// (handleRedirect) in case it isn't wired in yet.
// usage: node work/test/e2e/cloud.cjs   (needs Playwright + Chromium, dev-only; port 8098)
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../../..");
const PORT = Number(process.env.PORT) || 8098;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const APP = `${ORIGIN}/source/app/`;
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", root], { stdio: "ignore" });

const CORS = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match, If-None-Match", "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "Access-Control-Expose-Headers": "ETag, Retry-After" };

function patchedApp() {
  let src = fs.readFileSync(path.join(root, "source/app/js/app.js"), "utf8");
  if (!src.includes("handleRedirect")) {
    src = src.replace(/^/, 'import { handleRedirect, cloudConfigured } from "./adapters/oauth.js";\n');
    src = src.replace("async function main() {", "async function main() {\n  if ((await handleRedirect()).stop) return;");
    src = src.replace("if (folderSupported() && store.name", "if ((folderSupported() || cloudConfigured()) && store.name");
  }
  return src;
}
function patchedConfig(configured) {
  const src = fs.readFileSync(path.join(root, "source/app/js/config.js"), "utf8");
  if (!configured) return src;
  return src.replace('google: { clientId: "" }', 'google: { clientId: "e2e-google-client.apps.googleusercontent.com" }').replace('microsoft: { clientId: "" }', 'microsoft: { clientId: "ms-client-id-123" }');
}

async function toFulfill(res) {
  const headers = { ...CORS };
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) };
}
async function routeCloud(context, fakes, configured = true) {
  const { drive, graph, identity, events } = fakes;
  await context.route("**/js/config.js", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: patchedConfig(configured) }));
  await context.route("**/js/app.js", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: patchedApp() }));
  // Google's sign-in page: the user agrees -> back to the app with a token in the fragment
  await context.route("https://accounts.google.com/**", (r) => {
    const p = new URL(r.request().url()).searchParams;
    events.push(`google:${p.get("response_type")}:${p.get("prompt") ?? ""}`);
    const back = `${p.get("redirect_uri")}#access_token=gtoken&token_type=Bearer&expires_in=3599&scope=${encodeURIComponent(p.get("scope"))}&state=${p.get("state")}`;
    return r.fulfill({ status: 302, headers: { Location: back } });
  });
  await context.route("https://login.microsoftonline.com/**", async (r) => {
    const req = r.request();
    if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
    const url = req.url();
    if (url.includes("/authorize")) {
      events.push("microsoft:authorize");
      return r.fulfill({ status: 302, headers: { Location: identity.authorize(url) } });
    }
    events.push("microsoft:token");
    return r.fulfill(await toFulfill(await identity.handle(url, { method: req.method(), body: req.postData() })));
  });
  const api = (backend) => async (r) => {
    const req = r.request();
    if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
    const res = await backend.handle(req.url(), { method: req.method(), headers: await req.allHeaders(), body: req.postData() ?? undefined });
    return r.fulfill(await toFulfill(res));
  };
  await context.route("https://www.googleapis.com/**", api(drive));
  await context.route("https://graph.microsoft.com/**", api(graph));
}

(async () => {
  const { fakeDrive, fakeGraph, fakeMsIdentity } = await import("../fixtures/cloud-fakes.js");
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const errs = [];
  const check = (ok, msg) => ok || errs.push(msg);
  try {
    // ---------- not configured ----------
    {
      const context = await browser.newContext();
      await routeCloud(context, { drive: fakeDrive(), graph: fakeGraph(), identity: fakeMsIdentity(), events: [] }, false);
      const page = await context.newPage();
      page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
      await page.goto(APP);
      await page.waitForSelector(".side-item");
      await page.locator(".act-more").click();
      if (await page.locator(".menu-item", { hasText: "Storage" }).count()) {
        await page.locator(".menu-item", { hasText: "Storage" }).click();
        await page.locator(".modal-actions .loc-add").click();
        check(await page.locator(".menu-item", { hasText: "Google Drive: Not configured" }).count(), "unconfigured Google Drive is not shown as such");
        check(await page.locator(".menu-item", { hasText: "OneDrive: Not configured" }).count(), "unconfigured OneDrive is not shown as such");
      } else errs.push("no Storage menu without client IDs (folder picker missing in this browser?)");
      await context.close();
    }
    // ---------- configured: add Google Drive as main and OneDrive as backup ----------
    const graph = fakeGraph({ tokens: [] });
    const fakes = { drive: fakeDrive({ tokens: ["gtoken"] }), graph, identity: fakeMsIdentity({ graph }), events: [] };
    const context = await browser.newContext();
    await routeCloud(context, fakes);
    const page = await context.newPage();
    page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errs.push(`console: ${m.text()}`));
    await page.goto(APP);
    await page.waitForSelector(".side-item");
    const openAdd = async (label) => {
      if (!(await page.locator(".storage-dialog").count())) {
        await page.locator(".act-more").click();
        await page.locator(".menu-item", { hasText: "Storage" }).click();
      }
      await page.locator(".modal-actions .loc-add").click();
      await page.locator(".menu-item", { hasText: label }).click();
      await page.waitForSelector(".cloud-add");
    };
    const toastText = async (re) => (await page.locator(".toast", { hasText: re }).first().textContent({ timeout: 8000 }).catch(() => "")) || "";

    await openAdd("Google Drive as main");
    await page.fill(".cloud-folder", "E2E space");
    const popupP = context.waitForEvent("page");
    await page.locator(".cloud-signin").click();
    const popup = await popupP;
    await popup.waitForEvent("close", { timeout: 8000 }).catch(() => errs.push("Google sign-in popup did not close"));
    check(/Syncing with "Google Drive: E2E space"/.test(await toastText(/Syncing with/)), "no 'Syncing with Google Drive' toast");
    const gtree = fakes.drive.tree("E2E space");
    check(gtree["denotation.json"] && JSON.parse(gtree["denotation.json"]).rev >= 1, "Drive has no stamped denotation.json");
    check(Object.keys(gtree).some((k) => k.startsWith("pages/")), "no pages pushed to Drive");
    check(fakes.events.includes("google:token:select_account"), `Google was not asked for a token response: ${fakes.events}`);

    await openAdd("OneDrive as backup");
    const popup2P = context.waitForEvent("page");
    await page.locator(".cloud-signin").click();
    const popup2 = await popup2P;
    await popup2.waitForEvent("close", { timeout: 8000 }).catch(() => errs.push("OneDrive sign-in popup did not close"));
    check(/Backing up to "OneDrive: Denotation"/.test(await toastText(/Backing up to/)), "no 'Backing up to OneDrive' toast");
    check(fakes.events.includes("microsoft:token"), "the code was not redeemed at the token endpoint");
    await page.waitForTimeout(300);
    check(Object.keys(graph.tree("Denotation")).some((k) => k.startsWith("pages/")), "no pages copied to OneDrive");
    check(await page.locator(".loc-row", { hasText: "Google Drive: E2E space" }).count(), "Google Drive row missing");
    check(await page.locator(".loc-row", { hasText: "OneDrive: Denotation" }).count(), "OneDrive row missing");

    // tokens: IndexedDB only, never localStorage / sessionStorage; the address bar is clean
    const where = await page.evaluate(async () => {
      const ls = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
      const keys = await new Promise((res) => {
        const r = indexedDB.open("denotation");
        r.onsuccess = () => {
          const t = r.result.transaction("handles").objectStore("handles").getAllKeys();
          t.onsuccess = () => res(t.result);
        };
      });
      return { ls, keys, href: location.href };
    });
    check(!/gtoken|mtoken|mrefresh/.test(where.ls), "a token reached localStorage / sessionStorage");
    check(where.keys.filter((k) => /^tok:(google|microsoft):/.test(k)).length === 2, `tokens not in IndexedDB: ${where.keys}`);
    check(!/access_token|code=/.test(where.href), "the OAuth response stayed in the address bar");

    // reload: both locations come back connected from the stored descriptors
    await page.keyboard.press("Escape");
    await page.reload();
    await page.waitForSelector(".side-item");
    await page.waitForTimeout(800);
    await page.locator(".act-more").click();
    await page.locator(".menu-item", { hasText: "Storage" }).click();
    await page.waitForSelector(".storage-dialog");
    check(await page.locator(".loc-row", { hasText: "Connected" }).count() === 2, "locations not connected after reload");

    // remove Google Drive: its token is deleted
    const row = page.locator(".loc-row", { hasText: "Google Drive" });
    await row.locator("button", { hasText: "Remove" }).click();
    await page.locator(".modal-actions button", { hasText: "Remove" }).click();
    await page.waitForTimeout(300);
    const left = await page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open("denotation");
      r.onsuccess = () => {
        const t = r.result.transaction("handles").objectStore("handles").getAllKeys();
        t.onsuccess = () => res(t.result);
      };
    }));
    check(left.filter((k) => k.startsWith("tok:google:")).length === 0, "Google token kept after removing the location");
    check(left.filter((k) => k.startsWith("tok:microsoft:")).length === 1, "OneDrive token lost");

    // a forged response in the URL is dropped and cleaned
    await page.goto("about:blank");
    await page.goto(`${APP}#access_token=forged&token_type=Bearer&state=${"x".repeat(32)}`);
    await page.waitForSelector(".side-item");
    check(!(await page.evaluate(() => location.href)).includes("forged"), "forged token left in the address bar");

    // ---------- PIN lock: the stored sign-in is encrypted, sync waits while locked, PIN off makes it plain ----------
    const handlesDump = () => page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open("denotation");
      r.onsuccess = () => {
        const s = r.result.transaction("handles").objectStore("handles");
        const keys = s.getAllKeys();
        const vals = s.getAll();
        vals.onsuccess = () => res({ keys: keys.result, text: JSON.stringify(vals.result) });
      };
    }));
    const pinDialog = async (cls, fields) => {
      await page.locator(".act-more").click();
      await page.locator(".menu-item", { hasText: "Settings" }).click();
      await page.locator(cls).click();
      if (cls === ".pin-set") await page.locator(".pin-length button", { hasText: "4 digits" }).click();
      for (const [sel, v] of fields) await page.fill(sel, v);
      await page.locator(".pin-go").click();
      await page.waitForFunction(() => document.querySelectorAll(".modal").length === 1, null, { timeout: 15000 });
      await page.keyboard.press("Escape");
      await page.waitForSelector(".modal", { state: "detached" });
    };
    check(/mtoken|mrefresh/.test((await handlesDump()).text), "test setup: the OneDrive token should be plain before a PIN");
    await pinDialog(".pin-set", [[".pin-new", "2468"], [".pin-again", "2468"]]);
    let dump = await handlesDump();
    check(dump.keys.includes("tokvault"), "PIN on: no token key record");
    check(!/mtoken|mrefresh/.test(dump.text) && dump.text.includes("denotation-tok"), "PIN on: the sign-in token is still stored in plain text");
    await page.locator(".act-more").click();
    await page.locator(".menu-item", { hasText: "Lock now" }).click();
    await page.waitForSelector("#lock");
    await page.keyboard.type("2468");
    await page.waitForSelector("#lock", { state: "detached", timeout: 15000 }).catch(() => errs.push("PIN lock: unlock failed"));
    await page.waitForTimeout(800);
    await page.locator(".act-more").click();
    await page.locator(".menu-item", { hasText: "Storage" }).click();
    await page.waitForSelector(".storage-dialog");
    check(await page.locator(".loc-row", { hasText: "Connected" }).count() === 1, "PIN lock: OneDrive not connected after unlock");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".modal", { state: "detached" });
    await pinDialog(".pin-remove", [[".pin-current", "2468"]]);
    dump = await handlesDump();
    check(!dump.keys.includes("tokvault") && /mtoken|mrefresh/.test(dump.text), "PIN off: the token was not stored plain again");
    await context.close();

    // ---------- pop-ups blocked: sign in in this tab (full-page redirect), finished at the next boot ----------
    {
      const f2 = { drive: fakeDrive({ tokens: ["gtoken"] }), graph: fakeGraph(), identity: fakeMsIdentity(), events: [] };
      const ctx2 = await browser.newContext();
      await ctx2.addInitScript(() => {
        window.open = () => null;
      });
      await routeCloud(ctx2, f2);
      const p2 = await ctx2.newPage();
      p2.on("pageerror", (e) => errs.push(`redirect pageerror: ${e.message}`));
      await p2.goto(APP);
      await p2.waitForSelector(".side-item");
      const hashBefore = await p2.evaluate(() => location.hash);
      await p2.locator(".act-more").click();
      await p2.locator(".menu-item", { hasText: "Storage" }).click();
      await p2.locator(".modal-actions .loc-add").click();
      await p2.locator(".menu-item", { hasText: "Google Drive as backup" }).click();
      await p2.locator(".cloud-signin").click();
      await p2.locator(".modal-actions button", { hasText: "Continue" }).click();
      await p2.waitForURL((u) => u.pathname === "/source/app/" && !u.hash.includes("access_token"), { timeout: 8000 }).catch(() => {});
      await p2.waitForSelector(".side-item");
      const added = (await p2.locator(".toast", { hasText: /Added "Google Drive: Denotation"/ }).first().textContent({ timeout: 8000 }).catch(() => "")) || "";
      check(added, "redirect sign-in: no 'Added' toast");
      check((await p2.evaluate(() => location.hash)) === hashBefore, "redirect sign-in: the page's hash was not restored");
      await p2.waitForTimeout(800);
      check(Object.keys(f2.drive.tree("Denotation")).some((k) => k.startsWith("pages/")), "redirect sign-in: no copy in Drive");
      await ctx2.close();
    }
  } catch (e) {
    errs.push(e.stack || String(e));
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(`${errs.length ? "FAIL" : "ok  "} cloud storage (Google Drive + OneDrive, faked)${errs.length ? `\n  ${errs.join("\n  ")}` : ""}`);
  process.exit(errs.length ? 1 : 0);
})();
