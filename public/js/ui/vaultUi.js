// Export / import menus (JSON file, ZIP, folder) and the "Connect folder" live-storage controls.
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { openModal } from "./modal.js";
import { toast, confirmDialog } from "./dialogs.js";
import { saveTextFile, saveBinaryFile } from "./files.js";
import { createZip, readZip } from "../zip.js";
import { toJsonFiles, toMarkdownFiles, importFiles } from "../vault.js";
import { folderSupported, saveHandle, loadHandle, clearHandle } from "../adapters/folder.js";

const READ_EXT = /\.(md|markdown|csv|tsv|json|png|jpe?g|gif|webp)$/i;
const READ_MAX = 256 * 1024 * 1024;
const NO_FOLDERS = "Folders need Chrome or Edge on a computer. Use ZIP instead.";
const today = () => new Date().toISOString().slice(0, 10);
const aborted = (e) => e?.name === "AbortError";

async function writeTree(dir, files) {
  for (const f of files) {
    const parts = f.path.split("/");
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    try {
      await w.write(f.data);
    } finally {
      await w.close();
    }
  }
}
async function readTree(dir, prefix = "", out = [], budget = { left: READ_MAX }) {
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const path = prefix + name;
    if (handle.kind === "directory") await readTree(handle, `${path}/`, out, budget);
    else if (READ_EXT.test(name)) {
      const file = await handle.getFile();
      budget.left -= file.size;
      if (budget.left < 0) throw new Error("That folder is too large to import.");
      out.push({ path, data: new Uint8Array(await file.arrayBuffer()) });
    }
  }
  return out;
}
function summary(r) {
  const extra = [r.skipped ? `${r.skipped} skipped` : "", r.ignored ? `${r.ignored} other files ignored` : ""].filter(Boolean).join(", ");
  const main = r.format === "json"
    ? `Restored ${r.pages} pages and ${r.rows} rows.`
    : `Imported ${r.pages} page${r.pages === 1 ? "" : "s"} and ${r.databases} database${r.databases === 1 ? "" : "s"} (${r.rows} rows)${r.images ? `, ${r.images} images` : ""}.`;
  return extra ? `${main} (${extra})` : main;
}

/**
 * ctx: { store, ws(), flush(), afterImport(result), activeRepoId(), redraw(), onRemote() }
 */
export function createVaultUi(ctx) {
  const { store } = ctx;
  const live = store.name === "folder";
  let resuming = null;
  let armed = null;

  const data = async () => {
    await ctx.flush();
    return ctx.ws().exportAll();
  };
  const filesFor = async (format) => {
    const d = await data();
    return format === "markdown" ? toMarkdownFiles(d) : toJsonFiles(d);
  };
  const run = async (label, job) => {
    try {
      await job();
    } catch (e) {
      if (!aborted(e) && e?.code !== "declined") toast(`${label} failed: ${e?.message ?? e}`, "error");
    }
  };

  // ---------- export ----------
  const exportJsonFile = () => run("Export", async () => {
    const status = await saveTextFile(`denotation-${today()}.json`, JSON.stringify(await data(), null, 2));
    if (status === "copied") toast("Downloads are unavailable here, so the export was copied to your clipboard.");
  });
  const exportZip = (format) => run("Export", async () => {
    const files = await filesFor(format);
    const bytes = await createZip(files, { compress: true });
    await saveBinaryFile(`denotation-${today()}${format === "markdown" ? "-markdown" : ""}.zip`, bytes);
  });
  const exportFolder = (format) => run("Export", async () => {
    const dir = await globalThis.showDirectoryPicker({ id: "denotation-export", mode: "readwrite" });
    const files = await filesFor(format);
    await writeTree(dir, files);
    toast(`Wrote ${files.length} files to "${dir.name}".`);
  });

  // ---------- import ----------
  const doImport = async (files, opts) => {
    await ctx.flush();
    const r = await importFiles(ctx.ws(), files, opts);
    toast(summary(r));
    await ctx.afterImport(r);
  };
  const fileInput = h("input", {
    type: "file",
    accept: ".zip,.json,.md,.markdown,.csv,.tsv,application/zip,application/json,text/markdown,text/csv",
    multiple: true,
    hidden: true,
    onChange: async (e) => {
      const picked = [...e.target.files];
      e.target.value = "";
      if (!picked.length) return;
      await run("Import", async () => {
        const zip = picked.find((f) => /\.zip$/i.test(f.name));
        if (zip) {
          if (picked.length > 1) throw new Error("Import one ZIP at a time.");
          const entries = await readZip(new Uint8Array(await zip.arrayBuffer()));
          return doImport(entries, { name: zip.name.replace(/\.zip$/i, "") || "Imported" });
        }
        const files = await Promise.all(picked.map(async (f) => ({ path: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
        return doImport(files, { parentId: ctx.activeRepoId() });
      });
    }
  });
  const importFolder = () => run("Import", async () => {
    const dir = await globalThis.showDirectoryPicker({ id: "denotation-import", mode: "read" });
    const files = await readTree(dir);
    await doImport(files, { name: dir.name || "Imported" });
  });

  // ---------- live folder ----------
  const connectNow = async (handle, { quiet = false } = {}) => {
    await ctx.flush();
    const c = await store.connect(handle);
    if (!quiet || c.pulled) toast(`Syncing to "${store.status().folderName}"${c.pulled || c.pushed ? `: ${c.pulled} loaded, ${c.pushed} saved` : ""}.`);
  };
  const resume = (handle) => {
    resuming ??= (async () => {
      try {
        const p = await handle.requestPermission({ mode: "readwrite" });
        if (p === "granted") await connectNow(handle);
        else toast(`No access to "${handle.name}". Changes stay in this browser until you reconnect.`, "error");
      } catch (e) {
        toast(`Could not reconnect the folder: ${e?.message ?? e}`, "error");
      } finally {
        resuming = null;
      }
    })();
    return resuming;
  };
  const disarm = () => {
    if (!armed) return;
    window.removeEventListener("pointerdown", armed, true);
    window.removeEventListener("keydown", armed, true);
    armed = null;
  };
  const arm = (handle) => {
    disarm();
    armed = () => {
      disarm();
      resume(handle);
    };
    window.addEventListener("pointerdown", armed, true);
    window.addEventListener("keydown", armed, true);
  };
  const reconnect = () => run("Reconnect", async () => {
    disarm();
    const handle = await loadHandle();
    if (!handle) throw new Error("No folder is remembered. Use Connect folder.");
    await resume(handle);
  });
  const connectFolder = () => openModal({
    title: "Connect a folder",
    content: h(
      "div",
      {},
      h("p", {}, "Denotation will save every page as a JSON file in the folder you choose (denotation.json, pages/ and rows/). This browser keeps a copy, so the app stays fast and works if access lapses."),
      h("p", { class: "hint" }, "If the folder already holds a Denotation workspace, the two are merged: for each page the newer version wins. Nothing else in the folder is touched. A folder inside Google Drive or OneDrive syncs across devices.")
    ),
    actions: [
      { label: "Cancel" },
      {
        label: "Choose folder…",
        class: "primary",
        run: async () => {
          let handle;
          try {
            handle = await globalThis.showDirectoryPicker({ id: "denotation-data", mode: "readwrite" });
          } catch (e) {
            if (aborted(e)) return false;
            throw e;
          }
          await saveHandle(handle);
          disarm();
          await connectNow(handle);
        }
      }
    ]
  });
  const disconnect = async () => {
    const { folderName } = store.status();
    const ok = await confirmDialog(`Stop syncing to "${folderName}"? Your pages stay in this browser and in the folder.`, { title: "Disconnect folder", confirmLabel: "Disconnect", danger: false });
    if (!ok) return;
    await store.flush().catch(() => {});
    store.disconnect();
    disarm();
    await clearHandle().catch(() => {});
    toast("Folder disconnected.");
  };

  /** Boot: reattach a remembered folder. Never opens the picker. */
  async function init() {
    if (!live) return;
    store.onStatus(() => ctx.redraw());
    store.onRemoteChange(() => ctx.onRemote());
    const handle = await loadHandle();
    if (!handle) return;
    store.attach(handle);
    let perm = "prompt";
    try {
      perm = await handle.queryPermission({ mode: "readwrite" });
    } catch {
      // treat as prompt
    }
    if (perm === "granted") await connectNow(handle, { quiet: true }).catch(() => {});
    else if (perm === "prompt") arm(handle);
  }

  // ---------- menus ----------
  const exportItems = () => [
    { header: true, label: "Download" },
    { label: "JSON file", icon: ico("file-braces"), onSelect: exportJsonFile },
    { label: "ZIP — Markdown", icon: ico("file-archive"), onSelect: () => exportZip("markdown") },
    { label: "ZIP — Denotation JSON", icon: ico("file-archive"), onSelect: () => exportZip("json") },
    { header: true, label: "Folder" },
    ...(folderSupported()
      ? [
        { label: "To folder — Markdown…", icon: ico("folder-output"), onSelect: () => exportFolder("markdown") },
        { label: "To folder — Denotation JSON…", icon: ico("folder-output"), onSelect: () => exportFolder("json") }
      ]
      : [{ label: NO_FOLDERS, disabled: true }])
  ];
  const importItems = () => [
    { label: "File… (.zip, .json, .md, .csv)", icon: ico("file-input"), onSelect: () => fileInput.click() },
    folderSupported()
      ? { label: "From folder… (Markdown or JSON)", icon: ico("folder-input"), onSelect: importFolder }
      : { label: NO_FOLDERS, disabled: true }
  ];
  const folderItems = () => {
    const st = store.status();
    return st.state === "off"
      ? [{ label: "Connect folder…", icon: ico("folder-sync"), onSelect: connectFolder }]
      : [
        st.state === "synced" || st.state === "syncing"
          ? { label: "Sync now", icon: ico("refresh-cw"), onSelect: () => run("Sync", () => connectNow(undefined)) }
          : { label: "Reconnect", icon: ico("refresh-cw"), onSelect: reconnect },
        { label: "Choose another folder…", icon: ico("folder-sync"), onSelect: connectFolder },
        { label: "Disconnect", icon: ico("unplug"), onSelect: disconnect }
      ];
  };
  /** Submenu entries for the sidebar's workspace (⋯) menu. */
  const menuItems = () => [
    { label: "Export", icon: ico("file-down"), items: exportItems() },
    { label: "Import", icon: ico("upload"), items: importItems() },
    live ? { label: "Folder", icon: ico("folder-sync"), items: folderItems() } : null
  ].filter(Boolean);

  /** Footer pieces: storage line, notes, and the hidden import file input. */
  function footer({ where, user }) {
    const st = live ? store.status() : { state: "off" };
    const lines = [];
    if (st.state === "off") lines.push(h("div", {}, where));
    else {
      const tag = { syncing: " · syncing…", "needs-permission": " · paused", error: " · error" }[st.state] ?? "";
      lines.push(h("div", { title: "Pages are saved to this folder and cached in this browser." }, ico("folder"), ` Folder: ${st.folderName}${tag}${user ? ` · ${user}` : ""}`));
    }
    if (st.state === "needs-permission" || st.state === "error") {
      lines.push(h(
        "div",
        { class: "note", role: "status" },
        st.state === "error" ? `Folder sync stopped: ${st.error}. Your changes are kept in this browser. ` : `Click anywhere to resume syncing to ${st.folderName}. `,
        h("button", { class: "folder-reconnect", onClick: reconnect }, ico("refresh-cw"), " Reconnect")
      ));
    }
    return { lines, buttons: [], input: fileInput };
  }
  return { init, footer, menuItems, exportJsonFile };
}
