import test from "node:test";
import assert from "node:assert/strict";
import { sanitizePrefs, sanitizeAccent, resolveAccent, accentTokens, effectiveDark, tokens, ACCENT_HUES, PRESETS, DEFAULTS } from "../public/js/prefs.js";

test("24 hues in 15 degree steps", () => {
  assert.equal(ACCENT_HUES.length, 24);
  assert.deepEqual([ACCENT_HUES[0], ACCENT_HUES[1], ACCENT_HUES[23]], [0, 15, 345]);
});

test("sanitize accent", () => {
  assert.equal(DEFAULTS.accent, "random");
  assert.equal(sanitizePrefs(null).accent, "random");
  assert.equal(sanitizePrefs({ accent: "#2a6fdb" }).accent, "random");
  assert.equal(sanitizePrefs({ accent: "" }).accent, "random");
  assert.equal(sanitizePrefs({ accent: "random" }).accent, "random");
  assert.equal(sanitizePrefs({ accent: 210 }).accent, 210);
  assert.equal(sanitizePrefs({ accent: 0 }).accent, 0);
  assert.equal(sanitizePrefs({ accent: "345" }).accent, 345);
  assert.equal(sanitizePrefs({ accent: 7 }).accent, "random");
  assert.equal(sanitizePrefs({ accent: 360 }).accent, "random");
  assert.equal(sanitizePrefs({ accent: -15 }).accent, "random");
  assert.equal(sanitizePrefs({ accent: "grey" }).accent, "grey");
  assert.equal(sanitizeAccent(NaN), "random");
});

test("random never yields grey and is always a listed hue", () => {
  for (let i = 0; i < 2000; i++) {
    const v = resolveAccent("random");
    assert.ok(ACCENT_HUES.includes(v), String(v));
  }
  for (const r of [0, 0.999999, 1, -1, 0.5]) assert.ok(ACCENT_HUES.includes(resolveAccent("random", () => r)));
  assert.equal(resolveAccent("random", () => 0), 0);
  assert.equal(resolveAccent("random", () => 0.5), 180);
});

test("explicit choices resolve to themselves", () => {
  assert.equal(resolveAccent("grey"), "grey");
  assert.equal(resolveAccent(120, () => 0), 120);
});

test("presets do not set accent", () => {
  for (const p of PRESETS) assert.ok(!("accent" in p));
});

test("accent tokens follow light and dark", () => {
  assert.equal(accentTokens(210, false)["--accent"], "oklch(0.50 0.16 210)");
  assert.equal(accentTokens(210, true)["--accent"], "oklch(0.72 0.16 210)");
  assert.equal(accentTokens("grey", false)["--accent"], "oklch(0.35 0 0)");
  assert.equal(accentTokens("grey", true)["--accent"], "oklch(0.85 0 0)");
  assert.equal(accentTokens("grey", false)["--on-accent"], "#ffffff");
  assert.equal(accentTokens("grey", true)["--on-accent"], "#16150f");
});

test("effective dark", () => {
  assert.equal(effectiveDark({ bg: "" }, {}), false);
  assert.equal(effectiveDark({ bg: "" }, { prefersDark: true }), true);
  assert.equal(effectiveDark({ bg: "" }, { theme: "light", prefersDark: true }), false);
  assert.equal(effectiveDark({ bg: "" }, { theme: "dark" }), true);
  assert.equal(effectiveDark({ bg: "#000000" }, { theme: "light" }), true);
  assert.equal(effectiveDark({ bg: "#ffffff" }, { theme: "dark" }), false);
});

test("tokens: explicit accent only with custom bg", () => {
  const plain = tokens(sanitizePrefs({}), 90, {});
  assert.equal(plain["--accent-h"], "90");
  assert.ok(!("--accent" in plain));
  const dark = tokens(sanitizePrefs({ bg: "#000000" }), 90, {});
  assert.equal(dark["--accent"], "oklch(0.72 0.16 90)");
  assert.equal(dark["color-scheme"], "dark");
  const grey = tokens(sanitizePrefs({}), "grey", {});
  assert.equal(grey["--accent-c"], "0");
});
