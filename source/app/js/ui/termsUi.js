// Terms UI helpers shared by the chip plug-in (plugins/terms.js) and the repository dialog (repoSettings.js,
// termsPanel.js): the change event, the chip and definition card, saving, and the @-mention entries.
// Pure rules live in ../terms.js.
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { findRepo } from "../constants.js";
import { buildToken } from "../blocks/inline.js";
import { CONSTANTS_EVENT } from "./inlineChips.js";
import { termsOf, categoriesOf, resolveTerm, treeOrder, filterTerms } from "../terms.js";

// ---------- change event ----------
/** Fired after terms or category defaults change, so every chip repaints. */
export const TERMS_EVENT = "denotion:chip-terms";
export const termsChanged = () => document.dispatchEvent(new CustomEvent(TERMS_EVENT));
/** Run `fn` now and again on every terms / constants event for as long as `el` stays in the page. */
export function repaintOnTerms(el, fn) {
  const again = () => {
    if (!el.isConnected) {
      document.removeEventListener(TERMS_EVENT, again);
      document.removeEventListener(CONSTANTS_EVENT, again);
      return;
    }
    fn();
  };
  document.addEventListener(TERMS_EVENT, again);
  document.addEventListener(CONSTANTS_EVENT, again);
  fn();
}

export const repoOf = (ctx) => findRepo(ctx.livePages?.() ?? [], ctx.pageId);

/** Save repo.terms / repo.termCategories on the live repository page (empty lists remove the field). */
export async function saveTermData(ws, repo, { terms, categories }) {
  if (terms !== undefined) {
    if (terms.length) repo.terms = terms;
    else delete repo.terms;
  }
  if (categories !== undefined) {
    if (categories.length) repo.termCategories = categories;
    else delete repo.termCategories;
  }
  await ws.savePage(repo);
  termsChanged();
}

// ---------- icon and chip ----------
/** An icon node for a term: Lucide ("icon:name") or an emoji; always hidden from assistive tech (the text is the label). */
export function termIcon(icon) {
  const wrap = h("span", { class: "term-icon", "aria-hidden": "true" });
  if (typeof icon === "string" && icon.startsWith("icon:")) wrap.append(ico(icon.slice(5)));
  else wrap.append(document.createTextNode(icon ?? ""));
  return wrap;
}
export const hueStyle = (hue) => hue == null ? null : `--term-h:${hue}`;

/** Bold text, then the icon, tinted by the hue (when set). A button so a tap works and the editor does not start editing. */
export function termChipNode(res, { tag = "button" } = {}) {
  const el = h(tag, { class: `ichip ichip-btn ichip-term${res.hue == null ? "" : " has-hue"}${res.parent ? " is-branch" : ""}`, style: hueStyle(res.hue) },
    h("strong", { class: "term-text" }, res.text), res.icon ? termIcon(res.icon) : null);
  if (tag === "button") el.type = "button";
  return el;
}

// ---------- definition card ----------
const CARD_ID = "term-card";
let card = null;
let shownFor = null;
let pinned = false;
let timer = 0;
let wired = false;

function cardBody(res) {
  const path = [res.category, res.subcategory].filter(Boolean).join(" › ");
  const own = res.definition;
  const parentDef = res.parent?.definition;
  return [
    h("div", { class: "term-card-head" }, h("strong", {}, res.text), res.icon ? termIcon(res.icon) : null),
    path ? h("div", { class: "term-card-cat" }, path) : null,
    res.parent ? h("div", { class: "term-card-branch" }, "Branch of ", h("strong", {}, res.parent.text)) : null,
    own ? h("p", { class: "term-card-def" }, own) : null,
    parentDef ? h("p", { class: "term-card-def term-card-parent" }, h("span", { class: "term-card-from" }, `${res.parent.text}: `), parentDef) : null
  ].filter(Boolean);
}
/** True when a card would show something beyond the chip itself. */
export const hasCard = (res) => !!(res.definition || res.parent || res.category);

function place(chip) {
  const r = chip.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  card.style.left = "0px";
  card.style.top = "0px";
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const left = Math.max(8, Math.min(r.left, vw - cw - 8));
  const below = r.bottom + 6;
  const top = below + ch + 8 <= vh || r.top - ch - 6 < 8 ? below : r.top - ch - 6;
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(Math.max(8, top))}px`;
}
export function hideCard() {
  clearTimeout(timer);
  if (shownFor) shownFor.removeAttribute("aria-describedby");
  shownFor = null;
  pinned = false;
  if (card) card.hidden = true;
}
function wire() {
  if (wired) return;
  wired = true;
  // Esc closes the card first (and only the card)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !shownFor) return;
    hideCard();
    e.stopPropagation();
  }, true);
  document.addEventListener("pointerdown", (e) => {
    if (shownFor && !shownFor.contains(e.target)) hideCard();
  }, true);
  window.addEventListener("scroll", () => shownFor && hideCard(), true);
  window.addEventListener("resize", () => shownFor && hideCard());
  document.addEventListener("denotation:close-popovers", () => hideCard());
  window.addEventListener("hashchange", () => hideCard());
}
export function showCard(chip, res, { pin = false } = {}) {
  if (!hasCard(res)) return;
  wire();
  clearTimeout(timer);
  if (!card) {
    card = h("div", { id: CARD_ID, class: "term-card", role: "tooltip", hidden: true });
    document.body.append(card);
  }
  if (shownFor && shownFor !== chip) shownFor.removeAttribute("aria-describedby");
  card.replaceChildren(...cardBody(res));
  card.hidden = false;
  shownFor = chip;
  pinned = pin;
  chip.setAttribute("aria-describedby", CARD_ID);
  place(chip);
}
/**
 * Wire a chip button to the card: hover (mouse) after a short delay, keyboard focus, and click / tap to pin it.
 * `getRes()` returns the current resolved term so edits show without re-wiring.
 */
export function attachCard(chip, getRes) {
  const later = (fn, ms) => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
  chip.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse" || pinned && shownFor !== chip) return;
    later(() => showCard(chip, getRes()), 180);
  });
  chip.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(timer);
    if (shownFor === chip && !pinned) later(hideCard, 120);
  });
  chip.addEventListener("focus", () => {
    if (!chip.matches(":focus-visible")) return; // a mouse press is handled by click
    showCard(chip, getRes());
  });
  chip.addEventListener("blur", () => {
    if (shownFor === chip) hideCard();
  });
  chip.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (shownFor === chip && pinned) return hideCard();
    showCard(chip, getRes(), { pin: true });
  });
}

// ---------- @ mention entries ----------
/**
 * Menu items for the editor's @ dropdown: terms whose text contains the query (starts-with first), as chips.
 * put(token) inserts the token text. Returns [] when the repository has no terms.
 */
export function termMentionItems(ctx, query, put, limit = 5) {
  const repo = repoOf(ctx);
  const terms = termsOf(repo);
  if (!terms.length) return [];
  const q = String(query ?? "").trim().toLowerCase();
  const keep = filterTerms(terms, q);
  const cats = categoriesOf(repo);
  return treeOrder(terms, keep)
    .map((x) => x.term)
    .filter((t) => !q || t.text.toLowerCase().includes(q))
    .sort((a, b) => Number(b.text.toLowerCase().startsWith(q)) - Number(a.text.toLowerCase().startsWith(q)))
    .slice(0, limit)
    .map((t) => {
      const res = resolveTerm(terms, cats, t.id);
      return {
        label: res.parent ? `${t.text} (${res.parent.text})` : t.text,
        icon: ico("book-a"),
        hint: "term",
        onSelect: () => put(buildToken("term", [t.id]))
      };
    });
}
