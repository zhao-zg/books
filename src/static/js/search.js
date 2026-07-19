/*!
 * search.js — 书报搜索（两阶段搜索）
 * 阶段 1：书名搜索（基于 books-index.json，带相关性评分）
 * 阶段 2：内容搜索（基于按需全文内容索引，仅已下载/已导入书籍）
 * 按系列分组显示，防抖 300ms，分页加载（每页 50 条）
 */
(function (win) {
  'use strict';

  // ── 工具函数 ──────────────────────────────────────────────────────────

  function esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 每页显示条数
  var PAGE_SIZE = 50;

  // 错误码常量（与 dm-shared.js / renderer-data.js 中保持一致，模块内独立定义避免跨模块引用）
  // ★ M5修复：将散落本文件的 'CANCELLED' 字面量收敛为常量
  var ERR_CANCELLED = 'CANCELLED';

  var BKSearch = {
    _modal: null,
    _input: null,
    _resultsEl: null,
    _countEl: null,
    _debounceTimer: null,
    _inBackStack: false,
    _lockCleanup: null,

    // 搜索范围：'title' 仅书名 | 'all' 书名+内容
    _scope: 'title',

    // 搜索历史（localStorage, 最多 10 条）
    _historyKey: 'bk_search_history',
    _maxHistory: 10,
    _scrollObserver: null,

    /**
     * 检查书籍是否有上次阅读进度
     */
    _hasProgress: function (bookId) {
      return this._getReadingProgress(bookId) > 0;
    },

    /**
     * 读取书籍上次阅读进度（章节号）
     * ★ M3修复：优先调用 BKRenderer.getReadingProgress API，
     *   不再直读 localStorage（'bk_progress:' 前缀是 renderer 内部约定）。
     *   旧版本 fallback 保留，应对 Service Worker 缓存导致 renderer 未更新的极端情况。
     */
    _getReadingProgress: function (bookId) {
      if (win.BKRenderer && typeof win.BKRenderer.getReadingProgress === 'function') {
        try { return win.BKRenderer.getReadingProgress(bookId) || 0; } catch(e) { return 0; }
      }
      try { return parseInt(localStorage.getItem('bk_progress:' + bookId) || '0', 10); } catch(e) { return 0; }
    },

    // 当前搜索状态
    _currentQuery: '',
    _allResults: [],      // 当前搜索全部结果
    _displayedCount: 0,   // 已渲染条数
    _isLoading: false,    // 搜索进行中
    _contentTimer: null,  // 内容搜索异步定时器

    // ── 书名搜索（同步，基于 books-index.json）──────────────────────────

    /**
     * 在书目索引中按 title / id 模糊匹配
     * @param {string} query 搜索关键词
     * @returns {Array} 匹配结果数组
     */
    _searchTitles: function (query) {
      if (!query.trim()) return [];

      // 获取 DataManager 缓存的索引
      var DM = win.DataManager;
      if (!DM) return [];

      var index = DM.getCachedIndex();
      if (!index || !index.books) return [];

      var books = index.books;
      var series = index.series || [];
      var terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      var results = [];

      // 构建 series id → title 映射
      var seriesMap = {};
      for (var s = 0; s < series.length; s++) {
        seriesMap[series[s].id] = series[s].title;
      }

      for (var i = 0; i < books.length; i++) {
        var book = books[i];
        var hay = ((book.title || '') + ' ' + (book.id || '')).toLowerCase();
        var titleLower = (book.title || '').toLowerCase();
        var ok = true;
        var totalScore = 0;
        for (var j = 0; j < terms.length; j++) {
          if (hay.indexOf(terms[j]) === -1) { ok = false; break; }
          // 计算每个 term 的相关性分数
          if (titleLower === terms[j]) {
            totalScore += 3;  // 精确匹配
          } else if (titleLower.indexOf(terms[j]) === 0) {
            totalScore += 2;  // 开头匹配
          } else {
            totalScore += 1;  // 包含匹配
          }
        }
        if (ok) {
          results.push({
            type: 'title',            // 书名匹配
            bookId: book.id,
            bookTitle: book.title || book.id,
            series: book.series || '',
            seriesTitle: seriesMap[book.series] || book.series || '',
            chapterTitle: '',
            context: '',
            url: book.id,
            score: totalScore
          });
        }
      }

      // 按分数降序排列
      results.sort(function (a, b) { return b.score - a.score; });

      return results;
    },

    // ── 内容搜索（基于按需全文内容索引，同步）──────────────────────

    /**
     * 在已下载/已导入书籍的全文内容索引中搜索
     * 阶段2：遍历 _contentIndexMap 中每本书的每个章节，匹配全文
     * @param {string} query 搜索关键词
     * @returns {Array} 匹配结果数组
     */
    _searchContent: function (query) {
      if (!query.trim()) return [];

      var DM = win.DataManager;
      if (!DM) return [];
      var indexMap = DM.getContentIndexMap();
      if (!indexMap) return [];

      var terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      var results = [];

      // 构建 series id → title 映射（从主索引）
      var mainIndex = DM.getCachedIndex();
      var seriesList = (mainIndex && mainIndex.series) || [];
      var seriesMap = {};
      for (var s = 0; s < seriesList.length; s++) {
        seriesMap[seriesList[s].id] = seriesList[s].title;
      }

      var bookIds = Object.keys(indexMap);
      for (var b = 0; b < bookIds.length; b++) {
        var book = indexMap[bookIds[b]];
        var chapters = book.chapters || [];
        for (var c = 0; c < chapters.length; c++) {
          var ch = chapters[c];
          var hayTitle = (ch.t || '').toLowerCase();
          var hayContent = (ch.c || '').toLowerCase();
          var hayCombined = hayTitle + ' ' + hayContent;

          // AND 逻辑：所有关键词必须在标题或正文中至少出现一次
          var allMatch = true;
          for (var j = 0; j < terms.length; j++) {
            if (hayCombined.indexOf(terms[j]) === -1) {
              allMatch = false;
              break;
            }
          }

          if (allMatch) {
            // 评分：标题匹配加分，正文匹配基础分
            var titleMatch = false;
            for (var j = 0; j < terms.length; j++) {
              if (hayTitle.indexOf(terms[j]) !== -1) { titleMatch = true; break; }
            }
            var score = titleMatch ? 2 : 1;

            // 提取匹配上下文：找到首个关键词出现位置，截取前后 30 字
            var context = '';
            if (hayContent) {
              var firstPos = -1;
              for (var t = 0; t < terms.length; t++) {
                var p = hayContent.indexOf(terms[t]);
                if (p !== -1 && (firstPos === -1 || p < firstPos)) firstPos = p;
              }
              if (firstPos !== -1) {
                var ctxFrom = Math.max(0, firstPos - 30);
                var ctxTo = Math.min(hayContent.length, firstPos + 30);
                context = (ctxFrom > 0 ? '\u2026' : '') +
                  ch.c.substring(ctxFrom, ctxTo) +
                  (ctxTo < hayContent.length ? '\u2026' : '');
              }
            }

            results.push({
              type: 'content',
              bookId: book.id,
              bookTitle: book.title,
              series: book.series || '',
              seriesTitle: seriesMap[book.series] || book.series || '',
              chapterTitle: ch.t || ('\u7B2C' + ch.n + '\u7AE0'),
              chapterNumber: ch.n,
              context: context,
              url: book.id + '/' + ch.n,
              score: score
            });
          }
        }
      }

      results.sort(function (a, b) { return b.score - a.score; });
      return results;
    },

    // ── 搜索索引搜索已移除，改为 _searchContent 基于按需全文内容索引 ────────

    // ── 高亮匹配关键词 ──────────────────────────────────────────────────

    _highlightText: function (text, query) {
      if (!query.trim()) return esc(text);
      var terms = query.trim().split(/\s+/).filter(Boolean);
      var html = esc(text);
      for (var i = 0; i < terms.length; i++) {
        var re = new RegExp('(' + escRe(terms[i]) + ')', 'gi');
        html = html.replace(re, '<span class="bk-search-hl">$1</span>');
      }
      return html;
    },

    // ── 搜索执行 ────────────────────────────────────────────────────────

    /**
     * 执行搜索：两阶段
     * 1. 同步：书名搜索（_searchTitles）→ 即时结果
     * 2. 同步：内容搜索（_searchContent）→ 基于按需全文内容索引
     */
    _doSearch: function (query) {
      var self = this;
      self._currentQuery = query;
      self._allResults = [];
      self._displayedCount = 0;

      if (!query.trim()) {
        self._renderEmpty();
        return;
      }

      var startTime = Date.now();

      // 1. 书名搜索（同步，即时完成）
      var titleResults = [];
      if (self._scope === 'title' || self._scope === 'all') {
        titleResults = self._searchTitles(query);
      }

      // 2. 内容搜索（仅 'all' 模式）
      if (self._scope === 'all') {
        var DM = win.DataManager;
        var indexMap = DM ? DM.getContentIndexMap() : null;

        if (!indexMap && DM) {
          // 内容索引尚未加载，先显示书名结果，同时触发加载
          self._isLoading = true;
          self._allResults = titleResults;
          self._displayedCount = 0;
          self._renderPage();

          // 显示加载提示
          if (self._resultsEl) {
            var loadingHint = '<div class="bk-search-content-loading">\uD83D\uDCE5 正在加载内容索引...</div>';
            self._resultsEl.insertAdjacentHTML('beforeend', loadingHint);
          }

          DM.loadContentIndexes().then(function () {
            if (self._currentQuery !== query) return;
            self._doSearchPhase2(query, titleResults, startTime);
          }).catch(function () {
            if (self._currentQuery !== query) return;
            // 加载失败，只显示书名结果
            self._allResults = titleResults;
            self._isLoading = false;
            self._renderPage();
            self._updateCount(Date.now() - startTime);
            self._addSearchHistory(query);
          });
        } else {
          // 内容索引已就绪，直接执行
          self._doSearchPhase2(query, titleResults, startTime);
        }
      } else {
        // 仅书名模式
        var elapsed = Date.now() - startTime;
        self._allResults = titleResults;
        self._isLoading = false;
        self._renderPage();
        self._updateCount(elapsed);
        self._addSearchHistory(query);
      }
    },

    /**
     * 阶段 2：内容搜索（基于按需全文内容索引，同步）
     */
    _doSearchPhase2: function (query, titleResults, startTime) {
      var self = this;

      var contentResults = self._searchContent(query);

      // 去重：如果某书已在书名结果中出现，且内容搜索中只有1条匹配，则跳过
      // （1条章节匹配不比书名匹配提供更多价值；多条则保留，提供具体章节入口）
      var titleBookIds = {};
      for (var t = 0; t < titleResults.length; t++) {
        titleBookIds[titleResults[t].bookId] = true;
      }
      var bookMatchCount = {};
      for (var ci = 0; ci < contentResults.length; ci++) {
        var bid = contentResults[ci].bookId;
        bookMatchCount[bid] = (bookMatchCount[bid] || 0) + 1;
      }

      var filteredContent = [];
      for (var cf = 0; cf < contentResults.length; cf++) {
        var result = contentResults[cf];
        if (titleBookIds[result.bookId] && bookMatchCount[result.bookId] <= 1) continue;
        filteredContent.push(result);
      }

      // 合并：书名结果 → 内容结果
      self._allResults = titleResults.concat(filteredContent);
      self._displayedCount = 0;
      self._isLoading = false;
      self._renderPage();

      var elapsed = Date.now() - startTime;
      self._updateCount(elapsed);
      self._addSearchHistory(query);
    },

    /**
     * 更新搜索结果计数显示
     */
    _updateCount: function (elapsedMs) {
      if (!this._countEl) return;
      var total = this._allResults.length;
      var timeStr = elapsedMs < 1000
        ? (elapsedMs + 'ms')
        : ((elapsedMs / 1000).toFixed(1) + 's');

      if (total > 0) {
        this._countEl.textContent = '找到 ' + total + ' 条结果（' + timeStr + '）';
      } else if (this._currentQuery.trim()) {
        this._countEl.textContent = '无结果（' + timeStr + '）';
      } else {
        this._countEl.textContent = '输入关键词搜索';
      }
    },

    // ── 搜索结果渲染（分页 + 按系列分组）──────────────────────────────────

    /**
     * 渲染搜索结果页（支持分页追加）
     * @param {boolean} [append] 是否追加模式
     */
    _renderPage: function (append) {
      var self = this;
      if (!self._resultsEl) return;

      var results = self._allResults;
      var query = self._currentQuery;

      if (!results.length && !self._isLoading) {
        if (!append) {
          if (query.trim()) {
            var emptyHtml = '<div class="bk-search-empty">未找到相关内容</div>';
            // 仅书名模式下无结果时，提示切换到全文搜索
            if (self._scope === 'title') {
              emptyHtml += '<div class="bk-search-scope-hint">试试切换到「书名+内容」模式搜索更多结果</div>';
            }
            self._resultsEl.innerHTML = emptyHtml;
            // 绑定提示点击事件，自动切换到 all 模式
            var hintEl = self._resultsEl.querySelector('.bk-search-scope-hint');
            if (hintEl) {
              hintEl.addEventListener('click', function () {
                self._scope = 'all';
                var radios = self._modal ? self._modal.querySelectorAll('.bk-scope-radio') : [];
                for (var ri = 0; ri < radios.length; ri++) {
                  radios[ri].checked = (radios[ri].value === 'all');
                }
                self._renderResults(query);
              });
            }
          } else {
            self._resultsEl.innerHTML = '<div class="bk-search-hint">输入关键词开始搜索</div>';
          }
        }
        return;
      }

      var startIdx = append ? self._displayedCount : 0;
      var endIdx = Math.min(startIdx + PAGE_SIZE, results.length);

      // 如果非追加模式，先清空
      if (!append) {
        self._resultsEl.innerHTML = '';
        self._displayedCount = 0;
        startIdx = 0;
      }

      if (startIdx >= results.length) return;

      // 构建 HTML（按系列分组）
      var html = '';
      var lastSeries = '';
      var lastBook = '';

      for (var i = startIdx; i < endIdx; i++) {
        var r = results[i];

        // 系列分组标题
        if (r.series !== lastSeries) {
          if (lastBook) html += '</div>'; // 关闭上一个书籍分组
          if (lastSeries) html += '</div>'; // 关闭上一个系列分组
          lastSeries = r.series;
          lastBook = '';
          html += '<div class="bk-search-series-group">';
          html += '<div class="bk-search-series-title">📚 ' + esc(r.seriesTitle || r.series) + '</div>';
        }

        // 书籍分组标题（可点击，显示缓存状态）
        if (r.bookTitle !== lastBook) {
          if (lastBook) html += '</div>';
          lastBook = r.bookTitle;
          html += '<div class="bk-search-group">';
          html += '<div class="bk-search-group-title bk-search-group-title-clickable"' +
            ' data-book-id="' + esc(r.bookId) + '"' +
            ' data-series="' + esc(r.series) + '">📖 ' + esc(lastBook) +
            ' <span class="bk-search-cache-status" data-book-id="' + esc(r.bookId) + '"></span></div>';
        }

        // 搜索结果条目
        var typeLabel;
        if (r.type === 'title') {
          typeLabel = '<span class="bk-search-tag bk-tag-title">书名匹配</span>';
        } else if (r.type === 'content-index') {
          typeLabel = '<span class="bk-search-tag bk-tag-chapter">章节匹配</span>';
        } else {
          typeLabel = '<span class="bk-search-tag bk-tag-content">内容匹配</span>';
        }

        html += '<a class="bk-search-item" href="#' + esc(r.url) + '" data-url="' + esc(r.url) + '" data-book-id="' + esc(r.bookId) + '" data-series="' + esc(r.series) + '">';
        if (win.BKRenderer && win.BKRenderer._coverHTML) {
          html += win.BKRenderer._coverHTML(r, { size: 'sm', seriesTitle: r.seriesTitle });
        }
        html += '<div class="bk-search-item-body">';
        html += '<div class="bk-search-item-meta">';
        html += typeLabel;
        if (r.chapterTitle) {
          html += ' <span class="bk-search-chapter">' + esc(r.chapterTitle) + '</span>';
        }
        html += '</div>';

        // 内容匹配显示上下文
        if ((r.type === 'content' || r.type === 'content-index') && r.context) {
          html += '<div class="bk-search-item-text">' + self._highlightText(r.context, query) + '</div>';
        } else if (r.type === 'title') {
          html += '<div class="bk-search-item-text bk-search-hint-text">点击打开书籍' + (self._hasProgress(r.bookId) ? '（继续阅读）' : '') + '</div>';
        }

        html += '</div>';
        html += '</a>';
      }

      if (lastBook) html += '</div>';
      if (lastSeries) html += '</div>';

      // 追加或替换
      if (append) {
        // 移除旧的"加载更多"按钮
        var oldMore = self._resultsEl.querySelector('.bk-search-load-more');
        if (oldMore) oldMore.parentNode.removeChild(oldMore);
        self._resultsEl.insertAdjacentHTML('beforeend', html);
      } else {
        self._resultsEl.innerHTML = html;
      }

      self._displayedCount = endIdx;

      // 显示"加载更多"按钮 或 使用无限滚动
      if (endIdx < results.length) {
        var remaining = results.length - endIdx;
        var loadMoreHtml = '<div class="bk-search-load-more" data-remaining="' + remaining + '">' +
          '<button class="bk-search-load-btn">加载更多（还有 ' + remaining + ' 条）</button>' +
          '</div>';
        self._resultsEl.insertAdjacentHTML('beforeend', loadMoreHtml);

        var loadBtn = self._resultsEl.querySelector('.bk-search-load-btn');
        if (loadBtn) {
          loadBtn.addEventListener('click', function () {
            self._renderPage(true);
          });
        }

        // 移动端：IntersectionObserver 无限滚动
        self._setupInfiniteScroll();
      }

      // 绑定点击事件
      var items = self._resultsEl.querySelectorAll('.bk-search-item');
      for (var k = startIdx; k < items.length; k++) {
        (function (item) {
          item.addEventListener('click', function (e) {
            e.preventDefault();
            var url = item.getAttribute('data-url');
            var bookId = item.getAttribute('data-book-id');
            var series = item.getAttribute('data-series');
            var DM = win.DataManager;

            function doNavigate() {
              if (win.BKRouter) {
                // 检查阅读进度，有进度则直接跳转到上次阅读的章节
                // ★ M3修复：通过 self._getReadingProgress 封装函数获取进度，
                //   不再直读 localStorage key
                var progress = self._getReadingProgress(bookId);
                if (progress > 0 && bookId) {
                  win.BKRouter.navigate(bookId + '/' + progress);
                } else if (url) {
                  win.BKRouter.navigate(url.replace(/^#\/?/, ''));
                }
              }
              self.close(true);
            }

            // 检查书籍是否已下载，未下载则先自动下载
            if (DM && bookId) {
              DM.isBookDownloaded(bookId).then(function (downloaded) {
                if (downloaded) {
                  doNavigate();
                } else {
                  // 未缓存：显示下载中状态，自动下载后打开
                  var textEl = item.querySelector('.bk-search-item-text');
                  var origHTML = textEl ? textEl.innerHTML : '';
                  item.classList.add('bk-search-item-downloading');
                  if (textEl) textEl.textContent = '⏳ 正在下载书籍...';

                  // ★ 防导航劫持：登记本书为「最后点击下载的书」（与书城共享同一协调机制）
                  // 用户此后在书城或搜索框再点其他书下载时，本书完成后将不抢跳转
                  if (win.BKRenderer && win.BKRenderer.claimDownloadNavigate) {
                    win.BKRenderer.claimDownloadNavigate(bookId);
                  }

                  DM.downloadBook(bookId, series || '').then(function () {
                    // ★ M4修复：item DOM 已脱离文档 → 用户重新搜索导致旧 DOM 被替换，
                    //   放弃所有 UI 更新与导航（下载本身仍会完成并缓存，下次点击这本书可直接打开）
                    if (!item.isConnected) return;
                    item.classList.remove('bk-search-item-downloading');
                    // ★ 守卫1：若已被后续点击覆盖（用户点了其他书下载），本书静默退出不抢跳
                    if (win.BKRenderer && win.BKRenderer.isClaimedDownloadNavigate &&
                        !win.BKRenderer.isClaimedDownloadNavigate(bookId)) return;
                    // ★ 守卫2：搜索面板已关闭 + 书城不可见 → 用户已离开（如打开了别的书），不抢跳
                    if ((!self._modal || self._modal.style.display === 'none')) {
                      var homeEl = document.getElementById('homeView');
                      if (!homeEl || homeEl.style.display === 'none') return;
                    }
                    doNavigate();
                  }).catch(function (err) {
                    // ★ M4修复：item DOM 已脱离文档 → 跳过无意义的 UI 更新与导航
                    if (!item.isConnected) return;
                    item.classList.remove('bk-search-item-downloading');
                    // ★ 若已被后续点击覆盖，静默退出不抢跳
                    if (win.BKRenderer && win.BKRenderer.isClaimedDownloadNavigate &&
                        !win.BKRenderer.isClaimedDownloadNavigate(bookId)) return;
                    // ★ C1修复：用户主动取消（CANCELLED）做无声清理，不报"下载失败"也不强制跳转
                    //   参照 _handleBookClick（renderer-city-helpers.js:319-327）的 CANCELLED 处理模式
                    // ★ M5修复：使用 ERR_CANCELLED 常量替代字面量
                    if (err && err.code === ERR_CANCELLED) {
                      if (textEl) textEl.innerHTML = '';
                      return;
                    }
                    if (textEl) textEl.innerHTML = '⚠ 下载失败，点击重试';
                    console.error('[BKSearch] 下载书籍失败:', err);
                    // 降级：仍尝试直接导航（renderChapterList → loadBook 会再次尝试下载）
                    doNavigate();
                  });
                }
              }).catch(function () {
                // isBookDownloaded 检查失败，降级直接导航
                doNavigate();
              });
            } else {
              doNavigate();
            }
          });
        })(items[k]);
      }

      // 绑定书名标题点击事件（点击书名导航到书籍首页）
      var groupTitles = self._resultsEl.querySelectorAll('.bk-search-group-title-clickable');
      for (var g = 0; g < groupTitles.length; g++) {
        (function (title) {
          if (title._clickBound) return;
          title._clickBound = true;
          title.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var bookId = title.getAttribute('data-book-id');
            var series = title.getAttribute('data-series');
            var DM = win.DataManager;

            function doNavigate() {
              if (bookId && win.BKRouter) {
                // 检查阅读进度，有进度则直接跳转到上次阅读的章节
                // ★ M3修复：通过 self._getReadingProgress 封装函数获取进度，
                //   不再直读 localStorage key
                var progress = self._getReadingProgress(bookId);
                if (progress > 0) {
                  win.BKRouter.navigate(bookId + '/' + progress);
                } else {
                  win.BKRouter.navigate(bookId);
                }
              }
              self.close(true);
            }

            if (DM && bookId) {
              DM.isBookDownloaded(bookId).then(function (downloaded) {
                if (downloaded) {
                  doNavigate();
                } else {
                  // 未缓存：显示下载中状态
                  var statusEl = title.querySelector('.bk-search-cache-status');
                  if (statusEl) { statusEl.textContent = '⏳'; statusEl.style.color = 'var(--gold)'; }
                  // ★ 防导航劫持：登记本书为「最后点击下载的书」（与书城共享同一协调机制）
                  if (win.BKRenderer && win.BKRenderer.claimDownloadNavigate) {
                    win.BKRenderer.claimDownloadNavigate(bookId);
                  }
                  DM.downloadBook(bookId, series || '').then(function () {
                    // ★ M4修复：title DOM 已脱离文档 → 用户重新搜索导致旧 DOM 被替换，
                    //   放弃导航与状态更新（下载本身仍会完成并缓存）
                    if (!title.isConnected) return;
                    // ★ 守卫1：若已被后续点击覆盖，本书静默退出不抢跳
                    if (win.BKRenderer && win.BKRenderer.isClaimedDownloadNavigate &&
                        !win.BKRenderer.isClaimedDownloadNavigate(bookId)) return;
                    // ★ 守卫2：搜索面板已关闭 + 书城不可见 → 用户已离开，不抢跳
                    if ((!self._modal || self._modal.style.display === 'none')) {
                      var homeEl = document.getElementById('homeView');
                      if (!homeEl || homeEl.style.display === 'none') return;
                    }
                    doNavigate();
                  }).catch(function (err) {
                    // ★ M4修复：title DOM 已脱离文档 → 跳过无意义的 UI 更新与导航
                    if (!title.isConnected) return;
                    // ★ 若已被后续点击覆盖，静默退出不抢跳
                    if (win.BKRenderer && win.BKRenderer.isClaimedDownloadNavigate &&
                        !win.BKRenderer.isClaimedDownloadNavigate(bookId)) return;
                    // ★ C1修复：用户主动取消（CANCELLED）做无声清理，不报"下载失败"也不强制跳转
                    // ★ M5修复：使用 ERR_CANCELLED 常量替代字面量
                    if (err && err.code === ERR_CANCELLED) {
                      if (statusEl) { statusEl.textContent = ''; statusEl.style.color = ''; }
                      return;
                    }
                    if (statusEl) { statusEl.textContent = '✗'; statusEl.style.color = 'var(--danger-text)'; }
                    console.error('[BKSearch] 下载书籍失败:', err);
                    doNavigate();
                  });
                }
              }).catch(function () { doNavigate(); });
            } else {
              doNavigate();
            }
          });
        })(groupTitles[g]);
      }

      // 异步更新缓存状态图标
      var DM = win.DataManager;
      if (DM && DM.isBookDownloaded) {
        var statusEls = self._resultsEl.querySelectorAll('.bk-search-cache-status');
        var pending = {};
        for (var s = 0; s < statusEls.length; s++) {
          var bid = statusEls[s].getAttribute('data-book-id');
          if (!bid) continue;
          if (!pending[bid]) pending[bid] = [];
          pending[bid].push(statusEls[s]);
        }
        var bookIds = Object.keys(pending);
        for (var b = 0; b < bookIds.length; b++) {
          (function (bookId, els) {
            DM.isBookDownloaded(bookId).then(function (downloaded) {
              for (var j = 0; j < els.length; j++) {
                els[j].textContent = downloaded ? '✓' : '☁';
                els[j].style.color = downloaded ? 'var(--brand)' : 'var(--text-muted)';
              }
            }).catch(function () {
              for (var j = 0; j < els.length; j++) {
                els[j].textContent = '☁';
                els[j].style.color = 'var(--text-muted)';
              }
            });
          })(bookIds[b], pending[bookIds[b]]);
        }
      }
    },

    /**
     * 渲染空搜索状态（热门系列推荐）
     */
    _renderEmpty: function () {
      if (!this._resultsEl) return;
      if (this._countEl) this._countEl.textContent = '输入关键词搜索';

      var self = this;
      var html = '';

      // 搜索历史
      var history = self._getSearchHistory();
      if (history.length) {
        html += '<div class="bk-search-history">';
        html += '<div class="bk-search-history-title">搜索历史 <button class="bk-search-history-clear">清除</button></div>';
        html += '<div class="bk-search-history-list">';
        for (var h = 0; h < history.length; h++) {
          html += '<a class="bk-search-history-item" href="javascript:void(0)" data-query="' + esc(history[h]) + '">' + esc(history[h]) + '</a>';
        }
        html += '</div></div>';
      }

      // 热门系列推荐
      var DM = win.DataManager;
      var index = DM ? DM.getCachedIndex() : null;
      var seriesList = (index && index.series) || [];

      if (seriesList.length) {
        html += '<div class="bk-search-popular">';
        html += '<div class="bk-search-popular-title">热门系列</div>';
        html += '<div class="bk-search-series-list">';
        for (var i = 0; i < seriesList.length; i++) {
          var s = seriesList[i];
          html += '<a class="bk-search-series-card" href="#series/' + esc(s.id) + '" data-series="' + esc(s.id) + '">';
          html += '<div class="bk-search-series-name">' + esc(s.title) + '</div>';
          html += '<div class="bk-search-series-count">' + (s.count || 0) + ' 本</div>';
          html += '</a>';
        }
        html += '</div></div>';
      }

      if (!html) {
        html = '<div class="bk-search-hint">输入关键词开始搜索</div>';
      }

      this._resultsEl.innerHTML = html;

      // 绑定搜索历史点击
      if (history.length) {
        var historyItems = this._resultsEl.querySelectorAll('.bk-search-history-item');
        for (var hi = 0; hi < historyItems.length; hi++) {
          (function (item) {
            item.addEventListener('click', function (e) {
              e.preventDefault();
              var q = item.getAttribute('data-query');
              if (self._input) {
                self._input.value = q;
                self._renderResults(q);
              }
            });
          })(historyItems[hi]);
        }
        var clearBtn = this._resultsEl.querySelector('.bk-search-history-clear');
        if (clearBtn) {
          clearBtn.addEventListener('click', function () {
            self._clearSearchHistory();
            self._renderEmpty();
          });
        }
      }

      // 绑定系列卡片点击
      var cards = this._resultsEl.querySelectorAll('.bk-search-series-card');
      for (var c = 0; c < cards.length; c++) {
        (function (card) {
          card.addEventListener('click', function (e) {
            e.preventDefault();
            var seriesId = card.getAttribute('data-series');
            if (seriesId && win.BKRouter) {
              win.BKRouter.navigate('series/' + seriesId);
            }
            self.close(true);
          });
        })(cards[c]);
      }
    },

    // ── 搜索历史管理 ────────────────────────────────────────────────

    _getSearchHistory: function () {
      try {
        var raw = localStorage.getItem(this._historyKey);
        return raw ? JSON.parse(raw) : [];
      } catch (e) { return []; }
    },

    _addSearchHistory: function (query) {
      if (!query.trim()) return;
      var history = this._getSearchHistory();
      // 去重并移到最前
      var idx = history.indexOf(query);
      if (idx !== -1) history.splice(idx, 1);
      history.unshift(query);
      if (history.length > this._maxHistory) history = history.slice(0, this._maxHistory);
      try { localStorage.setItem(this._historyKey, JSON.stringify(history)); } catch (e) {}
    },

    _clearSearchHistory: function () {
      try { localStorage.removeItem(this._historyKey); } catch (e) {}
    },

    // ── 渲染搜索结果入口（兼容旧调用）────────────────────────────────────

    _renderResults: function (query) {
      this._doSearch(query);
    },

    // ── Modal UI ────────────────────────────────────────────────────────

    open: function () {
      var self = this;
      if (this._modal) {
        this._modal.style.display = 'flex';
        // 同步搜索范围单选按钮状态
        var radios = this._modal.querySelectorAll('.bk-scope-radio');
        for (var i = 0; i < radios.length; i++) {
          radios[i].checked = (radios[i].value === this._scope);
        }
        // reopen 时重新锁定遮罩滚动（防止触摸穿透）
        if (win.BK && win.BK.lockOverlayScroll) {
          this._lockCleanup = win.BK.lockOverlayScroll(this._modal, function () { self.close(); });
        }
        if (this._input) setTimeout(function () { self._input.focus(); }, 100);
        return;
      }

      var modal = document.createElement('div');
      modal.className = 'bk-search-overlay';
      // 平板/宽屏：3×3 网格布局（设计稿 29:140）
      if (win.matchMedia && win.matchMedia('(min-width: 768px)').matches) {
        modal.classList.add('bk-search-tablet');
      }
      modal.innerHTML =
        '<div class="bk-search-modal">' +
          '<div class="bk-search-header">' +
            '<input type="search" class="bk-search-input" id="bkSearchInput" placeholder="搜索书籍..." autocomplete="off">' +
            '<button class="bk-search-close" id="bkSearchClose">✕</button>' +
          '</div>' +
          '<div class="bk-search-toolbar" id="bkSearchToolbar">' +
            '<div class="bk-search-scope-toggle">' +
              '<label class="bk-scope-label">' +
                '<input type="radio" name="bkSearchScope" value="title" class="bk-scope-radio" checked> ' +
                '<span class="bk-scope-text">仅书名</span>' +
              '</label>' +
              '<label class="bk-scope-label">' +
                '<input type="radio" name="bkSearchScope" value="all" class="bk-scope-radio"> ' +
                '<span class="bk-scope-text">书名+内容</span>' +
              '</label>' +
            '</div>' +
          '</div>' +
          '<div class="bk-search-count" id="bkSearchCount">输入关键词搜索</div>' +
          '<div class="bk-search-results" id="bkSearchResults"></div>' +
        '</div>';

      document.body.appendChild(modal);
      this._modal = modal;
      this._input = document.getElementById('bkSearchInput');
      this._resultsEl = document.getElementById('bkSearchResults');
      this._countEl = document.getElementById('bkSearchCount');

      // 关闭按钮
      document.getElementById('bkSearchClose').addEventListener('click', function () {
        self.close();
      });

      // 搜索输入（300ms 防抖）
      this._input.addEventListener('input', function () {
        clearTimeout(self._debounceTimer);
        var q = self._input.value;
        self._debounceTimer = setTimeout(function () {
          if (!q.trim()) {
            self._renderEmpty();
          } else {
            self._renderResults(q);
          }
        }, 300);
      });

      // ESC 关闭
      this._input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') self.close();
      });

      // 搜索范围切换
      var scopeRadios = modal.querySelectorAll('.bk-scope-radio');
      for (var r = 0; r < scopeRadios.length; r++) {
        scopeRadios[r].addEventListener('change', function (e) {
          self._scope = e.target.value || 'all';
          // 切换范围时立即重新搜索
          if (self._input && self._input.value.trim()) {
            self._renderResults(self._input.value);
          }
        });
      }

      // 点击遮罩关闭
      modal.addEventListener('click', function (e) {
        if (e.target === modal) self.close();
      });

      // 显示热门系列推荐（空搜索状态）
      self._renderEmpty();

      setTimeout(function () { self._input.focus(); }, 100);

      // 注册 backStack
      if (win.BK && win.BK.backStack) {
        win.BK.backStack.push(function () { self.close(); });
        this._inBackStack = true;
      }

      // 锁定遮罩滚动
      if (win.BK && win.BK.lockOverlayScroll) {
        this._lockCleanup = win.BK.lockOverlayScroll(modal, function () { self.close(); });
      }
    },

    close: function (skipHistory) {
      if (this._modal) {
        this._modal.style.display = 'none';
      }
      if (this._contentTimer) {
        clearTimeout(this._contentTimer);
        this._contentTimer = null;
      }
      // 清理无限滚动 observer
      if (this._scrollObserver) {
        this._scrollObserver.disconnect();
        this._scrollObserver = null;
      }
      if (this._lockCleanup) {
        this._lockCleanup();
        this._lockCleanup = null;
      }
      if (!skipHistory && this._inBackStack && win.BK && win.BK.backStack) {
        win.BK.backStack.discard();
      }
      this._inBackStack = false;
    },

    // ── 移动端无限滚动 ─────────────────────────────────────────────

    _setupInfiniteScroll: function () {
      var self = this;
      if (self._scrollObserver) {
        self._scrollObserver.disconnect();
      }

      var loadMore = self._resultsEl.querySelector('.bk-search-load-more');
      if (!loadMore) return;

      // 移动端使用 IntersectionObserver 自动加载
      if (!('IntersectionObserver' in win)) return;

      self._scrollObserver = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            self._scrollObserver.disconnect();
            self._scrollObserver = null;
            self._renderPage(true);
            break;
          }
        }
      }, {
        root: self._resultsEl,
        rootMargin: '200px',
        threshold: 0
      });

      self._scrollObserver.observe(loadMore);
    }
  };

  win.BKSearch = BKSearch;

}(window));
