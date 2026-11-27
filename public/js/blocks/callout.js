// Callout looks: a callout follows `block.preset` (see callout-presets.js) unless one of its own overrides in
// `block.custom = { icon?, color?, bg? }` says otherwise (null = explicitly none). Callouts without a preset keep their
// own `icon` / `color` / `bg` as before. Pure (no DOM).
import { CALLOUT_PRESETS } from "./callout-presets.js";
import { normColor, normBg } from "./model.js";

export const DEFAULT_ICON = "icon:lightbulb";
const PRESET_ID = /^[a-z0-9-]{1,40}$/;
export const presetById = (id, presets = CALLOUT_PRESETS) => (typeof id === "string" ? presets.find((p) => p.id === id) ?? null : null);

/** The icon and colours a callout shows: { icon, color, bg, preset } (preset is the preset object or null). */
export function calloutLook(b, presets = CALLOUT_PRESETS) {
  const preset = presetById(b?.preset, presets);
  if (!preset) return { icon: b?.icon || DEFAULT_ICON, color: normColor(b?.color), bg: normBg(b?.bg), preset: null };
  const c = b.custom && typeof b.custom === "object" ? b.custom : {};
  const pick = (k, norm) => (Object.hasOwn(c, k) ? (c[k] === null ? null : norm(c[k])) : norm(preset[k]));
  return {
    icon: Object.hasOwn(c, "icon") && c.icon ? c.icon : preset.icon || DEFAULT_ICON,
    color: pick("color", normColor),
    bg: pick("bg", normBg),
    preset
  };
}
/** True when a preset callout has its own icon or colour. */
export const hasOverride = (b) => !!b?.preset && !!b.custom && Object.keys(b.custom).length > 0;

/** Makes the callout follow a preset: drops its overrides and its old own look. */
export function applyPreset(b, id) {
  if (!presetById(id)) return false;
  b.preset = id;
  delete b.custom;
  delete b.icon;
  delete b.color;
  delete b.bg;
  return true;
}
/** Sets one look key ("icon" | "color" | "bg"). On a preset callout this is an override; `value` null = none. */
export function setLook(b, key, value) {
  if (b.preset) {
    (b.custom ??= {})[key] = value;
    return;
  }
  if (value === null || value === undefined) delete b[key];
  else b[key] = value;
}
/** Removes a preset callout's overrides (Reset to preset). */
export function resetToPreset(b) {
  delete b.custom;
}
/** Cleans `preset` / `custom` in place (normalizeBlocks). Unknown preset ids are kept: the look falls back. */
export function cleanCallout(b) {
  if (typeof b.preset !== "string" || !PRESET_ID.test(b.preset)) delete b.preset;
  if (!b.preset || !b.custom || typeof b.custom !== "object" || Array.isArray(b.custom)) {
    delete b.custom;
    return b;
  }
  const out = {};
  if (typeof b.custom.icon === "string" && b.custom.icon && b.custom.icon.length <= 64) out.icon = b.custom.icon;
  for (const [k, norm] of [["color", normColor], ["bg", normBg]]) {
    if (!Object.hasOwn(b.custom, k)) continue;
    const v = b.custom[k] === null ? null : norm(b.custom[k]);
    if (v !== null || b.custom[k] === null) out[k] = v;
  }
  if (Object.keys(out).length) b.custom = out;
  else delete b.custom;
  return b;
}
