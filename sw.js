importScripts("./app-version.js");

const CACHE_PREFIX = "timebox-app-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${globalThis.TIMEBOX_APP_VERSION}`;
const APP_SHELL = Object.freeze([
  "./",
  "./index.html",
  "./styles.css",
  "./app-version.js",
  "./js/app.js",
  "./js/core.js",
  "./js/db.js",
  "./js/pwa.js",
  "./manifest.webmanifest",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
]);
const APP_SHELL_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.registration.scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

function offlineResponse() {
  return new Response("オフライン中のため、このファイルを取得できません。", {
    status: 503,
    statusText: "Offline",
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const requestUrl = new URL(request.url);
  if (request.method !== "GET" || requestUrl.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      caches.open(CACHE_NAME)
        .then((cache) => cache.match("./index.html"))
        .then((cachedIndex) => cachedIndex || fetch(request))
        .catch(() => offlineResponse())
    );
    return;
  }

  if (APP_SHELL_URLS.has(requestUrl.href)) {
    event.respondWith(
      caches.match(request, { ignoreSearch: true })
        .then((cachedResponse) => cachedResponse || fetch(request))
        .catch(() => offlineResponse())
    );
    return;
  }

  event.respondWith(fetch(request).catch(() => offlineResponse()));
});
