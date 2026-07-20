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

  // 错误码常量
  // ★ M5修复：将散落多处的 'CANCELLED' 字面量收敛为常量，便于以后修改/统一引用。
  //   各调用点（dm-download.js / search.js / renderer-city-helpers.js）均通过此常量
  //   或各模块本地同名常量比较，避免字符串拼写不一致导致的隐性 bug。
  var ERR_CANCELLED = 'CANCELLED';

  // ── 内存缓存 ──────────────────────────────────────────────────────────
  var _cachedIndex = null;
  var _cachedManifest = null;
  var _contentIndexMap = null; // { bookId: { id, title, series, chapters: [{ n, t, c }] } } | null（未初始化）
  var _downloadedIdCache = null; // Set<string> | null（null = 未初始化）
  var _bookBytesCache = null;   // number | null（null = 未计算/已失效）—— 书籍数据占用缓存，避免每次 getStorageStats 都 O(N) 遍历

  // ── 下载队列状态 ─────────────────────────────────────────────────────
  // 批次令牌机制：每次启动批量下载递增此 token，runConcurrent 闭包捕获本次 token，
  // 消费任务前校验，防止「取消后立即开始新批量」时旧 worker 复活消费旧 tasks 数组
  var _dlRunToken = 0;
  var _isDownloading = false;
  var _isPaused = false;
  var _isCancelled = false;
  var _dlCompleted = 0;
  var _dlTotal = 0;
  var _dlCurrentTitle = '';
  // 暂停/恢复机制：暂停时挂起 Promise，恢复时 resolve
  var _pauseResolve = null;
  // 当前活跃批次的 token（与 _pauseResolve/_isPaused 配合；pauseDownload/resumeDownload/cancelDownload
  // 需验证调用方对应的批次仍是当前活跃批次，避免跨批次误操作）
  var _dlActiveToken = 0;
  // 单本下载取消令牌：cancelDownload 推进此 token，各 downloadBook 闭包捕获本次 token，
  // 在 fetch 前/响应后/写入前等关键节点校验，被取消时抛 CANCELLED 错误。
  // 与 _dlRunToken 独立：批量下载的取消走 _dlRunToken，单本下载的取消走 _singleDlToken，
  // 同一次 cancelDownload 会同时推进两者，使两种下载都被取消。
  var _singleDlToken = 0;
  // 并发控制（顺序下载更稳定，减少网络波动导致的失败）
  var MAX_CONCURRENT = 1;
  var MAX_RETRIES = 3;

  // ── 实时进度状态（字节级）─────────────────────────────────────────────
  // 当前本书的字节进度（onProgress 推送时刷新，getDownloadStatus 读取）
  // 当 _dlBytesTotal=0 时表示该响应无 Content-Length，只能显示"已接收"
  var _dlBytesReceived = 0;
  var _dlBytesTotal = 0;
  // 当前本书字节级百分比（0-100，_dlBytesTotal>0 时为整数百分比；=0 时为 -1 表示未知）
  var _dlCurrentBookPercent = 0;
  // 批次累计接收字节（用于估算整体速度/剩余时间，跨多本累加）
  var _dlBatchBytesReceived = 0;
  // 批次开始时间戳（ms），用于速度估算
  var _dlBatchStartTs = 0;
  // 上次进度更新时间戳（ms），用于瞬时速度估算
  var _dlLastProgressTs = 0;
  var _dlLastProgressBytes = 0;
  // 瞬时速度（B/s），getDownloadStatus 读取，由 downloadBook 在流式读取时计算
  var _dlSpeedBps = 0;
  // 整个批次的总进度百分比（0-100，已含当前本字节加权），getDownloadStatus 读取
  var _dlTotalPercent = 0;
  // 当前阶段文案（'下载中' / '解析数据' / '写入本地' / '完成'）
  var _dlStage = '';

  /**
   * 重置实时进度状态（downloadSeries/downloadAll/downloadBook 启动前调用）
   * 注意：不重置 _dlBatchBytesReceived，由批次级函数自行管理
   */
  function _resetBookProgressState() {
    _dlBytesReceived = 0;
    _dlBytesTotal = 0;
    _dlCurrentBookPercent = 0;
    _dlSpeedBps = 0;
    _dlStage = '';
  }

  /**
   * 重置批次进度状态（downloadSeries/downloadAll 启动前调用）
   */
  function _resetBatchProgressState() {
    _dlBatchBytesReceived = 0;
    _dlBatchStartTs = Date.now();
    _dlLastProgressTs = _dlBatchStartTs;
    _dlLastProgressBytes = 0;
    _dlTotalPercent = 0;
    _resetBookProgressState();
  }

  /**
   * 更新瞬时速度：根据时间差和字节差计算 B/s
   * @param {number} received 当前累计接收字节
   * @returns {number} B/s
   *
   * ★ 鲁棒性：
   *   - dt < 50ms 视为极端抖动，跳过（避免单次 read 抖动）
   *   - 50-200ms 区间也计算（真实 CDN 下载时 onByteProgress 间隔常在该区间）
   *   - db <= 0 时仅"心跳"刷新 _dlLastProgressTs（避免长时间挂起）
   *   - 平滑系数 0.5：让新数据有适当权重，又不至于被瞬时毛刺带偏
   */
  function _calcSpeedBps(received) {
    var now = Date.now();
    var dt = now - _dlLastProgressTs;
    if (dt < 50) return _dlSpeedBps;
    var db = received - _dlLastProgressBytes;
    if (db <= 0) {
      // 字节未增加但时间过去：软刷新时间戳（"心跳"），避免下次 dt 仍停留在很久之前导致 db 过大
      _dlLastProgressTs = now;
      return _dlSpeedBps;
    }
    var instant = db * 1000 / dt;
    _dlSpeedBps = _dlSpeedBps > 0 ? (_dlSpeedBps * 0.5 + instant * 0.5) : instant;
    _dlLastProgressTs = now;
    _dlLastProgressBytes = received;
    return _dlSpeedBps;
  }

  /**
   * 计算批次总进度百分比（completed + 当前本字节进度）/ total * 100
   * @param {number} completed 已完成本数
   * @param {number} total 总本数
   * @returns {number} 0-100
   */
  function _calcTotalPercent(completed, total) {
    if (total <= 0) return 0;
    var bookProg = _dlBytesTotal > 0 ? _dlBytesReceived / _dlBytesTotal : 0;
    if (bookProg > 1) bookProg = 1;
    var pct = ((completed + bookProg) / total) * 100;
    if (pct > 99.5) pct = 99.5;  // 留 0.5% 给完成阶段
    if (pct < 0) pct = 0;
    return pct;
  }

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
   * @param {Object} [options] 可选参数
   *   @param {function} [options.shouldAbort] 每次重试前调用，返回 true 则放弃重试并抛 CANCELLED 错误。
   *     ★ M1修复：让调用方能在 setTimeout 重试间隔内提前取消，避免用户取消下载后仍继续发起重试。
   * @returns {Promise<Response>}
   */
  function fetchWithRetry(url, retries, options) {
    if (typeof retries === 'undefined') retries = MAX_RETRIES;
    // ★ M1修复：重试入口校验取消——首次调用时也会校验（虽然 dm-download.js 在调用前后都有兜底校验，
    //   这里集中校验让通用 fetchWithRetry 也支持取消语义，下游调用方无需各自处理）
    if (options && typeof options.shouldAbort === 'function' && options.shouldAbort()) {
      var abortErr = new Error('下载已取消');
      abortErr.code = ERR_CANCELLED;
      throw abortErr;
    }
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
            // ★ M1修复：重试 setTimeout 间隔内可能已被取消，再次校验避免无效重试
            if (options && typeof options.shouldAbort === 'function' && options.shouldAbort()) {
              var e = new Error('下载已取消');
              e.code = ERR_CANCELLED;
              throw e;
            }
            return fetchWithRetry(url, retries - 1, options);
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
          // ★ M1修复：切换地址时也校验取消（用户在等待备用地址切换期间可能已取消）
          if (options && typeof options.shouldAbort === 'function' && options.shouldAbort()) {
            var abortSwitchErr = new Error('下载已取消');
            abortSwitchErr.code = ERR_CANCELLED;
            throw abortSwitchErr;
          }
          return fetchWithRetry(newUrl, MAX_RETRIES, options);
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

