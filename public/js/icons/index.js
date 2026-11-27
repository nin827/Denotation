import { ICONS } from "./lucide-data.js";

const PREFIX = "icon:";
export const iconCount = () => Object.keys(ICONS).length;
const isIcon = (v) => typeof v === "string" && v.startsWith(PREFIX) && Object.hasOwn(ICONS, v.slice(PREFIX.length));
export const iconValue = (name) => `${PREFIX}${name}`;
const protos = new Map(); // one parsed <span><svg>…</svg></span> per icon name, cloned on each use
export function svgFor(name) {
  if (!Object.hasOwn(ICONS, name)) {
    const e = document.createElement("span");
    e.className = "icon-svg";
    return e;
  }
  let proto = protos.get(name);
  if (!proto) {
    proto = document.createElement("span");
    proto.className = "icon-svg";
    proto.setAttribute("aria-hidden", "true");
    proto.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name][0]}</svg>`;
    protos.set(name, proto);
  }
  return proto.cloneNode(true);
}
export const ico = svgFor;
const LEGACY = Object.fromEntries(Object.entries({
  "\u{1F4C4}": "file-text",
  "\u{1F4DD}": "pencil",
  "\u{1F4CC}": "pin",
  "\u{1F4CE}": "paperclip",
  "\u{1F4DA}": "library",
  "\u{1F4D3}": "notebook",
  "\u{1F4C5}": "calendar",
  "\u{1F4CA}": "chart-column",
  "\u{1F4C8}": "chart-line",
  "\u{1F5C2}\uFE0F": "folder-open",
  "\u{1F5C3}\uFE0F": "database",
  "\u{1F9E0}": "brain",
  "\u{1F4A1}": "lightbulb",
  "\u{1F525}": "flame",
  "\u2B50": "star",
  "\u2705": "circle-check",
  "\u26A0\uFE0F": "info",
  "\u2757": "info",
  "\u2753": "info",
  "\u{1F3AF}": "target",
  "\u{1F680}": "rocket",
  "\u{1F6E0}\uFE0F": "wrench",
  "\u{1F9EA}": "flask-conical",
  "\u{1F3A8}": "palette",
  "\u{1F3E0}": "house",
  "\u{1F331}": "sprout",
  "\u{1F34E}": "apple",
  "\u2615": "coffee",
  "\u{1F3B5}": "music",
  "\u2708\uFE0F": "plane",
  "\u{1F4AC}": "message-square",
  "\u{1F512}": "lock",
  "\u{1F44B}": "hand",
  "\u{1F5D1}": "trash"
}).filter(([, name]) => Object.hasOwn(ICONS, name)));
const nameOf = (v) => isIcon(v) ? v.slice(PREFIX.length) : LEGACY[v] ?? null;
export function iconNode(value, fallback = "") {
  const name = nameOf(value) ?? nameOf(fallback);
  if (name) return svgFor(name);
  return document.createTextNode(value || "");
}
export const pageIcon = (p) => iconNode(p?.icon, p?.type === "database" ? p.sourceId ? "icon:link-2" : "icon:database" : p?.type === "repo" ? "icon:library" : "icon:file-text");
let index = null;
export function searchIcons(query) {
  index ?? (index = Object.entries(ICONS).map(([name, [, tags]]) => ({ name, hay: `${name.replace(/-/g, " ")} ${tags}` })));
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return index.map((i) => i.name);
  const out = [];
  for (const { name, hay } of index) {
    if (!words.every((w) => hay.includes(w))) continue;
    out.push([name.startsWith(words[0]) ? 0 : name.includes(words[0]) ? 1 : 2, name]);
  }
  return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}
