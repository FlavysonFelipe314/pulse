const CACHE = "pulse-shell-v25";
const MEDIA_CACHE_PREFIX = "pulse-media-v3-user-";
const SHELL = [
  "/",
  "/static/css/app.css",
  "/static/js/app.js",
  "/static/manifest.webmanifest",
  "/static/images/app-icon.svg",
  "/static/images/app-icon-192.png",
  "/static/images/app-icon-512.png",
  "/static/images/favicon.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE && !key.startsWith(MEDIA_CACHE_PREFIX)).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

async function serveDeviceMedia(request, url) {
  const accountId = url.searchParams.get("account");
  if (!accountId || !/^\d+$/.test(accountId)) return fetch(request);
  const cache = await caches.open(`${MEDIA_CACHE_PREFIX}${accountId}`);
  const cached = await cache.match(url.href);
  if (!cached) return fetch(request);
  const range = request.headers.get("range");
  if (!range) return cached;
  const blob = await cached.blob();
  const match = range.match(/bytes=(\d+)-(\d*)/);
  if (!match) return cached;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : blob.size - 1;
  const end = Math.min(requestedEnd, blob.size - 1);
  if (start >= blob.size || start > end) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}` } });
  }
  return new Response(blob.slice(start, end + 1, blob.type || "audio/mpeg"), {
    status: 206,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${blob.size}`,
      "Content-Length": String(end - start + 1),
      "Content-Type": blob.type || "audio/mpeg"
    }
  });
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/media/music/")) {
    event.respondWith(serveDeviceMedia(request, url));
    return;
  }
  if (url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => {
      const copy = response.clone(); caches.open(CACHE).then(cache => cache.put("/", copy)); return response;
    }).catch(() => caches.match("/")));
    return;
  }
  if (url.origin === self.location.origin && url.pathname.startsWith("/static/")) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(request, copy)); return response;
    })));
  }
});
