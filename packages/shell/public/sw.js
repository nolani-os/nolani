// ClaraOS Service Worker — KILLSWITCH (May 2026)
//
// Reason: cache-first behaviour for /assets/ caused stale-bundle issues after
// JS-Patch deploys. Until we have a battle-tested SW (e.g. Workbox precache-
// manifest with proper invalidation), no SW is safer than a half-baked one.
//
// On install/activate: delete ALL caches + unregister self + reload all open
// tabs so they fetch fresh assets directly from the network.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: "window" });
    for (const c of clients) { try { c.navigate(c.url); } catch (e) {} }
  })());
});

// No fetch handler — let the browser hit the network directly.
