export const MODES = Object.freeze(["neutral", "light", "dark", "variable"]);
export const DEFAULTS = Object.freeze({ mode: "neutral", font: "system", customFont: "", fontSize: 15, headingStep: 0, headingIntercept: 0, accent: "random", sidebarLocked: true });
const SYSTEM = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
// Recommended fonts: system stacks plus the bundled Noto variable fonts (source/app/fonts, @font-face in style.css). "local" uses prefs.customFont.
export const FONTS = [
  { id: "system", label: "System sans", stack: SYSTEM },
  { id: "serif", label: "System serif", stack: 'Georgia, "Times New Roman", Times, serif' },
  { id: "mono", label: "System monospace", stack: MONO },
  { id: "noto-sans", label: "Noto Sans", family: "Noto Sans", stack: `"Noto Sans", ${SYSTEM}` },
  { id: "noto-serif", label: "Noto Serif", family: "Noto Serif", stack: '"Noto Serif", Georgia, "Times New Roman", serif' },
  { id: "noto-mono", label: "Noto Sans Mono", family: "Noto Sans Mono", stack: `"Noto Sans Mono", ${MONO}`, mono: true }
];
export const LOCAL_FONT = "local";
export const FONT_SIZE = Object.freeze({ min: 12, max: 24 });
export const HEADING_STEP = Object.freeze({ min: 0, max: 24 });
export const HEADING_INTERCEPT = Object.freeze({ min: -24, max: 24 });
export function headingSizes(p) {
  if (!p || !(p.headingStep > 0)) return null;
  const at = (n) => Math.min(96, Math.max(8, p.fontSize + (p.headingIntercept || 0) + p.headingStep * (5 - n)));
  return { h1: at(1), h2: at(2), h3: at(3), h4: at(4) };
}
const clampInt = (v, lim, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(lim.max, Math.max(lim.min, n)) : fallback;
};
export const ACCENT_HUES = Object.freeze(Array.from({ length: 24 }, (_, i) => i * 15));
export const ACCENT_CHROMA = 0.16;
export function sanitizeAccent(v) {
  if (v === "grey") return "grey";
  if (typeof v === "string" && /^\d{1,3}$/.test(v.trim())) v = Number(v);
  return typeof v === "number" && ACCENT_HUES.includes(v) ? v : "random";
}
// Turns a stored accent pref into a concrete "grey" or hue. "random" never yields grey.
export function resolveAccent(accent, rng = Math.random) {
  const a = sanitizeAccent(accent);
  if (a !== "random") return a;
  const i = Math.floor(rng() * ACCENT_HUES.length);
  return ACCENT_HUES[Math.min(ACCENT_HUES.length - 1, Math.max(0, i))];
}
// Explicit accent tokens for a concrete accent ("grey" or hue) in light or dark.
export function accentTokens(accent, dark) {
  const grey = accent === "grey";
  const c = grey ? 0 : ACCENT_CHROMA;
  const h = grey ? 0 : accent;
  const f = (x) => +x.toFixed(4);
  const t = { "--accent-h": String(h), "--accent-c": String(c) };
  if (dark) {
    t["--accent"] = grey ? "oklch(0.85 0 0)" : `oklch(0.72 ${c} ${h})`;
    t["--accent-soft"] = `oklch(0.30 ${f(c * 0.45)} ${h})`;
    t["--accent-ink"] = grey ? "oklch(0.88 0 0)" : `oklch(0.85 ${f(c * 0.6)} ${h})`;
    t["--on-accent"] = "#16150f";
  } else {
    t["--accent"] = grey ? "oklch(0.35 0 0)" : `oklch(0.50 ${c} ${h})`;
    t["--accent-soft"] = `oklch(0.95 ${f(c * 0.22)} ${h})`;
    t["--accent-ink"] = grey ? "oklch(0.30 0 0)" : `oklch(0.40 ${f(c * 0.875)} ${h})`;
    t["--on-accent"] = "#ffffff";
  }
  return t;
}
// Variable mode: light from 07:00 to 19:00 local time, dark otherwise. `now` is injectable for tests.
export const VARIABLE_DAY = Object.freeze({ from: 7, to: 19 });
export function resolveMode(mode, now = new Date()) {
  const m = sanitizeMode(mode);
  if (m !== "variable") return m;
  const hr = now.getHours();
  return hr >= VARIABLE_DAY.from && hr < VARIABLE_DAY.to ? "light" : "dark";
}
export const sanitizeMode = (v) => MODES.includes(v) ? v : DEFAULTS.mode;
// Neutral and light are light values (accent L 0.50); only dark uses the dark accent variant.
export const isDarkMode = (resolved) => resolved === "dark";
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 \-]{0,39}$/;
export const sanitizeFamily = (v) => typeof v === "string" && FAMILY.test(v.trim()) ? v.trim() : "";
export function sanitizePrefs(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const size = Math.round(Number(r.fontSize));
  const customFont = sanitizeFamily(r.customFont);
  const font = r.font === LOCAL_FONT || r.font === "custom" ? (customFont ? LOCAL_FONT : DEFAULTS.font) : FONTS.some((f) => f.id === r.font) ? r.font : DEFAULTS.font;
  return {
    mode: sanitizeMode(r.mode),
    font,
    customFont,
    fontSize: Number.isFinite(size) ? Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, size)) : DEFAULTS.fontSize,
    headingStep: clampInt(r.headingStep, HEADING_STEP, DEFAULTS.headingStep),
    headingIntercept: clampInt(r.headingIntercept, HEADING_INTERCEPT, DEFAULTS.headingIntercept),
    accent: sanitizeAccent(r.accent),
    sidebarLocked: r.sidebarLocked === void 0 ? DEFAULTS.sidebarLocked : !!r.sidebarLocked
  };
}
// Inline tokens set on <html>: only the accent hue/chroma; the CSS blocks keyed on data-mode derive everything else.
export function tokens(p, accent) {
  const a = accent === void 0 ? sanitizeAccent(p.accent) : accent;
  if (a === "random") return {};
  return { "--accent-h": String(a === "grey" ? 0 : a), "--accent-c": String(a === "grey" ? 0 : ACCENT_CHROMA) };
}
export function fontSpec(p) {
  if (p.font === LOCAL_FONT && p.customFont) return { stack: `"${p.customFont}", ${SYSTEM}`, mono: null };
  const f = FONTS.find((x) => x.id === p.font) ?? FONTS[0];
  return { stack: f.stack, mono: f.mono ? f.stack : null };
}
