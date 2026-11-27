// Service worker: offline app shell. Classic script (module workers are not everywhere). All paths are relative,
// so it works under /<repo>/. The file list and cache version come from sw-files.js (tools/gen-sw-files.mjs).
importScripts("sw-files.js");
const PREFIX = "denotation-";
const CACHE = `${PREFIX}${self.APP_VERSION}`;
const START = new URL("index.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  // No skipWaiting here: the page shows "Update available" and asks (message below), so an update never swaps
  // the code under an open tab on its own.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: "reload" bypasses the HTTP cache so the precache is exactly what the server has now
    await cache.addAll(self.APP_FILES.map((f) => new Request(new URL(f, self.location).href, { cache: "reload" })));
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never cache (or touch) cross-origin requests
  event.respondWith(staleWhileRevalidate(req, req.mode === "navigate" ? START : req));
});
async function staleWhileRevalidate(req, key) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key, { ignoreSearch: key === START });
  const fresh = fetch(req.mode === "navigate" ? START : req, { cache: "no-cache" }).then(async (res) => {
    if (res.ok && res.type === "basic") await cache.put(key, res.clone());
    return res;
  });
  if (hit) {
    fresh.catch(() => {}); // offline: the cached copy is the answer
    return hit;
  }
  return fresh;
}
