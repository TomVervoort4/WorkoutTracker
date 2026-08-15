const CACHE_VERSION = "v32";
const CACHE_NAME = `fittrack-${CACHE_VERSION}`;

const APP_SHELL = [
  "./index.html",
  "./styles.css",
  "./app.js",
  "./db.js",
  "./insights.js",
  "./bodycomp.js",
  "./reference.js",
  // Vendored SheetJS — precached so Fitdays imports work with no network
  "./vendor/xlsx.full.min.js",
  // Vendored exercise library — precached so exercise typing works offline
  "./vendor/exercise-library.json",
  // Open reference dataset + authored id-map — precached so exercise detail
  // and the browse library work with no network (browse images stay remote)
  "./data/exercise-reference.json",
  "./data/exercise-map.json",
  "./data/exercise-aliases.json",
  // Self-hosted Inter — precached so the UI renders in its real typeface
  // offline instead of falling back to the system sans
  "./Inter/Inter-VariableFont_opsz,wght.ttf",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

// Locally-vendored start/finish frames for the CURRENT plan exercises only
// (keyed by their free-exercise-db id via data/exercise-map.json). Precached so
// every plan exercise reference panel shows its images with NO network — the
// offline-first acceptance check. The 800-entry browse library does NOT vendor
// images; those lazy-load remotely and fall back to a placeholder offline.
const PLAN_EXERCISE_IMAGES = [
  "./data/exercise-images/Barbell_Bench_Press_-_Medium_Grip/0.jpg",
  "./data/exercise-images/Barbell_Bench_Press_-_Medium_Grip/1.jpg",
  "./data/exercise-images/Pullups/0.jpg",
  "./data/exercise-images/Pullups/1.jpg",
  "./data/exercise-images/Standing_Military_Press/0.jpg",
  "./data/exercise-images/Standing_Military_Press/1.jpg",
  "./data/exercise-images/Leverage_Iso_Row/0.jpg",
  "./data/exercise-images/Leverage_Iso_Row/1.jpg",
  "./data/exercise-images/Dumbbell_Bicep_Curl/0.jpg",
  "./data/exercise-images/Dumbbell_Bicep_Curl/1.jpg",
  "./data/exercise-images/Triceps_Pushdown/0.jpg",
  "./data/exercise-images/Triceps_Pushdown/1.jpg",
  "./data/exercise-images/Incline_Dumbbell_Press/0.jpg",
  "./data/exercise-images/Incline_Dumbbell_Press/1.jpg",
  "./data/exercise-images/Seated_Cable_Rows/0.jpg",
  "./data/exercise-images/Seated_Cable_Rows/1.jpg",
  "./data/exercise-images/Cable_Crossover/0.jpg",
  "./data/exercise-images/Cable_Crossover/1.jpg",
  "./data/exercise-images/Face_Pull/0.jpg",
  "./data/exercise-images/Face_Pull/1.jpg",
  "./data/exercise-images/Hammer_Curls/0.jpg",
  "./data/exercise-images/Hammer_Curls/1.jpg",
  "./data/exercise-images/Plank/0.jpg",
  "./data/exercise-images/Plank/1.jpg",
  "./data/exercise-images/Hanging_Leg_Raise/0.jpg",
  "./data/exercise-images/Hanging_Leg_Raise/1.jpg",
  "./data/exercise-images/Barbell_Squat/0.jpg",
  "./data/exercise-images/Barbell_Squat/1.jpg",
  "./data/exercise-images/Romanian_Deadlift/0.jpg",
  "./data/exercise-images/Romanian_Deadlift/1.jpg",
  "./data/exercise-images/Leg_Press/0.jpg",
  "./data/exercise-images/Leg_Press/1.jpg",
  "./data/exercise-images/Lying_Leg_Curls/0.jpg",
  "./data/exercise-images/Lying_Leg_Curls/1.jpg",
  "./data/exercise-images/Standing_Calf_Raises/0.jpg",
  "./data/exercise-images/Standing_Calf_Raises/1.jpg",
  "./data/exercise-images/External_Rotation_with_Band/0.jpg",
  "./data/exercise-images/External_Rotation_with_Band/1.jpg",
  "./data/exercise-images/Band_Pull_Apart/0.jpg",
  "./data/exercise-images/Band_Pull_Apart/1.jpg"
];

// Pre-cache all app shell assets on install (used as the offline fallback)
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll([...APP_SHELL, ...PLAN_EXERCISE_IMAGES]))
      .then(() => self.skipWaiting())
  );
});

// Single source of truth for the displayed app version: the page asks the
// active service worker for its CACHE_VERSION over a MessageChannel and shows
// whatever it replies. Keeping the constant here (not duplicated in the page)
// means the Data-tab readout can never drift from the actually-deployed cache.
self.addEventListener("message", (event) => {
  if (event.data?.type === "GET_VERSION") {
    event.ports[0]?.postMessage({ version: CACHE_VERSION });
  }
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
