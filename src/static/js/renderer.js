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

  // ── 渲染器对象 ──────────────────────────────────────────────────────

  var BKRenderer = {

    // ── 首页：书籍列表 ──────────────────────────────────────────────

    renderHome: function () {
      stopScrollTracking();
      showHome();

      var homeView = document.getElementById('homeView');
      if (!homeView) return;

      homeView.innerHTML = '<div class="bk-loading"><div class="bk-spinner"></div><div>加载中...</div></div>';

      loadBooksIndex().then(function (data) {
        var books = data.books || data || [];
        if (!Array.isArray(books)) books = [];

        if (!books.length) {
          homeView.innerHTML = '<div class="bk-empty">' +
            '<div class="bk-empty-icon">📚</div>' +
            '<div class="bk-empty-text">暂无书籍</div>' +
            '</div>';
          return;
        }

        var html = '<div class="book-list" id="booksGrid">';
        for (var i = 0; i < books.length; i++) {
          var book = books[i];
          var coverHtml = book.cover
            ? '<div class="book-card-cover"><img src="' + escAttr(book.cover) + '" alt="' + escAttr(book.title) + '" loading="lazy"></div>'
            : '<div class="book-card-cover book-card-cover-placeholder"><span class="book-card-icon">📖</span></div>';

          var meta = [];
          if (book.author) meta.push(escText(book.author));
          if (book.format) meta.push(escText(book.format.toUpperCase()));
          if (book.language) meta.push(escText(book.language));
          if (book.chapter_count) meta.push(book.chapter_count + '章');

          var progress = getReadingProgress(book.id);
          var progressHtml = '';
          if (progress > 0) {
            progressHtml = '<div class="book-card-progress">读到第' + progress + '章</div>';
          }

          html += '<a class="book-card" href="#/' + escAttr(book.id) + '">' +
            coverHtml +
            '<div class="book-card-info">' +
              '<div class="book-card-title">' + escText(book.title) + '</div>' +
              (meta.length ? '<div class="book-card-meta">' + meta.join(' · ') + '</div>' : '') +
              (book.description ? '<div class="book-card-desc">' + escText(book.description) + '</div>' : '') +
              progressHtml +
            '</div>' +
            '</a>';
        }
        html += '</div>';

        homeView.innerHTML = html;
        startScrollTracking('home');
        restoreScrollPosition('home');
      }).catch(function (err) {
        homeView.innerHTML = '<div class="bk-error">' +
          '<div class="bk-error-icon">⚠️</div>' +
          '<div class="bk-error-text">加载失败: ' + escText(err.message) + '</div>' +
          '</div>';
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
