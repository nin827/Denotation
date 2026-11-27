// "Linked images: Click to load" (Settings → Privacy, prefs.remoteImages). A picture on another site is drawn as a
// placeholder (icon, alt text, host name, "Load image" button) until it is clicked, so opening a page doesn't tell
// that site you read it. data:, blob: and same-origin pictures always load. A click loads that picture for the
// rest of the page view (the choice is forgotten on navigation). The decision itself is pure: imageUtil.deferImage.
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { deferImage, imageHost } from "./imageUtil.js";

let mode = "auto";
const allowed = new Set();
let watching = false;

/** Called from applyPrefs. */
export function setRemoteImageMode(m) {
  mode = m === "click" ? "click" : "auto";
}
export const remoteImageMode = () => mode;

/** True when `src` should show the placeholder now (click mode, another site, not clicked in this page view). */
export function waitsForClick(src) {
  return deferImage(src, mode, globalThis.location?.origin) && !allowed.has(src);
}

/**
 * The placeholder for a deferred picture. `onLoad()` runs after the click has allowed `src` (redraw the picture).
 * inline: a compact chip for inside a line of text.
 */
export function imagePlaceholder(src, alt, onLoad, { inline = false } = {}) {
  if (!watching && typeof globalThis.addEventListener === "function") {
    watching = true;
    globalThis.addEventListener("hashchange", () => allowed.clear());
  }
  const host = imageHost(src, globalThis.location?.origin) || "another site";
  const label = alt ? String(alt) : "Image";
  const btn = h("button", {
    type: "button",
    class: "rimg-load ichip-btn", // .ichip-btn: a text block doesn't enter edit mode on this click
    "aria-label": `Load image from ${host}${alt ? `: ${label}` : ""}`
  }, ico("image-down"), h("span", {}, "Load image"));
  const el = h(inline ? "span" : "div", { class: `rimg-ph${inline ? " inline" : ""}`, role: "group", "aria-label": `Image from ${host}, not loaded` },
    h("span", { class: "rimg-ico", "aria-hidden": "true" }, ico("image")),
    h("span", { class: "rimg-text" },
      h("span", { class: "rimg-alt" }, label),
      h("span", { class: "rimg-host" }, host)),
    btn);
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    allowed.add(src);
    onLoad?.();
  });
  return el;
}
