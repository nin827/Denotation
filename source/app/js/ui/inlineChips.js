// Inline chips ({{value}}, {{date}}, {{preset}}, {{const}}, {{page}}, {{check}}, {{status}}, {{= formula}}): rendering, the
// insert pickers, token clicks (checkbox, status) and plain-text resolution for export.
// Token grammar and parsing live in blocks/inline.js; the lookup logic in preview.js; constants in constants.js.
import { h } from "./dom.js";
import { ico, pageIcon } from "../icons/index.js";
import { openModal } from "./modal.js";
import { openMenu } from "./popover.js";
import { buildToken, scanTokens, tokenFallback } from "../blocks/inline.js";
import { findRepo, constantById, constantsOf, constantResolver, formatConstant, statusList, statusById } from "../constants.js";
import { check as checkFormula, evalExpression, formulaRefs, lookupError, formatResult } from "../formula.js";
import { resolveValue, keyList, matchKeys, listChipPresets, findChipPreset, resolvePreset, presetKey, cleanChipPresets, newChipPreset, countChipPresetUsers, presetNameTaken } from "../preview.js";
import { walk } from "../blocks/model.js";
import { confirmDialog, toast } from "./dialogs.js";
import { sourceList, sourceLabel, isTableSourceId, findTableSource, tableSources } from "../sources.js";

// ---------- data ----------
const CACHE_MS = 300; // enough to share one load between all chips of a render, short enough to see edits
const cache = new Map();
function rowsOf(ctx, dbId) {
  // a table block used as a data source: its rows come from the block, not the store
  if (isTableSourceId(dbId)) return Promise.resolve(findTableSource(ctx.livePages(), dbId)?.rows ?? []);
  const k = `${dbId}`;
  const hit = cache.get(k);
  if (hit && hit.ws === ctx.ws && Date.now() - hit.t < CACHE_MS) return hit.p;
  const p = Promise.resolve(ctx.ws.listRows(dbId)).catch(() => []);
  cache.set(k, { t: Date.now(), ws: ctx.ws, p });
  return p;
}
export const clearInlineCache = () => cache.clear();
// Preset edits (rename, column change, delete) tell every chip on the page to look itself up again.
const PRESETS_EVENT = "denotion:chip-presets";
const presetsChanged = () => {
  cache.clear();
  document.dispatchEvent(new CustomEvent(PRESETS_EVENT));
};
// Constant and status edits (repository dialog) do the same.
export const CONSTANTS_EVENT = "denotion:chip-constants";
export const constantsChanged = () => {
  cache.clear();
  document.dispatchEvent(new CustomEvent(CONSTANTS_EVENT));
};
const repoFor = (ctx) => findRepo(ctx.livePages(), ctx.pageId);
const norm = (s) => String(s ?? "").trim().toLowerCase();
/** A chip wrapper that paints `run()` (a node or a promise of one) now and again on every chip event. */
function liveChip(run) {
  const el = h("span", { class: "ichip-wrap" });
  const fail = () => el.replaceChildren(miss("Not found", "Lookup failed"));
  const paint = () => {
    try {
      const r = run();
      if (r && typeof r.then === "function") r.then((node) => el.replaceChildren(node)).catch(fail);
      else el.replaceChildren(r);
    } catch {
      fail();
    }
  };
  const again = () => {
    if (!el.isConnected) {
      document.removeEventListener(PRESETS_EVENT, again);
      document.removeEventListener(CONSTANTS_EVENT, again);
      return;
    }
    paint();
  };
  document.addEventListener(PRESETS_EVENT, again);
  document.addEventListener(CONSTANTS_EVENT, again);
  paint();
  return el;
}

/** The database page behind an id (a linked view resolves to its source), or a state string. */
function findDb(ctx, id) {
  if (isTableSourceId(id)) {
    const t = findTableSource(ctx.livePages(), id);
    return t ? { state: "ok", db: t, title: sourceLabel(t) } : { state: "missing" };
  }
  const info = ctx.pageInfo?.(id);
  if (!info || info.state === "missing") return { state: "missing" };
  if (info.state === "trashed" || info.state === "archived") return { state: info.state };
  const pages = ctx.livePages();
  const page = pages.find((p) => p.id === id);
  const data = page?.sourceId ? pages.find((p) => p.id === page.sourceId) : page;
  return data && data.type === "database" ? { state: "ok", db: data, title: page.title || data.title || "Untitled" } : { state: "missing" };
}

// ---------- rendering ----------
const friendlyDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
};
const miss = (label, title) => h("span", { class: "ichip ichip-miss", title }, ico("info"), h("span", {}, label));

/** A DOM node for one inline token node. Never uses innerHTML; args are only set as text or attributes. */
export function inlineChip(n, ctx) {
  if (n.kind === "date") {
    return h("span", { class: "ichip ichip-date", title: n.args[0] }, ico("calendar"), h("span", {}, friendlyDate(n.args[0])));
  }
  if (n.kind === "check") return checkChip(n, ctx);
  if (ctx?.livePages) {
    if (n.kind === "const") return constChip(n, ctx);
    if (n.kind === "page") return pageChip(n, ctx);
    if (n.kind === "status") return statusChip(n, ctx);
    if (n.kind === "formula" && ctx.ws) return formulaChip(n, ctx);
  }
  if (n.kind === "preset" && ctx?.ws) return presetChip(n, ctx);
  if (n.kind !== "value" || !ctx?.ws) return document.createTextNode(`{{${n.kind}}}`);
  const [dbId, key, colId] = n.args;
  const el = h("span", { class: "ichip-wrap" }, h("span", { class: "ichip ichip-value loading", title: `${key}` }, h("span", {}, "\u2026")));
  const fill = (node) => el.replaceChildren(node);
  (async () => {
    const f = findDb(ctx, dbId);
    if (f.state === "trashed") return fill(miss("In trash", `Database is in the trash › ${key}`));
    if (f.state === "archived") return fill(miss("Archived", `Database is archived › ${key}`));
    if (f.state !== "ok") return fill(miss("Not found", `Database not found › ${key}`));
    const res = resolveValue(f.db, await rowsOf(ctx, f.db.id), key, colId);
    const path = `${f.title} › ${key} › ${res.col?.name ?? "Column"}`;
    if (res.state === "norow") return fill(miss("Not found", `No row with key "${key}" in ${f.title}`));
    if (res.state === "nocol") return fill(miss("Not found", `Column not found › ${f.title} › ${key}`));
    const a = h("a", { class: "ichip ichip-value", href: f.db.virtual ? `#page-${f.db.pageId}` : `#row-${res.row.id}`, title: path }, res.text === "" ? h("span", { class: "ichip-empty" }, "(empty)") : res.text);
    fill(a);
  })().catch(() => fill(miss("Not found", "Lookup failed")));
  return el;
}

// ---------- constants, pages, checkboxes, statuses, formulas ----------
const emptyText = () => h("span", { class: "ichip-empty" }, "(empty)");
function constChip(n, ctx) {
  return liveChip(() => {
    const c = constantById(repoFor(ctx), n.args[0]);
    if (!c) return miss("Not found", "Constant not found (deleted, or this page is in a repository without it)");
    const text = formatConstant(c);
    return h("span", { class: `ichip ichip-const ichip-${c.type}`, title: `${c.name} = ${text || "(empty)"}` }, ico("variable"), text === "" ? emptyText() : h("span", {}, text));
  });
}
function pageChip(n, ctx) {
  const id = n.args[0];
  return liveChip(() => {
    const info = ctx.pageInfo?.(id);
    if (!info || info.state === "missing") return miss("Not found", "Page not found");
    if (info.state === "trashed") return miss("In trash", `${info.title || "Untitled"} is in the trash`);
    if (info.state === "archived") return miss("Archived", `${info.title || "Untitled"} is archived`);
    const p = ctx.livePages().find((x) => x.id === id) ?? info;
    return h("a", { class: "ichip ichip-page", href: `#page-${id}`, title: `Open ${p.title || "Untitled"}` }, pageIcon(p), h("span", {}, p.title || "Untitled"));
  });
}
function checkChip(n, ctx) {
  const on = n.args[0] === "1";
  return h(
    "button",
    {
      type: "button",
      class: `ichip-check ichip-btn${on ? " on" : ""}`,
      role: "checkbox",
      "aria-checked": on ? "true" : "false",
      "aria-label": "Checkbox",
      "data-tok": "check",
      disabled: !!ctx?.locked
    },
    ico(on ? "square-check" : "square")
  );
}
const statusColor = (hue) => `oklch(0.72 0.14 ${hue})`;
function statusChip(n, ctx) {
  return liveChip(() => {
    const st = statusById(repoFor(ctx), n.args[0]);
    const btn = (cls, label, title, icon) => h("button", { type: "button", class: `ichip ichip-btn ${cls}`, "data-tok": "status", "aria-haspopup": "menu", title, disabled: !!ctx.locked }, ico(icon), h("span", {}, label));
    if (!st) return btn("ichip-miss", "Not found", "Status not found; click to pick one", "info");
    const el = btn("ichip-status", st.label, `${st.label}: click to change`, "circle-dot");
    el.style.setProperty("--st-h", st.hue);
    return el;
  });
}
/** What a click on a checkbox or status chip does: apply(newTokenText) persists the changed token. */
export function chipAction(el, ctx, apply) {
  const kind = el.dataset.tok;
  if (kind === "check") return apply(buildToken("check", [el.getAttribute("aria-checked") === "true" ? "0" : "1"]));
  if (kind !== "status") return;
  const repo = repoFor(ctx);
  const list = statusList(repo);
  if (!list.length) return;
  openMenu(el, list.map((s) => ({ label: s.label, swatch: statusColor(s.hue), onSelect: () => apply(buildToken("status", [s.id])) })), { width: 200 });
}

/** The sync environment an expression needs (constants, database / preset lookups), loading the rows it refers to first. */
async function formulaEnv(ctx, expr) {
  const refs = formulaRefs(expr);
  const pages = ctx.livePages();
  const repo = repoFor(ctx);
  const tables = tableSources(pages);
  const dbOf = (ref) => {
    const p = pages.find((x) => x.type === "database" && (x.id === ref || norm(x.title) === norm(ref))) ?? tables.find((x) => x.id === ref || norm(x.title) === norm(ref));
    return p?.sourceId ? pages.find((x) => x.id === p.sourceId) ?? null : p ?? null;
  };
  const rows = new Map();
  const load = async (db) => {
    if (db && !rows.has(db.id)) rows.set(db.id, await rowsOf(ctx, db.id));
  };
  for (const [ref] of refs.values) await load(dbOf(ref));
  const presets = listChipPresets(pages);
  for (const [name] of refs.presets) await load(presets.find((x) => norm(x.preset.name) === norm(name))?.db);
  // raw typed cell value (numbers stay numbers); objects and arrays use their display text
  const cell = (db, row, key, colRef) => {
    const col = (db.columns ?? []).find((c) => c.id === colRef) ?? (db.columns ?? []).find((c) => norm(c.name) === norm(colRef));
    if (!col) throw lookupError("#REF!", `no column "${colRef}" in ${db.title || "Untitled"}`);
    const v = row.values?.[col.id];
    if (v === void 0 || v === null || v === "") return null;
    return typeof v === "object" ? resolveValue(db, [row], key, col.id).text : v;
  };
  const rowFor = (db, key) => {
    const hit = matchKeys(db, rows.get(db.id) ?? [], [key])[0]?.rows[0];
    if (!hit) throw lookupError("#N/A", `no row with key "${key}" in ${db.title || "Untitled"}`);
    return hit;
  };
  return {
    constant: repo ? constantResolver(repo) : void 0,
    value: (dbRef, key, colRef) => {
      const db = dbOf(dbRef);
      if (!db) throw lookupError("#REF!", `database "${dbRef}" not found`);
      return cell(db, rowFor(db, key), key, colRef);
    },
    preset: (name, key) => {
      const hit = presets.find((x) => norm(x.preset.name) === norm(name));
      if (!hit) throw lookupError("#REF!", `preset "${name}" not found`);
      const k = key ?? hit.preset.key;
      if (!k) throw lookupError("#N/A", `preset "${name}" needs a key`);
      return cell(hit.db, rowFor(hit.db, k), k, hit.preset.colId);
    }
  };
}
const formulaText = (r) => r.ok ? formatResult(r.value) : r.error;
async function runFormula(ctx, expr) {
  return evalExpression(expr, await formulaEnv(ctx, expr));
}
function formulaChip(n, ctx) {
  const expr = n.args[0];
  return liveChip(async () => {
    const r = await runFormula(ctx, expr);
    if (!r.ok) return h("span", { class: "ichip ichip-formula ichip-err", title: `${r.detail}\n= ${expr}` }, ico("info"), h("span", {}, r.error));
    const text = formatResult(r.value);
    return h("span", { class: "ichip ichip-formula", title: `= ${expr}` }, ico("sigma"), text === "" ? emptyText() : h("span", {}, text));
  });
}

/** A chip for {{preset:id|key}}: preset -> its database -> row by key -> column. Re-resolves when presets change. */
function presetChip(n, ctx) {
  const el = h("span", { class: "ichip-wrap" });
  const run = async () => {
    const hit = findChipPreset(ctx.livePages(), n.args[0]);
    const fill = (node) => el.replaceChildren(node);
    if (!hit) return fill(miss("Not found", "Preset not found (deleted?)"));
    const { preset, db } = hit;
    const key = presetKey(n, preset);
    if (!key) return fill(miss("Not found", `${preset.name} › no key`));
    const res = resolvePreset(db, preset, await rowsOf(ctx, db.id), n);
    const title = `${preset.name} › ${key}`;
    if (res.state === "norow") return fill(miss("Not found", `${title}: no row with this key in ${db.title || "Untitled"}`));
    if (res.state === "nocol") return fill(miss("Not found", `${title}: the preset's column no longer exists`));
    fill(h("a", { class: "ichip ichip-value ichip-preset", href: `#row-${res.row.id}`, title }, res.text === "" ? h("span", { class: "ichip-empty" }, "(empty)") : res.text));
  };
  el.replaceChildren(h("span", { class: "ichip ichip-value loading", title: n.args[1] ?? "Preset" }, h("span", {}, "\u2026")));
  const again = () => {
    if (!el.isConnected) return document.removeEventListener(PRESETS_EVENT, again);
    run().catch(() => el.replaceChildren(miss("Not found", "Lookup failed")));
  };
  document.addEventListener(PRESETS_EVENT, again);
  run().catch(() => el.replaceChildren(miss("Not found", "Lookup failed")));
  return el;
}

// ---------- plain text (export, copy) ----------
/**
 * Build a sync resolver node -> plain text for the tokens in `texts`, loading the needed rows first.
 * Values that cannot be found fall back to their key.
 */
export async function inlineResolver(ctx, texts) {
  const nodes = [];
  for (const t of texts) for (const s of scanTokens(t)) nodes.push(s.node);
  const need = new Map();
  for (const n of nodes) if (n.kind === "value" && !need.has(n.args[0])) need.set(n.args[0], findDb(ctx, n.args[0]));
  const presets = new Map();
  for (const n of nodes) {
    if (n.kind !== "preset" || presets.has(n.args[0])) continue;
    const hit = findChipPreset(ctx.livePages(), n.args[0]);
    presets.set(n.args[0], hit);
    if (hit && !need.has(hit.db.id)) need.set(hit.db.id, { state: "ok", db: hit.db });
  }
  const rows = new Map();
  for (const [id, f] of need) if (f.state === "ok") rows.set(id, await rowsOf(ctx, f.db.id));
  const repo = ctx.livePages ? repoFor(ctx) : null;
  const formulas = new Map();
  if (ctx.livePages) for (const n of nodes) {
    if (n.kind !== "formula" || formulas.has(n.args[0])) continue;
    formulas.set(n.args[0], formulaText(await runFormula(ctx, n.args[0])));
  }
  return (n) => {
    if (n.kind === "date") return n.args[0];
    if (n.kind === "const") {
      const c = constantById(repo, n.args[0]);
      return c ? formatConstant(c) : tokenFallback(n);
    }
    if (n.kind === "status") return statusById(repo, n.args[0])?.label ?? tokenFallback(n);
    if (n.kind === "page") return ctx.livePages?.().find((p) => p.id === n.args[0])?.title || tokenFallback(n);
    if (n.kind === "formula") return formulas.get(n.args[0]) ?? tokenFallback(n);
    if (n.kind === "check") return tokenFallback(n);
    if (n.kind === "preset") {
      const hit = presets.get(n.args[0]);
      if (!hit) return tokenFallback(n);
      const res = resolvePreset(hit.db, hit.preset, rows.get(hit.db.id) ?? [], n);
      return res.state === "ok" ? res.text : presetKey(n, hit.preset) || hit.preset.name;
    }
    const f = need.get(n.args[0]) ?? findDb(ctx, n.args[0]);
    if (f.state !== "ok") return tokenFallback(n);
    const res = resolveValue(f.db, rows.get(n.args[0]) ?? [], n.args[1], n.args[2]);
    return res.state === "ok" ? res.text : tokenFallback(n);
  };
}

/** All text strings of a block tree (for collecting tokens). */
export function blockTexts(blocks) {
  const out = [];
  walk(blocks, (b) => {
    if (typeof b.text === "string" && b.text.includes("{{")) out.push(b.text);
  });
  return out;
}

// ---------- picker ----------
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A searchable list; Up/Down/Enter in the search box, buttons for touch. */
function searchList({ placeholder, items, onPick, empty }) {
  const input = h("input", { type: "search", class: "ip-search", placeholder, "aria-label": placeholder, autocomplete: "off", style: "font-size:16px" });
  const list = h("div", { class: "ip-list", role: "listbox" });
  let shown = [];
  let active = 0;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.filter((it) => !q || it.label.toLowerCase().includes(q) || (it.hint ?? "").toLowerCase().includes(q)).slice(0, 100);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.length ? shown.map((it, i) => {
      const main = h(
        "button",
        { type: "button", class: `ip-item${i === active ? " active" : ""}`, role: "option", "aria-selected": String(i === active), onClick: () => onPick(it) },
        h("span", { class: "ip-label" }, it.label || "(empty)"),
        it.hint ? h("span", { class: "ip-hint" }, it.hint) : null
      );
      if (!it.action) return main;
      return h(
        "div",
        { class: "ip-row" },
        main,
        h("button", { type: "button", class: "ip-act", title: it.action.label, "aria-label": `${it.action.label}: ${it.label}`, onClick: () => it.action.run(it) }, ico(it.action.icon))
      );
    }) : [h("div", { class: "ip-empty" }, empty)].filter(Boolean));
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", () => {
    active = 0;
    draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      draw();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[active]) onPick(shown[active]);
    }
  });
  draw();
  return { el: h("div", { class: "ip-box" }, input, list), input };
}

const colLabel = (db, colId) => (db.columns ?? []).find((c) => c.id === colId)?.name || "Column";
async function savePresets(ctx, db, list) {
  const cleaned = cleanChipPresets(list, db.columns);
  if (cleaned.length) db.chipPresets = cleaned;
  else delete db.chipPresets;
  await ctx.ws.savePage(db);
  presetsChanged();
}

/**
 * Open the insert picker. kind: "value" (presets first, then database > row > column), "date", or "preset"
 * (opts.presetId: asks only for the key, or inserts at once when the preset has a fixed key).
 * Calls onPick(token) with a valid token string, or onCancel() when dismissed without a choice.
 */
export function openInlinePicker(kind, ctx, { onPick, onCancel, presetId } = {}) {
  let done = false;
  if (kind === "check") {
    onPick?.(buildToken("check", ["0"]));
    return null;
  }
  const hit0 = kind === "preset" ? findChipPreset(ctx.livePages(), presetId) : null;
  if (kind === "preset") {
    if (!hit0) {
      toast("That preset no longer exists.", "error");
      onCancel?.();
      return null;
    }
    if (hit0.preset.key) {
      const token = buildToken("preset", [presetId]);
      if (token) onPick?.(token);
      return null;
    }
  }
  const body = h("div", { class: "ip" });
  const finish = (token) => {
    done = true;
    modal.close();
    onPick?.(token);
  };
  const modal = openModal({
    title: TITLES[kind] ?? (kind === "preset" ? `Preset: ${hit0.preset.name}` : "Insert database value"),
    content: body,
    actions: [{ label: "Cancel" }],
    onClose: () => {
      if (!done) onCancel?.();
    }
  });
  if (kind === "date") return dateStep(body, finish);
  if (kind === "formula") return formulaStep(ctx, body, finish);
  if (kind === "page" || kind === "const" || kind === "status") return listStep(kind, ctx, body, finish);
  const state = {};
  const crumb = (text, back) => h("div", { class: "ip-crumb" }, back ? h("button", { type: "button", class: "ip-back", onClick: back }, ico("chevron-left"), " Back") : null, h("span", {}, text));
  const show = (...kids) => body.replaceChildren(...kids.filter(Boolean));
  const presetItems = () => listChipPresets(ctx.livePages());
  async function stepPresetKey(hit, back) {
    const where = hit.db.title || "Untitled";
    show(crumb(`Choose a row in ${where}`, back), h("div", { class: "ip-empty" }, "Loading\u2026"));
    const rows = await rowsOf(ctx, hit.db.id);
    const sl = searchList({
      placeholder: "Search by key\u2026",
      empty: "No rows with a key value.",
      items: keyList(hit.db, rows).map((k) => ({ label: k })),
      onPick: (it) => {
        const token = buildToken("preset", [hit.preset.id, it.label]);
        if (token) finish(token);
      }
    });
    show(crumb(`Choose a row in ${where}`, back), sl.el);
    sl.input.focus();
  }
  function stepStart() {
    const list = presetItems();
    if (!list.length) return stepDb();
    const sl = searchList({
      placeholder: "Search presets\u2026",
      empty: "No presets.",
      items: list.map((x) => ({
        label: x.preset.name,
        hint: `${x.db.title || "Untitled"} \u203a ${colLabel(x.db, x.preset.colId)}${x.preset.key ? ` \u203a ${x.preset.key}` : ""}`,
        x,
        action: { icon: "pencil", label: "Edit preset", run: (it) => stepEdit(it.x) }
      })),
      onPick: (it) => {
        if (it.x.preset.key) {
          const token = buildToken("preset", [it.x.preset.id]);
          if (token) finish(token);
        } else stepPresetKey(it.x, stepStart);
      }
    });
    show(
      crumb("Presets"),
      sl.el,
      h("button", { type: "button", class: "ip-new", onClick: stepDb }, ico("database"), " Database value\u2026")
    );
    sl.input.focus();
  }
  function stepEdit(x) {
    const { preset, db } = x;
    const err = h("div", { class: "rp-error", role: "alert" });
    const name = h("input", { type: "text", maxlength: 80, value: preset.name, "aria-label": "Preset name", style: "font-size:16px" });
    const col = h("select", { "aria-label": "Column", style: "font-size:16px" }, (db.columns ?? []).map((c) => h("option", { value: c.id, selected: c.id === preset.colId }, c.name || "Untitled")));
    const key = h("input", { type: "text", maxlength: 200, value: preset.key ?? "", "aria-label": "Fixed key", placeholder: "Ask each time", style: "font-size:16px" });
    const save = async () => {
      const nm = name.value.trim();
      const taken = listChipPresets(ctx.livePages()).some((o) => o.preset.id !== preset.id && o.db.id === db.id && o.preset.name.toLowerCase() === nm.toLowerCase());
      if (!nm || taken) {
        err.replaceChildren(ico("info"), ` ${nm ? "A preset with that name already exists." : "Enter a name."}`);
        return;
      }
      const next = { ...preset, name: nm, colId: col.value };
      const k = key.value.trim();
      if (k) next.key = k;
      else delete next.key;
      await savePresets(ctx, db, (db.chipPresets ?? []).map((p) => p.id === preset.id ? next : p));
      toast("Preset saved.");
      stepStart();
    };
    const del = async () => {
      const n = countChipPresetUsers(ctx.livePages().map((p) => p.blocks), preset.id);
      const used = n === 0 ? "No chips use it." : `${n} chip${n === 1 ? "" : "s"} on pages use it and will show \u201cNot found\u201d.`;
      const ok = await confirmDialog(`Delete the preset \u201c${preset.name}\u201d? ${used}`, { title: "Delete preset", confirmLabel: "Delete" });
      if (!ok) return;
      await savePresets(ctx, db, (db.chipPresets ?? []).filter((p) => p.id !== preset.id));
      toast("Preset deleted.");
      stepStart();
    };
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        save();
      }
    });
    show(
      crumb(`Edit preset (${db.title || "Untitled"})`, stepStart),
      h("label", { class: "ip-field" }, h("span", {}, "Name"), name),
      h("label", { class: "ip-field" }, h("span", {}, "Column"), col),
      h("label", { class: "ip-field" }, h("span", {}, "Fixed key (optional)"), key),
      err,
      h(
        "div",
        { class: "ip-btns" },
        h("button", { type: "button", class: "primary", onClick: save }, ico("save"), " Save"),
        h("button", { type: "button", class: "danger", onClick: del }, ico("trash"), " Delete preset")
      )
    );
    name.focus();
  }
  async function stepDb() {
    const dbs = sourceList(ctx.livePages()); // data sources first, then other databases, then table sources
    const sl = searchList({
      placeholder: "Search databases\u2026",
      empty: "No databases yet.",
      items: dbs.map((p) => ({ label: sourceLabel(p), hint: p.dataSource ? "data source" : p.virtual ? "read-only" : "", p })),
      onPick: (it) => {
        state.db = it.p;
        stepKey();
      }
    });
    show(crumb("1 of 3: choose a database", presetItems().length ? stepStart : null), sl.el);
    sl.input.focus();
  }
  async function stepKey() {
    show(crumb(`2 of 3: choose a row in ${state.db.title || "Untitled"}`, stepDb), h("div", { class: "ip-empty" }, "Loading\u2026"));
    const rows = await rowsOf(ctx, state.db.id);
    const sl = searchList({
      placeholder: "Search by key\u2026",
      empty: "No rows with a key value.",
      items: keyList(state.db, rows).map((k) => ({ label: k })),
      onPick: (it) => {
        state.key = it.label;
        stepCol();
      }
    });
    show(crumb(`2 of 3: choose a row in ${state.db.title || "Untitled"}`, stepDb), sl.el);
    sl.input.focus();
  }
  function stepCol() {
    const sl = searchList({
      placeholder: "Search columns\u2026",
      empty: "No columns.",
      items: (state.db.columns ?? []).map((c) => ({ label: c.name || "Untitled", hint: c.type, id: c.id })),
      onPick: (it) => {
        state.colId = it.id;
        stepFinal();
      }
    });
    show(crumb(`3 of 3: choose a column for "${state.key}"`, stepKey), sl.el);
    sl.input.focus();
  }
  function stepFinal(naming = false) {
    const { db, key, colId } = state;
    const insert = () => {
      const token = buildToken("value", [db.id, key, colId]);
      if (token) finish(token);
    };
    const back = () => stepCol();
    if (!naming) {
      show(
        crumb(`${db.title || "Untitled"} \u203a ${key} \u203a ${colLabel(db, colId)}`, back),
        h(
          "div",
          { class: "ip-btns" },
          h("button", { type: "button", class: "primary", onClick: insert }, "Insert value"),
          db.virtual ? null : h("button", { type: "button", onClick: () => stepFinal(true) }, ico("plus"), " Save as preset\u2026")
        )
      );
      return;
    }
    const err = h("div", { class: "rp-error", role: "alert" });
    const name = h("input", { type: "text", maxlength: 80, value: `${db.title || "Untitled"} ${colLabel(db, colId)}`.trim(), "aria-label": "Preset name", style: "font-size:16px" });
    const fixed = h("input", { type: "checkbox", "aria-label": "Use this key every time" });
    const save = async () => {
      const nm = name.value.trim();
      if (!nm) return err.replaceChildren(ico("info"), " Enter a name.");
      if (presetNameTaken(db.chipPresets, nm)) return err.replaceChildren(ico("info"), " A preset with that name already exists.");
      const preset = newChipPreset(nm, colId, fixed.checked ? key : "");
      if (!preset) return err.replaceChildren(ico("info"), " Could not create the preset.");
      await savePresets(ctx, db, [...db.chipPresets ?? [], preset]);
      const token = buildToken("preset", preset.key ? [preset.id] : [preset.id, key]);
      if (token) finish(token);
    };
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        save();
      }
    });
    show(
      crumb(`New preset: ${db.title || "Untitled"} \u203a ${colLabel(db, colId)}`, () => stepFinal(false)),
      h("label", { class: "ip-field" }, h("span", {}, "Preset name"), name),
      h("label", { class: "ip-check" }, fixed, h("span", {}, `Always use the key \u201c${key}\u201d (otherwise ask each time)`)),
      err,
      h("div", { class: "ip-btns" }, h("button", { type: "button", class: "primary", onClick: save }, ico("save"), " Save and insert"))
    );
    name.focus();
    name.select();
  }
  if (kind === "preset") stepPresetKey(hit0, null);
  else stepStart();
  return modal;
}

const TITLES = { date: "Insert date", page: "Insert page chip", const: "Insert constant", status: "Insert status", formula: "Insert formula" };

/** Page / constant / status: one searchable list; picking inserts the token. */
function listStep(kind, ctx, body, finish) {
  const repo = repoFor(ctx);
  let items;
  let empty;
  if (kind === "page") {
    items = ctx.livePages().map((p) => ({ label: p.title || "Untitled", hint: p.type === "database" ? "database" : p.type === "repo" ? "repository" : "", id: p.id }));
    empty = "No pages.";
  } else if (kind === "const") {
    items = constantsOf(repo).map((c) => ({ label: c.name, hint: formatConstant(c) || "(empty)", id: c.id }));
    empty = "No constants yet. Add them from the repository menu in the sidebar: Constants\u2026";
  } else {
    items = statusList(repo).map((s) => ({ label: s.label, id: s.id }));
    empty = "No statuses yet. Add them from the repository menu in the sidebar: Statuses\u2026";
  }
  const sl = searchList({
    placeholder: kind === "page" ? "Search pages\u2026" : kind === "const" ? "Search constants\u2026" : "Search statuses\u2026",
    empty,
    items,
    onPick: (it) => {
      const token = buildToken(kind, [it.id]);
      if (token) finish(token);
    }
  });
  body.replaceChildren(sl.el);
  setTimeout(() => sl.input.focus(), 0);
}

/** Inline formula: an expression field with a live result. */
function formulaStep(ctx, body, finish) {
  const input = h("input", { type: "text", maxlength: 500, "aria-label": "Formula", placeholder: '2030 - const("foundedyear")', autocomplete: "off", spellcheck: "false", style: "font-size:16px" });
  const out = h("div", { class: "ip-empty", role: "status", "aria-live": "polite" }, "Type an expression. Constants: const(\"name\") or the bare name. Lookups: value(\"db\", \"key\", \"col\").");
  const insert = h("button", { type: "button", class: "primary", disabled: true }, "Insert");
  let seq = 0;
  let valid = false;
  const refresh = async () => {
    const mine = ++seq;
    const expr = input.value.trim();
    valid = !!expr && checkFormula(expr).ok && expr.length <= 500;
    insert.disabled = !valid;
    if (!expr) return out.replaceChildren("Type an expression.");
    const r = await runFormula(ctx, expr);
    if (mine !== seq) return;
    out.replaceChildren(...r.ok ? [ico("sigma"), ` = ${formatResult(r.value) || "(empty)"}`] : [ico("info"), ` ${r.detail}`]);
  };
  const go = () => {
    if (!valid) return;
    const token = buildToken("formula", [input.value.trim()]);
    if (token) finish(token);
  };
  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      go();
    }
  });
  insert.addEventListener("click", go);
  body.replaceChildren(h("label", { class: "ip-field" }, h("span", {}, "Expression"), input), out, h("div", { class: "ip-btns" }, insert));
  setTimeout(() => input.focus(), 0);
}

function dateStep(body, finish) {
  const input = h("input", { type: "date", value: today(), "aria-label": "Date", style: "font-size:16px" });
  const insert = () => {
    const token = buildToken("date", [input.value]);
    if (token) finish(token);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      insert();
    }
  });
  body.replaceChildren(
    h("label", {}, "Date", input),
    h("div", { class: "modal-actions" },
      h("button", { type: "button", onClick: () => finish(buildToken("date", [today()])) }, "Today"),
      h("button", { type: "button", class: "primary", onClick: insert }, "Insert"))
  );
  setTimeout(() => input.focus(), 0);
}
