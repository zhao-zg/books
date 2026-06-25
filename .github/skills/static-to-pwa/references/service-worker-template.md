# Service Worker Template

## Complete Service Worker for Offline-First PWA

```javascript
/**
 * Service Worker for PWA
 * Features: Cache versioning, URL normalization, network-first strategy
 */

const CACHE_VERSION = '__TIMESTAMP__';  // Replace with build timestamp
const CACHE_NAME = 'app-main-' + CACHE_VERSION;

const CONFIG = {
  TIMEOUT: 5000,
  CORE_RESOURCES: [
    './',
    './manifest.json',
    './icons/icon.svg'
    // Add your core resources here
  ],
  CACHEABLE_TYPES: ['basic', 'cors']
};

// --------------------------------------------------------------------------
// 1. Lifecycle Events
// --------------------------------------------------------------------------

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        CONFIG.CORE_RESOURCES.map(url =>
          fetch(new Request(url, { cache: 'reload' }))
            .then(res => res.ok ? cache.put(url, res) : null)
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith('app-main-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

// --------------------------------------------------------------------------
// 2. URL Normalization (handles Chinese/Unicode paths)
// --------------------------------------------------------------------------

function normalizeUrl(urlStr) {
  try {
    let url = new URL(urlStr);
    let decodedPath = decodeURIComponent(url.pathname);

    if (decodedPath.endsWith('/index.html')) {
      decodedPath = decodedPath.slice(0, -10);
    }

    // Auto-append trailing slash for directories
    if (!decodedPath.split('/').pop().includes('.') && !decodedPath.endsWith('/')) {
      decodedPath += '/';
    }

    return url.origin + decodedPath;
  } catch (e) {
    return urlStr;
  }
}

// --------------------------------------------------------------------------
// 3. Fetch Interception
// --------------------------------------------------------------------------

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const request = event.request;
  const normalizedUrl = normalizeUrl(request.url);

  event.respondWith((async () => {
    // Cache-first: try both original URL and normalized URL
    const cached = await caches.match(request) || await caches.match(normalizedUrl);
    if (cached) return cached;

    // Cache miss: fetch and cache
    return fetchAndCache(request, normalizedUrl);
  })());
});

async function fetchAndCache(request, normalizedUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT);

  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (response.ok && CONFIG.CACHEABLE_TYPES.includes(response.type)) {
      const responseClone = response.clone();
      caches.open(CACHE_NAME).then(cache => {
        cache.put(normalizedUrl, responseClone);
      });
    }

    return response;
  } catch (err) {
    clearTimeout(timeoutId);

    // Try cache one more time with normalized URL
    const cached = await caches.match(normalizedUrl);
    if (cached) return cached;

    return new Response('Offline - Content not cached', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// --------------------------------------------------------------------------
// 4. Cache Management API (message from page)
// --------------------------------------------------------------------------

self.addEventListener('message', event => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  if (!port || !data.type) return;

  if (data.type === 'CACHE_INFO') {
    getCacheInfo().then(info => port.postMessage(info));
    return;
  }

  if (data.type === 'CLEAR_CACHE') {
    clearManagedCaches().then(result => port.postMessage(result));
  }
});

async function getCacheInfo() {
  const keys = await caches.keys();
  const targets = keys.filter(k => k.startsWith('app-main-'));
  let entryCount = 0;

  for (const name of targets) {
    const cache = await caches.open(name);
    const reqs = await cache.keys();
    entryCount += reqs.length;
  }

  return {
    ok: true,
    cacheNames: targets,
    entryCount
  };
}

async function clearManagedCaches() {
  const keys = await caches.keys();
  const targets = keys.filter(k => k.startsWith('app-main-'));

  await Promise.all(targets.map(name => caches.delete(name)));

  // Re-create current cache and prefetch core resources.
  const cache = await caches.open(CACHE_NAME);
  await Promise.allSettled(
    CONFIG.CORE_RESOURCES.map(url =>
      fetch(new Request(url, { cache: 'reload' }))
        .then(res => res.ok ? cache.put(url, res) : null)
    )
  );

  return { ok: true, cleared: targets.length };
}
```

## Key Design Decisions

1. **Cache Versioning**: Use timestamp in cache name to force refresh on deployment
2. **URL Normalization**: Decode URIs to handle Chinese characters and Unicode paths
3. **Network-First with Cache Fallback**: Always try network, fall back to cache when offline
4. **Clone Before Cache**: Always `response.clone()` before putting into cache (Response body can only be read once)
5. **Timeout**: Abort fetch after 5s to quickly fall back to cache on slow networks
6. **Cache message API**: Provide `CACHE_INFO` and `CLEAR_CACHE` so UI can display cache status and clear data on demand

## Customization Points

- `CACHE_NAME` prefix: Change `'app-main-'` to your app's prefix
- `CORE_RESOURCES`: List critical resources to pre-cache on install
- `CONFIG.TIMEOUT`: Adjust network timeout (default 5000ms)
- Cache strategy: Modify `fetchAndCache` for cache-first vs network-first per resource type
- Message API: Keep `CACHE_INFO` / `CLEAR_CACHE` names aligned with page-side JavaScript
