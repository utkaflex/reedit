/// <reference lib="webworker" />
export {};
declare const BUILD: string;
declare const PRECACHE: readonly { url: string; sha256: string }[];
const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const prefix = 'reedit-shell-';
const cacheName = prefix + BUILD;
const shellPath = '/index.html';
const allowed = new Set(
  PRECACHE.map((entry) => new URL(entry.url, worker.location.origin).href),
);
type Entry = (typeof PRECACHE)[number];

async function verified(entry: Entry, response?: Response): Promise<Response> {
  const resource =
    response ??
    (await fetch(
      new Request(entry.url, {
        cache: 'reload',
        credentials: 'same-origin',
        redirect: 'error',
      }),
    ));
  if (!resource.ok || resource.type === 'opaque')
    throw new Error('Shell resource unavailable');
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        await resource.clone().arrayBuffer(),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== entry.sha256) throw new Error('Mixed deployment rejected');
  return resource;
}

async function cacheShell(document?: Response): Promise<void> {
  const index = PRECACHE.find((entry) => entry.url === shellPath);
  if (!index) throw new Error('Shell document missing');
  const html = await verified(index, document);
  const cache = await caches.open(cacheName);
  for (const entry of PRECACHE)
    if (entry !== index) await cache.put(entry.url, await verified(entry));
  // Enabling offline navigation is the last step, once every dependency is present.
  await cache.put(index.url, html);
}

async function cached(
  request: Request | string,
  name = cacheName,
): Promise<Response | undefined> {
  try {
    return await caches.match(request, { cacheName: name });
  } catch {
    return undefined;
  }
}

function activeBuild(active: ServiceWorker): Promise<string | undefined> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (build?: string) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(build);
    };
    const timer = setTimeout(finish, 1000);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const status = event.data;
      finish(
        status &&
          typeof status === 'object' &&
          'build' in status &&
          typeof status.build === 'string'
          ? status.build
          : undefined,
      );
    };
    try {
      active.postMessage({ type: 'STATUS' }, [channel.port2]);
    } catch {
      finish();
    }
  });
}

let recovery: Promise<void> | null = null;
worker.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        await cacheShell();
      } catch (error) {
        await caches.delete(cacheName);
        throw error;
      }
      // A client showing the old worker's error cannot apply an update from the UI.
      const active = worker.registration.active;
      const build = active && (await activeBuild(active));
      if (!build || (await cached(shellPath, prefix + build))) return;
      const clients = await worker.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      if (
        !clients.some((client) =>
          new URL(client.url).hash.startsWith('#/reading'),
        )
      )
        await worker.skipWaiting();
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
    const navigation = (async () => {
      const html = await cached(shellPath);
      if (html) return html;
      try {
        const online = await fetch(event.request);
        if (online.ok && !recovery) {
          recovery = cacheShell(online.clone())
            .catch(() => {
              // A newer deployment can be rendered from the network, but cannot be cached as this edition.
            })
            .finally(() => {
              recovery = null;
            });
        }
        return online;
      } catch {
        return new Response(
          'Офлайн-оболочка недоступна. Подключитесь к интернету и откройте Reedit ещё раз.',
          {
            status: 503,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-store',
            },
          },
        );
      }
    })();
    event.respondWith(navigation);
    event.waitUntil(navigation.then(() => recovery));
  } else if (allowed.has(url.href)) {
    event.respondWith(
      (async () => (await cached(event.request)) ?? fetch(event.request))(),
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
            const response = await cached(event.request, key);
            if (response) return response;
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
