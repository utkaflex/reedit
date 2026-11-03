/// <reference lib="webworker" />
export {};
declare const BUILD: string;
declare const PRECACHE: readonly { url: string; sha256: string }[];
const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const prefix = 'reedit-shell-';
const cacheName = prefix + BUILD;
const allowed = new Set(
  PRECACHE.map((entry) => new URL(entry.url, worker.location.origin).href),
);
worker.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName);
      try {
        for (const entry of PRECACHE) {
          const response = await fetch(
            new Request(entry.url, {
              cache: 'reload',
              credentials: 'same-origin',
              redirect: 'error',
            }),
          );
          if (!response.ok || response.type === 'opaque')
            throw new Error('Shell resource unavailable');
          const hash = Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                'SHA-256',
                await response.clone().arrayBuffer(),
              ),
            ),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join('');
          if (hash !== entry.sha256)
            throw new Error('Mixed deployment rejected');
          await cache.put(entry.url, response);
        }
      } catch (error) {
        await caches.delete(cacheName);
        throw error;
      }
      // No skipWaiting: a new edition never interrupts an open book.
    })(),
  );
});
worker.addEventListener('activate', (event) => {
  event.waitUntil(worker.clients.claim());
});
worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== worker.location.origin ||
    url.pathname.startsWith('/api/')
  )
    return;
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () =>
        (await (await caches.open(cacheName)).match('/index.html')) ??
        new Response(
          'Офлайн-оболочка недоступна. Подключитесь к интернету и откройте Reedit ещё раз.',
          {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          },
        ))(),
    );
  } else if (allowed.has(url.href)) {
    event.respondWith(
      (async () =>
        (await (await caches.open(cacheName)).match(event.request)) ??
        fetch(event.request))(),
    );
  } else if (
    !url.search &&
    /^\/assets\/[\w.-]+\.(?:js|css)$/.test(url.pathname)
  ) {
    // Retained edition assets keep an old tab's late imports working during a deployment.
    event.respondWith(
      (async () => {
        for (const key of await caches.keys())
          if (key.startsWith(prefix)) {
            const cached = await (await caches.open(key)).match(event.request);
            if (cached) return cached;
          }
        return fetch(event.request);
      })(),
    );
  }
});
worker.addEventListener('message', (event) => {
  const data: unknown = event.data;
  if (!data || typeof data !== 'object' || !('type' in data)) return;
  const reply = (value: unknown) => event.ports[0]?.postMessage(value);
  if (data.type === 'STATUS') {
    reply({ build: BUILD });
    return;
  }
  event.waitUntil(
    (async () => {
      const clients = await worker.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      const source = event.source;
      if (
        clients.length !== 1 ||
        !source ||
        !('id' in source) ||
        clients[0]?.id !== source.id
      ) {
        reply({
          ok: false,
          reason: 'Закройте остальные вкладки и окна Reedit, затем повторите.',
        });
        return;
      }
      if (data.type === 'ACTIVATE_IF_IDLE') {
        if (new URL(clients[0].url).hash.startsWith('#/reading')) {
          reply({ ok: false, reason: 'Сначала закройте книгу.' });
          return;
        }
        reply({ ok: true });
        await worker.skipWaiting();
      } else if (
        data.type === 'CLEAN' &&
        'build' in data &&
        data.build === BUILD
      ) {
        for (const key of await caches.keys())
          if (key.startsWith(prefix) && key !== cacheName)
            await caches.delete(key);
        reply({ ok: true });
      }
    })(),
  );
});
