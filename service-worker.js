const CACHE_VERSION = "v2";
const CACHE_NAME = `fittrack-${CACHE_VERSION}`;

const APP_SHELL = [
  "./index.html",
  "./styles.css",
  "./app.js",
  "./db.js",
  "./manifest.webmanifest"
];

// Pre-cache all app shell assets on install (used as the offline fallback)
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Remove stale caches from previous versions on activate
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Network-first strategy: always fetch the latest version when online, and
// refresh the cache with whatever comes back. The cache is only used as an
// offline fallback. This guarantees code changes reach users on their very
// next load instead of being silently masked forever by a stale cache
// (which is what a cache-first strategy would do without a manual
// CACHE_VERSION bump on every release).
self.addEventListener("fetch", (event) => {
  // Only handle GET requests and same-origin / app-shell URLs
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Only cache valid, same-origin responses
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          networkResponse.type !== "opaque"
        ) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }

        return networkResponse;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;

          // If both network and cache miss on a navigation, fall back to the shell
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
        })
      )
  );
});
