/*!
 * search.js — 书报搜索（三阶段全局搜索）
 * 阶段 1：书名搜索（基于 books-index.json，带相关性评分）
 * 阶段 2：搜索索引搜索（基于 build-time search-index.json，覆盖所有书籍）
 * 阶段 3：深度内容搜索（基于已下载书籍，提供上下文片段）
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

  var BKSearch = {
    _modal: null,
    _input: null,
    _resultsEl: null,
    _countEl: null,
    _debounceTimer: null,
    _inBackStack: false,
    _lockCleanup: null,

    // 搜索范围：'title' 仅书名 | 'all' 书名+内容
    _scope: 'all',

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

    // ── 内容搜索（异步，基于已下载书籍）──────────────────────────────────

    /**
     * 遍历已下载书籍的章节内容搜索关键词
     * @param {string} query 搜索关键词
     * @param {function} callback 完成后回调 (results)
     */
    _searchContent: function (query, callback) {
      if (!query.trim()) {
        if (callback) callback([]);
        return;
      }

      var DM = win.DataManager;
      if (!DM) {
        if (callback) callback([]);
        return;
      }

      var terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

      // 获取已下载书籍 ID 列表
      DM.getDownloadedBookIds().then(function (downloadedIds) {
        if (!downloadedIds || !downloadedIds.length) {
          if (callback) callback([]);
          return;
        }

        var index = DM.getCachedIndex();
        var books = (index && index.books) || [];
        var seriesList = (index && index.series) || [];

        // 构建映射
        var bookInfoMap = {};
        for (var b = 0; b < books.length; b++) {
          bookInfoMap[books[b].id] = books[b];
        }
        var seriesMap = {};
        for (var s = 0; s < seriesList.length; s++) {
          seriesMap[seriesList[s].id] = seriesList[s].title;
        }

        var results = [];
        var pending = downloadedIds.length;
        var done = false;

        function finish() {
          if (!done) {
            done = true;
            if (callback) callback(results);
          }
        }

        // 逐个加载已下载书籍并搜索内容
        downloadedIds.forEach(function (bookId) {
          var info = bookInfoMap[bookId] || {};
          var series = info.series || '';
          var bookTitle = info.title || bookId;
          var seriesTitle = seriesMap[series] || series;

          DM.getBook(bookId, series).then(function (bookData) {
            if (done) return;
            if (bookData && bookData.chapters) {
              var chapters = bookData.chapters;
              for (var c = 0; c < chapters.length; c++) {
                var ch = chapters[c];
                var content = ch.content || '';
                if (Array.isArray(content)) {
                  content = content.map(function (c) { return c.text || ''; }).join('');
                }
                if (!content) continue;

                var contentLower = content.toLowerCase();
                var matched = true;
                for (var t = 0; t < terms.length; t++) {
                  if (contentLower.indexOf(terms[t]) === -1) {
                    matched = false;
                    break;
                  }
                }

                if (matched) {
                  // 提取匹配上下文（前后各 20 字）
                  var ctxStart = contentLower.indexOf(terms[0]);
                  var ctxFrom = Math.max(0, ctxStart - 20);
                  var ctxTo = Math.min(content.length, ctxStart + terms[0].length + 20);
                  var context = (ctxFrom > 0 ? '…' : '') +
                    content.substring(ctxFrom, ctxTo) +
                    (ctxTo < content.length ? '…' : '');

                  var chTitle = ch.title || (ch.number ? '第' + ch.number + '章' : '');

                  results.push({
                    type: 'content',        // 内容匹配
                    bookId: bookId,
                    bookTitle: bookTitle,
                    series: series,
                    seriesTitle: seriesTitle,
                    chapterTitle: chTitle,
                    chapterNumber: ch.number || 0,
                    context: context,
                    url: bookId + '/' + (ch.number || c + 1)
                  });
                }
              }
            }
            pending--;
            if (pending <= 0) finish();
          }).catch(function () {
            pending--;
            if (pending <= 0) finish();
          });
        });

        // 超时保护（15 秒）
        setTimeout(function () { finish(); }, 15000);

      }).catch(function () {
        if (callback) callback([]);
      });
    },

    // ── 搜索索引搜索（同步，基于 build-time search-index.json）──────────

    /**
     * 在构建时生成的搜索索引中搜索所有章节
     * 覆盖所有书籍（不仅是已下载的），使用章节标题和摘要匹配
     * @param {string} query 搜索关键词
     * @returns {Array} 匹配结果数组
     */
    _searchContentIndex: function (query) {
      var DM = win.DataManager;
      if (!DM) return [];
      var index = DM.getCachedSearchIndex();
      if (!index || !index.books) return [];

      var terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      var results = [];

      // 构建 series id → title 映射（从主索引）
      var mainIndex = DM.getCachedIndex();
      var seriesList = (mainIndex && mainIndex.series) || [];
      var seriesMap = {};
      for (var s = 0; s < seriesList.length; s++) {
        seriesMap[seriesList[s].id] = seriesList[s].title;
      }

      for (var i = 0; i < index.books.length; i++) {
        var book = index.books[i];
        for (var c = 0; c < book.chapters.length; c++) {
          var ch = book.chapters[c];
          var hayTitle = (ch.t || '').toLowerCase();
          var haySummary = (ch.s || '').toLowerCase();

          // Check title match
          var titleMatch = false;
          for (var j = 0; j < terms.length; j++) {
            if (hayTitle.indexOf(terms[j]) !== -1) { titleMatch = true; break; }
          }

          // Check summary match
          var summaryMatch = false;
          if (!titleMatch) {
            for (var k = 0; k < terms.length; k++) {
              if (haySummary.indexOf(terms[k]) !== -1) { summaryMatch = true; break; }
            }
          }

          if (titleMatch || summaryMatch) {
            var score = titleMatch ? 2 : 1;
            results.push({
              type: 'content-index',
              bookId: book.id,
              bookTitle: book.title,
              series: book.series || '',
              seriesTitle: seriesMap[book.series] || book.series || '',
              chapterTitle: ch.t || ('第' + ch.n + '章'),
              chapterNumber: ch.n,
              context: ch.s || '',
              url: book.id + '/' + ch.n,
              score: score
            });
          }
        }
      }

      results.sort(function (a, b) { return b.score - a.score; });
      return results;
    },

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
     * 执行搜索：三阶段
     * 1. 同步：书名搜索（_searchTitles）→ 即时结果
     * 2. 异步：搜索索引搜索（_searchContentIndex）→ 快速，覆盖所有书籍
     * 3. 异步：深度内容搜索（_searchContent）→ 慢速，仅已下载书籍，提供上下文片段
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

      self._isLoading = true;
      var startTime = Date.now();

      // 显示搜索中状态
      if (self._countEl) {
        self._countEl.textContent = '搜索中...';
      }
      if (self._resultsEl) {
        self._resultsEl.innerHTML = '<div class="bk-search-loading">正在搜索...</div>';
      }

      // 1. 书名搜索（同步，即时完成）
      var titleResults = [];
      if (self._scope === 'title' || self._scope === 'all') {
        titleResults = self._searchTitles(query);
      }

      // 2. 内容索引搜索 + 深度内容搜索（仅 'all' 模式）
      if (self._scope === 'all') {
        var DM = win.DataManager;
        var searchIndex = DM ? DM.getCachedSearchIndex() : null;

        if (!searchIndex && DM) {
          // 搜索索引尚未加载，先显示书名结果，同时触发加载
          self._allResults = titleResults;
          self._displayedCount = 0;
          self._renderPage();

          // 显示加载搜索索引提示
          if (self._resultsEl) {
            var loadingHint = '<div class="bk-search-content-loading">📥 正在加载搜索索引...</div>';
            self._resultsEl.insertAdjacentHTML('beforeend', loadingHint);
          }

          DM.loadSearchIndex().then(function () {
            if (self._currentQuery !== query) return;
            self._doSearchPhase2And3(query, titleResults, startTime);
          }).catch(function () {
            if (self._currentQuery !== query) return;
            // 加载失败，跳过内容索引搜索，直接进入深度搜索
            self._doSearchPhase3(query, titleResults, [], startTime);
          });
        } else {
          // 搜索索引已就绪，直接执行阶段 2 和 3
          self._doSearchPhase2And3(query, titleResults, startTime);
        }
      } else {
        // 仅书名模式
        var elapsed = Date.now() - startTime;
        self._allResults = titleResults;
        self._isLoading = false;
        self._renderPage();
        self._updateCount(elapsed);
      }
    },

    /**
     * 阶段 2：搜索索引搜索 + 阶段 3：深度内容搜索
     */
    _doSearchPhase2And3: function (query, titleResults, startTime) {
      var self = this;

      // 阶段 2：搜索索引搜索
      var contentIndexResults = self._searchContentIndex(query);

      // 去重：排除已在书名结果中出现的 bookId
      var titleBookIds = {};
      for (var t = 0; t < titleResults.length; t++) {
        titleBookIds[titleResults[t].bookId] = true;
      }

      // 过滤掉与书名结果重复的 bookId（仅当该书只有 1 个匹配时）
      var filteredContentIndex = [];
      for (var c = 0; c < contentIndexResults.length; c++) {
        filteredContentIndex.push(contentIndexResults[c]);
      }

      // 合并：书名结果 → 内容索引结果
      var merged = titleResults.concat(filteredContentIndex);
      self._allResults = merged;
      self._displayedCount = 0;
      self._renderPage();

      // 更新计数（搜索索引阶段完成）
      var elapsed2 = Date.now() - startTime;
      self._updateCount(elapsed2);

      // 阶段 3：深度内容搜索（异步，仅已下载书籍）
      if (self._contentTimer) clearTimeout(self._contentTimer);
      self._contentTimer = setTimeout(function () {
        self._searchContent(query, function (contentResults) {
          if (self._currentQuery !== query) return;

          // 构建已有结果的 URL 集合用于去重
          var existingUrls = {};
          for (var e = 0; e < self._allResults.length; e++) {
            existingUrls[self._allResults[e].url] = true;
          }

          // 添加不重复的深度内容结果，并为已有的 content-index 结果补充 context
          var newContentResults = [];
          for (var r = 0; r < contentResults.length; r++) {
            var cr = contentResults[r];
            if (existingUrls[cr.url]) {
              // 为已有的 content-index 结果补充深度上下文
              for (var m = 0; m < self._allResults.length; m++) {
                if (self._allResults[m].url === cr.url && self._allResults[m].type === 'content-index') {
                  self._allResults[m].context = cr.context;
                  self._allResults[m].deepContext = true;
                  break;
                }
              }
            } else {
              newContentResults.push(cr);
            }
          }

          self._allResults = self._allResults.concat(newContentResults);
          self._displayedCount = 0;
          self._isLoading = false;
          self._renderPage();

          var elapsed3 = Date.now() - startTime;
          self._updateCount(elapsed3);
        });
      }, 50);
    },

    /**
     * 阶段 3（回退）：当搜索索引加载失败时，仅执行深度内容搜索
     */
    _doSearchPhase3: function (query, titleResults, contentIndexResults, startTime) {
      var self = this;

      var merged = titleResults.concat(contentIndexResults);
      self._allResults = merged;
      self._displayedCount = 0;
      self._renderPage();

      if (self._contentTimer) clearTimeout(self._contentTimer);
      self._contentTimer = setTimeout(function () {
        self._searchContent(query, function (contentResults) {
          if (self._currentQuery !== query) return;

          var existingUrls = {};
          for (var e = 0; e < self._allResults.length; e++) {
            existingUrls[self._allResults[e].url] = true;
          }

          var newResults = [];
          for (var r = 0; r < contentResults.length; r++) {
            if (!existingUrls[contentResults[r].url]) {
              newResults.push(contentResults[r]);
            }
          }

          self._allResults = self._allResults.concat(newResults);
          self._displayedCount = 0;
          self._isLoading = false;
          self._renderPage();

          var elapsed = Date.now() - startTime;
          self._updateCount(elapsed);
        });
      }, 50);
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
          self._resultsEl.innerHTML = query.trim()
            ? '<div class="bk-search-empty">未找到相关内容</div>'
            : '<div class="bk-search-hint">输入关键词开始搜索</div>';
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

        // 书籍分组标题
        if (r.bookTitle !== lastBook) {
          if (lastBook) html += '</div>';
          lastBook = r.bookTitle;
          html += '<div class="bk-search-group">';
          html += '<div class="bk-search-group-title">📖 ' + esc(lastBook) + '</div>';
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

        html += '<a class="bk-search-item" href="#' + esc(r.url) + '" data-url="' + esc(r.url) + '">';
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
          html += '<div class="bk-search-item-text bk-search-hint-text">点击打开书籍</div>';
        }

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

      // 显示"加载更多"按钮
      if (endIdx < results.length) {
        var remaining = results.length - endIdx;
        var loadMoreHtml = '<div class="bk-search-load-more">' +
          '<button class="bk-search-load-btn">加载更多（还有 ' + remaining + ' 条）</button>' +
          '</div>';
        self._resultsEl.insertAdjacentHTML('beforeend', loadMoreHtml);

        var loadBtn = self._resultsEl.querySelector('.bk-search-load-btn');
        if (loadBtn) {
          loadBtn.addEventListener('click', function () {
            self._renderPage(true);
          });
        }
      }

      // 如果内容搜索还在进行中，显示提示
      if (self._isLoading && self._scope === 'all') {
        var loadingHint = '<div class="bk-search-content-loading">🔍 正在搜索更多内容...</div>';
        self._resultsEl.insertAdjacentHTML('beforeend', loadingHint);
      }

      // 绑定点击事件
      var items = self._resultsEl.querySelectorAll('.bk-search-item');
      for (var k = startIdx; k < items.length; k++) {
        (function (item) {
          item.addEventListener('click', function (e) {
            e.preventDefault();
            var url = item.getAttribute('data-url');
            if (url && win.BKRouter) {
              win.BKRouter.navigate(url.replace(/^#\/?/, ''));
            }
            self.close();
          });
        })(items[k]);
      }
    },

    /**
     * 渲染空搜索状态（热门系列推荐）
     */
    _renderEmpty: function () {
      if (!this._resultsEl) return;
      if (this._countEl) this._countEl.textContent = '输入关键词搜索';

      var DM = win.DataManager;
      var index = DM ? DM.getCachedIndex() : null;
      var seriesList = (index && index.series) || [];

      if (!seriesList.length) {
        this._resultsEl.innerHTML = '<div class="bk-search-hint">输入关键词开始搜索</div>';
        return;
      }

      var html = '<div class="bk-search-popular">';
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

      this._resultsEl.innerHTML = html;

      // 绑定系列卡片点击
      var cards = this._resultsEl.querySelectorAll('.bk-search-series-card');
      var self = this;
      for (var c = 0; c < cards.length; c++) {
        (function (card) {
          card.addEventListener('click', function (e) {
            e.preventDefault();
            var seriesId = card.getAttribute('data-series');
            if (seriesId && win.BKRouter) {
              win.BKRouter.navigate('series/' + seriesId);
            }
            self.close();
          });
        })(cards[c]);
      }
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
        if (this._input) setTimeout(function () { self._input.focus(); }, 100);
        return;
      }

      var modal = document.createElement('div');
      modal.className = 'bk-search-overlay';
      modal.innerHTML =
        '<div class="bk-search-modal">' +
          '<div class="bk-search-header">' +
            '<input type="search" class="bk-search-input" id="bkSearchInput" placeholder="搜索书籍..." autocomplete="off">' +
            '<button class="bk-search-close" id="bkSearchClose">✕</button>' +
          '</div>' +
          '<div class="bk-search-toolbar" id="bkSearchToolbar">' +
            '<div class="bk-search-scope-toggle">' +
              '<label class="bk-scope-label">' +
                '<input type="radio" name="bkSearchScope" value="title" class="bk-scope-radio"> ' +
                '<span class="bk-scope-text">仅书名</span>' +
              '</label>' +
              '<label class="bk-scope-label">' +
                '<input type="radio" name="bkSearchScope" value="all" class="bk-scope-radio" checked> ' +
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
          self._renderResults(q);
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

    close: function () {
      if (this._modal) {
        this._modal.style.display = 'none';
      }
      if (this._contentTimer) {
        clearTimeout(this._contentTimer);
        this._contentTimer = null;
      }
      if (this._lockCleanup) {
        this._lockCleanup();
        this._lockCleanup = null;
      }
      if (this._inBackStack && win.BK && win.BK.backStack) {
        win.BK.backStack.discard();
        this._inBackStack = false;
      }
    }
  };

  win.BKSearch = BKSearch;

}(window));
