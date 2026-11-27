import test from "node:test";
import assert from "node:assert/strict";
import { sanitizePrefs, sanitizeAccent, resolveAccent, accentTokens, resolveMode, isDarkMode, tokens, fontSpec, FONTS, MODES, ACCENT_HUES, DEFAULTS } from "../../source/app/js/prefs.js";

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

test("accent tokens follow light and dark", () => {
  assert.equal(accentTokens(210, false)["--accent"], "oklch(0.50 0.16 210)");
  assert.equal(accentTokens(210, true)["--accent"], "oklch(0.72 0.16 210)");
  assert.equal(accentTokens("grey", false)["--accent"], "oklch(0.35 0 0)");
  assert.equal(accentTokens("grey", true)["--accent"], "oklch(0.85 0 0)");
  assert.equal(accentTokens("grey", false)["--on-accent"], "#ffffff");
  assert.equal(accentTokens("grey", true)["--on-accent"], "#16150f");
});

test("mode sanitize and default", () => {
  assert.equal(DEFAULTS.mode, "neutral");
  assert.deepEqual(MODES, ["neutral", "light", "dark", "variable"]);
  assert.equal(sanitizePrefs(null).mode, "neutral");
  for (const m of MODES) assert.equal(sanitizePrefs({ mode: m }).mode, m);
  for (const bad of ["Dark", "sepia", "", 3, null, {}]) assert.equal(sanitizePrefs({ mode: bad }).mode, "neutral");
});

test("old bg, text and preset prefs are dropped", () => {
  const p = sanitizePrefs({ bg: "#000000", text: "#ffffff", preset: "sepia", mode: "dark" });
  assert.ok(!("bg" in p) && !("text" in p) && !("preset" in p));
  assert.equal(p.mode, "dark");
});

test("variable mode resolves by local time", () => {
  const at = (h, m = 0) => new Date(2026, 0, 15, h, m);
  assert.equal(resolveMode("variable", at(6, 59)), "dark");
  assert.equal(resolveMode("variable", at(7, 0)), "light");
  assert.equal(resolveMode("variable", at(12)), "light");
  assert.equal(resolveMode("variable", at(18, 59)), "light");
  assert.equal(resolveMode("variable", at(19, 0)), "dark");
  assert.equal(resolveMode("variable", at(0)), "dark");
  for (const m of ["neutral", "light", "dark"]) assert.equal(resolveMode(m, at(3)), m);
  assert.equal(resolveMode("junk", at(3)), "neutral");
});

test("only dark uses the dark accent", () => {
  assert.equal(isDarkMode("dark"), true);
  assert.equal(isDarkMode("light"), false);
  assert.equal(isDarkMode("neutral"), false);
});

test("font sanitize", () => {
  assert.equal(DEFAULTS.font, "system");
  for (const id of ["system", "serif", "mono", "noto-sans", "noto-serif", "noto-mono"]) assert.equal(sanitizePrefs({ font: id }).font, id);
  for (const id of ["inter", "lora", "jetbrains-mono", "nope", "", 5]) assert.equal(sanitizePrefs({ font: id }).font, "system");
  assert.ok(!FONTS.some((f) => f.google));
  const loc = sanitizePrefs({ font: "local", customFont: "  Fira Code " });
  assert.equal(loc.font, "local");
  assert.equal(loc.customFont, "Fira Code");
  assert.equal(sanitizePrefs({ font: "local", customFont: "" }).font, "system");
  assert.equal(sanitizePrefs({ font: "local", customFont: 'x"; } body{' }).font, "system");
  assert.equal(sanitizePrefs({ font: "local", customFont: "a".repeat(41) }).font, "system");
  assert.equal(sanitizePrefs({ font: "custom", customFont: "Quicksand" }).font, "local");
  assert.equal(sanitizePrefs({ font: "noto-sans", customFont: "bad;" }).customFont, "");
});

test("font spec", () => {
  assert.match(fontSpec({ font: "noto-serif" }).stack, /^"Noto Serif"/);
  assert.equal(fontSpec({ font: "noto-sans" }).mono, null);
  assert.match(fontSpec({ font: "noto-mono" }).mono, /^"Noto Sans Mono"/);
  assert.match(fontSpec({ font: "local", customFont: "Fira Code" }).stack, /^"Fira Code"/);
});

test("tokens carry only the accent hue and chroma", () => {
  for (const mode of MODES) {
    const t = tokens(sanitizePrefs({ mode }), 90);
    assert.deepEqual(t, { "--accent-h": "90", "--accent-c": "0.16" });
  }
  assert.deepEqual(tokens(sanitizePrefs({}), "grey"), { "--accent-h": "0", "--accent-c": "0" });
  assert.deepEqual(tokens(sanitizePrefs({}), "random"), {});
});
