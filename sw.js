// أسهَر service worker — app shell precache + capped runtime tile cache
const SHELL = "ashar-shell-v5";
const TILES = "ashar-tiles-v5";
const DATA = "ashar-data-v5";
const TILE_CAP = 400;

const SHELL_FILES = [
  "./",
  "index.html",
  "css/app.css",
  "js/app.js",
  "js/geo.js",
  "js/audio.js",
  "js/sync.js",
  "js/config.js",
  "vendor/leaflet/leaflet.js",
  "vendor/leaflet/leaflet.css",
  "vendor/fonts/rajdhani-700.woff2",
  "vendor/fonts/plexar-400.woff2",
  "vendor/fonts/plexar-700.woff2",
  "manifest.webmanifest",
  "icons/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => ![SHELL, TILES, DATA].includes(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  if (keys.length > TILE_CAP) {
    await Promise.all(keys.slice(0, keys.length - TILE_CAP).map((k) => c.delete(k)));
  }
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // map tiles: cache-first so the route you've driven stays visible offline
  if (/basemaps\.cartocdn\.com|tile\.openstreetmap\.org/.test(url.host)) {
    e.respondWith(
      caches.open(TILES).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        try {
          const res = await fetch(e.request);
          if (res.ok) { c.put(e.request, res.clone()); trimTiles(); }
          return res;
        } catch {
          return new Response("", { status: 408 });
        }
      })
    );
    return;
  }

  // camera DB + sync config: network-first so refreshes / new keys land, cache as fallback
  if (url.pathname.endsWith("data/cameras.json") || url.pathname.endsWith("js/config.js")) {
    e.respondWith(
      caches.open(DATA).then(async (c) => {
        try {
          const res = await fetch(e.request);
          if (res.ok) c.put(e.request, res.clone());
          return res;
        } catch {
          return (await c.match(e.request)) || new Response('{"meta":{},"cams":[]}', { headers: { "Content-Type": "application/json" } });
        }
      })
    );
    return;
  }

  // shell: cache-first
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
  }
});
