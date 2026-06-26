/*!
 * renderer.js — 书报 SPA 电子书渲染器
 *
 * 从 books.json / book.json 渲染各视图：
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

  function wrapRefs(text) {
    return win.BKRef ? win.BKRef.wrapRefs(text, '') : escText(text);
  }

  // 缓存已加载的 book.json
  var _bookCache = {};
  // 缓存 books.json
  var _booksIndex = null;

  // ── zl-html 数据状态 ────────────────────────────────────────────────────
  var _zlIndex = null;          // DataManager 加载的 books-index.json
  var _zlSeries = [];           // 系列数组
  var _zlBooks = [];            // 书籍数组
  var _zlCurrentSeries = 'all'; // 当前选中的系列过滤
  var _zlDownloadedIds = [];    // 已下载的书籍 ID 列表
  var _zlDmReady = false;       // DataManager 是否就绪
  var _dlPanelOpen = false;     // 下载面板是否展开
  var _dlProgressTimer = null;  // 下载进度轮询定时器
  var _manageMode = false;      // 书籍管理模式（显示删除按钮）

  // 滚动位置记忆
  var _scrollSaveTimer = null;
  var _scrollSaveHandler = null;
  var _scrollPageKey = null;

  // ── 数据加载 ─────────────────────────────────────────────────────────────

  function loadBooksIndex() {
    if (_booksIndex) return Promise.resolve(_booksIndex);
    var root = win.BK_ROOT || './';
    var isNative = !!(win.Capacitor && win.Capacitor.isNativePlatform && win.Capacitor.isNativePlatform());
    var jsonUrl = isNative ? root + 'books.json?_t=' + Date.now() : root + 'books.json';
    return fetch(jsonUrl)
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        _booksIndex = data;
        win.__bkBooks = data.books || data;
        return _booksIndex;
      });
  }

  function loadBook(bookId) {
    if (_bookCache[bookId]) return Promise.resolve(_bookCache[bookId]);

    // ★ 本地导入书籍（必须在 DataManager 之前，避免 imported-xxx 触发远程下载）
    if (win.ImportManager && win.ImportManager.getImportedBook) {
      return Promise.resolve().then(function () {
        return win.ImportManager.getImportedBook(bookId);
      }).then(function (data) {
        if (data) { _bookCache[bookId] = data; return data; }
        // 未命中导入，继续走 DataManager / Legacy
        if (_zlDmReady && win.DataManager) {
          return win.DataManager.getBook(bookId)
            .then(function (d) { _bookCache[bookId] = d; return d; })
            .catch(function () { return _loadBookLegacy(bookId); });
        }
        return _loadBookLegacy(bookId);
      });
    }

    // 优先通过 DataManager 加载 zl-html 书籍
    if (_zlDmReady && win.DataManager) {
      return win.DataManager.getBook(bookId)
        .then(function (data) {
          _bookCache[bookId] = data;
          return data;
        })
        .catch(function (dmErr) {
          console.warn('[Renderer] DataManager 加载失败，回退到旧路径: ' + bookId, dmErr.message);
          return _loadBookLegacy(bookId);
        });
    }

    return _loadBookLegacy(bookId);
  }

  // 旧路径加载 book.json（EPUB/MD/TXT 书籍）
  function _loadBookLegacy(bookId) {
    if (_bookCache[bookId]) return Promise.resolve(_bookCache[bookId]);
    var root = win.BK_ROOT || './';
    var isNative = !!(win.Capacitor && win.Capacitor.isNativePlatform && win.Capacitor.isNativePlatform());
    var jsonUrl = isNative
      ? root + bookId + '/book.json?_t=' + Date.now()
      : root + bookId + '/book.json';
    return fetch(jsonUrl)
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .catch(function(fetchErr) {
        if (isNative && ('caches' in win)) {
          var cacheUrls = [
            (win.location.origin || '') + '/' + bookId + '/book.json',
            root + bookId + '/book.json'
          ];
          return caches.match(cacheUrls[0]).then(function(r1) {
            return r1 || caches.match(cacheUrls[1]);
          }).then(function(cachedResp) {
            if (cachedResp && cachedResp.ok) return cachedResp.json();
            throw fetchErr;
          });
        }
        throw fetchErr;
      })
      .then(function(data) {
        _bookCache[bookId] = data;
        return data;
      });
  }

  // ── 容器与视图切换 ────────────────────────────────────────────────────

  function getApp() { return document.getElementById('app') || document.body; }

  function showApp() {
    if (win._bkShowApp) { win._bkShowApp(); return; }
    var h = document.getElementById('homeView'), a = document.getElementById('app');
    if (h) h.style.display = 'none';
    if (a) a.style.display = '';
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

  function renderContentItem(item) {
    if (!item) return '';
    var type = item.type || 'paragraph';
    var text = item.text || '';
    var html = '';

    switch (type) {
      case 'heading':
        var level = item.level || 2;
        level = Math.max(1, Math.min(6, level));
        html = '<h' + level + ' class="bk-heading bk-h' + level + '">' + wrapRefs(text) + '</h' + level + '>';
        break;

      case 'quote':
        html = '<blockquote class="bk-quote">' +
          '<div class="bk-quote-content">' + wrapRefs(text) + '</div>' +
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
          html += '<li>' + wrapRefs(items[i]) + '</li>';
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
          '<span class="bk-fn-text">' + wrapRefs(text) + '</span>' +
          '</div>';
        break;

      case 'separator':
        html = '<hr class="bk-separator">';
        break;

      case 'paragraph':
      default:
        if (text) {
          html = '<p class="bk-paragraph">' + wrapRefs(text) + '</p>';
        }
        break;
    }
    return html;
  }

  function renderChapterContent(chapter) {
    var contentArr = chapter.content || [];
    var html = '';

    // 兼容：如果 content 是字符串（未经转换的纯文本），按 \n 拆分渲染
    if (typeof contentArr === 'string') {
      var lines = contentArr.split('\n');
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim();
        if (line) {
          html += '<p class="bk-paragraph">' + wrapRefs(line) + '</p>';
        }
      }
      return html;
    }

    for (var i = 0; i < contentArr.length; i++) {
      html += renderContentItem(contentArr[i]);
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
        html += '<span class="bk-fn-text">' + wrapRefs(fn.text || '') + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }
    return html;
  }

  // ── 页面导航栏 ──────────────────────────────────────────────────────

  function buildPageNavigation(book, chapter) {
    var chapters = book.chapters || [];
    var chapterNum = chapter.number || 0;
    var prevChapter = null, nextChapter = null;
    for (var i = 0; i < chapters.length; i++) {
      if (chapters[i].number === chapterNum) {
        if (i > 0) prevChapter = chapters[i - 1];
        if (i < chapters.length - 1) nextChapter = chapters[i + 1];
        break;
      }
    }

    var html = '<nav class="page-navigation" id="pageNavigation">';
    if (prevChapter) {
      html += '<a class="nav-link nav-prev" href="#/' + escAttr(book.id) + '/' + prevChapter.number + '">';
      html += '<span class="nav-arrow">‹</span>';
      html += '<span class="nav-label">' + escText(prevChapter.title || '上一章') + '</span>';
      html += '</a>';
    } else {
      html += '<span class="nav-link nav-prev nav-disabled"><span class="nav-arrow">‹</span></span>';
    }

    html += '<a class="nav-link nav-toc" href="#/' + escAttr(book.id) + '">';
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
   * 根据 series ID 获取系列标题
   */
  function _getSeriesTitle(seriesId) {
    for (var i = 0; i < _zlSeries.length; i++) {
      if (_zlSeries[i].id === seriesId) return _zlSeries[i].title;
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
      // 绑定导入按钮事件
      _bindImportBtnEvent();
      return;
    }

    var html = '<div class="container">';

    // 头部
    html += '<div class="header">';
    html += '<h1 class="logo-trigger">📖 书报</h1>';
    html += '<p class="subtitle">电子书阅读应用</p>';
    html += '<div class="home-header-actions">';
    html += '<button type="button" id="bk-search-btn" class="home-action-btn">🔍 搜索</button>';
    if (_zlDmReady) {
      html += '<button type="button" id="bk-dl-mgr-btn" class="home-action-btn">📥 下载管理</button>';
    }
    html += '<button type="button" id="bk-import-btn" class="home-action-btn">📂 导入</button>';
    html += '<button type="button" id="bk-manage-btn" class="home-action-btn">🗑️ 管理</button>';
    html += '</div>';
    html += '</div>';

    // 系列标签栏
    html += _buildSeriesTabs();

    // 书籍网格
    html += _buildBookGrid(_zlCurrentSeries);

    // 底部
    html += '<div class="footer">';
    html += '<p>本站内容仅供主内圣徒交通使用</p>';
    html += '<p class="footer-meta" id="footerMeta"></p>';
    html += '</div>';
    html += '</div>';

    // 下载面板
    if (_zlDmReady) {
      html += _buildDownloadPanel();
    }

    homeView.innerHTML = html;

    // 绑定事件
    _bindZlEvents(homeView);

    startScrollTracking('home');
    restoreScrollPosition('home');
  }

  /**
   * 构建系列标签栏 HTML
   */
  function _buildSeriesTabs() {
    var html = '<div class="series-tabs" id="seriesTabs">';
    html += '<button class="series-tab' + (_zlCurrentSeries === 'all' ? ' active' : '') + '" data-series="all">全部</button>';
    for (var i = 0; i < _zlSeries.length; i++) {
      var s = _zlSeries[i];
      var active = _zlCurrentSeries === s.id ? ' active' : '';
      html += '<button class="series-tab' + active + '" data-series="' + escAttr(s.id) + '">' + escText(s.title) + '</button>';
    }
    html += '</div>';
    return html;
  }

  /**
   * 根据当前系列过滤构建书籍网格 HTML
   */
  function _buildBookGrid(seriesFilter) {
    var filtered = _zlBooks;
    if (seriesFilter && seriesFilter !== 'all') {
      filtered = [];
      for (var i = 0; i < _zlBooks.length; i++) {
        if (_zlBooks[i].series === seriesFilter) filtered.push(_zlBooks[i]);
      }
    }

    if (!filtered.length) {
      return '<div class="book-grid" id="bookGrid"><div class="home-status">该系列暂无书籍</div></div>';
    }

    var html = '<div class="book-grid" id="bookGrid">';
    for (var i = 0; i < filtered.length; i++) {
      var book = filtered[i];
      var downloaded = _isBookDownloaded(book.id);
      var seriesTitle = _getSeriesTitle(book.series);
      var chapterCount = book.chapter_count || 0;
      var progress = getReadingProgress(book.id);

      html += '<div class="book-card zl-book-card" data-book-id="' + escAttr(book.id) + '" data-series="' + escAttr(book.series) + '">';
      html += '<div class="book-card-wrapper">';
      html += '<div class="book-link" data-book-id="' + escAttr(book.id) + '" data-series="' + escAttr(book.series) + '" role="button" tabindex="0">';
      html += '<div class="book-info">';
      html += '<div class="book-header">';
      html += '<div class="book-title-row">';
      html += '<div class="title">' + escText(book.title || book.id) + '</div>';
      html += '<span class="download-icon">' + (downloaded ? '✅' : '☁️') + '</span>';
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
      html += '</div>';
      html += '</div>';
      html += '</div>';
      // ★ 管理模式下所有书籍显示删除按钮，导入书籍始终显示
      if (_manageMode || book.series === 'imported' || book.id.indexOf('imported-') === 0) {
        html += '<button type="button" class="imported-delete-btn" data-book-id="' + escAttr(book.id) + '" title="删除">✕</button>';
      }
      html += '</div>';
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
    for (var i = 0; i < _zlSeries.length; i++) {
      var s = _zlSeries[i];
      html += '<div class="download-series-row">';
      html += '<span class="download-series-name">' + escText(s.title) + ' (' + (s.count || 0) + '本)</span>';
      html += '<button class="download-series-btn" data-series="' + escAttr(s.id) + '">下载</button>';
      html += '</div>';
    }
    html += '</div>';

    // 全部下载
    html += '<button class="download-all-btn" id="dlAllBtn">全部下载</button>';
    html += '</div>';

    // 遮罩
    html += '<div class="download-panel-overlay' + (_dlPanelOpen ? ' open' : '') + '" id="dlOverlay"></div>';
    return html;
  }

  /**
   * 绑定导入按钮事件（抽取为独立函数，供空书籍状态和正常状态共用）
   */
  function _bindImportBtnEvent() {
    var importBtn = document.getElementById('bk-import-btn');
    if (importBtn) {
      importBtn.addEventListener('click', function () {
        if (!win.ImportManager || !win.ImportManager.pickAndImport) return;
        importBtn.disabled = true;
        importBtn.textContent = '导入中...';
        win.ImportManager.pickAndImport().then(function (bookData) {
          importBtn.disabled = false;
          importBtn.textContent = '📂 导入';
          if (!bookData) return;
          // 合并到首页列表
          bookData.series = 'imported';
          // 防重复
          var dupBook = false;
          for (var di = 0; di < _zlBooks.length; di++) {
            if (_zlBooks[di].id === bookData.id) { dupBook = true; break; }
          }
          if (!dupBook) _zlBooks.push(bookData);
          if (_zlDownloadedIds.indexOf(bookData.id) === -1) _zlDownloadedIds.push(bookData.id);
          if (!win.__bkBooks) win.__bkBooks = [];
          win.__bkBooks.push(bookData);
          // 导航到导入的书
          if (win.BKRouter) win.BKRouter.navigate(bookData.id);
        }).catch(function (err) {
          importBtn.disabled = false;
          importBtn.textContent = '📂 导入';
          if (err && err.message) console.error('[导入]', err.message);
        });
      });
    }
  }

  /**
   * 绑定导入书籍删除按钮事件（独立函数，与 _bindImportBtnEvent 并列）
   */
  function _bindDeleteBtnEvents(homeView) {
    var delBtns = homeView.querySelectorAll('.imported-delete-btn');
    for (var di = 0; di < delBtns.length; di++) {
      delBtns[di].addEventListener('click', function (e) {
        e.stopPropagation();
        var bookId = this.getAttribute('data-book-id');
        if (!bookId) return;
        var btn = this;
        btn.disabled = true;
        btn.textContent = '...';
        var doDelete = function () {
          // 从 _zlBooks 中移除
          for (var i = _zlBooks.length - 1; i >= 0; i--) {
            if (_zlBooks[i].id === bookId) { _zlBooks.splice(i, 1); break; }
          }
          // 从 _zlDownloadedIds 中移除
          var dlIdx = _zlDownloadedIds.indexOf(bookId);
          if (dlIdx !== -1) _zlDownloadedIds.splice(dlIdx, 1);
          // 从 __bkBooks 中移除
          if (win.__bkBooks) {
            for (var j = win.__bkBooks.length - 1; j >= 0; j--) {
              if (win.__bkBooks[j].id === bookId) { win.__bkBooks.splice(j, 1); break; }
            }
          }
          // 重新渲染首页
          var hv = document.getElementById('homeView');
          if (hv) _renderZlHome(hv);
        };
        if (bookId.indexOf('imported-') === 0 && win.ImportManager && win.ImportManager.deleteImportedBook) {
          win.ImportManager.deleteImportedBook(bookId).then(doDelete).catch(function () {
            doDelete();
          });
        } else if (bookId.indexOf('imported-') !== 0 && win.DataManager && win.DataManager.deleteBook) {
          win.DataManager.deleteBook(bookId).then(doDelete).catch(function () {
            doDelete();
          });
        } else {
          doDelete();
        }
      });
    }
  }

  /**
   * 绑定管理按钮事件（独立函数，切换管理模式并重新渲染）
   */
  function _bindManageBtnEvent() {
    var manageBtn = document.getElementById('bk-manage-btn');
    if (manageBtn) {
      manageBtn.addEventListener('click', function () {
        _manageMode = !_manageMode;
        manageBtn.textContent = _manageMode ? '✅ 完成' : '🗑️ 管理';
        var hv = document.getElementById('homeView');
        if (hv) _renderZlHome(hv);
      });
    }
  }

  /**
   * 绑定首页事件
   */
  function _bindZlEvents(homeView) {
    // 系列标签点击
    var tabs = homeView.querySelectorAll('.series-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        var seriesId = this.getAttribute('data-series');
        _zlCurrentSeries = seriesId;
        // 更新标签状态
        var allTabs = homeView.querySelectorAll('.series-tab');
        for (var j = 0; j < allTabs.length; j++) {
          allTabs[j].className = 'series-tab' + (allTabs[j].getAttribute('data-series') === seriesId ? ' active' : '');
        }
        // 重新渲染书籍网格
        var gridContainer = document.getElementById('bookGrid');
        if (gridContainer && gridContainer.parentNode) {
          var newGrid = _buildBookGrid(seriesId);
          var tmp = document.createElement('div');
          tmp.innerHTML = newGrid;
          gridContainer.parentNode.replaceChild(tmp.firstChild, gridContainer);
          // 重新绑定书籍点击事件
          _bindBookClickEvents(homeView);
        }
      });
    }

    // 书籍卡片点击
    _bindBookClickEvents(homeView);

    // 下载管理按钮
    var dlMgrBtn = document.getElementById('bk-dl-mgr-btn');
    if (dlMgrBtn) {
      dlMgrBtn.addEventListener('click', function () {
        _toggleDownloadPanel(true);
        _refreshStorageStats();
      });
    }

    // 下载面板关闭按钮
    var dlClose = document.getElementById('dlPanelClose');
    if (dlClose) {
      dlClose.addEventListener('click', function () { _toggleDownloadPanel(false); });
    }

    // 下载面板遮罩
    var dlOverlay = document.getElementById('dlOverlay');
    if (dlOverlay) {
      dlOverlay.addEventListener('click', function () { _toggleDownloadPanel(false); });
    }

    // 系列下载按钮
    var seriesDlBtns = homeView.querySelectorAll('.download-series-btn');
    for (var k = 0; k < seriesDlBtns.length; k++) {
      seriesDlBtns[k].addEventListener('click', function () {
        var seriesId = this.getAttribute('data-series');
        _startSeriesDownload(seriesId);
      });
    }

    // 全部下载按钮
    var dlAllBtn = document.getElementById('dlAllBtn');
    if (dlAllBtn) {
      dlAllBtn.addEventListener('click', function () {
        _startAllDownload();
      });
    }

    // 暂停/取消按钮
    var dlPause = document.getElementById('dlPauseBtn');
    if (dlPause) {
      dlPause.addEventListener('click', function () {
        var status = win.DataManager.getDownloadStatus();
        if (status.isPaused) {
          win.DataManager.resumeDownload();
          dlPause.textContent = '暂停';
        } else {
          win.DataManager.pauseDownload();
          dlPause.textContent = '恢复';
        }
      });
    }
    var dlCancel = document.getElementById('dlCancelBtn');
    if (dlCancel) {
      dlCancel.addEventListener('click', function () {
        win.DataManager.cancelDownload();
        _stopProgressPolling();
      });
    }

    // 搜索按钮
    var searchBtn = document.getElementById('bk-search-btn');
    if (searchBtn) {
      searchBtn.addEventListener('click', function () {
        if (win.BKSearch && win.BKSearch.open) win.BKSearch.open();
      });
    }

    // ★ 导入按钮
    _bindImportBtnEvent();

    // ★ 管理按钮
    _bindManageBtnEvent();

    // ★ 导入书籍删除按钮
    _bindDeleteBtnEvents(homeView);
  }

  /**
   * 绑定书籍卡片点击事件
   */
  function _bindBookClickEvents(homeView) {
    var cards = homeView.querySelectorAll('.zl-book-card .book-link');
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener('click', function (e) {
        e.preventDefault();
        var bookId = this.getAttribute('data-book-id');
        var series = this.getAttribute('data-series');
        _handleBookClick(bookId, series, this);
      });
    }
  }

  /**
   * 处理书籍卡片点击：已下载则导航，未下载则先下载
   */
  function _handleBookClick(bookId, series, cardEl) {
    if (_isBookDownloaded(bookId)) {
      // 已下载，直接导航到章节列表
      if (win.BKRouter) win.BKRouter.navigate(bookId);
      return;
    }

    // 未下载，尝试下载后打开
    if (!_zlDmReady || !win.DataManager) {
      // DataManager 不可用，直接导航（可能走旧的 books.json 路径）
      if (win.BKRouter) win.BKRouter.navigate(bookId);
      return;
    }

    // 显示下载中状态
    var iconEl = cardEl ? cardEl.querySelector('.download-icon') : null;
    if (iconEl) iconEl.textContent = '⏳';

    win.DataManager.downloadBook(bookId, series)
      .then(function () {
        // 下载成功，更新状态
        _zlDownloadedIds.push(bookId);
        if (iconEl) iconEl.textContent = '✅';
        // 导航到书籍
        if (win.BKRouter) win.BKRouter.navigate(bookId);
      })
      .catch(function (err) {
        console.error('[Renderer] 书籍下载失败:', err);
        if (iconEl) iconEl.textContent = '❌';
        setTimeout(function () { if (iconEl) iconEl.textContent = '☁️'; }, 2000);
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
    var el = document.getElementById('dlStorageInfo');
    if (!el) return;
    win.DataManager.getStorageStats().then(function (stats) {
      el.textContent = '已下载 ' + stats.downloadedCount + ' 本书，占用 ' + stats.totalSizeFormatted;
    }).catch(function () {
      el.textContent = '存储统计获取失败';
    });
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
          var iconEl = cards[i].querySelector('.download-icon');
          if (iconEl) {
            iconEl.textContent = _isBookDownloaded(bookId) ? '✅' : '☁️';
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

  // ── 渲染器对象 ──────────────────────────────────────────────────────

  var BKRenderer = {

    // zl-html 渲染器激活标志
    _zlActive: false,

    // ── 首页：书籍列表（增强版：zl-html 系列分类 + 下载管理）──────────

    renderHome: function () {
      stopScrollTracking();
      showHome();

      var homeView = document.getElementById('homeView');
      if (!homeView) return;

      homeView.innerHTML = '<div class="bk-loading"><div class="bk-spinner"></div><div>加载中...</div></div>';

      // 尝试初始化 DataManager 并加载 zl-html 索引
      var dmUrl = '';
      try {
        if (win.REMOTE_CONFIG && win.REMOTE_CONFIG.zl_html_data) {
          dmUrl = win.REMOTE_CONFIG.zl_html_data;
        }
      } catch (e) {}

      if (dmUrl && win.DataManager) {
        win.DataManager.setBaseUrl(dmUrl);
        _zlDmReady = true;
      }

      var indexPromise = _zlDmReady
        ? win.DataManager.loadIndex()
        : Promise.resolve(null);

      var downloadedPromise = _zlDmReady
        ? win.DataManager.getDownloadedBookIds()
        : Promise.resolve([]);

      Promise.all([indexPromise, downloadedPromise])
        .then(function (results) {
          var indexData = results[0];
          var downloadedIds = results[1] || [];

          if (indexData && indexData.series && indexData.books) {
            _zlIndex = indexData;
            _zlSeries = indexData.series || [];
            _zlBooks = indexData.books || [];
            _zlDownloadedIds = downloadedIds;
            BKRenderer._zlActive = true;
            // 将 zl-html 书籍合并到 __bkBooks，供书签等功能查找书名
            if (!win.__bkBooks) win.__bkBooks = [];
            for (var zi = 0; zi < _zlBooks.length; zi++) {
              var zlBook = _zlBooks[zi];
              var found = false;
              for (var bi = 0; bi < win.__bkBooks.length; bi++) {
                if (win.__bkBooks[bi].id === zlBook.id) { found = true; break; }
              }
              if (!found) win.__bkBooks.push(zlBook);
            }
          } else {
            _zlSeries = [];
            _zlBooks = [];
            _zlDownloadedIds = [];
            BKRenderer._zlActive = false;
          }

          // ★ 合并导入书籍
          return _mergeImportedBooks().then(function () {
            _renderZlHome(homeView);
          });
        })
        .catch(function (err) {
          console.warn('[Renderer] DataManager 加载失败，回退:', err.message);
          _zlSeries = [];
          _zlBooks = [];
          _zlDownloadedIds = [];
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
      showApp();
      var app = getApp();
      app.innerHTML = '<div class="bk-loading"><div class="bk-spinner"></div><div>加载中...</div></div>';

      loadBook(bookId).then(function (book) {
        var chapters = book.chapters || [];
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
      showApp();
      var app = getApp();
      app.innerHTML = '<div class="bk-loading"><div class="bk-spinner"></div><div>加载中...</div></div>';

      loadBook(bookId).then(function (book) {
        var chapters = book.chapters || [];
        var chapter = null;
        for (var i = 0; i < chapters.length; i++) {
          if (chapters[i].number === chapterNum) {
            chapter = chapters[i];
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
        var totalChapters = chapters.length;
        var progressPct = totalChapters > 0 ? Math.round(chapterNum / totalChapters * 100) : 0;
        html += '<div class="bk-reading-progress">' +
          '<div class="bk-reading-progress-bar" style="width:' + progressPct + '%"></div>' +
          '</div>';

        // 章节标题
        html += '<div class="bk-reading-header">';
        html += '<div class="bk-reading-book-title">' + escText(book.title || '') + '</div>';
        html += '<h1 class="bk-reading-chapter-title">' + escText(chapter.title || '第' + chapterNum + '章') + '</h1>';
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
      }).catch(function (err) {
        app.innerHTML = '<div class="bk-error">' +
          '<div class="bk-error-icon">⚠️</div>' +
          '<div class="bk-error-text">加载失败: ' + escText(err.message) + '</div>' +
          '</div>';
      });
    }
  };

  // ── 暴露 ──────────────────────────────────────────────────────────────

  win.BKRenderer = BKRenderer;

}(window));
