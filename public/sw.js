const CACHE_NAME = 'customer-pwa-v1';
const PRECACHE_URLS = [
  '/css/style.css',
  '/img/logo.png',
  '/img/pwa-icon.svg',
  '/img/hero.png',
  '/customer/login',
  '/customer/register',
  '/customer/tos',
  '/customer/privacy',
  '/customer/about',
  '/customer/contact'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))))
      ),
      self.clients.claim()
    ])
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  const cache = await caches.open(CACHE_NAME);
  if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(request, fallbackUrl) {
  try {
    const res = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    return new Response('Offline', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  if (req.mode === 'navigate' && path.startsWith('/customer/')) {
    event.respondWith(networkFirst(req, '/customer/login'));
    return;
  }

  if (path.startsWith('/css/') || path.startsWith('/img/') || path === '/manifest.webmanifest') {
    event.respondWith(cacheFirst(req));
    return;
  }

  event.respondWith(networkFirst(req));
});
