/**
 * Service Worker for 书报 - 电子书阅读应用
 * 纯路由版：不管理版本，缓存生命周期由安装对话框负责
 */

const CACHE_NAME = 'books-main';

const CONFIG = {
  TIMEOUT: 5000,
  CACHEABLE_TYPES: ['basic', 'cors']
};

// --------------------------------------------------------------------------
// 1. 生命周期
// --------------------------------------------------------------------------

self.addEventListener('install', event => {
  try {
    // 无需预缓存；缓存由安装对话框管理
    self.skipWaiting();
  } catch (e) {
    // skipWaiting 失败不阻塞安装
  }
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
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

// 始终走网络、不缓存的文件（版本检测、目录更新用）
const NETWORK_ONLY = ['version.json'];

function isNetworkOnly(url) {
  try {
    const path = new URL(url).pathname;
    return NETWORK_ONLY.some(f => path.endsWith('/' + f) || path === '/' + f || path.endsWith(f));
  } catch (e) { return false; }
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  try {
    const request = event.request;
    const normalizedUrl = normalizeUrl(request.url);

    // 版本/目录文件：网络优先，离线时才降级缓存
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
        // 网络和缓存都失败 → 导航请求返回离线页面
        if (request.mode === 'navigate') {
          return new Response(getOfflineHTML(), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }
        throw err;
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
        const bookCacheCount = allKeys.filter(k => k.startsWith('books-') && k !== 'books-main').length;
        port.postMessage({
          bookCacheCount: bookCacheCount,
          ok: allKeys.includes('books-main')
        });
      }).catch(err => {
        port.postMessage({ ok: false });
      })
    );
  }

  // 仅清除 books-* 离线缓存，保留用户 localStorage 数据
  if (event.data.type === 'CLEAR_CACHE') {
    const port = event.ports && event.ports[0];
    event.waitUntil(
      caches.keys()
        .then(keys => Promise.all(keys.filter(k => k.startsWith('books-')).map(k => caches.delete(k))))
        .then(() => { if (port) port.postMessage({ ok: true }); })
        .catch(err => { if (port) port.postMessage({ ok: false, error: err.message }); })
    );
  }
});