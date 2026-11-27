// The Terms tab of the repository dialog: terms grouped by category and subcategory (branches indented under their base
// term), search, create / edit / delete, "Add branch", and per-category default colour and icon.
// Rules and data live in ../terms.js. repoSettings.js owns the dialog and hands in `persist` (serialised saves).
import { h, debounce } from "./dom.js";
import { ico } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { openModal } from "./modal.js";
import { confirmDialog, toast } from "./dialogs.js";
import { pickEmoji } from "./emoji.js";
import { HUES } from "../blocks/model.js";
import {
  MAX_TERMS, MAX_TERM_TEXT, MAX_TERM_DEF, MAX_TERM_CAT, cleanTerms, cleanCategories, cleanIcon, termsOf, categoriesOf, newTerm, canBranch,
  resolveTerm, groupTerms, filterTerms, categoryNames, subcategoryNames, countTermUsers, deleteTerm, renameCategory, childrenOf
} from "../terms.js";
import { termChipNode, termIcon } from "./termsUi.js";

let uid = 0;
const fid = (p) => `${p}${++uid}`;
const clone = (list) => list.map((x) => ({ ...x }));
const hueName = (hue) => HUES.find(([d]) => d === hue)?.[1] ?? "";
const field = (label, control, cls = "") => h("label", { class: `ip-field rs-field ${cls}` }, h("span", {}, label), control);
const snippet = (s, n = 90) => s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** Ask what to do with the branches of a term being deleted: "delete", "keep" or null (cancel). */
function askBranches(term, count, kids) {
  return new Promise((resolve) => {
    const names = kids.slice(0, 5).map((k) => k.text).join(", ") + (kids.length > 5 ? "…" : "");
    openModal({
      title: "Delete term",
      content: h("div", {},
        h("p", {}, `Delete the term “${term.text}”? It has ${kids.length} branch${kids.length === 1 ? "" : "es"} (${names}).`),
        h("p", { class: "hint" }, count === 0 ? "No chips on pages use them." : `${count} chip${count === 1 ? "" : "s"} on pages use it and its branches and will show “Not found” once deleted.`),
        h("p", { class: "hint" }, "Keep the branches as plain terms, or delete them as well?")),
      actions: [
        { label: "Cancel" },
        { label: "Keep branches", run: () => resolve("keep") },
        { label: "Delete branches too", class: "danger", run: () => resolve("delete") }
      ],
      onClose: () => resolve(null)
    });
  });
}

/**
 * Build the panel. `current()` returns the live repository page; `persist(patch)` saves fields of it (null removes one);
 * `countLists()` resolves every block list in the workspace (pages and rows) for usage counts.
 */
export function createTermsPanel({ current, persist, countLists }) {
  const panel = h("div", { class: "rs-panel tm", role: "tabpanel" });
  let terms = clone(cleanTerms(termsOf(current())));
  let cats = cleanCategories(clone(categoriesOf(current())));
  let query = "";
  let editing = null;
  let focusNext = null;

  const save = () => persist({
    terms: cleanTerms(terms).length ? cleanTerms(terms) : null,
    termCategories: cleanCategories(cats).length ? cleanCategories(cats) : null
  });
  const saveSoon = debounce(save, 300);
  const resOf = (t) => resolveTerm(terms, cats, t.id);
  const catOf = (name) => cats.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const setCatDefault = (name, key, value) => {
    let c = catOf(name);
    if (!c) cats.push(c = { name });
    if (value == null) delete c[key];
    else c[key] = value;
    if (c.hue === undefined && !c.icon) cats = cats.filter((x) => x !== c);
  };

  // ---------- pickers ----------
  const hueSelect = (value, inheritedLabel, onChange, label) => {
    const sel = h("select", { "aria-label": label, style: "font-size:16px" },
      h("option", { value: "" }, inheritedLabel),
      ...HUES.map(([deg, nm]) => h("option", { value: deg, selected: value === deg }, nm)));
    sel.addEventListener("change", () => onChange(sel.value === "" ? null : Number(sel.value)));
    return sel;
  };
  const iconControl = (value, inherited, onChange, label) => {
    const shown = value ?? inherited;
    const btn = h("button", { type: "button", class: "tm-icon-btn", "aria-label": `${label}: ${shown ? "change" : "choose"}`, title: label },
      shown ? termIcon(shown) : ico("plus"), h("span", {}, shown ? (value ? "" : " inherited") : " none"));
    btn.addEventListener("click", () => pickEmoji(btn, (v) => onChange(v ? cleanIcon(v) : null), { removable: !!value }));
    const emoji = h("input", { type: "text", maxlength: 8, placeholder: "Emoji", "aria-label": `${label} (emoji)`, value: value && !value.startsWith("icon:") ? value : "", style: "font-size:16px;width:5.5em" });
    emoji.addEventListener("change", () => {
      const v = emoji.value.trim();
      if (!v) return onChange(null);
      const ok = cleanIcon(v);
      if (!ok || ok.startsWith("icon:")) {
        toast("Use an emoji or pick a Lucide icon.", "error");
        emoji.value = "";
        return;
      }
      onChange(ok);
    });
    const clear = value ? h("button", { type: "button", class: "icon", title: `Remove ${label.toLowerCase()}`, "aria-label": `Remove ${label.toLowerCase()}`, onClick: () => onChange(null) }, ico("x")) : null;
    return h("div", { class: "tm-icon-row" }, btn, emoji, clear);
  };

  // ---------- editor ----------
  function editor(t) {
    const err = h("div", { class: "rp-error rs-err", role: "alert" });
    const showErr = (m) => err.replaceChildren(...m ? [ico("info"), ` ${m}`] : []);
    const text = h("input", { type: "text", maxlength: MAX_TERM_TEXT, value: t.text, autocomplete: "off", style: "font-size:16px", "aria-label": "Term text" });
    text.addEventListener("input", () => {
      if (!text.value.trim()) return showErr("Enter the term text.");
      showErr("");
      t.text = text.value;
      saveSoon();
    });
    text.addEventListener("change", () => {
      if (!text.value.trim()) text.value = t.text;
      showErr("");
      draw();
    });
    const def = h("textarea", { rows: 3, maxlength: MAX_TERM_DEF, "aria-label": "Definition", placeholder: "Shown on hover, focus or tap", style: "font-size:16px" });
    def.value = t.definition ?? "";
    def.addEventListener("input", () => {
      if (def.value.trim()) t.definition = def.value;
      else delete t.definition;
      saveSoon();
    });
    const isBranch = !!t.parentId;
    const r = resOf(t);
    const dlCat = fid("tmc");
    const dlSub = fid("tms");
    const catIn = h("input", { type: "text", maxlength: MAX_TERM_CAT, value: t.category ?? "", list: dlCat, autocomplete: "off", style: "font-size:16px", placeholder: isBranch && r?.category ? `Inherited: ${r.category}` : "Optional", "aria-label": "Category" });
    const subIn = h("input", { type: "text", maxlength: MAX_TERM_CAT, value: t.subcategory ?? "", list: dlSub, autocomplete: "off", style: "font-size:16px", placeholder: isBranch && r?.subcategory ? `Inherited: ${r.subcategory}` : "Optional", "aria-label": "Subcategory", disabled: !t.category && !isBranch });
    catIn.addEventListener("change", () => {
      const v = catIn.value.trim().slice(0, MAX_TERM_CAT);
      if (v) t.category = v;
      else {
        delete t.category;
        delete t.subcategory;
      }
      save();
      draw();
    });
    subIn.addEventListener("change", () => {
      const v = subIn.value.trim().slice(0, MAX_TERM_CAT);
      if (v && (t.category || isBranch)) t.subcategory = v;
      else delete t.subcategory;
      save();
      draw();
    });
    const noOwn = { ...t };
    delete noOwn.hue;
    delete noOwn.icon;
    const inh = resolveTerm(terms.map((x) => x.id === t.id ? noOwn : x), cats, t.id);
    const hue = hueSelect(t.hue ?? null, inh?.hue != null ? `Inherit (${hueName(inh.hue)})` : "None", (v) => {
      if (v === null) delete t.hue;
      else t.hue = v;
      save();
      draw();
    }, "Colour");
    const icon = iconControl(t.icon ?? null, inh?.icon ?? null, (v) => {
      if (v) t.icon = v;
      else delete t.icon;
      save();
      draw();
    }, "Icon");
    let parent = null;
    if (childrenOf(terms, t.id).length) parent = h("p", { class: "hint" }, `Base term with ${childrenOf(terms, t.id).length} branch${childrenOf(terms, t.id).length === 1 ? "" : "es"}.`);
    else {
      const bases = terms.filter((x) => canBranch(terms, t.id, x.id)).sort((a, b) => a.text.localeCompare(b.text));
      const sel = h("select", { "aria-label": "Branch of", style: "font-size:16px" },
        h("option", { value: "" }, "None (a base term)"),
        ...bases.map((b) => h("option", { value: b.id, selected: b.id === t.parentId }, b.text)));
      sel.addEventListener("change", () => {
        if (sel.value) t.parentId = sel.value;
        else delete t.parentId;
        save();
        draw();
      });
      parent = field("Branch of", sel);
    }
    const sample = h("div", { class: "tm-sample" }, h("span", { class: "hint" }, "Preview "), termChipNode(r ?? { text: t.text }, { tag: "span" }));
    const done = h("button", { type: "button", class: "tm-done", onClick: () => {
      editing = null;
      draw();
    } }, ico("check"), " Done");
    const del = h("button", { type: "button", class: "danger rs-del", onClick: () => remove(t) }, ico("trash"), " Delete");
    const box = h("div", { class: "rs-item tm-editor", "data-editing": t.text },
      h("div", { class: "rs-grid tm-grid-2" }, field("Text", text), parent),
      field("Definition", def),
      h("div", { class: "rs-grid tm-grid-2" }, field("Category", catIn), field("Subcategory", subIn)),
      h("datalist", { id: dlCat }, ...categoryNames(terms).map((c) => h("option", { value: c }))),
      h("datalist", { id: dlSub }, ...subcategoryNames(terms, t.category ?? r?.category ?? "").map((c) => h("option", { value: c }))),
      h("div", { class: "rs-grid tm-grid-2" }, field("Colour", hue), h("div", { class: "ip-field rs-field" }, h("span", {}, "Icon (right of the text)"), icon)),
      err, sample, h("div", { class: "rs-actions" }, del, done));
    return box;
  }

  // ---------- actions ----------
  async function remove(t) {
    const kids = childrenOf(terms, t.id);
    const lists = await countLists();
    const own = countTermUsers(lists, terms, t.id, false);
    const all = countTermUsers(lists, terms, t.id, true);
    let mode = "keep";
    if (kids.length) {
      mode = await askBranches(t, all, kids);
      if (!mode) return;
    } else {
      const used = own === 0 ? "No chips use it." : `${own} chip${own === 1 ? "" : "s"} on pages use it and will show “Not found”.`;
      if (!await confirmDialog(`Delete the term “${t.text}”? ${used}`, { title: "Delete term", confirmLabel: "Delete" })) return;
    }
    const res = deleteTerm(terms, t.id, mode, cats);
    terms = clone(res.terms);
    if (res.removed.includes(editing)) editing = null;
    draw();
    await save();
    toast("Term deleted.");
  }
  function add(parentId = null) {
    if (terms.length >= MAX_TERMS) return toast("That is the most terms a repository can hold.", "error");
    let name = parentId ? "New branch" : "New term";
    let n = 1;
    while (terms.some((x) => x.text.toLowerCase() === name.toLowerCase())) name = `${parentId ? "New branch" : "New term"} ${++n}`;
    const t = newTerm(name, parentId ? { parentId } : {});
    if (!t) return;
    terms.push(t);
    query = "";
    editing = t.id;
    focusNext = t.id;
    draw();
    save();
  }
  function menuFor(t, anchor) {
    const items = [
      { label: "Edit", icon: ico("pencil"), onSelect: () => {
        editing = editing === t.id ? null : t.id;
        focusNext = editing;
        draw();
      } },
      !t.parentId ? { label: "Add branch", icon: ico("git-branch-plus"), onSelect: () => add(t.id) } : null,
      { separator: true },
      { label: "Delete…", icon: ico("trash"), danger: true, onSelect: () => remove(t) }
    ].filter(Boolean);
    openMenu(anchor, items, { width: 200 });
  }

  // ---------- list ----------
  function row(t, depth) {
    const r = resOf(t);
    const more = h("button", { type: "button", class: "icon tm-more", title: "Term menu", "aria-label": `Menu for ${t.text}`, "aria-haspopup": "menu" }, ico("ellipsis"));
    more.addEventListener("click", () => menuFor(t, more));
    const edit = h("button", { type: "button", class: "icon", title: "Edit term", "aria-label": `Edit ${t.text}`, "aria-expanded": String(editing === t.id) }, ico("pencil"));
    edit.addEventListener("click", () => {
      editing = editing === t.id ? null : t.id;
      focusNext = editing;
      draw();
    });
    const meta = [t.parentId && r.parent ? `Branch of ${r.parent.text}` : null, r.definition ? snippet(r.definition.replace(/\n+/g, " ")) : null].filter(Boolean).join(" · ");
    const kids = childrenOf(terms, t.id).length;
    return h("div", { class: `tm-row${depth ? " is-branch" : ""}`, "data-term": t.text, role: "listitem" },
      h("div", { class: "tm-main" }, termChipNode(r, { tag: "span" }), kids ? h("span", { class: "tm-count", title: `${kids} branch${kids === 1 ? "" : "es"}` }, ico("git-branch"), ` ${kids}`) : null,
        meta ? h("span", { class: "tm-meta" }, meta) : null),
      h("div", { class: "tm-acts" }, edit, more));
  }
  function defaults(names) {
    if (!names.length) return null;
    return h("details", { class: "tm-defaults", open: cats.length > 0 },
      h("summary", {}, ico("palette"), " Category colour and icon"),
      h("p", { class: "hint" }, "Terms in a category use its colour and icon unless they set their own. Branches follow their base term."),
      ...names.map((name) => {
        const c = catOf(name) ?? {};
        const nm = h("input", { type: "text", maxlength: MAX_TERM_CAT, value: name, "aria-label": `Rename category ${name}`, style: "font-size:16px" });
        nm.addEventListener("change", () => {
          const v = nm.value.trim();
          if (!v || v === name) return void (nm.value = name);
          const res = renameCategory(terms, cats, name, v);
          terms = clone(res.terms);
          cats = clone(res.categories);
          draw();
          save();
        });
        const hue = hueSelect(c.hue ?? null, "None", (v) => {
          setCatDefault(name, "hue", v);
          save();
          draw();
        }, `Colour for ${name}`);
        const icon = iconControl(c.icon ?? null, null, (v) => {
          setCatDefault(name, "icon", v || null);
          save();
          draw();
        }, `Icon for ${name}`);
        return h("div", { class: "tm-def-row", "data-category": name }, field("Category", nm), field("Colour", hue), h("div", { class: "ip-field rs-field" }, h("span", {}, "Icon"), icon));
      }));
  }
  function draw() {
    const keep = filterTerms(terms, query);
    const groups = groupTerms(terms, keep);
    const search = h("input", { type: "search", class: "ip-search tm-search", placeholder: "Search terms…", "aria-label": "Search terms", value: query, autocomplete: "off", style: "font-size:16px" });
    search.addEventListener("input", () => {
      query = search.value;
      const pos = search.selectionStart;
      draw();
      const s = panel.querySelector(".tm-search");
      s?.focus();
      s?.setSelectionRange(pos, pos);
    });
    const names = categoryNames(terms);
    const body = [];
    for (const g of groups) {
      body.push(h("h4", { class: "tm-cat" }, g.category ? [ico("tags"), ` ${g.category}`] : "No category"));
      for (const s of g.subs) {
        if (s.sub) body.push(h("h5", { class: "tm-sub" }, s.sub));
        for (const { term, depth } of s.items) {
          body.push(row(term, depth));
          if (editing === term.id) body.push(editor(term));
        }
      }
    }
    panel.replaceChildren(
      h("p", { class: "hint rs-help" }, "Name a word once, use it anywhere in this repository. Type ", h("code", {}, "@name"), " or ", h("code", {}, "/Term"), " in text for a bold chip. Edit it here and every chip updates."),
      h("div", { class: "tm-bar" }, search, h("button", { type: "button", class: "rs-add-term", onClick: () => add() }, ico("plus"), " Add term")),
      defaults(names),
      h("div", { class: "tm-list", role: "list", "aria-label": "Terms" }, ...body.length ? body : [h("div", { class: "ip-empty" }, terms.length ? "No terms match." : "No terms yet.")])
    );
    if (focusNext) {
      const id = focusNext;
      focusNext = null;
      const el = panel.querySelector(".tm-editor input");
      if (editing === id && el) {
        el.focus();
        el.select();
        el.scrollIntoView({ block: "nearest" });
      }
    }
  }
  draw();
  return { el: panel, redraw: draw };
}
