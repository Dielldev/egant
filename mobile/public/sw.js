// The phone app's service worker. One job: open even when the Mac can't be
// reached (asleep, offline, egant closed), so the app can say
// that instead of the browser's error page. It never touches the API — every
// session, message and answer always comes live from the Mac.

const CACHE = "egant-shell-v2";
const SHELL = ["/manifest.webmanifest", "/icon-192.png", "/apple-touch-icon.png"];

// Keeps the page itself and the build files it names — its script and
// styles, named after their content. A cached page without them is a blank
// one, and the first visit loads them before this worker is in charge, so
// they're fetched here rather than left to be picked up later. The page is
// stored only once its files are in, and earlier builds' files are dropped
// so they don't pile up on the phone.
async function keepShell(response) {
  const cache = await caches.open(CACHE);
  const html = await response.clone().text();
  const wanted = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
  for (const path of wanted) {
    if (!(await cache.match(path))) await cache.add(path);
  }
  await cache.put("/", response);
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/assets/") && !wanted.includes(path)) await cache.delete(request);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      const page = await fetch("/", { cache: "no-store" });
      if (!page.ok) throw new Error(`the app's page answered ${page.status}`);
      await keepShell(page);
      await self.skipWaiting();
    })(),
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
  // Tailscale answers with while egant is closed.
  if (request.mode === "navigate") {
    const network = fetch(request);
    event.respondWith(
      network
        .then((response) =>
          response.ok
            ? response.clone()
            : caches.match("/").then((cached) => cached ?? response),
        )
        .catch(() => caches.match("/").then((cached) => cached ?? Response.error())),
    );
    event.waitUntil(
      network.then((response) => (response.ok ? keepShell(response) : undefined)).catch(() => {}),
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
