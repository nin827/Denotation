import test from "node:test";
import assert from "node:assert/strict";
import { cleanRules, ruleMatches, propMap, rowPropMap, nearestRules, matchingCallouts, newRule } from "../../source/app/js/autoCallouts.js";
import { calloutLook, applyPreset, setLook, resetToPreset, cleanCallout, hasOverride } from "../../source/app/js/blocks/callout.js";
import { CALLOUT_PRESETS } from "../../source/app/js/blocks/callout-presets.js";
import { normalizeBlocks } from "../../source/app/js/blocks/model.js";

const props = propMap([
  { name: "Status", type: "select", value: "Draft" },
  { name: "Tags", type: "multi", value: ["urgent", "home"] },
  { name: "Due", type: "date", value: "2026-03-10" },
  { name: "Count", type: "number", value: 5 },
  { name: "Done", type: "checkbox", value: false },
  { name: "Note", type: "text", value: "" }
], { title: "Plan" });
const r = (prop, op, value = "") => ({ when: { prop, op, value } });

test("rule operators", () => {
  assert.equal(ruleMatches(r("status", "is", "draft"), props), true, "case-insensitive names and values");
  assert.equal(ruleMatches(r("Status", "is not", "Draft"), props), false);
  assert.equal(ruleMatches(r("Status", "is not", "Done"), props), true);
  assert.equal(ruleMatches(r("Tags", "is", "home"), props), true);
  assert.equal(ruleMatches(r("Tags", "contains", "urg"), props), true);
  assert.equal(ruleMatches(r("Title", "contains", "la"), props), true);
  assert.equal(ruleMatches(r("Note", "empty"), props), true);
  assert.equal(ruleMatches(r("Missing", "empty"), props), true);
  assert.equal(ruleMatches(r("Missing", "is", "x"), props), false);
  assert.equal(ruleMatches(r("Note", "not empty"), props), false);
  assert.equal(ruleMatches(r("Done", "empty"), props), true, "unchecked counts as empty");
  assert.equal(ruleMatches(r("Done", "is", "false"), props), true);
  assert.equal(ruleMatches(r("Due", "before", "2026-04-01"), props), true);
  assert.equal(ruleMatches(r("Due", "after", "2026-04-01"), props), false);
  assert.equal(ruleMatches(r("Due", "before", "today"), props, { today: new Date(2026, 2, 11) }), true);
  assert.equal(ruleMatches(r("Due", "after", "today"), props, { today: new Date(2026, 2, 11) }), false);
  assert.equal(ruleMatches(r("Count", "after", "4"), props), true);
  assert.equal(ruleMatches(r("Count", "is", "5.0"), props), true);
  assert.equal(ruleMatches(r("Count", "before", "abc"), props), false);
  assert.equal(ruleMatches({ when: { prop: "", op: "empty" } }, props), false);
});

test("row property map and nearest rule set", () => {
  const cols = [{ id: "n", name: "Name", type: "text" }, { id: "s", name: "Status", type: "select" }];
  const m = rowPropMap(cols, { values: { n: "Milk", s: "Open" } });
  assert.equal(ruleMatches(r("title", "is", "milk"), m), true);
  assert.equal(ruleMatches(r("Status", "is", "Open"), m), true);
  const own = { autoCallouts: [] };
  const parent = { autoCallouts: [{ id: "p1", ...r("Status", "is", "Open"), preset: "warning", text: "Open!" }, { id: "p2", ...r("Status", "is", "Done"), preset: "success", text: "Done" }, { id: "p3", ...r("Name", "not empty"), preset: "info", text: "Named" }] };
  const grand = { autoCallouts: [{ id: "g1", ...r("Name", "not empty"), preset: "info", text: "far" }] };
  assert.equal(nearestRules([own, parent, grand]).holder, parent, "empty own set falls through; nearest non-empty wins");
  assert.deepEqual(matchingCallouts([own, parent, grand], m).map((x) => x.rule.id), ["p1", "p3"], "all matching rules of that set, in order");
  assert.deepEqual(matchingCallouts([], m), []);
});

test("cleanRules", () => {
  const out = cleanRules([{ when: { prop: " Status ", op: "weird", value: 5 }, preset: "BAD!", text: 3 }, { nope: 1 }, null, { when: { prop: "x", op: "empty", value: "kept?" } }]);
  assert.equal(out.length, 2);
  assert.deepEqual({ ...out[0], id: "" }, { id: "", when: { prop: "Status", op: "is", value: "5" }, preset: "info", text: "3" });
  assert.equal(out[1].when.value, "", "ops without a value drop it");
  assert.equal(newRule("A", "contains", "b", "tip", "t").preset, "tip");
});

test("callout presets: look, overrides, reset, legacy callouts", () => {
  for (const p of CALLOUT_PRESETS) {
    assert.match(p.id, /^[a-z0-9-]+$/);
    assert.ok(p.label && p.icon);
    assert.ok(p.color === null || (Number.isInteger(p.color) && p.color % 30 === 0));
    assert.ok(p.bg === null || p.bg === "grey" || (Number.isInteger(p.bg) && p.bg % 30 === 0));
  }
  assert.deepEqual(CALLOUT_PRESETS.map((p) => p.id), ["info", "tip", "note", "success", "warning", "danger", "question", "quote"]);
  const legacy = { type: "callout", icon: "icon:star", bg: "grey" };
  assert.deepEqual(calloutLook(legacy), { icon: "icon:star", color: null, bg: "grey", preset: null }, "no preset: own look kept");
  const b = { type: "callout", icon: "icon:star", bg: 30 };
  applyPreset(b, "warning");
  assert.equal(b.icon, undefined);
  const warn = CALLOUT_PRESETS.find((p) => p.id === "warning");
  assert.deepEqual(calloutLook(b), { icon: warn.icon, color: warn.color, bg: warn.bg, preset: warn });
  setLook(b, "icon", "🔥");
  setLook(b, "bg", null);
  assert.equal(hasOverride(b), true);
  assert.deepEqual([calloutLook(b).icon, calloutLook(b).bg, calloutLook(b).color], ["🔥", null, warn.color]);
  resetToPreset(b);
  assert.equal(calloutLook(b).icon, warn.icon);
  assert.equal(applyPreset(b, "nope"), false);
  const unknown = cleanCallout({ type: "callout", preset: "gone-preset", custom: { icon: "x", color: 31, bg: null } });
  assert.deepEqual(unknown.custom, { icon: "x", bg: null }, "invalid hue dropped, explicit none kept");
  assert.equal(calloutLook(unknown).icon, "icon:lightbulb", "an unknown preset falls back");
  const [n] = normalizeBlocks([{ type: "callout", text: "x", preset: "Bad Id", custom: { icon: "y" } }]);
  assert.equal(n.preset, undefined);
  assert.equal(n.custom, undefined);
});
