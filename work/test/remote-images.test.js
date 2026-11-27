import test from "node:test";
import assert from "node:assert/strict";
import { remoteImageUrl, deferImage, imageHost, safeSrc } from "../../source/app/js/ui/imageUtil.js";
import { sanitizePrefs, sanitizeRemoteImages, DEFAULTS, REMOTE_IMAGES } from "../../source/app/js/prefs.js";

const ORIGIN = "https://me.github.io";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

test("prefs.remoteImages: auto by default, only known values kept", () => {
  assert.equal(DEFAULTS.remoteImages, "auto");
  assert.deepEqual(REMOTE_IMAGES, ["auto", "click"]);
  assert.equal(sanitizePrefs(null).remoteImages, "auto");
  assert.equal(sanitizePrefs({ remoteImages: "click" }).remoteImages, "click");
  for (const bad of ["CLICK", "never", 1, null, {}, ["click"], "__proto__"]) assert.equal(sanitizeRemoteImages(bad), "auto");
});

test("deferImage: only other sites' http(s) pictures wait, and only in click mode", () => {
  const cases = [
    ["https://example.com/a.png", true],
    ["http://example.com/a.png", true],
    ["HTTPS://Example.com/a.png", true],
    ["https://cdn.me.github.io/x.png", true], // a subdomain is another origin
    ["https://me.github.io/denotation/icons/icon.svg", false], // same origin
    [PNG, false],
    ["blob:https://me.github.io/1234", false],
    ["icons/icon.svg", false],
    ["//example.com/a.png", false],
    ["javascript:alert(1)", false],
    ["https://", false],
    ["", false],
    [null, false],
    [42, false]
  ];
  for (const [src, want] of cases) {
    assert.equal(deferImage(src, "click", ORIGIN), want, String(src));
    assert.equal(deferImage(src, "auto", ORIGIN), false, String(src));
    assert.equal(deferImage(src, undefined, ORIGIN), false, String(src));
  }
});

test("imageHost and remoteImageUrl", () => {
  assert.equal(imageHost("https://img.example.org:8443/p.png?x=1", ORIGIN), "img.example.org");
  assert.equal(imageHost(PNG, ORIGIN), "");
  assert.equal(imageHost("https://me.github.io/a.png", ORIGIN), "");
  assert.equal(remoteImageUrl("https://example.com/a.png#x", ORIGIN).href, "https://example.com/a.png#x");
  assert.equal(remoteImageUrl(" https://example.com/a.png", ORIGIN), null); // never rendered (safeSrc), never decided
  // With no known page origin every http(s) picture counts as remote.
  assert.equal(deferImage("https://me.github.io/a.png", "click", ""), true);
});

test("every remote picture safeSrc accepts is decided (seeded)", () => {
  let seed = 20261127;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const parts = ["https://", "http://", "data:image/png;", "blob:", "ftp://", "me.github.io", "example.com", "/", "a.png", "%00", " ", "@", ":", "#", "?"];
  for (let i = 0; i < 2000; i++) {
    let s = "";
    for (let n = 1 + Math.floor(rnd() * 5); n > 0; n--) s += parts[Math.floor(rnd() * parts.length)];
    const d = deferImage(s, "click", ORIGIN);
    assert.equal(typeof d, "boolean");
    if (d) assert.ok(safeSrc(s) && /^https?:/i.test(s), s); // only http(s) ever waits
    if (/^data:|^blob:/i.test(s)) assert.equal(d, false, s);
  }
});
