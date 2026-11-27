// Settings → Security (PIN set / change / remove, auto-lock) and the "Reset this browser" dialog.
// There is no PIN recovery: a forgotten PIN means resetting this browser's Denotation data.
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { openModal } from "./modal.js";
import { toast } from "./dialogs.js";
import { createLocationRegistry } from "../adapters/locations.js";
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
  clearAppKeys
} from "../lock.js";

const DB_NAME = "denotation";
export const HONEST = "The PIN hides the app on this device. It doesn't encrypt your data.";

/** "0:32" / "4:05" for a wait in milliseconds. */
export function formatWait(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** Message for a failed tryPin() result. */
export function failMessage(r) {
  if (r.throttled) return `Too many wrong tries. Try again in ${formatWait(r.waitMs)}.`;
  return r.waitMs ? `Wrong PIN. Try again in ${formatWait(r.waitMs)}.` : "Wrong PIN.";
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
    h("p", { class: "hint" }, "Folders on disk are not touched. After the reset you can add a folder again under Storage to get its pages back."),
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

/** mode: "set" | "change" | "remove". Resolves true when the PIN changed. */
export function openPinDialog(mode, { onDone } = {}) {
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
              removePin();
            } else {
              if (!validPin(next.input.value, length)) throw new Error(`The new PIN must be exactly ${length} digits.`);
              if (next.input.value !== again.input.value) throw new Error("The two new PINs don't match.");
              await setPin(next.input.value, length);
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

// ---------- Settings section ----------
const IDLE_LABELS = { 0: "Never", 1: "After 1 minute", 5: "After 5 minutes", 15: "After 15 minutes", 60: "After 1 hour" };

/**
 * The Security section for Settings. ctx: { onPinChange(), onIdleChange(), getStatus(), onExport(), prepareReset() }.
 * Returns a <section> that redraws itself.
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
            h("button", { type: "button", class: "pin-change", onClick: () => openPinDialog("change", { onDone: after }) }, "Change PIN…"),
            h("button", { type: "button", class: "pin-remove", onClick: () => openPinDialog("remove", { onDone: after }) }, "Remove PIN…")
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
