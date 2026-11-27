// Settings → Security (PIN set / change / remove, auto-lock, encryption) and the "Reset this browser" dialog.
// There is no PIN recovery for the lock itself: a forgotten PIN means resetting this browser's Denotation data.
// Encrypted data can then be opened again with the recovery key (see ../crypto.js for the key hierarchy).
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openModal } from "./modal.js";
import { toast } from "./dialogs.js";
import { createLocationRegistry } from "../adapters/locations.js";
import {
  createKeyFile,
  replaceRecovery,
  setSavedRecovery,
  readSavedRecovery,
  rewrapPin,
  unwrapWithSecret,
  unwrapWithPin
} from "../crypto.js";
import { migrateBrowserCopy } from "../adapters/local.js";
import {
  PIN_LENGTHS,
  IDLE_CHOICES,
  RESET_FLAG,
  loadRecord,
  setPin,
  removePin,
  tryPin,
  validPin,
  loadIdle,
  saveIdle,
  randomCode,
  clearAppKeys,
  hasPin,
  verifyPin,
  pinThrottle
} from "../lock.js";

const DB_NAME = "denotation";
export const HONEST = "The PIN hides the app on this device. On its own it doesn't encrypt your data (see Encryption below).";
export const ENC_HONEST = "Files are encrypted with a key unlocked by your PIN. A 4\u20136 digit PIN can be guessed by someone who has a copy of the files; keep the files private. If you forget the PIN and lose the recovery key, encrypted data can't be recovered.";

/** Whole seconds (at least 1) for a wait in milliseconds. */
export function formatWait(ms) {
  return `${Math.max(1, Math.ceil(ms / 1000))} s`;
}
/** Message for a failed tryPin() result (a wrong PIN blocks input for 3 s). */
export function failMessage(r) {
  if (r.throttled) return `Wait ${formatWait(r.waitMs)} before trying again.`;
  return `Wrong PIN. Try again in ${formatWait(r.waitMs || 3000)}.`;
}

// ---------- reset ----------
function deleteDb() {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    setTimeout(fin, 4000);
    try {
      if (!globalThis.indexedDB) return fin();
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = fin;
      req.onerror = fin;
      req.onblocked = () => setTimeout(fin, 1500); // another tab holds it open: the delete finishes when it closes
    } catch {
      fin();
    }
  });
}
async function wipe() {
  clearAppKeys(globalThis.localStorage);
  try {
    sessionStorage.clear();
  } catch {
    // blocked storage
  }
  await deleteDb();
}
/** Deletes everything Denotation keeps in this browser, then reloads. `prepare` stops pending saves first. */
export async function resetBrowser({ prepare } = {}) {
  try {
    await prepare?.();
  } catch {
    // the data is going anyway
  }
  await wipe();
  // Unload handlers (late saves, a final folder push) may write again: the next start wipes once more.
  try {
    sessionStorage.setItem(RESET_FLAG, "1");
  } catch {
    // blocked storage
  }
  location.reload();
}
/** Boot: finish a reset begun before the reload. Call before anything reads storage. */
export async function finishPendingReset() {
  let flag = null;
  try {
    flag = sessionStorage.getItem(RESET_FLAG);
  } catch {
    return;
  }
  if (!flag) return;
  await wipe();
}

function storageFacts(getStatus) {
  let s = null;
  try {
    s = getStatus?.() ?? null;
  } catch {
    s = null;
  }
  if (s && Array.isArray(s.locations)) {
    const m = s.locations.find((l) => l.role === "main");
    return { main: m?.name ?? null, unpushed: m ? Number(s.unpushed) || 0 : 0 };
  }
  let list = [];
  try {
    list = createLocationRegistry().list();
  } catch {
    list = [];
  }
  const m = list.find((l) => l.role === "main");
  return { main: m?.name ?? null, unpushed: null };
}

/**
 * The confirm dialog for a full reset. `locked`: opened from the lock screen (no export offered).
 * getStatus(): the folder adapter's status, when there is one. onExport(): runs an export. prepare(): stops saves.
 */
export function openResetDialog({ locked = false, getStatus, onExport, prepare } = {}) {
  const code = randomCode(8);
  const facts = storageFacts(getStatus);
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const warnings = [];
  if (!facts.main) warnings.push("There's no main storage location, so pages and rows that exist only in this browser will be lost.");
  else if (facts.unpushed === null) warnings.push(`Any changes not yet pushed to "${facts.main}" will be lost.`);
  else if (facts.unpushed > 0) warnings.push(`${plural(facts.unpushed, "change")} ${facts.unpushed === 1 ? "hasn't" : "haven't"} been pushed to "${facts.main}" and will be lost.`);
  const input = h("input", {
    type: "text",
    class: "reset-input",
    inputmode: "numeric",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: 8,
    "aria-describedby": "reset-code-hint"
  });
  const canExport = !locked && typeof onExport === "function";
  const body = h(
    "div",
    { class: "reset-dialog" },
    h("p", {}, "This deletes all Denotation data in this browser: pages and rows in the browser cache, preferences, your PIN, the AI access copy and the links to storage locations."),
    h("p", { class: "hint" }, "Folders on disk are not touched. After the reset you can add a folder again under Storage to get its pages back. An encrypted folder opens again with its PIN or recovery key."),
    ...warnings.map((w) => h("p", { class: "reset-warn", role: "alert" }, ico("info"), h("span", {}, h("strong", {}, "Warning: "), w))),
    warnings.length && canExport ? h("p", { class: "hint" }, "Export first to keep a copy.") : null,
    warnings.length && locked ? h("p", { class: "hint" }, "Export isn't available while the app is locked.") : null,
    canExport ? h("button", { type: "button", class: "reset-export", onClick: () => onExport() }, ico("file-down"), " Export a JSON backup") : null,
    h("p", { id: "reset-code-hint", class: "reset-code-line" }, "To confirm, type this number: ", h("strong", { class: "reset-code" }, code)),
    h("label", {}, "Confirmation number", input)
  );
  let go = null;
  const sync = () => {
    input.value = input.value.replace(/[^0-9]/g, "").slice(0, 8);
    if (go) go.disabled = input.value !== code;
  };
  input.addEventListener("input", sync);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && go && !go.disabled) go.click();
  });
  const m = openModal({
    title: locked ? "Reset this browser" : "Reset local cache",
    content: body,
    actions: [
      { label: "Cancel" },
      { label: "Delete everything", class: "danger reset-go", run: async () => {
        if (input.value !== code) return false;
        go.disabled = true;
        await resetBrowser({ prepare });
        return false;
      } }
    ]
  });
  go = body.closest(".modal")?.querySelector(".reset-go") ?? null;
  if (locked) body.closest(".modal-overlay")?.classList.add("over-lock");
  sync();
  input.focus();
  return m;
}

// ---------- PIN dialogs ----------
const pinField = (label, cls, max) => {
  const input = h("input", {
    type: "password",
    class: `pin-field ${cls}`,
    inputmode: "numeric",
    pattern: "[0-9]*",
    autocomplete: "off",
    maxlength: max
  });
  input.addEventListener("input", () => {
    input.value = input.value.replace(/[^0-9]/g, "").slice(0, Number(input.maxLength) || 6);
  });
  return { input, el: h("label", {}, label, input) };
};

/** mode: "set" | "change" | "remove". Resolves true when the PIN changed. keyring: re-wraps the data key on a change. */
export function openPinDialog(mode, { onDone, keyring = null, store = null } = {}) {
  const record = loadRecord();
  let length = record?.length ?? 4;
  const needCurrent = mode !== "set";
  const cur = needCurrent ? pinField("Current PIN", "pin-current", record?.length ?? 6) : null;
  const next = mode !== "remove" ? pinField("New PIN", "pin-new", length) : null;
  const again = mode !== "remove" ? pinField("New PIN again", "pin-again", length) : null;
  const seg = h("div", { class: "seg pin-length", role: "group", "aria-label": "PIN length" });
  const drawSeg = () => seg.replaceChildren(...PIN_LENGTHS.map((n) => h("button", {
    type: "button",
    "aria-pressed": String(length === n),
    onClick: () => {
      length = n;
      for (const f of [next, again]) {
        f.input.maxLength = n;
        f.input.value = f.input.value.slice(0, n);
      }
      drawSeg();
    }
  }, length === n ? ico("check") : null, `${n} digits`)));
  if (next) drawSeg();
  let busy = false;
  const body = h(
    "div",
    { class: "pin-dialog" },
    mode === "remove" ? h("p", {}, "Enter your current PIN to remove it. The app will open without a PIN on this device.") : null,
    cur?.el,
    next ? h("p", { class: "set-label" }, "Length") : null,
    next ? seg : null,
    next?.el,
    again?.el,
    mode !== "remove" ? h("p", { class: "hint" }, `${HONEST} There's no way to recover a forgotten PIN: you'd have to reset this browser and lose what isn't saved elsewhere.`) : null
  );
  const titles = { set: "Set a PIN", change: "Change PIN", remove: "Remove PIN" };
  const labels = { set: "Set PIN", change: "Change PIN", remove: "Remove PIN" };
  return new Promise((resolve) => {
    let changed = false;
    openModal({
      title: titles[mode],
      content: body,
      actions: [
        { label: "Cancel" },
        { label: labels[mode], class: `${mode === "remove" ? "danger" : "primary"} pin-go`, run: async () => {
          if (busy) return false;
          busy = true;
          try {
            if (needCurrent) {
              if (!cur.input.value) throw new Error("Enter your current PIN.");
              const r = await tryPin(cur.input.value);
              if (!r.ok) {
                cur.input.value = "";
                throw new Error(failMessage(r));
              }
            }
            if (mode === "remove") {
              if (keyring?.inUse()) throw new Error("Encryption uses this PIN. Turn encryption off first (below), then remove the PIN.");
              removePin();
            } else {
              if (!validPin(next.input.value, length)) throw new Error(`The new PIN must be exactly ${length} digits.`);
              if (next.input.value !== again.input.value) throw new Error("The two new PINs don't match.");
              await changePinEverywhere(next.input.value, length, { keyring, store, current: cur?.input.value });
            }
            changed = true;
            toast(mode === "remove" ? "PIN removed" : mode === "set" ? "PIN set. The app now locks on this device." : "PIN changed");
          } finally {
            busy = false;
          }
        } }
      ],
      onClose: () => {
        if (changed) onDone?.();
        resolve(changed);
      }
    });
    body.addEventListener("keydown", (e) => {
      if (e.key === "Enter") body.closest(".modal")?.querySelector(".pin-go")?.click();
    });
    (cur ?? next).input.focus();
  });
}

/**
 * Set the new PIN and re-wrap the data key for it (this browser's key file first, then every reachable encrypted
 * location). If saving the PIN fails, the old key file is put back so the old PIN keeps opening everything.
 */
async function changePinEverywhere(pin, length, { keyring, store, current }) {
  const old = keyring?.file() ?? null;
  if (!old) return setPin(pin, length);
  const dek = keyring.key ?? (current ? await unwrapWithPin(old, current) : null);
  if (!dek) throw new Error("The encryption key isn't unlocked. Lock and unlock the app, then try again.");
  keyring.saveFile(await rewrapPin(old, dek, pin));
  try {
    await setPin(pin, length);
  } catch (e) {
    keyring.saveFile(old);
    throw e;
  }
  if (!keyring.key) keyring.setKey(dek);
  await store?.syncKeyFiles?.().catch(() => {});
}

// ---------- encryption dialogs ----------
const copyBtn = (text, label = "Copy") => {
  const b = h("button", { type: "button", class: "rk-copy" }, ico("copy"), ` ${label}`);
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      b.replaceChildren(ico("check"), " Copied");
    } catch {
      toast("Couldn't copy. Select the key and copy it by hand.", "error");
    }
  });
  return b;
};
const keyBox = (text) => h("p", { class: "rk-code", tabindex: "0", "aria-label": `Recovery key ${text.split("").join(" ")}` }, text);

/**
 * Show a recovery key once. Resolves { saved, keep }: saved = "I've saved it" was pressed (any other close cancels).
 * keep: the "Keep recovery key in the app" toggle (default off).
 */
export function openRecoveryDialog({ recovery, keep = false, intro } = {}) {
  let keepIt = keep;
  const toggle = h("input", { type: "checkbox", class: "rk-keep", checked: keep, onChange: (e) => void (keepIt = e.target.checked) });
  const body = h(
    "div",
    { class: "rk-dialog" },
    h("p", {}, intro ?? "This is your recovery key. It is shown only now. With it you can open your encrypted data if you forget your PIN. Write it down or keep it in a password manager."),
    keyBox(recovery),
    h("div", { class: "sec-actions" }, copyBtn(recovery)),
    h("label", { class: "check-row" }, toggle, h("span", {}, "Keep recovery key in the app")),
    h("p", { class: "hint" }, "When on, the key is stored encrypted with your data key and can be shown again in Settings while the app is unlocked. Off by default.")
  );
  return new Promise((resolve) => {
    let saved = false;
    openModal({
      title: "Save your recovery key",
      content: body,
      actions: [
        { label: "Cancel" },
        { label: "I've saved it", class: "primary rk-saved", run: () => void (saved = true) }
      ],
      onClose: () => resolve({ saved, keep: saved && keepIt })
    });
  });
}

/**
 * Ask for this device's PIN (verified, 3 s block after a wrong one). `extra`: nodes shown above the field.
 * Resolves the PIN, or null when cancelled.
 */
export function askPin({ title, intro, extra = [], confirmLabel = "Continue", danger = false } = {}) {
  const record = loadRecord();
  const f = pinField("PIN", "pin-confirm", record?.length ?? 6);
  const body = h("div", { class: "pin-dialog" }, intro ? h("p", {}, intro) : null, ...extra, f.el);
  return new Promise((resolve) => {
    let pin = null;
    openModal({
      title,
      content: body,
      actions: [
        { label: "Cancel" },
        { label: confirmLabel, class: `${danger ? "danger" : "primary"} pin-go`, run: async () => {
          if (!f.input.value) throw new Error("Enter your PIN.");
          const r = await tryPin(f.input.value);
          if (!r.ok) {
            f.input.value = "";
            throw new Error(failMessage(r));
          }
          pin = f.input.value;
        } }
      ],
      onClose: () => resolve(pin)
    });
    body.addEventListener("keydown", (e) => {
      if (e.key === "Enter") body.closest(".modal")?.querySelector(".pin-go")?.click();
    });
    f.input.focus();
  });
}

/**
 * Open an encrypted location's (or this browser's) key file with its PIN or recovery key, then keep the key on
 * this device wrapped by this device's PIN (asked for separately when the two differ). Wrong tries block for 3 s.
 * Resolves true when the key is now in the keyring.
 */
export function openUnlockKeyDialog({ keyFile, keyring, title = "Unlock encrypted storage", intro } = {}) {
  if (!hasPin()) {
    toast("Set a PIN first (Settings \u2192 Security). Encrypted storage needs a PIN on this device.", "error");
    return Promise.resolve(false);
  }
  const mine = keyring.file();
  if (mine && keyFile && mine.kid !== keyFile.kid) {
    toast("This location was encrypted with a different key than this browser uses. Turn encryption off on one of them first.", "error");
    return Promise.resolve(false);
  }
  const secret = h("input", { type: "password", class: "unlock-secret", autocomplete: "off", spellcheck: "false", maxlength: 64 });
  const device = pinField("This device's PIN", "unlock-device", loadRecord()?.length ?? 6);
  device.el.hidden = true;
  const msg = h("p", { class: "hint unlock-step", role: "status" });
  const body = h(
    "div",
    { class: "pin-dialog unlock-dialog" },
    h("p", {}, intro ?? "This storage is encrypted. Enter the PIN that was used for it, or its recovery key."),
    h("label", {}, "PIN or recovery key", secret),
    msg,
    device.el
  );
  let dek = null;
  return new Promise((resolve) => {
    let ok = false;
    openModal({
      title,
      content: body,
      actions: [
        { label: "Cancel" },
        { label: "Unlock", class: "primary unlock-go", run: async () => {
          if (!dek) {
            const left = pinThrottle.waitLeft();
            if (left > 0) throw new Error(failMessage({ throttled: true, waitMs: left }));
            const r = await unwrapWithSecret(keyFile, secret.value);
            if (!r) {
              secret.value = "";
              pinThrottle.fail();
              throw new Error("That PIN or recovery key doesn't open this storage. Try again in 3 s.");
            }
            pinThrottle.clear();
            dek = r.dek;
            if (r.via === "pin" && (await verifyPin(secret.value.trim(), loadRecord()))) {
              keyring.adopt(dek, keyFile); // same PIN as this device: the file opens with it as it is
              ok = true;
              return;
            }
            device.el.hidden = false;
            secret.disabled = true;
            msg.textContent = "Opened. Now enter this device's PIN to keep the key on this device.";
            device.input.focus();
            return false;
          }
          if (!device.input.value) throw new Error("Enter this device's PIN.");
          const t = await tryPin(device.input.value);
          if (!t.ok) {
            device.input.value = "";
            throw new Error(failMessage(t));
          }
          keyring.adopt(dek, await rewrapPin(keyFile, dek, device.input.value));
          ok = true;
        } }
      ],
      onClose: () => resolve(ok)
    });
    body.addEventListener("keydown", (e) => {
      if (e.key === "Enter") body.closest(".modal")?.querySelector(".unlock-go")?.click();
    });
    secret.focus();
  });
}

/** A modal that shows job progress; returns { update(text), done(text) }. */
function progressDialog(title) {
  const line = h("p", { class: "enc-progress", role: "status", "aria-live": "polite" }, "Starting\u2026");
  const result = h("div", { class: "enc-result" });
  openModal({ title, content: h("div", {}, line, result), actions: [{ label: "Close", class: "enc-close" }] });
  const close = line.closest(".modal")?.querySelector(".enc-close");
  if (close) close.disabled = true;
  return {
    update: (text) => void (line.textContent = text),
    done(text, lines = []) {
      line.textContent = text;
      result.replaceChildren(...lines.map((l) => h("p", { class: l.error ? "reset-warn" : "hint" }, l.error ? ico("info") : ico("check"), " ", l.text)));
      if (close) close.disabled = false;
    }
  };
}
const exportOffer = (onExport) => (typeof onExport === "function"
  ? [h("p", { class: "hint" }, "Export a backup first to be safe. Nothing is lost if the job is interrupted: it continues on the next unlock."), h("button", { type: "button", class: "reset-export enc-export", onClick: () => onExport() }, ico("file-down"), " Export a backup first")]
  : []);

/** Make sure a data key exists (creating one and showing its recovery key). -> true when ready. */
async function ensureKey(keyring, pin, { fresh = false } = {}) {
  const cur = keyring.file();
  if (cur && keyring.key && !fresh) return true;
  let file;
  let dek;
  let recovery;
  if (cur && keyring.key) {
    ({ file, recovery } = await replaceRecovery(cur, keyring.key, { keep: false }));
    dek = keyring.key;
  } else ({ file, dek, recovery } = await createKeyFile({ pin }));
  const r = await openRecoveryDialog({
    recovery,
    intro: cur ? "This is your new recovery key (it replaces the old one). It is shown only now. With it you can open your encrypted data if you forget your PIN." : undefined
  });
  if (!r.saved) return false;
  if (r.keep) file = await setSavedRecovery(file, dek, recovery);
  keyring.adopt(dek, file);
  return true;
}

// ---------- Settings section ----------
const IDLE_LABELS = { 0: "Never", 1: "After 1 minute", 5: "After 5 minutes", 15: "After 15 minutes", 60: "After 1 hour" };

// ---------- encryption jobs ----------
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function resultLines(results) {
  return results.map((r) => (r.error
    ? { error: true, text: `"${r.name}": stopped (${r.error}). It continues on the next unlock or sync.` }
    : { text: `"${r.name}": ${plural(r.changed, "file")} changed${r.failed?.length ? `, ${plural(r.failed.length, "file")} couldn't be read with this key and were left as they are` : ""}.` }));
}
/** Turn storage-location encryption on / off. ctx: { keyring, store, onExport } */
export async function setFileEncryption(on, ctx) {
  const { keyring, store } = ctx;
  if (!store?.setEncryption) throw new Error("Storage locations aren't available in this browser.");
  const locs = store.status().locations;
  const pin = await askPin({
    title: on ? "Encrypt storage locations" : "Turn off encryption",
    intro: on
      ? `Every page and row file in ${locs.length ? locs.map((l) => `"${l.name}"`).join(", ") : "your storage locations (none yet; new ones will be encrypted)"} will be encrypted with a key unlocked by your PIN. Folder and file names stay visible.`
      : "Every file in your storage locations will be decrypted back to plain JSON, then the key file is deleted.",
    extra: exportOffer(ctx.onExport),
    confirmLabel: on ? "Continue" : "Decrypt everything",
    danger: !on
  });
  if (!pin) return false;
  if (on && !(await ensureKey(keyring, pin, { fresh: true }))) return false;
  const ui = progressDialog(on ? "Encrypting storage" : "Decrypting storage");
  let results;
  try {
    results = await store.setEncryption(on, { onProgress: (j) => ui.update(`${on ? "Encrypting" : "Decrypting"} "${j.name}": ${j.done} of ${j.total} files\u2026`) });
  } catch (e) {
    ui.done(`Not started: ${e.message}`);
    return false;
  }
  const failed = results.some((r) => r.error || r.failed?.length);
  if (!on && !failed && keyring.settings().browser === "off") {
    keyring.removeFile();
    keyring.lock();
  }
  ui.done(failed ? "Finished with problems." : on ? "Your storage locations are encrypted." : "Your storage locations are plain again.", resultLines(results));
  return true;
}
/** Turn browser-copy encryption on / off (resumable migration). */
export async function setBrowserEncryption(on, ctx) {
  const { keyring } = ctx;
  const pin = await askPin({
    title: on ? "Encrypt the browser copy" : "Stop encrypting the browser copy",
    intro: on ? "Pages and rows kept in this browser will be encrypted. Preferences and settings stay plain." : "Pages and rows kept in this browser will be stored as plain JSON again.",
    extra: exportOffer(ctx.onExport)
  });
  if (!pin) return false;
  if (on && !(await ensureKey(keyring, pin))) return false;
  keyring.saveSettings({ browser: on ? "encrypting" : "decrypting" });
  return runBrowserJob(keyring, { ui: progressDialog(on ? "Encrypting the browser copy" : "Decrypting the browser copy") });
}
/** Run (or resume) the browser-copy migration the settings ask for. */
export async function runBrowserJob(keyring, { ui = null } = {}) {
  const state = keyring.settings().browser;
  if (state !== "encrypting" && state !== "decrypting") return true;
  const target = state === "encrypting" ? "encrypted" : "plain";
  try {
    const r = await migrateBrowserCopy({ keyring, target, onProgress: (p) => ui?.update(`${p.done} of ${p.total} records\u2026`) });
    keyring.saveSettings({ browser: target === "encrypted" ? "on" : "off" });
    if (target === "plain" && !keyring.settings().files) {
      keyring.removeFile();
      keyring.lock();
    }
    ui?.done(target === "encrypted" ? "The browser copy is encrypted." : "The browser copy is plain again.", r.failed.length ? [{ error: true, text: `${plural(r.failed.length, "record")} couldn't be read and were left as they are.` }] : []);
    return true;
  } catch (e) {
    ui?.done(`Stopped: ${e.message}. Nothing was lost; it continues on the next unlock.`);
    if (!ui) toast(`Browser copy encryption stopped: ${e.message}`, "error");
    return false;
  }
}

function encryptionPart(ctx, redraw) {
  const { keyring, store } = ctx;
  if (!keyring) return [];
  const s = keyring.settings();
  const file = keyring.file();
  const pin = hasPin();
  const locs = store?.status?.().locations ?? [];
  const canFiles = typeof store?.setEncryption === "function";
  const run = (job) => async () => {
    try {
      await job();
    } catch (e) {
      toast(e.message, "error");
    }
    redraw();
    ctx.onPinChange?.();
  };
  const state = s.files ? (locs.length ? `Storage locations are encrypted (${locs.filter((l) => l.encrypted).length} of ${locs.length})` : "On: new storage locations will be encrypted") : "Storage locations are not encrypted";
  const browserLabel = { off: "", on: "", encrypting: " (encrypting\u2026 continues on unlock)", decrypting: " (decrypting\u2026 continues on unlock)" }[s.browser];
  const browserBox = h("input", {
    type: "checkbox",
    class: "enc-browser",
    checked: s.browser === "on" || s.browser === "encrypting",
    disabled: !pin,
    onChange: (e) => {
      const want = e.target.checked;
      e.target.checked = !want; // reflects the real state until the job finishes
      run(() => setBrowserEncryption(want, ctx))();
    }
  });
  const keepBox = h("input", {
    type: "checkbox",
    class: "enc-keep",
    checked: !!file?.savedRecovery,
    disabled: !file || !keyring.key,
    onChange: (e) => {
      const want = e.target.checked;
      e.target.checked = !want;
      run(async () => {
        if (want) {
          const { file: next, recovery } = await replaceRecovery(keyring.file(), keyring.key, { keep: true });
          const r = await openRecoveryDialog({ recovery, keep: true, intro: "A new recovery key replaces the old one and is kept in the app. Save it somewhere too: it is your way back if you forget your PIN." });
          if (!r.saved) return;
          keyring.saveFile(r.keep ? next : await setSavedRecovery(next, keyring.key, null));
        } else keyring.saveFile(await setSavedRecovery(keyring.file(), keyring.key, null));
        await store?.syncKeyFiles?.();
      })();
    }
  });
  return [
    h("h5", { class: "sec-sub" }, "Encryption"),
    h("p", { class: "enc-state", role: "status" }, ico(s.files ? "lock-keyhole" : "lock-open"), h("span", {}, state)),
    h("p", { class: "hint enc-honest" }, ENC_HONEST),
    !pin ? h("p", { class: "hint" }, "Set a PIN first: encryption needs it.") : null,
    canFiles || s.files
      ? h("div", { class: "sec-actions" }, s.files
        ? h("button", { type: "button", class: "enc-files-off", disabled: !pin || !canFiles, onClick: run(() => setFileEncryption(false, ctx)) }, ico("lock-open"), " Turn off encryption\u2026")
        : h("button", { type: "button", class: "primary enc-files-on", disabled: !pin, onClick: run(() => setFileEncryption(true, ctx)) }, ico("lock-keyhole"), " Encrypt storage locations\u2026"))
      : h("p", { class: "hint" }, "Storage locations need Chrome or Edge on a computer."),
    h("label", { class: "check-row" }, browserBox, h("span", {}, `Also encrypt the browser copy${browserLabel}`)),
    file
      ? h("label", { class: "check-row" }, keepBox, h("span", {}, "Keep recovery key in the app"))
      : null,
    file?.savedRecovery && keyring.key
      ? h("div", { class: "sec-actions" }, h("button", { type: "button", class: "enc-show-rk", onClick: run(async () => {
        const text = await readSavedRecovery(keyring.file(), keyring.key);
        if (!text) throw new Error("The kept recovery key couldn't be read.");
        openModal({ title: "Recovery key", content: h("div", { class: "rk-dialog" }, keyBox(text), h("div", { class: "sec-actions" }, copyBtn(text))), actions: [{ label: "Close" }] });
      }) }, ico("key-round"), " Show recovery key"))
      : null
  ];
}

/**
 * The Security section for Settings. ctx: { onPinChange(), onIdleChange(), getStatus(), onExport(), prepareReset(),
 * keyring, store }. Returns a <section> that redraws itself.
 */
export function securitySection(ctx = {}) {
  const el = h("section", { class: "security" });
  function draw() {
    const record = loadRecord();
    const idle = loadIdle();
    const after = () => {
      draw();
      ctx.onPinChange?.();
    };
    el.replaceChildren(
      h("h4", {}, "Security"),
      h("p", { class: "pin-state", role: "status" },
        ico(record ? "lock-keyhole" : "lock-open"),
        h("span", {}, record ? `PIN lock is on (${record.length} digits)` : "PIN lock is off")),
      h("p", { class: "hint" }, `${HONEST} It applies to this browser on this device only.`),
      h(
        "div",
        { class: "sec-actions" },
        record
          ? [
            h("button", { type: "button", class: "pin-change", onClick: () => openPinDialog("change", { onDone: after, keyring: ctx.keyring, store: ctx.store }) }, "Change PIN…"),
            h("button", { type: "button", class: "pin-remove", onClick: () => openPinDialog("remove", { onDone: after, keyring: ctx.keyring, store: ctx.store }) }, "Remove PIN…")
          ]
          : h("button", { type: "button", class: "primary pin-set", onClick: () => openPinDialog("set", { onDone: after }) }, ico("lock-keyhole"), " Set a PIN…")
      ),
      record
        ? h(
          "div",
          { class: "set-row" },
          h("label", { for: "set-idle" }, "Lock when idle"),
          h("select", {
            id: "set-idle",
            onChange: (e) => {
              saveIdle(Number(e.target.value));
              ctx.onIdleChange?.();
            }
          }, IDLE_CHOICES.map((n) => h("option", { value: String(n), selected: n === idle }, IDLE_LABELS[n])))
        )
        : null,
      ...encryptionPart(ctx, draw),
      h("h5", { class: "sec-sub" }, "Reset"),
      h("p", { class: "hint" }, "Deletes all Denotation data in this browser, including the PIN. Folders on disk are not touched."),
      h("button", {
        type: "button",
        class: "danger reset-open",
        onClick: () => openResetDialog({ getStatus: ctx.getStatus, onExport: ctx.onExport, prepare: ctx.prepareReset })
      }, ico("rotate-ccw"), " Reset local cache…")
    );
  }
  draw();
  return el;
}
