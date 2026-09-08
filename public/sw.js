// Minimal service worker: exists to make the app installable and serves a
// cached shell so it opens offline. Network-first for everything (the app's
// data comes from /api and must stay fresh); cache is only the fallback.
// ponytail: no precache list — the shell is cached lazily on first online load.
const CACHE = "cipher-v1";

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // never cache API POSTs
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && new URL(req.url).origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./")))
  );
});
