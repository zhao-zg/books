/**
 * Service Worker for 书报 - 电子书阅读应用
 *
 * 缓存策略（v2，适配在线数据架构）：
 *  - 核心资源（HTML/JS/CSS/图标）安装时预缓存
 *  - 书籍 JSON 数据由 data-manager.js 通过 localforage 管理，SW 不介入
 *  - data CDN 索引文件（books-index.json / manifest.json / search-index.json）使用 stale-while-revalidate
 *  - 版本检测文件（version.json）始终走网络
 */

const CACHE_NAME = 'bk-main-__APP_VERSION__';

const CONFIG = {
  TIMEOUT: 5000,
  CACHEABLE_TYPES: ['basic', 'cors']
};

// 安装时预缓存的核心资源列表
const PRECACHE_URLS = [
  './',
  './index.html',
  // JS
  './js/app-update/au-utils.js',
  './js/app-update/au-core.js',
  './js/app-update/au-ui.js',
  './js/app-update/au-changelog.js',
  './js/app-update/au-init.js',
  './js/back-stack.js',
  './js/bible-dict.js',
  './js/bookmark.js',
  './js/data-manager/dm-shared.js',
  './js/data-manager/dm-storage.js',
  './js/data-manager/dm-index.js',
  './js/data-manager/dm-download.js',
  './js/data-manager/dm-book-ops.js',
  './js/data-manager/dm-api.js',
  './js/dev-console.js',
  './js/font-control.js',
  './js/highlight/highlight-shared.js',
  './js/highlight/highlight-core.js',
  './js/highlight/highlight-apply.js',
  './js/highlight/highlight-crud.js',
  './js/highlight/highlight-ui.js',
  './js/highlight/highlight-events.js',
  './js/import-manager/import-shared.js',
  './js/import-manager/import-file-picker.js',
  './js/import-manager/import-txt.js',
  './js/import-manager/import-epub.js',
  './js/import-manager/import-epub-style.js',
  './js/import-manager/import-html-converter.js',
  './js/import-manager/import-markdown.js',
  './js/import-manager/import-pdf.js',
  './js/import-manager/import-storage.js',
  './js/import-manager/import-orchestrator.js',
  './js/nav-stack/nav-back.js',
  './js/nav-stack/nav-float-bar.js',
  './js/ref-detector.js',
  './js/remote-config.js',
  './js/renderer/renderer-shared.js',
  './js/renderer/renderer-utils.js',
  './js/renderer/renderer-data.js',
  './js/renderer/renderer-progress.js',
  './js/renderer/renderer-content.js',
  './js/renderer/renderer-carousel.js',
  './js/renderer/renderer-city-helpers.js',
  './js/renderer/renderer-toc-drawer.js',
  './js/renderer/renderer-shelf.js',
  './js/renderer/renderer-city.js',
  './js/renderer/renderer-api.js',
  './js/shelf.js',
  './js/resource-pack/rp-shared.js',
  './js/resource-pack/rp-dialogs.js',
  './js/resource-pack/rp-import.js',
  './js/router.js',
  './js/scripture-popup/sp-shared.js',
  './js/scripture-popup/sp-dom.js',
  './js/scripture-popup/sp-render.js',
  './js/scripture-popup/sp-events.js',
  './js/scripture-popup/sp-annotate.js',
  './js/scripture-popup/sp-init.js',
  './js/search.js',
  './js/speech.js',
  './js/theme-toggle.js',
  // Vendor
  './vendor/localforage.min.js',
  './vendor/jszip.min.js',
  './vendor/marked.min.js',
  // CSS
  './css/style/css-variables.css',
  './css/style/css-base.css',
  './css/style/css-toc-drawer.css',
  './css/style/css-settings.css',
  './css/style/css-reader.css',
  './css/style/css-epub.css',
  './css/style/css-reader-views.css',
  './css/style/css-highlight.css',
  './css/style/css-popups.css',
  './css/style/css-navigation.css',
  './css/style/css-shelf.css',
  './css/style/css-drawers.css',
  './css/style/css-responsive.css',
  // 图标
  './icons/icon-120.png',
  './icons/icon-152.png',
  './icons/icon-16.png',
  './icons/icon-167.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-32.png',
  './icons/icon-512.png',
  './icons/icon.png'
];

// --------------------------------------------------------------------------
// 1. 生命周期
// --------------------------------------------------------------------------

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(PRECACHE_URLS);
      } catch (e) {
        // 预缓存失败不阻塞安装（部分资源可能暂时不可用）
      }
      try {
        self.skipWaiting();
      } catch (e) {
        // skipWaiting 失败不阻塞安装
      }
    })()
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      try {
        // 清理所有旧版缓存，仅保留当前 CACHE_NAME
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter(k => (k.startsWith('books-') || k.startsWith('bk-')) && k !== CACHE_NAME)
            .map(k => caches.delete(k))
        );
      } catch (e) {
        // 清理失败不阻塞激活
      }
      try {
        await self.clients.claim();
      } catch (e) {
        // clients.claim 失败不阻塞激活
      }
    })()
  );
});

// --------------------------------------------------------------------------
// 2. URL 规范化 (处理中文路径)
// --------------------------------------------------------------------------

function normalizeUrl(urlStr) {
  try {
    let url = new URL(urlStr);
    let decodedPath = decodeURIComponent(url.pathname);
    
    if (decodedPath.endsWith('/index.html')) {
      decodedPath = decodedPath.slice(0, -10);
    }
    
    // 目录补全斜杠
    if (!decodedPath.split('/').pop().includes('.') && !decodedPath.endsWith('/')) {
      decodedPath += '/';
    }

    return url.origin + decodedPath;
  } catch (e) {
    return urlStr;
  }
}

// --------------------------------------------------------------------------
// 3. 请求拦截
// --------------------------------------------------------------------------

// 始终走网络、不缓存的文件（版本检测用）
const NETWORK_ONLY = ['version.json'];

function isNetworkOnly(url) {
  try {
    const path = new URL(url).pathname;
    return NETWORK_ONLY.some(f => path.endsWith('/' + f) || path === '/' + f || path.endsWith(f));
  } catch (e) { return false; }
}

/**
 * 判断请求是否为数据 CDN 请求（路径包含 /zl-data/）
 */
function isDataCDN(url) {
  try {
    const u = new URL(url);
    return u.pathname.includes('/zl-data/');
  } catch (e) { return false; }
}

/**
 * stale-while-revalidate：先返回缓存，同时后台更新缓存
 * 缓存操作使用不含 query string 的 URL，避免 DataManager 的 ?t= 时间戳导致缓存不命中
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cacheUrl = request.url.replace(/\?.*$/, '');
  const cached = await cache.match(cacheUrl);

  const fetchPromise = fetch(request).then(response => {
    if (response && response.status === 200) {
      // 用不含 query 的 URL 写缓存，确保下次匹配命中
      cache.put(cacheUrl, response.clone()).catch(() => {});
    }
    return response;
  }).catch(() => cached); // 网络失败时降级到缓存

  // 如果有缓存，立即返回并后台更新；否则等待网络
  if (cached) {
    fetchPromise.catch(() => {}); // 忽略后台更新错误
    return cached;
  }
  return fetchPromise;
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  try {
    const request = event.request;
    const normalizedUrl = normalizeUrl(request.url);

    // ── data CDN 请求处理 ─────────────────────────────────────────────
    // 书籍数据由 data-manager.js 通过 localforage 管理，SW 仅在索引层面提供缓存加速
    if (isDataCDN(request.url)) {
      event.respondWith((async () => {
        try {
          const url = new URL(request.url);
          // books-index.json、manifest.json 和 search-index.json：stale-while-revalidate，确保索引尽量最新
          if (url.pathname.endsWith('books-index.json') || url.pathname.endsWith('manifest.json') || url.pathname.endsWith('search-index.json')) {
            return await staleWhileRevalidate(request, CACHE_NAME);
          }
          // 其他 CDN 请求（书籍 JSON 等）：不缓存，直接透传给 data-manager.js 处理
          return await fetch(request);
        } catch (e) {
          // 数据请求失败：让请求正常失败，由 data-manager.js 处理离线逻辑
          return new Response(
            JSON.stringify({ error: 'offline', message: '书籍数据不可用（离线状态）' }),
            { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
          );
        }
      })());
      return;
    }

    // ── 版本/目录文件：网络优先，离线时才降级缓存 ─────────────────────
    if (isNetworkOnly(request.url)) {
      event.respondWith((async () => {
        try {
          return await fetch(request, { cache: 'no-store' });
        } catch (e) {
          try {
            const cached = await caches.match(request) || await caches.match(normalizedUrl);
            if (cached) return cached;
          } catch (cacheErr) {
            // 缓存查询也失败，继续往下
          }
          // 网络失败 + 无缓存 → 返回离线页面
          if (request.mode === 'navigate') {
            return new Response(getOfflineHTML(), {
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
          }
          return new Response('Network error', { status: 503 });
        }
      })());
      return;
    }

    // 安装/更新时 cacheAllBooks 使用 cache:'no-cache' 发起请求，
    // 由页面侧显式调用 cache.put 管理，SW 不再介入，避免双重写缓存竞争。
    if (request.cache === 'no-cache') return;

    // ── 默认策略：缓存优先，未命中则网络取并写缓存 ──────────────────
    event.respondWith((async () => {
      try {
        // 1. 缓存优先 (尝试原始 URL 和规范化 URL)
        const cached = await caches.match(request) || await caches.match(normalizedUrl);
        if (cached) return cached;

        // 2. 缓存未命中 → 从网络取并写缓存
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT);
        try {
          const response = await fetch(request, { signal: controller.signal });
          clearTimeout(timeoutId);

          if (response && response.status === 200 && CONFIG.CACHEABLE_TYPES.includes(response.type)) {
            const responseClone = response.clone();
            try {
              const cache = await caches.open(CACHE_NAME);
              // 用 event.waitUntil 延长 SW 生命周期，确保大文件写完再休眠
              const writePromise = cache.put(request, responseClone)
                .then(() => {
                  if (request.url !== normalizedUrl) {
                    return cache.put(normalizedUrl, response.clone());
                  }
                })
                .catch(() => {/* 写缓存失败不影响正常响应 */});
              event.waitUntil(writePromise);
            } catch (cacheWriteErr) {
              // 缓存写入失败不影响返回
            }
          }
          return response;
        } catch (fetchErr) {
          clearTimeout(timeoutId);
          throw fetchErr;
        }
      } catch (err) {
        // 网络和缓存都失败 → 导航请求返回离线页面，确保核心页面始终可离线访问
        if (request.mode === 'navigate') {
          return new Response(getOfflineHTML(), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }
        return new Response('', { status: 503, statusText: 'Offline' });
      }
    })());
  } catch (err) {
    // 顶层兜底：处理 event.respondWith 调用前的同步异常
    try {
      event.respondWith(new Response('Service Worker Error', { status: 500 }));
    } catch (e) {
      // respondWith 已被调用或不可用，忽略
    }
  }
});

// --------------------------------------------------------------------------
// 4. 工具
// --------------------------------------------------------------------------

function getOfflineHTML() {
  return `<!DOCTYPE html><html lang="zh-CN"><body><div style="text-align:center;margin-top:50px;"><h1>📱 离线状态</h1><p>当前页面尚未缓存</p><button onclick="location.reload()">刷新重试</button></div></body></html>`;
}

self.addEventListener('message', event => {
  if (!event.data) return;

  if (event.data.type === 'SKIP_WAITING') self.skipWaiting();

  if (event.data.type === 'CLEAR_ALL_CACHES') {
    event.waitUntil(
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
    );
  }

  // 查询当前缓存状态（通过 MessageChannel port 回复）
  if (event.data.type === 'CACHE_INFO') {
    const port = event.ports && event.ports[0];
    if (!port) return;
    event.waitUntil(
      caches.keys().catch(() => []).then(allKeys => {
        const bookCacheCount = allKeys.filter(k => k.startsWith('books-') && k !== CACHE_NAME).length;
        port.postMessage({
          bookCacheCount: bookCacheCount,
          ok: allKeys.includes(CACHE_NAME)
        });
      }).catch(err => {
        port.postMessage({ ok: false });
      })
    );
  }

  // 仅清除 books-* / bk-* 离线缓存，保留用户 localStorage 数据
  if (event.data.type === 'CLEAR_CACHE') {
    const port = event.ports && event.ports[0];
    event.waitUntil(
      caches.keys()
        .then(keys => Promise.all(
          keys.filter(k => k.startsWith('books-') || k.startsWith('bk-')).map(k => caches.delete(k))
        ))
        .then(() => { if (port) port.postMessage({ ok: true }); })
        .catch(err => { if (port) port.postMessage({ ok: false, error: err.message }); })
    );
  }
});
