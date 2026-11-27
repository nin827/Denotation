import { h, debounce } from "./dom.js";
import { pageIcon, ico } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { newItems } from "./newMenu.js";
import { openModal } from "./modal.js";
import { toast, confirmDialog } from "./dialogs.js";

export async function renderTrash(root, env) {
  const { ws: ws } = env;
  root.classList.remove("doc-wide", "doc-small");
  const list = h("div", { class: "trash-list" });
  async function draw() {
    const items = await ws.listTrash();
    list.replaceChildren(...items.length ? items.map((p) => h(
      "div",
      { class: "trash-item" },
      h("span", { class: "ti-icon" }, pageIcon(p)),
      h("span", { class: "ti-title" }, p.title || "Untitled"),
      h("span", { class: "hint" }, `deleted ${new Date(p.trashedAt).toLocaleDateString()}`),
      h("button", { onClick: async () => {
        await ws.restorePage(p.id);
        await env.refresh();
        await draw();
        toast("Restored");
      } }, "Restore"),
      h("button", {
        class: "danger",
        onClick: async () => {
          if (!await confirmDialog(`Permanently delete "${p.title || "Untitled"}"?`, { title: "Delete forever", confirmLabel: "Delete forever" })) return;
          await ws.deletePage(p.id);
          await env.refresh();
          await draw();
        }
      }, "Delete forever")
    )) : [h("p", { class: "empty" }, "The trash is empty.")]);
    empty.disabled = !items.length;
  }
  const empty = h("button", {
    class: "danger",
    onClick: async () => {
      if (!await confirmDialog("Permanently delete everything in the trash?", { title: "Empty trash", confirmLabel: "Empty trash" })) return;
      const n = await ws.emptyTrash();
      await env.refresh();
      await draw();
      toast(`Deleted ${n} page${n === 1 ? "" : "s"}`);
    }
  }, "Empty trash");
  root.replaceChildren(
    h("h1", { class: "view-title" }, ico("trash"), " Trash"),
    h("p", { class: "hint" }, "Pages here are hidden everywhere else. Restore them, or delete them forever."),
    empty,
    list
  );
  await draw();
}
export function openQuickFind(env) {
  const { ws: ws } = env;
  const results = h("div", { class: "qf-results", role: "listbox" });
  let hits = [];
  let modal;
  const go = (hit) => {
    modal.close();
    if (hit.kind === "row") env.openRow(hit.id);
    else env.open(hit.id);
  };
  const input = h("input", {
    type: "search",
    class: "qf-input",
    placeholder: "Search pages and rows\u2026",
    "aria-label": "Search",
    onInput: debounce(async (e) => {
      hits = await ws.search(e.target.value);
      results.replaceChildren(...hits.length ? hits.map((x) => h(
        "button",
        { class: "qf-hit", role: "option", onClick: () => go(x) },
        h("span", { class: "qf-title" }, x.kind === "row" ? ico("table-properties") : null, " ", x.title),
        x.snippet ? h("span", { class: "qf-snip" }, x.snippet) : null
      )) : [h("p", { class: "hint" }, e.target.value.trim() ? "No results." : "")]);
    }, 150),
    onKeydown: (e) => {
      if (e.key === "Enter" && hits[0]) go(hits[0]);
    }
  });
  modal = openModal({ title: "Quick find", content: h("div", {}, input, results), actions: [{ label: "Close" }] });
  input.focus();
}
export function renderRepoBody(root, env, repo, { onCreate }) {
  const pages = env.pages();
  const kids = pages.filter((p) => p.parentId === repo.id && p.type !== "sync" && !p.trashedAt);
  const card = (p) => h(
    "a",
    { class: "repo-card", href: `#page-${p.id}`, onClick: (e) => {
      e.preventDefault();
      env.open(p.id);
    } },
    h("span", { class: "rc-icon" }, pageIcon(p)),
    h("span", { class: "rc-title" }, p.title || "Untitled"),
    h("span", { class: "hint" }, p.type === "database" ? "Database" : "Page")
  );
  root.replaceChildren(
    h(
      "div",
      { class: "repo-actions" },
      h("button", { class: "act-new-page", onClick: () => onCreate("doc", repo.id) }, ico("plus"), " New page"),
      h("button", { class: "act-new-db", onClick: () => onCreate("database", repo.id) }, ico("database"), " New database"),
      h("button", { class: "act-new-more", onClick: (e) => openMenu(e.currentTarget, newItems({ pages: pages, parentId: repo.id, onCreate, onImportCsv: env.importCsv }), { width: 230 }) }, ico("layers"), " More\u2026")
    ),
    kids.length ? h("div", { class: "repo-grid" }, kids.map(card)) : h("p", { class: "empty" }, "This repository is empty. Add a page or a database.")
  );
}
