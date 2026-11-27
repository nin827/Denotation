import { h, debounce } from "./dom.js";
import { ico } from "../icons/index.js";
import { openModal } from "./modal.js";
import {
  sanitizePrefs,
  tokens,
  fontSpec,
  headingSizes,
  googleFontUrl,
  FONTS,
  FONT_SIZE,
  HEADING_STEP,
  HEADING_INTERCEPT,
  PRESETS,
  DEFAULTS,
  ACCENT_HUES,
  resolveAccent,
  accentTokens,
  effectiveDark
} from "../prefs.js";

const KEY = "denotion:prefs";
const TOKEN_NAMES = ["--bg", "--bg-soft", "--bg-hover", "--border", "--scrim", "--text", "--muted", "--accent", "--accent-soft", "--accent-ink", "--accent-h", "--accent-c", "--on-accent", "color-scheme"];
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
const pageEnv = () => ({
  theme: document.documentElement.dataset.theme,
  prefersDark: !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches)
});
// The accent actually in use: "random" is drawn once per page load and never gives grey.
export function currentAccent(p) {
  if (p.accent !== "random") return p.accent;
  if (randomHue === null) randomHue = resolveAccent("random");
  return randomHue;
}
export function applyPrefs(p) {
  const root = document.documentElement;
  const acc = currentAccent(p);
  const t = tokens(p, acc, pageEnv());
  if (acc === "grey") root.dataset.accent = "grey";
  else delete root.dataset.accent;
  for (const name of TOKEN_NAMES) {
    if (name in t) root.style.setProperty(name, t[name]);
    else root.style.removeProperty(name);
  }
  const { stack, google } = fontSpec(p);
  root.style.setProperty("font-family", stack);
  root.style.setProperty("--font-size", `${p.fontSize}px`);
  const hs = headingSizes(p);
  for (const n of [1, 2, 3, 4]) {
    if (hs) root.style.setProperty(`--h${n}-size`, `${hs[`h${n}`]}px`);
    else root.style.removeProperty(`--h${n}-size`);
  }
  let link = document.getElementById("denotion-font");
  if (google) {
    const href = googleFontUrl(google);
    if (!link) {
      link = h("link", { id: "denotion-font", rel: "stylesheet" });
      document.head.append(link);
    }
    if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  } else link?.remove();
}
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
  const live = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const asHex = (v, fallback) => /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
  function colorRow(label, key, token, fallback) {
    const input = h("input", {
      type: "color",
      "aria-label": label,
      value: cur[key] || asHex(live(token), fallback),
      onInput: (e) => set({ [key]: e.target.value }, false)
    });
    return h(
      "div",
      { class: "set-row" },
      h("label", {}, label),
      input,
      h("button", { class: "icon", title: `Reset ${label.toLowerCase()}`, "aria-label": `Reset ${label}`, disabled: !cur[key], onClick: () => set({ [key]: "" }) }, ico("rotate-ccw"))
    );
  }
  function swatches() {
    const dark = effectiveDark(cur, pageEnv());
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
        h("h4", {}, "Font"),
        h(
          "div",
          { class: "set-row" },
          h("label", { for: "set-font" }, "Family"),
          h(
            "select",
            { id: "set-font", value: cur.font, onChange: (e) => set({ font: e.target.value }) },
            FONTS.map((f) => h("option", { value: f.id }, f.label))
          )
        ),
        cur.font === "custom" ? h(
          "div",
          { class: "set-row" },
          h("label", { for: "set-custom" }, "Font name"),
          h("input", {
            id: "set-custom",
            type: "text",
            value: cur.customFont,
            placeholder: "e.g. Quicksand, Comic Neue, Fira Code",
            maxlength: 40,
            onChange: (e) => set({ customFont: e.target.value })
          })
        ) : null,
        cur.font === "custom" ? h("p", { class: "hint" }, "Any Google Fonts family name works, and so does a font installed on this device.") : null,
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
        h("h4", {}, "Colors"),
        h("div", { class: "preset-row" }, PRESETS.map((pr) => h("button", {
          class: "preset",
          title: pr.label,
          "aria-label": pr.label,
          onClick: () => set({ bg: pr.bg, text: pr.text }),
          style: pr.bg ? `background:${pr.bg};color:${pr.text}` : null
        }, pr.bg ? "Aa" : ico("rotate-ccw")))),
        colorRow("Background", "bg", "--bg", "#ffffff"),
        colorRow("Font color", "text", "--text", "#1f2530"),
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
