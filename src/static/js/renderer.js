/*!
 * renderer.js — 书报 SPA 电子书渲染器
 *
 * 从 DataManager (books-index.json) 渲染各视图：
 *   .renderHome()                        → 书籍列表
 *   .renderChapterList(bookId)           → 章节列表（目录）
 *   .renderReadingView(bookId, chapterN) → 阅读视图
 *
 * 暴露：window.BKRenderer
 */
(function (win) {
  'use strict';

  // ── 本地开发模式检测 ──────────────────────────────────────────────────
  // 本地测试时跳过所有远程请求（更新检查、CDN 下载等）
  (function () {
    var h = win.location.hostname, p = win.location.protocol;
    win.__BK_LOCAL_DEV__ = (h === 'localhost' || h === '127.0.0.1' || h === '' ||
      p === 'file:' || /^192\.168\.\d+\.\d+$/.test(h) ||
      /^10\.\d+\.\d+\.\d+$/.test(h) || h === '[::1]');
  })();

  // ── 工具 ────────────────────────────────────────────────────────────────

  function escAttr(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function escText(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  /**
   * 轻量 Toast 提示（无外部依赖；首次调用注入极简样式，约 2.2s 后自动消失）。
   * 项目此前无统一 toast 函数，此处最小化实现，供重同步等轻交互反馈复用。
   * @param {string} msg 提示文案
   */
  var _toastTimer = null;
  function _toast(msg) {
    if (!msg) return;
    try {
      if (!document.getElementById('bk-resync-toast-style')) {
        var st = document.createElement('style');
        st.id = 'bk-resync-toast-style';
        st.textContent =
          '.bk-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%) translateY(12px);' +
          'background:rgba(26,25,24,.92);color:#fff;padding:10px 18px;border-radius:22px;' +
          'font-size:14px;z-index:99999;opacity:0;transition:opacity .2s,transform .2s;' +
          'pointer-events:none;max-width:80vw;white-space:nowrap}' +
          '.bk-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}';
        document.head.appendChild(st);
      }
      var el = document.createElement('div');
      el.className = 'bk-toast';
      el.textContent = String(msg);
      document.body.appendChild(el);
      // 触发过渡（requestAnimationFrame 不可用时直接显示）
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { el.classList.add('show'); });
      } else {
        el.classList.add('show');
      }
      if (_toastTimer) clearTimeout(_toastTimer);
      _toastTimer = setTimeout(function () {
        el.classList.remove('show');
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
      }, 2200);
    } catch (e) { /* 极端环境兜底：静默 */ }
  }

  // 系列颜色调色板（用于书籍卡片左侧指示条）
  var _seriesColors = [
    '#3D8A5A', '#D89575', '#D4A64A', '#6E8B4E', '#C77B53',
    '#B5855B', '#8A9A5B', '#A9794E', '#C98B6B', '#7A8B5A',
    '#CC9B5C', '#B5654A', '#5E8C6A', '#C28E5A', '#9A8B5B'
  ];
  var _seriesColorMap = {};
  var _seriesColorIdx = 0;

  function _getSeriesColor(seriesId) {
    if (!seriesId) return '#3D8A5A';
    if (!_seriesColorMap[seriesId]) {
      _seriesColorMap[seriesId] = _seriesColors[_seriesColorIdx % _seriesColors.length];
      _seriesColorIdx++;
    }
    return _seriesColorMap[seriesId];
  }

  // 书名清洗：去掉前导编号（如 "1210-神赐给人类最好的礼物" -> "神赐给人类最好的礼物"）
  function _cleanBookTitle(t) {
    if (!t) return '';
    return String(t).replace(/^[\d]+\s*[-–—:：·.\s]+/, '').replace(/\s+$/, '');
  }

  // 书号提取：取书名前导编号（与 _cleanBookTitle 对应）。如 "1210-神赐…" -> "1210"；无编号返回 ''。
  // 真实书报数据中部分书名带前导编号、部分不带，故书号在书城三级为可选渲染。
  function _extractBookNo(t) {
    if (!t) return '';
    var m = String(t).match(/^(\d+)\s*[-–—:：·.\s]+/);
    return m ? m[1] : '';
  }

  // 来源徽标：区分书籍的导入渠道（本地文件 / WebDAV）。
  // - local  -> 「📁 本地」
  // - webdav -> 「☁ {服务器名称}」，服务器名称缺失时回退显示地址（serverName 已在导入时写入 name||url）。
  // 无 source（书城目录书）不渲染徽标。
  function _sourceBadgeHTML(book) {
    var s = book && book.source;
    if (!s || !s.type) return '';
    if (s.type === 'local') {
      return '<span class="book-source-badge book-source-local">📁 本地</span>';
    }
    if (s.type === 'webdav') {
      var label = s.serverName || 'WebDAV';
      return '<span class="book-source-badge book-source-webdav" title="' + escAttr(label) + '">☁ ' + escText(label) + '</span>';
    }
    return '';
  }

  /**
   * 版式封面（typographic cover）：无真实封面图时的优雅降级。
   * 系列主题色作底 + 衬线书名 + 系列名 + 品牌角标，整体符合 Soft Nordic 调性。
   * @param {Object} bookOrResult 书籍对象或搜索结果对象（含 title/bookTitle/series/seriesTitle）
   * @param {Object} opts { size: 'sm'|'md'|'lg', seriesTitle: string }
   */
  function _coverHTML(bookOrResult, opts) {
    opts = opts || {};
    var b = bookOrResult || {};
    var series = b.series || '';
    var color = _getSeriesColor(series);
    var rawTitle = b.title || b.bookTitle || b.id || '';
    var title = _cleanBookTitle(rawTitle);
    var seriesTitle = opts.seriesTitle || '';
    var sizeCls = opts.size ? ' bk-cover--' + opts.size : '';
    var html = '<div class="bk-cover' + sizeCls + '" style="--cover-color:' + color + '" role="img" aria-label="' + escAttr(title + ' 封面') + '">';
    html += '<div class="bk-cover-inner">';
    if (seriesTitle) {
      html += '<div class="bk-cover-series">' + escText(seriesTitle) + '</div>';
    }
    html += '<div class="bk-cover-title">' + escText(title) + '</div>';
    html += '<div class="bk-cover-rule"></div>';
    html += '<div class="bk-cover-foot">书报</div>';
    html += '</div></div>';
    return html;
  }

  function wrapRefs(text, ctxScripture) {
    return win.BKRef ? win.BKRef.wrapRefs(text, ctxScripture || '') : escText(text);
  }

  /**
   * 富文本版 wrapRefs：将 HTML 字符串拆分为标签片段和纯文本片段，
   * 仅对纯文本片段调用 wrapRefs()（内部会转义 HTML 并添加经文引用链接），
   * 标签片段原样保留，从而实现「保留内联格式 + 经文引用检测」双重功能。
   */
  function wrapRefsRich(html, ctxScripture) {
    if (!html) return '';
    var parts = html.split(/(<[^>]+>)/);
    var result = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        // 纯文本片段 — 过 wrapRefs（转义 + 经文引用）
        result += wrapRefs(parts[i], ctxScripture);
      } else {
        // 标签片段 — 原样保留
        result += parts[i];
      }
    }
    return result;
  }

  // 缓存已加载的 book.json（LRU 淘汰，最多 15 本）
  var _bookCache = {};
  var _bookCacheKeys = [];  // 按访问顺序排列的键
  var _BOOK_CACHE_MAX = 15;

  function _bookCacheGet(bookId) {
    if (!_bookCache[bookId]) return null;
    // 移至末尾（最近访问）
    var idx = _bookCacheKeys.indexOf(bookId);
    if (idx > -1) _bookCacheKeys.splice(idx, 1);
    _bookCacheKeys.push(bookId);
    return _bookCache[bookId];
  }

  function _bookCacheSet(bookId, data) {
    // 如果已存在，先移除旧位置
    var idx = _bookCacheKeys.indexOf(bookId);
    if (idx > -1) _bookCacheKeys.splice(idx, 1);
    // 添加新条目
    _bookCache[bookId] = data;
    _bookCacheKeys.push(bookId);
    // 超出限制时淘汰最旧的
    while (_bookCacheKeys.length > _BOOK_CACHE_MAX) {
      var oldest = _bookCacheKeys.shift();
      delete _bookCache[oldest];
    }
  }


  // ── zl-html 数据状态 ────────────────────────────────────────────────────
  var _zlIndex = null;          // DataManager 加载的 books-index.json
  var _zlSeries = [];           // 系列数组
  var _zlBooks = [];            // 书籍数组
  var _zlCurrentSeries = '';   // 当前选中的系列过滤
  var _zlCurrentCategory = null;  // 当前选中的类型（null 表示显示类型目录页）
  var _zlCurrentCategoryPrefix = null; // 当前选中类型的 category_prefix
  var _zlDownloadedIds = [];    // 已下载的书籍 ID 列表
  var _zlHomeView = 'catalog';  // 首页视图模式：'catalog'（系列目录）| 'series'（系列书籍列表）
  var _zlDmReady = false;       // DataManager 是否就绪
  var _bmLoadedListenerBound = false; // 「书签已加载」事件监听是否已注册（仅一次）
  var _dmInitPromise = null;    // DataManager 初始化 Promise（单例）
  var _dlPanelOpen = false;     // 下载面板是否展开
  var _dlProgressTimer = null;  // 下载进度轮询定时器
  var _manageMode = false;      // 书籍管理模式（显示删除按钮）
  var _showAppGen = 0;          // showApp 过渡动画生成计数器
  var _bkHomeClickHandler = null; // 首页事件委托处理器（用于 removeEventListener）
  var _zlIndexUpdateHandler = null; // 索引更新事件处理器（用于 removeEventListener）
  var _bkShelfChangedBound = false;   // 书城卡片全局 bk-shelf-changed 监听是否已注册（仅一次）
  var _shelfPageChangedBound = false; // 书架页全局 bk-shelf-changed 监听是否已注册（仅一次）
  var _shelfActiveTab = 'reading';   // 书架分段激活态：'reading'（在读，默认）| 'read'（已读）

  // 滚动位置记忆
  var _scrollSaveTimer = null;
  var _scrollSaveHandler = null;
  var _scrollPageKey = null;
  var _scrollTarget = null; // 当前滚动监听挂载的元素（window 或 .bk-carousel-page）

  // 阅读视图的纵向滚动发生在当前 .bk-carousel-page 内部（不再依赖文档滚动，
  // 以免被 bk-scroll-locked 的 touch-action:none 阻断）。此处返回真正的滚动容器。
  function _getScrollContainer() {
    if (document.body.classList.contains('bk-reading-page')) {
      var page = (_carouselPages && _carouselPages.curr) || document.getElementById('carouselPageCurr');
      if (page) return page;
    }
    return win;
  }

  // ── 数据加载 ─────────────────────────────────────────────────────────────



  function loadBook(bookId) {
    var _cached = _bookCacheGet(bookId);
    if (_cached) return Promise.resolve(_cached);

    // ★ 确保 DataManager 已初始化（直接 URL 导航时可能尚未初始化）
    return _ensureDmInit().then(function () {
      // ★ 本地导入书籍（必须在 DataManager 之前，避免 imported-xxx 触发远程下载）
      if (win.ImportManager && win.ImportManager.getImportedBook) {
        return Promise.resolve().then(function () {
          return win.ImportManager.getImportedBook(bookId);
        }).then(function (data) {
          if (data) { _bookCacheSet(bookId, data); return data; }
          // 导入书籍 ID 但数据丢失：DataManager 不可能找到，直接报错
          if (bookId.indexOf('imported-') === 0) {
            throw new Error('导入书籍数据丢失，请重新导入该书。');
          }
          // 未命中导入，继续走 DataManager
          if (_zlDmReady && win.DataManager) {
            return win.DataManager.getBook(bookId)
              .then(function (d) { _bookCacheSet(bookId, d); return d; })
              .catch(function (dmErr) {
                console.warn('[Renderer] DataManager 加载失败: ' + bookId, dmErr.message);
                if (_isBookDownloaded(bookId) === false && !navigator.onLine) {
                  throw new Error('此书尚未缓存，请连接网络后重试。可在下载管理中预先缓存书籍。');
                }
                throw dmErr;
              });
          }
          return Promise.reject(new Error('DataManager 未初始化'));
        });
      }

      // 通过 DataManager 加载书籍
      if (_zlDmReady && win.DataManager) {
        return win.DataManager.getBook(bookId)
          .then(function (data) { _bookCacheSet(bookId, data); return data; })
          .catch(function (dmErr) {
            console.warn('[Renderer] DataManager 加载失败: ' + bookId, dmErr.message);
            if (_isBookDownloaded(bookId) === false && !navigator.onLine) {
              throw new Error('此书尚未缓存，请连接网络后重试。可在下载管理中预先缓存书籍。');
            }
            throw dmErr;
          });
      }

      // DataManager 不可用，检查导入管理器
      return Promise.reject(new Error('DataManager 未初始化'));
    });
  }

  // 旧路径加载已移除（books.json / book.json 不再使用）

  /**
   * 确保 DataManager 已初始化（单例 Promise）
   * 在 loadBook 之前调用，确保直接 URL 导航也能正确加载数据
   */
  function _ensureDmInit() {
    if (_dmInitPromise) return _dmInitPromise;
    _dmInitPromise = (function () {
      if (_zlDmReady) return Promise.resolve();
      var dmUrl = '';
      var dmUrls = [];
      var isNativeApp = false;
      var isPwaStandalone = false;
      try {
        // 检测是否为本地开发环境
        var hostname = win.location.hostname;
        var protocol = win.location.protocol;
        var isLocal = hostname === 'localhost'
          || hostname === '127.0.0.1'
          || hostname === ''
          || protocol === 'file:'
          || /^192\.168\.\d+\.\d+$/.test(hostname)
          || /^10\.\d+\.\d+\.\d+$/.test(hostname)
          || hostname === '[::1]';

        // ★ 优先检测 APK/PWA（Capacitor WebView 的 hostname 也是 localhost）
        isNativeApp = !!(win.Capacitor && win.Capacitor.isNativePlatform && win.Capacitor.isNativePlatform());
        isPwaStandalone = (win.matchMedia && win.matchMedia('(display-mode: standalone)').matches) || win.navigator.standalone;

        // 从配置的 cloudflare 地址列表构建数据源 URL（多个地址可容灾）
        var cfServers = (win.BK_SERVERS && win.BK_SERVERS.cloudflare) || [];

        if (isNativeApp || isPwaStandalone) {
          // APK/PWA：优先使用本地 bundled 索引数据，回退到 CDN
          var localZlData = './zl-data';
          var cfFallbackUrls = [];
          if (cfServers.length > 0) {
            for (var si = 0; si < cfServers.length; si++) {
              cfFallbackUrls.push(cfServers[si].replace(/\/+$/, '') + '/zl-data');
            }
          } else {
            cfFallbackUrls.push('https://books-data.pages.dev/zl-data');
          }
          // APK/PWA 本地数据始终可用（APK 打包 / PWA 安装时缓存），
          // DataManager.loadIndex() 对本地路径走 localforage 缓存优先，无需探路 fetch
          dmUrl = localZlData;
          dmUrls = [localZlData].concat(cfFallbackUrls);
          console.log('[Renderer] ' + (isNativeApp ? 'APK' : 'PWA') + '模式：使用本地索引数据，CDN 备用');
          return _setupDataManager(dmUrl, dmUrls);
        } else if (isLocal) {
          // 本地开发模式：使用 output/zl-data/（由 main.py copy_zl_merged_data 完整复制）
          // 服务器从 output/ 启动时，相对路径 ./zl-data 正确指向 zl-data/
          dmUrl = './zl-data';
          dmUrls.push(dmUrl);
          console.log('[Renderer] 本地模式：DataManager 使用 ' + dmUrl);
        } else {
          dmUrls.push(win.location.origin + '/zl-data');
          // 添加 CDN 兜底地址，与 APK/PWA 分支保持一致
          if (cfServers.length > 0) {
            for (var bi = 0; bi < cfServers.length; bi++) {
              var cfUrl = cfServers[bi].replace(/\/+$/, '') + '/zl-data';
              if (dmUrls.indexOf(cfUrl) === -1) {
                dmUrls.push(cfUrl);
              }
            }
          } else {
            dmUrls.push('https://books-data.pages.dev/zl-data');
          }
          dmUrl = dmUrls[0];
          console.log('[Renderer] 浏览器模式：DataManager 使用 ' + dmUrl + '（' + dmUrls.length + ' 个地址）');
        }
      } catch (e) {}
      return _setupDataManager(dmUrl, dmUrls);
    })();
    win._bkDataReady = _dmInitPromise;
    return _dmInitPromise;
  }

  /**
   * 初始化 DataManager（提取为独立函数，供 _ensureDmInit 同步/异步复用）
   */
  function _setupDataManager(dmUrl, dmUrls) {
    if (!dmUrl || !win.DataManager) return Promise.resolve();
    win.DataManager.setBaseUrl(dmUrls && dmUrls.length > 1 ? dmUrls : dmUrl);
    _zlDmReady = true;
    return Promise.all([
      win.DataManager.loadIndex(),
      win.DataManager.getDownloadedBookIds()
    ]).then(function (results) {
      var indexData = results[0];
      var downloadedIds = results[1] || [];
      if (indexData && indexData.series && indexData.books) {
        _zlIndex = indexData;
        _zlSeries = indexData.series || [];
        _zlBooks = indexData.books || [];
        _invalidateMergedSeriesCache();
        _zlDownloadedIds = downloadedIds;
        BKRenderer._zlActive = true;
        if (!win.__bkBooks) win.__bkBooks = [];
        for (var zi = 0; zi < _zlBooks.length; zi++) {
          var zlBook = _zlBooks[zi];
          var found = false;
          for (var bi = 0; bi < win.__bkBooks.length; bi++) {
            if (win.__bkBooks[bi].id === zlBook.id) { found = true; break; }
          }
          if (!found) win.__bkBooks.push(zlBook);
        }
        // DataManager 加载成功后，若当前浏览视图（书架 / 书城）可见则就地重渲染
        var homeEl = document.getElementById('homeView');
        var appEl = document.getElementById('app');
        if (appEl && appEl.style.display !== 'none') {
          if (win.location.hash.indexOf('city') !== -1) {
            if (BKRenderer.renderCityPage) BKRenderer.renderCityPage();
          } else if (BKRenderer.renderShelfPage) {
            BKRenderer.renderShelfPage();
          }
        } else if (homeEl && homeEl.style.display !== 'none' && _zlBooks.length > 0) {
          if (BKRenderer.renderCityPage) BKRenderer.renderCityPage();
        }
      }
      return _mergeImportedBooks();
    }).catch(function (err) {
      console.warn('[Renderer] DataManager 初始化失败:', err.message);
      _zlDmReady = false;
    });
  }

  // ── 容器与视图切换 ────────────────────────────────────────────────────

  function getApp() { return document.getElementById('app') || document.body; }

  function showApp() {
    if (win._bkShowApp) { win._bkShowApp(); } else {
      var h = document.getElementById('homeView'), a = document.getElementById('app');
      if (h) h.style.display = 'none';
      if (a) a.style.display = '';
    }
    // 触发 fade-in 过渡
    var appEl = document.getElementById('app');
    if (appEl) {
      var gen = ++_showAppGen;
      appEl.classList.remove('bk-view-enter', 'bk-view-enter-active');
      appEl.classList.add('bk-view-enter');
      requestAnimationFrame(function() {
        if (gen !== _showAppGen) return;
        requestAnimationFrame(function() {
          if (gen !== _showAppGen) return;
          appEl.classList.remove('bk-view-enter');
          appEl.classList.add('bk-view-enter-active');
        });
      });
    }
  }
  function showHome() {
    if (win._bkShowHome) { win._bkShowHome(); return; }
    var h = document.getElementById('homeView'), a = document.getElementById('app');
    if (h) h.style.display = '';
    if (a) a.style.display = 'none';
    document.title = '书报';
  }

  // ── 滚动位置记忆 ─────────────────────────────────────────────────────

  function saveScrollPosition() {
    if (!_scrollPageKey) return;
    try {
      var c = _getScrollContainer();
      var y = c === win ? (win.scrollY || 0) : (c.scrollTop || 0);
      localStorage.setItem('bk_scroll:' + _scrollPageKey, String(y));
    } catch(e) {}
  }

  function restoreScrollPosition(pageKey) {
    try {
      var y = parseInt(localStorage.getItem('bk_scroll:' + pageKey) || '0', 10);
      if (y > 0) {
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            var c = _getScrollContainer();
            if (c === win) win.scrollTo(0, y);
            else c.scrollTop = y;
          });
        });
      }
    } catch(e) {}
  }

  function startScrollTracking(pageKey) {
    stopScrollTracking();
    _scrollPageKey = pageKey;
    _scrollSaveHandler = function() {
      clearTimeout(_scrollSaveTimer);
      _scrollSaveTimer = setTimeout(saveScrollPosition, 300);
    };
    _scrollTarget = _getScrollContainer();
    _scrollTarget.addEventListener('scroll', _scrollSaveHandler, { passive: true });
  }

  function stopScrollTracking() {
    saveScrollPosition();
    if (_scrollSaveHandler) {
      var target = _scrollTarget || win;
      target.removeEventListener('scroll', _scrollSaveHandler);
      _scrollSaveHandler = null;
      _scrollTarget = null;
    }
    _scrollPageKey = null;
  }

  // ── 阅读进度追踪 ─────────────────────────────────────────────────────

  function saveReadingProgress(bookId, chapterNum) {
    try {
      var key = 'bk_progress:' + bookId;
      localStorage.setItem(key, String(chapterNum));
    } catch(e) {}

    // 自动标记钩子：读到最后一章且尚未标记已读时，自动补标「已读」。
    // 触发条件：chapter_count>0 且 chapterNum >= chapter_count。
    // （TTS 进度条不写 bk_progress，不会误触发此钩子。）
    // 去重由 BKShelf.markRead 内部幂等保证，此处无需自行判断。
    try {
      var cc = (_findBookById(bookId) || {}).chapter_count || 0;
      var alreadyRead = (win.BKShelf && win.BKShelf.isRead) ? win.BKShelf.isRead(bookId) : false;
      if (cc > 0 && chapterNum >= cc && !alreadyRead && win.BKShelf && win.BKShelf.markRead) {
        win.BKShelf.markRead(bookId);
      }
    } catch (e) {}
  }

  function getReadingProgress(bookId) {
    try {
      return parseInt(localStorage.getItem('bk_progress:' + bookId) || '0', 10);
    } catch(e) { return 0; }
  }

  // ── 通用片段：底部控制栏（TTS） ──────────────────────────────────────

  function buildBottomControlBar() {
    return '' +
      '<div class="bottom-control-bar" id="bottomControlBar" style="display:none;">' +
        '<button class="control-btn play-pause-btn" id="playPauseBtn" title="播放/暂停" aria-label="播放">' +
          '<span class="play-icon">▶</span>' +
          '<span class="pause-icon" style="display:none;">⏸</span>' +
        '</button>' +
        '<div class="progress-section">' +
          '<div class="progress-column">' +
            '<input type="range" id="progressBar" class="progress-bar" min="0" max="100" value="0" step="0.1">' +
            '<span class="speech-time" id="speechTime">00:00 / 00:00</span>' +
          '</div>' +
          '<select id="rateSelect" class="control-select" title="语速">' +
            '<option value="0.5">0.5x</option>' +
            '<option value="0.75">0.75x</option>' +
            '<option value="1" selected>1x</option>' +
            '<option value="1.25">1.25x</option>' +
            '<option value="1.5">1.5x</option>' +
            '<option value="2">2x</option>' +
          '</select>' +
        '</div>' +
      '</div>';
  }

  // ── Content → HTML 渲染 ──────────────────────────────────────────────

  function renderContentItem(item, ctx, eager) {
    if (!item) return '';
    var type = item.type || 'paragraph';
    var text = item.text || '';
    var html = '';

    switch (type) {
      case 'heading':
        var level = item.level || 2;
        level = Math.max(1, Math.min(6, level));
        var hStyleAttr = item.style ? ' style="' + escAttr(item.style) + '"' : '';
        html = '<h' + level + ' class="bk-heading bk-h' + level + '"' + hStyleAttr + '>' +
          (item.html ? wrapRefsRich(item.html, ctx) : wrapRefs(text, ctx)) + '</' + level + '>';
        break;

      case 'quote':
        var qStyleAttr = item.style ? ' style="' + escAttr(item.style) + '"' : '';
        html = '<blockquote class="bk-quote"' + qStyleAttr + '>' +
          '<div class="bk-quote-content">' +
          (item.html ? wrapRefsRich(item.html, ctx) : wrapRefs(text, ctx)) + '</div>' +
          '</blockquote>';
        break;

      case 'image':
        var src = item.src || '';
        var alt = item.attrs && item.attrs.alt || '';
        // 预览页（carousel prev/next）需要立即加载图片，否则滑动时视口外图片因 lazy 未加载而显示空白
        var imgLoading = eager ? 'eager' : 'lazy';
        html = '<figure class="bk-figure">' +
          '<img src="' + escAttr(src) + '" alt="' + escAttr(alt || text) + '" loading="' + imgLoading + '">' +
          (text ? '<figcaption>' + escText(text) + '</figcaption>' : '') +
          '</figure>';
        break;

      case 'list':
        var items = item.items || [];
        var itemHtmls = item.itemHtmls || [];
        var ordered = item.attrs && item.attrs.ordered;
        var tag = ordered ? 'ol' : 'ul';
        html = '<' + tag + ' class="bk-list">';
        for (var i = 0; i < items.length; i++) {
          var liContent = (itemHtmls[i] != null) ? wrapRefsRich(itemHtmls[i], ctx) : wrapRefs(items[i], ctx);
          html += '<li>' + liContent + '</li>';
        }
        html += '</' + tag + '>';
        break;

      case 'code':
        var lang = (item.attrs && item.attrs.language) || '';
        html = '<pre class="bk-code' + (lang ? ' language-' + escAttr(lang) : '') + '"><code>' + escText(text) + '</code></pre>';
        break;

      case 'footnote':
        var fnId = (item.attrs && item.attrs.id) || '';
        html = '<div class="bk-footnote" id="fn-' + escAttr(fnId) + '">' +
          '<span class="bk-fn-number">' + escText(fnId) + '</span>' +
          '<span class="bk-fn-text">' + wrapRefs(text, ctx) + '</span>' +
          '</div>';
        break;

      case 'pdf_page':
        var pgNum = item.pageNumber || 1;
        var pdfBkId = item.pdfBookId || '';
        html = '<div class="bk-pdf-page" data-pdf-page="' + pgNum + '" data-pdf-book="' + escAttr(pdfBkId) + '">' +
          '<div class="bk-pdf-page-placeholder"><span>第 ' + pgNum + ' 页</span></div>' +
          '<canvas class="bk-pdf-canvas"></canvas>' +
          '</div>';
        break;

      case 'separator':
        html = '<hr class="bk-separator">';
        break;

      case 'table':
        var tRows = item.rows || [];
        if (tRows.length) {
          html = '<table class="bk-table">';
          for (var ri2 = 0; ri2 < tRows.length; ri2++) {
            var row2 = tRows[ri2];
            html += '<tr>';
            var cells2 = row2.cells || [];
            for (var ci4 = 0; ci4 < cells2.length; ci4++) {
              var cell2 = cells2[ci4];
              var cellTag2 = row2.header ? 'th' : 'td';
              var cellContent2 = cell2.html
                ? wrapRefsRich(cell2.html, ctx)
                : wrapRefs(cell2.text || '', ctx);
              html += '<' + cellTag2 + '>' + cellContent2 + '</' + cellTag2 + '>';
            }
            html += '</tr>';
          }
          html += '</table>';
        }
        break;

      case 'paragraph':
      default:
        if (text || item.html) {
          var pStyleAttr = item.style ? ' style="' + escAttr(item.style) + '"' : '';
          html = '<p class="bk-paragraph"' + pStyleAttr + '>' +
            (item.html ? wrapRefsRich(item.html, ctx) : wrapRefs(text, ctx)) + '</p>';
        }
        break;
    }
    return html;
  }

  function renderChapterContent(chapter, eager) {
    var contentArr = chapter.content || [];
    var html = '';

    // 当页章节标题：固定在正文顶部展示，浮动导航自动收起后仍可见当前章节
    var pageTitle = chapter.title || ('第' + (chapter.number != null ? chapter.number : '') + '章');
    html += '<h1 class="bk-page-title">' + escText(pageTitle) + '</h1>';

    // 从章节标题提取初始经文上下文
    // 例如标题 "约翰福音" → scanCtx 可识别出 "约" 书卷
    // 例如标题 "第十三章" → 在已有书卷基础上识别章号
    var ctx = '';
    if (win.BKRef && win.BKRef.scanCtx) {
      // 先尝试从 chapter 元数据获取 scripture 字段（cx 兼容）
      if (chapter.scripture) {
        ctx = chapter.scripture;
      } else if (chapter.title) {
        // 从标题中提取：如果标题含书卷名（如"约翰福音"、"创世记"）
        ctx = win.BKRef.scanCtx(chapter.title, '');
      }
    }

    // 兼容：如果 content 是字符串（未经转换的纯文本），按 \n 拆分渲染
    if (typeof contentArr === 'string') {
      var lines = contentArr.split('\n');
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim();
        if (!line) continue;

        // 检测 heading 标记（## 开头）
        var headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
        if (headingMatch) {
          var level = Math.min(headingMatch[1].length, 6);
          var hText = headingMatch[2].trim();
          html += '<h' + level + ' class="bk-heading bk-h' + level + '">' + wrapRefs(hText, ctx) + '</h' + level + '>';
          // heading 通常包含书卷名或章节信息，优先更新上下文
          if (win.BKRef && win.BKRef.scanCtx) {
            ctx = win.BKRef.scanCtx(hText, ctx);
          }
        } else {
          html += '<p class="bk-paragraph">' + wrapRefs(line, ctx) + '</p>';
          // 段落也更新上下文
          if (win.BKRef && win.BKRef.scanCtx) {
            ctx = win.BKRef.scanCtx(line, ctx);
          }
        }
      }
      return html;
    }

    // 预扫描：如果初始 ctx 为空，从第一个 heading 项提取上下文
    if (!ctx && win.BKRef && win.BKRef.scanCtx) {
      for (var pi = 0; pi < contentArr.length; pi++) {
        var pItem = contentArr[pi];
        if (pItem && pItem.type === 'heading' && pItem.text) {
          ctx = win.BKRef.scanCtx(pItem.text, '');
          if (ctx) break;
        }
        // 如果已经遇到非 heading 的内容，停止预扫描
        if (pItem && pItem.type !== 'heading' && pItem.text) break;
      }
    }

    for (var i = 0; i < contentArr.length; i++) {
      var item = contentArr[i];
      html += renderContentItem(item, ctx, eager);
      // 对有文本内容的项更新经文上下文
      if (item && item.text && win.BKRef && win.BKRef.scanCtx) {
        ctx = win.BKRef.scanCtx(item.text, ctx);
      }
    }
    // 脚注区域
    var footnotes = chapter.footnotes || [];
    if (footnotes.length) {
      html += '<div class="bk-footnotes-section">';
      html += '<h3 class="bk-footnotes-title">脚注</h3>';
      for (var fi = 0; fi < footnotes.length; fi++) {
        var fn = footnotes[fi];
        html += '<div class="bk-footnote" id="fn-' + escAttr(fn.id || fi + 1) + '">';
        html += '<span class="bk-fn-number">' + escText(fn.id || (fi + 1)) + '</span>';
        html += '<span class="bk-fn-text">' + wrapRefs(fn.text || '', ctx) + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }
    return html;
  }

  // ── PDF 页面懒渲染 ──────────────────────────────────────────────────────
  // 使用 IntersectionObserver 在 .bk-pdf-page 元素进入视口时，
  // 用 pdf.js 渲染对应页到内嵌 <canvas>。

  var _pdfDocCache = {};      // pdfBookId → Promise<pdfDocument> (缓存 Promise 避免并发重复加载)
  var _pdfRenderObserver = null; // IntersectionObserver 单例

  function _getPdfDoc(pdfBookId) {
    if (_pdfDocCache[pdfBookId]) return _pdfDocCache[pdfBookId];
    // 从 imported-pdf-data store 读取 Uint8Array
    var pdfStore = (win.ImportManager && win.ImportManager.getPdfDataStore)
      ? win.ImportManager.getPdfDataStore() : null;
    if (!pdfStore) return Promise.reject(new Error('PDF 数据存储不可用'));
    var p = pdfStore.getItem('pdf:' + pdfBookId).then(function (data) {
      if (!data) return Promise.reject(new Error('PDF 数据未找到: ' + pdfBookId));
      var lib = win.pdfjsLib;
      if (!lib) return Promise.reject(new Error('pdf.js 未加载'));
      return lib.getDocument({ data: new Uint8Array(data) }).promise;
    });
    _pdfDocCache[pdfBookId] = p;
    return p;
  }

  function _cleanupPdfCache() {
    var keys = Object.keys(_pdfDocCache);
    for (var i = 0; i < keys.length; i++) {
      // pdfDocument.destroy() 需在 resolve 后调用；这里安全地尝试
      var p = _pdfDocCache[keys[i]];
      if (p && typeof p.then === 'function') {
        p.then(function (pdf) { if (pdf && pdf.destroy) pdf.destroy(); }).catch(function () {});
      }
    }
    _pdfDocCache = {};
    if (_pdfRenderObserver) {
      _pdfRenderObserver.disconnect();
      _pdfRenderObserver = null;
    }
  }

  function _renderPdfPage(el) {
    if (el.getAttribute('data-pdf-rendered') === '1') return;
    var pgNum = parseInt(el.getAttribute('data-pdf-page'), 10) || 1;
    var pdfBkId = el.getAttribute('data-pdf-book') || '';
    var canvas = el.querySelector('.bk-pdf-canvas');
    if (!canvas) return;

    var placeholder = el.querySelector('.bk-pdf-page-placeholder');

    _getPdfDoc(pdfBkId).then(function (pdf) {
      return pdf.getPage(pgNum);
    }).then(function (page) {
      var viewport = page.getViewport({ scale: 1 });
      // 按容器宽度适配缩放
      var containerWidth = el.clientWidth || el.parentElement.clientWidth || 600;
      var scale = containerWidth / viewport.width;
      var scaledViewport = page.getViewport({ scale: scale });

      canvas.width = Math.floor(scaledViewport.width);
      canvas.height = Math.floor(scaledViewport.height);
      canvas.style.width = Math.floor(scaledViewport.width) + 'px';
      canvas.style.height = Math.floor(scaledViewport.height) + 'px';

      var ctx = canvas.getContext('2d');
      return page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
    }).then(function () {
      // 渲染完成，标记并隐藏占位
      el.setAttribute('data-pdf-rendered', '1');
      if (placeholder) placeholder.style.display = 'none';
      canvas.style.opacity = '1';
    }).catch(function (err) {
      console.warn('[PDF] 页面渲染失败:', pgNum, err);
      if (placeholder) placeholder.innerHTML = '<span>页面加载失败</span>';
    });
  }

  function initPdfPageLazyRender(containerEl) {
    var pages = containerEl.querySelectorAll('.bk-pdf-page');
    if (!pages.length) return;

    if (!_pdfRenderObserver) {
      _pdfRenderObserver = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            _renderPdfPage(entries[i].target);
            _pdfRenderObserver.unobserve(entries[i].target);
          }
        }
      }, { rootMargin: '200px 0px' });
    }

    for (var i = 0; i < pages.length; i++) {
      _pdfRenderObserver.observe(pages[i]);
    }
  }

  // ── 章节去重辅助 ──────────────────────────────────────────────────

  /**
   * 获取去重后的章节列表（按 number 去重，保留首次出现的章节）
   * 适用于某些书籍数据中同一编号有多条记录的情况（如读经一年一遍的每日两读）
   */
  function _getUniqueChapters(chapters) {
    var seen = {};
    var unique = [];
    for (var i = 0; i < chapters.length; i++) {
      var num = chapters[i].number;
      if (!seen[num]) {
        seen[num] = true;
        unique.push(chapters[i]);
      }
    }
    return unique;
  }

  // ── 键盘快捷键管理 ────────────────────────────────────────────────────

  var _readingKeyHandler = null;

  function _installReadingShortcuts(bookId, uniqueChapters, chapterNum) {
    _removeReadingShortcuts();
    _readingKeyHandler = function (e) {
      // 忽略输入框内的按键
      var tag = (e.target && e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        // 上一章
        for (var i = 0; i < uniqueChapters.length; i++) {
          if (uniqueChapters[i].number === chapterNum && i > 0) {
            if (win.BKRouter) win.BKRouter.navigate(bookId + '/' + uniqueChapters[i - 1].number);
            break;
          }
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        // 下一章
        for (var i = 0; i < uniqueChapters.length; i++) {
          if (uniqueChapters[i].number === chapterNum && i < uniqueChapters.length - 1) {
            if (win.BKRouter) win.BKRouter.navigate(bookId + '/' + uniqueChapters[i + 1].number);
            break;
          }
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (win.BKRouter) win.BKRouter.navigate('');
      }
    };
    document.addEventListener('keydown', _readingKeyHandler);
  }

  function _removeReadingShortcuts() {
    if (_readingKeyHandler) {
      document.removeEventListener('keydown', _readingKeyHandler);
      _readingKeyHandler = null;
    }
    _removeSwipeHandler();
    _removeChapterLinkHandler();
  }

  // ── 跨章节链接（事件委托） ──────────────────────────────────────────
  var _chapterLinkHandler = null;
  var _chapterLinkBookId = null;

  function _installChapterLinkHandler(bookId) {
    _removeChapterLinkHandler();
    _chapterLinkBookId = bookId;
    _chapterLinkHandler = function (e) {
      var link = e.target.closest('[data-chapter-link]');
      if (!link) return;
      e.preventDefault();
      var targetChapter = parseInt(link.getAttribute('data-chapter-link'), 10);
      if (targetChapter && _chapterLinkBookId && win.BKRouter) {
        win.BKRouter.navigate(_chapterLinkBookId + '/' + targetChapter);
      }
    };
    var app = getApp();
    if (app) app.addEventListener('click', _chapterLinkHandler);
  }

  function _removeChapterLinkHandler() {
    if (_chapterLinkHandler) {
      var app = getApp();
      if (app) app.removeEventListener('click', _chapterLinkHandler);
      _chapterLinkHandler = null;
    }
    _chapterLinkBookId = null;
  }

  // ── 三页轮播（carousel swipe） ────────────────────────────────────────
  //
  // 三页轮播：track 包含 prev/curr/next 三个 page，translateX(-33.333%) 居中当前页。
  // 滑动时直接 translate track，松手后动画完成 → 重排 DOM → 重置 translateX。
  // 每次路由跳转重新渲染 carousel 以确保数据准确。

  var _carouselBookId = null;
  var _carouselChapterNum = null;
  var _carouselUniqueChapters = null;
  var _carouselPages = null;   // { prev, curr, next } 三个 DOM 元素
  var _carouselTrack = null;
  var _swipeState = null;
  var _swipeHandlers = null;
  var _swipeEl = null;
  var _swipeAnimating = false;  // 动画进行中，拒绝新滑动手势
  var SWIPE_THRESHOLD = 80;
  var SWIPE_MAX_VERTICAL = 60;
  var SWIPE_DURATION = 280;

  // 生成单个 carousel page 的 HTML
  function _renderCarouselPage(chapter, pageId) {
    var html = '<div class="bk-carousel-page" id="carouselPage' + pageId + '">';
    html += '<div class="content" id="carouselContent' + pageId + '">';
    if (chapter) {
      html += renderChapterContent(chapter, true);
    }
    html += '</div></div>';
    return html;
  }

  // 获取指定章节号对应的 chapter 对象
  function _getChapter(uniqueChapters, num) {
    if (!uniqueChapters || num == null) return null;
    for (var i = 0; i < uniqueChapters.length; i++) {
      if (uniqueChapters[i].number === num) return uniqueChapters[i];
    }
    return null;
  }

  // 获取当前章节在列表中的索引
  function _getChapterIndex(uniqueChapters, num) {
    for (var i = 0; i < uniqueChapters.length; i++) {
      if (uniqueChapters[i].number === num) return i;
    }
    return -1;
  }

  // 获取相邻章节号
  function _getAdjacentChapterNum(uniqueChapters, currentNum, direction) {
    var idx = _getChapterIndex(uniqueChapters, currentNum);
    if (idx < 0) return null;
    var targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= uniqueChapters.length) return null;
    return uniqueChapters[targetIdx].number;
  }

  // 填充 carousel page 的内容
  function _fillCarouselPage(pageEl, chapter) {
    var contentEl = pageEl.querySelector('.content');
    if (!contentEl) return;
    if (chapter) {
      // 相邻预览页同样需要 eager 加载，避免滑动时才去 lazy 加载而显示空白
      contentEl.innerHTML = renderChapterContent(chapter, true);
      initPdfPageLazyRender(contentEl);
    } else {
      contentEl.innerHTML = '';
    }
  }

  // 滑动完成后重排页面（先重置位置，再移动 DOM，避免中间帧闪烁）
  function _reorderCarousel(direction) {
    if (!_carouselTrack || !_carouselPages) return;
    var prev = _carouselPages.prev;
    var curr = _carouselPages.curr;
    var next = _carouselPages.next;

    // 先重置 translateX 到居中位置，再移动 DOM，
    // 避免先移 DOM 后设 translate 时浏览器在两步之间产生一帧位置跳动
    var pageW = _carouselTrack.parentElement.offsetWidth;
    _carouselTrack.style.transform = 'translateX(' + (-pageW) + 'px)';

    if (direction === 1) {
      // 下一章：prev=旧curr, curr=旧next, next=新下一章
      _carouselTrack.appendChild(prev);
      _carouselPages = { prev: curr, curr: next, next: prev };
    } else {
      // 上一章：prev=新上一章, curr=旧prev, next=旧curr
      _carouselTrack.insertBefore(next, prev);
      _carouselPages = { prev: next, curr: prev, next: curr };
    }

    // 交换内容容器 ID：新 curr 必须是 chapterContent（承载 padding/字号样式）
    // 注意：初始当前页的 id 是 "chapterContent"（非 carouselContent 前缀），
    // 一旦被移除会拿不回 [id^="carouselContent"]，故统一用 .content 定位容器
    var oldCurrContent = curr.querySelector('.content');
    var newCurrContent = _carouselPages.curr.querySelector('.content');
    if (oldCurrContent) {
      oldCurrContent.removeAttribute('id');
    }
    if (newCurrContent) {
      newCurrContent.id = 'chapterContent';
    }
  }

  // 更新相邻页面内容
  function _updateAdjacentPages(bookId, uniqueChapters, chapterNum) {
    var prevNum = _getAdjacentChapterNum(uniqueChapters, chapterNum, -1);
    var nextNum = _getAdjacentChapterNum(uniqueChapters, chapterNum, 1);
    var prevChapter = prevNum != null ? _getChapter(uniqueChapters, prevNum) : null;
    var nextChapter = nextNum != null ? _getChapter(uniqueChapters, nextNum) : null;
    if (_carouselPages) {
      _fillCarouselPage(_carouselPages.prev, prevChapter);
      _fillCarouselPage(_carouselPages.next, nextChapter);
    }
  }

  function _installCarouselSwipe(bookId, uniqueChapters, chapterNum) {
    _removeSwipeHandler();

    var track = document.querySelector('.bk-carousel-track');
    if (!track) return;
    _carouselTrack = track;
    _carouselBookId = bookId;
    _carouselChapterNum = chapterNum;
    _carouselUniqueChapters = uniqueChapters;

    var pages = track.querySelectorAll('.bk-carousel-page');
    if (pages.length !== 3) return;
    _carouselPages = { prev: pages[0], curr: pages[1], next: pages[2] };

    // 用像素精确设定静止位置，与滑动手势的像素定位保持一致，避免亚像素跳动
    if (track.parentElement) {
      var pageW0 = track.parentElement.offsetWidth || win.innerWidth || 0;
      track.style.transform = 'translateX(' + (-pageW0) + 'px)';
    }

    function onTouchStart(e) {
      if (e.touches.length > 1) return;
      if (_swipeAnimating) return;   // 动画进行中不响应新滑动
      var t = e.touches[0];
      _swipeState = {
        startX: t.clientX,
        startY: t.clientY,
        startTime: Date.now(),
        active: false,
        rejected: false
      };
    }

    function onTouchMove(e) {
      if (!_swipeState || _swipeState.rejected || e.touches.length > 1) return;
      var t = e.touches[0];
      var dx = t.clientX - _swipeState.startX;
      var dy = t.clientY - _swipeState.startY;

      if (!_swipeState.active) {
        if (Math.abs(dy) > SWIPE_MAX_VERTICAL) { _swipeState.rejected = true; return; }
        if (Math.abs(dx) < 15) return;
        if (Math.abs(dx) <= Math.abs(dy)) { _swipeState.rejected = true; return; }
        _swipeState.active = true;
        track.classList.add('bk-swipe-active');
        track.style.transition = 'none';
      }

      // 事件可能已被浏览器锁定为滚动（cancelable=false），此时 preventDefault 无效且会刷警告
      if (e.cancelable) e.preventDefault();
      var pageW = track.parentElement.offsetWidth;
      // 用像素定位，避免 -33.333% 这类重复小数产生亚像素抖动
      var px = dx;

      // 从共享状态读取，而非闭包变量，以便 finish() 更新后立即生效
      var _chNum = _carouselChapterNum;
      var _uChs = _carouselUniqueChapters;
      var isAtStart = _chNum <= (_uChs[0] ? _uChs[0].number : 0);
      var isAtEnd = _chNum >= (_uChs[_uChs.length - 1] ? _uChs[_uChs.length - 1].number : 0);
      if ((dx > 0 && isAtStart) || (dx < 0 && isAtEnd)) {
        px *= 0.25;
      }
      track.style.transform = 'translateX(' + (-pageW + px) + 'px)';
      var pct = pageW ? (px / pageW) : 0; // 当前已滑动的页面比例（-1~1 之间）
      _swipeState.currentPct = pct;
      _swipeState.currentDx = dx;
    }

    function onTouchEnd() {
      if (!_swipeState) return;
      var state = _swipeState;
      _swipeState = null;

      if (!state.active) return;

      track.classList.remove('bk-swipe-active');
      var dx = state.currentDx || 0;
      var pct = state.currentPct || 0;
      var elapsed = Date.now() - state.startTime;
      var velocity = Math.abs(dx) / elapsed;
      var pageW = track.parentElement.offsetWidth;

      var shouldNavigate = Math.abs(dx) > SWIPE_THRESHOLD || (velocity > 0.4 && Math.abs(dx) > 30);
      var direction = dx > 0 ? -1 : 1; // -1=上一章, 1=下一章
      // 从共享状态读取，而非闭包变量
      var targetNum = _getAdjacentChapterNum(_carouselUniqueChapters, _carouselChapterNum, direction);

      if (shouldNavigate && targetNum != null) {
        _swipeAnimating = true;  // 加锁：动画期间拒绝新滑动手势
        // 动画滑到相邻页（用像素定位，避免亚像素抖动）
        var targetPx = direction === -1 ? 0 : -2 * pageW;
        track.style.transition = 'transform ' + SWIPE_DURATION + 'ms ease-out';
        track.style.transform = 'translateX(' + targetPx + 'px)';

        // 用 transitionend 在动画恰好结束时重排，避免 setTimeout 与动画不同步造成跳帧抖动
        // 注意：transitionend 会冒泡，子元素（.scripture-ref / .bk-highlight 等）自身的过渡
        // 也会冒泡到 track 并误触发 finish()，导致在滑动动画未完成时就重排/复位。
        // 因此必须过滤：仅当事件目标是 track 自身且属性为 transform 时才执行。
        var finished = false;
        function finish(e) {
          if (finished) return;
          // 由 transitionend 触发时，必须确认是 track 自己的 transform 过渡，忽略子元素冒泡
          if (e && (e.target !== track || e.propertyName !== 'transform')) return;
          finished = true;
          track.removeEventListener('transitionend', finish);
          track.style.transition = 'none';
          _reorderCarousel(direction);

          // 更新共享状态（事件处理器从 _carouselXxx 读取，无需重新绑定）
          _carouselChapterNum = targetNum;

          // 新 curr 已在之前的 _fillCarouselPage / 初始渲染中包含正确的相邻章节内容，
          // 无需重新 innerHTML 替换（这会导致内容闪烁和 justify-content 重新布局的跳动）。
          // 但仍需触发依赖 DOM 的懒加载和初始化：
          var newChapter = _getChapter(_carouselUniqueChapters, targetNum);
          var contentEl = document.getElementById('chapterContent');
          if (contentEl) {
            initPdfPageLazyRender(contentEl);
          }
          // 更新相邻页面（新的 prev/next 需要填充新章节的前后内容）
          _updateAdjacentPages(_carouselBookId, _carouselUniqueChapters, targetNum);

          // 更新 URL（不触发 router 重新渲染）
          // 用 try/finally 保证 _carouselNavigating 一定复位，避免 navigate 抛异常时
          // 标志位卡死为 true，导致后续 renderReadingView 全部 early-return、carousel 被冻结
          _carouselNavigating = true;
          try {
            if (win.BKRouter) {
              win.BKRouter.navigate(_carouselBookId + '/' + targetNum);
            } else {
              win.location.hash = '#/' + _carouselBookId + '/' + targetNum;
            }
          } finally {
            _carouselNavigating = false;
          }

          // 更新缓存的标题和进度
          BKRenderer._currentChapterTitle = newChapter ? (newChapter.title || '') : '';
          saveReadingProgress(_carouselBookId, targetNum);
          document.title = (BKRenderer._currentBookTitle || '') + ' - ' + (newChapter ? (newChapter.title || '第' + targetNum + '章') : '');

          // 更新进度条
          var progressBar = document.querySelector('.bk-reading-progress-bar');
          if (progressBar) {
            var totalChapters = _carouselUniqueChapters.length;
            var progressPct = totalChapters > 0 ? Math.round(targetNum / totalChapters * 100) : 0;
            progressBar.style.width = progressPct + '%';
          }

          // 保存"被滑走"的旧章节滚动位置（reorder 后旧当前页已变为 prev）
          if (_carouselPages && _carouselPages.prev) {
            try { localStorage.setItem('bk_scroll:' + _scrollPageKey, String(_carouselPages.prev.scrollTop || 0)); } catch(e) {}
          }

          // 切到新章节：滚动容器复位到顶部（页内滚动，不再依赖 window）
          var _sc = _getScrollContainer();
          if (_sc === win) win.scrollTo(0, 0);
          else _sc.scrollTop = 0;

          // 重新初始化依赖 DOM 的功能
          if (win.BKHighlight && win.BKHighlight.rendoHighlights) win.BKHighlight.rendoHighlights();
          if (win.BKScripturePopup && win.BKScripturePopup.init) win.BKScripturePopup.init();

          // 滚动监听改挂到新的当前页（reorder 后 curr 已是新章节元素），
          // 并以新章节 pageKey 记录滚动位置
          _scrollPageKey = _carouselBookId + '/' + targetNum;
          if (_scrollSaveHandler) {
            var _oldT = _scrollTarget || win;
            _oldT.removeEventListener('scroll', _scrollSaveHandler);
            _scrollTarget = _getScrollContainer();
            _scrollTarget.addEventListener('scroll', _scrollSaveHandler, { passive: true });
          }

          // 不再调用 _installCarouselSwipe() 重新绑定事件（这会产生事件真空期，
          // 导致快速连续滑动时手势丢失）。共享状态 _carouselXxx 已在上方更新，
          // 事件处理器直接从共享状态读取，无需重建闭包。

          _swipeAnimating = false;  // 解锁：允许下一次滑动手势
        }
        track.addEventListener('transitionend', finish);
        setTimeout(finish, SWIPE_DURATION + 80); // 兜底：防止 transitionend 未触发
      } else {
        // 回弹
        track.style.transition = 'transform ' + (SWIPE_DURATION * 0.6) + 'ms ease-out';
        track.style.transform = 'translateX(' + (-pageW) + 'px)';
        setTimeout(function () {
          track.style.transition = 'none';
        }, SWIPE_DURATION * 0.6);
      }
    }

    _swipeHandlers = { touchstart: onTouchStart, touchmove: onTouchMove, touchend: onTouchEnd };
    var readingView = document.getElementById('readingView');
    if (readingView) {
      readingView.addEventListener('touchstart', onTouchStart, { passive: true });
      readingView.addEventListener('touchmove', onTouchMove, { passive: false });
      readingView.addEventListener('touchend', onTouchEnd, { passive: true });
      _swipeEl = readingView;
    }
  }

  function _removeSwipeHandler() {
    if (_swipeHandlers && _swipeEl) {
      _swipeEl.removeEventListener('touchstart', _swipeHandlers.touchstart);
      _swipeEl.removeEventListener('touchmove', _swipeHandlers.touchmove);
      _swipeEl.removeEventListener('touchend', _swipeHandlers.touchend);
      _swipeEl.classList.remove('bk-swipe-active');
      _swipeEl.style.transition = '';
      _swipeEl.style.transform = '';
    }
    _swipeHandlers = null;
    _swipeState = null;
    _swipeEl = null;
  }

  // 防止 carousel 内部导航触发 router 重复渲染
  var _carouselNavigating = false;

  // ── zl-html 首页渲染辅助函数 ────────────────────────────────────────

  /**
   * 检查书籍是否已下载（同步，基于缓存的 ID 列表）
   */
  function _isBookDownloaded(bookId) {
    return _zlDownloadedIds.indexOf(bookId) !== -1;
  }

  /**
   * 系列标题显示替换（兜底：CWWL → 李文集）
   */
  function _displaySeriesTitle(title) {
    if (title === 'CWWL') return '李文集';
    return title;
  }

  /**
   * 根据 series ID 获取系列标题
   */
  function _getSeriesTitle(seriesId) {
    for (var i = 0; i < _zlSeries.length; i++) {
      if (_zlSeries[i].id === seriesId) return _displaySeriesTitle(_zlSeries[i].title);
    }
    return seriesId || '';
  }

  /**
   * 渲染 zl-html 首页完整内容
   */
  /**
   * 取续读列表（有阅读进度的书），按 bk_last_read 置顶、其余按 progress 降序。
   * @param {number} limit 截取数量；<=0 表示不限制（返回全部）
   * @returns {Array<{book, progress, chapterCount, progressPct, chapterTitle}>}
   */
  function _getContinueList(limit) {
    limit = (typeof limit === 'number' && limit > 0) ? limit : 0;

    var items = [];
    for (var i = 0; i < _zlBooks.length; i++) {
      var b = _zlBooks[i];
      var prog = getReadingProgress(b.id);
      if (prog > 0) {
        var chapterCount = b.chapter_count || 0;
        var progressPct = (chapterCount > 0) ? Math.round(prog / chapterCount * 100) : 0;
        items.push({
          book: b,
          progress: prog,
          chapterCount: chapterCount,
          progressPct: progressPct,
          chapterTitle: ''
        });
      }
    }

    // 排序：bk_last_read 置顶，其余按 progress 降序
    var lastId = '';
    try { lastId = localStorage.getItem('bk_last_read') || ''; } catch (e) {}
    items.sort(function (a, b) {
      if (a.book.id === lastId) return -1;
      if (b.book.id === lastId) return 1;
      return b.progress - a.progress;
    });

    if (limit > 0 && items.length > limit) items = items.slice(0, limit);
    return items;
  }

  /**
   * 渲染「继续阅读」列表到 #bkContinueListAnchor。
   * @param {Object} opts { expanded: boolean } 展开后去掉折叠上限并隐藏「查看全部」。
   */
  function _renderContinueList(homeView, opts) {
    opts = opts || {};
    var anchor = homeView.querySelector('#bkContinueListAnchor');
    if (!anchor) return;

    var expanded = !!opts.expanded;
    var all = _getContinueList(0);

    // 无阅读历史 → 引导卡（整卡点击进入书城）
    if (all.length === 0) {
      anchor.innerHTML =
        '<a class="bk-continue-card bk-continue-welcome" href="#/city">' +
          '<div class="bk-continue-info">' +
            '<div class="bk-continue-title">去书城开始阅读</div>' +
            '<div class="bk-continue-chapter">' + _zlBooks.length + ' 本书籍等你探索</div>' +
          '</div>' +
        '</a>';
      var va = homeView.querySelector('#bk-continue-viewall');
      if (va) va.style.display = 'none';
      return;
    }

    var list = expanded ? all : all.slice(0, 6);

    // 「查看全部」按钮：展开后或不足一屏时隐藏
    var vaBtn = homeView.querySelector('#bk-continue-viewall');
    if (vaBtn) {
      vaBtn.style.display = (expanded || all.length <= 6) ? 'none' : '';
    }

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var b = it.book;
      html += '<a class="bk-continue-card" href="#/' + escAttr(b.id) + '/' + (it.progress || 1) + '">';
      html += '<div class="bk-continue-cover">' + _coverHTML(b, { size: 'sm' }) + '</div>';
      html += '<div class="bk-continue-info">';
      html += '<div class="bk-continue-title">' + escText(_cleanBookTitle(b.title)) + '</div>';
      html += '<div class="bk-continue-chapter">读到第' + it.progress + '章 / 共' + it.chapterCount + '章</div>';
      html += '</div>';
      html += '<div class="reading-progress"><div class="reading-progress-fill" style="width:' + it.progressPct + '%"></div></div>';
      html += '<div class="bk-continue-arrow">›</div>';
      html += '</a>';
    }
    anchor.innerHTML = html;
  }
  // 系列合并：书籍数 < MIN_SERIES_BOOKS 的系列归入拾遗
  var _MIN_SERIES_BOOKS = 3;
  var _PICKUP_SERIES_ID = 'sy_auto';
  var _PROTECTED_SERIES = { 'books': true, 'sy_auto': true }; // 不参与合并的系列

  function _getMergedSeries() {
    // 计算每个系列的真实书籍数
    var seriesBookCount = {};
    for (var i = 0; i < _zlBooks.length; i++) {
      var sid = _zlBooks[i].series;
      seriesBookCount[sid] = (seriesBookCount[sid] || 0) + 1;
    }

    var visibleSeries = [];
    var mergedCount = 0; // 被合并掉的系列贡献给拾遗的额外书籍数

    var mergedIds = {};  // 被合并掉的系列ID集合

    for (var i = 0; i < _zlSeries.length; i++) {
      var s = _zlSeries[i];
      var count = seriesBookCount[s.id] || 0;
      if (count < _MIN_SERIES_BOOKS && !_PROTECTED_SERIES[s.id]) {
        mergedCount += count;
        mergedIds[s.id] = true;
      } else {
        visibleSeries.push(s);
      }
    }

    // 更新拾遗系列的显示计数
    if (mergedCount > 0) {
      for (var i = 0; i < visibleSeries.length; i++) {
        if (visibleSeries[i].id === _PICKUP_SERIES_ID) {
          visibleSeries[i] = {
            id: visibleSeries[i].id,
            title: visibleSeries[i].title,
            count: (seriesBookCount[_PICKUP_SERIES_ID] || 0) + mergedCount
          };
          break;
        }
      }
    }

    return { series: visibleSeries, bookCount: seriesBookCount, mergedCount: mergedCount, mergedIds: mergedIds };
  }
  /**
   * 构建单个书籍卡片 HTML（纯函数，消除重复代码）
   */
  function _buildBookCard(book, opts) {
    opts = opts || {};
    // readMarker：书城纯信息卡启用；为卡片追加一个角落小已读标记（极简 sage 对勾）。
    var readMarker = (opts.readMarker === true);
    var isRead = (win.BKShelf && win.BKShelf.isRead) ? win.BKShelf.isRead(book.id) : false;
    var chapterCount = book.chapter_count || 0;
    // 纯书籍信息卡（书城三级）不加 is-read 类，避免 sage 内描边等已读状态视觉泄漏到书城。
    // cityBook：书城三级「封面海报 + 下方精简信息条」卡 —— 封面(.bk-cover) 作海报，
    // 下方 .book-caption 显示书名 + 书号(可选) + 章节数；不渲染完整 .book-info（无徽标/进度/标记按钮）。
    var cityBook = (opts.cityBook === true);

    var html = '<div class="book-card zl-book-card' + (cityBook ? ' is-city-book' : '') + '" data-book-id="' + escAttr(book.id) + '" data-series="' + escAttr(book.series) + '" style="--series-color:' + _getSeriesColor(book.series) + '">';
    html += '<div class="book-card-wrapper">';
    html += '<div class="book-link" data-book-id="' + escAttr(book.id) + '" data-series="' + escAttr(book.series) + '" role="button" tabindex="0">';
    // 仅书架/搜索等非书城卡片用固定 60px 小封面(size:'md')；书城 L3 海报由 .bk-city-book-grid 专属规则撑满，md 会被覆盖成死 class，故去掉
    var coverSize = cityBook ? null : 'md';
    html += _coverHTML(book, { size: coverSize, seriesTitle: _getSeriesTitle(book.series) });
    if (cityBook) {
      // 书城三级：封面海报 + 下方精简信息条（书名 + 书号(可选) + 章节数）
      var bookNo = _extractBookNo(book.title);
      html += '<div class="book-caption">';
      html += '<div class="book-caption-title">' + escText(_cleanBookTitle(book.title)) + '</div>';
      html += '<div class="book-caption-meta">';
      if (bookNo) {
        html += '<span class="book-caption-no">书号 ' + escText(bookNo) + '</span>';
      }
      html += '<span class="book-caption-chapters">共 ' + chapterCount + ' 章</span>';
      var srcBadge = _sourceBadgeHTML(book);
      if (srcBadge) html += srcBadge;
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';
    // 书城小已读标记（readMarker：仅书城纯信息卡启用）：卡片角落极简 sage 对勾，
    // 默认隐藏，已读时加 is-read-mark 显现（由 bk-shelf-changed 监听就地切换显隐）。
    if (readMarker) {
      html += '<span class="bk-city-read-marker' + (isRead ? ' is-read-mark' : '') + '" aria-label="已读" role="img">✓</span>';
    }
    html += '</div>';
    return html;
  }

  /**
   * 处理书籍卡片点击：已下载则导航，未下载则先下载
   */
  function _handleBookClick(bookId, series, cardEl) {
    if (_isBookDownloaded(bookId)) {
      // 已下载，检查是否有上次阅读进度
      var progress = getReadingProgress(bookId);
      if (progress > 0 && win.BKRouter) {
        win.BKRouter.navigate(bookId + '/' + progress);
      } else if (win.BKRouter) {
        win.BKRouter.navigate(bookId);
      }
      return;
    }

    // 未下载，尝试下载后打开
    if (!_zlDmReady || !win.DataManager) {
      // DataManager 不可用，直接导航
      if (win.BKRouter) win.BKRouter.navigate(bookId);
      return;
    }

    // 显示下载中状态
    var cardEl2 = cardEl ? cardEl.closest('.zl-book-card') : null;
    var iconEl = cardEl ? cardEl.querySelector('.cache-status') : null;
    if (iconEl) { iconEl.textContent = '⏳'; iconEl.style.color = '#ff9800'; }
    if (cardEl2) cardEl2.setAttribute('data-downloading', 'true');

    win.DataManager.downloadBook(bookId, series)
      .then(function () {
        // 下载成功，更新状态
        _zlDownloadedIds.push(bookId);
        if (iconEl) { iconEl.textContent = '✓'; iconEl.style.color = 'var(--brand)'; }
        if (cardEl2) cardEl2.removeAttribute('data-downloading');
        // 导航到书籍
        if (win.BKRouter) win.BKRouter.navigate(bookId);
      })
      .catch(function (err) {
        console.error('[Renderer] 书籍下载失败:', err);
        if (iconEl) { iconEl.textContent = '✗'; iconEl.style.color = '#f44336'; }
        if (cardEl2) cardEl2.removeAttribute('data-downloading');
        setTimeout(function () { if (iconEl) { iconEl.textContent = '☁'; iconEl.style.color = 'var(--text-muted)'; } }, 2000);
      });
  }

  /**
   * 重新同步 WebDAV 书籍：禁用按钮 → 调用 WebDavManager.resyncBook → toast 反馈 → 复位按钮。
   * 失败文案优先取错误的 hint，其次 message（与 WebDavManager.wrapError 字段约定一致）。
   *
   * @param {HTMLElement} resyncBtn 触发按钮（.bk-resync-btn[data-book-id]）
   * @param {Object} book 书籍对象（须含 source.type==='webdav'）
   */
  function _doResync(resyncBtn, book) {
    if (!resyncBtn || !book || !book.source || book.source.type !== 'webdav') return;
    var mgr = win.WebDavManager;
    if (!mgr || typeof mgr.resyncBook !== 'function') {
      _toast('当前环境不支持重新同步');
      return;
    }
    // 防重复点击
    resyncBtn.disabled = true;
    resyncBtn.classList.add('is-loading');
    mgr.resyncBook(book)
      .then(function () {
        _toast('重新同步成功');
      })
      .catch(function (err) {
        var hint = (err && (err.hint || err.message)) ? (err.hint || err.message) : '重新同步失败';
        _toast(hint);
      })
      .finally(function () {
        resyncBtn.disabled = false;
        resyncBtn.classList.remove('is-loading');
      });
  }

  /**
   * 书卡点击委托：捕获「重新同步」按钮（.bk-resync-btn[data-book-id]）。
   * 命中后阻止默认/冒泡，避免触发「打开书」导航；查书后调用 _doResync。
   */
  function _onResyncClick(e) {
    if (!e || !e.target || !e.target.closest) return;
    var resyncBtn = e.target.closest('.bk-resync-btn');
    if (!resyncBtn) return;
    // 命中重同步按钮：阻断后续「打开书」导航（按钮为 .book-link 的兄弟节点，亦显式 stop）
    e.preventDefault();
    e.stopPropagation();

    var bookId = resyncBtn.getAttribute('data-book-id');
    if (!bookId) return;
    var book = _findBookById(bookId);
    if (!book) {
      _toast('未找到对应的书籍');
      return;
    }
    // 防御：按钮仅应出现在 webdav 源书卡上，理论上不会进入此分支
    if (!book.source || book.source.type !== 'webdav') return;
    _doResync(resyncBtn, book);
  }

  // 重同步点击委托是否已绑定（document 级，仅一次；覆盖书架 / 书城任意容器渲染的书卡）
  var _resyncHandlerBound = false;
  function _bindResyncHandler() {
    if (_resyncHandlerBound) return;
    _resyncHandlerBound = true;
    document.addEventListener('click', _onResyncClick);
  }

  /**
   * 切换下载面板显示/隐藏
   */
  function _toggleDownloadPanel(open) {
    _dlPanelOpen = open;
    var panel = document.getElementById('downloadPanel');
    var overlay = document.getElementById('dlOverlay');
    if (panel) panel.className = 'download-panel' + (open ? ' open' : '');
    if (overlay) overlay.className = 'download-panel-overlay' + (open ? ' open' : '');
  }

  /**
   * 确保下载管理面板已构建（全局持久元素，独立于当前页面视图）。
   * 面板挂载到 document.body，避免被书架/我的 等页面切换隐藏（旧实现挂在
   * #homeView 内，切到「我的」设置页时 #homeView 被隐藏，导致按钮点击无反应）。
   */
  function _ensureDownloadPanel() {
    if (document.getElementById('downloadPanel')) return;
    var holder = document.createElement('div');
    holder.innerHTML =
      '<div class="download-panel" id="downloadPanel">' +
        '<div class="download-panel-header">' +
          '<span class="download-panel-title">📥 下载管理</span>' +
          '<button class="download-panel-close" id="dlPanelClose" aria-label="关闭">✕</button>' +
        '</div>' +
        '<div class="dl-overview">' +
          '<div class="dl-ov-item"><span class="dl-ov-num" id="dlOvSeries">—</span><span class="dl-ov-label">系列</span></div>' +
          '<div class="dl-ov-item"><span class="dl-ov-num" id="dlOvCached">—</span><span class="dl-ov-label">已缓存</span></div>' +
          '<div class="dl-ov-item"><span class="dl-ov-num" id="dlOvSize">—</span><span class="dl-ov-label">占用</span></div>' +
        '</div>' +
        '<div class="download-resource-summary" id="dlResourceSummary">资源统计加载中...</div>' +
        '<div class="download-storage-info" id="dlStorageInfo">存储统计加载中...</div>' +
        '<div class="download-progress" id="dlProgressWrap" style="display:none">' +
          '<div class="download-progress-bar" id="dlProgressBar" style="width:0%"></div>' +
        '</div>' +
        '<div class="download-progress-text" id="dlProgressText" style="display:none"></div>' +
        '<div class="download-controls" id="dlControls" style="display:none">' +
          '<button class="dl-ctrl-btn" id="dlPauseBtn">暂停</button>' +
          '<button class="dl-ctrl-btn" id="dlCancelBtn">取消</button>' +
        '</div>' +
        '<div class="download-series-list" id="dlSeriesList"></div>' +
        '<button class="download-all-btn" id="dlAllBtn">全部下载</button>' +
      '</div>' +
      '<div class="download-panel-overlay" id="dlOverlay"></div>';
    while (holder.firstChild) document.body.appendChild(holder.firstChild);

    // 关闭按钮
    var dlClose = document.getElementById('dlPanelClose');
    if (dlClose) dlClose.addEventListener('click', function () { _toggleDownloadPanel(false); });
    // 遮罩：点击关闭
    var dlOverlay = document.getElementById('dlOverlay');
    if (dlOverlay) dlOverlay.addEventListener('click', function () { _toggleDownloadPanel(false); });
    // 全部下载
    var dlAllBtn = document.getElementById('dlAllBtn');
    if (dlAllBtn) dlAllBtn.addEventListener('click', function () { _startAllDownload(); });
    // 暂停 / 恢复
    var dlPause = document.getElementById('dlPauseBtn');
    if (dlPause) dlPause.addEventListener('click', function () {
      if (!win.DataManager) return;
      var status = win.DataManager.getDownloadStatus();
      if (status && status.isPaused) { win.DataManager.resumeDownload(); dlPause.textContent = '暂停'; }
      else { win.DataManager.pauseDownload(); dlPause.textContent = '恢复'; }
    });
    // 取消
    var dlCancel = document.getElementById('dlCancelBtn');
    if (dlCancel) dlCancel.addEventListener('click', function () {
      if (win.DataManager) win.DataManager.cancelDownload();
      _stopProgressPolling();
    });
  }

  /**
   * 渲染下载面板中的系列列表（每次打开前刷新，保证数据已就绪）。
   * 每行含缓存状态（.series-cache-info[data-series]，供 _refreshSeriesCacheStatus 更新）
   * 与「下载」按钮（触发 _startSeriesDownload）。
   */
  function _renderDlSeriesList() {
    var list = document.getElementById('dlSeriesList');
    if (!list) return;
    var series = (_getMergedSeries().series || []);
    var html = '';
    for (var i = 0; i < series.length; i++) {
      var s = series[i];
      html += '<div class="download-series-row">';
      html += '<span class="download-series-name">' + escText(s.title) + (s.count != null ? ' (' + s.count + '本)' : '') + '</span>';
      html += '<span class="series-cache-info" data-series="' + escAttr(s.id) + '">—</span>';
      html += '<button class="download-series-btn" data-series="' + escAttr(s.id) + '">下载</button>';
      html += '</div>';
    }
    list.innerHTML = html;
    var btns = list.querySelectorAll('.download-series-btn');
    for (var k = 0; k < btns.length; k++) {
      btns[k].addEventListener('click', function () {
        var seriesId = this.getAttribute('data-series');
        _startSeriesDownload(seriesId);
      });
    }
  }

  /**
   * 刷新存储统计信息
   */
  function _refreshStorageStats() {
    if (!_zlDmReady || !win.DataManager) return;
    // 更新资源摘要（checkResources）
    var resEl = document.getElementById('dlResourceSummary');
    var ovCached = document.getElementById('dlOvCached');
    var ovSize = document.getElementById('dlOvSize');
    if (resEl && win.DataManager.checkResources) {
      win.DataManager.checkResources().then(function (res) {
        var cached = res.downloaded || 0;
        var total = res.total || _zlBooks.length || 0;
        var sizeMB = res.estimatedTotalSize
          ? (res.estimatedTotalSize / 1024 / 1024).toFixed(1)
          : '未知';
        resEl.textContent = '已缓存 ' + cached + ' / 总共 ' + total + ' 本书（约 ' + sizeMB + ' MB）';
        if (ovCached) ovCached.textContent = cached + '/' + total;
        if (ovSize) ovSize.textContent = sizeMB + ' MB';
      }).catch(function () {
        resEl.textContent = '资源统计获取失败';
      });
    }
    // 更新存储统计（getStorageStats）
    var el = document.getElementById('dlStorageInfo');
    if (el) {
      win.DataManager.getStorageStats().then(function (stats) {
        el.textContent = '已下载 ' + stats.downloadedCount + ' 本书，占用 ' + stats.totalSizeFormatted;
      }).catch(function () {
        el.textContent = '存储统计获取失败';
      });
    }
    // 概览卡：系列数
    var ovSeries = document.getElementById('dlOvSeries');
    if (ovSeries) {
      try { ovSeries.textContent = (_getMergedSeries().series || []).length; } catch (e) {}
    }
    // 更新系列缓存进度
    _refreshSeriesCacheStatus();
  }

  /**
   * 刷新下载面板中各系列的缓存进度显示
   */
  function _refreshSeriesCacheStatus() {
    if (!_zlDmReady || !win.DataManager || !win.DataManager.getBooksBySeriesStatus) return;
    win.DataManager.getBooksBySeriesStatus().then(function (result) {
      var seriesArr = (result && result.series) || [];
      for (var i = 0; i < seriesArr.length; i++) {
        var s = seriesArr[i];
        var infoEls = document.querySelectorAll('.series-cache-info[data-series="' + s.id + '"]');
        for (var j = 0; j < infoEls.length; j++) {
          infoEls[j].textContent = s.cached + '/' + s.total + ' 已缓存';
          infoEls[j].style.color = s.cached === s.total && s.total > 0 ? 'var(--brand)' : 'var(--text-muted)';
        }
      }
    }).catch(function () {});
  }

  /**
   * 开始下载某系列
   */
  function _startSeriesDownload(seriesId) {
    if (!_zlDmReady || !win.DataManager) return;
    _showDownloadProgress();
    var seriesTitle = _getSeriesTitle(seriesId);

    win.DataManager.downloadSeries(seriesId, function (completed, total, currentTitle) {
      _updateDownloadProgressUI(completed, total, currentTitle);
    }).then(function (result) {
      _onDownloadComplete(result, seriesTitle);
    }).catch(function (err) {
      _onDownloadError(err);
    });
  }

  /**
   * 开始下载全部
   */
  function _startAllDownload() {
    if (!_zlDmReady || !win.DataManager) return;
    _showDownloadProgress();

    win.DataManager.downloadAll(function (completed, total, currentTitle) {
      _updateDownloadProgressUI(completed, total, currentTitle);
    }).then(function (result) {
      _onDownloadComplete(result, '全部');
    }).catch(function (err) {
      _onDownloadError(err);
    });
  }

  /**
   * 显示下载进度区域
   */
  function _showDownloadProgress() {
    var wrap = document.getElementById('dlProgressWrap');
    var text = document.getElementById('dlProgressText');
    var controls = document.getElementById('dlControls');
    if (wrap) wrap.style.display = '';
    if (text) { text.style.display = ''; text.textContent = '准备中...'; }
    if (controls) controls.style.display = '';
    // 重置暂停按钮
    var pauseBtn = document.getElementById('dlPauseBtn');
    if (pauseBtn) pauseBtn.textContent = '暂停';
    // 启动进度轮询
    _startProgressPolling();
  }

  /**
   * 更新下载进度 UI
   */
  function _updateDownloadProgressUI(completed, total, currentTitle) {
    var bar = document.getElementById('dlProgressBar');
    var text = document.getElementById('dlProgressText');
    if (total > 0 && bar) {
      bar.style.width = Math.round(completed / total * 100) + '%';
    }
    if (text) {
      text.textContent = completed + ' / ' + total + (currentTitle ? ' — ' + currentTitle : '');
    }
  }

  /**
   * 下载完成处理
   */
  function _onDownloadComplete(result, label) {
    _stopProgressPolling();
    var bar = document.getElementById('dlProgressBar');
    var text = document.getElementById('dlProgressText');
    var controls = document.getElementById('dlControls');
    if (bar) bar.style.width = '100%';
    if (text) {
      var msg = label + ' 下载完成: 成功 ' + result.success + ' 本';
      if (result.failed) {
        msg += '，失败 ' + result.failed + ' 本';
        var names = result.failedBookNames || [];
        if (names.length) {
          var shown = names.slice(0, 3).join('、');
          if (names.length > 3) shown += ' 等 ' + names.length + ' 本';
          msg += '（' + shown + '）';
        }
      }
      text.textContent = msg;
    }
    if (controls) controls.style.display = 'none';
    // 刷新已下载列表和书籍网格
    _refreshAfterDownload();
  }

  /**
   * 下载错误处理
   */
  function _onDownloadError(err) {
    _stopProgressPolling();
    var text = document.getElementById('dlProgressText');
    var controls = document.getElementById('dlControls');
    if (text) text.textContent = '下载出错: ' + (err.message || err);
    if (controls) controls.style.display = 'none';
  }

  /**
   * 启动进度轮询（作为 onProgress 回调的补充）
   */
  function _startProgressPolling() {
    _stopProgressPolling();
    _dlProgressTimer = setInterval(function () {
      if (!win.DataManager) return;
      var status = win.DataManager.getDownloadStatus();
      if (!status.isDownloading) {
        _stopProgressPolling();
        return;
      }
      _updateDownloadProgressUI(status.progress.completed, status.progress.total, status.progress.currentTitle);
    }, 1000);
  }

  /**
   * 停止进度轮询
   */
  function _stopProgressPolling() {
    if (_dlProgressTimer) {
      clearInterval(_dlProgressTimer);
      _dlProgressTimer = null;
    }
  }

  /**
   * 下载完成后刷新书籍网格和统计
   */
  function _refreshAfterDownload() {
    if (!_zlDmReady || !win.DataManager) return;
    win.DataManager.getDownloadedBookIds().then(function (ids) {
      _zlDownloadedIds = ids;
      // 刷新书籍网格中的下载图标
      var homeView = document.getElementById('homeView');
      if (homeView) {
        var cards = homeView.querySelectorAll('.zl-book-card');
        for (var i = 0; i < cards.length; i++) {
          var bookId = cards[i].getAttribute('data-book-id');
          var isDown = _isBookDownloaded(bookId);
          var statusEl = cards[i].querySelector('.cache-status');
          if (statusEl) {
            statusEl.textContent = isDown ? '✓' : '☁';
            statusEl.style.color = isDown ? 'var(--brand)' : 'var(--text-muted)';
          }
        }
      }
      _refreshStorageStats();
    });
  }

  /**
   * 合并导入书籍到首页列表（抽取为公共辅助，供 renderHome 的 then/catch 共用）
   */
  function _mergeImportedBooks() {
    if (!win.ImportManager || !win.ImportManager.getImportedBooks) {
      return Promise.resolve();
    }
    return Promise.resolve().then(function () {
      return win.ImportManager.getImportedBooks();
    }).then(function (imported) {
      for (var ii = 0; ii < imported.length; ii++) {
        var ib = imported[ii];
        ib.series = 'imported';
        // 幂等：避免重复渲染（导入后调用 renderHome 刷新书城时不产生重复卡片）
        var inBooks = false;
        for (var bi = 0; bi < _zlBooks.length; bi++) {
          if (_zlBooks[bi].id === ib.id) { inBooks = true; break; }
        }
        if (!inBooks) _zlBooks.push(ib);
        var inDl = false;
        for (var di = 0; di < _zlDownloadedIds.length; di++) {
          if (_zlDownloadedIds[di] === ib.id) { inDl = true; break; }
        }
        if (!inDl) _zlDownloadedIds.push(ib.id);
        if (!win.__bkBooks) win.__bkBooks = [];
        var exists = false;
        for (var bj = 0; bj < win.__bkBooks.length; bj++) {
          if (win.__bkBooks[bj].id === ib.id) { exists = true; break; }
        }
        if (!exists) win.__bkBooks.push(ib);
      }
    });
  }

  // ── 目录 Drawer ────────────────────────────────────────────────────────

  /**
   * 打开目录 Drawer，填充章节列表
   */
  /**
   * 填充 TOC 内容（标题 + 章节列表 + 滚动当前章），不 toggle 抽屉、不 push backStack。
   * 抽屉模式（手机）和双栏模式（平板/横屏）共用此函数。
   * @param {string} bookId
   * @returns {Promise} loadBook 完成后 resolve
   */
  function _fillTocDrawer(bookId) {
    var body = document.getElementById('bkTocDrawerBody');
    var titlesEl = document.getElementById('bkTocDrawerTitles');
    if (!body) return Promise.resolve();

    // 显示加载状态
    body.innerHTML = '<div class="bk-loading" style="padding:32px 0"><div class="bk-spinner"></div><div>加载中...</div></div>';

    return loadBook(bookId).then(function (book) {
      var chapters = _getUniqueChapters(book.chapters || []);
      var progress = getReadingProgress(bookId);

      // 填充标题
      if (titlesEl) {
        titlesEl.innerHTML = '<div class="bk-toc-drawer-book-title">' + escText(book.title) + '</div>' +
          (book.author ? '<div class="bk-toc-drawer-author">' + escText(book.author) + '</div>' : '');
      }

      // 填充章节列表
      var html = '<div class="bk-toc-chapter-list">';
      for (var i = 0; i < chapters.length; i++) {
        var ch = chapters[i];
        var chNum = ch.number || (i + 1);
        var isCurrent = chNum === progress;
        html += '<a class="bk-toc-chapter-item' + (isCurrent ? ' bk-toc-current' : '') + '" href="#/' + escAttr(bookId) + '/' + chNum + '" data-toc-nav="1">';
        html += '<span class="bk-toc-chapter-num">' + chNum + '</span>';
        html += '<span class="bk-toc-chapter-title">' + escText(ch.title || '第' + chNum + '章') + '</span>';
        if (isCurrent) html += '<span class="bk-toc-chapter-badge">在读</span>';
        html += '</a>';
      }
      html += '</div>';
      body.innerHTML = html;

      // 滚动到当前章节
      var currentItem = body.querySelector('.bk-toc-current');
      if (currentItem) {
        setTimeout(function() {
          currentItem.scrollIntoView({ block: 'center', behavior: 'auto' });
        }, 50);
      }
    }).catch(function (err) {
      body.innerHTML = '<div class="bk-error" style="padding:24px 0"><div class="bk-error-icon">⚠️</div><div class="bk-error-text">加载失败</div></div>';
    });
  }

  function _openTocDrawer(bookId) {
    var drawer = document.getElementById('bkTocDrawer');
    if (!drawer) return;
    _toggleTocDrawer(true);
    _fillTocDrawer(bookId);
  }

  /**
   * 双栏阅读模式（平板/横屏）：TOC 常驻左栏。
   * 触发：min-width:768px（平板/宽屏）。手机横屏(max-height:500px)不触发。
   * 进入阅读视图时调用；退出阅读视图（renderHome/renderChapterList）调 _exitSplitMode。
   */
  var _splitMedia = null;
  var _splitBookId = null;
  function _maybeEnterSplitMode(bookId) {
    _splitBookId = bookId;
    if (!win.matchMedia) return;
    _splitMedia = win.matchMedia('(min-width: 768px)');
    _applySplitMode(_splitMedia.matches);
    if (_splitMedia.addEventListener) {
      _splitMedia.addEventListener('change', _onSplitMediaChange);
    } else if (_splitMedia.addListener) {
      _splitMedia.addListener(_onSplitMediaChange);
    }
  }
  function _onSplitMediaChange(e) {
    _applySplitMode(e.matches);
  }
  function _applySplitMode(shouldSplit) {
    if (shouldSplit) {
      document.body.classList.add('bk-split-mode');
      if (_splitBookId) _fillTocDrawer(_splitBookId);
    } else {
      document.body.classList.remove('bk-split-mode');
    }
  }
  function _exitSplitMode() {
    document.body.classList.remove('bk-split-mode');
    if (_splitMedia) {
      if (_splitMedia.removeEventListener) {
        _splitMedia.removeEventListener('change', _onSplitMediaChange);
      } else if (_splitMedia.removeListener) {
        _splitMedia.removeListener(_onSplitMediaChange);
      }
    }
    _splitMedia = null;
    _splitBookId = null;
  }

  /** 写「我的」页书签统计（元素不存在时静默跳过） */
  function _setBookmarkStat(bms) {
    var count = (bms && Array.isArray(bms)) ? bms.length : 0;
    var el = document.getElementById('meStatBookmarks');
    if (el) el.textContent = count;
  }

  /**
   * 异步填充「我的」页统计卡（书籍数 / 章节数 / 书签数）
   */
  function _fillSettingsStats() {
    // 书籍数 + 章节数
    try {
      var books = win.__bkBooks || [];
      var bookCount = books.length;
      var chapterCount = 0;
      for (var i = 0; i < books.length; i++) {
        if (books[i] && books[i].chapters) chapterCount += books[i].chapters.length;
      }
      var elBooks = document.getElementById('meStatBooks');
      var elChapters = document.getElementById('meStatChapters');
      if (elBooks) elBooks.textContent = bookCount;
      if (elChapters) elChapters.textContent = chapterCount;
    } catch (e) {}

    // 书签数（与 BKBookmark 存储层保持一致：统一走 getAll，避免实例/键不匹配）
    try {
      if (win.BKBookmark && win.BKBookmark.getAll) {
        win.BKBookmark.getAll().then(function (bms) {
          _setBookmarkStat(bms);
        }).catch(function () {});
        // 首次读取较慢（IndexedDB 超时）时，真实数据到达后自动刷新统计
        if (!_bmLoadedListenerBound) {
          _bmLoadedListenerBound = true;
          win.addEventListener('bk:bookmarks-loaded', function () {
            if (win.BKBookmark && win.BKBookmark.getAll) {
              win.BKBookmark.getAll().then(function (bms) { _setBookmarkStat(bms); }).catch(function () {});
            }
          });
        }
      }
    } catch (e) {}
  }



  /**
   * 切换 Drawer 的打开/关闭状态
   */
  function _toggleTocDrawer(open, opts) {
    opts = opts || {};
    var drawer = document.getElementById('bkTocDrawer');
    var overlay = document.getElementById('bkTocOverlay');
    if (drawer) drawer.classList.toggle('open', open);
    if (overlay) overlay.classList.toggle('open', open);
    // 关闭时清空搜索
    if (!open) {
      var si = document.getElementById('bkTocSearchInput');
      if (si) { si.value = ''; _filterTocItems(''); }
    }
    if (open) {
      document.addEventListener('keydown', _tocEscHandler);
      if (win.BK && win.BK.backStack) {
        win.BK.backStack.push(function() { _toggleTocDrawer(false); });
      }
      // 打开时聚焦搜索框
      setTimeout(function() {
        var si = document.getElementById('bkTocSearchInput');
        if (si) si.focus();
      }, 320);
    } else {
      document.removeEventListener('keydown', _tocEscHandler);
      // 点击章节跳转时（navigate=true）：抽屉的 pushState 历史条目会被 router 的
      // replaceState 复用，这里只移除回退栈回调（silentPop），绝不 history.back，
      // 否则会与章节跳转抢历史记录导致跳回原章节、看起来“点击不跳转”。
      if (!opts.navigate && win.BK && win.BK.backStack) {
        win.BK.backStack.pop();
      }
    }
  }

  function _tocEscHandler(e) {
    if (e.key === 'Escape') { _toggleTocDrawer(false); }
  }

  /**
   * 过滤目录章节列表（按标题/序号模糊匹配）
   */
  function _filterTocItems(query) {
    var body = document.getElementById('bkTocDrawerBody');
    if (!body) return;
    var items = body.querySelectorAll('.bk-toc-chapter-item');
    var q = (query || '').trim().toLowerCase();
    var visibleCount = 0;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var num = (item.querySelector('.bk-toc-chapter-num') || {}).textContent || '';
      var title = (item.querySelector('.bk-toc-chapter-title') || {}).textContent || '';
      var match = !q || num.toLowerCase().indexOf(q) >= 0 || title.toLowerCase().indexOf(q) >= 0;
      item.classList.toggle('bk-toc-hidden', !match);
      if (match) visibleCount++;
    }
    // 显示/隐藏“无结果”提示
    var noRes = body.querySelector('.bk-toc-no-results');
    if (q && visibleCount === 0 && !noRes) {
      var div = document.createElement('div');
      div.className = 'bk-toc-no-results';
      div.textContent = '未找到匹配的章节';
      body.appendChild(div);
    } else if (!q && noRes) {
      noRes.remove();
    } else if (q && visibleCount > 0 && noRes) {
      noRes.remove();
    }
  }

  /**
   * 全局初始化 Drawer 事件（只绑定一次）
   */
  function _initTocDrawerEvents() {
    if (win.BK && win.BK._tocDrawerInited) return;
    if (win.BK) win.BK._tocDrawerInited = true;

    // 遮罩点击关闭
    var overlay = document.getElementById('bkTocOverlay');
    if (overlay) {
      overlay.addEventListener('click', function() { _toggleTocDrawer(false); });
    }

    // 关闭按钮
    var closeBtn = document.getElementById('bkTocDrawerClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', function() { _toggleTocDrawer(false); });
    }

    // 搜索框输入事件（防抖 200ms）
    var searchInput = document.getElementById('bkTocSearchInput');
    if (searchInput) {
      var _tocSearchTimer = null;
      searchInput.addEventListener('input', function() {
        var val = this.value;
        clearTimeout(_tocSearchTimer);
        _tocSearchTimer = setTimeout(function() {
          _filterTocItems(val);
        }, 200);
      });
    }

    // 全局事件代理：点击 nav-toc 按钮打开 drawer，点击 drawer 内章节链接关闭 drawer 并导航
    document.addEventListener('click', function(e) {
      // nav-toc 按钮
      var tocBtn = e.target.closest ? e.target.closest('[data-toc-drawer]') : null;
      if (tocBtn) {
        e.preventDefault();
        var bookId = tocBtn.getAttribute('data-book-id');
        if (bookId) _openTocDrawer(bookId);
        return;
      }
      // drawer 内章节链接
      var chapterLink = e.target.closest ? e.target.closest('[data-toc-nav]') : null;
      if (chapterLink) {
        // 阻止默认的 href 跳转（与下面 router 导航冲突），改用 router 跳转。
        // 同书章节切换走 replaceState，跨书走 hash 变化，均不会触发 history.back，
        // 因此点击章节能正确跳转到目标页。
        e.preventDefault();
        var href = chapterLink.getAttribute('href') || '';
        var navPath = href.replace(/^#\/?/, '');
        // 关闭 drawer 视觉并清掉其回退栈条目（不 history.back），再导航
        _toggleTocDrawer(false, { navigate: true });
        if (win.BK && win.BK.backStack && win.BK.backStack.silentPop) {
          win.BK.backStack.silentPop();
        }
        if (win.BKRouter) win.BKRouter.navigate(navPath);
        return;
      }
    }, true);
  }

  // ── 书架（书城增强 + 书架页）辅助函数 ────────────────────────────────

  /**

  /**
   * 按 id 从公开书籍表（window.__bkBooks）与私有 _zlBooks 查书籍元数据。
   * @param {string} bookId
   * @returns {Object|null}
   */
  function _findBookById(bookId) {
    if (win.__bkBooks) {
      for (var i = 0; i < win.__bkBooks.length; i++) {
        if (win.__bkBooks[i].id === bookId) return win.__bkBooks[i];
      }
    }
    for (var j = 0; j < _zlBooks.length; j++) {
      if (_zlBooks[j].id === bookId) return _zlBooks[j];
    }
    return null;
  }

  /**
   * 全局 bk-shelf-changed 监听：书城卡片就地翻转（不加整页刷新）。
   * 书城 DOM 即便在书架页前台时也仍在文档中（仅隐藏），就地更新无害，且回看时保持状态一致。
   */
  function _bkShelfChangedHandler(e) {
    var detail = (e && e.detail) || {};
    var bookId = detail.bookId;
    if (!bookId) return;
    var book = _findBookById(bookId) || { id: bookId };
    // 统一契约：角标显隐 / is-read 类均由 BKShelf.isRead（finished）决定，
    // 不再依赖 action==='add'（新模型 add=入架≠已读）。
    var read = (win.BKShelf && win.BKShelf.isRead) ? win.BKShelf.isRead(bookId) : false;
    var cards = document.querySelectorAll('.zl-book-card');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (card.getAttribute('data-book-id') !== bookId) continue;

      // 书城纯信息卡（含 .bk-city-read-marker）：仅切换角落小已读标记的显隐，
      // 不加 is-read 类、不翻徽标，避免 sage 内描边（.zl-book-card.is-read）泄漏到书城。
      var marker = card.querySelector('.bk-city-read-marker');
      if (marker) {
        if (read) marker.classList.add('is-read-mark');
        else marker.classList.remove('is-read-mark');
        continue;
      }
      // 历史兼容：极少数书城卡未渲染小标记但带 data-city 标记，同样跳过内描边。
      if (card.getAttribute('data-city') === '1') continue;
      // 非书城普通卡（书架/搜索）：is-read 类跟随 BKShelf.isRead 同步
      if (read) card.classList.add('is-read');
      else card.classList.remove('is-read');
    }
  }

  /**
   * 全局 bk-shelf-changed 监听：书架页就地刷新（仅当书架页为前台时）。
   */
  function _shelfPageChangedHandler() {
    var listEl = document.getElementById('shelfList');
    if (!listEl) return; // 书架页不在前台，跳过（回看时由 renderShelfPage 整体重渲染兜底）
    // 先合并导入书籍数据（异步），再渲染书架列表
    // 修复：BKShelf.add() 在 saveBook() 中同步触发 bk-shelf-changed，
    // 但此时新书尚未合并到 _zlBooks/__bkBooks，导致 _findBookById 返回 null，
    // 书架显示 bookId 而非真实标题。
    _mergeImportedBooks().then(function () {
      _renderShelfList();
    }).catch(function () {
      _renderShelfList(); // 合并失败也兜底渲染，避免书架不刷新
    });
  }

  /**
   * 书架页列表 + 统计渲染（私有）：读 BKShelf.all()/stats() 整体渲染，保证与事实源 100% 一致。
   */
  /**
   * 计算书架统计：已读 / 在读 / 收藏。
   * 已读 = BKShelf 收藏总数；在读 = 有阅读进度且未读完的书数；收藏 = BKShelf 收藏总数。
   * @returns {{read:number, reading:number, collected:number}}
   */


  /**
   * 渲染书架页「继续阅读」模块（复用既有 _renderContinueList 卡片结构）。
   * @param {HTMLElement} app 书架页容器（#app）
   */
  function _renderShelfContinue(app) {
    if (!app) return;
    _renderContinueList(app);
  }

  function _renderShelfList() {
    var listEl = document.getElementById('shelfList');
    var tabsEl = document.getElementById('shelfTabs');
    if (!listEl || !win.BKShelf) return;

    var records = win.BKShelf.all();
    var _isReadFn = function (id) {
      return (win.BKShelf && win.BKShelf.isRead) ? win.BKShelf.isRead(id) : false;
    };

    // 分桶：在读（未 finished） / 已读（finished）
    var reading = [], read = [];
    for (var i = 0; i < records.length; i++) {
      (_isReadFn(records[i].bookId) ? read : reading).push(records[i]);
    }

    // 分段计数 + 激活态（保留 _shelfActiveTab，bk-shelf-changed 重渲染不跳变）
    var crEl = document.getElementById('shelfCountReading');
    var cdEl = document.getElementById('shelfCountRead');
    if (crEl) crEl.textContent = reading.length;
    if (cdEl) cdEl.textContent = read.length;
    if (tabsEl) {
      var tabBtns = tabsEl.querySelectorAll('.bk-shelf-tab');
      for (var t = 0; t < tabBtns.length; t++) {
        var tb = tabBtns[t];
        var active = tb.getAttribute('data-tab') === _shelfActiveTab;
        tb.classList.toggle('is-active', active);
        tb.setAttribute('aria-selected', active ? 'true' : 'false');
      }
    }

    // 空状态引导
    if (!records.length) {
      listEl.innerHTML =
        '<div class="bk-shelf-empty">' +
          '<div class="bk-shelf-empty-icon">📚</div>' +
          '<div class="bk-shelf-empty-title">你还没有收藏的书</div>' +
          '<button type="button" class="bk-shelf-empty-cta" id="shelfEmptyCta">去书城发现好书 →</button>' +
        '</div>';
      var cta = document.getElementById('shelfEmptyCta');
      if (cta) cta.addEventListener('click', function () {
        if (win.BKRouter) win.BKRouter.navigate('city');
      });
      return;
    }

    // 书架列表（每条记录 = 在架/收藏；是否「读完」由 BKShelf.isRead(finished) 判定）
    // 仅渲染当前激活桶（默认：在读）
    var bucket = (_shelfActiveTab === 'read') ? read : reading;
    if (!bucket.length) {
      listEl.innerHTML =
        '<div class="bk-shelf-tab-empty">' +
          (_shelfActiveTab === 'read' ? '已读列表还是空的' : '在读列表还是空的') +
        '</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < bucket.length; i++) {
      var rec = bucket[i];
      var book = _findBookById(rec.bookId) || { id: rec.bookId, title: rec.bookId, series: '' };
      var title = book.title ? _cleanBookTitle(book.title) : (rec.bookId || '未知书籍');
      var author = book.author || _getSeriesTitle(book.series) || '';
      var cover = _coverHTML(book, { size: 'sm' });
      var isRead = _isReadFn(rec.bookId);

      // 已读角标：仅读完(finished)行显现；统一由 _renderShelfList 渲染，避免与 _coverHTML 重复
      var readMarker = isRead
        ? '<span class="bk-city-read-marker is-read-mark" aria-label="已读" role="img">✓</span>'
        : '';

      // 行副文案：读完显「已于 X 读完」；未读完（在读/收藏）显「在读中」+ 进度（若有）
      var subText;
      if (isRead) {
        subText = '已于 ' + escText(rec.completedAt || '') + ' 读完';
      } else {
        var prog = getReadingProgress(rec.bookId);
        var cc = book.chapter_count || 0;
        subText = (cc > 0 && prog > 0)
          ? ('在读中 · 第 ' + prog + '/' + cc + ' 章')
          : '在读中';
      }
      // note/rating 数据模型已预留，本轮只读展示占位
      var metaExtra = '';
      if (rec.rating) metaExtra += ' ★' + rec.rating;
      if (rec.note) metaExtra += ' · 有笔记';

      html += '<div class="bk-shelf-row" data-book-id="' + escAttr(rec.bookId) + '" role="button" tabindex="0" aria-label="打开 ' + escAttr(title) + '">';
      html += '<div class="bk-shelf-row-cover">' + cover + '</div>';
      html += readMarker;
      html += '<div class="bk-shelf-row-info">';
      html += '<div class="bk-shelf-row-title">' + escText(title) + '</div>';
      if (author) html += '<div class="bk-shelf-row-author">' + escText(author) + '</div>';
      // 导入来源徽标（本地 / WebDAV）：仅导入书含 source，目录书不渲染
      var srcBadge = _sourceBadgeHTML(book);
      if (srcBadge) html += '<div class="bk-shelf-row-source">' + srcBadge + '</div>';
      // 在读行：主操作「标记已读」（sage 实心 pill）；已读行：副操作「移回在读」（中性描边 pill）
      var actionBtn = isRead
        ? '<button type="button" class="bk-shelf-unread" data-book-id="' + escAttr(rec.bookId) + '" aria-label="取消已读，移回在读"><span class="bk-shelf-btn-ico" aria-hidden="true">↩</span>移回在读</button>'
        : '<button type="button" class="bk-shelf-markread" data-book-id="' + escAttr(rec.bookId) + '" aria-label="标记为已读"><span class="bk-shelf-btn-ico" aria-hidden="true">✓</span>标记已读</button>';
      html += '<div class="bk-shelf-row-date">' + escText(subText) + escText(metaExtra) + '</div>';
      html += '</div>';
      html += actionBtn;
      html += '<button type="button" class="bk-shelf-remove-btn" data-book-id="' + escAttr(rec.bookId) + '" aria-label="移除">移除</button>';
      html += '</div>';
    }
    listEl.innerHTML = html;

    // 绑定「标记已读」按钮（在读行）：点击 → BKShelf.markRead → 移入已读桶
    // （bk-shelf-changed 触发整体重渲染，激活态停在「在读」故该行消失 = 已移动）
    var markBtns = listEl.querySelectorAll('.bk-shelf-markread');
    for (var m = 0; m < markBtns.length; m++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-book-id');
          if (id && win.BKShelf && win.BKShelf.markRead) win.BKShelf.markRead(id);
        });
      })(markBtns[m]);
    }
    // 绑定「取消已读」按钮（已读行）：点击 → BKShelf.unmarkRead → 移回在读桶
    var unreadBtns = listEl.querySelectorAll('.bk-shelf-unread');
    for (var u = 0; u < unreadBtns.length; u++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-book-id');
          if (id && win.BKShelf && win.BKShelf.unmarkRead) win.BKShelf.unmarkRead(id);
        });
      })(unreadBtns[u]);
    }

    // 绑定移除按钮（二次确认后写 BKShelf.remove，由事件监听整体重渲染）
    var rmBtns = listEl.querySelectorAll('.bk-shelf-remove-btn');
    for (var j = 0; j < rmBtns.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-book-id');
          if (!id) return;
          var b = _findBookById(id);
          var name = b ? _cleanBookTitle(b.title || id) : id;
          if (win.confirm && !win.confirm('确定将《' + name + '》移出书架？')) return;
          if (win.BKShelf && win.BKShelf.remove) win.BKShelf.remove(id);
          // 移除后由 bk-shelf-changed 监听整体重渲染（含统计与空状态）
        });
      })(rmBtns[j]);
    }
  }

  // ════════════════════════════════════════════════════════════
  // 书城：多级下钻（系列 → 分类 → 书籍，模块级状态机）
  // 渲染进 #homeView（与书架页 #app 区分）；底栏常驻由 bottom-tab-bar 控制。
  // ════════════════════════════════════════════════════════════

  var CITY_BATCH_SIZE = 24; // 三级书籍列表每批加载数量（决策 OQ1）

  // 书城下钻状态（与旧 _zl* 区分，避免污染）
  var _cityCategory = null;       // 当前分类名
  var _cityCategoryPrefix = null; // 当前分类 prefix
  var _citySeries = '';           // 当前系列 id（'' 表示未进入三级）
  var _cityBookOffset = 0;        // 三级书籍列表已渲染偏移
  var _cityLoading = false;       // 加载中锁（防重复触发）
  var _cityAllBooks = [];         // 当前三级系列在分类下的全部书籍
  var _cityObserver = null;       // IntersectionObserver 实例（触底哨兵）
  var _cityEventsBound = false;   // 书城事件委托是否已绑定（homeView 持久，仅绑一次）
  var _cityIndexUpdateBound = false; // 后台索引更新监听是否已注册（仅一次）
  var _cityImplicit = false;       // 当前三级书籍列表是否隐式选定唯一分类（单分类系列跳过二级）

  /** 计算书城当前下钻层级：1=系列网格，2=分类列表，3=书籍列表
   *  注：单分类系列 implicit 进入三级时 _cityCategory 可能为空，
   *      故以 _cityImplicit 同样视为三级（设计注：「_cityCategory 为空即唯一分类已隐式选定」）。 */
  function _cityLevel() {
    if (_citySeries && (_cityCategory || _cityImplicit)) return 3;
    if (_citySeries) return 2;
    return 1;
  }

  /**
   * 书城一级：返回系列列表（模块级下钻主轴翻转后，L1 = 系列）。
   * 职事书报 books 系列强制置顶；其余按 count 降序。
   * @returns {Array<Object>} 系列对象数组
   */
  function _getSeriesList() {
    // 合并微型系列（count < MIN_SERIES_BOOKS）到拾遗系列，与下载面板行为一致
    var merged = _getMergedSeries();
    var list = merged.series.slice();
    // 更新拾遗系列的显示计数（含被合并掉的书籍）
    var pickupIdx = -1;
    for (var k = 0; k < list.length; k++) {
      if (list[k].id === _PICKUP_SERIES_ID) { pickupIdx = k; break; }
    }
    if (pickupIdx >= 0 && merged.mergedCount > 0) {
      var pickupOrig = (merged.bookCount[_PICKUP_SERIES_ID] || 0);
      list[pickupIdx] = {
        id: list[pickupIdx].id,
        title: list[pickupIdx].title,
        count: pickupOrig + merged.mergedCount
      };
    }
    list.sort(function (a, b) {
      var aTop = (a.id === 'books') ? 1 : 0;
      var bTop = (b.id === 'books') ? 1 : 0;
      if (aTop !== bTop) return bTop - aTop; // books 置顶
      var ac = (typeof a.count === 'number') ? a.count : 0;
      var bc = (typeof b.count === 'number') ? b.count : 0;
      return bc - ac; // 其余按 count 降序
    });
    return list;
  }

  /**
   * 取某系列下的分类集合（模块级下钻主轴翻转后，L2 = 系列内分类）。
   * 若系列对象自带 categories 字段（数组 of {prefix,name,count}，如职事书报 books）则直接用；
   * 否则从 _zlBooks 过滤 b.series===seriesId 聚合出 {prefix,name:category,count}，按 prefix 数值升序。
   * 单分类系列返回 1 项（触发 implicit 跳过二级）。
   * @param {string} seriesId
   * @returns {Array<{prefix:string,name:string,count:number}>}
   */
  /** 判断书籍是否属于某系列（含被合并到拾遗的系列） */
  var _mergedSeriesCache = null;
  function _bookMatchesSeries(b, seriesId) {
    if (b.series === seriesId) return true;
    // 拾遗系列：被合并的微型系列书籍也属于拾遗
    if (seriesId === _PICKUP_SERIES_ID) {
      if (!_mergedSeriesCache) _mergedSeriesCache = _getMergedSeries();
      return !!_mergedSeriesCache.mergedIds[b.series];
    }
    return false;
  }
  /** 清除合并系列缓存（数据变更时调用） */
  function _invalidateMergedSeriesCache() { _mergedSeriesCache = null; }

  function _getSeriesCategories(seriesId) {
    var seriesObj = null;
    for (var i = 0; i < _zlSeries.length; i++) {
      if (_zlSeries[i].id === seriesId) { seriesObj = _zlSeries[i]; break; }
    }
    if (seriesObj && Array.isArray(seriesObj.categories) && seriesObj.categories.length) {
      return seriesObj.categories.slice();
    }
    var map = {};
    for (var j = 0; j < _zlBooks.length; j++) {
      var b = _zlBooks[j];
      if (!_bookMatchesSeries(b, seriesId)) continue;
      var p = b.category_prefix;
      if (p === undefined || p === null) p = '';
      if (!map[p]) map[p] = { prefix: p, name: b.category, count: 0 };
      map[p].count++;
    }
    var arr = [];
    for (var k in map) {
      if (map.hasOwnProperty(k)) arr.push(map[k]);
    }
    arr.sort(function (a, b) { return parseInt(a.prefix || '0', 10) - parseInt(b.prefix || '0', 10); });
    return arr;
  }

  /**
   * 取某系列在某分类下的书籍（主轴翻转后，books 跨分类特例自然消解，无需特判）。
   * @param {string} seriesId
   * @param {string} cat 分类名
   * @param {string} prefix 分类 prefix（空/未定义表示单分类系列隐式选定，返回该系列全部书）
   * @returns {Array<Object>} 书籍数组
   */
  function _getBooksInSeriesCategory(seriesId, cat, prefix) {
    var result = [];
    var hasPrefix = (prefix !== undefined && prefix !== null && prefix !== '');
    for (var i = 0; i < _zlBooks.length; i++) {
      var b = _zlBooks[i];
      if (!_bookMatchesSeries(b, seriesId)) continue;
      if (!hasPrefix) {
        // 单分类系列（隐式选定唯一分类）：返回该系列全部书籍
        result.push(b);
      } else if (b.category_prefix === prefix) {
        result.push(b);
      }
    }
    return result;
  }

  /** 计算系列书籍数（无 series.count 时实时统计，含被合并系列） */
  function _countSeriesBooks(seriesId) {
    var n = 0;
    for (var i = 0; i < _zlBooks.length; i++) {
      if (_bookMatchesSeries(_zlBooks[i], seriesId)) n++;
    }
    return n;
  }

  /**
   * 渲染面包屑（供测试定位：.bk-city-crumb[data-level] / .bk-crumb-item[data-action] / .bk-crumb-sep）
   * 主轴翻转后：
   *   二级页（系列内分类列表）：仅「‹ 系列名」(data-action=to-series → 回 L1)
   *   三级页（多分类书籍列表）：「系列名 › 分类名」(to-series / to-category)
   *   三级页（单分类隐式）：仅「系列名」(data-action=to-series → 回 L1)
   * @param {number} level 2 | 3
   * @param {string} seriesTitle 系列名
   * @param {string} cat 分类名（仅三级多分类时使用）
   * @param {boolean} implicit 是否单分类隐式（三级仅显示系列名）
   */
  function _renderCityCrumb(level, seriesTitle, cat, implicit, seriesId) {
    var cityRoot = '<span class="bk-crumb-item" data-action="to-city" role="button" tabindex="0">书城</span>';
    var sep = '<span class="bk-crumb-sep">›</span>';
    if (level === 2) {
      return '<nav class="bk-city-crumb" data-level="2">' +
        cityRoot + sep +
        '<span class="bk-crumb-item" data-action="to-series" data-series="' + escAttr(seriesId || '') + '" role="button" tabindex="0">' + escText(seriesTitle) + '</span>' +
        '</nav>';
    }
    if (implicit) {
      // 单分类系列：隐式选定唯一分类，仅显示系列名
      return '<nav class="bk-city-crumb" data-level="3">' +
        cityRoot + sep +
        '<span class="bk-crumb-item" data-action="to-series" data-series="' + escAttr(seriesId || '') + '" role="button" tabindex="0">' + escText(seriesTitle) + '</span>' +
        '</nav>';
    }
    return '<nav class="bk-city-crumb" data-level="3">' +
      cityRoot + sep +
      '<span class="bk-crumb-item" data-action="to-series" data-series="' + escAttr(seriesId || '') + '" role="button" tabindex="0">' + escText(seriesTitle) + '</span>' +
      sep +
      '<span class="bk-crumb-item" data-action="to-category" role="button" tabindex="0">' + escText(cat) + '</span>' +
      '</nav>';
  }

  /** 书城一级：系列网格（主轴翻转后，L1 = 系列） */
  function _renderCityHome(homeView) {
    _citySeries = '';
    _cityCategory = null;
    _cityCategoryPrefix = null;
    _cityImplicit = false;
    _cityBookOffset = 0;
    if (_cityObserver) { _cityObserver.disconnect(); _cityObserver = null; }
    var seriesList = _getSeriesList();
    var html = '<div class="bk-city-page">';
    html += '<div class="bk-city-header"><h1 class="bk-city-title">书城</h1></div>';
    html += '<div class="bk-section-header"><span class="bk-section-title-lg">系列</span></div>';
    html += '<div class="series-catalog-grid">';
    for (var i = 0; i < seriesList.length; i++) {
      var s = seriesList[i];
      var displayTitle = _displaySeriesTitle ? _displaySeriesTitle(s.title) : s.title;
      var bookCount = (typeof s.count === 'number') ? s.count : _countSeriesBooks(s.id);
      var sc1 = _getSeriesColor(s.id);
      html += '<div class="series-catalog-card" data-series="' + escAttr(s.id) + '" role="button" tabindex="0" style="--series-color:' + sc1 + '">';
      // 海报封面（复用 .bk-cover，系列色 + 系列名作为封面标题），与 L3 书籍卡海报同构
      html += _coverHTML({ series: s.id, title: displayTitle }, { seriesTitle: '系列' });
      // 信息条（与 L3 .book-caption 同构）：名称 + 数量
      html += '<div class="collection-caption">';
      html += '<div class="series-catalog-card-title">' + escText(displayTitle) + '</div>';
      html += '<div class="series-catalog-card-count">' + bookCount + ' 本</div>';
      html += '</div></div>';
    }
    html += '</div></div>';
    homeView.innerHTML = html;
    startScrollTracking('city');
    restoreScrollPosition('city');
  }

  /**
   * 进入某系列：取该系列的分类集合。
   * 若仅 1 个分类 → 隐式跳过二级，直接进三级书籍列表（implicit=true）。
   * 否则 → 进二级分类列表。
   */
  function _enterSeries(homeView, seriesId) {
    var cats = _getSeriesCategories(seriesId);
    if (cats.length === 1) {
      _renderCityBookList(homeView, seriesId, cats[0].name, cats[0].prefix, true);
    } else {
      _renderCityCategoryList(homeView, seriesId);
    }
  }

  /** 书城二级：某系列下的分类网格 + 面包屑（主轴翻转后，L2 = 系列内分类） */
  function _renderCityCategoryList(homeView, seriesId) {
    _citySeries = seriesId;
    _cityCategory = null;
    _cityCategoryPrefix = null;
    _cityImplicit = false;
    _cityBookOffset = 0;
    if (_cityObserver) { _cityObserver.disconnect(); _cityObserver = null; }
    var cats = _getSeriesCategories(seriesId);
    var seriesTitle = _getSeriesTitle(seriesId);
    var html = '<div class="bk-city-page">';
    html += '<div class="bk-city-topbar">';
    html += _renderCityCrumb(2, seriesTitle, '', false, seriesId);
    html += '</div>';
    html += '<div class="bk-section-header"><span class="bk-section-title-lg">' + escText(seriesTitle) + '</span></div>';
    html += '<div class="category-grid">';
    for (var i = 0; i < cats.length; i++) {
      var c = cats[i];
      var sc2 = _getSeriesColor(seriesId);
      html += '<div class="category-card" data-category="' + escAttr(c.name) + '" data-category-prefix="' + escAttr(c.prefix) + '" role="button" tabindex="0" style="--series-color:' + sc2 + '">';
      // 海报封面（复用 .bk-cover，系列色 + 分类名作为封面标题，顶部标签为所属系列名），与 L3 同构
      html += _coverHTML({ series: seriesId, title: c.name }, { seriesTitle: seriesTitle });
      // 信息条（与 L3 .book-caption 同构）：分类名 + 数量
      html += '<div class="collection-caption">';
      html += '<div class="category-card-title">' + escText(c.name) + '</div>';
      html += '<div class="category-card-count">' + c.count + ' 本</div>';
      html += '</div></div>';
    }
    html += '</div></div>';
    homeView.innerHTML = html;
    startScrollTracking('city-category');
    restoreScrollPosition('city-category');
  }

  /** 书城三级：某系列在某分类下的书籍列表（无限滚动）+ 面包屑
   *  @param {string} seriesId
   *  @param {string} cat 分类名
   *  @param {string} prefix 分类 prefix
   *  @param {boolean} implicit 是否单分类隐式（跳过二级，面包屑仅显示系列名）
   */
  function _renderCityBookList(homeView, seriesId, cat, prefix, implicit) {
    _citySeries = seriesId;
    _cityCategory = (cat === undefined || cat === null) ? null : cat;
    _cityCategoryPrefix = (prefix === undefined || prefix === null) ? null : prefix;
    _cityImplicit = !!implicit;
    _cityBookOffset = 0;
    _cityLoading = false;
    _cityAllBooks = _getBooksInSeriesCategory(seriesId, cat, prefix);
    var seriesTitle = _getSeriesTitle(seriesId);
    var html = '<div class="bk-city-page">';
    html += '<div class="bk-city-topbar">';
    html += _renderCityCrumb(3, seriesTitle, cat, implicit, seriesId);
    html += '</div>';
    html += '<div class="bk-section-header"><span class="bk-section-title-lg">' + escText(seriesTitle) + '</span></div>';
    html += '<div class="book-grid bk-city-book-grid" data-series="' + escAttr(seriesId) + '"></div>';
    html += '<div class="bk-city-sentinel" id="bkCitySentinel"></div>';
    html += '<div class="bk-city-end" hidden>已经到底了</div>';
    html += '</div>';
    homeView.innerHTML = html;
    // 先填首批，再建立触底哨兵
    _appendCityBatch(homeView);
    _setupCitySentinel(homeView);
    startScrollTracking('city-book');
    restoreScrollPosition('city-book');
  }

  /** 向三级书籍网格追加下一批（更新 _cityBookOffset），返回是否还有更多 */
  function _appendCityBatch(homeView) {
    if (_cityLoading) return false;
    var remaining = _cityAllBooks.length - _cityBookOffset;
    if (remaining <= 0) {
      _showCityEnd(homeView, true);
      return false;
    }
    _cityLoading = true;
    var batch = _cityAllBooks.slice(_cityBookOffset, _cityBookOffset + CITY_BATCH_SIZE);
    var grid = homeView.querySelector('.bk-city-book-grid');
    if (grid) {
      var frag = '';
      for (var i = 0; i < batch.length; i++) {
        frag += _buildBookCard(batch[i], { showProgress: false, readMarker: true, cityBook: true });
      }
      grid.insertAdjacentHTML('beforeend', frag);
    }
    _cityBookOffset += batch.length;
    _cityLoading = false;
    if (_cityBookOffset >= _cityAllBooks.length) _showCityEnd(homeView, true);
    return true;
  }

  /** 显示 / 隐藏「已经到底了」 */
  function _showCityEnd(homeView, show) {
    var endEl = homeView.querySelector('.bk-city-end');
    if (endEl) endEl.hidden = !show;
  }

  /** 建立触底哨兵（IntersectionObserver 守卫；jsdom 无 IO 时由测试直接调 _cityLoadMore） */
  function _setupCitySentinel(homeView) {
    if (typeof IntersectionObserver !== 'function') return;
    var sentinel = homeView.querySelector('#bkCitySentinel');
    if (!sentinel) return;
    if (_cityObserver) _cityObserver.disconnect();
    _cityObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) _cityLoadMore();
      }
    }, { rootMargin: '200px' });
    _cityObserver.observe(sentinel);
  }

  /** 无限滚动加载更多（供 IntersectionObserver 与测试 stub 调用） */
  function _cityLoadMore() {
    var homeView = document.getElementById('homeView');
    if (!homeView) return;
    if (_cityLevel() !== 3) return;
    _appendCityBatch(homeView);
    _setupCitySentinel(homeView);
  }

  /** 逐级回退：任意级 → 一级（系列网格） */
  function _cityBackToSeries() {
    var homeView = document.getElementById('homeView');
    if (!homeView) return;
    _renderCityHome(homeView);
  }

  /** 逐级回退：三级 → 二级（系列内分类列表） */
  function _cityBackToCategories() {
    var homeView = document.getElementById('homeView');
    if (!homeView) return;
    _renderCityCategoryList(homeView, _citySeries);
  }

  /** 书城事件委托（绑定在 homeView 容器一次；重渲染 innerHTML 不丢失监听） */
  function _bindCityEvents(homeView) {
    if (_cityEventsBound) return;
    _cityEventsBound = true;

    function onClick(e) {
      if (!e.target || !e.target.closest) return;

      // 面包屑：回上一级
      var crumb = e.target.closest('.bk-crumb-item');
      if (crumb) {
        e.preventDefault();
        var action = crumb.getAttribute('data-action');
        if (action === 'to-city') {
          // 回书城根（一级系列网格）
          _renderCityHome(homeView);
        } else if (action === 'to-series') {
          // 回二级（该系列内分类列表）
          var sid = crumb.getAttribute('data-series');
          if (sid) _renderCityCategoryList(homeView, sid);
        } else if (action === 'to-category') {
          // 回二级（该系列内分类列表）
          _renderCityCategoryList(homeView, _citySeries);
        }
        return;
      }

      // L1 系列卡 → 进入该系列（系列 → 分类 → 书籍）
      var seriesCard = e.target.closest('.series-catalog-card');
      if (seriesCard) {
        e.preventDefault();
        var seriesId = seriesCard.getAttribute('data-series');
        _enterSeries(homeView, seriesId);
        return;
      }

      // L2 分类卡 → 进入三级书籍列表
      var catCard = e.target.closest('.category-card');
      if (catCard) {
        e.preventDefault();
        var cat = catCard.getAttribute('data-category');
        var prefix = catCard.getAttribute('data-category-prefix');
        _renderCityBookList(homeView, _citySeries, cat, prefix, false);
        return;
      }

      // 书籍卡 → 进入阅读（与书架 / 搜索一致的导航逻辑）
      var bookLink = e.target.closest('.book-link[data-book-id]');
      if (bookLink) {
        e.preventDefault();
        var bookId = bookLink.getAttribute('data-book-id');
        var series = bookLink.getAttribute('data-series');
        // 点书城卡 = 打开阅读 + 自动加入书架（仅收藏，不等于已读）。
        // 新模型：add 仅入架，角标需 markRead / 读完进度才亮起（bk-shelf-changed 处理器已
        // 改读 BKShelf.isRead，故 add 不会点亮「已读」角标）；BKShelf.add 幂等，重复点击无害。
        if (win.BKShelf && win.BKShelf.add) win.BKShelf.add(bookId);
        _handleBookClick(bookId, series, bookLink);
        return;
      }
    }

    /**
     * 键盘事件委托（与 click 同容器 homeView，同一 _cityEventsBound 守卫仅绑一次）。
     * 书城 L1/L2/L3 卡及面包屑均为 role=button tabindex=0，聚焦后 Enter(13)/Space(32)
     * 触发与鼠标点击等效的下钻 / 打开逻辑；Space 必须 preventDefault 防页面滚动。
     * 注意：<div role=button> / <span role=button> 不会自动派发 click，故 keydown 与 click
     * 不会重复触发，此处不手动 dispatch click。
     */
    function onKeyDown(e) {
      if (!e.target || !e.target.closest) return;
      // 仅响应 Enter / Space 键
      var isEnter = e.key === 'Enter' || e.keyCode === 13;
      var isSpace = e.key === ' ' || e.keyCode === 32;
      if (!isEnter && !isSpace) return;

      // 面包屑：回上一级（键盘可达）
      var crumb = e.target.closest('.bk-crumb-item');
      if (crumb) {
        e.preventDefault();
        var action = crumb.getAttribute('data-action');
        if (action === 'to-city') {
          _renderCityHome(homeView);
        } else if (action === 'to-series') {
          var sid2 = crumb.getAttribute('data-series');
          if (sid2) _renderCityCategoryList(homeView, sid2);
        } else if (action === 'to-category') {
          _renderCityCategoryList(homeView, _citySeries);
        }
        return;
      }

      // L1 系列卡 → 进入该系列
      var seriesCard = e.target.closest('.series-catalog-card');
      if (seriesCard) {
        e.preventDefault();
        var seriesId = seriesCard.getAttribute('data-series');
        _enterSeries(homeView, seriesId);
        return;
      }

      // L2 分类卡 → 进入三级书籍列表
      var catCard = e.target.closest('.category-card');
      if (catCard) {
        e.preventDefault();
        var cat = catCard.getAttribute('data-category');
        var prefix = catCard.getAttribute('data-category-prefix');
        _renderCityBookList(homeView, _citySeries, cat, prefix, false);
        return;
      }

      // 书籍卡 → 进入阅读（与 click 同一逻辑）
      var bookLink = e.target.closest('.book-link[data-book-id]');
      if (bookLink) {
        e.preventDefault();
        var bookId = bookLink.getAttribute('data-book-id');
        var series = bookLink.getAttribute('data-series');
        // 键盘打开 = 打开阅读 + 自动加入书架（与 click 一致）
        if (win.BKShelf && win.BKShelf.add) win.BKShelf.add(bookId);
        _handleBookClick(bookId, series, bookLink);
        return;
      }
    }

    homeView.addEventListener('click', onClick);
    homeView.addEventListener('keydown', onKeyDown);
  }

  /** 注册书城所需的全局监听（bk-shelf-changed 就地翻转 + 后台索引更新）仅一次 */
  function _registerCityGlobalHandlers() {
    if (!_bkShelfChangedBound) {
      _bkShelfChangedBound = true;
      if (win.BKShelf) win.addEventListener('bk-shelf-changed', _bkShelfChangedHandler);
    }
    if (!_cityIndexUpdateBound) {
      _cityIndexUpdateBound = true;
      document.addEventListener('zl:index-updated', _onIndexUpdated);
    }
  }

  /** 后台索引更新 → 重渲染当前可见浏览视图 */
  function _onIndexUpdated() {
    if (!win.DataManager) return;
    var idx = win.DataManager.getCachedIndex();
    if (!idx || !idx.books) return;
    _zlIndex = idx;
    _zlSeries = idx.series || [];
    _zlBooks = idx.books || [];
    _invalidateMergedSeriesCache();
    _rerenderCurrentView();
  }

  /** 重渲染当前可见浏览视图（书架 / 书城），供管理模式切换与索引更新复用 */
  function _rerenderCurrentView() {
    var homeView = document.getElementById('homeView');
    var appEl = document.getElementById('app');
    if (appEl && appEl.style.display !== 'none') {
      if (win.location.hash.indexOf('city') !== -1) {
        if (BKRenderer.renderCityPage) BKRenderer.renderCityPage();
      } else if (BKRenderer.renderShelfPage) {
        BKRenderer.renderShelfPage();
      }
    } else if (homeView && homeView.style.display !== 'none') {
      if (BKRenderer.renderCityPage) BKRenderer.renderCityPage();
    }
  }

  // ── 渲染器对象 ──────────────────────────────────────────────────────

  var BKRenderer = {

    // zl-html 渲染器激活标志
    _zlActive: false,

    // ── 首页：书籍列表（增强版：zl-html 系列分类 + 下载管理）──────────

    renderHome: function () {
      // 决策④：首屏由书城改为书架（#/shelf）。renderHome 薄转发，
      // 旧 _renderEnhancedHome / _renderZlHome 已随书城改为 #/city 而下线。
      BKRenderer.renderShelfPage();
    },

    // ── 书城：多级下钻（系列 → 分类 → 书籍）──────────────────────────
    // 渲染进 #homeView；内部状态机（_city*）表达三级下钻，不进 hash。

    renderCityPage: function () {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
      _cleanupPdfCache();
      document.body.classList.remove('bk-reading-page');
      showHome();
      var homeView = document.getElementById('homeView');
      if (!homeView) return;
      document.title = '书城';
      if (!_zlDmReady) {
        _ensureDmInit().then(function () {
          _renderCityHome(homeView);
          _bindCityEvents(homeView);
          _registerCityGlobalHandlers();
        }).catch(function () {});
      } else {
        _renderCityHome(homeView);
        _bindCityEvents(homeView);
        _registerCityGlobalHandlers();
      }
    },

    /**
     * 系列书籍列表页（独立深链 #/series/<id>，来自搜索「热门系列」卡片）
     * 主轴翻转后：books（跨分类系列）→ 进二级分类列表；其余单分类系列 → 直接进三级书籍列表（implicit）。
     * 复用书城三级下钻的渲染与无限滚动基建。
     */
    renderSeriesPage: function (seriesId) {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
      _cleanupPdfCache();
      document.body.classList.remove('bk-reading-page');
      showHome();
      var homeView = document.getElementById('homeView');
      if (!homeView) return;
      document.title = '书城';

      function render() {
        if (seriesId === 'books') {
          // 跨分类系列 → 进二级分类列表
          _renderCityCategoryList(homeView, seriesId);
        } else {
          var cats = _getSeriesCategories(seriesId);
          if (cats.length === 1) {
            // 单分类系列 → 隐式跳过二级，直接进三级书籍列表
            _renderCityBookList(homeView, seriesId, cats[0].name, cats[0].prefix, true);
          } else {
            // 多分类（理论上非 books 系列均为单分类，此处为兜底）
            _renderCityCategoryList(homeView, seriesId);
          }
        }
        _bindCityEvents(homeView);
        _registerCityGlobalHandlers();
      }

      if (!_zlDmReady) {
        _ensureDmInit().then(function () { render(); }).catch(function () {
          _renderCityHome(homeView);
          _bindCityEvents(homeView);
          _registerCityGlobalHandlers();
        });
      } else {
        render();
      }
    },

    // 无限滚动加载更多（测试可调用；内部已含 IntersectionObserver 守卫）
    cityLoadMore: function () {
      _cityLoadMore();
    },

    // ── 目录页：章节列表 ────────────────────────────────────────────

    // ── 我的（个人中心，手机/平板） ─────────────────────────────

    renderMyPage: function () {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
      _cleanupPdfCache();
      document.body.classList.remove('bk-reading-page');
      showApp();
      var app = getApp();

      // 环境判断（与 themePanel 一致的可见性规则，避免「点了没反应」的无效行）
      var ua = navigator.userAgent;
      var isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
      var isAndroid = /Android/i.test(ua);
      var isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
      var isStandalone = (window.navigator.standalone === true) || window.matchMedia('(display-mode: standalone)').matches;
      var canUpdate = isCapacitor || (isStandalone && ('caches' in window));

      var html = '<div class="bk-settings-page">';
      html += '<div class="bk-settings-header"><h1>我的</h1></div>';
      html += '<div class="bk-settings-grid">';
      html += '<div class="bk-settings-left">';

      // 个人卡
      html += '<div class="bk-profile-card">';
      html += '<div class="bk-profile-avatar">读</div>';
      html += '<div class="bk-profile-info"><div class="bk-profile-name">书报读者</div><div class="bk-profile-sub">在阅读中遇见美好</div></div>';
      html += '</div>';

      // 统计卡
      html += '<div class="bk-stats-card">';
      html += '<div class="bk-stat"><span class="bk-stat-num" id="meStatBooks">—</span><span class="bk-stat-label">书籍</span></div>';
      html += '<div class="bk-stat"><span class="bk-stat-num" id="meStatChapters">—</span><span class="bk-stat-label">章节</span></div>';
      html += '<div class="bk-stat"><span class="bk-stat-num" id="meStatBookmarks">—</span><span class="bk-stat-label">书签</span></div>';
      html += '</div>';

      // 设置入口：打开阅读界面的设置弹窗（阅读模式 + 字体大小），避免「我的」页内联冗余
      html += '<button class="bk-settings-entry" data-action="open-theme-panel" type="button">';
      html += '<span class="bk-settings-entry-icon">⚙️</span>';
      html += '<span class="bk-settings-entry-text"><span class="bk-settings-entry-label">设置</span><span class="bk-settings-entry-sub">阅读模式 · 字体大小</span></span>';
      html += '<span class="bk-settings-entry-arrow">›</span>';
      html += '</button>';

      // 内容与数据
      html += '<div class="bk-settings-section">';
      html += '<div class="bk-settings-section-title">内容与数据</div>';
      html += '<button class="bk-settings-row" data-action="bookmarks"><span class="bk-row-icon">📑</span><span class="bk-row-label">我的书签</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" data-action="clear-data"><span class="bk-row-icon">🧹</span><span class="bk-row-label">清理数据</span><span class="bk-row-arrow">›</span></button>';
      html += '</div>';
      html += '</div>'; // bk-settings-left end

      html += '<div class="bk-settings-right">';

      // 应用（按环境显示，避免无效行）
      html += '<div class="bk-settings-section">';
      html += '<div class="bk-settings-section-title">应用</div>';
      html += '<button class="bk-settings-row" data-action="install-pwa"><span class="bk-row-icon">📲</span><span class="bk-row-label">发送桌面</span><span class="bk-row-arrow">›</span></button>';
      html += '<div class="cache-status" id="meInstallStatus" style="display:none"></div>';
      if (isAndroid && !isCapacitor) {
        html += '<button class="bk-settings-row" data-action="android-apk"><span class="bk-row-icon">📱</span><span class="bk-row-label">安卓APK</span><span class="bk-row-arrow">›</span></button>';
        html += '<div class="cache-status" id="meApkStatus" style="display:none"></div>';
      }
      if (canUpdate) {
        html += '<button class="bk-settings-row" data-action="check-update"><span class="bk-row-icon">🔄</span><span class="bk-row-label">检查更新</span><span class="bk-row-arrow">›</span></button>';
      }
      html += '<button class="bk-settings-row" data-action="guide"><span class="bk-row-icon">📖</span><span class="bk-row-label">使用说明</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" data-action="feedback"><span class="bk-row-icon">💬</span><span class="bk-row-label">问题反馈</span><span class="bk-row-arrow">›</span></button>';
      html += '</div>';

      // 资源管理
      html += '<div class="bk-settings-section">';
      html += '<div class="bk-settings-section-title">资源管理</div>';
      html += '<button class="bk-settings-row" data-action="download-mgr"><span class="bk-row-icon">📥</span><span class="bk-row-label">下载管理</span><span class="bk-row-arrow">›</span></button>';
      html += '</div>';

      // 高级（内联开关）
      html += '<div class="bk-settings-section">';
      html += '<div class="bk-settings-section-title">高级</div>';
      if (canUpdate) {
        html += '<div class="pref-row"><div class="pref-label-wrap"><span class="pref-title">自动检查更新</span><span class="pref-desc">启动时自动检查是否有新版本</span></div><label class="pref-toggle"><input type="checkbox" id="meAutoCheckToggle"><span class="pref-toggle-slider"></span></label></div>';
      }
      html += '<div class="pref-row"><div class="pref-label-wrap"><span class="pref-title">开发者模式</span><span class="pref-desc">在页面底部显示调试日志</span></div><label class="pref-toggle"><input type="checkbox" id="meDevToggle"><span class="pref-toggle-slider"></span></label></div>';
      html += '</div>';

      html += '</div>'; // bk-settings-right end
      html += '</div>'; // bk-settings-grid end
      html += '</div>'; // bk-settings-page end

      app.innerHTML = html;

      // 注：阅读模式 / 字号设置已收归阅读设置弹窗（#themePanel），由上方「设置」入口打开，无需在此初始化。

      // 高级开关初始化
      if (canUpdate) {
        var ac0 = document.getElementById('meAutoCheckToggle');
        if (ac0) { try { ac0.checked = localStorage.getItem('bk_auto_check_update') === '1'; } catch (e) {} }
      }
      var dt0 = document.getElementById('meDevToggle');
      if (dt0) { try { dt0.checked = localStorage.getItem('bk_dev_mode') === '1'; } catch (e) {} }

      // 绑定功能行点击
      var rows = app.querySelectorAll('.bk-settings-row');
      for (var i = 0; i < rows.length; i++) {
        (function(row) {
          row.addEventListener('click', function() {
            var action = row.getAttribute('data-action');
            if (action === 'bookmarks') {
              if (win.BKBookmark && win.BKBookmark.showList) win.BKBookmark.showList();
            } else if (action === 'clear-data') {
              if (win.BK && win.BK.clearData) win.BK.clearData();
            } else if (action === 'download-mgr') {
              if (win.BKRenderer && win.BKRenderer.openDownloadManager) win.BKRenderer.openDownloadManager();
            } else if (action === 'install-pwa') {
              var st = document.getElementById('meInstallStatus');
              function setSt(msg, cls) { if (st) { st.textContent = msg; st.className = 'cache-status' + (cls ? ' ' + cls : ''); st.style.display = ''; } }
              if (win.BK && win.BK.installPWA) { win.BK.installPWA(); return; }
              var p = win._pwaInstallPrompt;
              if (p) { win._pwaInstallPrompt = null; p.prompt(); return; }
              if (isIOS && !isStandalone) { setSt('请点击浏览器底部「分享」按钮，选择「添加到主屏幕」'); return; }
              setSt('当前环境暂不支持自动安装，请用浏览器菜单添加到主屏幕', 'error');
            } else if (action === 'android-apk') {
              var apkSt = document.getElementById('meApkStatus');
              if (apkSt) apkSt.style.display = '';
              if (win.BKDownloadApk) win.BKDownloadApk(apkSt);
            } else if (action === 'check-update') {
              if (isCapacitor) {
                if (win.AppUpdate && win.AppUpdate.showCloudflareUpdateDialog) win.AppUpdate.showCloudflareUpdateDialog();
              } else if (win.AppUpdate && win.AppUpdate.showPwaUpdateDialog) {
                win.AppUpdate.showPwaUpdateDialog();
              }
            } else if (action === 'guide') {
              if (win.showGuideDialog) win.showGuideDialog();
            } else if (action === 'feedback') {
              if (win.showFeedbackDialog) win.showFeedbackDialog();
            }
          });
        })(rows[i]);
      }

      // 设置入口：打开阅读界面的设置弹窗（阅读模式 + 字体大小）
      var entry = app.querySelector('.bk-settings-entry');
      if (entry) {
        entry.addEventListener('click', function(e) {
          e.stopPropagation();
          if (typeof window.toggleThemePanel === 'function') {
            window.toggleThemePanel();
          } else {
            console.warn('[BK] toggleThemePanel 未就绪，设置弹窗无法打开');
          }
        });
      }

      // 高级开关绑定
      if (canUpdate) {
        var ac2 = document.getElementById('meAutoCheckToggle');
        if (ac2) ac2.addEventListener('change', function() {
          try { if (this.checked) localStorage.setItem('bk_auto_check_update', '1'); else localStorage.removeItem('bk_auto_check_update'); } catch (e) {}
        });
      }
      var dt2 = document.getElementById('meDevToggle');
      if (dt2) dt2.addEventListener('change', function() {
        var on = this.checked;
        try { localStorage.setItem('bk_dev_mode', on ? '1' : '0'); } catch (e) {}
        if (on && win.BKDevConsole) win.BKDevConsole.init();
        else if (!on && win.BKDevConsole) win.BKDevConsole.destroy();
      });

      // 异步填充统计卡
      _fillSettingsStats();
    },

    // ── 书架页（新增模块） ────────────────────────────────────────

    renderShelfPage: function () {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
      _cleanupPdfCache();
      document.body.classList.remove('bk-reading-page');
      showApp();
      var app = getApp();
      document.title = '书架';

      var html = '<div class="bk-shelf-page">';
      html += '<div class="bk-city-header">';
      html += '<h1 class="bk-city-title">书架</h1>';
      html += '<button type="button" id="shelfImportBtn" class="bk-city-search-btn" aria-label="导入">📂</button>';
      html += '</div>';
      // 继续阅读模块（决策④：阅读进度归书架，首屏顶部续读）
      html += '<div class="bk-section-header">';
      html += '<span class="bk-section-title-lg">继续阅读</span>';
      html += '<span class="bk-view-all" id="bk-continue-viewall" role="button" tabindex="0">查看全部</span>';
      html += '</div>';
      html += '<div id="bkContinueListAnchor"></div>';
      // 书架分段切换（在读 / 已读；默认在读；收藏冗余已去除）
      html += '<div class="bk-shelf-tabs" id="shelfTabs" role="tablist">';
      html += '<button type="button" class="bk-shelf-tab is-active" data-tab="reading" role="tab" aria-selected="true">在读 <span class="bk-shelf-tab-count" id="shelfCountReading">0</span></button>';
      html += '<button type="button" class="bk-shelf-tab" data-tab="read" role="tab" aria-selected="false">已读 <span class="bk-shelf-tab-count" id="shelfCountRead">0</span></button>';
      html += '</div>';
      // 我的书架
      html += '<div class="bk-section-header"><span class="bk-section-title-lg">我的书架</span></div>';
      html += '<div class="bk-shelf-list" id="shelfList"></div>';
      html += '</div>';

      app.innerHTML = html;

      // 导入按钮：打开导入对话框（支持从文件/WebDAV）
      var importBtn = document.getElementById('shelfImportBtn');
      if (importBtn) {
        importBtn.addEventListener('click', function () {
          if (win.BKResourcePack && win.BKResourcePack.showImportDialog) {
            win.BKResourcePack.showImportDialog();
          } else if (win.BKRenderer && win.BKRenderer.pickAndImport) {
            win.BKRenderer.pickAndImport();
          }
        });
      }

      // 继续阅读「查看全部」：原地展开（首屏默认最多 6 张）
      var viewAllBtn = document.getElementById('bk-continue-viewall');
      if (viewAllBtn) {
        viewAllBtn.addEventListener('click', function () { _renderContinueList(app, { expanded: true }); });
      }

      // 分段切换（在读 / 已读）：点击仅改激活桶并重渲染列表（bk-shelf-changed 监听复用）
      var tabsEl2 = document.getElementById('shelfTabs');
      if (tabsEl2) {
        tabsEl2.addEventListener('click', function (e) {
          var tab = e.target.closest('.bk-shelf-tab');
          if (!tab) return;
          _shelfActiveTab = tab.getAttribute('data-tab') || 'reading';
          _renderShelfList();
        });
      }

      // 书架行点击进入阅读：整行（封面/标题/信息）可点开书籍；行内按钮各自处理，不触发跳转
      var shelfListNav = document.getElementById('shelfList');
      if (shelfListNav) {
        shelfListNav.addEventListener('click', function (e) {
          if (e.target.closest('button')) return; // 标记/取消/移除按钮自行处理
          var row = e.target.closest('.bk-shelf-row');
          if (!row) return;
          var id = row.getAttribute('data-book-id');
          if (id && win.BKRouter && typeof win.BKRouter.navigate === 'function') {
            win.BKRouter.navigate(id);
          }
        });
        // 键盘可达：行聚焦时 Enter / 空格 打开书籍
        shelfListNav.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          if (e.target.closest('button')) return;
          var row = e.target.closest('.bk-shelf-row');
          if (!row) return;
          var id = row.getAttribute('data-book-id');
          if (id && win.BKRouter && typeof win.BKRouter.navigate === 'function') {
            e.preventDefault();
            win.BKRouter.navigate(id);
          }
        });
      }

      // 进入时整体读取 BKShelf 渲染（兜底一致）
      _renderShelfContinue(app);
      _renderShelfList();

      // 订阅 bk-shelf-changed 做就地刷新（仅注册一次）
      if (!_shelfPageChangedBound) {
        win.addEventListener('bk-shelf-changed', _shelfPageChangedHandler);
        _shelfPageChangedBound = true;
      }

      // 注册书城所需的全局监听（bk-shelf-changed 就地翻转 + 后台索引更新，仅一次）
      _registerCityGlobalHandlers();

      startScrollTracking('shelf');
      restoreScrollPosition('shelf');

      // 数据未就绪时确保 DataManager 初始化后再填充动态区
      if (!_zlDmReady) {
        _ensureDmInit().then(function () {
          _renderShelfContinue(app);
          _renderShelfList();
        }).catch(function () {});
      }
    },

    renderChapterList: function (bookId) {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
      _cleanupPdfCache();
      document.body.classList.remove('bk-reading-page');
      showApp();
      var app = getApp();
      app.innerHTML = '<div class="bk-loading"><div class="bk-spinner"></div><div>加载中...</div></div>';

      loadBook(bookId).then(function (book) {
        var chapters = _getUniqueChapters(book.chapters || []);
        var progress = getReadingProgress(bookId);

        var html = '<div class="bk-chapter-list-view">';

        // 顶部栏已移至浮动导航（nav-stack.js），不再渲染永久顶栏

        // 书籍信息头部
        html += '<div class="bk-book-header">';
        if (book.cover) {
          html += '<img class="bk-book-header-cover" src="' + escAttr(book.cover) + '" alt="' + escAttr(book.title) + '">';
        }
        html += '<h1 class="bk-book-header-title">' + escText(book.title) + '</h1>';
        if (book.author) html += '<div class="bk-book-header-author">' + escText(book.author) + '</div>';
        if (book.description) html += '<div class="bk-book-header-desc">' + escText(book.description) + '</div>';
        html += '<div class="bk-book-header-stats">';
        html += '<span class="bk-stat">' + chapters.length + ' 章</span>';
        if (progress > 0) html += '<span class="bk-stat">· 读到第' + progress + '章</span>';
        html += '</div>';
        html += '</div>';

        // 章节列表
        html += '<div class="bk-chapter-list">';
        for (var i = 0; i < chapters.length; i++) {
          var ch = chapters[i];
          var chNum = ch.number || (i + 1);
          var isCurrent = chNum === progress;
          var isRead = chNum < progress;
          var statusClass = isCurrent ? ' bk-chapter-current' : (isRead ? ' bk-chapter-read' : '');
          html += '<a class="bk-chapter-item' + statusClass + '" href="#/' + escAttr(bookId) + '/' + chNum + '">';
          html += '<span class="bk-chapter-num">' + chNum + '</span>';
          html += '<span class="bk-chapter-title">' + escText(ch.title || '第' + chNum + '章') + '</span>';
          if (isCurrent) html += '<span class="bk-chapter-badge">在读</span>';
          else if (isRead) html += '<span class="bk-chapter-status">✓</span>';
          html += '</a>';
        }
        html += '</div>';
        html += '</div>';

        app.innerHTML = html;

        var pageKey = bookId;
        startScrollTracking(pageKey);
        restoreScrollPosition(pageKey);

        // 初始化 TTS
        if (win.BKSpeech && win.BKSpeech.cancel) win.BKSpeech.cancel();
      }).catch(function (err) {
        app.innerHTML = '<div class="bk-error">' +
          '<div class="bk-error-icon">⚠️</div>' +
          '<div class="bk-error-text">加载失败: ' + escText(err.message) + '</div>' +
          '</div>';
      });
    },

    // ── 阅读视图 ────────────────────────────────────────────────────

    renderReadingView: function (bookId, chapterNum) {
      // 防止 carousel 内部导航触发重复渲染
      if (_carouselNavigating) return;

      stopScrollTracking();
      _removeReadingShortcuts();
      _removeChapterLinkHandler();
      showApp();
      var app = getApp();
      app.innerHTML = '<div class="bk-loading"><div class="bk-spinner"></div><div>加载中...</div></div>';

      loadBook(bookId).then(function (book) {
        var uniqueChapters = _getUniqueChapters(book.chapters || []);
        var chapter = null;
        var chapterIdx = -1;
        for (var i = 0; i < uniqueChapters.length; i++) {
          if (uniqueChapters[i].number === chapterNum) {
            chapter = uniqueChapters[i];
            chapterIdx = i;
            break;
          }
        }

        if (!chapter) {
          app.innerHTML = '<div class="bk-error">' +
            '<div class="bk-error-icon">⚠️</div>' +
            '<div class="bk-error-text">未找到第 ' + chapterNum + ' 章</div>' +
            '</div>';
          return;
        }

        // 保存阅读进度
        saveReadingProgress(bookId, chapterNum);

        // 缓存当前书名和章节标题（供浮动导航栏使用）
        BKRenderer._currentBookTitle = book.title || '';
        BKRenderer._currentChapterTitle = chapter.title || '';

        // 设置文档标题
        document.title = (book.title || '') + ' - ' + (chapter.title || '第' + chapterNum + '章');

        // 获取前后章节
        var prevChapter = chapterIdx > 0 ? uniqueChapters[chapterIdx - 1] : null;
        var nextChapter = chapterIdx < uniqueChapters.length - 1 ? uniqueChapters[chapterIdx + 1] : null;

        // 渲染页面结构（三页轮播 carousel）
        var html = '<div class="reading-view" id="readingView">';

        // 阅读进度条
        var totalChapters = uniqueChapters.length;
        var progressPct = totalChapters > 0 ? Math.round(chapterNum / totalChapters * 100) : 0;
        html += '<div class="bk-reading-progress">' +
          '<div class="bk-reading-progress-bar" style="width:' + progressPct + '%"></div>' +
          '</div>';

        // 三页轮播 track：prev / curr / next
        html += '<div class="bk-carousel-track">';
        html += _renderCarouselPage(prevChapter, 'Prev');
        // 当前页用 id="chapterContent" 以便 TTS/字号/高亮等模块引用
        html += '<div class="bk-carousel-page" id="carouselPageCurr">' +
          '<div class="content" id="chapterContent">' +
          renderChapterContent(chapter, true) +
          '</div></div>';
        html += _renderCarouselPage(nextChapter, 'Next');
        html += '</div>';

        // TTS 展开面板（默认隐藏，点击播放按钮展开）
        html += '<div class="bk-tts-panel" id="bkTtsPanel">';
        html += buildBottomControlBar();
        html += '</div>';

        html += '</div>';

        app.innerHTML = html;
        initPdfPageLazyRender(app);
        document.body.classList.add('bk-reading-page');
        _maybeEnterSplitMode(bookId);

        var pageKey = bookId + '/' + chapterNum;
        win.__bkCurrentPath = pageKey;
        try { localStorage.setItem('bk_last_read', bookId); } catch(e) {}
        startScrollTracking(pageKey);

        // 检查是否有书签恢复的滚动位置
        var bmScrollKey = 'bk_scroll:' + pageKey;
        var bmScrollY = 0;
        try { bmScrollY = parseInt(localStorage.getItem(bmScrollKey) || '0', 10); } catch(e) {}
        if (bmScrollY > 0) {
          requestAnimationFrame(function() {
            requestAnimationFrame(function() {
              var c = _getScrollContainer();
              if (c === win) win.scrollTo(0, bmScrollY);
              else c.scrollTop = bmScrollY;
            });
          });
        }

        // 初始化 TTS
        if (win.BKSpeech) {
          if (win.BKSpeech.cancel) win.BKSpeech.cancel();
          if (win.BKSpeech.init) {
            win.BKSpeech.init({
              getElements: function() {
                var container = document.getElementById('chapterContent');
                if (!container) return [];
                var els = [];
                var paragraphs = container.querySelectorAll('.bk-paragraph, .bk-quote-content, .bk-heading, .bk-code, li');
                for (var pi = 0; pi < paragraphs.length; pi++) {
                  els.push({ el: paragraphs[pi] });
                }
                return els;
              }
            });
          }
        }

        // 恢复划线
        if (win.BKHighlight && win.BKHighlight.rendoHighlights) {
          win.BKHighlight.rendoHighlights();
        }

        // 初始化经文弹窗
        if (win.BKScripturePopup && win.BKScripturePopup.init) {
          win.BKScripturePopup.init();
        }

        // 安装键盘快捷键 + 三页轮播滑动手势
        _installReadingShortcuts(bookId, uniqueChapters, chapterNum);
        _installCarouselSwipe(bookId, uniqueChapters, chapterNum);
        _installChapterLinkHandler(bookId);
      }).catch(function (err) {
        app.innerHTML = '<div class="bk-error">' +
          '<div class="bk-error-icon">⚠️</div>' +
          '<div class="bk-error-text">加载失败: ' + escText(err.message) + '</div>' +
          '</div>';
      });
    },

    // ── 管理模式切换（从设置面板调用）──────────────────────────

    toggleManageMode: function () {
      _manageMode = !_manageMode;

      // 进入/退出管理模式：重渲染当前可见视图，使卡片按 _manageMode 重建（删除按钮随之显隐）
      _rerenderCurrentView();

      // 关闭设置面板
      if (typeof window.toggleThemePanel === 'function') {
        var panel = document.getElementById('themePanel');
        if (panel && panel.classList.contains('show')) {
          window.toggleThemePanel();
        }
      }
    },

    // ── 打开下载管理面板（从设置面板调用）───────────────────────

    openDownloadManager: function () {
      // 关闭设置面板
      if (typeof window.toggleThemePanel === 'function') {
        var panel = document.getElementById('themePanel');
        if (panel && panel.classList.contains('show')) {
          window.toggleThemePanel();
        }
      }
      // 确保面板已挂载（全局持久元素），并等待数据就绪后再填充系列列表与统计
      _ensureDownloadPanel();
      var open = function () {
        _renderDlSeriesList();
        _toggleDownloadPanel(true);
        _refreshStorageStats();
      };
      if (_zlDmReady) open();
      else if (typeof _ensureDmInit === 'function') _ensureDmInit().then(open).catch(open);
    },

    // ── 查询管理模式状态 ──────────────────────────────────────

    isManageMode: function () {
      return _manageMode;
    },

    // ── 导入外部书籍（从设置面板调用）─────────────────────────

    pickAndImport: function () {
      if (!win.ImportManager || !win.ImportManager.pickAndImport) return;
      // 关闭设置面板
      if (typeof window.toggleThemePanel === 'function') {
        var panel = document.getElementById('themePanel');
        if (panel && panel.classList.contains('show')) {
          window.toggleThemePanel();
        }
      }
      win.ImportManager.pickAndImport().then(function(bookData) {
        if (!bookData) return;
        bookData.series = 'imported';
        var dupBook = false;
        for (var di = 0; di < _zlBooks.length; di++) {
          if (_zlBooks[di].id === bookData.id) { dupBook = true; break; }
        }
        if (!dupBook) _zlBooks.push(bookData);
        if (_zlDownloadedIds.indexOf(bookData.id) === -1) _zlDownloadedIds.push(bookData.id);
        if (!win.__bkBooks) win.__bkBooks = [];
        win.__bkBooks.push(bookData);
        if (win.BKRouter) win.BKRouter.navigate(bookData.id);
      }).catch(function(err) {
        if (err && err.message) console.error('[导入]', err.message);
      });
    },

    // ── 书城三级下钻内部回退（供 nav-stack 原生返回键调用）─────────────
    // 主轴翻转后：L3 多分类 → 回 L2 分类列表；L3 单分类隐式 / L2 分类列表 → 回 L1 系列网格。
    // 返回 true 表示已处理逐级回退，false 表示已在书城一级 / 书架（交给路由 / 浏览器后退）
    goBackInHome: function () {
      if (_cityLevel() === 3 && !_cityImplicit) {
        _cityBackToCategories(); // 多分类书籍 → 分类列表（L2）
        return true;
      }
      if (_cityLevel() >= 2) {
        _cityBackToSeries();      // 单分类隐式书籍 / 分类列表 → 系列网格（L1）
        return true;
      }
      return false;
    },

    // ── 工具方法（供 nav-stack.js 等外部模块调用）─────────────────────

    _getBookTitle: function (bookId) {
      if (_zlBooks) {
        for (var i = 0; i < _zlBooks.length; i++) {
          if (_zlBooks[i].id === bookId) return _zlBooks[i].title || '';
        }
      }
      return '';
    }
  };

  // ── 暴露 ──────────────────────────────────────────────────────────────

  win.BKRenderer = BKRenderer;

  // 暴露版式封面生成器（供 search.js 搜索结果复用）
  win.BKRenderer._coverHTML = _coverHTML;
  win.BKRenderer._cleanBookTitle = _cleanBookTitle;

  // 测试钩子（仅供单元测试直接调用，不影响运行时行为）：重同步事件分支与查书工具
  win.BKRenderer.__test = {
    doResync: _doResync,
    onResyncClick: _onResyncClick,
    findBookById: _findBookById,
    renderContentItem: renderContentItem
  };

  // 初始化目录 Drawer 全局事件（页面加载时一次）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      _initTocDrawerEvents();
      _bindResyncHandler();
    });
  } else {
    _initTocDrawerEvents();
    _bindResyncHandler();
  }

}(window));
