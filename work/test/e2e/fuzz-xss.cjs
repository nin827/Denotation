// Browser fuzz: seeds a workspace full of script-injection payloads (titles, blocks, inline tokens, links, embeds,
// wiki syntax, images, callouts, page properties, databases, columns, options, views, rows, constants, statuses,
// terms, graph rules) straight into localStorage, then renders every page, row, the sidebar, quick find, Trash,
// Archive and the graph, and opens every term card. Fails when a payload runs (window.__fuzzXss set, a dialog opens)
// or the DOM gets an on* attribute, a script/iframe/object/embed/base element, a link / source that resolves to
// javascript:, vbscript: or data:text, or an inline style that carries CSS beyond a value (url(), ;, expression).
// Also clicks the rendered links.
//
// usage: node work/test/e2e/fuzz-xss.cjs     PORT (8096-8099, default 8097), FUZZ_SEED, FUZZ_RUNS (workspaces)
// Known bugs are reported as "KNOWN" and don't fail the run (see KNOWN below); FUZZ_STRICT=1 fails on them too and
// on page errors.
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");

const PORT = Number(process.env.PORT) || 8097;
if (PORT < 8096 || PORT > 8099) throw new Error("fuzz-xss: use a port from 8096 to 8099 (8080 is the owner's data)");
const root = path.resolve(__dirname, "../../..");
const STRICT = process.env.FUZZ_STRICT === "1";
// Findings that match a known, reported bug: printed, not fatal (unless FUZZ_STRICT=1).
const KNOWN = [
  { re: /prop-open|prop-ro/, why: "pageProps.safeUrl keeps 'java\\tscript:' / '\\u0001javascript:' URLs (url page properties)" },
  { re: /ichip-term.*style=/, why: "termsUi.hueStyle writes an uncleaned repo.terms hue into style (CSS injection)" }
];

(async () => {
  const { rng, seedFor, XSS, UNICODE, BASE_SEED, RUNS } = await import("../fixtures/fuzz.js");
  const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", root], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const findings = [];
  const known = [];
  const pageErrors = [];
  try {
    for (let run = 0; run < RUNS; run++) {
      const seed = (seedFor("e2e-xss") + run) >>> 0;
      const r = rng(seed);
      const ws = makeWorkspace(r, { XSS, UNICODE });
      const ctx = await browser.newContext();
      // A flag every payload sets; dialogs also count as execution.
      await ctx.addInitScript(() => {
        window.__fuzzXss = 0;
        for (const k of ["alert", "confirm", "prompt", "print"]) window[k] = () => { window.__fuzzXss = `dialog:${k}`; };
      });
      const page = await ctx.newPage();
      const popups = [];
      ctx.on("page", (p) => popups.push(p));
      page.on("pageerror", (e) => pageErrors.push(`[seed ${seed}] ${e.message.slice(0, 160)}${process.env.FUZZ_STACK ? `\n${e.stack}` : ""}`));
      page.on("dialog", (d) => { findings.push(`[seed ${seed}] dialog opened: ${d.type()} ${d.message().slice(0, 60)}`); d.dismiss().catch(() => {}); });
      await page.goto(`http://127.0.0.1:${PORT}/source/app/index.html`);
      await page.waitForSelector(".side-item", { timeout: 15000 });
      await page.evaluate((data) => {
        for (const k of Object.keys(localStorage)) if (/^denotion:(pages|rows|tombstones):/.test(k)) localStorage.removeItem(k);
        for (const p of data.pages) localStorage.setItem(`denotion:pages:${p.id}`, JSON.stringify(p));
        for (const x of data.rows) localStorage.setItem(`denotion:rows:${x.id}`, JSON.stringify(x));
      }, ws);
      await page.reload();
      await page.waitForSelector(".side-item", { timeout: 15000 }).catch(() => pageErrors.push(`[seed ${seed}] sidebar did not render the crafted workspace`));
      const scan = async (where) => {
        const res = await page.evaluate(() => {
          const bad = [];
          const proto = (u) => { try { return new URL(u, location.href).protocol; } catch { return null; } };
          const unsafe = (u) => ["javascript:", "vbscript:"].includes(proto(u)) || /^\s*data:text/i.test(u ?? "");
          for (const el of document.querySelectorAll("*")) {
            for (const a of el.attributes) {
              if (/^on/i.test(a.name)) bad.push(`${el.tagName.toLowerCase()}.${el.className} has ${a.name}`);
              if (["href", "src", "action", "formaction", "xlink:href", "data", "poster", "srcset"].includes(a.name.toLowerCase()) && unsafe(a.value)) bad.push(`${el.tagName.toLowerCase()}.${el.className} ${a.name}=${JSON.stringify(a.value.slice(0, 60))} -> ${proto(a.value)}`);
            }
            const st = el.getAttribute("style");
            if (st && /url\(|expression\(|@import|javascript:|position\s*:\s*fixed/i.test(st)) bad.push(`${el.tagName.toLowerCase()}.${el.className} style=${JSON.stringify(st.slice(0, 80))}`);
            const tag = el.tagName.toLowerCase();
            if (["iframe", "object", "embed", "base", "frame", "applet"].includes(tag)) bad.push(`<${tag}> element in the DOM`);
            if (tag === "script" && !(el.src && new URL(el.src).origin === location.origin)) bad.push(`inline/foreign <script>: ${(el.src || el.textContent).slice(0, 60)}`);
            if (tag === "meta" && /refresh/i.test(el.getAttribute("http-equiv") ?? "")) bad.push("<meta http-equiv=refresh>");
          }
          if (window.__fuzzXss) bad.push(`payload executed: __fuzzXss=${window.__fuzzXss}`);
          return bad;
        });
        for (const b of res) {
          const k = KNOWN.find((x) => x.re.test(b));
          (k && !STRICT ? known : findings).push(`[seed ${seed}] ${where}: ${b}${k ? `  (known: ${k.why})` : ""}`);
        }
      };
      await scan("sidebar");
      const repoId = ws.pages.find((p) => p.type === "repo").id;
      const targets = [...ws.pages.filter((p) => p.type !== "sync").map((p) => `#page-${p.id}`), ...ws.rows.map((x) => `#row-${x.id}`), "#archive", "#trash", "#graph", `#graph-${repoId}`];
      for (const hash of targets) {
        const t0 = Date.now();
        if (process.env.FUZZ_VERBOSE) console.log(`  [seed ${seed}] ${hash}`);
        await page.evaluate((h) => { location.hash = h; }, hash);
        await page.waitForTimeout(hash.startsWith("#graph") ? 600 : 150);
        await scan(hash);
        // Term cards: hover / focus each term chip so its card (definition, category, parent) renders, then scan.
        const chips = page.locator("#main .ichip-term");
        const nChips = await chips.count();
        for (let i = 0; i < Math.min(nChips, 8); i++) {
          await chips.nth(i).focus().catch(() => {});
          await chips.nth(i).hover({ timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(80);
        }
        if (nChips) await scan(`${hash} term cards`);
        const took = Date.now() - t0;
        if (took > 15000) findings.push(`[seed ${seed}] ${hash}: rendering + checks took ${(took / 1000).toFixed(1)} s (hang?)`);
        // Click every link the page rendered (javascript: hrefs run on click even when target=_blank).
        const n = await page.locator("#main a[href]").count();
        for (let i = 0; i < Math.min(n, 40); i++) {
          const a = page.locator("#main a[href]").nth(i);
          const href = await a.getAttribute("href").catch(() => null);
          if (!href || /^#/.test(href) || /^https?:/i.test(href.trim())) continue; // in-app or real web links: not clicked
          await a.click({ timeout: 1000, modifiers: [] }).catch(() => {});
          await page.waitForTimeout(50);
          for (const p of [page, ...popups]) {
            const hit = await p.evaluate(() => window.__fuzzXss).catch(() => 0);
            if (hit) {
              const cls = await a.getAttribute("class").catch(() => "");
              const msg = `${hash}: clicking a.${cls} href=${JSON.stringify(href.slice(0, 60))} ran the payload (${p === page ? "same page" : "popup"})`;
              const k = KNOWN.find((x) => x.re.test(msg));
              (k && !STRICT ? known : findings).push(`[seed ${seed}] ${msg}${k ? `  (known: ${k.why})` : ""}`);
              await p.evaluate(() => { window.__fuzzXss = 0; }).catch(() => {});
            }
          }
          if (page.url().split("#")[0] !== `http://127.0.0.1:${PORT}/source/app/index.html`) {
            findings.push(`[seed ${seed}] ${hash}: clicking ${JSON.stringify(href)} navigated away to ${page.url()}`);
            await page.goto(`http://127.0.0.1:${PORT}/source/app/index.html${hash}`);
          }
        }
      }
      // Quick find with payload queries.
      for (const q of [r.pick(XSS), "<", "script", r.pick(UNICODE)]) {
        await page.keyboard.press("Escape");
        await page.keyboard.press("Control+k");
        if (await page.locator(".qf-input").count()) {
          await page.fill(".qf-input", q);
          await page.waitForTimeout(150);
          await scan(`quick find ${JSON.stringify(q.slice(0, 20))}`);
          await page.keyboard.press("Escape");
        }
      }
      console.log(`  workspace ${run + 1}/${RUNS} (seed ${seed}): ${ws.pages.length} pages, ${ws.rows.length} rows, ${targets.length} routes rendered`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
  for (const k of [...new Set(known)]) console.log(`KNOWN ${k}`);
  for (const e of [...new Set(pageErrors)]) console.log(`PAGE ERROR ${e}`);
  for (const f of [...new Set(findings)]) console.log(`FAIL ${f}`);
  const failed = findings.length > 0 || (STRICT && pageErrors.length > 0);
  console.log(`${failed ? "FAIL" : "ok  "} fuzz-xss: ${findings.length} finding(s), ${new Set(known).size} known, ${new Set(pageErrors).size} page error(s) (FUZZ_SEED=${BASE_SEED}, runs=${RUNS})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

/** A workspace where every user-controlled string is a payload. Ids are valid so the records load. */
function makeWorkspace(r, { XSS, UNICODE }) {
  const now = Date.now();
  const P = () => r.pick(XSS);
  const T = () => (r.chance(0.7) ? P() : r.pick(UNICODE) + P());
  const id = (p) => `${p}${r.id(10).replace(/-/g, "x")}`;
  const pages = [];
  const rows = [];
  const repo = {
    id: id("repo"), type: "repo", title: T(), parentId: null, createdAt: now, updatedAt: now, icon: P(),
    constants: [{ id: id("k"), name: "rate", type: "text", value: P() }, { id: id("k"), name: "bad", type: "number", value: P() }, { id: id("k"), name: "evil", type: "text", value: "1px;background:url(https://example.invalid/b.png)" }],
    statuses: [{ id: id("s"), label: P(), hue: P() }, { id: id("s"), label: P(), hue: 30 }],
    // Raw (uncleaned) terms, as a JSON import or a sync pull would store them.
    terms: [
      { id: "termA", text: T(), definition: P(), category: P(), subcategory: P(), hue: "0;position:fixed;inset:0;background:url(https://example.invalid/x.png)", icon: P() },
      { id: "termB", text: P(), definition: `${P()}\n${P()}`, parentId: "termA", icon: "icon:<img src=x onerror=window.__fuzzXss=1>", hue: 30 },
      { id: "termC", text: P(), icon: r.pick(["😀", "<svg onload=window.__fuzzXss=1>", "icon:star"]), category: "Cat" },
      { id: "termD", text: P(), definition: 5, hue: P() }
    ],
    termCategories: [{ name: "Cat", hue: P(), icon: P() }, { name: P(), icon: "icon:x\" onload=\"window.__fuzzXss=1" }],
    graphRules: [
      { when: { field: "type", op: "is", value: "page" }, icon: P(), color: P(), size: P() },
      { when: [{ prop: P(), op: "contains", value: P() }], icon: "icon:<svg onload=window.__fuzzXss=1>", color: "#fff\" onload=\"x", size: 2 }
    ]
  };
  pages.push(repo);
  const db = {
    id: id("db"), type: "database", title: T(), parentId: repo.id, createdAt: now + 1, updatedAt: now, rowPages: true, icon: P(),
    columns: [
      { id: "cname", name: P(), type: "text", config: {}, display: r.pick(["wrap", "marquee", P()]) },
      { id: "cnum", name: P(), type: "number", config: { format: P() } },
      { id: "csel", name: P(), type: "select", config: { options: [P(), P(), "plain"] } },
      { id: "cdate", name: "When", type: "date", config: {} },
      { id: "cjson", name: P(), type: "json", typeText: P(), config: {} },
      { id: "cf", name: P(), type: "formula", config: { expr: `CONCAT("${P().replace(/"/g, '""')}", [cname])` } }
    ],
    views: ["table", "board", "list", "gallery", "calendar", "chart", "sheet"].map((type) => ({ id: id("v"), name: P(), type, filter: { op: "and", rules: [] }, sorts: [], groupBy: "csel", widths: { cname: P() } })),
    columnGroups: [{ id: id("g"), label: P(), colIds: ["cnum", "csel"] }],
    autoCallouts: [{ id: id("ac"), when: { prop: P(), op: "not empty", value: P() }, preset: P(), text: P() }],
    chipPresets: [{ id: id("cp"), name: P(), colId: "cname" }]
  };
  pages.push(db);
  for (let i = 0; i < 6; i++) {
    rows.push({
      id: id("row"), dbId: db.id, createdAt: now + i, updatedAt: now, icon: P(),
      values: { cname: T(), cnum: r.pick([P(), 5]), csel: r.pick(db.columns[2].config.options), cdate: r.pick([P(), "2024-02-29"]), cjson: r.pick([{ [P()]: P() }, [P()], P()]), cf: P() },
      blocks: [{ id: id("b"), type: "p", text: P() }]
    });
  }
  const inline = () => r.pick([
    () => `{{img:${r.pick(["https://example.invalid/x.png", "data:image/png;base64,AAAA"])}|10|10|${P().replace(/[|}\\\r\n]/g, "")}}}`,
    () => `{{value:${db.id}|${P().replace(/[|}\\\r\n]/g, " ").slice(0, 150)}|cname}}`,
    () => `{{link:${db.id}}} {{page:${repo.id}}} {{status:${repo.statuses[0].id}}} {{const:${repo.constants[0].id}}}`,
    () => `{{= "${P().replace(/[}\\\r\n]/g, "")}"}}`,
    () => `[${P()}](${r.pick(XSS.filter((x) => !/[\s)]/.test(x)))})`,
    () => P()
  ])();
  const linkish = () => {
    const prev = pages.filter((p) => p.type === "doc");
    const tgt = prev.length ? r.pick(prev) : db;
    const head = (tgt.blocks ?? []).find((b) => /^h[1-4]$/.test(b.type));
    return r.pick([
      () => `{{term:${r.pick(["termA", "termB", "termC", "termD", "nope"])}}}`,
      () => `{{link:${tgt.id}}} {{xlink:${tgt.id}}} {{link:missing}}`,
      () => (head ? `{{embed:${tgt.id}|h|${head.id}}}` : `{{embed:${tgt.id}|b|${(tgt.blocks ?? [{ id: "x" }])[0].id}}}`),
      () => `{{embed:${tgt.id}|b|${(tgt.blocks ?? []).slice(0, 3).map((b) => b.id).join(",") || "x"}}}`,
      () => `[[${P().replace(/[[\]{}\n]/g, "")}]] x[[${tgt.title}]] ![[${P()}]]`,
      () => `{{img:https://example.invalid/a.png|${r.pick(["rate", "bad", "320", "1px;x:y", "20em"])}|${r.pick(["", "10rem", "evil"])}|${P().replace(/[|}\\\r\n]/g, "")}}}`
    ])();
  };
  const block = (type) => ({ id: id("b"), type, text: `${T()} ${inline()} ${inline()} ${linkish()}` });
  for (let d = 0; d < 4; d++) {
    const doc = {
      id: id("doc"), type: "doc", title: T(), parentId: d ? pages[pages.length - 1].id : repo.id, createdAt: now + 10 + d, updatedAt: now,
      icon: r.pick([P(), "icon:<img src=x onerror=window.__fuzzXss=1>", "😀"]), cover: r.pick(["__proto__", "constructor", P()]),
      graph: { icon: P(), color: P(), size: P() },
      props: [
        { id: id("pr"), name: P(), type: "url", value: r.pick(XSS.filter((x) => /script|data:/i.test(x))) },
        { id: id("pr"), name: P(), type: "url", value: "java\tscript:window.__fuzzXss=1" },
        { id: id("pr"), name: P(), type: "url", value: "\u0001javascript:window.__fuzzXss=1" },
        { id: id("pr"), name: P(), type: "text", value: P() },
        { id: id("pr"), name: P(), type: "select", value: P(), options: [P()] },
        { id: id("pr"), name: P(), type: "multi", value: [P(), P()], options: [P()] },
        { id: id("pr"), name: P(), type: "page", value: db.id }
      ],
      autoCallouts: [{ id: id("ac"), when: { prop: "x", op: "empty", value: "" }, preset: "info", text: P() }],
      blocks: [
        ...["p", "h1", "h2", "h3", "h4", "bullet", "numbered", "todo", "quote"].map(block),
        { ...block("toggle"), children: [block("p")] },
        { ...block("callout"), icon: P(), preset: P(), custom: { icon: P(), color: P(), bg: P() }, color: P(), bg: P() },
        { id: id("b"), type: "code", lang: P(), text: P() },
        { id: id("b"), type: "table", cells: [[P(), P()], [inline(), P()]], header: true },
        { id: id("b"), type: "image", src: r.pick(["javascript:window.__fuzzXss=1", "data:text/html,<script>parent.__fuzzXss=1</script>", "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9cGFyZW50Ll9fZnV6elhzcz0xPjwvc3ZnPg==", P()]), caption: P() },
        { id: id("b"), type: "bookmark", url: r.pick(["javascript:window.__fuzzXss=1", " javascript:window.__fuzzXss=1", P()]), title: P() },
        { id: id("b"), type: "bookmark", url: `https://example.invalid/"><img src=x onerror=window.__fuzzXss=1>`, title: P() },
        { id: id("b"), type: "page", ref: db.id },
        { id: id("b"), type: "dbview", sourceId: db.id, view: { id: id("v"), name: P(), type: "table" } },
        { id: id("b"), type: "preview", dbId: db.id, keys: [P()], presetId: null, config: { layout: P(), columns: ["cname"] }, snapshot: { title: P() } },
        { id: id("b"), type: "pivot", source: db.id, rowBy: "csel", colBy: null, agg: "count", value: null },
        { id: id("b"), type: "columns", children: [{ id: id("c"), type: "column", children: [block("p")] }, { id: id("c"), type: "column", children: [block("p")] }] },
        { id: id("b"), type: "toc" }, { id: id("b"), type: "breadcrumb" }, { id: id("b"), type: "divider", color: P(), bg: P() },
        { id: id("b"), type: "p", text: `${linkish()} ${linkish()} ${linkish()}` }
      ]
    };
    pages.push(doc);
  }
  pages.push({ ...pages[pages.length - 1], id: id("arch"), title: T(), archivedAt: now, parentId: repo.id });
  pages.push({ ...pages[pages.length - 2], id: id("trash"), title: T(), trashedAt: now, parentId: repo.id });
  pages.push({ ...pages[pages.length - 3], id: id("tmpl"), title: T(), template: true, parentId: repo.id });
  return { pages, rows };
}
