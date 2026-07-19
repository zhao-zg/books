/*!
 * data-manager.js — 书籍数据在线下载、本地存储和管理
 *
 * 暴露：window.DataManager
 *   .loadIndex()              加载/更新全局索引
 *   .getCachedIndex()         获取已缓存索引（同步）
 *   .checkIndexUpdate()       检查索引是否需要更新
 *   .loadContentIndexes()      加载所有已有内容索引（懒加载）
 *   .getContentIndexMap()       获取内容索引映射（同步）
 *   .buildContentIndex(data)    为书籍生成全文内容索引（供下载/导入用）
 *   .removeContentIndex(id)     移除书籍内容索引
 *   .downloadBook(id,series)  下载单本书
 *   .downloadSeries(id)       批量下载某系列
 *   .downloadAll()            下载全部书籍
 *   .getBook(id,series)       获取书籍数据（优先本地）
 *   .isBookDownloaded(id)     检查是否已下载
 *   .getDownloadedBookIds()   获取已下载 ID 列表
 *   .deleteBook(id)           删除本地缓存
 *   .getStorageStats()        存储统计
 *   .checkResources()         检查资源下载统计（已缓存/总本数）
 *   .clearAllBooks()           清除所有已下载书籍数据
 *   .getBooksBySeriesStatus()  按系列分组返回缓存统计
 *   .pauseDownload()          暂停批量下载
 *   .resumeDownload()         恢复批量下载
 *   .cancelDownload()         取消批量下载
 *   .getDownloadStatus()      获取下载状态
 *   .setBaseUrl(urlOrArray)  设置数据基础 URL（支持数组，多地址容灾）
 */
'use strict';
  var win = window;

  // ── 配置 ──────────────────────────────────────────────────────────────
  var DATA_BASE_URLS = [];   // 多个基础 URL，容灾兜底
  var DATA_BASE_URL = '';    // 当前生效的 URL
  var _currentUrlIndex = 0;

  // ── localforage 实例 ─────────────────────────────────────────────────
  var store = (typeof localforage !== 'undefined')
    ? localforage.createInstance({ name: 'books', storeName: 'zl-data' })
    : null;

  // 存储 key 常量
  var KEY_INDEX     = 'zl_index';
  var KEY_MANIFEST  = 'zl_manifest';
  var KEY_DOWNLOADED = 'zl_downloaded_ids';
  var KEY_BOOK_PREFIX = 'zl_book:';
  var KEY_CONTENT_INDEX_IDS = 'zl_ci_ids';
  var KEY_CONTENT_INDEX_PREFIX = 'zl_ci:';

  // ── 内存缓存 ──────────────────────────────────────────────────────────
  var _cachedIndex = null;
  var _cachedManifest = null;
  var _contentIndexMap = null; // { bookId: { id, title, series, chapters: [{ n, t, c }] } } | null（未初始化）
  var _downloadedIdCache = null; // Set<string> | null（null = 未初始化）
  var _bookBytesCache = null;   // number | null（null = 未计算/已失效）—— 书籍数据占用缓存，避免每次 getStorageStats 都 O(N) 遍历

  // ── 下载队列状态 ─────────────────────────────────────────────────────
  var _isDownloading = false;
  var _isPaused = false;
  var _isCancelled = false;
  var _dlCompleted = 0;
  var _dlTotal = 0;
  var _dlCurrentTitle = '';
  // 暂停/恢复机制：暂停时挂起 Promise，恢复时 resolve
  var _pauseResolve = null;
  // 并发控制（顺序下载更稳定，减少网络波动导致的失败）
  var MAX_CONCURRENT = 1;
  var MAX_RETRIES = 3;

  // ── 工具函数 ──────────────────────────────────────────────────────────

  /**
   * 构建完整 URL
   */
  function buildUrl(path) {
    var base = DATA_BASE_URL || '';
    if (!base) return path;
    return base.replace(/\/+$/, '') + '/' + path;
  }

  /**
   * 带重试 + 多地址容灾的 fetch
   * 当前地址重试耗尽后自动切换到下一个地址
   * @param {string} url
   * @param {number} [retries] 当前地址剩余重试次数
   * @returns {Promise<Response>}
   */
  function fetchWithRetry(url, retries) {
    if (typeof retries === 'undefined') retries = MAX_RETRIES;
    return fetch(url, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        // 检测 CDN 返回 HTML 兜底页面（如 Cloudflare Pages 404 回退到 index.html）而非 JSON
        var ct = r.headers.get('content-type') || '';
        if (ct.indexOf('text/html') !== -1) {
          // 文件在此 CDN 上不存在，无需重试，直接标记为 HTML 错误
          var htmlErr = new Error('HTML_RESPONSE');
          htmlErr._isHtmlResponse = true;
          throw htmlErr;
        }
        return r;
      })
      .catch(function (err) {
        // HTML 响应说明文件在该 CDN 不存在，跳过重试直接切换备用地址
        if (!err._isHtmlResponse && retries > 0) {
          // 当前地址还有重试次数，指数退避后重试
          var delay = Math.pow(2, MAX_RETRIES - retries) * 1000;
          console.warn('[DataManager] 请求失败，' + delay + 'ms 后重试: ' + url);
          return new Promise(function (resolve) {
            setTimeout(resolve, delay);
          }).then(function () {
            return fetchWithRetry(url, retries - 1);
          });
        }
        // 当前地址重试耗尽（或 HTML 响应），尝试切换到下一个地址
        if (DATA_BASE_URLS.length > 1 && _currentUrlIndex < DATA_BASE_URLS.length - 1) {
          _currentUrlIndex++;
          DATA_BASE_URL = DATA_BASE_URLS[_currentUrlIndex];
          console.warn('[DataManager] 切换到备用地址: ' + DATA_BASE_URL +
            (err._isHtmlResponse ? '（前一个地址返回了 HTML）' : ''));
          // 用新地址重新构建 URL 并重试（保留完整相对路径，含子目录）
          var oldBase = DATA_BASE_URLS[_currentUrlIndex - 1].replace(/\/+$/, '');
          var relativePath;
          if (url.indexOf(oldBase + '/') === 0) {
            relativePath = url.substring(oldBase.length + 1);
          } else {
            relativePath = url.substring(url.lastIndexOf('/') + 1);
          }
          var newUrl = DATA_BASE_URL.replace(/\/+$/, '') + '/' + relativePath;
          return fetchWithRetry(newUrl, MAX_RETRIES);
        }
        throw err._isHtmlResponse
          ? new Error('该书籍数据文件在所有服务器上均不存在')
          : err;
      });
  }

  /**
   * 纯文本 → 结构化 content 数组
   * 保留所有经文引用原文，不做清洗
   */
  function textToContents(text) {
    if (!text || typeof text !== 'string') return [];
    return text.split('\n')
      .filter(function (line) { return line.trim(); })
      .map(function (line) { return { type: 'paragraph', text: line.trim() }; });
  }

  /**
   * 将原始 JSON 数据转换为渲染器期望的格式
   * content 字段从纯文本字符串转为结构化数组
   */
  function convertBookData(rawBook) {
    var chapters = (rawBook.chapters || []).map(function (ch) {
      var content = ch.content;
      // 如果 content 是字符串，转为结构化数组
      if (typeof content === 'string') {
        content = textToContents(content);
      } else if (!Array.isArray(content)) {
        content = [];
      }
      return {
        number: ch.number,
        title: ch.title || '',
        content: content,
        footnotes: ch.footnotes || []
      };
    });

    // 构建转换后的书籍对象（保留所有原始字段）
    var result = {};
    var keys = Object.keys(rawBook);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k !== 'chapters') {
        result[k] = rawBook[k];
      }
    }
    result.chapters = chapters;
    return result;
  }

  /**
   * 从全局索引中查找书籍所属系列
   * 先查内存缓存（O(n) 遍历），未命中则加载索引后查找
   * @param {string} bookId
   * @returns {Promise<string>} series ID，未找到则 resolve 空字符串
   */
  function findSeriesByBookId(bookId) {
    // 先尝试从内存缓存同步查找
    if (_cachedIndex && _cachedIndex.books) {
      for (var i = 0; i < _cachedIndex.books.length; i++) {
        if (_cachedIndex.books[i].id === bookId) {
          return Promise.resolve(_cachedIndex.books[i].series);
        }
      }
    }
    // 缓存中未找到，尝试加载索引后查找
    return loadIndex().then(function (idx) {
      if (idx && idx.books) {
        for (var i = 0; i < idx.books.length; i++) {
          if (idx.books[i].id === bookId) {
            return idx.books[i].series;
          }
        }
      }
      return '';
    }).catch(function () { return ''; });
  }

  /**
   * 格式化文件大小（支持 B / KB / MB / GB）
   * 对 NaN/Infinity/负数等非法输入归一化为 0，保证健壮性
   */
  function formatSize(bytes) {
    if (!isFinite(bytes) || bytes < 0) bytes = 0;
    if (!bytes) return '0 B';
    if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return Math.round(bytes) + ' B';
  }

  /**
   * 失效书籍占用缓存——在任何写入/删除 zl-data 中书籍数据的操作后调用
   * 包括：cacheBook / deleteBook / downloadBook / clearAllBooks
   */
  function _invalidateBookSizeCache() {
    _bookBytesCache = null;
  }

