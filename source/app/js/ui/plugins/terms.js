// Plug-in module (terms): registers the {{term:<id>}} chip kind (registerChipKind in ../inlineChips.js) and the /Term
// slash entry (push onto CATALOG in ../../blocks/catalog.js). Imported once by app.js.
// Terms live on the repository page (repo.terms); the logic is in ../../terms.js and the helpers in ../termsUi.js.
import { h } from "../dom.js";
import { ico } from "../../icons/index.js";
import { registerChipKind } from "../inlineChips.js";
import { openModal } from "../modal.js";
import { toast } from "../dialogs.js";
import { CATALOG } from "../../blocks/catalog.js";
import { buildToken, tokenFallback } from "../../blocks/inline.js";
import {
  MAX_TERMS, MAX_TERM_TEXT, MAX_TERM_DEF, termsOf, categoriesOf, resolveTerm, treeOrder, filterTerms, termMatches, newTerm, cleanTerms
} from "../../terms.js";
import { repoOf, repaintOnTerms, saveTermData, termChipNode, attachCard, hideCard } from "../termsUi.js";

const miss = (title) => h("span", { class: "ichip ichip-miss", title }, ico("info"), h("span", {}, "Not found"));

function render(n, ctx) {
  const el = h("span", { class: "ichip-wrap" });
  const id = n.args[0];
  let res = null;
  repaintOnTerms(el, () => {
    const repo = repoOf(ctx);
    res = repo ? resolveTerm(termsOf(repo), categoriesOf(repo), id) : null;
    if (!res) {
      hideCard();
      return el.replaceChildren(miss("Term not found (deleted, or this page is in a repository without it)"));
    }
    const chip = termChipNode(res);
    attachCard(chip, () => res);
    el.replaceChildren(chip);
  });
  return el;
}

/** Plain text for Markdown export and copy: the term text in bold (the definition is dropped). */
function text(n, ctx) {
  const t = termsOf(repoOf(ctx)).find((x) => x.id === n.args[0]);
  return t ? `**${t.text.replace(/([*\\])/g, "\\$1")}**` : tokenFallback(n);
}

// ---------- picker ----------
function pick(ctx, { onPick, onCancel } = {}) {
  const repo = repoOf(ctx);
  if (!repo) {
    toast("There is no repository to hold terms.", "error");
    onCancel?.();
    return null;
  }
  let done = false;
  const body = h("div", { class: "ip term-pick" });
  const finish = (id) => {
    const token = buildToken("term", [id]);
    if (!token) return;
    done = true;
    modal.close();
    onPick?.(token);
  };
  const modal = openModal({
    title: "Insert term",
    content: body,
    actions: [{ label: "Cancel" }],
    onClose: () => {
      if (!done) onCancel?.();
    }
  });
  const input = h("input", { type: "search", class: "ip-search", placeholder: "Search terms…", "aria-label": "Search terms", autocomplete: "off", style: "font-size:16px" });
  const list = h("div", { class: "ip-list", role: "listbox", "aria-label": "Terms" });
  let shown = [];
  let active = 0;
  const draw = () => {
    const terms = termsOf(repo);
    const cats = categoriesOf(repo);
    shown = treeOrder(terms, filterTerms(terms, input.value)).slice(0, 200);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.length ? shown.map(({ term, depth }, i) => {
      const res = resolveTerm(terms, cats, term.id);
      const path = [res.category, res.subcategory].filter(Boolean).join(" › ");
      return h("button", {
        type: "button", role: "option", class: `ip-item term-pick-item${depth ? " is-branch" : ""}${i === active ? " active" : ""}`,
        "aria-selected": String(i === active), onClick: () => finish(term.id)
      }, termChipNode(res, { tag: "span" }), h("span", { class: "ip-hint" }, path));
    }) : [h("div", { class: "ip-empty" }, terms.length ? "No terms match." : "No terms yet. Create one below, or from the repository menu: Terms…")]);
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", () => {
    active = 0;
    draw();
    // a parent shown only as context is not the default choice
    if (input.value.trim()) {
      active = Math.max(0, shown.findIndex((x) => termMatches(x.term, input.value)));
      draw();
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      draw();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[active]) finish(shown[active].term.id);
    }
  });

  // new term form
  const nText = h("input", { type: "text", maxlength: MAX_TERM_TEXT, placeholder: "Term text", "aria-label": "New term text", autocomplete: "off", style: "font-size:16px" });
  const nDef = h("textarea", { rows: 2, maxlength: MAX_TERM_DEF, placeholder: "Definition (optional)", "aria-label": "New term definition", style: "font-size:16px" });
  const err = h("div", { class: "rp-error", role: "alert" });
  const create = async () => {
    err.textContent = "";
    if (termsOf(repo).length >= MAX_TERMS) return void (err.textContent = "That is the most terms a repository can hold.");
    const t = newTerm(nText.value, { definition: nDef.value });
    if (!t) return void (err.textContent = "Enter the term text.");
    try {
      await saveTermData(ctx.ws, repo, { terms: cleanTerms([...termsOf(repo), t]) });
    } catch (e) {
      return void (err.textContent = e?.message || "Could not save.");
    }
    finish(t.id);
  };
  nText.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      create();
    }
  });
  const form = h("details", { class: "term-new" },
    h("summary", {}, ico("plus"), " New term"),
    h("div", { class: "term-new-body" }, nText, nDef, err,
      h("div", { class: "ip-btns" }, h("button", { type: "button", class: "primary", onClick: create }, "Create and insert"))));
  body.replaceChildren(input, list, form);
  draw();
  setTimeout(() => input.focus(), 0);
  return null;
}

registerChipKind("term", { render, text, pick });

// ---------- /Term slash entry ----------
if (!CATALOG.some((e) => e.id === "iterm")) {
  CATALOG.push({
    id: "iterm", label: "Term", group: "Inline", keywords: "term glossary definition name word variable inline chip branch",
    make: () => null, inline: "term", icon: "book-a"
  });
}
