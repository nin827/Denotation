// The Content-Security-Policy <meta> of the app page and of the root redirect page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
/** The policy of the page's CSP <meta> as { directive: [sources] }, plus where the meta sits. */
function policyOf(html) {
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*>/i);
  assert.ok(m, "a Content-Security-Policy <meta> exists");
  const out = {};
  for (const part of m[1].split(";")) {
    const [name, ...src] = part.trim().split(/\s+/);
    if (!name) continue;
    assert.equal(out[name], undefined, `${name} appears once`);
    out[name] = src;
  }
  return { policy: out, at: m.index };
}

test("app page: the CSP meta comes first and forbids inline and eval'd script", () => {
  const html = read("source/app/index.html");
  const { policy, at } = policyOf(html);
  for (const tag of ["<link", "<script", "<style"]) {
    const i = html.indexOf(tag);
    if (i >= 0) assert.ok(at < i, `the CSP meta comes before the first ${tag}`);
  }
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), "no inline <script> in index.html");
  assert.ok(!/\son[a-z]+=/i.test(html), "no inline event handlers in index.html");
  const all = Object.values(policy).flat();
  assert.ok(!all.includes("'unsafe-eval'") && !all.includes("'wasm-unsafe-eval'"), "no 'unsafe-eval' anywhere");
  assert.deepEqual(policy["script-src"], ["'self'"], "scripts: same origin files only");
  assert.deepEqual(policy["default-src"], ["'self'"]);
  assert.deepEqual(policy["object-src"], ["'none'"]);
  assert.deepEqual(policy["base-uri"], ["'none'"]);
  assert.deepEqual(policy["style-src-elem"], ["'self'"], "no inline <style> elements");
  assert.ok(policy["worker-src"]?.includes("'self'"), "service worker and layout worker");
  for (const d of ["frame-ancestors", "report-uri", "sandbox"]) assert.equal(policy[d], undefined, `${d} is ignored in a <meta>`);
  for (const d of Object.keys(policy)) assert.ok(!policy[d].includes("*") && !policy[d].includes("http:"), `${d}: no wildcard or plain http`);
});

test("app page: every cloud host the code talks to is allowed (and only https)", () => {
  const { policy } = policyOf(read("source/app/index.html"));
  const dir = path.join(root, "source/app/js/adapters");
  const hosts = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    for (const m of readFileSync(path.join(dir, f), "utf8").matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.add(m[1].toLowerCase());
  }
  assert.ok(hosts.size >= 4, "found the cloud hosts");
  const allowed = [...(policy["connect-src"] ?? []), ...(policy["frame-src"] ?? [])];
  for (const h of hosts) assert.ok(allowed.includes(`https://${h}`), `${h} is in connect-src or frame-src`);
  for (const s of policy["connect-src"]) assert.ok(s === "'self'" || s.startsWith("https://"), `connect-src ${s}`);
});

test("root redirect page: nothing but its own style (by hash) and the icon", () => {
  const html = read("index.html");
  const { policy, at } = policyOf(html);
  assert.ok(at < html.indexOf("<style"), "the CSP meta comes before the style");
  assert.deepEqual(policy["default-src"], ["'none'"]);
  assert.equal(policy["script-src"], undefined, "no scripts (default-src 'none')");
  assert.ok(!/<script/i.test(html), "no scripts at all");
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const hash = `'sha256-${createHash("sha256").update(style).digest("base64")}'`;
  assert.deepEqual(policy["style-src"], [hash], "style-src carries the hash of the <style> block (update it when the style changes)");
  assert.ok(/http-equiv="refresh" content="0; url=source\/app\/"/.test(html), "still forwards to the app");
});
