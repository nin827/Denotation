import { config } from "./config.js";
import { createStore } from "./store.js";
import { newBlock } from "./blocks/model.js";
import { isTrashed, createWorkspace } from "./workspace.js";
import { h } from "./ui/dom.js";
import { ico } from "./icons/index.js";
import { renderSidebar, activeRepo } from "./ui/sidebar.js";
import { createLayout } from "./ui/layout.js";
import { openModal } from "./ui/modal.js";
import { loadPrefs, applyPrefs, savePrefs, openSettings } from "./ui/appearance.js";
import { toast } from "./ui/dialogs.js";
import { pickCsv } from "./ui/csvFile.js";
import { createVaultUi } from "./ui/vaultUi.js";
import { createFolderAdapter, folderSupported } from "./adapters/folder.js";
import { renderDatabase } from "./ui/dbView.js";
import { makePersistence, renderRowPage, renderHeader, renderDocPage } from "./ui/pageView.js";
import { renderTrash, renderRepoBody, openQuickFind } from "./ui/workspaceViews.js";
import { openFeedback } from "./ui/feedback.js";
import { openAiAccess, openPageAiAccess } from "./ui/aiAccess.js";
import { hasPin } from "./lock.js";
import { createLockScreen } from "./ui/lock.js";
import { securitySection, openResetDialog, finishPendingReset } from "./ui/security.js";

const appEl = document.getElementById("app");
const loginEl = document.getElementById("login");
const sidebarEl = document.getElementById("sidebar");
const mainEl = document.getElementById("main");
let store = null;
let ws = null;
let user = null;
let pages = [];
let currentId = null;
let view = null;
let persistence = null;
let env = null;
let vaultUi = null;
let prefs = loadPrefs();
applyPrefs(prefs);
const layout = createLayout({ appEl, getLocked: () => prefs.sidebarLocked, onChange: () => {
  if (ws) drawSidebar();
} });
const hashFor = (id) => `#page-${id}`;
const parseHash = () => {
  const m = location.hash.match(/^#(page|row)-([A-Za-z0-9-]+)$/);
  if (m) return { kind: m[1], id: m[2] };
  return location.hash === "#trash" ? { kind: "trash" } : null;
};
const firstLive = () => pages.find((p) => p.type !== "sync" && !isTrashed(pages, p));
// PIN lock: locking flushes saves and clears the rendered workspace; unlocking renders the current page again.
const resetCtx = () => ({
  getStatus: () => store?.status?.() ?? null,
  onExport: () => vaultUi?.exportJsonFile(),
  prepareReset: async () => {
    persistence?.dispose?.(); // pending edits are discarded with everything else
    persistence = null;
    ws = null;
  }
});
const lockUi = createLockScreen({
  onLocking: async () => {
    try {
      await persistence?.flush();
      await store?.flush?.();
    } catch (e) {
      console.error(e);
    }
    if (!lockUi.isLocked()) return;
    sidebarEl.replaceChildren();
    mainEl.replaceChildren();
  },
  onUnlocked: async () => {
    if (ws) await route();
  },
  onForgot: () => {
    const { getStatus, prepareReset } = resetCtx();
    openResetDialog({ locked: true, getStatus, prepare: prepareReset });
  }
});
const lockNow = () => lockUi.lock();
async function main() {
  await finishPendingReset();
  if (hasPin()) await lockUi.lock(); // nothing is loaded or drawn before the PIN is entered
  lockUi.watchIdle();
  showMessage("Opening your workspace\u2026");
  try {
    store = await createStore(config);
  } catch (e) {
    return showFatal(e);
  }
  if (folderSupported() && store.name === "local") store = createFolderAdapter(store);
  if (store.auth) {
    store.auth.onChange((u) => u ? start(u) : showLogin());
  } else {
    start(null);
  }
}
function showMessage(text) {
  appEl.hidden = true;
  loginEl.hidden = false;
  loginEl.replaceChildren(h("h1", {}, "Denotion"), h("p", { class: "hint" }, text));
}
function showFatal(e) {
  appEl.hidden = true;
  loginEl.hidden = false;
  loginEl.replaceChildren(h("h1", {}, "Denotion"), h("pre", {}, e.message));
  console.error(e);
}
function showLogin() {
  ws = null;
  user = null;
  appEl.hidden = true;
  loginEl.hidden = false;
  loginEl.replaceChildren(
    h("h1", {}, "Denotion"),
    h("p", {}, "Sign in to open your workspace."),
    ...store.auth.providers.map((p) => h("button", {
      class: "primary",
      onClick: () => store.auth.signIn(p).catch((e) => toast(e.message, "error"))
    }, `Continue with ${p[0].toUpperCase()}${p.slice(1)}`))
  );
}
async function start(u) {
  user = u;
  ws = createWorkspace(store);
  persistence?.dispose?.();
  persistence = makePersistence(ws, { win: window, afterFlush: () => store.flush?.() });
  env = {
    importCsv: (parentId) => importCsv(parentId),
    ws,
    persistence,
    pages: () => pages,
    refresh,
    rerender: () => route(),
    open: async (id) => {
      layout.afterNavigate(); // get an overlay sidebar out of the way on the tap, not after the async flush + hashchange
      await persistence.flush();
      if (location.hash === hashFor(id)) route();
      else location.hash = hashFor(id);
    },
    openRow: async (id) => {
      await persistence.flush();
      location.hash = `#row-${id}`;
    },
    leave: async (goneIds = [], dbId = null) => {
      await refresh();
      const target = dbId ? pages.find((p) => p.id === dbId) : null;
      const next = target && !isTrashed(pages, target) ? target : firstLive();
      if (next) {
        if (location.hash === hashFor(next.id)) route();
        else location.hash = hashFor(next.id);
      } else {
        location.hash = "";
        route();
      }
    }
  };
  vaultUi = createVaultUi({
    store,
    ws: () => ws,
    flush: () => persistence.flush(),
    activeRepoId: () => activeRepo(pages, currentId)?.id ?? null,
    redraw: () => drawSidebar(),
    onRemote: async () => {
      await refresh();
      await route();
    },
    afterImport: async (r) => {
      await refresh();
      if (r.rootId && r.format === "markdown") env.open(r.rootId);
      else await route();
    }
  });
  loginEl.hidden = true;
  appEl.hidden = false;
  try {
    pages = await ws.listPages();
    try {
      if (!pages.length) await seed();
      else await ws.ensureRepository();
    } catch (e) {
      toast(e.message, "error");
    }
    pages = await ws.listPages();
  } catch (e) {
    return showFatal(e);
  }
  await route();
  vaultUi.init().catch((e) => toast(`Folder sync: ${e.message}`, "error"));
}
async function route() {
  if (lockUi.isLocked() || !ws) return;
  layout.afterNavigate();
  const target = parseHash();
  const known = target?.kind === "page" && pages.find((p) => p.id === target.id && p.type !== "sync");
  if (known) {
    currentId = known.id;
    drawSidebar();
    mainEl.classList.add("loading");
  }
  await persistence.flush();
  pages = await ws.listPages();
  mainEl.classList.remove("loading");
  if (target?.kind === "trash") {
    view = "trash";
    currentId = null;
    drawSidebar();
    return renderTrash(mainEl, env);
  }
  view = null;
  if (target?.kind === "row") {
    const row = await ws.getRow(target.id);
    const db = row && pages.find((p) => p.id === row.dbId);
    if (db) {
      currentId = db.id;
      drawSidebar();
      mainEl.scrollTop = 0;
      return renderRowPage(mainEl, env, db, row);
    }
  }
  const page = target?.kind === "page" && pages.find((p) => p.id === target.id && p.type !== "sync") || firstLive();
  if (!page) {
    currentId = null;
    drawSidebar();
    mainEl.replaceChildren(h("p", { class: "empty" }, "Create a page or database from the sidebar."));
    return;
  }
  currentId = page.id;
  drawSidebar();
  mainEl.scrollTop = 0;
  const fresh = page;
  if (fresh.type === "repo") {
    const header = renderHeader(env, fresh, { titleValue: fresh.title, setTitle: (v) => {
      fresh.title = v;
    } });
    const body = h("div", { class: "db-body" });
    mainEl.classList.remove("doc-wide", "doc-small");
    mainEl.replaceChildren(header, body);
    renderRepoBody(body, env, fresh, { onCreate: createPage });
  } else if (fresh.type === "database") {
    const header = renderHeader(env, fresh, { titleValue: fresh.title, setTitle: (v) => {
      fresh.title = v;
    } });
    const body = h("div", { class: "db-body" });
    mainEl.classList.remove("doc-wide", "doc-small");
    mainEl.replaceChildren(header, body);
    await renderDatabase(body, ws, fresh, { onOpenRow: (id) => env.openRow(id), onOpenPage: (id) => env.open(id) });
  } else {
    renderDocPage(mainEl, env, fresh);
  }
}
async function refresh() {
  if (!ws) return;
  pages = await ws.listPages();
  drawSidebar();
}
function drawSidebar() {
  if (lockUi.isLocked() || !ws) return;
  renderSidebar(sidebarEl, {
    pages,
    currentId,
    view,
    locked: prefs.sidebarLocked,
    onToggleLock: () => {
      prefs = { ...prefs, sidebarLocked: !prefs.sidebarLocked };
      savePrefs(prefs);
      layout.apply();
    },
    onClose: () => layout.close(),
    onSettings: () => openSettings({ prefs, onChange: (p) => {
      prefs = p;
      layout.apply();
      drawSidebar();
    }, extra: securitySection({ ...resetCtx(), onPinChange: drawSidebar, onIdleChange: () => lockUi.touch() }) }),
    onLockNow: hasPin() ? lockNow : null,
    onFeedback: () => openFeedback({ env, onFile: (t) => ws.fileFeedback(t), onOpen: (id) => env.open(id) }),
    onAiAccess: () => openAiAccess(env),
    onPageAiAccess: (p) => openPageAiAccess(env, p),
    vaultItems: () => vaultUi.menuItems(),
    onOpen: (id) => env.open(id),
    onRedraw: drawSidebar,
    onCreate: createPage,
    onImportCsv: importCsv,
    onTrash: trashPage,
    onRename: renamePage,
    onFavorite: async (p) => {
      await ws.setFavorite(p.id, !p.favorite);
      await refresh();
    },
    onDuplicate: async (p) => {
      await persistence.flush();
      const c = await ws.duplicatePage(p.id);
      await refresh();
      toast("Page duplicated");
      env.open(c.id);
    },
    onSearch: () => openQuickFind(env),
    onOpenTrash: async () => {
      await persistence.flush();
      if (location.hash === "#trash") route();
      else location.hash = "#trash";
    },
    footer: buildFooter()
  });
}
async function createPage(type = "doc", parentId = null, opts = {}) {
  if (type !== "repo" && !parentId) parentId = activeRepo(pages, currentId)?.id ?? null;
  const source = opts.sourceId ? pages.find((x) => x.id === opts.sourceId) : null;
  const p = await ws.createPage({
    type,
    parentId: type === "repo" ? null : parentId,
    ...opts,
    title: source ? `${source.title || "Untitled"} ${opts.viewType === "sheet" ? "(sheet view)" : "(view)"}` : type === "database" ? opts.viewType === "sheet" ? "New sheet" : "New database" : type === "repo" ? "New repository" : "Untitled"
  });
  if (parentId) {
    const parent = await ws.getPage(parentId);
    if (parent?.blocks) {
      const last = parent.blocks[parent.blocks.length - 1];
      const link = newBlock("page", { ref: p.id });
      if (last && last.type === "p" && !last.text && parent.blocks.length === 1) parent.blocks.splice(0, 1, link);
      else parent.blocks.push(link);
      await ws.savePage(parent);
    }
  }
  await refresh();
  env.open(p.id);
}
async function importCsv(parentId) {
  const file = await pickCsv();
  if (!file) return;
  try {
    await persistence.flush();
    const { db, rows } = await ws.importCsv({ text: file.text, title: file.name || "Imported data", parentId });
    await refresh();
    toast(`Imported ${rows} row${rows === 1 ? "" : "s"} into "${db.title}".`);
    env.open(db.id);
  } catch (e) {
    toast(e.message, "error");
  }
}
function renamePage(p) {
  const input = h("input", { type: "text", value: p.title || "", maxlength: 200, placeholder: "Untitled" });
  openModal({
    title: "Rename",
    content: h("label", {}, "Name", input),
    actions: [{ label: "Cancel" }, { label: "Rename", class: "primary", run: async () => {
      await persistence.flush();
      const fresh = await ws.getPage(p.id) || p;
      fresh.title = input.value.trim();
      await ws.savePage(fresh);
      await refresh();
      if (currentId === p.id) route();
    } }]
  });
  input.focus();
  input.select();
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.querySelector(".modal-actions button.primary")?.click();
  });
}
async function trashPage(p) {
  await persistence.flush();
  await ws.trashPage(p.id);
  await refresh();
  toast(`"${p.title || "Untitled"}" moved to trash`);
  if (view === "trash") return route();
  if (currentId && isTrashed(pages, pages.find((x) => x.id === currentId))) env.leave([p.id]);
}
function buildFooter() {
  const where = `Storage: ${store.cache?.label ?? store.label ?? store.name}${user ? ` \xB7 ${user.name}` : ""}`;
  const { lines, buttons, input } = vaultUi.footer({ where, user: user?.name });
  return h(
    "div",
    { class: "side-footer" },
    ...lines,
    store.note ? h("div", { class: "note" }, store.note) : null,
    store.auth ? h("div", { class: "row" }, ...buttons, h("button", { onClick: () => store.auth.signOut() }, ico("log-out"), " Sign out")) : null,
    input
  );
}
async function seed() {
  const N = newBlock;
  const repo = await ws.createPage({ type: "repo", title: "My repository" });
  const welcome = await ws.createPage({ title: "Welcome to Denotion", parentId: repo.id });
  welcome.icon = "icon:hand";
  const sub = await ws.createPage({ title: "A sub-page", parentId: welcome.id });
  sub.blocks = [N("p", { text: "Sub-pages live inside their parent. Use the breadcrumb above to go back." })];
  await ws.savePage(sub);
  const toggle = N("toggle", { text: "Toggle lists fold away" });
  toggle.children = [N("p", { text: "Press Tab to nest a block under a toggle, Shift+Tab to move it back out." })];
  const fold = N("h3", { text: "Toggle headings fold too", fold: true });
  fold.children = [N("p", { text: "Make any heading foldable from its handle menu." })];
  const table = N("table", { rows: 3, cols: 4 });
  table.cells = [["Name", "Rows", "Columns", "Note"], ["Table", "any", "any", "Type /table 4x5"], ["Columns", "-", "2 to 6", "Type /columns 3"]];
  const cols = N("columns", { count: 2 });
  cols.children[0].children = [N("h4", { text: "Left column" }), N("p", { text: "Drag blocks between columns by their handle." })];
  cols.children[1].children = [N("h4", { text: "Right column" }), N("todo", { text: "Try a to-do" })];
  welcome.blocks = [
    N("h1", { text: "Welcome" }),
    N("p", { text: "Denotion is a small Notion-style workspace you can bend to your needs. Hover a block and use the three-line handle at its left to change type, move, copy, link or delete it. Type `/` for every block type." }),
    N("callout", { text: "Select text and press Ctrl/Cmd+B, I, E or K for bold, italic, code or link. Or just type the markdown.", icon: "icon:lightbulb" }),
    N("toc"),
    N("h2", { text: "Blocks" }),
    toggle,
    fold,
    N("quote", { text: "Quotes and callouts take colours from the handle menu." }),
    N("h2", { text: "Layout" }),
    table,
    cols,
    N("h2", { text: "Pages" }),
    N("page", { ref: sub.id }),
    N("p", { text: "Open **Column type demo** in the sidebar to see Dictionary and Array columns. Click the open icon on a row to open it as a full page. These are example entries; delete them whenever you like." })
  ];
  await ws.savePage(welcome);
  const demo = await ws.createPage({ type: "database", title: "Column type demo", parentId: repo.id });
  const col = (name, type, cfg) => ({ id: crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`, name, type, config: cfg });
  const [nameCol] = demo.columns;
  const tags = col("Tags", "array", { itemType: "text", size: null });
  const scores = col("Scores (3)", "array", { itemType: "number", size: 3 });
  const contact = col("Contact", "dictionary", {
    mode: "strict",
    fields: [{ key: "email", type: "text" }, { key: "age", type: "number" }]
  });
  const extra = col("Extra", "dictionary", { mode: "loose" });
  await ws.updateColumns(demo, [nameCol, tags, scores, contact, extra]);
  const row = await ws.createRow(demo);
  Object.assign(row.values, {
    [nameCol.id]: "Ada Lovelace",
    [tags.id]: ["math", "poetry"],
    [scores.id]: [9, 8, 10],
    [contact.id]: { email: "ada@example.com", age: 36 },
    [extra.id]: { born: 1815, famous: true }
  });
  row.blocks = [N("p", { text: "Every database row is also a page. Write notes here." })];
  await ws.saveRow(row);
}
window.addEventListener("unhandledrejection", (e) => {
  toast(e.reason?.message || "Something went wrong. Your last change may not be saved.", "error");
});
window.addEventListener("hashchange", () => {
  if (ws) route();
});
window.addEventListener("keydown", (e) => {
  if (ws && !lockUi.isLocked() && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey) {
    if (e.target?.classList?.contains("blk-ta")) return;
    e.preventDefault();
    openQuickFind(env);
  }
});
main();
