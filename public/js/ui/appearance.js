import { h, debounce } from "./dom.js";
import { ico } from "../icons/index.js";
import { openModal } from "./modal.js";
import {
  sanitizePrefs,
  sanitizeFamily,
  tokens,
  fontSpec,
  headingSizes,
  resolveMode,
  isDarkMode,
  MODES,
  FONTS,
  LOCAL_FONT,
  FONT_SIZE,
  HEADING_STEP,
  HEADING_INTERCEPT,
  DEFAULTS,
  ACCENT_HUES,
  resolveAccent,
  accentTokens
} from "../prefs.js";

const KEY = "denotion:prefs";
const TOKEN_NAMES = ["--accent-h", "--accent-c"];
export function loadPrefs() {
  try {
    return sanitizePrefs(JSON.parse(localStorage.getItem(KEY)));
  } catch {
    return sanitizePrefs(null);
  }
}
export function savePrefs(p) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
  }
}
let randomHue = null;
// The accent actually in use: "random" is drawn once per page load and never gives grey.
export function currentAccent(p) {
  if (p.accent !== "random") return p.accent;
  if (randomHue === null) randomHue = resolveAccent("random");
  return randomHue;
}
// Sets <html data-mode> to the resolved value (neutral | light | dark). "variable" is re-checked every minute and when the tab shows.
let modePref = DEFAULTS.mode;
let modeTimer = 0;
let modeHooked = false;
export const currentMode = () => document.documentElement.dataset.mode || "neutral";
function applyMode() {
  const root = document.documentElement;
  const m = resolveMode(modePref);
  if (root.dataset.mode !== m) root.dataset.mode = m;
  return m;
}
function watchMode(p) {
  modePref = p.mode;
  clearInterval(modeTimer);
  modeTimer = 0;
  if (p.mode === "variable") modeTimer = setInterval(applyMode, 60000);
  if (!modeHooked) {
    modeHooked = true;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) applyMode();
    });
  }
}
export function applyPrefs(p) {
  const root = document.documentElement;
  watchMode(p);
  applyMode();
  const acc = currentAccent(p);
  const t = tokens(p, acc);
  if (acc === "grey") root.dataset.accent = "grey";
  else delete root.dataset.accent;
  for (const name of TOKEN_NAMES) {
    if (name in t) root.style.setProperty(name, t[name]);
    else root.style.removeProperty(name);
  }
  const { stack, mono } = fontSpec(p);
  root.style.setProperty("font-family", stack);
  if (mono) root.style.setProperty("--mono", mono);
  else root.style.removeProperty("--mono");
  root.style.setProperty("--font-size", `${p.fontSize}px`);
  const hs = headingSizes(p);
  for (const n of [1, 2, 3, 4]) {
    if (hs) root.style.setProperty(`--h${n}-size`, `${hs[`h${n}`]}px`);
    else root.style.removeProperty(`--h${n}-size`);
  }
}
// Installed fonts (Chromium's Local Font Access). Needs a user gesture and permission; cached for the session.
let localFonts = null;
export const canListLocalFonts = () => typeof window.queryLocalFonts === "function";
async function loadLocalFonts() {
  const all = await window.queryLocalFonts();
  localFonts = [...new Set(all.map((f) => f.family))].map(sanitizeFamily).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).sort((x, y) => x.localeCompare(y));
  return localFonts;
}
const MODE_ICONS = { neutral: ["Neutral", "contrast"], light: ["Light", "sun"], dark: ["Dark", "moon"], variable: ["Variable", "sun-moon"] };
export function openSettings({ prefs: prefs, onChange }) {
  let cur = { ...prefs };
  const commit = debounce(() => savePrefs(cur), 200);
  const set = (patch, redraw = true) => {
    cur = sanitizePrefs({ ...cur, ...patch });
    applyPrefs(cur);
    commit();
    onChange(cur);
    if (redraw) draw();
  };
  const body = h("div", { class: "settings" });
  const modeControl = () => h(
    "div",
    { class: "seg", role: "group", "aria-label": "Theme value" },
    MODES.map((m) => h("button", {
      type: "button",
      title: m === "variable" ? "Variable: light 07:00-19:00, dark otherwise" : MODE_ICONS[m][0],
      "aria-pressed": String(cur.mode === m),
      onClick: () => set({ mode: m })
    }, ico(MODE_ICONS[m][1]), MODE_ICONS[m][0]))
  );
  function fontPicker() {
    const opt = (id, label, stack, selected, onClick) => h("button", {
      class: "font-opt", type: "button", "aria-pressed": String(selected), onClick,
      style: `font-family:${stack}`
    }, h("span", { class: "fo-name" }, label), selected ? ico("check") : null);
    const wrap = h("div", { class: "font-pick" });
    const recommended = h("div", { class: "font-groups", role: "group", "aria-label": "Recommended fonts" },
      FONTS.map((f) => opt(f.id, f.label, f.stack, cur.font === f.id, () => set({ font: f.id }))));
    const local = h("div", { class: "font-groups" });
    const drawLocal = (status) => {
      local.replaceChildren();
      if (cur.font === LOCAL_FONT) local.append(h("p", { class: "hint" }, `In use: ${cur.customFont}`));
      if (!canListLocalFonts()) {
        local.append(
          h("div", { class: "set-row" },
            h("label", { for: "set-custom" }, "Font name"),
            h("input", { id: "set-custom", type: "text", value: cur.customFont, placeholder: "e.g. Fira Code", maxlength: 40,
              onChange: (e) => {
                const fam = sanitizeFamily(e.target.value);
                set(fam ? { font: LOCAL_FONT, customFont: fam } : { font: DEFAULTS.font, customFont: "" });
              } })),
          h("p", { class: "hint" }, "Type the name of a font installed on this device. Not recommended: it only works where that font exists.")
        );
        return;
      }
      if (!localFonts) {
        local.append(
          h("button", { type: "button", onClick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await loadLocalFonts();
              drawLocal();
            } catch {
              drawLocal("Permission was not granted, so no fonts are listed.");
            }
          } }, "Show fonts installed on this device"),
          ...[status ? h("p", { class: "hint", role: "status" }, status) : null].filter(Boolean),
          h("p", { class: "hint" }, "Not recommended: your browser asks permission, and the font only works on this device.")
        );
        return;
      }
      const list = h("div", { class: "font-list", role: "group", "aria-label": "Fonts on this device" });
      const fill = (q) => {
        const f = q.trim().toLowerCase();
        const rows = localFonts.filter((n) => !f || n.toLowerCase().includes(f)).slice(0, 300);
        list.replaceChildren(...(rows.length ? rows.map((n) => opt(n, n, `"${n}", sans-serif`, cur.font === LOCAL_FONT && cur.customFont === n, () => set({ font: LOCAL_FONT, customFont: n }))) : [h("p", { class: "hint", style: "padding:4px 8px;margin:0" }, "No matching fonts.")]));
      };
      local.append(
        h("input", { type: "search", "aria-label": "Search installed fonts", placeholder: "Search installed fonts", style: "width:100%;margin-top:6px", onInput: (e) => fill(e.target.value) }),
        list
      );
      fill("");
    };
    drawLocal();
    wrap.append(h("h5", {}, "Recommended"), recommended, h("h5", {}, "On this device"), local);
    return wrap;
  }
  function swatches() {
    const dark = isDarkMode(currentMode());
    const mk = (value, label, extra, child) => h("button", {
      class: `swatch${extra ? " " + extra : ""}`,
      type: "button",
      title: label,
      "aria-label": label,
      "aria-pressed": String(cur.accent === value),
      style: value === "random" ? null : `--sw:${accentTokens(value, dark)["--accent"]};--sw-on:${dark ? "#16150f" : "#ffffff"}`,
      onClick: () => set({ accent: value })
    }, cur.accent === value ? ico("check") : child ?? null);
    return h(
      "div",
      { class: "swatch-grid", role: "group", "aria-label": "Accent color" },
      mk("random", "Random", "swatch-random"),
      ACCENT_HUES.map((hue) => mk(hue, `Hue ${hue}`)),
      mk("grey", "Grey")
    );
  }
  const stepsPreview = h("p", { class: "hint steps-preview" });
  const drawPreview = () => {
    const hs = headingSizes(cur);
    stepsPreview.textContent = hs ? `H4 to H1: ${[hs.h4, hs.h3, hs.h2, hs.h1].join(" - ")} px (base ${cur.fontSize})` : "Default heading sizes";
  };
  function numRow(id, label, key, lim, help) {
    return h(
      "div",
      { class: "set-row", title: help },
      h("label", { for: id }, label),
      h("input", {
        id,
        type: "number",
        min: lim.min,
        max: lim.max,
        step: 1,
        value: cur[key],
        onInput: (e) => {
          if (e.target.value !== "") {
            cur = sanitizePrefs({ ...cur, [key]: e.target.value });
            applyPrefs(cur);
            commit();
            onChange(cur);
            drawPreview();
          }
        },
        onChange: (e) => {
          e.target.value = cur[key];
        }
      })
    );
  }
  function draw() {
    drawPreview();
    const sizeLabel = h("label", { for: "set-size" }, `Size: ${cur.fontSize}px`);
    body.replaceChildren(
      h(
        "section",
        {},
        h("h4", {}, "Theme"),
        modeControl(),
        h("h4", {}, "Font"),
        fontPicker(),
        h(
          "div",
          { class: "set-row" },
          sizeLabel,
          h("input", {
            id: "set-size",
            type: "range",
            min: FONT_SIZE.min,
            max: FONT_SIZE.max,
            step: 1,
            value: cur.fontSize,
            onInput: (e) => {
              sizeLabel.textContent = `Size: ${e.target.value}px`;
              set({ fontSize: e.target.value }, false);
              drawPreview();
            }
          })
        ),
        h("p", { class: "set-sample" }, "The quick brown fox jumps over the lazy dog."),
        h("h4", {}, "Heading sizes"),
        numRow("set-step", "Font size steps", "headingStep", HEADING_STEP, "Size added per heading level. 0 keeps the default heading sizes."),
        numRow("set-intercept", "Font size intercept", "headingIntercept", HEADING_INTERCEPT, "Added to every heading. With base 12 and step 4, an intercept of -4 gives H4 to H1 = 12-16-20-24."),
        stepsPreview
      ),
      h(
        "section",
        {},
        h("h4", {}, "Accent"),
        swatches()
      ),
      h(
        "section",
        {},
        h("h4", {}, "Sidebar"),
        h(
          "label",
          { class: "set-check" },
          h("input", { type: "checkbox", checked: cur.sidebarLocked, onChange: (e) => set({ sidebarLocked: e.target.checked }) }),
          " Keep the sidebar locked open (unlock it to open and close it as needed)"
        )
      )
    );
  }
  draw();
  return openModal({
    title: "Appearance",
    content: body,
    actions: [
      { label: "Reset all", run: () => {
        set({ ...DEFAULTS, sidebarLocked: cur.sidebarLocked });
        return false;
      } },
      { label: "Done", class: "primary" }
    ]
  });
}
