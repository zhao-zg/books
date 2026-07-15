'use strict';

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
      var label = (s.serverName && s.serverName.indexOf('://') < 0) ? s.serverName : 'WebDAV';
      return '<span class="book-source-badge book-source-webdav" title="' + escAttr(label) + '">☁ ' + escText(label) + '</span>';
    }
    return '';
  }

  /**
   * 导入来源的人类可读标签（用于书架副标题 / 封面系列位，替代泄漏的 series='imported' 字面量）。
   *  - webdav -> 服务器名称（缺省回退 'WebDAV'）
   *  - local  -> '本地导入'
   * 无 source（书城目录书）返回 ''（交给 series 兜底）。
   */
  function _sourceLabel(book) {
    var s = book && book.source;
    if (!s || !s.type) return '';
    if (s.type === 'webdav') return (s.serverName && s.serverName.indexOf('://') < 0) ? s.serverName : 'WebDAV';
    if (s.type === 'local') return '本地导入';
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
