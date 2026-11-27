// PWA glue: service worker registration, the "update available" signal, install prompt state and persistent storage.
// Everything is relative to the page, so it works under /<repo>/. The state helpers are pure so Node can test them.

/** What the Settings install row should show: "installed" | "prompt" (browser can install now) | "ios" | "none". */
export function installMode({ standalone = false, iOS = false, hasPrompt = false } = {}) {
  if (standalone) return "installed";
  if (hasPrompt) return "prompt";
  return iOS ? "ios" : "none";
}
export const isStandalone = (win = globalThis) => {
  try {
    return !!(win.matchMedia?.("(display-mode: standalone)").matches || win.navigator?.standalone);
  } catch {
    return false;
  }
};
export const isIOS = (win = globalThis) => {
  const n = win.navigator ?? {};
  return /iphone|ipad|ipod/i.test(n.userAgent ?? "") || (n.platform === "MacIntel" && (n.maxTouchPoints ?? 0) > 1);
};

let deferred = null; // the browser's install prompt (Chromium), captured as early as possible
let installed = false;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    notify();
  });
}
export const currentInstallMode = () => installMode({ standalone: installed || isStandalone(), iOS: isIOS(), hasPrompt: !!deferred });
/** Re-draw callback for when the install state changes; returns an unsubscribe function. */
export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** Shows the browser's install dialog. Resolves "accepted" | "dismissed" | "unavailable". */
export async function promptInstall() {
  const ev = deferred;
  if (!ev) return "unavailable";
  deferred = null;
  notify();
  try {
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    return outcome;
  } catch {
    return "unavailable";
  }
}

const DEV_OFF_KEY = "denotion:sw"; // set to "off" in localStorage to skip the service worker (and drop an existing one) while developing
const devOff = () => {
  try {
    return localStorage.getItem(DEV_OFF_KEY) === "off";
  } catch {
    return false;
  }
};
/**
 * Registers sw.js (relative to the page). `onUpdate(apply)` is called when a new version is installed and waiting;
 * `apply()` activates it and reloads once the new worker has taken over. Returns the registration or null.
 */
export async function registerServiceWorker({ onUpdate, beforeApply } = {}) {
  if (!("serviceWorker" in navigator)) return null;
  if (devOff()) {
    (await navigator.serviceWorker.getRegistrations().catch(() => [])).forEach((r) => r.unregister());
    return null;
  }
  let reg;
  try {
    reg = await navigator.serviceWorker.register("sw.js");
  } catch (e) {
    console.warn("Service worker not registered:", e.message);
    return null;
  }
  if (!reg) return null; // some browsers (or blocked service workers) resolve without a registration
  const hadController = !!navigator.serviceWorker.controller; // first install is not an "update"
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
  const apply = async () => {
    try {
      await beforeApply?.();
    } catch (e) {
      console.error(e);
    }
    (reg.waiting ?? reg.installing)?.postMessage({ type: "SKIP_WAITING" });
  };
  const announce = () => {
    if (reg.waiting && navigator.serviceWorker.controller) onUpdate?.(apply);
  };
  announce();
  reg.addEventListener("updatefound", () => {
    const w = reg.installing;
    w?.addEventListener("statechange", () => w.state === "installed" && announce());
  });
  // Look for a new version when the app comes back to the foreground (long-lived installed apps).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reg.update().catch(() => {});
  });
  return reg;
}
/** Asks the browser not to evict this origin's data. Safe to call more than once; resolves true / false / null (unsupported). */
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}
