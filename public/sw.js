// Sailz service worker — shell caching ONLY. Never touches /api/* (every
// dashboard number, call, order, lead must always be live, never served
// from cache) or any cross-origin request (Google Fonts, the PixiJS CDN
// script) — those pass straight through untouched. This exists purely to
// satisfy PWA installability criteria and give the app shell a usable
// offline fallback, not to speed up or cache real data.
const CACHE = "sailz-shell-v1";
const SHELL = ["/", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // same-origin shell requests only — /api/* and any cross-origin request
  // (fonts.googleapis.com, cdnjs) are never intercepted, so they always
  // hit the real network exactly like a page with no service worker at all.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // network-first: a deployed change is visible immediately while online;
  // the cached shell is only ever used as an offline fallback, never as a
  // way to serve a stale UI to someone who's actually connected.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
