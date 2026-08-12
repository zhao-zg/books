'use strict';

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
  var _dlDialog = null;      // 下载管理对话框引用（BK.openDialog 返回）
  var _dlProgressTimer = null;  // 下载进度轮询定时器
  var _dlFloatEl = null;       // 下载悬浮窗 DOM 引用
  var _lastClickDownloadId = null;  // 最后一次在书城点击下载的书 ID（用于完成后判断是否自动跳转，避免并发下载时先完成者劫持导航）
  // 错误码常量（与 dm-shared.js 中保持一致，模块内独立定义避免跨模块引用）
  // ★ M5修复：将 'CANCELLED' 字面量收敛为常量，便于以后修改/统一引用。
  var ERR_CANCELLED = 'CANCELLED';
  var _manageMode = false;      // 书籍管理模式（显示删除按钮）
  var _showAppGen = 0;          // showApp 过渡动画生成计数器
  var _bkHomeClickHandler = null; // 首页事件委托处理器（用于 removeEventListener）
  var _zlIndexUpdateHandler = null; // 索引更新事件处理器（用于 removeEventListener）
  var _bkShelfChangedBound = false;   // 书城卡片全局 bk-shelf-changed 监听是否已注册（仅一次）
  var _shelfPageChangedBound = false; // 书架页全局 bk-shelf-changed 监听是否已注册（仅一次）
  var _shelfActiveTab = 'reading';   // 书架分段激活态：'reading'（在读，默认）| 'read'（已读）
  var _shelfEditing = false;         // 书架编辑（多选）态
  var _shelfSelected = {};           // 编辑态选中集合：{ bookId: true }
  var _suppressNextClick = false;    // 长按菜单打开后吞掉随后的 click，避免误跳转

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
          // 未命中导入，走 DataManager（内置书/ysz 书均走此路径）
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

      // 通过 DataManager 加载书籍（内置书/ysz 书均走此路径）
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

      // DataManager 不可用
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
          // APK/PWA：优先使用本地 bundled 索引数据，回退到同源 zl-data
          var localZlData = './zl-data';
          var cfFallbackUrls = [];
          if (cfServers.length > 0) {
            for (var si = 0; si < cfServers.length; si++) {
              cfFallbackUrls.push(cfServers[si].replace(/\/+$/, '') + '/zl-data');
            }
          }
          // APK/PWA 本地数据始终可用（APK 打包 / PWA 安装时缓存），
          // DataManager.loadIndex() 对本地路径走 localforage 缓存优先，无需探路 fetch
          dmUrl = localZlData;
          dmUrls = [localZlData].concat(cfFallbackUrls);
          console.log('[Renderer] ' + (isNativeApp ? 'APK' : 'PWA') + '模式：使用本地索引数据' + (cfFallbackUrls.length ? '，CDN 备用' : ''));
          return _setupDataManager(dmUrl, dmUrls);
        } else if (isLocal) {
          // 本地开发模式：使用 output/zl-data/（由 main.py copy_zl_merged_data 完整复制）
          // 服务器从 output/ 启动时，相对路径 ./zl-data 正确指向 zl-data/
          dmUrl = './zl-data';
          dmUrls.push(dmUrl);
          console.log('[Renderer] 本地模式：DataManager 使用 ' + dmUrl);
        } else {
          dmUrls.push(win.location.origin + '/zl-data');
          // 添加 CDN 备用地址（如有配置）
          if (cfServers.length > 0) {
            for (var bi = 0; bi < cfServers.length; bi++) {
              var cfUrl = cfServers[bi].replace(/\/+$/, '') + '/zl-data';
              if (dmUrls.indexOf(cfUrl) === -1) {
                dmUrls.push(cfUrl);
              }
            }
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
      // 内置书已走 CDN（ysz 格式 JSON），不再需要 loadEpubResources
      return _mergeImportedBooks();
    }).then(function () {
      // ★ 合并导入书籍后若当前视图可见则就地重渲染（修复时序：导入书籍含 source 属性，
      //   需重渲染才能在书架卡片上显示来源徽标）
      var _appEl = document.getElementById('app');
      if (_appEl && _appEl.style.display !== 'none') {
        if (win.location.hash.indexOf('city') !== -1) {
          if (BKRenderer.renderCityPage) BKRenderer.renderCityPage();
        } else if (BKRenderer.renderShelfPage) {
          BKRenderer.renderShelfPage();
        }
      }
      // _mergeBundledBooks 已废弃（内置书走 CDN），但保留调用避免报错
      return _mergeBundledBooks();
    }).catch(function (err) {
      console.warn('[Renderer] DataManager 初始化失败:', err.message);
      _zlDmReady = false;
      // 内置书已走 CDN，不再需要 loadEpubResources
      return _mergeImportedBooks();
    }).then(function () {
      // ★ 同 success 分支：合并导入书籍后重渲染
      var _appEl2 = document.getElementById('app');
      if (_appEl2 && _appEl2.style.display !== 'none') {
        if (win.location.hash.indexOf('city') !== -1) {
          if (BKRenderer.renderCityPage) BKRenderer.renderCityPage();
        } else if (BKRenderer.renderShelfPage) {
          BKRenderer.renderShelfPage();
        }
      }
      // _mergeBundledBooks 已废弃（内置书走 CDN），但保留调用避免报错
      return _mergeBundledBooks();
    }).catch(function (e) {
      console.warn('[Renderer] 内置书库合并失败:', e.message);
    });
  }

  // ── 容器与视图切换 ────────────────────────────────────────────────────

  function getApp() { return document.getElementById('app') || document.body; }

  function showApp() {
    var appEl = document.getElementById('app');
    // 检测 #app 是否已可见（后续重渲染场景），避免冷启动时多次重渲染反复触发淡入动画导致屏幕抖动
    var alreadyVisible = appEl && appEl.style.display !== 'none';
    if (win._bkShowApp) { win._bkShowApp(); } else {
      var h = document.getElementById('homeView');
      if (h) h.style.display = 'none';
      if (appEl) appEl.style.display = '';
    }
    // 仅在 #app 从隐藏变为可见时触发 fade-in 过渡（首次进入），后续重渲染跳过
    if (appEl && !alreadyVisible) {
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

  // rAF 合并进度条更新：scroll 高频触发时每帧最多更新一次，避免 layout thrashing
  var _progressRafPending = false;
  function _scheduleProgressUpdate() {
    if (_progressRafPending) return;
    _progressRafPending = true;
    requestAnimationFrame(function() {
      _progressRafPending = false;
      try { _updateTopReadingProgress(); } catch(e) {}
    });
  }

  function startScrollTracking(pageKey) {
    stopScrollTracking();
    _scrollPageKey = pageKey;
    _scrollSaveHandler = function() {
      // 进度条实时更新（rAF 合并）：紧跟滚动且不触发 layout thrashing
      _scheduleProgressUpdate();
      clearTimeout(_scrollSaveTimer);
      _scrollSaveTimer = setTimeout(function() {
        saveScrollPosition();
        _checkChapterScrollCompletion();
      }, 300);
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

