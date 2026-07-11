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
    var html = '<div class="bk-cover' + sizeCls + '" style="--cover-color:' + color + '" role="img" aria-label="' + escAttr(title) + '">';
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
  var _dmInitPromise = null;    // DataManager 初始化 Promise（单例）
  var _dlPanelOpen = false;     // 下载面板是否展开
  var _dlProgressTimer = null;  // 下载进度轮询定时器
  var _manageMode = false;      // 书籍管理模式（显示删除按钮）
  var _showAppGen = 0;          // showApp 过渡动画生成计数器
  var _bkHomeClickHandler = null; // 首页事件委托处理器（用于 removeEventListener）
  var _zlIndexUpdateHandler = null; // 索引更新事件处理器（用于 removeEventListener）
  var _bkShelfChangedBound = false;   // 书城卡片全局 bk-shelf-changed 监听是否已注册（仅一次）
  var _shelfPageChangedBound = false; // 书架页全局 bk-shelf-changed 监听是否已注册（仅一次）

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
        // DataManager 加载成功后，若首页可见则重新渲染为系列目录
        var homeEl = document.getElementById('homeView');
        if (homeEl && homeEl.style.display !== 'none' && _zlBooks.length > 0) {
          _zlHomeView = 'catalog';
          _renderZlHome(homeEl);
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
        html = '<h' + level + ' class="bk-heading bk-h' + level + '">' + wrapRefs(text, ctx) + '</h' + level + '>';
        break;

      case 'quote':
        html = '<blockquote class="bk-quote">' +
          '<div class="bk-quote-content">' + wrapRefs(text, ctx) + '</div>' +
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
        var ordered = item.attrs && item.attrs.ordered;
        var tag = ordered ? 'ol' : 'ul';
        html = '<' + tag + ' class="bk-list">';
        for (var i = 0; i < items.length; i++) {
          html += '<li>' + wrapRefs(items[i], ctx) + '</li>';
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

      case 'separator':
        html = '<hr class="bk-separator">';
        break;

      case 'paragraph':
      default:
        if (text) {
          html = '<p class="bk-paragraph">' + wrapRefs(text, ctx) + '</p>';
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
    } else {
      contentEl.innerHTML = '';
    }
  }

  // 滑动完成后重排页面
  function _reorderCarousel(direction) {
    if (!_carouselTrack || !_carouselPages) return;
    var prev = _carouselPages.prev;
    var curr = _carouselPages.curr;
    var next = _carouselPages.next;

    if (direction === 1) {
      // 下一章：prev=旧curr, curr=旧next, next=新下一章
      _carouselTrack.appendChild(prev);
      _carouselPages = { prev: curr, curr: next, next: prev };
    } else {
      // 上一章：prev=新上一章, curr=旧prev, next=旧curr
      _carouselTrack.insertBefore(next, prev);
      _carouselPages = { prev: next, curr: prev, next: curr };
    }
    var pageW = _carouselTrack.parentElement.offsetWidth;
    _carouselTrack.style.transform = 'translateX(' + (-pageW) + 'px)';

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

      var isAtStart = chapterNum <= (uniqueChapters[0] ? uniqueChapters[0].number : 0);
      var isAtEnd = chapterNum >= (uniqueChapters[uniqueChapters.length - 1] ? uniqueChapters[uniqueChapters.length - 1].number : 0);
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
      var targetNum = _getAdjacentChapterNum(uniqueChapters, chapterNum, direction);

      if (shouldNavigate && targetNum != null) {
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

          // 更新状态
          chapterNum = targetNum;
          _carouselChapterNum = chapterNum;

          // 更新当前页内容（curr 现在是新章节，ID 已交换为 chapterContent）
          var newChapter = _getChapter(uniqueChapters, chapterNum);
          if (newChapter) {
            var contentEl = document.getElementById('chapterContent');
            if (contentEl) {
              contentEl.innerHTML = renderChapterContent(newChapter, true);
            }
          }
          // 更新相邻页面
          _updateAdjacentPages(bookId, uniqueChapters, chapterNum);

          // 更新 URL（不触发 router 重新渲染）
          // 用 try/finally 保证 _carouselNavigating 一定复位，避免 navigate 抛异常时
          // 标志位卡死为 true，导致后续 renderReadingView 全部 early-return、carousel 被冻结
          _carouselNavigating = true;
          try {
            if (win.BKRouter) {
              win.BKRouter.navigate(bookId + '/' + chapterNum);
            } else {
              win.location.hash = '#/' + bookId + '/' + chapterNum;
            }
          } finally {
            _carouselNavigating = false;
          }

          // 更新缓存的标题和进度
          BKRenderer._currentChapterTitle = newChapter ? (newChapter.title || '') : '';
          saveReadingProgress(bookId, chapterNum);
          document.title = (BKRenderer._currentBookTitle || '') + ' - ' + (newChapter ? (newChapter.title || '第' + chapterNum + '章') : '');

          // 更新进度条
          var progressBar = document.querySelector('.bk-reading-progress-bar');
          if (progressBar) {
            var totalChapters = uniqueChapters.length;
            var progressPct = totalChapters > 0 ? Math.round(chapterNum / totalChapters * 100) : 0;
            progressBar.style.width = progressPct + '%';
          }

          // 保存“被滑走”的旧章节滚动位置（reorder 后旧当前页已变为 prev）
          if (_carouselPages && _carouselPages.prev) {
            try { localStorage.setItem('bk_scroll:' + _scrollPageKey, String(_carouselPages.prev.scrollTop || 0)); } catch(e) {}
          }

          // 切到新章节：滚动容器复位到顶部（页内滚动，不再依赖 window）
          var _sc = _getScrollContainer();
          if (_sc === win) win.scrollTo(0, 0);
          else _sc.scrollTop = 0;

          // 重新初始化依赖 DOM 的功能
          if (win.BKHighlight && win.BKHighlight.redoHighlights) win.BKHighlight.redoHighlights();
          if (win.BKScripturePopup && win.BKScripturePopup.init) win.BKScripturePopup.init();

          // 滚动监听改挂到新的当前页（reorder 后 curr 已是新章节元素），
          // 并以新章节 pageKey 记录滚动位置
          _scrollPageKey = bookId + '/' + chapterNum;
          if (_scrollSaveHandler) {
            var _oldT = _scrollTarget || win;
            _oldT.removeEventListener('scroll', _scrollSaveHandler);
            _scrollTarget = _getScrollContainer();
            _scrollTarget.addEventListener('scroll', _scrollSaveHandler, { passive: true });
          }

          // 重新绑定滑动（用新的 chapterNum）
          _installCarouselSwipe(bookId, uniqueChapters, chapterNum);
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
  function _renderZlHome(homeView) {
    var books = _zlBooks;

    if (!books.length) {
      var emptyHtml = '<div class="container">';
      emptyHtml += '<div class="header"><h1 class="logo-trigger">📖 书报</h1>';
      emptyHtml += '<p class="subtitle">电子书阅读应用</p>';
      emptyHtml += '<div class="home-header-actions">';
      emptyHtml += '<button type="button" id="bk-import-btn" class="home-action-btn">📂 导入</button>';
      emptyHtml += '</div>';
      emptyHtml += '</div>';
      emptyHtml += '<div class="content"><div class="home-status">';
      emptyHtml += '<div class="home-status-icon">📚</div>';
      emptyHtml += '<div>暂无书籍，请点击右上角导入按钮添加书籍</div>';
      emptyHtml += '</div></div></div>';
      homeView.innerHTML = emptyHtml;
      _bindZlEvents(homeView);
      return;
    }

    if (_zlHomeView === 'catalog') {
      _renderEnhancedHome(homeView);
    } else {
      _renderSeriesBookList(homeView);
    }
  }

  /**
   * 增强版主页（重构）：头部 → 继续阅读 → 书架 → 下载管理 → footer
   */
  function _renderEnhancedHome(homeView) {
    var html = '<div class="bk-home-enhanced">';

    // ── 头部：左标题「书报」+ 右搜索图标按钮 ──
    html += '<div class="bk-home-header">';
    html += '<h1 class="bk-home-title">书报</h1>';
    html += '<button type="button" id="bk-search-btn" class="bk-home-search-btn" aria-label="搜索">';
    html += '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
    html += '</button>';
    html += '</div>';

    // ── 继续阅读区 ──
    html += '<div class="bk-section-header">';
    html += '<span class="bk-section-title-lg">继续阅读</span>';
    html += '<span class="bk-view-all" id="bk-continue-viewall" role="button" tabindex="0">查看全部</span>';
    html += '</div>';
    html += '<div id="bkContinueListAnchor"></div>';

    // ── 书架区（按系列分组，由 _renderSeriesShelf 填充）──
    html += '<div id="bkShelfAnchor"></div>';

    // 底部
    html += '<div class="footer">';
    html += '<p>本站内容仅供主内圣徒交通使用</p>';
    html += '<p class="footer-meta" id="footerMeta"></p>';
    html += '</div>';
    html += '</div>'; // .bk-home-enhanced

    if (_zlDmReady) {
      html += _buildDownloadPanel();
    }

    homeView.innerHTML = html;
    _bindZlEvents(homeView);

    // 填充动态内容
    _renderContinueList(homeView);
    _renderSeriesShelf(homeView);
  }

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

    // 无阅读历史 → 引导卡（整卡点击滚动到书架）
    if (all.length === 0) {
      anchor.innerHTML =
        '<a class="bk-continue-card bk-continue-welcome" href="#bkShelfAnchor">' +
          '<div class="bk-continue-info">' +
            '<div class="bk-continue-title">选择一个系列开始</div>' +
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

  /**
   * 渲染书架：按系列分组渲染到 #bkShelfAnchor（复用 _buildBookCard）。
   * 每个可见系列单独成区，最后以「未分类」区收纳无有效系列的孤儿书。
   * 不做数量上限，渲染全部书籍。
   */
  function _renderSeriesShelf(homeView) {
    var anchor = homeView.querySelector('#bkShelfAnchor');
    if (!anchor) return;
    var merged = _getMergedSeries();
    var html = '';

    for (var i = 0; i < merged.series.length; i++) {
      var s = merged.series[i];
      var list = _getSeriesBooks(s.id);
      if (!list.length) continue;
      var bookCount = merged.bookCount[s.id] || 0;
      if (s.id === _PICKUP_SERIES_ID && merged.mergedCount > 0) bookCount = s.count;
      var displayTitle = _displaySeriesTitle ? _displaySeriesTitle(s.title) : s.title;
      html += '<section class="bk-series-block" data-series="' + escAttr(s.id) + '">';
      html += '<div class="bk-section-header">';
      html += '<span class="bk-section-title-lg">' + escText(displayTitle) + '</span>';
      html += '<span class="bk-series-count">' + bookCount + ' 本</span>';
      html += '</div>';
      html += '<div class="book-grid">';
      for (var j = 0; j < list.length; j++) html += _buildBookCard(list[j]);
      html += '</div>';
      html += '</section>';
    }

    var orphans = _getOrphanBooks();
    if (orphans.length) {
      html += '<section class="bk-series-block bk-series-block--orphan">';
      html += '<div class="bk-section-header">';
      html += '<span class="bk-section-title-lg">未分类</span>';
      html += '<span class="bk-series-count">' + orphans.length + ' 本</span>';
      html += '</div>';
      html += '<div class="book-grid">';
      for (var k = 0; k < orphans.length; k++) html += _buildBookCard(orphans[k]);
      html += '</div>';
      html += '</section>';
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

    for (var i = 0; i < _zlSeries.length; i++) {
      var s = _zlSeries[i];
      var count = seriesBookCount[s.id] || 0;
      if (count < _MIN_SERIES_BOOKS && !_PROTECTED_SERIES[s.id]) {
        mergedCount += count;
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

    return { series: visibleSeries, bookCount: seriesBookCount, mergedCount: mergedCount };
  }

  // 获取某系列的书籍列表（考虑合并）
  function _getSeriesBooks(seriesId) {
    var books = [];
    if (seriesId === _PICKUP_SERIES_ID) {
      // 拾遗系列：包含原始拾遗书籍 + 被合并的小系列书籍
      var mergedSeriesIds = {};
      var seriesBookCount = {};
      for (var i = 0; i < _zlBooks.length; i++) {
        var sid = _zlBooks[i].series;
        seriesBookCount[sid] = (seriesBookCount[sid] || 0) + 1;
      }
      for (var i = 0; i < _zlSeries.length; i++) {
        var s = _zlSeries[i];
        var count = seriesBookCount[s.id] || 0;
        if (count < _MIN_SERIES_BOOKS && !_PROTECTED_SERIES[s.id]) {
          mergedSeriesIds[s.id] = true;
        }
      }
      for (var i = 0; i < _zlBooks.length; i++) {
        if (_zlBooks[i].series === _PICKUP_SERIES_ID || mergedSeriesIds[_zlBooks[i].series]) {
          books.push(_zlBooks[i]);
        }
      }
    } else {
      for (var i = 0; i < _zlBooks.length; i++) {
        if (_zlBooks[i].series === seriesId) books.push(_zlBooks[i]);
      }
    }
    return books;
  }

  /**
   * 取所有「孤儿书」——即 .series 为空或不是已知系列 id 的书籍。
   * 这些书不属于任何可见系列，应在「未分类」区统一收纳。
   * @returns {Array<Object>} 孤儿书列表
   */
  function _getOrphanBooks() {
    var known = {};
    for (var i = 0; i < _zlSeries.length; i++) known[_zlSeries[i].id] = true;
    var orphans = [];
    for (var i = 0; i < _zlBooks.length; i++) {
      var sid = _zlBooks[i].series;
      if (!sid || !known[sid]) orphans.push(_zlBooks[i]);
    }
    return orphans;
  }

  /**
   * 渲染系列卡片目录（首页默认视图）
   */
  function _renderSeriesCatalog(homeView) {
    var merged = _getMergedSeries();
    var totalBooks = _zlBooks.length;
    var totalSeries = merged.series.length;

    var html = '<div class="container">';

    // 头部
    html += '<div class="header">';
    html += '<h1 class="logo-trigger">📖 书报</h1>';
    html += '<p class="subtitle">' + totalSeries + ' 个系列 · ' + totalBooks + ' 本书</p>';
    html += '<div class="home-header-actions">';
    html += '<button type="button" id="bk-search-btn" class="home-action-btn btn-search">🔍 搜索</button>';
    html += '</div>';
    html += '</div>';

    // 系列卡片网格
    html += '<div class="series-catalog-grid">';
    for (var i = 0; i < merged.series.length; i++) {
      var s = merged.series[i];
      var bookCount = merged.bookCount[s.id] || 0;
      // 如果是拾遗系列，使用合并后的计数
      if (s.id === _PICKUP_SERIES_ID && merged.mergedCount > 0) {
        bookCount = s.count;
      }
      var displayTitle = _displaySeriesTitle ? _displaySeriesTitle(s.title) : s.title;
      html += '<div class="series-catalog-card" data-series="' + escAttr(s.id) + '" style="--series-color:' + _getSeriesColor(s.id) + '">';
      html += '<div class="series-catalog-card-title">' + escText(displayTitle) + '</div>';
      html += '<div class="series-catalog-card-count">' + bookCount + ' 本</div>';
      html += '</div>';
    }
    html += '</div>';

    // 底部
    html += '<div class="footer">';
    html += '<p>本站内容仅供主内圣徒交通使用</p>';
    html += '<p class="footer-meta" id="footerMeta"></p>';
    html += '</div>';
    html += '</div>';

    if (_zlDmReady) {
      html += _buildDownloadPanel();
    }

    homeView.innerHTML = html;
    _bindZlEvents(homeView);
  }

  /**
   * 渲染系列书籍列表视图（点击系列卡片后进入）
   */
  function _renderSeriesBookList(homeView) {
    var seriesTitle = _getSeriesTitle(_zlCurrentSeries);

    var html = '<div class="container">';

    // 精简头部：返回按钮 + 系列名称
    html += '<div class="header series-list-header">';
    html += '<div class="series-back-row">';
    html += '<button type="button" class="series-back-btn" id="seriesBackBtn" title="返回系列目录">';
    html += '<span class="series-back-icon">←</span>';
    html += '</button>';
    html += '<div class="series-list-titles">';
    html += '<h1 class="logo-trigger series-list-title">' + escText(seriesTitle) + '</h1>';
    html += '<p class="subtitle">📖 书报</p>';
    html += '</div>';
    html += '</div>';
    html += '<div class="home-header-actions">';
    html += '<button type="button" id="bk-search-btn" class="home-action-btn btn-search">🔍 搜索</button>';
    html += '</div>';
    html += '</div>';

    // 书籍网格（复用现有逻辑，含 books 系列二级分类导航）
    html += _buildBookGrid(_zlCurrentSeries);

    // 底部
    html += '<div class="footer">';
    html += '<p>本站内容仅供主内圣徒交通使用</p>';
    html += '<p class="footer-meta" id="footerMeta"></p>';
    html += '</div>';
    html += '</div>';

    if (_zlDmReady) {
      html += _buildDownloadPanel();
    }

    homeView.innerHTML = html;
    _bindZlEvents(homeView);
  }

  /**
   * 构建系列标签栏 HTML
   */
  function _buildSeriesTabs() {
    var merged = _getMergedSeries();
    var html = '<div class="series-tabs" id="seriesTabs">';
    for (var i = 0; i < merged.series.length; i++) {
      var s = merged.series[i];
      var active = _zlCurrentSeries === s.id ? ' active' : '';
      html += '<button class="series-tab' + active + '" data-series="' + escAttr(s.id) + '">' + escText(_displaySeriesTitle(s.title)) + '</button>';
    }
    html += '</div>';
    return html;
  }

  /**
   * 构建单个书籍卡片 HTML（纯函数，消除重复代码）
   */
  function _buildBookCard(book) {
    var downloaded = _isBookDownloaded(book.id);
    var seriesTitle = _getSeriesTitle(book.series);
    var isRead = (win.BKShelf && win.BKShelf.isRead) ? win.BKShelf.isRead(book.id) : false;
    var chapterCount = book.chapter_count || 0;
    var progress = getReadingProgress(book.id);
    var progressPct = (progress > 0 && chapterCount > 0) ? Math.round(progress / chapterCount * 100) : 0;

    var html = '<div class="book-card zl-book-card' + (isRead ? ' is-read' : '') + '" data-book-id="' + escAttr(book.id) + '" data-series="' + escAttr(book.series) + '" style="--series-color:' + _getSeriesColor(book.series) + '">';
    html += '<div class="book-card-wrapper">';
    html += '<div class="book-link" data-book-id="' + escAttr(book.id) + '" data-series="' + escAttr(book.series) + '" role="button" tabindex="0">';
    html += _coverHTML(book, { size: 'md', seriesTitle: _getSeriesTitle(book.series) });
    html += '<div class="book-info">';
    html += '<div class="book-header">';
    html += '<div class="book-title-row">';
    html += '<span class="bk-series-dot" style="background:' + _getSeriesColor(book.series) + '"></span>';
    html += '<div class="title">' + escText(_cleanBookTitle(book.title)) + '</div>';
    html += '<span class="cache-status" style="color:' + (downloaded ? '#4caf50' : '#999') + ';font-size:0.75em;">' + (downloaded ? '✓' : '☁') + '</span>';
    html += '</div>';
    html += '</div>';
    if (seriesTitle) {
      html += '<div class="series-tag">' + escText(seriesTitle) + '</div>';
    }
    html += '<div class="chapter-count">共 ' + chapterCount + ' 章';
    if (progress > 0) {
      html += ' · 读到第' + progress + '章';
    }
    html += '</div>';
    // 阅读进度条
    if (progressPct > 0) {
      html += '<div class="reading-progress"><div class="reading-progress-fill" style="width:' + progressPct + '%"></div></div>';
    }
    // 书架状态区（已读/未读徽标 + 标记已读按钮），零耦合搜索
    html += _buildShelfBadge(book);
    html += '</div>';
    html += '</div>';
    html += '</div>';
    // 删除按钮（管理模式或导入书籍）
    if (_manageMode || book.series === 'imported' || book.id.indexOf('imported-') === 0) {
      html += '<button type="button" class="imported-delete-btn" data-book-id="' + escAttr(book.id) + '" title="删除">✕</button>';
    }
    // 重新同步按钮（仅 WebDAV 导入的书；与删除按钮并列，非 webdav 书不受影响）
    if (book.source && book.source.type === 'webdav') {
      html += '<button type="button" class="bk-resync-btn" data-book-id="' + escAttr(book.id) + '" title="重新同步">↻</button>';
    }
    html += '</div>';
    return html;
  }

  // 用更新后的 book 对象原地刷新某张卡片（重同步后保留 id，仅替换 DOM）
  function _refreshBookCardById(bookId, updatedBook) {
    function _replaceIn(arr) {
      if (!arr) return;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].id === bookId) { arr[i] = updatedBook; return; }
      }
    }
    _replaceIn(_zlBooks);
    _replaceIn(win.__bkBooks);
    var homeView = document.getElementById('homeView');
    if (!homeView) return;
    var card = homeView.querySelector('.zl-book-card[data-book-id="' + bookId + '"]');
    if (!card || !card.parentNode) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = _buildBookCard(updatedBook);
    var newCard = tmp.firstChild;
    if (newCard) card.parentNode.replaceChild(newCard, card);
  }

  /**
   * 根据当前系列过滤构建书籍网格 HTML
   */
  function _buildBookGrid(seriesFilter) {
    var filtered = _getSeriesBooks(seriesFilter);

    if (!filtered.length) {
      return '<div class="book-grid" id="bookGrid"><div class="home-status">该系列暂无书籍</div></div>';
    }

    // 职事书报系列：二级类型目录导航
    if (seriesFilter === 'books') {
      // 一级：类型目录页
      if (_zlCurrentCategory === null) {
        // 从书籍数据中聚合类型信息（保持出现顺序）
        var catMap = {};
        var catOrder = [];
        for (var i = 0; i < filtered.length; i++) {
          var book = filtered[i];
          var cat = book.category || '';
          var prefix = book.category_prefix || '';
          if (!cat) continue;
          var key = prefix + '-' + cat;
          if (!catMap[key]) {
            catMap[key] = { prefix: prefix, name: cat, count: 0 };
            catOrder.push(key);
          }
          catMap[key].count++;
        }
        if (catOrder.length > 0) {
          var html = '<div class="category-grid" id="bookGrid">';
          for (var ci = 0; ci < catOrder.length; ci++) {
            var c = catMap[catOrder[ci]];
            html += '<div class="category-card" data-category="' + escAttr(c.name) + '" data-category-prefix="' + escAttr(c.prefix) + '">';
            html += '<div class="category-card-title">' + escText(c.prefix) + '-' + escText(c.name) + '</div>';
            html += '<div class="category-card-count">' + c.count + ' 本</div>';
            html += '</div>';
          }
          html += '</div>';
          return html;
        }
        // 如果没有类型信息（旧数据），回退到平铺显示
      } else {
        // 二级：显示该类型下的书籍
        var catFiltered = [];
        for (var i = 0; i < filtered.length; i++) {
          if (filtered[i].category === _zlCurrentCategory && filtered[i].category_prefix === _zlCurrentCategoryPrefix) catFiltered.push(filtered[i]);
        }
        var html = '<div class="book-grid" id="bookGrid">';
        for (var i = 0; i < catFiltered.length; i++) {
          html += _buildBookCard(catFiltered[i]);
        }
        html += '</div>';
        return html;
      }
    }

    // 非 books 系列：平铺渲染
    var html = '<div class="book-grid" id="bookGrid">';
    for (var i = 0; i < filtered.length; i++) {
      html += _buildBookCard(filtered[i]);
    }
    html += '</div>';
    return html;
  }

  /**
   * 构建批量下载面板 HTML
   */
  function _buildDownloadPanel() {
    var html = '<div class="download-panel' + (_dlPanelOpen ? ' open' : '') + '" id="downloadPanel">';
    html += '<div class="download-panel-header">';
    html += '<span class="download-panel-title">📥 下载管理</span>';
    html += '<button class="download-panel-close" id="dlPanelClose">✕</button>';
    html += '</div>';

    // 概览统计卡（设计稿 22:3 管理面板概览）
    html += '<div class="dl-overview" id="dlOverview">';
    html += '<div class="dl-ov-item"><div class="dl-ov-num" id="dlOvCached">–</div><div class="dl-ov-label">已缓存</div></div>';
    html += '<div class="dl-ov-item"><div class="dl-ov-num" id="dlOvSize">–</div><div class="dl-ov-label">占用</div></div>';
    html += '<div class="dl-ov-item"><div class="dl-ov-num" id="dlOvSeries">–</div><div class="dl-ov-label">系列</div></div>';
    html += '</div>';

    // 资源检查摘要
    html += '<div class="bk-resource-summary" id="dlResourceSummary" style="padding:8px 12px;margin-bottom:8px;font-size:0.8125em;color:#666;background:#f5f5f5;border-radius:6px;">资源统计加载中...</div>';

    // 存储统计
    html += '<div class="download-storage-info" id="dlStorageInfo">存储统计加载中...</div>';

    // 下载进度条
    html += '<div class="download-progress" id="dlProgressWrap" style="display:none">';
    html += '<div class="download-progress-bar" id="dlProgressBar" style="width:0%"></div>';
    html += '</div>';
    html += '<div class="download-progress-text" id="dlProgressText" style="display:none"></div>';

    // 下载控制按钮
    html += '<div class="download-controls" id="dlControls" style="display:none">';
    html += '<button class="dl-ctrl-btn" id="dlPauseBtn">暂停</button>';
    html += '<button class="dl-ctrl-btn" id="dlCancelBtn">取消</button>';
    html += '</div>';

    // 系列下载列表
    html += '<div class="download-series-list">';
    var merged = _getMergedSeries();
    for (var i = 0; i < merged.series.length; i++) {
      var s = merged.series[i];
      var bookCount = (s.id === _PICKUP_SERIES_ID && merged.mergedCount > 0) ? s.count : (merged.bookCount[s.id] || 0);
      html += '<div class="download-series-row">';
      html += '<span class="download-series-name">' + escText(_displaySeriesTitle(s.title)) + ' (' + bookCount + '本)</span>';
      html += '<span class="series-cache-info" data-series="' + escAttr(s.id) + '"></span>';
      html += '<button class="download-series-btn" data-series="' + escAttr(s.id) + '">下载</button>';
      html += '</div>';
    }
    html += '</div>';

    // 全部下载
    html += '<button class="download-all-btn" id="dlAllBtn">全部下载</button>';

    // 清除全部缓存
    html += '<button class="bk-btn" id="dlClearAllBtn" style="background:#f44336;color:#fff;">清除全部缓存</button>';
    html += '</div>';

    // 遮罩
    html += '<div class="download-panel-overlay' + (_dlPanelOpen ? ' open' : '') + '" id="dlOverlay"></div>';
    return html;
  }

  /**
   * 绑定首页事件（事件委托：在容器上绑定一次，覆盖所有交互元素）
   */
  function _bindZlEvents(homeView) {
    // 先移除旧的委托处理器（防止重复绑定）
    if (_bkHomeClickHandler) {
      homeView.removeEventListener('click', _bkHomeClickHandler);
      _bkHomeClickHandler = null;
    }

    var clickHandler = function(e) {
      // 0a. 系列目录卡片点击（进入系列书籍列表）
      var seriesCatalogCard = e.target.closest ? e.target.closest('.series-catalog-card') : null;
      if (seriesCatalogCard) {
        e.preventDefault();
        _zlCurrentSeries = seriesCatalogCard.getAttribute('data-series');
        _zlHomeView = 'series';
        _zlCurrentCategory = null;
        _zlCurrentCategoryPrefix = null;
        _renderZlHome(homeView);
        return;
      }

      // 0b. 返回按钮（动态：分类视图→返回类型目录 / 否则→返回系列目录）
      if (e.target.closest && e.target.closest('#seriesBackBtn')) {
        if (_zlCurrentCategory) {
          // 在类型书籍二级页面 → 返回类型目录（一级）
          _zlCurrentCategory = null;
          _zlCurrentCategoryPrefix = null;
          var gridContainer = document.getElementById('bookGrid');
          if (gridContainer && gridContainer.parentNode) {
            var newGrid = _buildBookGrid(_zlCurrentSeries);
            var tmp = document.createElement('div');
            tmp.innerHTML = newGrid;
            gridContainer.parentNode.replaceChild(tmp.firstChild, gridContainer);
          }
          // 恢复标题为系列名称
          var titleEl = homeView.querySelector('.series-list-title');
          if (titleEl) titleEl.textContent = _getSeriesTitle(_zlCurrentSeries);
        } else {
          // 在系列书籍列表 → 返回系列目录
          _zlHomeView = 'catalog';
          _zlCurrentCategory = null;
          _zlCurrentCategoryPrefix = null;
          _renderZlHome(homeView);
        }
        return;
      }

      // 1. 系列标签点击
      var tab = e.target.closest ? e.target.closest('.series-tab') : null;
      if (tab) {
        e.preventDefault();
        var seriesId = tab.getAttribute('data-series');
        _zlCurrentSeries = seriesId;
        _zlCurrentCategory = null;
        _zlCurrentCategoryPrefix = null;
        var allTabs = homeView.querySelectorAll('.series-tab');
        for (var j = 0; j < allTabs.length; j++) {
          allTabs[j].className = 'series-tab' + (allTabs[j].getAttribute('data-series') === seriesId ? ' active' : '');
        }
        var gridContainer = document.getElementById('bookGrid');
        if (gridContainer && gridContainer.parentNode) {
          var newGrid = _buildBookGrid(seriesId);
          var tmp = document.createElement('div');
          tmp.innerHTML = newGrid;
          gridContainer.parentNode.replaceChild(tmp.firstChild, gridContainer);
        }
        return;
      }

      // 1.5a 类型卡片点击（进入二级目录）
      var catCard = e.target.closest ? e.target.closest('.category-card') : null;
      if (catCard) {
        _zlCurrentCategory = catCard.getAttribute('data-category');
        _zlCurrentCategoryPrefix = catCard.getAttribute('data-category-prefix');
        var gridContainer = document.getElementById('bookGrid');
        if (gridContainer && gridContainer.parentNode) {
          var newGrid = _buildBookGrid(_zlCurrentSeries);
          var tmp = document.createElement('div');
          tmp.innerHTML = newGrid;
          gridContainer.parentNode.replaceChild(tmp.firstChild, gridContainer);
        }
        // 更新标题为分类名称
        var titleEl = homeView.querySelector('.series-list-title');
        if (titleEl) titleEl.textContent = _zlCurrentCategoryPrefix + '-' + _zlCurrentCategory;
        return;
      }

      // 2. 「标记已读」按钮点击（须在 .book-link 之前判定：按钮是 .book-link 的后代）
      // 写 BKShelf，由全局 bk-shelf-changed 监听就地翻转卡片，不整页刷新。
      var markReadBtn = e.target.closest ? e.target.closest('.bk-mark-read-btn') : null;
      if (markReadBtn) {
        e.preventDefault();
        e.stopPropagation();
        var mrBookId = markReadBtn.getAttribute('data-book-id');
        if (mrBookId && win.BKShelf && win.BKShelf.add) {
          win.BKShelf.add(mrBookId);
        }
        return;
      }

      // 3. 书籍卡片点击（.book-link）
      var bookLink = e.target.closest ? e.target.closest('.book-link[data-book-id]') : null;
      if (bookLink) {
        e.preventDefault();
        var bookId = bookLink.getAttribute('data-book-id');
        var series = bookLink.getAttribute('data-series');
        _handleBookClick(bookId, series, bookLink);
        return;
      }

      // 3. 删除按钮点击
      var delBtn = e.target.closest ? e.target.closest('.imported-delete-btn') : null;
      if (delBtn) {
        e.stopPropagation();
        var delBookId = delBtn.getAttribute('data-book-id');
        if (!delBookId) return;
        delBtn.disabled = true;
        delBtn.textContent = '...';
        var doDelete = function() {
          for (var i = _zlBooks.length - 1; i >= 0; i--) {
            if (_zlBooks[i].id === delBookId) { _zlBooks.splice(i, 1); break; }
          }
          var dlIdx = _zlDownloadedIds.indexOf(delBookId);
          if (dlIdx !== -1) _zlDownloadedIds.splice(dlIdx, 1);
          if (win.__bkBooks) {
            for (var j = win.__bkBooks.length - 1; j >= 0; j--) {
              if (win.__bkBooks[j].id === delBookId) { win.__bkBooks.splice(j, 1); break; }
            }
          }
          // 局部 DOM 更新：移除对应卡片
          var cardEl = null;
          var allCards = homeView.querySelectorAll('.zl-book-card');
          for (var ci = 0; ci < allCards.length; ci++) {
            if (allCards[ci].getAttribute('data-book-id') === delBookId) { cardEl = allCards[ci]; break; }
          }
          if (cardEl) cardEl.parentNode.removeChild(cardEl);
          // 如果当前系列下没有书籍了，回到系列目录
          var grid = homeView.querySelector('.book-grid');
          if (grid && grid.querySelectorAll('.zl-book-card').length === 0) {
            _zlHomeView = 'catalog';
            _zlCurrentCategory = null;
            _zlCurrentCategoryPrefix = null;
            _renderZlHome(homeView);
          }
        };
        if (delBookId.indexOf('imported-') === 0 && win.ImportManager && win.ImportManager.deleteImportedBook) {
          win.ImportManager.deleteImportedBook(delBookId).then(doDelete).catch(function() { doDelete(); });
        } else if (delBookId.indexOf('imported-') !== 0 && win.DataManager && win.DataManager.deleteBook) {
          win.DataManager.deleteBook(delBookId).then(doDelete).catch(function() { doDelete(); });
        } else {
          doDelete();
        }
        return;
      }

      // 4. 重新同步按钮点击（仅 WebDAV 导入的书；非 webdav 书无此按钮，不受影响）
      var resyncBtn = e.target.closest ? e.target.closest('.bk-resync-btn') : null;
      if (resyncBtn) {
        e.stopPropagation();
        var rsBookId = resyncBtn.getAttribute('data-book-id');
        if (!rsBookId) return;
        // 取最新 book 对象（内存优先，回退到 __bkBooks）
        var rsBook = null;
        for (var rbi = 0; rbi < _zlBooks.length; rbi++) {
          if (_zlBooks[rbi] && _zlBooks[rbi].id === rsBookId) { rsBook = _zlBooks[rbi]; break; }
        }
        if (!rsBook && win.__bkBooks) {
          for (var rbj = 0; rbj < win.__bkBooks.length; rbj++) {
            if (win.__bkBooks[rbj] && win.__bkBooks[rbj].id === rsBookId) { rsBook = win.__bkBooks[rbj]; break; }
          }
        }
        if (!rsBook) return;
        resyncBtn.disabled = true;
        resyncBtn.textContent = '…';
        if (win.WebDavManager && win.WebDavManager.resyncBook) {
          win.WebDavManager.resyncBook(rsBook).then(function (updated) {
            resyncBtn.disabled = false;
            resyncBtn.textContent = '↻';
            _refreshBookCardById(rsBookId, updated);
          }).catch(function (err) {
            resyncBtn.disabled = false;
            resyncBtn.textContent = '↻';
            alert('重新同步失败：' + (err && err.message ? err.message : err));
          });
        } else {
          resyncBtn.disabled = false;
          resyncBtn.textContent = '↻';
        }
        return;
      }

      // 5. 下载面板关闭
      if (e.target.closest && e.target.closest('#dlPanelClose')) {
        _toggleDownloadPanel(false);
        return;
      }

      // 6. 下载面板遮罩
      if (e.target.closest && e.target.closest('#dlOverlay')) {
        _toggleDownloadPanel(false);
        return;
      }

      // 7. 系列下载按钮
      var seriesDlBtn = e.target.closest ? e.target.closest('.download-series-btn') : null;
      if (seriesDlBtn) {
        var dlSeriesId = seriesDlBtn.getAttribute('data-series');
        _startSeriesDownload(dlSeriesId);
        return;
      }

      // 8. 全部下载
      if (e.target.closest && e.target.closest('#dlAllBtn')) {
        _startAllDownload();
        return;
      }

      // 8.5 清除全部缓存
      if (e.target.closest && e.target.closest('#dlClearAllBtn')) {
        if (confirm('确定清除所有已缓存的书籍数据吗？')) {
          if (win.DataManager && win.DataManager.clearAllBooks) {
            win.DataManager.clearAllBooks().then(function () {
              location.reload();
            }).catch(function (err) {
              console.error('[Renderer] 清除缓存失败:', err);
              alert('清除缓存失败: ' + (err.message || err));
            });
          }
        }
        return;
      }

      // 9. 暂停按钮
      if (e.target.closest && e.target.closest('#dlPauseBtn')) {
        var status = win.DataManager.getDownloadStatus();
        if (status.isPaused) {
          win.DataManager.resumeDownload();
          e.target.closest('#dlPauseBtn').textContent = '暂停';
        } else {
          win.DataManager.pauseDownload();
          e.target.closest('#dlPauseBtn').textContent = '恢复';
        }
        return;
      }

      // 10. 取消按钮
      if (e.target.closest && e.target.closest('#dlCancelBtn')) {
        win.DataManager.cancelDownload();
        _stopProgressPolling();
        return;
      }

      // 11. 搜索按钮
      if (e.target.closest && e.target.closest('#bk-search-btn')) {
        if (win.BKSearch && win.BKSearch.open) win.BKSearch.open();
        return;
      }

      // 11.5 引导卡（无阅读历史）→ 滚动到书架区
      var welcomeCard = e.target.closest ? e.target.closest('.bk-continue-welcome') : null;
      if (welcomeCard) {
        e.preventDefault();
        var shelfAnchor = homeView.querySelector('#bkShelfAnchor');
        if (shelfAnchor) shelfAnchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }

      // 11.6 继续阅读「查看全部」→ 原地展开并滚动到该区
      var viewAllBtn = e.target.closest ? e.target.closest('#bk-continue-viewall') : null;
      if (viewAllBtn) {
        _renderContinueList(homeView, { expanded: true });
        var listAnchor = homeView.querySelector('#bkContinueListAnchor');
        if (listAnchor) listAnchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }

      // 12. 空状态页导入按钮
      if (e.target.closest && e.target.closest('#bk-import-btn')) {
        if (BKRenderer && BKRenderer.pickAndImport) BKRenderer.pickAndImport();
        return;
      }
    };

    homeView.addEventListener('click', clickHandler);
    _bkHomeClickHandler = clickHandler;

    // 监听 DataManager 索引更新事件（后台拉取到新数据时自动刷新）
    if (_zlIndexUpdateHandler) {
      document.removeEventListener('zl:index-updated', _zlIndexUpdateHandler);
    }
    _zlIndexUpdateHandler = function () {
      if (win.DataManager) {
        var newIndex = win.DataManager.getCachedIndex();
        if (newIndex && newIndex.books) {
          _zlIndex = newIndex;
          _zlSeries = newIndex.series || [];
          _zlBooks = newIndex.books || [];
          var homeEl = document.getElementById('homeView');
          if (homeEl && homeEl.style.display !== 'none' && _zlBooks.length > 0) {
            _renderZlHome(homeEl);
          }
        }
      }
    };
    document.addEventListener('zl:index-updated', _zlIndexUpdateHandler);

    // 注册全局 bk-shelf-changed 监听（仅一次）：书城卡片就地翻转
    if (!_bkShelfChangedBound && win.BKShelf) {
      win.addEventListener('bk-shelf-changed', _bkShelfChangedHandler);
      _bkShelfChangedBound = true;
    }

    startScrollTracking('home');
    restoreScrollPosition('home');
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
        if (iconEl) { iconEl.textContent = '✓'; iconEl.style.color = '#4caf50'; }
        if (cardEl2) cardEl2.removeAttribute('data-downloading');
        // 导航到书籍
        if (win.BKRouter) win.BKRouter.navigate(bookId);
      })
      .catch(function (err) {
        console.error('[Renderer] 书籍下载失败:', err);
        if (iconEl) { iconEl.textContent = '✗'; iconEl.style.color = '#f44336'; }
        if (cardEl2) cardEl2.removeAttribute('data-downloading');
        setTimeout(function () { if (iconEl) { iconEl.textContent = '☁'; iconEl.style.color = '#999'; } }, 2000);
      });
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
          infoEls[j].style.color = s.cached === s.total && s.total > 0 ? '#4caf50' : '#999';
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
            statusEl.style.color = isDown ? '#4caf50' : '#999';
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
          var count = (bms && Array.isArray(bms)) ? bms.length : 0;
          var el = document.getElementById('meStatBookmarks');
          if (el) el.textContent = count;
        }).catch(function () {});
      }
    } catch (e) {}
  }

  /**
   * 异步加载书签列表整页数据（从 localforage 读取 bookmarks）
   */
  function _loadBookmarksPage() {
    var list = document.getElementById('bmList');
    var count = document.getElementById('bmCount');
    if (!list) return;

    list.innerHTML = '<div class="bk-loading" style="padding:40px"><div class="bk-spinner"></div><div>加载中...</div></div>';

    try {
      if (win.BKBookmark && win.BKBookmark.getAll) {
        win.BKBookmark.getAll().then(function (items) {
          items = (items && Array.isArray(items)) ? items : [];
          if (count) count.textContent = items.length + ' 个书签';
          if (items.length === 0) {
            list.innerHTML = '<div class="bk-empty-state" style="padding:48px 20px;text-align:center;color:var(--text-muted)"><div style="font-size:40px;margin-bottom:8px">🔖</div><div>暂无书签</div></div>';
            return;
          }
          var html = '<div class="bk-bookmark-grid">';
          for (var i = items.length - 1; i >= 0; i--) {
            var bm = items[i];
            var color = bm.color || 'var(--brand)';
            html += '<a class="bk-bookmark-card" href="#/' + escAttr(bm.bookId || '') + '/' + (bm.chapterNum || 1) + '">';
            html += '<div class="bk-bm-color-bar" style="background:' + color + '"></div>';
            html += '<div class="bk-bm-body">';
            html += '<div class="bk-bm-title">' + escText(bm.title || '') + '</div>';
            html += '<div class="bk-bm-meta">' + escText(bm.bookId || '') + ' · 第' + (bm.chapterNum || 1) + '章</div>';
            if (bm.note) html += '<div class="bk-bm-note">' + escText(bm.note.substring(0, 60)) + '</div>';
            html += '<div class="bk-bm-time">' + (bm.timestamp ? new Date(bm.timestamp).toLocaleDateString() : '') + '</div>';
            html += '</div></a>';
          }
          html += '</div>';
          list.innerHTML = html;
        }).catch(function () {
          list.innerHTML = '<div class="bk-error" style="padding:24px 0;text-align:center;color:var(--text-muted)">加载失败</div>';
        });
      } else {
        list.innerHTML = '<div class="bk-empty-state" style="padding:48px 20px;text-align:center;color:var(--text-muted)"><div>书签模块未就绪</div></div>';
      }
    } catch (e) {
      list.innerHTML = '<div class="bk-error">加载异常</div>';
    }
  }

  /**
   * 字号选择器独立弹窗（设计稿 10:1）
   * 居中模态，分段控件+步进器+滑块+衬线预览+确认取消
   */
  function _openFontSizeDialog() {
    var sizes = [14,15,16,18,20,22,24,26];
    var curSize = 16;
    try { curSize = parseInt(localStorage.getItem('globalFontSize') || '16', 10); } catch(e) {}
    var curIdx = sizes.indexOf(curSize);
    if (curIdx < 0) curIdx = 2;

    var html =
      '<div class="bk-dialog-mask">' +
      '<div class="bk-dialog bk-fontsize-dialog">' +
        '<div class="bk-dialog-header"><span class="bk-dialog-title">字体大小</span><button class="bk-dialog-close" id="fsCloseBtn">×</button></div>' +
        '<div class="bk-dialog-body" style="padding:12px 16px 8px">' +
          '<div class="fs-segmented" id="fsSegmented">' +
            '<button class="fs-seg-btn" data-idx="1">正常</button>' +
            '<button class="fs-seg-btn" data-idx="3">大</button>' +
            '<button class="fs-seg-btn" data-idx="5">更大</button>' +
          '</div>' +
          '<div class="fs-stepper-row">' +
            '<button class="fs-step-btn" data-delta="-1">−</button>' +
            '<span class="fs-value" id="fsValueDisplay">' + curSize + 'px</span>' +
            '<button class="fs-step-btn" data-delta="1">+</button>' +
          '</div>' +
          '<div class="font-size-slider-container" style="margin-top:8px;padding:0;border:none">' +
            '<span class="font-label-small">A</span>' +
            '<input type="range" class="font-size-slider" id="fsDialogSlider" min="0" max="7" step="1" value="' + curIdx + '">' +
            '<span class="font-label-large">A</span>' +
          '</div>' +
          '<div class="fs-preview" style="margin-top:14px;font-family:var(--reading-font-family);font-size:' + curSize + 'px;line-height:1.7;border:1px solid var(--border);border-radius:8px;padding:12px 14px;color:var(--text)">' +
            '预览：在阅读中遇见美好，享受文字带来的宁静与力量。' +
          '</div>' +
        '</div>' +
        '<div class="bk-dialog-footer" style="padding:8px 16px 16px;display:flex;gap:10px;justify-content:flex-end">' +
          '<button class="bk-btn bk-btn-secondary" id="fsCancelBtn">取消</button>' +
          '<button class="bk-btn bk-btn-primary" id="fsConfirmBtn">确认</button>' +
        '</div>' +
      '</div></div>';

    var mask = document.createElement('div');
    mask.innerHTML = html;
    document.body.appendChild(mask.firstElementChild);

    var outer = document.querySelector('.bk-fontsize-dialog');
    var maskEl = outer ? outer.closest('.bk-dialog-mask') : null;

    function updateFsPreview(actIdx) {
      var sz = sizes[actIdx] || 16;
      var preview = document.querySelector('.fs-preview');
      var val = document.getElementById('fsValueDisplay');
      if (preview) preview.style.fontSize = sz + 'px';
      if (val) val.textContent = sz + 'px';
      var segs = document.querySelectorAll('.fs-seg-btn');
      for (var s = 0; s < segs.length; s++) segs[s].classList.remove('active');
      var activeSeg = document.querySelector('.fs-seg-btn[data-idx="' + actIdx + '"]');
      if (activeSeg) activeSeg.classList.add('active');
    }

    function closeDialog() { if (maskEl) maskEl.remove(); }

    // 关闭按钮
    var closeBtn = document.getElementById('fsCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeDialog);
    var cancelBtn = document.getElementById('fsCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeDialog);
    if (maskEl) maskEl.addEventListener('click', function(e) { if (e.target === maskEl) closeDialog(); });

    // 分段按钮
    var segBtns = document.querySelectorAll('.fs-seg-btn');
    for (var i = 0; i < segBtns.length; i++) {
      (function(btn) {
        btn.addEventListener('click', function() {
          var idx = parseInt(btn.getAttribute('data-idx'), 10);
          var slider = document.getElementById('fsDialogSlider');
          if (slider) { slider.value = idx; slider.dispatchEvent(new Event('input')); curIdx = idx; }
        });
      })(segBtns[i]);
    }

    // 步进器
    var stepBtns = document.querySelectorAll('.fs-step-btn');
    for (var j = 0; j < stepBtns.length; j++) {
      (function(btn) {
        btn.addEventListener('click', function() {
          var delta = parseInt(btn.getAttribute('data-delta'), 10);
          var slider = document.getElementById('fsDialogSlider');
          if (!slider) return;
          var newVal = Math.max(0, Math.min(7, parseInt(slider.value, 10) + delta));
          slider.value = newVal;
          slider.dispatchEvent(new Event('input'));
          slider.dispatchEvent(new Event('change'));
          curIdx = newVal;
        });
      })(stepBtns[j]);
    }

    // 滑块
    var slider = document.getElementById('fsDialogSlider');
    if (slider) {
      slider.addEventListener('input', function() { updateFsPreview(parseInt(this.value, 10)); });
      slider.addEventListener('change', function() { curIdx = parseInt(this.value, 10); });
    }

    // 确认
    var confirmBtn = document.getElementById('fsConfirmBtn');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function() {
        var sz = sizes[curIdx] || 16;
        try { localStorage.setItem('globalFontSize', String(sz)); } catch(e) {}
        document.documentElement.style.setProperty('--reading-font-size', sz + 'px');
        // 同步 sheet 中的滑块
        var sheetSlider = document.getElementById('fontSizeSlider');
        if (sheetSlider) { sheetSlider.value = curIdx; }
        var fd = document.getElementById('fontSizeDisplay');
        if (fd) fd.textContent = sz + 'px';
        closeDialog();
      });
    }

    // 初始高亮
    updateFsPreview(curIdx);
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
   * 书城卡片底部「书架状态」片段：已读→sage 徽标；未读→未读徽标 + sage 标记按钮。
   * 通过 BKShelf.isRead(book.id) 判定，零耦合搜索（搜索结果用 _coverHTML 不受影响）。
   * @param {Object} book
   * @returns {string} 根节点为 .bk-shelf-status 的 HTML 片段
   */
  function _buildShelfBadge(book) {
    if (!book || !book.id) return '';
    var isRead = (win.BKShelf && win.BKShelf.isRead) ? win.BKShelf.isRead(book.id) : false;
    if (isRead) {
      return '<div class="bk-shelf-status">' +
        '<span class="bk-shelf-badge is-read">已读 ✓</span>' +
        '</div>';
    }
    return '<div class="bk-shelf-status">' +
      '<span class="bk-shelf-badge is-unread">未读</span>' +
      '<button type="button" class="bk-mark-read-btn" data-book-id="' + escAttr(book.id) + '">标记已读</button>' +
      '</div>';
  }

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
    var cards = document.querySelectorAll('.zl-book-card');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-book-id') !== bookId) continue;
      var card = cards[i];
      var statusEl = card.querySelector('.bk-shelf-status');
      if (!statusEl) {
        var info = card.querySelector('.book-info');
        if (info) { statusEl = document.createElement('div'); info.appendChild(statusEl); }
      }
      if (statusEl && statusEl.parentNode) {
        var tmp = document.createElement('div');
        tmp.innerHTML = _buildShelfBadge(book);
        var newNode = tmp.firstChild;
        if (newNode) statusEl.parentNode.replaceChild(newNode, statusEl);
      }
      if (detail.action === 'add') card.classList.add('is-read');
      else if (detail.action === 'remove') card.classList.remove('is-read');
    }
  }

  /**
   * 全局 bk-shelf-changed 监听：书架页就地刷新（仅当书架页为前台时）。
   */
  function _shelfPageChangedHandler() {
    var listEl = document.getElementById('shelfList');
    if (!listEl) return; // 书架页不在前台，跳过（回看时由 renderShelfPage 整体重渲染兜底）
    _renderShelfList();
  }

  /**
   * 书架页列表 + 统计渲染（私有）：读 BKShelf.all()/stats() 整体渲染，保证与事实源 100% 一致。
   */
  function _renderShelfList() {
    var listEl = document.getElementById('shelfList');
    var statsEl = document.getElementById('shelfStats');
    if (!listEl || !win.BKShelf) return;

    var records = win.BKShelf.all();
    var stat = win.BKShelf.stats();

    // 统计卡
    if (statsEl) {
      statsEl.innerHTML =
        '<div class="bk-shelf-stat"><div class="bk-shelf-stat-num">' + stat.total + '</div>' +
        '<div class="bk-shelf-stat-label">总共读过</div></div>' +
        '<div class="bk-shelf-stat"><div class="bk-shelf-stat-num">' + stat.thisMonth + '</div>' +
        '<div class="bk-shelf-stat-label">本月阅读</div></div>';
    }

    // 空状态引导
    if (!records.length) {
      listEl.innerHTML =
        '<div class="bk-shelf-empty">' +
          '<div class="bk-shelf-empty-icon">📚</div>' +
          '<div class="bk-shelf-empty-title">你还没有标记已读的书</div>' +
          '<button type="button" class="bk-shelf-empty-cta" id="shelfEmptyCta">去书城标记 →</button>' +
        '</div>';
      var cta = document.getElementById('shelfEmptyCta');
      if (cta) cta.addEventListener('click', function () {
        if (win._bkShowHome) win._bkShowHome();
        if (win.BKRouter) win.BKRouter.navigateReplace('');
      });
      return;
    }

    // 已读列表
    var html = '';
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      var book = _findBookById(rec.bookId) || { id: rec.bookId, title: rec.bookId, series: '' };
      var title = book.title ? _cleanBookTitle(book.title) : (rec.bookId || '未知书籍');
      var author = book.author || _getSeriesTitle(book.series) || '';
      var cover = _coverHTML(book, { size: 'sm' });
      var completedAt = rec.completedAt || '';
      // note/rating 数据模型已预留，本轮只读展示占位
      var metaExtra = '';
      if (rec.rating) metaExtra += ' ★' + rec.rating;
      if (rec.note) metaExtra += ' · 有笔记';

      html += '<div class="bk-shelf-row" data-book-id="' + escAttr(rec.bookId) + '">';
      html += '<div class="bk-shelf-row-cover">' + cover + '</div>';
      html += '<div class="bk-shelf-row-info">';
      html += '<div class="bk-shelf-row-title">' + escText(title) + '</div>';
      if (author) html += '<div class="bk-shelf-row-author">' + escText(author) + '</div>';
      html += '<div class="bk-shelf-row-date">已于 ' + escText(completedAt) + ' 读完' + escText(metaExtra) + '</div>';
      html += '</div>';
      html += '<button type="button" class="bk-shelf-remove-btn" data-book-id="' + escAttr(rec.bookId) + '" aria-label="移除">移除</button>';
      html += '</div>';
    }
    listEl.innerHTML = html;

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

  // ── 渲染器对象 ──────────────────────────────────────────────────────

  var BKRenderer = {

    // zl-html 渲染器激活标志
    _zlActive: false,

    // ── 首页：书籍列表（增强版：zl-html 系列分类 + 下载管理）──────────

    renderHome: function () {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
      document.body.classList.remove('bk-reading-page');
      showHome();

      var homeView = document.getElementById('homeView');
      if (!homeView) return;

      // ★ 数据已就绪（Splash 阶段已完成加载），直接渲染，不显示 spinner
      if (_zlDmReady) {
        _mergeImportedBooks().then(function () {
          _renderZlHome(homeView);
        }).catch(function () {
          _renderZlHome(homeView);
        });
        return;
      }

      homeView.innerHTML = '<div class="bk-loading"><div class="bk-spinner"></div><div>加载中...</div></div>';

      // 复用统一的 DataManager 初始化
      _ensureDmInit()
        .then(function () {
          return _mergeImportedBooks().then(function () {
            _renderZlHome(homeView);
          });
        })
        .then(function () {
          if (win.bkDismissSplash) win.bkDismissSplash();
        })
        .catch(function (err) {
          console.warn('[Renderer] DataManager 加载失败，回退:', err.message);
          _zlSeries = [];
          _zlBooks = [];
          _zlDownloadedIds = [];
          if (!win.__bkBooks) win.__bkBooks = [];
          // ★ 即使 DataManager 失败，也要合并导入书籍
          _mergeImportedBooks().then(function () {
            _renderZlHome(homeView);
          }).catch(function () {
            _renderZlHome(homeView);
          }).then(function () {
            if (win.bkDismissSplash) win.bkDismissSplash();
          });
        });
    },

    // ── 目录页：章节列表 ────────────────────────────────────────────

    // ── 我的（个人中心，手机/平板） ─────────────────────────────

    renderMyPage: function () {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
      document.body.classList.remove('bk-reading-page');
      showApp();
      var app = getApp();

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

      // 阅读设置
      html += '<div class="bk-settings-section">';
      html += '<div class="bk-settings-section-title">阅读</div>';
      html += '<button class="bk-settings-row" data-action="theme-panel"><span class="bk-row-icon">🎨</span><span class="bk-row-label">阅读模式</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" data-action="font-size"><span class="bk-row-icon">Aa</span><span class="bk-row-label">字体大小</span><span class="bk-row-arrow">›</span></button>';
      html += '</div>';

      // 内容与数据
      html += '<div class="bk-settings-section">';
      html += '<div class="bk-settings-section-title">内容与数据</div>';
      html += '<button class="bk-settings-row" data-action="bookmarks"><span class="bk-row-icon">📑</span><span class="bk-row-label">我的书签</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" data-action="theme-panel"><span class="bk-row-icon">🧹</span><span class="bk-row-label">清理数据</span><span class="bk-row-arrow">›</span></button>';
      html += '</div>';
      html += '</div>'; // bk-settings-left end

      html += '<div class="bk-settings-right">';

      // 应用
      html += '<div class="bk-settings-section">';
      html += '<div class="bk-settings-section-title">应用</div>';
      html += '<button class="bk-settings-row" data-action="theme-panel"><span class="bk-row-icon">📲</span><span class="bk-row-label">发送桌面</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" data-action="theme-panel"><span class="bk-row-icon">📱</span><span class="bk-row-label">安卓APK</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" data-action="theme-panel"><span class="bk-row-icon">🔄</span><span class="bk-row-label">检查更新</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" data-action="theme-panel"><span class="bk-row-icon">📖</span><span class="bk-row-label">使用说明</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" data-action="theme-panel"><span class="bk-row-icon">💬</span><span class="bk-row-label">问题反馈</span><span class="bk-row-arrow">›</span></button>';
      html += '</div>';

      // 资源管理
      html += '<div class="bk-settings-section">';
      html += '<div class="bk-settings-section-title">资源管理</div>';
      html += '<button class="bk-settings-row" data-action="theme-panel"><span class="bk-row-icon">📥</span><span class="bk-row-label">下载管理</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" data-action="theme-panel"><span class="bk-row-icon">🗑️</span><span class="bk-row-label">管理书籍</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" data-action="theme-panel"><span class="bk-row-icon">📂</span><span class="bk-row-label">导入</span><span class="bk-row-arrow">›</span></button>';
      html += '</div>';

      // 高级
      html += '<div class="bk-settings-section">';
      html += '<div class="bk-settings-section-title">高级</div>';
      html += '<button class="bk-settings-row" data-action="theme-panel"><span class="bk-row-icon">⚙️</span><span class="bk-row-label">偏好设置</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" data-action="theme-panel"><span class="bk-row-icon">🔧</span><span class="bk-row-label">开发者</span><span class="bk-row-arrow">›</span></button>';
      html += '</div>';

      html += '</div>'; // bk-settings-right end
      html += '</div>'; // bk-settings-grid end
      html += '</div>'; // bk-settings-page end

      app.innerHTML = html;

      // 绑定入口点击
      var rows = app.querySelectorAll('.bk-settings-row');
      for (var i = 0; i < rows.length; i++) {
        (function(row) {
          row.addEventListener('click', function() {
            var action = row.getAttribute('data-action');
            if (action === 'font-size') {
              _openFontSizeDialog();
            } else if (action === 'bookmarks') {
              if (win.BKBookmark && win.BKBookmark.showList) win.BKBookmark.showList();
            } else if (action === 'theme-panel') {
              if (typeof win.toggleThemePanel === 'function') win.toggleThemePanel();
            }
          });
        })(rows[i]);
      }

      // 异步填充统计卡
      _fillSettingsStats();
    },

    // ── 设置整页（手机/平板，设计稿 3:202） ─────────────────────

    renderFullSettingsPage: function () {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
      document.body.classList.remove('bk-reading-page');
      showApp();
      var app = getApp();

      var html = '<div class="bk-settings-page"><div class="bk-settings-header">';
      html += '<button class="bk-back-btn" id="settingsBackBtn">‹ 返回</button>';
      html += '<h1>设置</h1></div>';
      html += '<div class="bk-settings-grid bk-settings-grid-full">';

      // 左栏：阅读与显示
      html += '<div class="bk-settings-left">';

      // 阅读模式（三卡）
      html += '<div class="bk-settings-section"><div class="bk-settings-section-title">阅读模式</div>';
      html += '<div class="theme-options" id="fullSettingsTheme">';
      html += '<div class="theme-option" data-theme="warm" onclick="setTheme(\'warm\')"><div class="theme-preview warm"><div class="tp-bar"></div><div class="tp-body"><div class="tp-line"></div><div class="tp-line short"></div><div class="tp-line"></div></div></div><div class="theme-option-content"><div class="theme-radio"></div><div class="theme-label">暖色</div></div></div>';
      html += '<div class="theme-option" data-theme="cool" onclick="setTheme(\'cool\')"><div class="theme-preview cool"><div class="tp-bar"></div><div class="tp-body"><div class="tp-line"></div><div class="tp-line short"></div><div class="tp-line"></div></div></div><div class="theme-option-content"><div class="theme-radio"></div><div class="theme-label">冷色</div></div></div>';
      html += '<div class="theme-option" data-theme="dark" onclick="setTheme(\'dark\')"><div class="theme-preview dark"><div class="tp-bar"></div><div class="tp-body"><div class="tp-line"></div><div class="tp-line short"></div><div class="tp-line"></div></div></div><div class="theme-option-content"><div class="theme-radio"></div><div class="theme-label">夜间</div></div></div>';
      html += '</div></div>';

      // 字体大小
      html += '<div class="bk-settings-section"><div class="bk-settings-section-title">字体大小</div>';
      html += '<div class="font-size-slider-container" style="padding:12px 16px">';
      html += '<span class="font-label-small">A</span>';
      html += '<input type="range" class="font-size-slider" id="fsSlider" min="0" max="7" step="1" value="3" oninput="handleFontSliderChange(this.value)">';
      html += '<span class="font-label-large">A</span>';
      html += '<span class="font-size-value" id="fsDisplay"></span></div></div>';

      html += '</div>'; // bk-settings-left end

      // 右栏：偏好与关于
      html += '<div class="bk-settings-right">';

      // 内容与数据
      html += '<div class="bk-settings-section"><div class="bk-settings-section-title">内容与数据</div>';
      html += '<button class="bk-settings-row" onclick="if(window.BKBookmark)window.BKBookmark.showList()"><span class="bk-row-icon">📑</span><span class="bk-row-label">我的书签</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" onclick="showClearDialog()"><span class="bk-row-icon">🧹</span><span class="bk-row-label">清理数据</span><span class="bk-row-arrow">›</span></button>';
      html += '</div>';

      // 应用信息
      html += '<div class="bk-settings-section"><div class="bk-settings-section-title">应用</div>';
      html += '<button class="bk-settings-row" onclick="showGuideDialog()"><span class="bk-row-icon">📖</span><span class="bk-row-label">使用说明</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" onclick="showFeedbackDialog()"><span class="bk-row-icon">💬</span><span class="bk-row-label">问题反馈</span><span class="bk-row-arrow">›</span></button>';
      html += '</div>';

      // 关于
      html += '<div class="bk-settings-section"><div class="bk-settings-section-title">关于</div>';
      html += '<button class="bk-settings-row" onclick="if(window.BKResourcePack)window.BKResourcePack.showCachedDialog()"><span class="bk-row-icon">💾</span><span class="bk-row-label">缓存管理</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" onclick="if(window.AppUpdate)window.AppUpdate.checkForUpdate()"><span class="bk-row-icon">🔄</span><span class="bk-row-label">检查更新</span><span class="bk-row-arrow">›</span></button>';
      html += '</div>';

      html += '</div>'; // bk-settings-right end
      html += '</div>'; // bk-settings-grid end
      html += '</div>'; // bk-settings-page end

      app.innerHTML = html;

      // 绑定返回
      var backBtn = document.getElementById('settingsBackBtn');
      if (backBtn) backBtn.addEventListener('click', function() { if (win.BKRouter) win.BKRouter.back(); });

      // 同步当前主题高亮和字号滑块
      if (typeof updateThemeUI === 'function') {
        var cur = (function(){ try { return localStorage.getItem('readingTheme') || 'cool'; }catch(e){return 'cool';} })();
        updateThemeUI(cur);
      }
      var s = (function(){ try { return localStorage.getItem('globalFontSize') || '16'; }catch(e){return '16';} })();
      var idx = [14,15,16,18,20,22,24,26].indexOf(parseInt(s,10));
      if (idx >= 0) {
        var sl = document.getElementById('fsSlider');
        var fd = document.getElementById('fsDisplay');
        if (sl) { sl.value = idx; }
        if (fd) { fd.textContent = s + 'px'; }
      }
    },

    // ── 书签列表整页（设计稿 3:368） ────────────────────────────

    renderBookmarksPage: function () {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
      document.body.classList.remove('bk-reading-page');
      showApp();
      var app = getApp();

      var html = '<div class="bk-settings-page"><div class="bk-settings-header">';
      html += '<button class="bk-back-btn" id="bmBackBtn">‹ 返回</button>';
      html += '<h1>书签</h1><span class="bk-bookmark-count" id="bmCount"></span></div>';
      html += '<div class="bk-bookmarks-list" id="bmList"></div>';
      html += '</div>';

      app.innerHTML = html;

      var backBtn = document.getElementById('bmBackBtn');
      if (backBtn) backBtn.addEventListener('click', function() { if (win.BKRouter) win.BKRouter.back(); });

      // 从 localforage 读取书签列表
      _loadBookmarksPage();
    },

    // ── 书架页（新增模块） ────────────────────────────────────────

    renderShelfPage: function () {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
      document.body.classList.remove('bk-reading-page');
      showApp();
      var app = getApp();
      document.title = '书架';

      var html = '<div class="bk-shelf-page">';
      html += '<div class="bk-settings-header">';
      html += '<button class="bk-back-btn" id="shelfBackBtn">‹ 返回</button>';
      html += '<h1>书架</h1></div>';
      html += '<div class="bk-shelf-stats" id="shelfStats"></div>';
      html += '<div class="bk-shelf-list" id="shelfList"></div>';
      html += '</div>';

      app.innerHTML = html;

      var backBtn = document.getElementById('shelfBackBtn');
      if (backBtn) backBtn.addEventListener('click', function () { if (win.BKRouter) win.BKRouter.back(); });

      // 进入时整体读取 BKShelf 渲染（兜底一致）
      _renderShelfList();

      // 订阅 bk-shelf-changed 做就地刷新（仅注册一次）
      if (!_shelfPageChangedBound) {
        win.addEventListener('bk-shelf-changed', _shelfPageChangedHandler);
        _shelfPageChangedBound = true;
      }

      startScrollTracking('shelf');
      restoreScrollPosition('shelf');
    },

    renderChapterList: function (bookId) {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
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
        if (win.BKHighlight && win.BKHighlight.redoHighlights) {
          win.BKHighlight.redoHighlights();
        }

        // 初始化经文弹窗
        if (win.BKScripturePopup && win.BKScripturePopup.init) {
          win.BKScripturePopup.init();
        }

        // 安装键盘快捷键 + 三页轮播滑动手势
        _installReadingShortcuts(bookId, uniqueChapters, chapterNum);
        _installCarouselSwipe(bookId, uniqueChapters, chapterNum);
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

      var homeView = document.getElementById('homeView');

      // 进入管理模式时，确保首页处于“书籍列表”视图，否则删除按钮无处挂载
      if (_manageMode && _zlHomeView !== 'series') {
        var merged = _getMergedSeries();
        if (merged.series.length > 0) {
          _zlCurrentSeries = merged.series[0].id;
        } else if (_zlBooks.length > 0) {
          // 没有任何可见系列（书籍未分组）时，仍切换到系列视图以展示书籍卡片
          _zlCurrentSeries = _zlBooks[0].series || '';
        }
        _zlHomeView = 'series';
        _zlCurrentCategory = null;
        _zlCurrentCategoryPrefix = null;
        if (homeView) _renderZlHome(homeView);
      }

      // 遍历所有书籍卡片，添加/移除删除按钮
      if (homeView) {
        var cards = homeView.querySelectorAll('.zl-book-card');
        for (var ci = 0; ci < cards.length; ci++) {
          var card = cards[ci];
          var bookId = card.getAttribute('data-book-id');
          var series = card.getAttribute('data-series');
          var existingDelBtn = card.querySelector('.imported-delete-btn');
          if (_manageMode) {
            if (!existingDelBtn) {
              var btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'imported-delete-btn';
              btn.setAttribute('data-book-id', bookId);
              btn.title = '删除';
              btn.textContent = '✕';
              card.appendChild(btn);
            }
          } else {
            if (existingDelBtn && series !== 'imported' && bookId.indexOf('imported-') !== 0) {
              existingDelBtn.parentNode.removeChild(existingDelBtn);
            }
          }
        }
      }

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
      _toggleDownloadPanel(true);
      _refreshStorageStats();
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

    // ── 首页内部回退（系列/分类视图 → 上一级）─────────────────────────
    // 返回 true 表示已处理回退，false 表示已在顶层（系列目录）
    goBackInHome: function () {
      var homeView = document.getElementById('homeView');
      if (!homeView) return false;

      // 分类视图 → 返回系列书籍列表
      if (_zlCurrentCategory) {
        _zlCurrentCategory = null;
        _zlCurrentCategoryPrefix = null;
        var gridContainer = document.getElementById('bookGrid');
        if (gridContainer && gridContainer.parentNode) {
          var newGrid = _buildBookGrid(_zlCurrentSeries);
          var tmp = document.createElement('div');
          tmp.innerHTML = newGrid;
          gridContainer.parentNode.replaceChild(tmp.firstChild, gridContainer);
        }
        // 恢复标题为系列名称
        var titleEl = homeView.querySelector('.series-list-title');
        if (titleEl) titleEl.textContent = _getSeriesTitle(_zlCurrentSeries);
        return true;
      }

      // 系列书籍列表 → 返回系列目录
      if (_zlHomeView === 'series') {
        _zlHomeView = 'catalog';
        _zlCurrentCategory = null;
        _zlCurrentCategoryPrefix = null;
        _renderZlHome(homeView);
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

  // 暴露字号选择器弹窗（供 nav-stack.js 工具栏按钮调用）
  win._openFontSizeDialog = _openFontSizeDialog;

  // 初始化目录 Drawer 全局事件（页面加载时一次）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initTocDrawerEvents);
  } else {
    _initTocDrawerEvents();
  }

}(window));
