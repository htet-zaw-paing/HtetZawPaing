const CACHE_VERSION = 'hzp-v3';
const PRECACHE = `${CACHE_VERSION}-precache`;
const RUNTIME = `${CACHE_VERSION}-runtime`;
const OFFLINE_PAGE = '/index.html';

const PRECACHE_URLS = [
  '/index.html',
  '/tailwind.css',
  '/manifest.json',
  '/me-black.png'
];

const isCacheableResponse = response => {
  if (!response || !response.ok || response.type === 'opaque') return false;
  if (response.headers.has('cf-mitigated')) return false;
  return true;
};

const putSafely = async (cacheName, request, response) => {
  if (!isCacheableResponse(response)) return;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  } catch (error) {
    console.warn('Service Worker cache write skipped:', error);
  }
};

const fetchWithTimeout = async (request, timeout = 8000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);

    await Promise.allSettled(PRECACHE_URLS.map(async url => {
      try {
        const request = new Request(url, { cache: 'reload' });
        const response = await fetch(request);
        if (isCacheableResponse(response)) await cache.put(request, response);
      } catch (error) {
        console.warn(`Service Worker precache skipped: ${url}`, error);
      }
    }));

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([PRECACHE, RUNTIME]);
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('hzp-') && !keep.has(key)).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === '/sw.js') return;

  const isNavigation = request.mode === 'navigate' || request.destination === 'document';
  const isAsset = ['style', 'script', 'image', 'font', 'manifest'].includes(request.destination);

  if (isNavigation) {
    event.respondWith((async () => {
      try {
        const response = await fetchWithTimeout(request);
        await putSafely(RUNTIME, request, response);
        return response;
      } catch (error) {
        const cached = await caches.match(request) || await caches.match(OFFLINE_PAGE);
        return cached || new Response(
          '<!doctype html><meta charset="utf-8"><title>Offline</title><body style="font-family:system-ui;padding:2rem">You are offline. Please reconnect and try again.</body>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  if (isAsset) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      const refresh = fetchWithTimeout(request).then(response => {
        putSafely(RUNTIME, request, response);
        return response;
      }).catch(() => null);

      if (cached) {
        event.waitUntil(refresh);
        return cached;
      }

      const response = await refresh;
      return response || new Response('', { status: 504, statusText: 'Offline' });
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const response = await fetchWithTimeout(request);
      await putSafely(RUNTIME, request, response);
      return response;
    } catch (error) {
      return (await caches.match(request)) || new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});
