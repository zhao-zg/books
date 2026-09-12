/**
 * Service Worker for 书报 - 电子书阅读应用
 * App 版本: 0.5.2
 *
 * 缓存策略（v4，数据桶版本化 + 静态桶固定名）：
 *  - CACHE_NAME 固定为 'bk-main'，不带版本号（SW 运行时缓存：cache.put 覆盖更新）
 *  - 数据缓存桶由页面 pwaCache 管理（bk-data-{version} 切换桶方案），SW 不参与其生命周期
 *  - SW activate 零清理：不删除任何缓存（含旧版数据桶），只做 clients.claim() 接管页面
 *  - SW 字节变化检测由注释中的 App 版本号驱动（升级时 sw.js 内容变化触发更新）
 *  - 核心资源（HTML/JS/CSS/图标）安装时预缓存到 bk-main
 *  - 书籍 JSON 数据由 data-manager.js 通过 localforage 管理，SW 不介入
 *  - data CDN 索引文件（books-index.json / manifest.json）使用 stale-while-revalidate
 *  - 版本检测文件（version.json）始终走网络
 */

const CACHE_NAME = 'bk-main';
const DATA_CACHE_PREFIX = 'bk-data-';

const CONFIG = {
  TIMEOUT: 5000,
  CACHEABLE_TYPES: ['basic', 'cors']
};

// 安装时预加载的核心资源列表（仅首屏必需）
// 数据桶（__bkCoreUrls 全量）由页面 pwaCache 安装/更新时全量缓存，SW 预缓存仅兜底
// 首屏启动必需资源（无 defer 的阻塞脚本 + 首屏 CSS + 启动 Vendor + 图标），
// 保证首次进入不白屏。defer 模块与 cmaps 之外的 vendor 依赖数据桶全量缓存。
// ⚠ 此列表须与 index.html 中 __bkCoreUrls 保持同步（子集关系），
// 构建时 generator.py 会校验一致性。
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  // JS（无 defer 的阻塞启动脚本：数据层 + 渲染链 + 导航）
  './js/back-stack.js',
  './js/data-manager/dm-shared.js',
  './js/data-manager/dm-storage.js',
  './js/data-manager/dm-index.js',
  './js/data-manager/dm-download.js',
  './js/data-manager/dm-book-ops.js',
  './js/data-manager/dm-api.js',
  './js/background-download.js',
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
  './js/ref-detector.js',
  './js/router.js',
  './js/remote-config.js',
  './js/webdav-presets.js',
  './js/theme-toggle.js',
  './js/speech.js',
  './js/nav-stack/nav-back.js',
  './js/nav-stack/nav-float-bar.js',
  './js/image-utils.js',
  './js/app-lifecycle.js',
  // Vendor（启动必须，无 defer）
  './vendor/localforage.min.js',
  // CSS（首屏布局必需）
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

// vendor/cmaps + vendor/standard_fonts 的文件列表由构建脚本（generator.py）
// 在构建时扫描目录生成，替换 __VENDOR_PRECACHE_URLS__ 占位符。
// 独立于 PRECACHE_URLS 预缓存：install 时单独 addAll，失败不阻塞核心安装。
// 确保首次离线打开中文 PDF 时 CJK 字体映射和标准字体可用。
const VENDOR_CMAP_FONT_URLS = ['./vendor/cmaps/78-EUC-H.bcmap',
  './vendor/cmaps/78-EUC-V.bcmap',
  './vendor/cmaps/78-H.bcmap',
  './vendor/cmaps/78-RKSJ-H.bcmap',
  './vendor/cmaps/78-RKSJ-V.bcmap',
  './vendor/cmaps/78-V.bcmap',
  './vendor/cmaps/78ms-RKSJ-H.bcmap',
  './vendor/cmaps/78ms-RKSJ-V.bcmap',
  './vendor/cmaps/83pv-RKSJ-H.bcmap',
  './vendor/cmaps/90ms-RKSJ-H.bcmap',
  './vendor/cmaps/90ms-RKSJ-V.bcmap',
  './vendor/cmaps/90msp-RKSJ-H.bcmap',
  './vendor/cmaps/90msp-RKSJ-V.bcmap',
  './vendor/cmaps/90pv-RKSJ-H.bcmap',
  './vendor/cmaps/90pv-RKSJ-V.bcmap',
  './vendor/cmaps/Add-H.bcmap',
  './vendor/cmaps/Add-RKSJ-H.bcmap',
  './vendor/cmaps/Add-RKSJ-V.bcmap',
  './vendor/cmaps/Add-V.bcmap',
  './vendor/cmaps/Adobe-CNS1-0.bcmap',
  './vendor/cmaps/Adobe-CNS1-1.bcmap',
  './vendor/cmaps/Adobe-CNS1-2.bcmap',
  './vendor/cmaps/Adobe-CNS1-3.bcmap',
  './vendor/cmaps/Adobe-CNS1-4.bcmap',
  './vendor/cmaps/Adobe-CNS1-5.bcmap',
  './vendor/cmaps/Adobe-CNS1-6.bcmap',
  './vendor/cmaps/Adobe-CNS1-UCS2.bcmap',
  './vendor/cmaps/Adobe-GB1-0.bcmap',
  './vendor/cmaps/Adobe-GB1-1.bcmap',
  './vendor/cmaps/Adobe-GB1-2.bcmap',
  './vendor/cmaps/Adobe-GB1-3.bcmap',
  './vendor/cmaps/Adobe-GB1-4.bcmap',
  './vendor/cmaps/Adobe-GB1-5.bcmap',
  './vendor/cmaps/Adobe-GB1-UCS2.bcmap',
  './vendor/cmaps/Adobe-Japan1-0.bcmap',
  './vendor/cmaps/Adobe-Japan1-1.bcmap',
  './vendor/cmaps/Adobe-Japan1-2.bcmap',
  './vendor/cmaps/Adobe-Japan1-3.bcmap',
  './vendor/cmaps/Adobe-Japan1-4.bcmap',
  './vendor/cmaps/Adobe-Japan1-5.bcmap',
  './vendor/cmaps/Adobe-Japan1-6.bcmap',
  './vendor/cmaps/Adobe-Japan1-UCS2.bcmap',
  './vendor/cmaps/Adobe-Korea1-0.bcmap',
  './vendor/cmaps/Adobe-Korea1-1.bcmap',
  './vendor/cmaps/Adobe-Korea1-2.bcmap',
  './vendor/cmaps/Adobe-Korea1-UCS2.bcmap',
  './vendor/cmaps/B5-H.bcmap',
  './vendor/cmaps/B5-V.bcmap',
  './vendor/cmaps/B5pc-H.bcmap',
  './vendor/cmaps/B5pc-V.bcmap',
  './vendor/cmaps/CNS-EUC-H.bcmap',
  './vendor/cmaps/CNS-EUC-V.bcmap',
  './vendor/cmaps/CNS1-H.bcmap',
  './vendor/cmaps/CNS1-V.bcmap',
  './vendor/cmaps/CNS2-H.bcmap',
  './vendor/cmaps/CNS2-V.bcmap',
  './vendor/cmaps/ETHK-B5-H.bcmap',
  './vendor/cmaps/ETHK-B5-V.bcmap',
  './vendor/cmaps/ETen-B5-H.bcmap',
  './vendor/cmaps/ETen-B5-V.bcmap',
  './vendor/cmaps/ETenms-B5-H.bcmap',
  './vendor/cmaps/ETenms-B5-V.bcmap',
  './vendor/cmaps/EUC-H.bcmap',
  './vendor/cmaps/EUC-V.bcmap',
  './vendor/cmaps/Ext-H.bcmap',
  './vendor/cmaps/Ext-RKSJ-H.bcmap',
  './vendor/cmaps/Ext-RKSJ-V.bcmap',
  './vendor/cmaps/Ext-V.bcmap',
  './vendor/cmaps/GB-EUC-H.bcmap',
  './vendor/cmaps/GB-EUC-V.bcmap',
  './vendor/cmaps/GB-H.bcmap',
  './vendor/cmaps/GB-V.bcmap',
  './vendor/cmaps/GBK-EUC-H.bcmap',
  './vendor/cmaps/GBK-EUC-V.bcmap',
  './vendor/cmaps/GBK2K-H.bcmap',
  './vendor/cmaps/GBK2K-V.bcmap',
  './vendor/cmaps/GBKp-EUC-H.bcmap',
  './vendor/cmaps/GBKp-EUC-V.bcmap',
  './vendor/cmaps/GBT-EUC-H.bcmap',
  './vendor/cmaps/GBT-EUC-V.bcmap',
  './vendor/cmaps/GBT-H.bcmap',
  './vendor/cmaps/GBT-V.bcmap',
  './vendor/cmaps/GBTpc-EUC-H.bcmap',
  './vendor/cmaps/GBTpc-EUC-V.bcmap',
  './vendor/cmaps/GBpc-EUC-H.bcmap',
  './vendor/cmaps/GBpc-EUC-V.bcmap',
  './vendor/cmaps/H.bcmap',
  './vendor/cmaps/HKdla-B5-H.bcmap',
  './vendor/cmaps/HKdla-B5-V.bcmap',
  './vendor/cmaps/HKdlb-B5-H.bcmap',
  './vendor/cmaps/HKdlb-B5-V.bcmap',
  './vendor/cmaps/HKgccs-B5-H.bcmap',
  './vendor/cmaps/HKgccs-B5-V.bcmap',
  './vendor/cmaps/HKm314-B5-H.bcmap',
  './vendor/cmaps/HKm314-B5-V.bcmap',
  './vendor/cmaps/HKm471-B5-H.bcmap',
  './vendor/cmaps/HKm471-B5-V.bcmap',
  './vendor/cmaps/HKscs-B5-H.bcmap',
  './vendor/cmaps/HKscs-B5-V.bcmap',
  './vendor/cmaps/Hankaku.bcmap',
  './vendor/cmaps/Hiragana.bcmap',
  './vendor/cmaps/KSC-EUC-H.bcmap',
  './vendor/cmaps/KSC-EUC-V.bcmap',
  './vendor/cmaps/KSC-H.bcmap',
  './vendor/cmaps/KSC-Johab-H.bcmap',
  './vendor/cmaps/KSC-Johab-V.bcmap',
  './vendor/cmaps/KSC-V.bcmap',
  './vendor/cmaps/KSCms-UHC-H.bcmap',
  './vendor/cmaps/KSCms-UHC-HW-H.bcmap',
  './vendor/cmaps/KSCms-UHC-HW-V.bcmap',
  './vendor/cmaps/KSCms-UHC-V.bcmap',
  './vendor/cmaps/KSCpc-EUC-H.bcmap',
  './vendor/cmaps/KSCpc-EUC-V.bcmap',
  './vendor/cmaps/Katakana.bcmap',
  './vendor/cmaps/LICENSE',
  './vendor/cmaps/NWP-H.bcmap',
  './vendor/cmaps/NWP-V.bcmap',
  './vendor/cmaps/RKSJ-H.bcmap',
  './vendor/cmaps/RKSJ-V.bcmap',
  './vendor/cmaps/Roman.bcmap',
  './vendor/cmaps/UniCNS-UCS2-H.bcmap',
  './vendor/cmaps/UniCNS-UCS2-V.bcmap',
  './vendor/cmaps/UniCNS-UTF16-H.bcmap',
  './vendor/cmaps/UniCNS-UTF16-V.bcmap',
  './vendor/cmaps/UniCNS-UTF32-H.bcmap',
  './vendor/cmaps/UniCNS-UTF32-V.bcmap',
  './vendor/cmaps/UniCNS-UTF8-H.bcmap',
  './vendor/cmaps/UniCNS-UTF8-V.bcmap',
  './vendor/cmaps/UniGB-UCS2-H.bcmap',
  './vendor/cmaps/UniGB-UCS2-V.bcmap',
  './vendor/cmaps/UniGB-UTF16-H.bcmap',
  './vendor/cmaps/UniGB-UTF16-V.bcmap',
  './vendor/cmaps/UniGB-UTF32-H.bcmap',
  './vendor/cmaps/UniGB-UTF32-V.bcmap',
  './vendor/cmaps/UniGB-UTF8-H.bcmap',
  './vendor/cmaps/UniGB-UTF8-V.bcmap',
  './vendor/cmaps/UniJIS-UCS2-H.bcmap',
  './vendor/cmaps/UniJIS-UCS2-HW-H.bcmap',
  './vendor/cmaps/UniJIS-UCS2-HW-V.bcmap',
  './vendor/cmaps/UniJIS-UCS2-V.bcmap',
  './vendor/cmaps/UniJIS-UTF16-H.bcmap',
  './vendor/cmaps/UniJIS-UTF16-V.bcmap',
  './vendor/cmaps/UniJIS-UTF32-H.bcmap',
  './vendor/cmaps/UniJIS-UTF32-V.bcmap',
  './vendor/cmaps/UniJIS-UTF8-H.bcmap',
  './vendor/cmaps/UniJIS-UTF8-V.bcmap',
  './vendor/cmaps/UniJIS2004-UTF16-H.bcmap',
  './vendor/cmaps/UniJIS2004-UTF16-V.bcmap',
  './vendor/cmaps/UniJIS2004-UTF32-H.bcmap',
  './vendor/cmaps/UniJIS2004-UTF32-V.bcmap',
  './vendor/cmaps/UniJIS2004-UTF8-H.bcmap',
  './vendor/cmaps/UniJIS2004-UTF8-V.bcmap',
  './vendor/cmaps/UniJISPro-UCS2-HW-V.bcmap',
  './vendor/cmaps/UniJISPro-UCS2-V.bcmap',
  './vendor/cmaps/UniJISPro-UTF8-V.bcmap',
  './vendor/cmaps/UniJISX0213-UTF32-H.bcmap',
  './vendor/cmaps/UniJISX0213-UTF32-V.bcmap',
  './vendor/cmaps/UniJISX02132004-UTF32-H.bcmap',
  './vendor/cmaps/UniJISX02132004-UTF32-V.bcmap',
  './vendor/cmaps/UniKS-UCS2-H.bcmap',
  './vendor/cmaps/UniKS-UCS2-V.bcmap',
  './vendor/cmaps/UniKS-UTF16-H.bcmap',
  './vendor/cmaps/UniKS-UTF16-V.bcmap',
  './vendor/cmaps/UniKS-UTF32-H.bcmap',
  './vendor/cmaps/UniKS-UTF32-V.bcmap',
  './vendor/cmaps/UniKS-UTF8-H.bcmap',
  './vendor/cmaps/UniKS-UTF8-V.bcmap',
  './vendor/cmaps/V.bcmap',
  './vendor/cmaps/WP-Symbol.bcmap',
  './vendor/standard_fonts/FoxitDingbats.pfb',
  './vendor/standard_fonts/FoxitFixed.pfb',
  './vendor/standard_fonts/FoxitFixedBold.pfb',
  './vendor/standard_fonts/FoxitFixedBoldItalic.pfb',
  './vendor/standard_fonts/FoxitFixedItalic.pfb',
  './vendor/standard_fonts/FoxitSerif.pfb',
  './vendor/standard_fonts/FoxitSerifBold.pfb',
  './vendor/standard_fonts/FoxitSerifBoldItalic.pfb',
  './vendor/standard_fonts/FoxitSerifItalic.pfb',
  './vendor/standard_fonts/FoxitSymbol.pfb',
  './vendor/standard_fonts/LICENSE_FOXIT',
  './vendor/standard_fonts/LICENSE_LIBERATION',
  './vendor/standard_fonts/LiberationSans-Bold.ttf',
  './vendor/standard_fonts/LiberationSans-BoldItalic.ttf',
  './vendor/standard_fonts/LiberationSans-Italic.ttf',
  './vendor/standard_fonts/LiberationSans-Regular.ttf'];

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
      // 独立预缓存 vendor cMaps/fonts（PDF CJK 字体支持）。
      // 失败不阻塞安装——首次在线打开 PDF 时默认策略会运行时缓存。
      if (VENDOR_CMAP_FONT_URLS.length > 0) {
        try {
          const vendorCache = await caches.open(CACHE_NAME);
          await vendorCache.addAll(VENDOR_CMAP_FONT_URLS);
        } catch (e) {
          // vendor 预缓存失败不阻塞安装
        }
      }
      // 快速激活：install 完成后立即 skipWaiting，让新版 SW 尽快接管页面
      // 缓存版本管理由页面 pwaCache 切换桶方案控制，SW 不参与
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', event => {
  // SW 只管缓存读写，不负责版本管理。
  // 旧缓存清理由应用层 cacheAllBooks 的"先建后删"流程控制，
  // SW activate 不删任何缓存，避免升级中途退出导致离线失效。
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

    // ── 跨域请求直接透传，不拦截 ──────────────────────────────────
    // WebDAV 等外部服务的请求不应被 SW 缓存策略干扰，
    // 避免：超时/缓存旧数据/CORS 错误被吞掉/取消下载不生效等问题。
    const requestUrl = new URL(request.url);
    if (requestUrl.origin !== self.location.origin) return;

    const normalizedUrl = normalizeUrl(request.url);

    // ── 安装/更新时 cacheAllBooks 使用 cache:'no-cache' 发起请求，───
    // 由页面侧显式调用 cache.put 管理，SW 不再介入，避免双重写缓存竞争。
    // 必须最先检查：否则 zl-data 索引请求会被 isDataCDN 分支拦截走
    // staleWhileRevalidate，导致页面侧把旧缓存写进新数据桶。
    if (request.cache === 'no-cache') return;

    // ── data CDN 请求处理 ─────────────────────────────────────────────
    // 书籍数据由 data-manager.js 通过 localforage 管理，SW 仅在索引层面提供缓存加速
    if (isDataCDN(request.url)) {
      event.respondWith((async () => {
        try {
          const url = new URL(request.url);
          // books-index.json、manifest.json：stale-while-revalidate，确保索引尽量最新
          if (url.pathname.endsWith('books-index.json') || url.pathname.endsWith('manifest.json')) {
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
            // navigation 请求失败：先尝试根路径 + 原始/规范化 URL 缓存兜底
            const cached = await caches.match('./') || await caches.match(request) || await caches.match(normalizedUrl);
            if (cached) return cached;
          } catch (cacheErr) {
            // 缓存查询也失败，继续往下
          }
          // 缓存也没有 → navigation 返回离线页面，其他请求 503
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
        // 缓存和网络都失败 → navigation 先尝试根路径缓存兜底（cache key 可能是 './'）
        if (request.mode === 'navigate') {
          try {
            const fallback = await caches.match('./');
            if (fallback) return fallback;
          } catch (e) {}
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
        port.postMessage({
          ok: allKeys.includes(CACHE_NAME),
          dataOk: allKeys.some(k => k.indexOf(DATA_CACHE_PREFIX) === 0)
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
