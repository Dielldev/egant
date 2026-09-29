// The phone app's service worker. One job: open even when the Mac can't be
// reached (asleep, egant closed, phone off the tailnet), so the app can say
// that instead of the browser's error page. It never touches the API — every
// session, message and answer always comes live from the Mac.

const CACHE = "egant-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function remember(request, response) {
  if (response.ok) {
    const copy = response.clone();
    void caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // The page itself: the Mac's copy when it answers, so an update is picked
  // up at once; the cached one when it doesn't — including the 502 that
  // `tailscale serve` answers with while egant is closed.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) =>
          response.ok
            ? remember("/", response)
            : caches.match("/").then((cached) => cached ?? response),
        )
        .catch(() => caches.match("/").then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Build output is named after its content, so a cached copy is never stale.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches
        .match(request)
        .then((cached) => cached ?? fetch(request).then((response) => remember(request, response))),
    );
  }
});
