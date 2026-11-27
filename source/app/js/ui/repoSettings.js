// Repository settings dialog: constants ({{const:id}}, formulas), the status list ({{status:id}}) and terms ({{term:id}}).
// Reached from the repository's page menu in the sidebar (Constants… / Statuses… / Terms…). Edits save as you go and every chip
// updates live (constantsChanged event).
import { h, debounce } from "./dom.js";
import { ico } from "../icons/index.js";
import { openModal } from "./modal.js";
import { confirmDialog, toast } from "./dialogs.js";
import { constantsChanged } from "./inlineChips.js";
import { termsChanged } from "./termsUi.js";
import { createTermsPanel } from "./termsPanel.js";
import { HUES } from "../blocks/model.js";
import { setConstantsProvider } from "../formula.js";
import {
  CONST_TYPES, DATE_STYLES, MAX_CONSTANTS, MAX_STATUSES, NAME_RE,
  cleanConstants, cleanStatuses, coerceValue, constantsOf, constantResolver, countTokenUsers, findRepo, newStatus, statusList, validDate
} from "../constants.js";
import { newId } from "../ids.js";

/** Let database formulas resolve constants through their repository (call once at startup). */
export function installFormulaConstants(env) {
  setConstantsProvider((dbId) => {
    const repo = findRepo(env.pages(), dbId);
    return repo ? constantResolver(repo) : null;
  });
}

const TYPE_LABEL = { text: "Text", number: "Number", date: "Date" };
let uid = 0;
const fid = (p) => `${p}${++uid}`;
const field = (label, control, cls = "") => h("label", { class: `ip-field rs-field ${cls}` }, h("span", {}, label), control);
const errLine = () => h("div", { class: "rp-error rs-err", role: "alert" });
const showErr = (el, msg) => el.replaceChildren(...msg ? [ico("info"), ` ${msg}`] : []);

/** Every block list in the workspace: all pages, plus the rows of each database. */
async function blockLists(env) {
  const lists = env.pages().map((p) => p.blocks).filter(Boolean);
  for (const db of env.pages()) {
    if (db.type !== "database" || db.sourceId) continue;
    try {
      for (const r of await env.ws.listRows(db.id)) if (r.blocks) lists.push(r.blocks);
    } catch {
      // unreadable rows are skipped
    }
  }
  return lists;
}
/** Tokens of one kind/id across every page and row (blocks of all pages, synced blocks and row pages). */
const countUsers = async (env, kind, id) => countTokenUsers(await blockLists(env), kind, id);
const usedText = (n, what) => n === 0 ? `No ${what} use it.` : `${n} ${what.replace(/s$/, "")}${n === 1 ? "" : "s"} on pages use it and will show “Not found”.`;

export function openRepoSettings(env, repo, tab = "constants") {
  const repoId = repo.id;
  const current = () => env.pages().find((p) => p.id === repoId);
  let chain = Promise.resolve();
  // Saves are serialised and applied to the live page object (an open repository page may hold it for its own saves).
  const persist = (patch) => {
    chain = chain.then(async () => {
      const cur = current();
      if (!cur) return;
      for (const [k, v] of Object.entries(patch)) {
        if (v == null) delete cur[k];
        else cur[k] = v;
      }
      await env.ws.savePage(cur);
      await env.refresh();
      constantsChanged();
      termsChanged();
    }).catch((e) => toast(e?.message || "Could not save.", "error"));
    return chain;
  };

  // ---------- constants ----------
  const rows = constantsOf(current()).map((c) => ({ id: c.id, name: c.name, type: c.type, value: c.value == null ? "" : String(c.value), format: { ...c.format } }));
  const constPanel = h("div", { class: "rs-panel", role: "tabpanel" });
  const nameError = (r) => {
    const n = r.name.trim();
    if (!NAME_RE.test(n)) return "Name: letters, digits, _ or - (up to 40).";
    if (rows.some((o) => o !== r && o.name.trim().toLowerCase() === n.toLowerCase())) return "Another constant already has this name.";
    return "";
  };
  const valueError = (r) => {
    if (r.value === "") return "";
    if (r.type === "number" && coerceValue("number", r.value) === null) return "Not a number.";
    if (r.type === "date" && !validDate(r.value)) return "Use a valid date.";
    return "";
  };
  const saveConstants = () => {
    const list = rows.filter((r) => !nameError(r)).map((r) => ({
      id: r.id, name: r.name.trim(), type: r.type, value: coerceValue(r.type, r.value), format: r.type === "number"
        ? { decimals: r.format.decimals, thousands: r.format.thousands }
        : r.type === "date" ? { style: r.format.style } : null
    }));
    const cleaned = cleanConstants(list);
    return persist({ constants: cleaned.length ? cleaned : null });
  };
  const saveSoon = debounce(saveConstants, 300);
  function constRow(r) {
    const err = errLine();
    const check = () => showErr(err, nameError(r) || valueError(r));
    const name = h("input", { type: "text", maxlength: 40, value: r.name, id: fid("rsn"), autocomplete: "off", spellcheck: "false", style: "font-size:16px", "aria-label": "Constant name" });
    name.addEventListener("input", () => {
      r.name = name.value;
      check();
      saveSoon();
    });
    name.addEventListener("change", () => saveConstants());
    const type = h("select", { "aria-label": "Type", style: "font-size:16px" }, CONST_TYPES.map((t) => h("option", { value: t, selected: t === r.type }, TYPE_LABEL[t])));
    type.addEventListener("change", () => {
      r.type = type.value;
      r.format = {};
      if (r.type === "number" && coerceValue("number", r.value) === null) r.value = "";
      if (r.type === "date" && !validDate(r.value)) r.value = "";
      drawConstants();
      saveConstants();
    });
    const value = h("input", {
      type: r.type === "date" ? "date" : "text", inputmode: r.type === "number" ? "decimal" : null, maxlength: 500, value: r.value,
      "aria-label": "Value", autocomplete: "off", style: "font-size:16px"
    });
    value.addEventListener("input", () => {
      r.value = value.value;
      check();
      saveSoon();
    });
    value.addEventListener("change", () => saveConstants());
    let format = null;
    if (r.type === "number") {
      const dec = h("select", { "aria-label": "Decimals", style: "font-size:16px" }, [h("option", { value: "" }, "Auto"), ...[0, 1, 2, 3, 4, 6].map((d) => h("option", { value: d, selected: r.format.decimals === d }, `${d} decimal${d === 1 ? "" : "s"}`))]);
      const thou = h("input", { type: "checkbox", checked: !!r.format.thousands, "aria-label": "Thousands separator" });
      dec.addEventListener("change", () => {
        r.format.decimals = dec.value === "" ? void 0 : Number(dec.value);
        saveConstants();
      });
      thou.addEventListener("change", () => {
        r.format.thousands = thou.checked;
        saveConstants();
      });
      format = h("div", { class: "rs-format" }, field("Format", dec), h("label", { class: "ip-check" }, thou, h("span", {}, "1,000 separator")));
    } else if (r.type === "date") {
      const style = h("select", { "aria-label": "Date style", style: "font-size:16px" }, DATE_STYLES.map(([s, ex]) => h("option", { value: s, selected: (r.format.style ?? "iso") === s }, ex)));
      style.addEventListener("change", () => {
        r.format.style = style.value;
        saveConstants();
      });
      format = h("div", { class: "rs-format" }, field("Format", style));
    }
    const del = h("button", { type: "button", class: "danger rs-del", title: "Delete constant", "aria-label": `Delete constant ${r.name}` }, ico("trash"), h("span", { class: "rs-del-label" }, " Delete"));
    del.addEventListener("click", async () => {
      const n = await countUsers(env, "const", r.id);
      const ok = await confirmDialog(`Delete the constant “${r.name}”? ${usedText(n, "chips")} Formulas that use its name will show #NAME?.`, { title: "Delete constant", confirmLabel: "Delete" });
      if (!ok) return;
      rows.splice(rows.indexOf(r), 1);
      drawConstants();
      await saveConstants();
      toast("Constant deleted.");
    });
    check();
    return h("div", { class: "rs-item", "data-const": r.name },
      h("div", { class: "rs-grid" }, field("Name", name), field("Type", type), field("Value", value)),
      format, err, h("div", { class: "rs-actions" }, del));
  }
  function drawConstants() {
    constPanel.replaceChildren(
      h("p", { class: "hint rs-help" }, "Name a value once, use it anywhere in this repository. Type ", h("code", {}, "@name"), " in text for a chip, or use it in formulas as ", h("code", {}, 'const("name")'), " or the bare name."),
      ...rows.length ? rows.map(constRow) : [h("div", { class: "ip-empty" }, "No constants yet.")],
      h("div", { class: "ip-btns" }, h("button", { type: "button", class: "rs-add", onClick: () => {
        if (rows.length >= MAX_CONSTANTS) return toast("That is the most constants a repository can hold.", "error");
        let n = rows.length + 1;
        while (rows.some((o) => o.name.toLowerCase() === `constant${n}`)) n++;
        rows.push({ id: newId(), name: `constant${n}`, type: "text", value: "", format: {} });
        drawConstants();
        saveConstants();
        constPanel.querySelectorAll(".rs-item")[rows.length - 1]?.querySelector("input")?.select();
      } }, ico("plus"), " Add constant"))
    );
  }

  // ---------- statuses ----------
  const sts = statusList(current());
  const stPanel = h("div", { class: "rs-panel", role: "tabpanel" });
  const saveStatuses = () => persist({ statuses: cleanStatuses(sts) });
  const saveStSoon = debounce(saveStatuses, 300);
  function statusRow(s, i) {
    const label = h("input", { type: "text", maxlength: 40, value: s.label, autocomplete: "off", style: "font-size:16px", "aria-label": "Status label" });
    const sample = h("span", { class: "ichip ichip-status" }, ico("circle-dot"), h("span", {}, s.label || "Status"));
    sample.style.setProperty("--st-h", s.hue);
    label.addEventListener("input", () => {
      s.label = label.value;
      sample.lastChild.textContent = s.label || "Status";
      saveStSoon();
    });
    label.addEventListener("change", saveStatuses);
    const hue = h("select", { "aria-label": "Colour", style: "font-size:16px" }, HUES.map(([deg, nm]) => h("option", { value: deg, selected: deg === s.hue }, nm)));
    hue.addEventListener("change", () => {
      s.hue = Number(hue.value);
      sample.style.setProperty("--st-h", s.hue);
      saveStatuses();
    });
    const move = (dir) => {
      const j = i + dir;
      if (j < 0 || j >= sts.length) return;
      [sts[i], sts[j]] = [sts[j], sts[i]];
      drawStatuses();
      saveStatuses();
    };
    const up = h("button", { type: "button", class: "icon", title: "Move up", "aria-label": `Move ${s.label} up`, disabled: i === 0, onClick: () => move(-1) }, ico("chevron-up"));
    const down = h("button", { type: "button", class: "icon", title: "Move down", "aria-label": `Move ${s.label} down`, disabled: i === sts.length - 1, onClick: () => move(1) }, ico("chevron-down"));
    const del = h("button", { type: "button", class: "danger rs-del", title: "Delete status", "aria-label": `Delete status ${s.label}` }, ico("trash"));
    del.addEventListener("click", async () => {
      const n = await countUsers(env, "status", s.id);
      const ok = await confirmDialog(`Delete the status “${s.label}”? ${usedText(n, "tags")}`, { title: "Delete status", confirmLabel: "Delete" });
      if (!ok) return;
      sts.splice(sts.indexOf(s), 1);
      drawStatuses();
      await saveStatuses();
    });
    return h("div", { class: "rs-item rs-status", "data-status": s.label },
      h("div", { class: "rs-grid rs-grid-status" }, field("Label", label), field("Colour", hue)),
      h("div", { class: "rs-actions" }, sample, up, down, del));
  }
  function drawStatuses() {
    stPanel.replaceChildren(
      h("p", { class: "hint rs-help" }, "Tags for ", h("code", {}, "/Status tag"), ". Click a tag in text to switch it to another status."),
      ...sts.length ? sts.map(statusRow) : [h("div", { class: "ip-empty" }, "No statuses yet.")],
      h("div", { class: "ip-btns" }, h("button", { type: "button", class: "rs-add-status", onClick: () => {
        if (sts.length >= MAX_STATUSES) return toast("That is the most statuses a repository can hold.", "error");
        const st = newStatus("New status", HUES[sts.length % HUES.length][0]);
        if (!st) return;
        sts.push(st);
        drawStatuses();
        saveStatuses();
        stPanel.querySelectorAll(".rs-item")[sts.length - 1]?.querySelector("input")?.select();
      } }, ico("plus"), " Add status"))
    );
  }

  // ---------- terms ----------
  const termsTab = createTermsPanel({ current, persist, countLists: () => blockLists(env) });

  // ---------- tabs ----------
  const tabs = h("div", { class: "rs-tabs", role: "tablist" });
  const body = h("div", { class: "rs-body" });
  const tabBtn = (id, label, icon) => {
    const b = h("button", { type: "button", role: "tab", class: "rs-tab", "data-tab": id, id: `rs-tab-${id}` }, ico(icon), ` ${label}`);
    b.addEventListener("click", () => show(id));
    return b;
  };
  const tbs = { constants: tabBtn("constants", "Constants", "variable"), statuses: tabBtn("statuses", "Statuses", "circle-dot"), terms: tabBtn("terms", "Terms", "book-a") };
  const panels = { constants: constPanel, statuses: stPanel, terms: termsTab.el };
  tabs.append(tbs.constants, tbs.statuses, tbs.terms);
  function show(id) {
    for (const [k, b] of Object.entries(tbs)) {
      b.setAttribute("aria-selected", String(k === id));
      b.tabIndex = k === id ? 0 : -1;
      b.classList.toggle("active", k === id);
    }
    if (id === "constants") drawConstants();
    else if (id === "statuses") drawStatuses();
    else termsTab.redraw();
    body.replaceChildren(panels[id]);
  }
  tabs.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const order = Object.keys(tbs);
    const at = order.findIndex((k) => tbs[k].getAttribute("aria-selected") === "true");
    const id = order[(at + (e.key === "ArrowRight" ? 1 : -1) + order.length) % order.length];
    show(id);
    tbs[id].focus();
  });
  show(Object.hasOwn(tbs, tab) ? tab : "constants");
  return openModal({
    title: `${current()?.title || repo.title || "Repository"}: constants, statuses and terms`,
    content: h("div", { class: "rs" }, tabs, body),
    actions: [{ label: "Done", class: "primary" }]
  });
}
