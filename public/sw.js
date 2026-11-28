/* Raunaknama service worker: keeps the site installable (PWA) and lets the app shell open offline.
   It only touches (1) page navigations: network first, cached shell as the offline fallback, and
   (2) Vite's content-hashed build files under /assets/ (their name changes on every deploy, so a cached copy
   can never be stale). Songs, audio, Range requests, lyrics and every /api or Netlify-function request are
   never intercepted, so playback behaves exactly like a plain website (background play, lock screen card). */
const VERSION = "rn-pwa-v3";
const SHELL = ["/", "/favicon.svg", "/icon-192.png", "/icon-512.png", "/site.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("rn-pwa-") && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || req.headers.has("range")) return; // audio / video seeking: never touch
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.netlify/")) return;

  // Hashed build files: cache first (safe, the file name changes whenever the content does).
  if (req.mode !== "navigate") {
    if (!url.pathname.startsWith("/assets/")) return;
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      }))
    );
    return;
  }
  e.respondWith(
    fetch(req)
      .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put("/", copy)).catch(() => {}); return res; })
      .catch(() => caches.match("/").then((r) => r || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } })))
  );
});
