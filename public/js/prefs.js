export const DEFAULTS = Object.freeze({ font: "system", customFont: "", fontSize: 15, headingStep: 0, headingIntercept: 0, bg: "", text: "", accent: "random", sidebarLocked: true });
const SYSTEM = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const FONTS = [
  { id: "system", label: "System sans", stack: SYSTEM },
  { id: "serif", label: "System serif", stack: 'Georgia, "Times New Roman", Times, serif' },
  { id: "mono", label: "System monospace", stack: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  { id: "inter", label: "Inter", google: "Inter", stack: `"Inter", ${SYSTEM}` },
  { id: "nunito", label: "Nunito", google: "Nunito", stack: `"Nunito", ${SYSTEM}` },
  { id: "ibm-plex-sans", label: "IBM Plex Sans", google: "IBM Plex Sans", stack: `"IBM Plex Sans", ${SYSTEM}` },
  { id: "lora", label: "Lora (serif)", google: "Lora", stack: '"Lora", Georgia, serif' },
  { id: "merriweather", label: "Merriweather (serif)", google: "Merriweather", stack: '"Merriweather", Georgia, serif' },
  { id: "source-serif-4", label: "Source Serif 4", google: "Source Serif 4", stack: '"Source Serif 4", Georgia, serif' },
  { id: "playfair-display", label: "Playfair Display", google: "Playfair Display", stack: '"Playfair Display", Georgia, serif' },
  { id: "jetbrains-mono", label: "JetBrains Mono", google: "JetBrains Mono", stack: '"JetBrains Mono", ui-monospace, Menlo, monospace' },
  { id: "custom", label: "Custom font name\u2026", stack: SYSTEM }
];
export const PRESETS = [
  { id: "default", label: "Theme default", bg: "", text: "" },
  { id: "sepia", label: "Sepia", bg: "#f4ecd8", text: "#433422" },
  { id: "rose", label: "Rose", bg: "#fff5f5", text: "#3b1f24" },
  { id: "slate", label: "Slate", bg: "#14171c", text: "#e6e9ee" },
  { id: "midnight", label: "Midnight", bg: "#0b1020", text: "#dbe4ff" },
  { id: "forest", label: "Forest", bg: "#0f1a14", text: "#d8eadf" },
  { id: "contrast", label: "High contrast", bg: "#000000", text: "#ffffff" }
];
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
// Is the page effectively dark? A custom background wins; otherwise data-theme, then the OS preference.
export function effectiveDark(p, env = {}) {
  if (p && p.bg) return isDark(p.bg);
  if (env.theme === "dark") return true;
  if (env.theme === "light") return false;
  return !!env.prefersDark;
}
const HEX = /^#[0-9a-f]{6}$/i;
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 \-]{0,39}$/;
export function sanitizePrefs(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const size = Math.round(Number(r.fontSize));
  return {
    font: FONTS.some((f) => f.id === r.font) ? r.font : DEFAULTS.font,
    customFont: typeof r.customFont === "string" && FAMILY.test(r.customFont.trim()) ? r.customFont.trim() : "",
    fontSize: Number.isFinite(size) ? Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, size)) : DEFAULTS.fontSize,
    headingStep: clampInt(r.headingStep, HEADING_STEP, DEFAULTS.headingStep),
    headingIntercept: clampInt(r.headingIntercept, HEADING_INTERCEPT, DEFAULTS.headingIntercept),
    bg: HEX.test(r.bg) ? r.bg.toLowerCase() : "",
    text: HEX.test(r.text) ? r.text.toLowerCase() : "",
    accent: sanitizeAccent(r.accent),
    sidebarLocked: r.sidebarLocked === void 0 ? DEFAULTS.sidebarLocked : !!r.sidebarLocked
  };
}
const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrastOn = (hex) => luminance(hex) > 0.4 ? "#000000" : "#ffffff";
const isDark = (hex) => luminance(hex) <= 0.4;
export function tokens(p, accent, env = {}) {
  const t = {};
  const mix = (a, pct, b) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
  if (p.bg) {
    const fg = p.text || contrastOn(p.bg);
    t["--bg"] = p.bg;
    t["--bg-soft"] = mix(p.bg, 93, fg);
    t["--bg-hover"] = mix(p.bg, 86, fg);
    t["--border"] = mix(p.bg, 82, fg);
    t["--scrim"] = isDark(p.bg) ? "rgba(0, 0, 0, .6)" : "rgba(15, 20, 30, .45)";
    t["color-scheme"] = isDark(p.bg) ? "dark" : "light";
  }
  if (p.text) {
    t["--text"] = p.text;
    t["--muted"] = mix(p.text, 62, "var(--bg)");
  } else if (p.bg) {
    t["--text"] = contrastOn(p.bg);
    t["--muted"] = mix(contrastOn(p.bg), 62, p.bg);
  }
  const a = accent === void 0 ? sanitizeAccent(p.accent) : accent;
  if (a === "random") return t;
  t["--accent-h"] = String(a === "grey" ? 0 : a);
  t["--accent-c"] = String(a === "grey" ? 0 : ACCENT_CHROMA);
  // With a custom background the page scheme is decided here, so state the accent explicitly.
  if (p.bg) Object.assign(t, accentTokens(a, effectiveDark(p, env)));
  return t;
}
export function fontSpec(p) {
  if (p.font === "custom" && p.customFont) return { stack: `"${p.customFont}", ${SYSTEM}`, google: p.customFont };
  const f = FONTS.find((x) => x.id === p.font) ?? FONTS[0];
  return { stack: f.id === "custom" ? SYSTEM : f.stack, google: f.google ?? null };
}
export const googleFontUrl = (family) => `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;600;700&display=swap`;
