const CACHE_NAME = "efrei-app-static-v8";
const ASSETS = [
  "/",
  "/index.html",
  "/lib/css/styles.css",
  "/lib/fonts/Inter-Variable.woff2",
  "/lib/fonts/SpaceGrotesk-Variable.woff2",
  "/lib/fonts/Rubik80sFade-Regular.woff2",
  "/lib/js/app.js",
  "/lib/js/router.js",
  "/lib/js/state.js",
  "/lib/js/api.js",
  "/lib/js/realtime.js",
  "/lib/js/views/home.js",
  "/lib/js/views/login.js",
  "/lib/js/views/signup.js",
  "/lib/js/views/not-found.js",
  "/sw.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  const path = url.pathname || "";
  if (path.startsWith("/api/") || path.startsWith("/auth/") || path.startsWith("/ws/")) {
    return;
  }
  if (event.request.headers.get("authorization")) {
    return;
  }

  const isNavigation = event.request.mode === "navigate";

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return response;
        })
        .catch(() => (isNavigation ? caches.match("/index.html") : Promise.reject()));
    })
  );
});
