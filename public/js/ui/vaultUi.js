// Export / import menus (JSON file, ZIP, folder) and the Storage dialog (main location + backups,
// sync mode and auto push interval, Pull / Push with warnings, restore from a backup).
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openMenu } from "./popover.js";
import { openModal } from "./modal.js";
import { toast, confirmDialog } from "./dialogs.js";
import { saveTextFile, saveBinaryFile } from "./files.js";
import { createZip, readZip } from "../zip.js";
import { toJsonFiles, toMarkdownFiles, importFiles } from "../vault.js";
import { folderSupported } from "../adapters/folder.js";
import { LOCATION_TYPES, PUSH_MINUTES, locationTypeConfigured, cloudProvider } from "../adapters/locations.js";
import { connectGdrive, gdriveName, cleanFolderName } from "../adapters/gdrive.js";
import { connectOnedrive, onedriveName } from "../adapters/onedrive.js";
import { tokenStore, onCloudWarning, takeRedirectNotice } from "../adapters/oauth.js";
import { openUnlockKeyDialog } from "./security.js";

const READ_EXT = /\.(md|markdown|csv|tsv|json|png|jpe?g|gif|webp)$/i;
const READ_MAX = 256 * 1024 * 1024;
const NO_FOLDERS = "Folders need Chrome or Edge on a computer. Use ZIP instead.";
const NOT_CONFIGURED = "Not configured \u2014 the site owner must add a client ID";
const CLOUD = { gdrive: "Google Drive", onedrive: "OneDrive" };
const locIcon = (type) => (CLOUD[type] ? "cloud" : "folder");
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

/** Ask for a ZIP password. Resolves the text, or null when cancelled. `check(pw)` throws to keep the dialog open. */
function askZipPassword({ title = "Password-protected ZIP", intro, check } = {}) {
  const input = h("input", { type: "password", class: "zip-pw", autocomplete: "off", maxlength: 200 });
  const body = h("div", { class: "pin-dialog" }, h("p", {}, intro ?? "This ZIP is protected with a password."), h("label", {}, "Password", input));
  return new Promise((resolve) => {
    let pw = null;
    openModal({
      title,
      content: body,
      actions: [
        { label: "Cancel" },
        { label: "Open", class: "primary zip-pw-go", run: async () => {
          if (!input.value) throw new Error("Enter the password.");
          await check?.(input.value);
          pw = input.value;
        } }
      ],
      onClose: () => resolve(pw)
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") body.closest(".modal")?.querySelector(".zip-pw-go")?.click();
    });
    input.focus();
  });
}

/**
 * ctx: { store, ws(), flush(), afterImport(result), activeRepoId(), redraw(), onRemote(), keyring }
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
  const exportZip = (format, password = null) => run("Export", async () => {
    const files = await filesFor(format);
    if (password) toast("Encrypting the ZIP\u2026");
    const bytes = await createZip(files, { compress: true, password });
    await saveBinaryFile(`denotation-${today()}${format === "markdown" ? "-markdown" : ""}.zip`, bytes);
  });
  /** Export dialog for ZIPs with options: format and "Protect with a password" (off by default). */
  const openZipExport = () => {
    let format = "json";
    let protect = false;
    const seg = h("div", { class: "seg zip-format", role: "group", "aria-label": "Format" });
    const drawSeg = () => seg.replaceChildren(...[["json", "Denotation JSON"], ["markdown", "Markdown"]].map(([v, label]) => h("button", {
      type: "button",
      "aria-pressed": String(format === v),
      onClick: () => {
        format = v;
        drawSeg();
      }
    }, format === v ? ico("check") : null, label)));
    drawSeg();
    const pw = h("input", { type: "password", class: "zip-pw-new", autocomplete: "new-password", maxlength: 200 });
    const pw2 = h("input", { type: "password", class: "zip-pw-again", autocomplete: "new-password", maxlength: 200 });
    const fields = h("div", { class: "zip-pw-fields", hidden: true },
      h("label", {}, "Password", pw),
      h("label", {}, "Password again", pw2),
      h("p", { class: "hint" }, "Standard ZIP AES-256 (WinZip AE-2): opens in 7-Zip, WinRAR, Keka and macOS Archive Utility; Windows Explorer may not open it. File names inside stay visible. There's no way to recover a forgotten password."));
    const box = h("input", { type: "checkbox", class: "zip-protect", onChange: (e) => {
      protect = e.target.checked;
      fields.hidden = !protect;
      if (protect) pw.focus();
    } });
    openModal({
      title: "Export as ZIP",
      content: h("div", { class: "zip-export" },
        h("p", { class: "set-label" }, "Format"), seg,
        h("label", { class: "check-row" }, box, h("span", {}, "Protect with a password")),
        fields,
        h("p", { class: "hint" }, "Passwords are for ZIP exports only; JSON file exports are always plain.")),
      actions: [
        { label: "Cancel" },
        { label: "Export", class: "primary zip-export-go", run: () => {
          if (protect) {
            if (pw.value.length < 8) throw new Error("Use a password of at least 8 characters.");
            if (pw.value !== pw2.value) throw new Error("The two passwords don't match.");
          }
          exportZip(format, protect ? pw.value : null);
        } }
      ]
    });
  };
  /** Read a ZIP, asking for its password when it has AES entries. Resolves null when the password is cancelled. */
  const readZipAsk = async (bytes) => {
    try {
      return await readZip(bytes);
    } catch (e) {
      if (e?.code !== "password-required") throw e;
    }
    let entries = null;
    const pw = await askZipPassword({
      check: async (p) => {
        try {
          entries = await readZip(bytes, { password: p });
        } catch (e) {
          if (e?.code === "bad-password") throw new Error("Wrong password.");
          throw e;
        }
      }
    });
    return pw ? entries : null;
  };
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
          const entries = await readZipAsk(new Uint8Array(await zip.arrayBuffer()));
          if (!entries) return;
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
  /** Auto mode: "3 changes · next push in 4 min" (minute granularity), or "" when nothing waits. */
  const autoPending = (s) => {
    if (s.mode !== "auto" || !s.unpushed) return "";
    const min = s.nextPushAt ? Math.max(1, Math.ceil((s.nextPushAt - Date.now()) / 60000)) : 0;
    return `${plural(s.unpushed, "change")}${min ? ` · next push in ${min} min` : ""}`;
  };
  const STATE_LABEL = { synced: "Connected", syncing: "Syncing…", "needs-permission": "Needs permission", locked: "Locked", error: "Error" };
  /** An encrypted location this browser has no key for: ask for its PIN or recovery key, then sync it. */
  const unlockLoc = (loc) => run("Unlock", async () => {
    if (!ctx.keyring) throw new Error("Encryption isn't available here.");
    const keyFile = await store.locationKeyFile(loc.id);
    if (!keyFile) throw new Error(`"${loc.name}" has no readable key file (keys.json).`);
    const ok = await openUnlockKeyDialog({ keyFile, keyring: ctx.keyring, intro: `"${loc.name}" is encrypted. Enter the PIN that was used for it, or its recovery key.` });
    if (!ok) return;
    await store.retryLocked();
    const l = st().locations.find((x) => x.id === loc.id);
    toast(l?.state === "locked" ? `"${loc.name}" is still locked: ${l.error}` : `Unlocked "${loc.name}".`, l?.state === "locked" ? "error" : "info");
  });

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
    else toast(c.pulled || c.pushed || c.deleted ? `Merged: ${c.pulled} loaded, ${c.pushed} saved${del}.` : "Everything is in sync.");
  };
  // One cooldown is shared by auto pulls, Pull and Push: while it runs the buttons show the seconds left.
  const coolLeft = () => {
    const until = live ? st().cooldownUntil : 0;
    return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
  };
  const coolLabel = (label) => (coolLeft() ? `${label} (${coolLeft()}s)` : label);
  let coolTick = null;
  const watchCooldown = () => {
    if (coolTick || !coolLeft()) return;
    coolTick = setInterval(() => {
      if (!coolLeft()) {
        clearInterval(coolTick);
        coolTick = null;
      }
      ctx.redraw();
      renderDialog?.();
    }, 1000);
  };
  // Auto mode footer: refresh "next push in M min" when the minute changes (no per-second redraws).
  let minuteTick = null;
  let minuteLabel = "";
  const watchMinutes = () => {
    minuteLabel = autoPending(st());
    if (minuteTick) return;
    minuteTick = setInterval(() => {
      const label = live ? autoPending(st()) : "";
      if (!label) {
        clearInterval(minuteTick);
        minuteTick = null;
      }
      if (label !== minuteLabel) {
        minuteLabel = label;
        ctx.redraw();
        renderDialog?.();
      }
    }, 15000);
  };
  const transfer = (dir) => run(dir === "push" ? "Push" : "Pull", async () => {
    if (coolLeft()) return toast(`Wait ${coolLeft()} s before the next Pull or Push.`);
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
    toast(mode === "manual" ? "Manual sync: use Pull and Push to sync with the main location." : `Auto sync: changes are pushed every ${store.pushMinutes} min.`);
  });
  const setPushMinutes = (n) => run("Auto push", async () => {
    store.setPushMinutes(n);
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
    let r;
    try {
      r = await store.addLocation(handle, { role });
    } catch (e) {
      if (e?.code !== "locked") throw e;
      const loc = st().locations.find((l) => l.state === "locked" && l.name === handle.name);
      if (loc && /unlock to sync/.test(loc.error)) return unlockLoc(loc);
      throw e;
    }
    const name = handle.name;
    if (role === "backup") toast(`Backing up to "${name}".`);
    else if (r.counts?.manual) toast(`"${name}" is the main location. Manual sync: use Pull or Push.`);
    else if (r.counts) toast(`Syncing with "${name}"${r.counts.pulled || r.counts.pushed ? `: ${r.counts.pulled} loaded, ${r.counts.pushed} saved` : ""}.`);
    else toast(`Added "${name}". Click anywhere to allow access.`);
  });
  /**
   * Google Drive / OneDrive: ask for the workspace folder name (and, for Drive, where it lives), then sign in.
   * The sign-in popup must open inside the click, so the dialog's button starts it before anything is awaited.
   */
  const addCloud = (type, role) => {
    const label = CLOUD[type];
    const folder = h("input", { type: "text", class: "cloud-folder", value: "Denotation", maxlength: 60, autocomplete: "off", spellcheck: "false" });
    let space = "drive";
    const seg = h("div", { class: "seg cloud-space", role: "group", "aria-label": "Where in Google Drive" });
    const drawSeg = () => seg.replaceChildren(...[["drive", "Folder in My Drive"], ["appdata", "Hidden app folder"]].map(([v, text]) => h("button", {
      type: "button",
      "aria-pressed": String(space === v),
      onClick: () => {
        space = v;
        drawSeg();
      }
    }, space === v ? ico("check") : null, text)));
    drawSeg();
    const nameFor = () => (type === "gdrive" ? gdriveName({ folder: cleanFolderName(folder.value), space }) : onedriveName({ folder: cleanFolderName(folder.value) }));
    const body = h("div", { class: "cloud-add" },
      h("label", {}, "Workspace folder", folder),
      type === "gdrive" ? h("p", { class: "set-label" }, "Where") : null,
      type === "gdrive" ? seg : null,
      h("p", { class: "hint" }, type === "gdrive"
        ? "Denotation can only see the files it creates. \u201cFolder in My Drive\u201d is visible in Drive; the hidden app folder isn't (Drive settings \u203a Manage apps can delete it)."
        : "Files go to Apps \u203a Denotation in your OneDrive. Denotation can't see your other files."),
      h("p", { class: "hint" }, `${role === "main" ? "The main location syncs both ways." : "A backup only receives copies."} Use the same folder name on every device.`));
    openModal({
      title: `${label} as ${role === "main" ? (mainLoc() ? "new main" : "main") : "backup"}`,
      content: body,
      actions: [
        { label: "Cancel" },
        { label: "Sign in\u2026", class: "primary cloud-signin", run: () => {
          const name = cleanFolderName(folder.value);
          if (!name) throw new Error("Use a folder name of 1\u201360 characters without / \\ : * ? \" < > | # %.");
          if (st().locations.some((l) => l.type === type && l.name === nameFor())) throw new Error(`"${nameFor()}" is already connected.`);
          const opts = { folder: name, space, role };
          const started = type === "gdrive" ? connectGdrive(opts) : connectOnedrive(opts); // opens the popup now
          finishCloud(type, role, opts, started);
        } }
      ]
    });
    folder.focus();
  };
  const finishCloud = (type, role, opts, started) => run("Add location", async () => {
    let r;
    try {
      r = await started;
    } catch (e) {
      if (e?.code === "access_denied") return toast("Sign-in was cancelled.");
      if (e?.code !== "popup-blocked") throw e;
      const ok = await confirmDialog(`The sign-in window was blocked. Sign in to ${CLOUD[type]} in this tab instead? Denotation reloads when you come back, and adds the location then.`, { title: "Sign in in this tab", confirmLabel: "Continue", danger: false });
      if (!ok) return;
      await ctx.flush();
      await store.flush().catch(() => {});
      return void (type === "gdrive" ? connectGdrive({ ...opts, mode: "redirect" }) : connectOnedrive({ ...opts, mode: "redirect" }));
    }
    await ctx.flush();
    let added;
    try {
      added = await store.addLocation(cloudProvider(r.handle), { role });
    } catch (e) {
      await tokenStore().delete(r.handle.tokenKey).catch(() => {});
      if (e?.code === "locked") {
        const loc = st().locations.find((l) => l.state === "locked" && l.type === type);
        if (loc && /unlock to sync/.test(loc.error)) return unlockLoc(loc);
      }
      throw e;
    }
    const loc = st().locations.find((l) => l.id === added.id);
    const name = loc?.name ?? CLOUD[type];
    if (loc?.state === "error") toast(`Added "${name}", but it failed: ${loc.error}`, "error");
    else if (role === "backup") toast(`Backing up to "${name}".`);
    else if (added.counts?.manual) toast(`"${name}" is the main location. Manual sync: use Pull or Push.`);
    else toast(`Syncing with "${name}"${added.counts?.pulled || added.counts?.pushed ? `: ${added.counts.pulled} loaded, ${added.counts.pushed} saved` : ""}.`);
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
    ...LOCATION_TYPES.filter((t) => CLOUD[t.type]).flatMap((t) => (locationTypeConfigured(t.type)
      ? [
        { label: mainLoc() ? `${t.label} as new main\u2026` : `${t.label} as main\u2026`, icon: ico("cloud-sync"), hint: mainLoc() ? "current main \u2192 backup" : "", onSelect: () => addCloud(t.type, "main") },
        { label: `${t.label} as backup\u2026`, icon: ico("cloud-upload"), onSelect: () => addCloud(t.type, "backup") }
      ]
      : [{ label: `${t.label}: ${NOT_CONFIGURED}`, icon: ico("cloud-off"), disabled: true }]))
  ], { width: 270 });
  const locRow = (loc) => {
    const isMain = loc.role === "main";
    const s = st();
    const type = LOCATION_TYPES.find((t) => t.type === loc.type)?.label ?? loc.type;
    const btn = (label, icon, onClick, cls = "", disabled = false) => h("button", { class: `chip-btn ${cls}`.trim(), onClick, disabled }, ico(icon), ` ${label}`);
    const locked = loc.state === "locked";
    const needs = loc.state === "needs-permission" || locked;
    return h(
      "li",
      { class: `loc-row${isMain ? " main" : ""}` },
      h("div", { class: "loc-head" }, ico(locIcon(loc.type)), h("strong", { class: "loc-name" }, loc.name || type), h("span", { class: "chip" }, isMain ? "Main" : "Backup"), loc.encrypted ? h("span", { class: "chip enc-chip" }, ico("lock-keyhole"), " Encrypted") : null),
      h("div", { class: "hint loc-meta" }, `${type} · ${(CLOUD[loc.type] && loc.state === "needs-permission" ? "Signed out" : STATE_LABEL[loc.state]) ?? loc.state}${loc.error ? `: ${loc.error}` : ""} · last ${isMain ? "synced" : "copied"} ${when(loc.lastSyncAt)}`),
      isMain && !needs
        ? h(
          "div",
          { class: "seg loc-mode", role: "group", "aria-label": "Sync mode" },
          h("button", { "aria-pressed": String(s.mode === "auto"), onClick: () => setMode("auto") }, s.mode === "auto" ? ico("check") : null, "Auto"),
          h("button", { "aria-pressed": String(s.mode === "manual"), onClick: () => setMode("manual") }, s.mode === "manual" ? ico("check") : null, "Manual")
        )
        : null,
      isMain && !needs && s.mode === "auto"
        ? h(
          "div",
          { class: "loc-push" },
          h(
            "div",
            { class: "set-row" },
            h("label", { for: "loc-push-min" }, "Auto push every"),
            h(
              "select",
              { id: "loc-push-min", value: String(s.pushMinutes), onChange: (e) => setPushMinutes(Number(e.target.value)), onBlur: () => renderDialog?.() },
              ...PUSH_MINUTES.map((m) => h("option", { value: String(m) }, `${m} minutes`))
            )
          ),
          h("p", { class: "hint" }, "Pulls happen automatically when the folder has a newer version.")
        )
        : null,
      isMain && !needs && s.mode === "auto" && s.unpushed ? h("div", { class: "hint" }, autoPending(s)) : null,
      isMain && !needs && s.mode === "manual" && (s.unpushed || s.incoming)
        ? h("div", { class: "hint" }, [s.unpushed ? `${plural(s.unpushed, "change")} not pushed` : "", s.incoming ? "Folder has newer changes" : ""].filter(Boolean).join(" · "))
        : null,
      h(
        "div",
        { class: "loc-actions" },
        loc.state === "needs-permission" ? btn(CLOUD[loc.type] ? "Sign in\u2026" : "Reconnect", CLOUD[loc.type] ? "log-in" : "refresh-cw", reconnectAll) : null,
        locked && /unlock to sync/.test(loc.error) ? btn("Unlock…", "lock-keyhole-open", () => unlockLoc(loc), "loc-unlock") : null,
        isMain && !needs ? btn(coolLabel("Pull"), "download", () => transfer("pull"), "", !!coolLeft()) : null,
        isMain && !needs ? btn(coolLabel("Push"), "upload", () => transfer("push"), "", !!coolLeft()) : null,
        !isMain ? btn("Make main", "folder-sync", () => makeMain(loc)) : null,
        !isMain && !needs ? btn("Restore from this backup…", "rotate-ccw", () => restoreFrom(loc)) : null,
        btn("Remove", "unplug", () => removeLoc(loc))
      )
    );
  };
  const openStorage = () => {
    const body = h("div", { class: "storage-dialog" });
    renderDialog = () => {
      // Don't rebuild under an open select (status ticks would close it); its blur re-renders.
      const active = document.activeElement;
      if (active?.tagName === "SELECT" && body.contains(active)) return;
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
      watchCooldown();
      ctx.redraw();
      renderDialog?.();
    });
    store.onRemoteChange(() => ctx.onRemote());
    const warned = new Set();
    onCloudWarning((w) => {
      if (w?.type !== "too-large" || warned.has(`${w.location}/${w.path}`)) return;
      warned.add(`${w.location}/${w.path}`);
      toast(`${w.path} is too large (${Math.ceil(w.size / 1048576)} MB) for "${w.location}" and wasn't copied there. It is kept in this browser.`, "error");
    });
    const notice = takeRedirectNotice();
    if (notice) toast(notice.text, notice.kind === "error" ? "error" : "info");
    const r = await store.init();
    if (r.needsPermission.length) arm();
  }

  // ---------- menus ----------
  const exportItems = () => [
    { header: true, label: "Download" },
    { label: "JSON file", icon: ico("file-braces"), onSelect: exportJsonFile },
    { label: "ZIP — Markdown", icon: ico("file-archive"), onSelect: () => exportZip("markdown") },
    { label: "ZIP — Denotation JSON", icon: ico("file-archive"), onSelect: () => exportZip("json") },
    { label: "ZIP with options… (password)", icon: ico("file-lock"), onSelect: openZipExport },
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
    const ok = m && m.state !== "needs-permission" && m.state !== "locked";
    const s = live ? st() : {};
    return [
      { label: "Export", icon: ico("file-down"), items: exportItems() },
      { label: "Import", icon: ico("upload"), items: importItems() },
      live ? { label: "Storage…", icon: ico("hard-drive"), hint: m ? (s.mode === "manual" ? "manual" : "auto") : "", onSelect: openStorage } : null,
      ok ? { label: coolLabel("Pull"), icon: ico("download"), hint: s.incoming ? "new" : "", disabled: !!coolLeft(), onSelect: () => transfer("pull") } : null,
      ok ? { label: coolLabel("Push"), icon: ico("upload"), hint: s.unpushed ? String(s.unpushed) : "", disabled: !!coolLeft(), onSelect: () => transfer("push") } : null,
      m && m.state === "needs-permission" ? { label: "Reconnect storage", icon: ico("refresh-cw"), onSelect: reconnectAll } : null,
      m && m.state === "locked" ? { label: "Unlock storage…", icon: ico("lock-keyhole-open"), onSelect: () => unlockLoc(m) } : null
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
      const tag = { syncing: " · syncing…", "needs-permission": " · paused", locked: " · locked", error: " · error" }[m.state] ?? "";
      lines.push(h("div", { title: "Pages sync with the main location and are cached in this browser." }, ico(locIcon(m.type)), ` Main: ${m.name}${tag}${s.mode === "manual" ? " · manual" : ""}${backups}${user ? ` · ${user}` : ""}`));
      if (s.mode === "auto" && m.state !== "needs-permission" && s.unpushed) {
        lines.push(h("div", { class: "note sync-pending", role: "status", title: "Pushed to the main location at the interval set in Storage, and when this tab is hidden or closed." }, autoPending(s)));
        watchMinutes();
      }
      if (s.mode === "manual" && m.state === "synced" && (s.unpushed || s.incoming)) {
        lines.push(h(
          "div",
          { class: "note sync-pending", role: "status" },
          [s.unpushed ? `${plural(s.unpushed, "change")} not pushed` : "", s.incoming ? "Folder has newer changes" : ""].filter(Boolean).join(" · "),
          " ",
          s.incoming ? h("button", { onClick: () => transfer("pull"), disabled: !!coolLeft() }, ico("download"), ` ${coolLabel("Pull")}`) : null,
          s.unpushed ? h("button", { onClick: () => transfer("push"), disabled: !!coolLeft() }, ico("upload"), ` ${coolLabel("Push")}`) : null
        ));
      }
    }
    const waiting = s.locations.filter((l) => l.state === "needs-permission");
    if (waiting.length) {
      lines.push(h(
        "div",
        { class: "note", role: "status" },
        waiting.every((l) => CLOUD[l.type]) ? `Sign in again to resume ${waiting.map((l) => `"${l.name}"`).join(", ")}. ` : `Click anywhere to resume ${waiting.map((l) => `"${l.name}"`).join(", ")}. `,
        h("button", { class: "folder-reconnect", onClick: reconnectAll }, ico("refresh-cw"), waiting.every((l) => CLOUD[l.type]) ? " Sign in\u2026" : " Reconnect")
      ));
    }
    for (const l of s.locations.filter((x) => x.state === "locked")) {
      lines.push(h(
        "div",
        { class: "note enc-locked", role: "status" },
        ico("lock-keyhole"), ` "${l.name}": ${/unlock to sync/.test(l.error) ? "Encrypted \u2014 unlock to sync." : l.error} `,
        /unlock to sync/.test(l.error) ? h("button", { class: "loc-unlock", onClick: () => unlockLoc(l) }, ico("lock-keyhole-open"), " Unlock") : null
      ));
    }
    if (s.job) lines.push(h("div", { class: "note", role: "status" }, `${s.job.target === "encrypted" ? "Encrypting" : "Decrypting"} "${s.job.name}": ${s.job.done} of ${s.job.total}\u2026`));
    for (const l of s.locations.filter((x) => x.state === "error")) {
      lines.push(h("div", { class: "note", role: "status" }, l.role === "main" ? `Sync with "${l.name}" stopped: ${l.error}. Your changes are kept in this browser.` : `Backup to "${l.name}" failed: ${l.error}.`));
    }
    return { lines, buttons: [], input: fileInput };
  }
  return { init, footer, menuItems, exportJsonFile };
}
