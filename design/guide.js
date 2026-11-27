// Live style guide. Applies prefs exactly like public/js/ui/appearance.js applyPrefs (mode, accent, font).
import { HUES } from "../public/js/blocks/model.js";
import { ico } from "../public/js/icons/index.js";
import { MODES, FONTS, ACCENT_HUES, resolveMode, resolveAccent, tokens, fontSpec, sanitizePrefs, headingSizes } from "../public/js/prefs.js";

const root = document.documentElement;
const $ = (id) => document.getElementById(id);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (v != null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const state = { mode: "neutral", accent: resolveAccent("random"), random: true, font: "system" };
const MODE_ICONS = { neutral: ["Neutral", "contrast"], light: ["Light", "sun"], dark: ["Dark", "moon"], variable: ["Variable", "sun-moon"] };

const TOKENS = ["--bg", "--bg-soft", "--bg-hover", "--text", "--muted", "--border", "--accent", "--accent-soft", "--accent-ink", "--on-accent", "--danger", "--scrim",
  "--c-gray", "--c-brown", "--c-orange", "--c-yellow", "--c-green", "--c-blue", "--c-purple", "--c-pink", "--c-red"];

function apply() {
  const m = resolveMode(state.mode);
  root.dataset.mode = m;
  const t = tokens(sanitizePrefs({}), state.accent);
  if (state.accent === "grey") root.dataset.accent = "grey"; else delete root.dataset.accent;
  for (const n of ["--accent-h", "--accent-c"]) root.style.setProperty(n, t[n]);
  const { stack, mono } = fontSpec({ font: state.font, customFont: "" });
  root.style.setProperty("font-family", stack);
  if (mono) root.style.setProperty("--mono", mono); else root.style.removeProperty("--mono");
  $("resolved").textContent = state.mode === "variable" ? `now ${m}` : "";
  drawControls();
  drawTokens();
  drawBlockColors();
}
function drawControls() {
  $("c-mode").replaceChildren(...MODES.map((m) => h("button", { type: "button", "aria-pressed": String(state.mode === m), onClick: () => { state.mode = m; apply(); } }, ico(MODE_ICONS[m][1]), MODE_ICONS[m][0])));
  const sw = (value, label, extra) => h("button", {
    class: `swatch${extra ? " " + extra : ""}`, type: "button", title: label, "aria-label": label,
    "aria-pressed": String(value === "random" ? state.random : !state.random && state.accent === value),
    style: value === "random" ? null : `--sw:${swatchColor(value)};--sw-on:${resolveMode(state.mode) === "dark" ? "#16150f" : "#ffffff"}`,
    onClick: () => { state.random = value === "random"; state.accent = value === "random" ? resolveAccent("random") : value; apply(); }
  }, (value === "random" ? state.random : !state.random && state.accent === value) ? ico("check") : null);
  $("c-accent").replaceChildren(sw("random", "Random", "swatch-random"), ...ACCENT_HUES.map((hue) => sw(hue, `Hue ${hue}`)), sw("grey", "Grey"));
  $("c-font").replaceChildren(...FONTS.map((f) => h("option", { value: f.id, ...(f.id === state.font ? { selected: "" } : {}) }, f.label)));
}
function swatchColor(v) {
  const dark = resolveMode(state.mode) === "dark";
  if (v === "grey") return dark ? "oklch(0.85 0 0)" : "oklch(0.35 0 0)";
  return dark ? `oklch(0.72 0.16 ${v})` : `oklch(0.50 0.16 ${v})`;
}
function drawTokens() {
  const probe = h("i", { style: "display:none" });
  document.body.append(probe);
  setTimeout(() => probe.remove());
  $("tokens").replaceChildren(...TOKENS.map((n) => {
    probe.style.background = `var(${n})`;
    const v = getComputedStyle(probe).backgroundColor;
    return h("div", { class: "g-tok" }, h("i", { style: `background:var(${n})` }), h("b", {}, n), h("span", { title: v }, v));
  }));
}

function build() {
  const I = (n) => ico(n);
  $("buttons").append(
    h("button", {}, "Default"), h("button", { class: "primary" }, "Primary"), h("button", { class: "danger" }, "Danger"),
    h("button", {}, I("plus"), "With icon"), h("button", { disabled: "" }, "Disabled"),
    h("button", { class: "icon", "aria-label": "Search", title: "Icon button" }, I("search")),
    h("button", { class: "icon on", "aria-label": "Pinned" }, I("lock")),
    h("button", { class: "act-new primary" }, I("plus"), h("span", {}, "New"), I("chevron-down"))
  );
  $("inputs").append(
    h("div", { class: "set-row" }, h("label", { for: "g-text" }, "Text"), h("input", { id: "g-text", type: "text", placeholder: "Placeholder" })),
    h("div", { class: "set-row" }, h("label", { for: "g-sel" }, "Select"), h("select", { id: "g-sel" }, h("option", {}, "Option one"), h("option", {}, "Option two"))),
    h("div", { class: "set-row" }, h("label", { for: "g-rng" }, "Range"), h("input", { id: "g-rng", type: "range", min: "12", max: "24", value: "15" })),
    h("div", { class: "set-row" }, h("label", { for: "g-ta" }, "Textarea"), h("textarea", { id: "g-ta", rows: "2" }, "Some text")),
    h("label", { class: "set-check" }, h("input", { type: "checkbox", checked: "" }), " Checkbox with label"),
    h("p", { class: "hint" }, "Hint text uses --muted at 13px.")
  );
  const item = (label, icon, extra = {}) => h("div", { class: `menu-item${extra.cls ? " " + extra.cls : ""}`, role: "menuitem" },
    h("span", { class: "menu-icon" }, I(icon)), h("span", { class: "menu-label" }, label), extra.hint ? h("span", { class: "menu-hint" }, extra.hint) : null);
  $("menu").append(h("div", { class: "menu", role: "menu" },
    h("div", { class: "menu-header" }, "Turn into"),
    item("Text", "type", { hint: "Ctrl+1" }), item("Heading 1", "heading-1", { cls: "active" }), item("Duplicate", "copy", { cls: "disabled" }),
    item("Move to trash", "trash", { cls: "danger" })));
  $("modal").append(h("div", { class: "modal", role: "dialog" },
    h("h3", {}, "Rename page"),
    h("label", {}, "Title", h("input", { type: "text", value: "Meeting notes" })),
    h("div", { class: "modal-error" }, "Error text appears here."),
    h("div", { class: "modal-actions" }, h("button", {}, "Cancel"), h("button", { class: "primary" }, "Save"))));
  $("toasts").append(h("div", { class: "toast", role: "status" }, "Block copied"), h("div", { class: "toast error", role: "alert" }, "That page no longer exists."));
  $("side").append(h("div", { class: "side-box" },
    h("div", { class: "brand" }, h("span", { class: "brand-name" }, "Denotion"), h("button", { class: "act-new primary" }, I("plus"), h("span", {}, "New"), I("chevron-down")), h("button", { class: "icon", "aria-label": "Search" }, I("search"))),
    h("div", { class: "side-tools" }, ...[["search", "Search"], ["settings-2", "Settings"], ["ticket", "Ticket"], ["trash", "Trash"]].map(([i, t], n) => h("button", { class: `tool${n === 1 ? " active" : ""}` }, I(i), h("span", {}, t)))),
    h("div", { class: "side-section" }, "Pages"),
    h("div", { class: "side-item active", tabindex: "0" }, h("span", { class: "twist-gap" }), h("span", { class: "side-icon" }, I("file-text")), h("span", { class: "side-title" }, "Active page")),
    h("div", { class: "side-item", tabindex: "0" }, h("button", { class: "icon twist open", "aria-label": "Collapse" }, I("chevron-right")), h("span", { class: "side-icon" }, I("folder-open")), h("span", { class: "side-title" }, "Folder with children")),
    h("div", { class: "side-item", style: "padding-left:20px", tabindex: "0" }, h("span", { class: "twist-gap" }), h("span", { class: "side-icon" }, I("database")), h("span", { class: "side-title" }, "Nested database"))));
  $("seg").append(
    h("div", { class: "seg", role: "group", "aria-label": "Segmented" }, ...["Day", "Week", "Month"].map((t, i) => h("button", { type: "button", "aria-pressed": String(i === 1) }, i === 1 ? I("check") : null, t))));
  $("chips").append(
    h("span", { class: "chip" }, "Chip"), h("span", { class: "chip" }, "2026-11-27"), h("button", { class: "chip-btn" }, "Chip button"), h("span", { class: "badge" }, "3"),
    h("div", { class: "banner", style: "width:100%" }, I("info"), "Banner message with an icon and text."));
  $("cards").append(
    h("div", { class: "card", tabindex: "0", role: "button" }, h("div", { class: "card-title" }, "Card title"), h("div", { class: "card-chips" }, h("span", { class: "chip" }, "Todo"), h("span", { class: "chip" }, "High"))),
    h("div", { class: "repo-card" }, h("span", { class: "rc-icon" }, I("library")), h("span", { class: "rc-title" }, "Repo card"), h("p", { class: "hint" }, "12 pages")),
    h("div", { class: "dash-tile" }, h("div", { class: "hint", style: "margin:0" }, "Dashboard tile"), h("div", { class: "dash-val" }, "128")));
  const th = (t) => h("th", {}, t);
  $("tables").append(h("div", { class: "db-wrap" }, h("table", { class: "db-table" },
    h("thead", {}, h("tr", {}, th("Name"), th("Status"), th("Due"))),
    h("tbody", {}, ...[["Write spec", "Doing", "2026-12-01"], ["Ship guide", "Todo", "2026-12-05"]].map((r) => h("tr", {}, ...r.map((c) => h("td", {}, h("span", { class: "cell-btn" }, c)))))))));
  $("icons").append(...[["12px", 12], ["14px", 14], ["16px", 16], ["1.1em (default)", null], ["20px", 20]].map(([l, px]) => {
    const i = ico("star"); if (px) i.style.cssText = `width:${px}px;height:${px}px`;
    return h("div", {}, i, l);
  }));
  const sizes = headingSizes(sanitizePrefs({ headingStep: 4, headingIntercept: 0 }));
  $("steps").textContent = `Prefs example: base 15, step 4, intercept 0 gives H4 to H1 = ${sizes.h4}, ${sizes.h3}, ${sizes.h2}, ${sizes.h1} px.`;
  $("c-font").addEventListener("change", (e) => { state.font = e.target.value; apply(); });
  setInterval(() => { if (state.mode === "variable") apply(); }, 60000);
}
build();
apply();

function drawBlockColors() {
  const sample = (label, cls, style) => h("div", { class: `blk-row ${cls}`, style }, h("div", { class: "rendered", style: "padding:4px 8px" }, label));
  $("blockcolors").replaceChildren(
    h("div", { class: "cp-grid", role: "group", "aria-label": "Block colours" },
      ...HUES.map(([deg, name]) => h("span", { class: "cp-sw hue", style: `--h:${deg}`, title: `${name} ${deg}\u00b0` }, h("span", { class: "cp-a" }, "A"))),
      h("span", { class: "cp-sw grey", title: "Grey (background only)" })),
    ...HUES.filter((_, i) => i % 3 === 0).map(([deg, name]) => sample(`${name} ${deg}\u00b0: text and background`, "has-color has-bg", `--blk-h:${deg};--blk-bg-h:${deg}`)),
    sample("Grey background, default text", "has-bg bg-grey")
  );
}
