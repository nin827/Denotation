// AI access settings UI (owned by the AI-connection work). Contract used by the sidebar:
//   openAiAccess(env)            -> opens the workspace-wide (broad) permissions dialog
//   openPageAiAccess(env, page)  -> opens the granular permissions dialog for one repo/page/database
// `env` is the same object the sidebar menus already receive from app.js.
//
// Permissions are saved in this browser and, when a folder is connected, to permissions.json in that
// folder, which the local MCP server (tools/mcp) reads. See js/permissions.js for the rules.
import { h } from "./dom.js";
import { openModal } from "./modal.js";
import { toast } from "./dialogs.js";
import { ico, pageIcon } from "../icons/index.js";
import { ACTIONS, makeResolver, ownValue, setBroadValue, setPageValue } from "../permissions.js";
import { folderSupported } from "../adapters/folder.js";
import { syncPermissions, savePermissions, loadLocalPermissions } from "../adapters/folderPermissions.js";

const ACTION_LABEL = { read: "Read", create: "Create", edit: "Edit", delete: "Delete" };
const ACTION_HINT = {
  read: "See titles and content",
  create: "Add pages and rows inside",
  edit: "Change titles, text and rows",
  delete: "Move to trash, delete rows"
};
const CHOICES = [
  { value: "no", label: "No", icon: "x" },
  { value: "yes", label: "Yes", icon: "check" },
  { value: "ignore", label: "Ignore", icon: "minus" }
];
const VALUE_LABEL = { yes: "Yes", no: "No", ignore: "Ignore" };
const TYPE_LABEL = { repo: "repository", doc: "page", database: "database", sync: "synced block" };

const storeOf = (env) => env?.ws?.store ?? null;
const folderInfo = (store) => {
  const st = store?.status?.() ?? { state: "off", folderName: "" };
  return { connected: !!store?.connected, state: st.state, name: st.folderName || "" };
};
const pagesOf = (env) => (typeof env?.pages === "function" ? env.pages() : []) ?? [];
const titleOf = (p) => p?.title || "Untitled";

async function loadPerms(env) {
  try {
    return await syncPermissions(storeOf(env));
  } catch {
    return loadLocalPermissions();
  }
}
async function persist(env, perms, statusEl) {
  const r = await savePermissions(storeOf(env), perms);
  if (statusEl) {
    statusEl.replaceChildren(
      r.folder === "failed" ? ico("info") : ico("check"),
      r.folder === "saved" ? " Saved to the folder." : r.folder === "failed" ? " Saved in this browser; the folder could not be written." : " Saved in this browser."
    );
  }
  if (r.folder === "failed") toast("Could not write permissions.json to the folder.", "error");
  return r.perms;
}

/** Three-way choice: No / Yes / Ignore, each with an icon and a text label. */
function choice(label, value, onPick) {
  const group = h("div", { class: "seg ai-seg", role: "radiogroup", "aria-label": label });
  const buttons = CHOICES.map((c) => h("button", {
    type: "button",
    role: "radio",
    "aria-checked": String(value === c.value),
    tabindex: value === c.value ? "0" : "-1",
    title: `${label}: ${c.label}`,
    "data-value": c.value,
    onClick: () => onPick(c.value)
  }, ico(c.icon), h("span", { class: "ai-seg-label" }, c.label)));
  group.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = buttons[(i + step + buttons.length) % buttons.length];
    next.focus();
    next.click();
  });
  group.append(...buttons);
  return group;
}
const refocus = (root, action) => root.querySelector(`.ai-seg[aria-label="${ACTION_LABEL[action]}"] [aria-checked="true"]`)?.focus();

function statusNote(store) {
  const f = folderInfo(store);
  if (!f.connected) {
    return h("div", { class: "ai-note" }, ico("unplug"), h("div", {},
      h("strong", {}, "Connect a folder to let assistants reach your workspace."),
      h("p", { class: "hint" }, folderSupported()
        ? "Assistants connect through a small local server that reads the folder. Connect one from the sidebar's ⋯ menu (Folder → Connect folder…). Until then these settings are kept in this browser."
        : "Assistants connect through a small local server that reads a connected folder. This browser can't connect folders; use Chrome or Edge on a computer. These settings are kept in this browser.")));
  }
  if (f.state === "needs-permission" || f.state === "error") {
    return h("div", { class: "ai-note" }, ico("info"), h("div", {},
      h("strong", {}, `Folder "${f.name}" is not syncing.`),
      h("p", { class: "hint" }, "Reconnect it from the sidebar so these settings reach the folder.")));
  }
  return h("div", { class: "ai-note ok" }, ico("plug"), h("div", {},
    h("strong", {}, `Connected folder: ${f.name}`),
    h("p", { class: "hint" }, "Saved to permissions.json in the folder. Assistants can only do what is allowed here.")));
}

function connectBlock(store) {
  const f = folderInfo(store);
  const cmd = 'claude mcp add denotation -- node "<path to Denotation>/tools/mcp/denotation-mcp.mjs" --folder "<path to folder>"';
  const code = h("code", { class: "ai-cmd-text" }, cmd);
  const copy = h("button", {
    type: "button", class: "ai-copy", title: "Copy command", "aria-label": "Copy command",
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        toast("Command copied.");
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        toast("Press Ctrl+C to copy.");
      }
    }
  }, ico("copy"), " Copy");
  return h("section", {},
    h("h4", {}, "Connect an assistant"),
    h("p", { class: "hint" }, "Claude Code (other MCP clients work the same way):"),
    h("div", { class: "ai-cmd" }, code, copy),
    h("p", { class: "hint" },
      f.connected
        ? `Replace <path to folder> with the full path of the folder "${f.name}" (the browser can't see it), and <path to Denotation> with where this app's files are. `
        : "Replace the paths with where this app's files are and the folder you connect. ",
      "Changes made by an assistant show up after the next sync, or when you come back to this window."),
    h("p", { class: "hint" }, "Only share the folder with assistants through this server: a tool with general file access could read the files directly."));
}

function summary(set) {
  return h("span", { class: "ai-chips" }, ACTIONS.filter((a) => set[a]).map((a) =>
    h("span", { class: `ai-chip ${set[a]}` }, ico(set[a] === "yes" ? "check" : "x"), `${ACTION_LABEL[a]} ${VALUE_LABEL[set[a]]}`)));
}

// ---------- broad dialog ----------
export async function openAiAccess(env) {
  let perms = await loadPerms(env);
  const store = storeOf(env);
  const body = h("div", { class: "settings ai-access" });
  const saved = h("p", { class: "hint ai-saved", "aria-live": "polite" });

  const draw = (focusAction) => {
    const table = h("div", { class: "ai-table", role: "group", "aria-label": "Workspace permissions" },
      ACTIONS.map((a) => h("div", { class: "ai-row" },
        h("div", { class: "ai-action" }, h("span", { class: "ai-action-name" }, ACTION_LABEL[a]), h("span", { class: "ai-action-hint" }, ACTION_HINT[a])),
        choice(ACTION_LABEL[a], perms.broad[a], async (v) => {
          perms = await persist(env, setBroadValue(perms, a, v), saved);
          draw(a);
        }))));
    const pages = pagesOf(env);
    const byId = new Map(pages.map((p) => [p.id, p]));
    const ids = Object.keys(perms.pages);
    const overrides = ids.length
      ? h("ul", { class: "ai-overrides" }, ids.map((id) => {
        const p = byId.get(id);
        return h("li", {},
          p
            ? h("button", { type: "button", class: "ai-ov-open", title: "Edit this page's AI access", onClick: () => openPageAiAccess(env, p, { onChange: (next) => { perms = next; draw(); } }) },
              pageIcon(p), h("span", { class: "ai-ov-title" }, titleOf(p)), summary(perms.pages[id]))
            : h("span", { class: "ai-ov-open gone" }, ico("info"), h("span", { class: "ai-ov-title" }, "Deleted page"), summary(perms.pages[id])),
          h("button", {
            type: "button", class: "ai-ov-remove", title: "Remove override", "aria-label": `Remove override for ${p ? titleOf(p) : "deleted page"}`,
            onClick: async () => {
              const next = { ...perms, pages: { ...perms.pages } };
              delete next.pages[id];
              perms = await persist(env, next, saved);
              draw();
            }
          }, "Remove"));
      }))
      : h("p", { class: "hint" }, "None yet. Right-click a repository, page or database in the sidebar and choose AI access… to override these settings for it and everything inside.");
    body.replaceChildren(
      statusNote(store),
      h("section", {},
        h("h4", {}, "Whole workspace"),
        table,
        h("p", { class: "hint" }, "Ignore means not set; for the whole workspace it counts as No.")),
      h("section", {}, h("h4", {}, "Page overrides"), overrides),
      connectBlock(store),
      saved
    );
    if (focusAction) refocus(body, focusAction);
  };
  draw();
  return openModal({ title: "AI access", content: body, actions: [{ label: "Done", class: "primary" }] });
}

// ---------- granular dialog ----------
const sourceText = (r, byId, selfId) => {
  if (r.source === "self") return "set here";
  if (r.source === "ancestor") {
    const p = byId.get(r.sourceId);
    return p ? `from ${TYPE_LABEL[p.type] ?? "page"} "${titleOf(p)}"` : "from a parent";
  }
  if (r.source === "broad") return "from workspace";
  return selfId ? "not set anywhere" : "";
};

export async function openPageAiAccess(env, page, { onChange } = {}) {
  if (!page?.id) return null;
  let perms = await loadPerms(env);
  const body = h("div", { class: "settings ai-access" });
  const saved = h("p", { class: "hint ai-saved", "aria-live": "polite" });
  const kind = TYPE_LABEL[page.type] ?? "page";
  const draw = (focusAction) => {
    const pages = pagesOf(env);
    const list = pages.some((p) => p.id === page.id) ? pages : [...pages, page];
    const byId = new Map(list.map((p) => [p.id, p]));
    const can = makeResolver(perms, list, []);
    const rows = ACTIONS.map((a) => {
      const eff = can(page.id, a);
      return h("div", { class: "ai-row" },
        h("div", { class: "ai-action" },
          h("span", { class: "ai-action-name" }, ACTION_LABEL[a]),
          h("span", { class: `ai-effective ${eff.value}` }, ico(eff.allowed ? "check" : "x"),
            h("span", {}, h("b", {}, `Effective: ${eff.allowed ? "Yes" : "No"}`), h("span", { class: "ai-from" }, ` — ${sourceText(eff, byId, page.id)}`)))),
        choice(ACTION_LABEL[a], ownValue(perms, page.id, a), async (v) => {
          perms = await persist(env, setPageValue(perms, page.id, a, v), saved);
          onChange?.(perms);
          draw(a);
        }));
    });
    const inherit = page.type === "database" ? "Rows of this database follow these settings."
      : page.type === "repo" ? "Everything in this repository follows these settings unless a page inside overrides them."
      : "Pages inside follow these settings unless they override them.";
    body.replaceChildren(
      h("p", { class: "ai-target" }, pageIcon(page), h("strong", {}, titleOf(page)), h("span", { class: "hint" }, ` (${kind})`)),
      h("div", { class: "ai-table", role: "group", "aria-label": `AI access for ${titleOf(page)}` }, rows),
      h("p", { class: "hint" }, `Ignore follows the nearest parent, then the workspace setting. ${inherit}`),
      folderInfo(storeOf(env)).connected ? null : statusNote(storeOf(env)),
      saved
    );
    if (focusAction) refocus(body, focusAction);
  };
  draw();
  return openModal({
    title: "AI access",
    content: body,
    actions: [
      ...(onChange ? [] : [{ label: "Workspace settings…", run: () => { openAiAccess(env); } }]),
      { label: "Done", class: "primary" }
    ]
  });
}
