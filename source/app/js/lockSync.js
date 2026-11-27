// Tells the other open tabs of this origin about PIN lock events, so locking in one tab locks them all.
// BroadcastChannel where the browser has it; otherwise a localStorage key whose `storage` event reaches the other
// tabs. A message carries only its kind (never a PIN or key). Unlocking stays per tab: each tab asks for the PIN.
//
// Kinds:
//   lock         Lock now or the idle lock in one tab: the others lock too.
//   pin-set      a PIN was set: the others lock (they now need it).
//   pin-changed  the PIN changed: the others lock, or redraw their lock screen for the new length.
//   pin-removed  the PIN was removed: a locked tab reloads (nothing to ask for), an open one redraws.
//   active       someone used the app in another tab (throttled), so a background tab's idle clock doesn't lock
//                everything while the user is busy elsewhere.
// Pure apart from the injected BroadcastChannel / storage / event target, so Node tests can drive it.

export const CHANNEL = "denotation-lock";
export const SIGNAL_KEY = "denotion:lock-signal";
export const KINDS = Object.freeze(["lock", "pin-set", "pin-changed", "pin-removed", "active"]);
/** Activity pings go out at most this often. */
export const ACTIVE_EVERY_MS = 15000;

/** A received message -> { kind, id } or null (anything malformed or unknown is ignored). */
export function parseSignal(raw) {
  let m = raw;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  if (!m || typeof m !== "object" || !KINDS.includes(m.kind)) return null;
  return { kind: m.kind, id: typeof m.id === "string" ? m.id.slice(0, 40) : "" };
}

/**
 * What this tab does about a signal, given its own state now.
 * -> "lock" | "redraw" (rebuild the lock screen) | "reload" | "refresh" (redraw the open app) | "active" | null
 * The PIN record is shared storage, so `hasPin` already reflects the other tab's change; a stale signal that
 * contradicts it does nothing.
 */
export function reaction(kind, { locked = false, hasPin = false } = {}) {
  switch (kind) {
    case "lock":
      return hasPin && !locked ? "lock" : null;
    case "pin-set":
    case "pin-changed":
      if (!hasPin) return null;
      return locked ? "redraw" : "lock";
    case "pin-removed":
      if (hasPin) return null;
      return locked ? "reload" : "refresh";
    case "active":
      return locked ? null : "active";
    default:
      return null;
  }
}

const newId = () => {
  try {
    const b = globalThis.crypto.getRandomValues(new Uint8Array(8));
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  } catch {
    return String(Math.random()).slice(2, 18);
  }
};

/**
 * opts: { Channel (BroadcastChannel ctor or null), storage (localStorage), target (window, for `storage` events),
 *         now() }
 * -> { send(kind), onSignal(fn(kind)) -> unsubscribe, transport: "broadcast" | "storage" | "none", close() }
 */
export function createLockSync({
  Channel = typeof globalThis.BroadcastChannel === "function" ? globalThis.BroadcastChannel : null,
  storage = globalThis.localStorage ?? null,
  target = typeof globalThis.addEventListener === "function" ? globalThis : null,
  now = () => Date.now()
} = {}) {
  const fns = new Set();
  const seen = [];
  let lastActive = -Infinity;
  const deliver = (raw) => {
    const s = parseSignal(raw);
    if (!s) return;
    if (s.id) {
      if (seen.includes(s.id)) return;
      seen.push(s.id);
      if (seen.length > 32) seen.shift();
    }
    for (const fn of [...fns]) {
      try {
        fn(s.kind);
      } catch (e) {
        console.error(e);
      }
    }
  };

  let channel = null;
  try {
    channel = Channel ? new Channel(CHANNEL) : null;
  } catch {
    channel = null;
  }
  let onStorage = null;
  if (channel) channel.onmessage = (e) => deliver(e?.data);
  else if (storage && target) {
    onStorage = (e) => {
      if (e?.key === SIGNAL_KEY && e.newValue) deliver(e.newValue);
    };
    target.addEventListener("storage", onStorage);
  }

  function send(kind) {
    if (!KINDS.includes(kind)) throw new Error(`Unknown lock signal: ${kind}`);
    if (kind === "active") {
      const t = now();
      if (t - lastActive < ACTIVE_EVERY_MS) return false;
      lastActive = t;
    }
    const msg = { kind, id: newId() };
    try {
      if (channel) channel.postMessage(msg);
      else if (storage) storage.setItem(SIGNAL_KEY, JSON.stringify(msg)); // a fresh id, so the value always changes
      else return false;
      return true;
    } catch {
      return false; // closed channel or blocked storage: the other tabs keep their own state
    }
  }

  return {
    send,
    onSignal(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    transport: channel ? "broadcast" : onStorage ? "storage" : "none",
    close() {
      fns.clear();
      try {
        channel?.close();
      } catch {
        // already closed
      }
      if (onStorage) target.removeEventListener("storage", onStorage);
    }
  };
}

let shared = null;
/** The app's one lock channel (created on first use). */
export function lockSync() {
  if (!shared) shared = createLockSync();
  return shared;
}
