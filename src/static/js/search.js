/*!
 * search.js — 书报全文搜索
 * 从 data/search-index.json 加载搜索索引 + 全屏 Modal UI + 段落级定位
 */
(function (win) {
  'use strict';

  function esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  var BKSearch = {
    _modal: null,
    _input: null,
    _resultsEl: null,
    _countEl: null,
    _debounceTimer: null,
    _inBackStack: false,
    _lockCleanup: null,

    // 搜索索引缓存
    _index: null,
    _indexLoading: false,

    // ── 加载搜索索引 ────────────────────────────────────────────────

    _ensureIndex: function () {
      if (this._index) return Promise.resolve(this._index);
      if (this._indexLoading) {
        // 等待正在进行的加载
        var self = this;
        return new Promise(function(resolve) {
          var check = setInterval(function() {
            if (self._index) { clearInterval(check); resolve(self._index); }
          }, 100);
          setTimeout(function() { clearInterval(check); resolve([]); }, 10000);
        });
      }
      this._indexLoading = true;
      var self = this;
      var root = win.BK_ROOT || './';
      var isNative = !!(win.Capacitor && win.Capacitor.isNativePlatform && win.Capacitor.isNativePlatform());
      var url = isNative
        ? root + 'data/search-index.json?_t=' + Date.now()
        : root + 'data/search-index.json';

      return fetch(url)
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (data) {
          self._index = data.entries || data || [];
          self._indexLoading = false;
          return self._index;
        })
        .catch(function (err) {
          self._indexLoading = false;
          console.warn('[搜索] 加载索引失败:', err);
          self._index = [];
          return [];
        });
    },

    // ── 搜索逻辑 ────────────────────────────────────────────────────

    search: function (query, entries) {
      if (!entries || !entries.length || !query.trim()) {
        return { results: [], total: 0 };
      }

      var terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      var results = [];

      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var hay = ((e.book_title || '') + ' ' + (e.chapter_title || '') + ' ' + (e.text || '')).toLowerCase();
        var ok = true;
        for (var j = 0; j < terms.length; j++) {
          if (hay.indexOf(terms[j]) === -1) { ok = false; break; }
        }
        if (ok) results.push(e);
      }

      return { results: results, total: results.length };
    },

    // 高亮匹配关键词
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

    // ── 搜索结果渲染 ────────────────────────────────────────────────

    _renderResults: function (query) {
      var self = this;
      self._ensureIndex().then(function (entries) {
        var result = self.search(query, entries);
        var results = result.results;
        var total = result.total;

        if (self._countEl) {
          self._countEl.textContent = total > 0
            ? '找到 ' + total + ' 条结果'
            : (query.trim() ? '无结果' : '输入关键词搜索');
        }

        if (!self._resultsEl) return;

        if (!results.length) {
          self._resultsEl.innerHTML = query.trim()
            ? '<div class="bk-search-empty">未找到相关内容</div>'
            : '<div class="bk-search-hint">输入关键词开始搜索</div>';
          return;
        }

        // 按书籍分组显示
        var maxShow = 50;
        var html = '';
        var lastBook = '';
        for (var i = 0; i < Math.min(results.length, maxShow); i++) {
          var r = results[i];
          if (r.book_title !== lastBook) {
            if (lastBook) html += '</div>';
            lastBook = r.book_title || '';
            html += '<div class="bk-search-group">';
            html += '<div class="bk-search-group-title">📖 ' + esc(lastBook) + '</div>';
          }
          var chapterLabel = r.chapter_title || (r.chapter ? '第' + r.chapter + '章' : '');
          html += '<a class="bk-search-item" href="#' + esc(r.url) + '" data-url="' + esc(r.url) + '">';
          html += '<div class="bk-search-item-meta">' + esc(chapterLabel) + '</div>';
          html += '<div class="bk-search-item-text">' + self._highlightText(r.text || '', query) + '</div>';
          html += '</a>';
        }
        if (lastBook) html += '</div>';

        if (results.length > maxShow) {
          html += '<div class="bk-search-more">还有 ' + (results.length - maxShow) + ' 条结果...</div>';
        }

        self._resultsEl.innerHTML = html;

        // 点击搜索结果跳转
        self._resultsEl.querySelectorAll('.bk-search-item').forEach(function (item) {
          item.addEventListener('click', function (e) {
            e.preventDefault();
            var url = item.getAttribute('data-url');
            if (url && win.BKRouter) {
              win.BKRouter.navigate(url.replace(/^#\/?/, ''));
            }
            self.close();
          });
        });
      });
    },

    // ── Modal UI ────────────────────────────────────────────────────

    open: function () {
      var self = this;
      if (this._modal) {
        this._modal.style.display = 'flex';
        if (this._input) setTimeout(function() { self._input.focus(); }, 100);
        return;
      }

      var modal = document.createElement('div');
      modal.className = 'bk-search-overlay';
      modal.innerHTML =
        '<div class="bk-search-modal">' +
          '<div class="bk-search-header">' +
            '<input type="search" class="bk-search-input" id="bkSearchInput" placeholder="搜索书籍内容..." autocomplete="off">' +
            '<button class="bk-search-close" id="bkSearchClose">✕</button>' +
          '</div>' +
          '<div class="bk-search-count" id="bkSearchCount">输入关键词搜索</div>' +
          '<div class="bk-search-results" id="bkSearchResults"></div>' +
        '</div>';

      document.body.appendChild(modal);
      this._modal = modal;
      this._input = document.getElementById('bkSearchInput');
      this._resultsEl = document.getElementById('bkSearchResults');
      this._countEl = document.getElementById('bkSearchCount');

      // 事件绑定
      document.getElementById('bkSearchClose').addEventListener('click', function () {
        self.close();
      });

      this._input.addEventListener('input', function () {
        clearTimeout(self._debounceTimer);
        var q = self._input.value;
        self._debounceTimer = setTimeout(function () {
          self._renderResults(q);
        }, 300);
      });

      this._input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') self.close();
      });

      modal.addEventListener('click', function (e) {
        if (e.target === modal) self.close();
      });

      // 预加载索引
      self._ensureIndex();

      setTimeout(function() { self._input.focus(); }, 100);

      // 注册 backStack
      if (win.BK && win.BK.backStack) {
        win.BK.backStack.push(function() { self.close(); });
        this._inBackStack = true;
      }

      // 锁定遮罩滚动
      if (win.BK && win.BK.lockOverlayScroll) {
        this._lockCleanup = win.BK.lockOverlayScroll(modal, function() { self.close(); });
      }
    },

    close: function () {
      if (this._modal) {
        this._modal.style.display = 'none';
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
