// Lock screen (keypad + hidden digit dots) and the idle timer.
// While locked, <body class="is-locked"> hides everything but #lock (see css/lock.css) and the app clears its
// own rendering through onLocking(); onUnlocked() renders the current page again.
import { h } from "./dom.js";
import { ico } from "../icons/index.js";
import { hasPin, loadRecord, loadIdle, tryPin, waitLeft, runUnlockHooks } from "../lock.js";
import { failMessage, formatWait } from "./security.js";

const IDLE_CHECK_MS = 10000;
const calm = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * opts: { onLocking(): Promise (flush + clear), onUnlocked(), onForgot() }
 * -> { lock(): Promise<void> resolved at unlock, isLocked(), watchIdle() }
 */
export function createLockScreen({ onLocking, onUnlocked, onForgot } = {}) {
  let locked = false;
  let waiters = [];
  let root = null;
  let countdown = 0;

  // ---------- screen ----------
  function build() {
    const length = loadRecord()?.length ?? 4;
    let busy = false;
    const input = h("input", {
      id: "lock-input",
      class: "lock-input",
      type: "password",
      inputmode: "numeric",
      pattern: "[0-9]*",
      autocomplete: "off",
      maxlength: length,
      "aria-label": `PIN, ${length} digits`,
      "aria-describedby": "lock-msg"
    });
    const dots = h("div", { class: "lock-dots", "aria-hidden": "true" }, Array.from({ length }, () => h("span", { class: "lock-dot" })));
    const msg = h("p", { id: "lock-msg", class: "lock-msg", role: "status", "aria-live": "polite" });
    const keys = [];
    const key = (label, value, aria) => {
      const b = h("button", { type: "button", class: `lock-key${value === "back" ? " lock-back" : ""}`, "aria-label": aria ?? label, "data-key": value }, label);
      b.addEventListener("click", () => press(value));
      keys.push(b);
      return b;
    };
    const pad = h(
      "div",
      { class: "lock-pad", role: "group", "aria-label": "Keypad" },
      ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => key(d, d)),
      h("span", { class: "lock-gap" }),
      key("0", "0"),
      key(ico("delete"), "back", "Delete last digit")
    );
    const card = h(
      "div",
      { class: "lock-card" },
      h("div", { class: "lock-icon" }, ico("lock-keyhole")),
      h("h1", { id: "lock-title" }, "Denotion is locked"),
      h("p", { class: "hint lock-sub" }, `Enter your ${length}-digit PIN`),
      h("label", { class: "lock-entry", for: "lock-input" }, dots, input),
      msg,
      pad,
      h("button", { type: "button", class: "lock-forgot", onClick: () => onForgot?.() }, "Forgot PIN? Reset this browser")
    );
    const el = h("div", { id: "lock", role: "dialog", "aria-modal": "true", "aria-labelledby": "lock-title" }, card);

    const fine = window.matchMedia?.("(pointer: fine)").matches;
    const draw = () => {
      const n = input.value.length;
      [...dots.children].forEach((d, i) => d.classList.toggle("on", i < n));
      dots.dataset.count = String(n);
    };
    const setDisabled = (v) => {
      input.disabled = v;
      keys.forEach((k) => (k.disabled = v));
    };
    const startCountdown = () => {
      clearInterval(countdown);
      const tick = () => {
        const left = waitLeft();
        if (left <= 0) {
          clearInterval(countdown);
          countdown = 0;
          msg.textContent = "";
          setDisabled(false);
          if (fine) input.focus();
          return;
        }
        setDisabled(true);
        msg.textContent = `Too many wrong tries. Try again in ${formatWait(left)}.`;
      };
      tick();
      if (waitLeft() > 0) countdown = setInterval(tick, 1000);
    };
    const shake = () => {
      if (calm() || !card.animate) return;
      card.animate([{ transform: "translateX(0)" }, { transform: "translateX(-8px)" }, { transform: "translateX(8px)" }, { transform: "translateX(0)" }], { duration: 240, easing: "ease-out" });
    };
    async function submit() {
      if (busy || input.value.length !== length) return;
      busy = true;
      const pin = input.value;
      setDisabled(true);
      msg.textContent = "Checking…";
      let r;
      try {
        r = await tryPin(pin);
      } catch (e) {
        r = { ok: false, error: e };
      }
      busy = false;
      input.value = "";
      draw();
      if (r.ok) {
        msg.textContent = "";
        await unlock(pin);
        return;
      }
      shake();
      setDisabled(false);
      msg.textContent = r.error ? `Couldn't check the PIN: ${r.error.message ?? r.error}` : failMessage(r);
      if (r.waitMs > 0) startCountdown();
      else if (fine) input.focus();
    }
    function press(v) {
      if (busy || input.disabled) return;
      if (v === "back") input.value = input.value.slice(0, -1);
      else if (input.value.length < length) input.value += v;
      draw();
      if (v !== "back" && msg.textContent && !countdown) msg.textContent = "";
      submit();
    }
    input.addEventListener("input", () => {
      input.value = input.value.replace(/[^0-9]/g, "").slice(0, length);
      draw();
      submit();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    // Typing anywhere on the lock screen goes to the PIN (keyboard users who moved focus to a key).
    el.addEventListener("keydown", (e) => {
      if (e.target === input || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        press(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        press("back");
      }
    });
    draw();
    return { el, input, fine, startCountdown };
  }

  function closeOverlays() {
    // Menus and popovers close on a mousedown outside them; dialogs on a mousedown on their backdrop.
    try {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      for (const o of [...document.querySelectorAll(".modal-overlay")]) o.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      document.getElementById("toasts")?.replaceChildren();
    } catch {
      // the CSS hides whatever is left
    }
  }

  function show() {
    root?.el.remove();
    root = build();
    document.body.classList.add("is-locked");
    document.getElementById("app")?.setAttribute("inert", "");
    document.body.append(root.el);
    if (waitLeft() > 0) root.startCountdown();
    else if (root.fine) root.input.focus();
    else root.el.querySelector(".lock-key")?.focus({ preventScroll: true });
  }

  async function lock() {
    const done = new Promise((r) => waiters.push(r));
    if (locked) return done;
    if (!hasPin()) {
      flushWaiters();
      return done;
    }
    locked = true;
    document.activeElement?.blur?.(); // an editor commits its text before the flush
    closeOverlays();
    show();
    try {
      await onLocking?.();
    } catch {
      // still locked; content is hidden either way
    }
    return done;
  }
  function flushWaiters() {
    const w = waiters;
    waiters = [];
    w.forEach((r) => r());
  }
  async function unlock(pin) {
    try {
      await runUnlockHooks(pin);
    } catch (e) {
      console.error(e);
    }
    clearInterval(countdown);
    countdown = 0;
    locked = false;
    root?.el.remove();
    root = null;
    document.body.classList.remove("is-locked");
    document.getElementById("app")?.removeAttribute("inert");
    lastActive = Date.now();
    try {
      await onUnlocked?.();
    } finally {
      flushWaiters();
    }
  }

  // ---------- idle ----------
  let lastActive = Date.now();
  let idleTimer = 0;
  let watching = false;
  const bump = () => {
    lastActive = Date.now();
  };
  const check = () => {
    if (locked || !hasPin()) return;
    const min = loadIdle();
    if (min > 0 && Date.now() - lastActive >= min * 60000) lock();
  };
  function watchIdle() {
    if (watching) return;
    watching = true;
    for (const ev of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "input"]) document.addEventListener(ev, bump, { capture: true, passive: true });
    document.addEventListener("scroll", bump, { capture: true, passive: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) check();
    });
    idleTimer = setInterval(check, IDLE_CHECK_MS);
  }

  return {
    lock,
    isLocked: () => locked,
    watchIdle,
    /** Restart the idle clock (after the setting changes). */
    touch: bump,
    stop: () => clearInterval(idleTimer)
  };
}
