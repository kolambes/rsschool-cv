const CACHE_NAME = "zipibus-pwa-v20260713-hero2c";

// On localhost the cache-first strategy hides code/CSS edits during development.
// The browser re-checks sw.js on navigation (updateViaCache:"none"), so a changed
// sw.js is picked up quickly; when it sees a local host it removes its own caches,
// stops intercepting fetches, and unregisters — making local reloads always fresh.
const IS_LOCAL = (() => {
  const host = self.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".local");
})();

const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json?v=20260709-varA",
  "/app.js?v=20260713-hero2c",
  "/theme-init.js?v=20260709-varA",
  "/fonts.css?v=20260709-selfhost",
  "/fonts/geist-400-latin.woff2",
  "/fonts/geist-400-cyrillic.woff2",
  "/fonts/geist-500-latin.woff2",
  "/fonts/geist-500-cyrillic.woff2",
  "/fonts/geist-600-latin.woff2",
  "/fonts/geist-600-cyrillic.woff2",
  "/fonts/geist-700-latin.woff2",
  "/fonts/geist-700-cyrillic.woff2",
  "/fonts/geist-mono-500-latin.woff2",
  "/fonts/geist-mono-500-cyrillic.woff2",
  "/fonts/geist-mono-600-latin.woff2",
  "/fonts/geist-mono-600-cyrillic.woff2",
  "/tokens.css?v=20260713-eyecomfort",
  "/styles.css?v=20260709-nodark",
  "/home-final.css?v=20260709-nodark",
  "/about-final.css?v=20260709-nodark",
  "/visual-polish.css?v=20260709-nodark",
  "/responsive-system.css?v=20260713-stoptimes",
  "/modern-ui.css?v=20260709-nodark",
  "/adaptive.css?v=20260708-responsive-safe2",
  "/redesign-theme.css?v=20260709-nodark",
  "/system.css?v=20260713-hero2c",
  "/icons/app-icon-192.png?v=20260622-shortcut",
  "/icons/app-icon-512.png?v=20260622-shortcut",
  // Герб пережат: 754KB PNG -> 13.7KB WebP (даунскейл до 192px под
  // contain-фон topbar/админки) — теперь лёгкий и прекэшируется.
  "/bus-park-logo-light-clean.webp?v=20260712-crest"
];

self.addEventListener("install", (event) => {
  if (IS_LOCAL) {
    self.skipWaiting();
    return;
  }
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  if (IS_LOCAL) {
    // Wipe every cache and remove self so localhost always serves disk-fresh files.
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .then(() => self.registration.unregister())
        .then(() => self.clients.claim())
        .catch(() => undefined)
    );
    return;
  }
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // Localhost: never intercept — let the network (dev server on disk) answer.
  if (IS_LOCAL) return;

  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/index.html")));
    return;
  }

  if (url.pathname.startsWith("/api/")) return;

  if (["script", "style", "image", "manifest"].includes(request.destination)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      })
    );
  }
});
