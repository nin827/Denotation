// Inline chips ({{value:...}} and {{date:...}}): rendering, the insert picker, and plain-text resolution for export.
// Token grammar and parsing live in blocks/inline.js; the lookup logic in preview.js.
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openModal } from "./modal.js";
import { buildToken, scanTokens, tokenFallback } from "../blocks/inline.js";
import { resolveValue, keyList } from "../preview.js";
import { walk } from "../blocks/model.js";

// ---------- data ----------
const CACHE_MS = 300; // enough to share one load between all chips of a render, short enough to see edits
const cache = new Map();
function rowsOf(ctx, dbId) {
  const k = `${dbId}`;
  const hit = cache.get(k);
  if (hit && hit.ws === ctx.ws && Date.now() - hit.t < CACHE_MS) return hit.p;
  const p = Promise.resolve(ctx.ws.listRows(dbId)).catch(() => []);
  cache.set(k, { t: Date.now(), ws: ctx.ws, p });
  return p;
}
export const clearInlineCache = () => cache.clear();

/** The database page behind an id (a linked view resolves to its source), or a state string. */
function findDb(ctx, id) {
  const info = ctx.pageInfo?.(id);
  if (!info || info.state === "missing") return { state: "missing" };
  if (info.state === "trashed") return { state: "trashed" };
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
  if (n.kind !== "value" || !ctx?.ws) return document.createTextNode(`{{${n.kind}}}`);
  const [dbId, key, colId] = n.args;
  const el = h("span", { class: "ichip-wrap" }, h("span", { class: "ichip ichip-value loading", title: `${key}` }, h("span", {}, "\u2026")));
  const fill = (node) => el.replaceChildren(node);
  (async () => {
    const f = findDb(ctx, dbId);
    if (f.state === "trashed") return fill(miss("In trash", `Database is in the trash › ${key}`));
    if (f.state !== "ok") return fill(miss("Not found", `Database not found › ${key}`));
    const res = resolveValue(f.db, await rowsOf(ctx, f.db.id), key, colId);
    const path = `${f.title} › ${key} › ${res.col?.name ?? "Column"}`;
    if (res.state === "norow") return fill(miss("Not found", `No row with key "${key}" in ${f.title}`));
    if (res.state === "nocol") return fill(miss("Not found", `Column not found › ${f.title} › ${key}`));
    const a = h("a", { class: "ichip ichip-value", href: `#row-${res.row.id}`, title: path }, res.text === "" ? h("span", { class: "ichip-empty" }, "(empty)") : res.text);
    fill(a);
  })().catch(() => fill(miss("Not found", "Lookup failed")));
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
  const rows = new Map();
  for (const [id, f] of need) if (f.state === "ok") rows.set(id, await rowsOf(ctx, f.db.id));
  return (n) => {
    if (n.kind === "date") return n.args[0];
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
    list.replaceChildren(...shown.length ? shown.map((it, i) => h(
      "button",
      { type: "button", class: `ip-item${i === active ? " active" : ""}`, role: "option", "aria-selected": String(i === active), onClick: () => onPick(it) },
      h("span", { class: "ip-label" }, it.label || "(empty)"),
      it.hint ? h("span", { class: "ip-hint" }, it.hint) : null
    )) : [h("div", { class: "ip-empty" }, empty)].filter(Boolean));
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

/**
 * Open the insert picker. kind: "value" | "date". Calls onPick(token) with a valid token string,
 * or onCancel() when dismissed without a choice.
 */
export function openInlinePicker(kind, ctx, { onPick, onCancel } = {}) {
  let done = false;
  const body = h("div", { class: "ip" });
  const finish = (token) => {
    done = true;
    modal.close();
    onPick?.(token);
  };
  const modal = openModal({
    title: kind === "date" ? "Insert date" : "Insert database value",
    content: body,
    actions: [{ label: "Cancel" }],
    onClose: () => {
      if (!done) onCancel?.();
    }
  });
  if (kind === "date") return dateStep(body, finish);
  const state = {};
  const crumb = (text, back) => h("div", { class: "ip-crumb" }, back ? h("button", { type: "button", class: "ip-back", onClick: back }, ico("chevron-left"), " Back") : null, h("span", {}, text));
  const show = (...kids) => body.replaceChildren(...kids.filter(Boolean));
  async function stepDb() {
    const dbs = ctx.livePages().filter((p) => p.type === "database" && !p.sourceId);
    const sl = searchList({
      placeholder: "Search databases…",
      empty: "No databases yet.",
      items: dbs.map((p) => ({ label: p.title || "Untitled", p })),
      onPick: (it) => {
        state.db = it.p;
        stepKey();
      }
    });
    show(crumb("1 of 3: choose a database"), sl.el);
    sl.input.focus();
  }
  async function stepKey() {
    show(crumb(`2 of 3: choose a row in ${state.db.title || "Untitled"}`, stepDb), h("div", { class: "ip-empty" }, "Loading…"));
    const rows = await rowsOf(ctx, state.db.id);
    const sl = searchList({
      placeholder: "Search by key…",
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
      placeholder: "Search columns…",
      empty: "No columns.",
      items: (state.db.columns ?? []).map((c) => ({ label: c.name || "Untitled", hint: c.type, id: c.id })),
      onPick: (it) => {
        const token = buildToken("value", [state.db.id, state.key, it.id]);
        if (token) finish(token);
      }
    });
    show(crumb(`3 of 3: choose a column for "${state.key}"`, stepKey), sl.el);
    sl.input.focus();
  }
  stepDb();
  return modal;
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
