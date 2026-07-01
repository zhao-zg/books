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

  // ── 工具 ────────────────────────────────────────────────────────────────

  function escAttr(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function escText(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // 系列颜色调色板（用于书籍卡片左侧指示条）
  var _seriesColors = [
    '#667eea', '#f56565', '#48bb78', '#ed8936', '#9f7aea',
    '#38b2ac', '#e53e3e', '#3182ce', '#d69e2e', '#805ad5',
    '#dd6b20', '#319795', '#e53e3e', '#2b6cb0', '#b7791f'
  ];
  var _seriesColorMap = {};
  var _seriesColorIdx = 0;

  function _getSeriesColor(seriesId) {
    if (!seriesId) return '#667eea';
    if (!_seriesColorMap[seriesId]) {
      _seriesColorMap[seriesId] = _seriesColors[_seriesColorIdx % _seriesColors.length];
      _seriesColorIdx++;
    }
    return _seriesColorMap[seriesId];
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

  // 滚动位置记忆
  var _scrollSaveTimer = null;
  var _scrollSaveHandler = null;
  var _scrollPageKey = null;

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
          // 检查本地索引是否可用
          return fetch(localZlData + '/books-index.json', { cache: 'no-cache' }).then(function(r) {
            if (r.ok) {
              dmUrl = localZlData;
              dmUrls = [localZlData].concat(cfFallbackUrls);
              console.log('[Renderer] ' + (isNativeApp ? 'APK' : 'PWA') + '模式：使用本地索引数据，CDN 备用');
            } else {
              throw new Error('本地索引不可用');
            }
          }).catch(function() {
            dmUrls = cfFallbackUrls;
            dmUrl = cfFallbackUrls[0];
            console.log('[Renderer] ' + (isNativeApp ? 'APK' : 'PWA') + '模式：本地索引不可用，使用 CDN（' + dmUrls.length + ' 个地址）');
          }).then(function() {
            return _setupDataManager(dmUrl, dmUrls);
          });
        } else if (isLocal) {
          var origin = win.location.origin;
          if (!origin || origin === 'null') origin = 'http://localhost:8080';
          dmUrls.push(origin + '/zl-data');
          dmUrl = dmUrls[0];
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
    try { localStorage.setItem('bk_scroll:' + _scrollPageKey, String(win.scrollY || 0)); } catch(e) {}
  }

  function restoreScrollPosition(pageKey) {
    try {
      var y = parseInt(localStorage.getItem('bk_scroll:' + pageKey) || '0', 10);
      if (y > 0) {
        requestAnimationFrame(function() {
          requestAnimationFrame(function() { win.scrollTo(0, y); });
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
    win.addEventListener('scroll', _scrollSaveHandler, { passive: true });
  }

  function stopScrollTracking() {
    saveScrollPosition();
    if (_scrollSaveHandler) {
      win.removeEventListener('scroll', _scrollSaveHandler);
      _scrollSaveHandler = null;
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

  function renderContentItem(item, ctx) {
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
        html = '<figure class="bk-figure">' +
          '<img src="' + escAttr(src) + '" alt="' + escAttr(alt || text) + '" loading="lazy">' +
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

  function renderChapterContent(chapter) {
    var contentArr = chapter.content || [];
    var html = '';

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
      html += renderContentItem(item, ctx);
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
  }

  // ── 页面导航栏 ──────────────────────────────────────────────────────

  function buildPageNavigation(book, chapter) {
    var uniqueChapters = _getUniqueChapters(book.chapters || []);
    var chapterNum = chapter.number || 0;
    var prevChapter = null, nextChapter = null;
    for (var i = 0; i < uniqueChapters.length; i++) {
      if (uniqueChapters[i].number === chapterNum) {
        if (i > 0) prevChapter = uniqueChapters[i - 1];
        if (i < uniqueChapters.length - 1) nextChapter = uniqueChapters[i + 1];
        break;
      }
    }

    var html = '<nav class="page-navigation" id="pageNavigation">';

    // 返回书架按钮
    html += '<a class="nav-link nav-home" href="#/" id="back-btn" title="返回书架">';
    html += '<span class="nav-icon">⬅</span>';
    html += '</a>';

    if (prevChapter) {
      html += '<a class="nav-link nav-prev" href="#/' + escAttr(book.id) + '/' + prevChapter.number + '">';
      html += '<span class="nav-arrow">‹</span>';
      html += '<span class="nav-label">' + escText(prevChapter.title || '上一章') + '</span>';
      html += '</a>';
    } else {
      html += '<span class="nav-link nav-prev nav-disabled"><span class="nav-arrow">‹</span></span>';
    }

    html += '<a class="nav-link nav-toc" href="#/' + escAttr(book.id) + '" data-toc-drawer="1" data-book-id="' + escAttr(book.id) + '" role="button">';
    html += '<span class="nav-icon">☰</span>';
    html += '</a>';

    if (nextChapter) {
      html += '<a class="nav-link nav-next" href="#/' + escAttr(book.id) + '/' + nextChapter.number + '">';
      html += '<span class="nav-label">' + escText(nextChapter.title || '下一章') + '</span>';
      html += '<span class="nav-arrow">›</span>';
      html += '</a>';
    } else {
      html += '<span class="nav-link nav-next nav-disabled"><span class="nav-arrow">›</span></span>';
    }
    html += '</nav>';
    return html;
  }

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
      emptyHtml += '<div>暂无书籍，请点击导入按钮添加书籍</div>';
      emptyHtml += '</div></div></div>';
      homeView.innerHTML = emptyHtml;
      _bindZlEvents(homeView);
      return;
    }

    if (_zlHomeView === 'catalog') {
      _renderSeriesCatalog(homeView);
    } else {
      _renderSeriesBookList(homeView);
    }
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
    html += '<div class="home-overflow-menu" id="homeOverflowMenu">';
    html += '<button type="button" class="home-action-btn home-overflow-trigger" id="bk-overflow-btn">⋯</button>';
    html += '<div class="home-overflow-dropdown" id="homeOverflowDropdown" style="display:none">';
    if (_zlDmReady) {
      html += '<button type="button" id="bk-dl-mgr-btn" class="home-overflow-item">📥 下载管理</button>';
    }
    html += '<button type="button" id="bk-import-btn" class="home-overflow-item">📂 导入</button>';
    html += '<button type="button" id="bk-manage-btn" class="home-overflow-item">' + (_manageMode ? '✅ 完成' : '🗑️ 管理') + '</button>';
    html += '</div>';
    html += '</div>';
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
      html += '<div class="series-catalog-card" data-series="' + escAttr(s.id) + '">';
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
    html += '<div class="home-overflow-menu" id="homeOverflowMenu">';
    html += '<button type="button" class="home-action-btn home-overflow-trigger" id="bk-overflow-btn">⋯</button>';
    html += '<div class="home-overflow-dropdown" id="homeOverflowDropdown" style="display:none">';
    if (_zlDmReady) {
      html += '<button type="button" id="bk-dl-mgr-btn" class="home-overflow-item">📥 下载管理</button>';
    }
    html += '<button type="button" id="bk-import-btn" class="home-overflow-item">📂 导入</button>';
    html += '<button type="button" id="bk-manage-btn" class="home-overflow-item">' + (_manageMode ? '✅ 完成' : '🗑️ 管理') + '</button>';
    html += '</div>';
    html += '</div>';
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
    var chapterCount = book.chapter_count || 0;
    var progress = getReadingProgress(book.id);
    var progressPct = (progress > 0 && chapterCount > 0) ? Math.round(progress / chapterCount * 100) : 0;

    var html = '<div class="book-card zl-book-card" data-book-id="' + escAttr(book.id) + '" data-series="' + escAttr(book.series) + '" style="--series-color:' + _getSeriesColor(book.series) + '">';
    html += '<div class="book-card-wrapper">';
    html += '<div class="book-link" data-book-id="' + escAttr(book.id) + '" data-series="' + escAttr(book.series) + '" role="button" tabindex="0">';
    html += '<div class="book-info">';
    html += '<div class="book-header">';
    html += '<div class="book-title-row">';
    html += '<div class="title">' + escText(book.title || book.id) + '</div>';
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
    html += '</div>';
    html += '</div>';
    html += '</div>';
    // 删除按钮（管理模式或导入书籍）
    if (_manageMode || book.series === 'imported' || book.id.indexOf('imported-') === 0) {
      html += '<button type="button" class="imported-delete-btn" data-book-id="' + escAttr(book.id) + '" title="删除">✕</button>';
    }
    html += '</div>';
    return html;
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
        var html = '<div id="bookGrid">';
        html += '<div class="category-back-bar"><button type="button" class="category-back-btn" id="categoryBackBtn">返回类型目录</button></div>';
        html += '<div class="book-grid">';
        for (var i = 0; i < catFiltered.length; i++) {
          html += _buildBookCard(catFiltered[i]);
        }
        html += '</div></div>';
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

      // 0b. 返回系列目录按钮
      if (e.target.closest && e.target.closest('#seriesBackBtn')) {
        _zlHomeView = 'catalog';
        _zlCurrentCategory = null;
        _zlCurrentCategoryPrefix = null;
        _renderZlHome(homeView);
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
        return;
      }

      // 1.5b 返回类型目录
      if (e.target.closest && e.target.closest('#categoryBackBtn')) {
        _zlCurrentCategory = null;
        _zlCurrentCategoryPrefix = null;
        var gridContainer = document.getElementById('bookGrid');
        if (gridContainer && gridContainer.parentNode) {
          var newGrid = _buildBookGrid(_zlCurrentSeries);
          var tmp = document.createElement('div');
          tmp.innerHTML = newGrid;
          gridContainer.parentNode.replaceChild(tmp.firstChild, gridContainer);
        }
        return;
      }

      // 2. 书籍卡片点击（.book-link）
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

      // 4. 下载管理按钮
      if (e.target.closest && e.target.closest('#bk-dl-mgr-btn')) {
        _toggleDownloadPanel(true);
        _refreshStorageStats();
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

      // 12. 导入按钮
      if (e.target.closest && e.target.closest('#bk-import-btn')) {
        var importBtn = e.target.closest('#bk-import-btn');
        if (!win.ImportManager || !win.ImportManager.pickAndImport) return;
        importBtn.disabled = true;
        importBtn.textContent = '导入中...';
        win.ImportManager.pickAndImport().then(function(bookData) {
          var btn = document.getElementById('bk-import-btn');
          if (btn) { btn.disabled = false; btn.textContent = '📂 导入'; }
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
          var btn = document.getElementById('bk-import-btn');
          if (btn) { btn.disabled = false; btn.textContent = '📂 导入'; }
          if (err && err.message) console.error('[导入]', err.message);
        });
        return;
      }

      // 13. 管理按钮
      if (e.target.closest && (e.target.closest('#bk-manage-btn') || e.target.closest('.home-overflow-item#bk-manage-btn'))) {
        _manageMode = !_manageMode;
        // 更新按钮文字
        var manageBtn = document.getElementById('bk-manage-btn');
        if (manageBtn) manageBtn.textContent = _manageMode ? '✅ 完成' : '🗑️ 管理';
        // 遍历所有书籍卡片，添加/移除删除按钮
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
            // 非管理模式：仅移除非导入书籍的删除按钮
            if (existingDelBtn && series !== 'imported' && bookId.indexOf('imported-') !== 0) {
              existingDelBtn.parentNode.removeChild(existingDelBtn);
            }
          }
        }
        return;
      }

      // 14. 溢出菜单触发按钮
      if (e.target.closest && e.target.closest('#bk-overflow-btn')) {
        e.stopPropagation();
        var dropdown = document.getElementById('homeOverflowDropdown');
        if (dropdown) {
          dropdown.style.display = (dropdown.style.display === 'none' || !dropdown.style.display) ? 'block' : 'none';
        }
        return;
      }

      // 15. 点击溢出菜单外区域关闭菜单
      var overflowMenu = document.getElementById('homeOverflowMenu');
      if (overflowMenu && !e.target.closest('#homeOverflowMenu')) {
        var dropdown = document.getElementById('homeOverflowDropdown');
        if (dropdown && dropdown.style.display !== 'none') {
          dropdown.style.display = 'none';
        }
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
    if (resEl && win.DataManager.checkResources) {
      win.DataManager.checkResources().then(function (res) {
        var cached = res.downloaded || 0;
        var total = res.total || _zlBooks.length || 0;
        var sizeMB = res.estimatedTotalSize
          ? (res.estimatedTotalSize / 1024 / 1024).toFixed(1)
          : '未知';
        resEl.textContent = '已缓存 ' + cached + ' / 总共 ' + total + ' 本书（约 ' + sizeMB + ' MB）';
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
      text.textContent = label + ' 下载完成: 成功 ' + result.success + ' 本' +
        (result.failed ? '，失败 ' + result.failed + ' 本' : '');
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
        _zlBooks.push(ib);
        _zlDownloadedIds.push(ib.id);
        if (!win.__bkBooks) win.__bkBooks = [];
        var exists = false;
        for (var bi = 0; bi < win.__bkBooks.length; bi++) {
          if (win.__bkBooks[bi].id === ib.id) { exists = true; break; }
        }
        if (!exists) win.__bkBooks.push(ib);
      }
    });
  }

  // ── 目录 Drawer ────────────────────────────────────────────────────────

  /**
   * 打开目录 Drawer，填充章节列表
   */
  function _openTocDrawer(bookId) {
    var drawer = document.getElementById('bkTocDrawer');
    var overlay = document.getElementById('bkTocOverlay');
    var body = document.getElementById('bkTocDrawerBody');
    var titlesEl = document.getElementById('bkTocDrawerTitles');
    if (!drawer || !body) return;

    // 显示加载状态
    body.innerHTML = '<div class="bk-loading" style="padding:32px 0"><div class="bk-spinner"></div><div>加载中...</div></div>';
    _toggleTocDrawer(true);

    loadBook(bookId).then(function (book) {
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
          currentItem.scrollIntoView({ block: 'center', behavior: 'instant' });
        }, 50);
      }
    }).catch(function (err) {
      body.innerHTML = '<div class="bk-error" style="padding:24px 0"><div class="bk-error-icon">⚠️</div><div class="bk-error-text">加载失败</div></div>';
    });
  }

  /**
   * 切换 Drawer 的打开/关闭状态
   */
  function _toggleTocDrawer(open) {
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
      if (win.BK && win.BK.backStack) {
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
        // 先关闭 drawer，href 会自动触发 hashchange 导航
        _toggleTocDrawer(false);
      }
    }, true);
  }

  // ── 渲染器对象 ──────────────────────────────────────────────────────

  var BKRenderer = {

    // zl-html 渲染器激活标志
    _zlActive: false,

    // ── 首页：书籍列表（增强版：zl-html 系列分类 + 下载管理）──────────

    renderHome: function () {
      stopScrollTracking();
      _removeReadingShortcuts();
      showHome();

      var homeView = document.getElementById('homeView');
      if (!homeView) return;

      homeView.innerHTML = '<div class="bk-loading"><div class="bk-spinner"></div><div>加载中...</div></div>';

      // 复用统一的 DataManager 初始化
      _ensureDmInit()
        .then(function () {
          return _mergeImportedBooks().then(function () {
            _renderZlHome(homeView);
          });
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
          });
        });
    },

    // ── 目录页：章节列表 ────────────────────────────────────────────

    renderChapterList: function (bookId) {
      stopScrollTracking();
      _removeReadingShortcuts();
      showApp();
      var app = getApp();
      app.innerHTML = '<div class="bk-loading"><div class="bk-spinner"></div><div>加载中...</div></div>';

      loadBook(bookId).then(function (book) {
        var chapters = _getUniqueChapters(book.chapters || []);
        var progress = getReadingProgress(bookId);

        var html = '<div class="bk-chapter-list-view">';

        // 书籍信息头部
        html += '<div class="bk-book-header">';
        if (book.cover) {
          html += '<img class="bk-book-header-cover" src="' + escAttr(book.cover) + '" alt="' + escAttr(book.title) + '">';
        }
        html += '<h1 class="bk-book-header-title">' + escText(book.title) + '</h1>';
        if (book.author) html += '<div class="bk-book-header-author">' + escText(book.author) + '</div>';
        if (book.description) html += '<div class="bk-book-header-desc">' + escText(book.description) + '</div>';
        html += '</div>';

        // 章节列表
        html += '<div class="bk-chapter-list">';
        for (var i = 0; i < chapters.length; i++) {
          var ch = chapters[i];
          var chNum = ch.number || (i + 1);
          var isCurrent = chNum === progress;
          html += '<a class="bk-chapter-item' + (isCurrent ? ' bk-chapter-current' : '') + '" href="#/' + escAttr(bookId) + '/' + chNum + '">';
          html += '<span class="bk-chapter-num">' + chNum + '</span>';
          html += '<span class="bk-chapter-title">' + escText(ch.title || '第' + chNum + '章') + '</span>';
          if (isCurrent) html += '<span class="bk-chapter-badge">在读</span>';
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
      stopScrollTracking();
      _removeReadingShortcuts();
      showApp();
      var app = getApp();
      app.innerHTML = '<div class="bk-loading"><div class="bk-spinner"></div><div>加载中...</div></div>';

      loadBook(bookId).then(function (book) {
        var uniqueChapters = _getUniqueChapters(book.chapters || []);
        var chapter = null;
        for (var i = 0; i < uniqueChapters.length; i++) {
          if (uniqueChapters[i].number === chapterNum) {
            chapter = uniqueChapters[i];
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

        // 设置文档标题
        document.title = (book.title || '') + ' - ' + (chapter.title || '第' + chapterNum + '章');

        // 渲染页面结构
        var html = '<div class="reading-view" id="readingView">';

        // 阅读进度条
        var totalChapters = uniqueChapters.length;
        var progressPct = totalChapters > 0 ? Math.round(chapterNum / totalChapters * 100) : 0;
        html += '<div class="bk-reading-progress">' +
          '<div class="bk-reading-progress-bar" style="width:' + progressPct + '%"></div>' +
          '</div>';

        // 返回书架按钮 + 章节标题
        html += '<div class="bk-reading-header">';
        html += '<div class="bk-reading-header-row">';
        html += '<button type="button" class="bk-back-btn" title="返回书架" aria-label="返回书架">';
        html += '<span class="bk-back-btn-icon">&#8249;</span>';
        html += '</button>';
        html += '<div class="bk-reading-header-titles">';
        html += '<div class="bk-reading-book-title">' + escText(book.title || '') + '</div>';
        html += '<h1 class="bk-reading-chapter-title">' + escText(chapter.title || '第' + chapterNum + '章') + '</h1>';
        html += '</div>';
        html += '</div>';
        html += '</div>';

        // 章节内容
        html += '<div class="content" id="chapterContent">';
        html += renderChapterContent(chapter);
        html += '</div>';

        // 页面导航
        html += buildPageNavigation(book, chapter);

        html += '</div>';

        // TTS 控制栏
        html += buildBottomControlBar();

        app.innerHTML = html;

        // 绑定返回书架按钮（头部）
        var headerBackBtn = app.querySelector('.bk-back-btn');
        if (headerBackBtn) {
          headerBackBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (win.BKRouter) win.BKRouter.navigate('');
          });
        }

        var pageKey = bookId + '/' + chapterNum;
        win.__bkCurrentPath = pageKey;
        startScrollTracking(pageKey);

        // 检查是否有书签恢复的滚动位置
        var bmScrollKey = 'bk_scroll:' + pageKey;
        var bmScrollY = 0;
        try { bmScrollY = parseInt(localStorage.getItem(bmScrollKey) || '0', 10); } catch(e) {}
        if (bmScrollY > 0) {
          requestAnimationFrame(function() {
            requestAnimationFrame(function() { win.scrollTo(0, bmScrollY); });
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

        // 初始化经文弹窗（处理动态插入的 scripture-block 和行内引用标注）
        if (win.BKScripturePopup && win.BKScripturePopup.init) {
          win.BKScripturePopup.init();
        }

        // 安装键盘快捷键
        _installReadingShortcuts(bookId, uniqueChapters, chapterNum);
      }).catch(function (err) {
        app.innerHTML = '<div class="bk-error">' +
          '<div class="bk-error-icon">⚠️</div>' +
          '<div class="bk-error-text">加载失败: ' + escText(err.message) + '</div>' +
          '</div>';
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
    }
  };

  // ── 暴露 ──────────────────────────────────────────────────────────────

  win.BKRenderer = BKRenderer;

  // 初始化目录 Drawer 全局事件（页面加载时一次）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initTocDrawerEvents);
  } else {
    _initTocDrawerEvents();
  }

}(window));
