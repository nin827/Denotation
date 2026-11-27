// Content-Security-Policy check for the Playwright tests.
//   In a test:   const { watchCsp } = require("./csp-watch.cjs"); await watchCsp(context);   // or a page
//                Every violation is logged to the page console as an error starting with "[csp]", so a test that
//                fails on console errors fails on it too.
//   Any test:    node -r ./work/test/e2e/csp-watch.cjs work/test/e2e/links.cjs
//                Preloaded, it watches every browser context the test opens and makes the run exit 1 when a
//                violation happened (it prints them at exit).
const VIOLATION = "[csp]";
const seen = [];
const INIT = `document.addEventListener("securitypolicyviolation", (e) => {
  console.error(${JSON.stringify(VIOLATION)} + " " + e.effectiveDirective + " blocked " + (e.blockedURI || "inline") + " at " + (e.sourceFile || "") + ":" + (e.lineNumber || 0));
});`;
const isViolation = (text) => text.startsWith(VIOLATION) || /Content Security Policy/i.test(text);

/** Watch a BrowserContext or Page; violations go to the console and to `sink` (default: the run's list). */
async function watchCsp(target, sink = seen) {
  await target.addInitScript(INIT);
  const onPage = (page) => page.on("console", (m) => {
    if (m.type() === "error" && isViolation(m.text())) sink.push(`${page.url()}: ${m.text()}`);
  });
  if (typeof target.pages === "function") {
    target.pages().forEach(onPage);
    target.on("page", onPage);
  } else onPage(target);
  return sink;
}

// Preloaded with -r: wrap chromium.launch so every context (and browser.newPage) is watched.
if (process.execArgv.some((a) => /csp-watch\.cjs$/.test(a))) {
  let pw = null;
  try {
    pw = require("playwright");
  } catch {
    pw = null;
  }
  if (pw && !pw.chromium.__cspWatched) {
    const launch = pw.chromium.launch.bind(pw.chromium);
    pw.chromium.__cspWatched = true;
    pw.chromium.launch = async (...args) => {
      const browser = await launch(...args);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...a) => {
        const ctx = await newContext(...a);
        await watchCsp(ctx);
        return ctx;
      };
      browser.newPage = async (...a) => (await browser.newContext(...a)).newPage();
      return browser;
    };
    process.on("exit", (code) => {
      if (seen.length) {
        console.error(`CSP: ${seen.length} violation(s)\n  ${[...new Set(seen)].join("\n  ")}`);
        process.exitCode = 1;
        if (!code) process.exit(1);
      } else console.log("CSP: no violations");
    });
  }
}

module.exports = { watchCsp, isViolation, seen };
