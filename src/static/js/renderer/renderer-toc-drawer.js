'use strict';

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
      // 不自动聚焦搜索框，避免唤出键盘
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

