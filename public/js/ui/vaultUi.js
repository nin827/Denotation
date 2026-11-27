// Export / import menus (JSON file, ZIP, folder) and the Storage dialog (main location + backups,
// sync mode, Pull / Push with warnings, restore from a backup).
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { openModal } from "./modal.js";
import { toast, confirmDialog } from "./dialogs.js";
import { saveTextFile, saveBinaryFile } from "./files.js";
import { createZip, readZip } from "../zip.js";
import { toJsonFiles, toMarkdownFiles, importFiles } from "../vault.js";
import { folderSupported } from "../adapters/folder.js";
import { LOCATION_TYPES } from "../adapters/locations.js";

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

  // ---------- storage locations (main + backups) ----------
  const st = () => store.status();
  const mainLoc = () => st().locations.find((l) => l.role === "main") ?? null;
  const backupLocs = () => st().locations.filter((l) => l.role === "backup");
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");
  const STATE_LABEL = { synced: "Connected", syncing: "Syncing…", "needs-permission": "Needs permission", error: "Error" };

  const reconnectAll = () => run("Reconnect", async () => {
    disarm();
    const failed = await store.requestPermissions();
    if (failed.length) toast(`No access to ${failed.map((n) => `"${n}"`).join(", ")}. Changes stay in this browser until you reconnect.`, "error");
  });
  const disarm = () => {
    if (!armed) return;
    window.removeEventListener("pointerdown", armed, true);
    window.removeEventListener("keydown", armed, true);
    armed = null;
  };
  /** One user gesture anywhere asks for access to every location that needs it. */
  const arm = () => {
    disarm();
    armed = () => {
      disarm();
      resuming ??= reconnectAll().finally(() => {
        resuming = null;
      });
    };
    window.addEventListener("pointerdown", armed, true);
    window.addEventListener("keydown", armed, true);
  };

  // Titles for the warning lists: page title, or a row's first column value.
  const titleOf = async (c) => {
    const r = c.local ?? c.remote;
    if (c.collection === "pages") return r?.title || "Untitled";
    const db = r?.dbId ? await store.get("pages", r.dbId).catch(() => null) : null;
    const col = db?.columns?.[0];
    const v = col ? r?.values?.[col.id] : "";
    const name = v === undefined || v === null || v === "" ? "Untitled row" : String(v).slice(0, 80);
    return db ? `${name} (row in ${db.title || "Untitled"})` : name;
  };
  const conflictLine = (dir, c) => {
    const L = when(c.localAt);
    const R = when(c.remoteAt);
    if (dir === "push") {
      return {
        newer: `Folder: ${R} · here: ${L}`,
        "only-remote": `Only in the folder (${R}): push deletes it`,
        "deleted-locally": `Deleted here ${L} · changed in the folder ${R}`,
        "deleted-remotely": `Deleted in the folder ${R} · here: ${L}`
      }[c.reason];
    }
    return {
      newer: `Here: ${L} · folder: ${R}`,
      "only-local": `Only in this browser (${L}): pull removes it`,
      "deleted-locally": `Deleted here ${L} · folder copy ${R}`,
      "deleted-remotely": `Edited here ${L} · deleted in the folder ${R}`
    }[c.reason];
  };
  /** Ask before a one-way overwrite that would lose newer state. Resolves "cancel" | "force" | "merge". */
  const warnDialog = async (dir, list) => {
    const SHOW = 5;
    const titles = await Promise.all(list.slice(0, SHOW).map(titleOf));
    const folder = mainLoc()?.name ?? "the folder";
    const push = dir === "push";
    return new Promise((resolve) => {
      let answer = "cancel";
      openModal({
        title: push ? "The folder has newer changes" : "This browser has newer changes",
        content: h(
          "div",
          { class: "sync-warn" },
          h("p", {}, push
            ? `${plural(list.length, "item")} in "${folder}" changed after this browser's copy. Pushing replaces ${list.length === 1 ? "it" : "them"} with this browser's version.`
            : `${plural(list.length, "item")} in this browser ${list.length === 1 ? "is" : "are"} newer than in "${folder}". Pulling replaces ${list.length === 1 ? "it" : "them"} with the folder's version.`),
          h("ul", { class: "sync-warn-list" }, ...list.slice(0, SHOW).map((c, i) => h("li", {}, h("strong", {}, titles[i]), h("span", { class: "hint" }, conflictLine(dir, c))))),
          list.length > SHOW ? h("p", { class: "hint" }, `and ${list.length - SHOW} more.`) : null,
          h("p", { class: "hint" }, "Merge keeps the newest version of each item on both sides.")
        ),
        actions: [
          { label: "Cancel" },
          { label: "Merge (keep newest)", run: () => void (answer = "merge") },
          { label: push ? "Push anyway" : "Pull anyway", class: "danger", run: () => void (answer = "force") }
        ],
        onClose: () => resolve(answer)
      });
    });
  };
  const summaryToast = (kind, c) => {
    const del = c.deleted ? `, ${c.deleted} deleted` : "";
    if (kind === "push") toast(c.pushed || c.deleted ? `Pushed ${c.pushed}${del} to "${mainLoc()?.name}".` : "Nothing to push: the folder already matches.");
    else if (kind === "pull") toast(c.pulled || c.deleted ? `Pulled ${c.pulled}${del} from "${mainLoc()?.name}".` : "Nothing to pull: this browser already matches.");
    else toast(c.pulled || c.pushed || c.deleted ? `Synced: ${c.pulled} loaded, ${c.pushed} saved${del}.` : "Everything is in sync.");
  };
  const syncNow = () => run("Sync", async () => {
    await ctx.flush();
    summaryToast("merge", (await store.syncNow()).counts);
  });
  const transfer = (dir) => run(dir === "push" ? "Push" : "Pull", async () => {
    await ctx.flush();
    const r = await store[dir]();
    if (r.applied) return summaryToast(dir, r.counts);
    const list = dir === "push" ? r.conflicts.newerRemote : r.conflicts.olderRemote;
    const answer = await warnDialog(dir, list);
    if (answer === "force") summaryToast(dir, (await store[dir]({ force: true })).counts);
    else if (answer === "merge") summaryToast("merge", (await store.syncNow()).counts);
  });
  const setMode = (mode) => run("Sync mode", async () => {
    await ctx.flush();
    await store.setMode(mode);
    toast(mode === "manual" ? "Manual sync: use Pull and Push to sync with the main location." : "Automatic sync is on.");
  });
  const addFolder = (role) => run("Add location", async () => {
    let handle;
    try {
      handle = await globalThis.showDirectoryPicker({ id: "denotation-data", mode: "readwrite" });
    } catch (e) {
      if (aborted(e)) return;
      throw e;
    }
    await ctx.flush();
    const r = await store.addLocation(handle, { role });
    const name = handle.name;
    if (role === "backup") toast(`Backing up to "${name}".`);
    else if (r.counts?.manual) toast(`"${name}" is the main location. Manual sync: use Pull or Push.`);
    else if (r.counts) toast(`Syncing with "${name}"${r.counts.pulled || r.counts.pushed ? `: ${r.counts.pulled} loaded, ${r.counts.pushed} saved` : ""}.`);
    else toast(`Added "${name}". Click anywhere to allow access.`);
  });
  const makeMain = (loc) => run("Make main", async () => {
    const ok = await confirmDialog(`Make "${loc.name}" the main location? It syncs both ways from now on${mainLoc() ? ` and "${mainLoc().name}" becomes a backup` : ""}. ${store.mode === "manual" ? "Manual mode: nothing changes until you Pull or Push." : "The first sync keeps the newest version of each item."}`, { title: "Make main", confirmLabel: "Make main", danger: false });
    if (!ok) return;
    await ctx.flush();
    const r = await store.makeMain(loc.id);
    if (r.needsPermission) arm();
    else if (r.counts && !r.counts.manual) summaryToast("merge", r.counts);
  });
  const removeLoc = (loc) => run("Remove", async () => {
    const ok = await confirmDialog(`Stop using "${loc.name}"? Its files stay where they are, and your pages stay in this browser.`, { title: loc.role === "main" ? "Remove main location" : "Remove backup", confirmLabel: "Remove", danger: false });
    if (!ok) return;
    await store.flush().catch(() => {});
    await store.removeLocation(loc.id);
    toast(`Removed "${loc.name}".`);
  });
  const restoreFrom = (loc) => run("Restore", async () => {
    await ctx.flush();
    const [b, localNewest] = await Promise.all([store.readBackup(loc.id), store.localNewest()]);
    if (!b.count) throw new Error(`"${loc.name}" holds no pages to restore.`);
    const older = b.newest < localNewest;
    const ok = await confirmDialog(
      `"${loc.name}" was last changed ${when(b.newest)}; this browser was last changed ${when(localNewest)}. Restoring replaces ${plural(b.count, "page or row", "pages and rows")} here with the backup's version${older ? ", including newer edits made since" : ""}. Pages created after the backup are kept.`,
      { title: older ? "Restore an older backup?" : "Restore from backup", confirmLabel: "Restore", danger: older }
    );
    if (!ok) return;
    await doImport(b.files, {});
  });

  // ---------- storage dialog ----------
  let renderDialog = null;
  const addMenu = (anchor) => openMenu(anchor, [
    { header: true, label: "Folder" },
    ...(folderSupported()
      ? [
        { label: mainLoc() ? "Folder as new main…" : "Folder as main…", icon: ico("folder-sync"), hint: mainLoc() ? "current main → backup" : "", onSelect: () => addFolder("main") },
        { label: "Folder as backup…", icon: ico("folder-output"), onSelect: () => addFolder("backup") }
      ]
      : [{ label: NO_FOLDERS, disabled: true }]),
    { header: true, label: "Cloud" },
    ...LOCATION_TYPES.filter((t) => !t.available).map((t) => ({ label: `${t.label} (coming soon)`, icon: ico("cloud"), disabled: true }))
  ], { width: 250 });
  const locRow = (loc) => {
    const isMain = loc.role === "main";
    const s = st();
    const type = LOCATION_TYPES.find((t) => t.type === loc.type)?.label ?? loc.type;
    const btn = (label, icon, onClick, cls = "") => h("button", { class: `chip-btn ${cls}`.trim(), onClick }, ico(icon), ` ${label}`);
    const needs = loc.state === "needs-permission";
    return h(
      "li",
      { class: `loc-row${isMain ? " main" : ""}` },
      h("div", { class: "loc-head" }, ico("folder"), h("strong", { class: "loc-name" }, loc.name || "Folder"), h("span", { class: "chip" }, isMain ? "Main" : "Backup")),
      h("div", { class: "hint loc-meta" }, `${type} · ${STATE_LABEL[loc.state] ?? loc.state}${loc.error ? `: ${loc.error}` : ""} · last ${isMain ? "synced" : "copied"} ${when(loc.lastSyncAt)}`),
      isMain && !needs
        ? h(
          "div",
          { class: "seg loc-mode", role: "group", "aria-label": "Sync mode" },
          h("button", { "aria-pressed": String(s.mode === "auto"), onClick: () => setMode("auto") }, s.mode === "auto" ? ico("check") : null, "Auto"),
          h("button", { "aria-pressed": String(s.mode === "manual"), onClick: () => setMode("manual") }, s.mode === "manual" ? ico("check") : null, "Manual")
        )
        : null,
      isMain && !needs && s.mode === "manual" && (s.unpushed || s.incoming)
        ? h("div", { class: "hint" }, [s.unpushed ? `${plural(s.unpushed, "change")} not pushed` : "", s.incoming ? "Folder has newer changes" : ""].filter(Boolean).join(" · "))
        : null,
      h(
        "div",
        { class: "loc-actions" },
        needs ? btn("Reconnect", "refresh-cw", reconnectAll) : null,
        isMain && !needs ? btn("Pull", "download", () => transfer("pull")) : null,
        isMain && !needs ? btn("Push", "upload", () => transfer("push")) : null,
        isMain && !needs ? btn("Sync now", "refresh-cw", syncNow) : null,
        !isMain ? btn("Make main", "folder-sync", () => makeMain(loc)) : null,
        !isMain && !needs ? btn("Restore from this backup…", "rotate-ccw", () => restoreFrom(loc)) : null,
        btn("Remove", "unplug", () => removeLoc(loc))
      )
    );
  };
  const openStorage = () => {
    const body = h("div", { class: "storage-dialog" });
    renderDialog = () => {
      const locs = st().locations;
      const ordered = [...locs.filter((l) => l.role === "main"), ...locs.filter((l) => l.role === "backup")];
      body.replaceChildren(
        h("p", { class: "hint" }, "Pages are always kept in this browser. The main location syncs both ways (a folder inside Google Drive or OneDrive syncs across devices); backups only receive copies."),
        ordered.length ? h("ul", { class: "loc-list" }, ...ordered.map(locRow)) : h("p", {}, "No storage locations yet: pages are saved in this browser only.")
      );
    };
    renderDialog();
    openModal({
      title: "Storage",
      content: body,
      actions: [
        { label: "Add location…", class: "primary loc-add", run: () => {
          addMenu(document.querySelector(".modal-actions .loc-add"));
          return false;
        } },
        { label: "Close" }
      ],
      onClose: () => {
        renderDialog = null;
      }
    });
  };

  /** Boot: load the storage locations (migrating an old single folder). Never opens the picker. */
  async function init() {
    if (!live) return;
    store.onStatus(() => {
      ctx.redraw();
      renderDialog?.();
    });
    store.onRemoteChange(() => ctx.onRemote());
    const r = await store.init();
    if (r.needsPermission.length) arm();
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
  /** Entries for the sidebar's workspace (⋯) menu. */
  const menuItems = () => {
    const m = live ? mainLoc() : null;
    const ok = m && m.state !== "needs-permission";
    const s = live ? st() : {};
    return [
      { label: "Export", icon: ico("file-down"), items: exportItems() },
      { label: "Import", icon: ico("upload"), items: importItems() },
      live ? { label: "Storage…", icon: ico("hard-drive"), hint: m ? (s.mode === "manual" ? "manual" : "auto") : "", onSelect: openStorage } : null,
      ok ? { label: "Pull", icon: ico("download"), hint: s.incoming ? "new" : "", onSelect: () => transfer("pull") } : null,
      ok ? { label: "Push", icon: ico("upload"), hint: s.unpushed ? String(s.unpushed) : "", onSelect: () => transfer("push") } : null,
      ok ? { label: "Sync now", icon: ico("refresh-cw"), onSelect: syncNow } : null,
      m && !ok ? { label: "Reconnect storage", icon: ico("refresh-cw"), onSelect: reconnectAll } : null
    ].filter(Boolean);
  };

  /** Footer pieces: storage line, notes, and the hidden import file input. */
  function footer({ where, user }) {
    const lines = [];
    const s = live ? st() : { state: "off", locations: [] };
    const m = s.locations.find((l) => l.role === "main");
    const nb = s.locations.length - (m ? 1 : 0);
    const backups = nb ? ` · ${plural(nb, "backup")}` : "";
    if (!m) lines.push(h("div", {}, where + backups));
    else {
      const tag = { syncing: " · syncing…", "needs-permission": " · paused", error: " · error" }[m.state] ?? "";
      lines.push(h("div", { title: "Pages sync with the main location and are cached in this browser." }, ico("folder"), ` Main: ${m.name}${tag}${s.mode === "manual" ? " · manual" : ""}${backups}${user ? ` · ${user}` : ""}`));
      if (s.mode === "manual" && m.state === "synced" && (s.unpushed || s.incoming)) {
        lines.push(h(
          "div",
          { class: "note sync-pending", role: "status" },
          [s.unpushed ? `${plural(s.unpushed, "change")} not pushed` : "", s.incoming ? "Folder has newer changes" : ""].filter(Boolean).join(" · "),
          " ",
          s.incoming ? h("button", { onClick: () => transfer("pull") }, ico("download"), " Pull") : null,
          s.unpushed ? h("button", { onClick: () => transfer("push") }, ico("upload"), " Push") : null
        ));
      }
    }
    const waiting = s.locations.filter((l) => l.state === "needs-permission");
    if (waiting.length) {
      lines.push(h(
        "div",
        { class: "note", role: "status" },
        `Click anywhere to resume ${waiting.map((l) => `"${l.name}"`).join(", ")}. `,
        h("button", { class: "folder-reconnect", onClick: reconnectAll }, ico("refresh-cw"), " Reconnect")
      ));
    }
    for (const l of s.locations.filter((x) => x.state === "error")) {
      lines.push(h("div", { class: "note", role: "status" }, l.role === "main" ? `Sync with "${l.name}" stopped: ${l.error}. Your changes are kept in this browser.` : `Backup to "${l.name}" failed: ${l.error}.`));
    }
    return { lines, buttons: [], input: fileInput };
  }
  return { init, footer, menuItems, exportJsonFile };
}
