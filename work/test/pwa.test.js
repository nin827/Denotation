import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { collect, PUBLIC, render } from "../tools/gen-sw-files.mjs";
import { png } from "../tools/make-icons.mjs";
import { installMode, isIOS, isStandalone } from "../../source/app/js/pwa.js";

const read = (f) => readFileSync(path.join(PUBLIC, f), "utf8");
const swFiles = () => {
  const ctx = { self: {} };
  vm.runInNewContext(read("sw-files.js"), ctx);
  return ctx.self;
};

test("sw-files.js lists only files that exist, with no duplicates", () => {
  const { APP_FILES, APP_VERSION } = swFiles();
  assert.match(APP_VERSION, /^[0-9a-f]{12}$/);
  assert.equal(new Set(APP_FILES).size, APP_FILES.length);
  for (const f of APP_FILES) {
    assert.ok(!f.startsWith("/") && !f.includes(".."), `${f} must be a relative path`);
    assert.ok(existsSync(path.join(PUBLIC, f)), `${f} is listed but missing`);
  }
});
test("sw-files.js covers every shell file (run: node work/tools/gen-sw-files.mjs)", () => {
  const listed = new Set(swFiles().APP_FILES);
  const missing = collect().filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], "files under source/app/ missing from sw-files.js; run node work/tools/gen-sw-files.mjs");
});
test("every module app.js reaches (static and dynamic imports) is precached", () => {
  const listed = new Set(swFiles().APP_FILES);
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    assert.ok(existsSync(path.join(PUBLIC, file)), `${file} is imported but missing`);
    const src = read(file);
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm)) visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])));
  };
  visit("js/app.js");
  assert.ok(seen.size > 30);
  for (const f of seen) assert.ok(listed.has(f), `${f} is loaded by the app but not in sw-files.js`);
});
test("the shell also holds index.html, the manifest, icons, stylesheets and fonts", () => {
  const listed = new Set(swFiles().APP_FILES);
  for (const f of ["index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/icon.svg", "css/style.css"]) assert.ok(listed.has(f), f);
  assert.ok([...listed].some((f) => /^fonts\/.*\.woff2$/.test(f)));
  assert.ok(!listed.has("sw.js") && !listed.has("sw-files.js"));
});
test("render() is deterministic and embeds the file list", () => {
  assert.equal(render(["index.html"]), render(["index.html"]));
  assert.match(render(["index.html"]), /"index\.html"/);
});
test("the index.html css files and manifest/icon links are precached and relative", () => {
  const html = read("index.html");
  const listed = new Set(swFiles().APP_FILES);
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    assert.ok(!m[1].startsWith("/") && !/^https?:/.test(m[1]), `${m[1]} must be relative`);
    assert.ok(listed.has(m[1]), `${m[1]} not precached`);
  }
});
test("manifest is valid and relative", () => {
  const m = JSON.parse(read("manifest.webmanifest"));
  assert.equal(m.name, "Denotation");
  assert.equal(m.short_name, "Denotation");
  assert.equal(m.start_url, "./");
  assert.equal(m.scope, "./");
  assert.equal(m.display, "standalone");
  for (const k of ["background_color", "theme_color"]) assert.match(m[k], /^#[0-9a-f]{6}$/i);
  const purposes = new Set(m.icons.map((i) => i.purpose));
  assert.ok(purposes.has("any") && purposes.has("maskable"));
  assert.ok(m.icons.some((i) => i.sizes === "192x192") && m.icons.some((i) => i.sizes === "512x512"));
  for (const i of m.icons) assert.ok(existsSync(path.join(PUBLIC, i.src)) && !i.src.startsWith("/"), i.src);
});
test("icons are real PNGs of the stated size", () => {
  for (const [f, size] of [["icons/icon-192.png", 192], ["icons/icon-512.png", 512], ["icons/icon-maskable-512.png", 512], ["icons/apple-touch-icon.png", 180]]) {
    const b = readFileSync(path.join(PUBLIC, f));
    assert.equal(b.subarray(1, 4).toString(), "PNG");
    assert.equal(b.readUInt32BE(16), size);
    assert.equal(b.readUInt32BE(20), size);
  }
  assert.equal(png(2, () => [1, 2, 3]).readUInt32BE(16), 2);
});
test("sw.js: relative, versioned, never touches cross-origin or non-GET, cleans old caches", () => {
  const sw = read("sw.js");
  assert.match(sw, /importScripts\("sw-files\.js"\)/);
  assert.match(sw, /APP_VERSION/);
  assert.match(sw, /url\.origin !== self\.location\.origin\) return/);
  assert.match(sw, /req\.method !== "GET"\) return/);
  assert.match(sw, /caches\.delete/);
  assert.ok(!/skipWaiting\(\)\s*;?\s*\n\s*\}\)\s*;?\s*self\.addEventListener\("activate"/.test(sw));
  assert.ok(!/["'`]\/[a-z]/i.test(sw.replace(/\/\/.*$/gm, "").replace(/\/[^/\n]+\/[gimsuy]*/g, "")), "no leading-slash paths");
});
test("install mode", () => {
  assert.equal(installMode({ standalone: true, hasPrompt: true }), "installed");
  assert.equal(installMode({ hasPrompt: true }), "prompt");
  assert.equal(installMode({ iOS: true }), "ios");
  assert.equal(installMode({}), "none");
  assert.equal(installMode(), "none");
});
test("platform sniffing", () => {
  assert.equal(isIOS({ navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } }), true);
  assert.equal(isIOS({ navigator: { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 } }), true);
  assert.equal(isIOS({ navigator: { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 0 } }), false);
  assert.equal(isStandalone({ matchMedia: () => ({ matches: true }), navigator: {} }), true);
  assert.equal(isStandalone({ matchMedia: () => ({ matches: false }), navigator: { standalone: true } }), true);
  assert.equal(isStandalone({ navigator: {} }), false);
});
