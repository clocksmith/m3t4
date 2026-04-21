self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .catch(() => undefined),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .catch(() => undefined),
      self.clients.claim(),
      self.registration.unregister(),
    ]),
  );
});

self.addEventListener("fetch", () => {
  // Let the page go directly to the network while this retired worker
  // unregisters. Do not call respondWith().
});
