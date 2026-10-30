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
          'pointer-events:none;max-width:80vw;overflow-wrap:break-word;word-break:break-all;text-align:center}' +
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

  // 系列颜色调色板（Soft Nordic 低饱和调性：鼠尾草绿 / 陶土 / 暖赭 / 灰蓝 / 深褐 / 橄榄 / 石板 / 灰玫瑰 / 青灰 / 棕褐 / 雾紫 / 苔绿）。
  // 整体降饱和、提明度，避免相邻卡片色彩互相「跳动」；奶油白文字 (#FBF8F2) 在其上均清晰可读。
  var _seriesColors = [
    '#5E8C6A', // 1  鼠尾草绿 sage
    '#C2865E', // 2  陶土 terracotta
    '#C9A24A', // 3  暖赭 ochre
    '#6E8AA3', // 4  灰蓝 dusty blue
    '#A8855E', // 5  深褐 sepia
    '#8A9259', // 6  橄榄 olive
    '#73767F', // 7  石板 slate
    '#B07187', // 8  灰玫瑰 rose
    '#5E8C82', // 9  青灰 sage-teal
    '#9A7B5B', // 10 棕褐 tawny
    '#8A7BA3', // 11 雾紫 dusty violet
    '#7A8E5A'  // 12 苔绿 moss
  ];
  var _seriesColorMap = {};
  var _seriesColorIdx = 0;

  function _getSeriesColor(seriesId) {
    if (!seriesId) return '#3D8C6A';
    if (!_seriesColorMap[seriesId]) {
      _seriesColorMap[seriesId] = _seriesColors[_seriesColorIdx % _seriesColors.length];
      _seriesColorIdx++;
    }
    return _seriesColorMap[seriesId];
  }

  // 按明度因子微调颜色（amt ∈ [-1,1]：正提亮、负压暗），用于同系列多本书的轻微差异化。
  // 仅动 RGB 通道，不改变色相，保证相邻封面和谐。
  function _adjustBrightness(hex, amt) {
    var c = String(hex || '#000000').replace('#', '');
    if (c.length === 3) c = c.charAt(0) + c.charAt(0) + c.charAt(1) + c.charAt(1) + c.charAt(2) + c.charAt(2);
    var r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
    function _f(v) { var x = Math.round(v + amt * 255); return Math.max(0, Math.min(255, x)); }
    function _h(v) { var s = _f(v).toString(16); return s.length < 2 ? '0' + s : s; }
    return '#' + _h(r) + _h(g) + _h(b);
  }

  // 来源徽标：区分书籍的导入渠道，均仅显示图标以节省宽度。
  // - local    -> 「📁」
  // - webdav   -> 「☁」（服务器名称保留在 title 属性供 hover 查看）
  // - resource -> 「📦」（内置 EPUB 资源导入）
  // 无 source（书城目录书）不渲染徽标。
  function _sourceBadgeHTML(book) {
    var s = book && book.source;
    if (!s || !s.type) return '';
    if (s.type === 'local') {
      return '<span class="book-source-badge book-source-local">📁</span>';
    }
    if (s.type === 'webdav') {
      var label = (s.serverName && s.serverName.indexOf('://') < 0) ? s.serverName : 'WebDAV导入';
      return '<span class="book-source-badge book-source-webdav" title="' + escAttr(label) + '">☁</span>';
    }
    if (s.type === 'resource') {
      return '<span class="book-source-badge book-source-resource" title="内置资源">📦</span>';
    }
    return '';
  }

  /**
   * 导入来源的人类可读标签（用于书架副标题 / 封面系列位，替代泄漏的 series='imported' 字面量）。
   *  - webdav -> 服务器名称（缺省回退 'WebDAV导入'）
   *  - local  -> '本地导入'
   *  - resource -> '内置资源'
   * 无 source（书城目录书）返回 ''（交给 series 兜底）。
   */
  function _sourceLabel(book) {
    var s = book && book.source;
    if (!s || !s.type) return '';
    if (s.type === 'webdav') return (s.serverName && s.serverName.indexOf('://') < 0) ? s.serverName : 'WebDAV导入';
    if (s.type === 'local') return '本地导入';
    if (s.type === 'resource') return '内置资源';
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
    // 同系列多本书：按 book.id 派生轻微明度抖动（±9%），打破单色网格又保持和谐。
    // 仅影响封面底色，不改动 --series-color 左条，避免层级间颜色语义漂移。
    if (opts.varyByBook && b.id) {
      var _hid = String(b.id), _hh = 0;
      for (var _k = 0; _k < _hid.length; _k++) _hh = (_hh * 31 + _hid.charCodeAt(_k)) >>> 0;
      color = _adjustBrightness(color, ((_hh % 21) / 21 - 0.5) * 0.18);
    }
    var rawTitle = b.title || b.bookTitle || b.id || '';
    var title = rawTitle;
    var seriesTitle = opts.seriesTitle || '';
    var sizeCls = opts.size ? ' bk-cover--' + opts.size : '';

    // ★ 有真实封面图时直接展示（EPUB 提取的 data URI）
    // 安全校验：仅允许 data:image/ 开头的 URI，防止 XSS
    var coverUrl = b.cover || '';
    if (coverUrl && coverUrl.indexOf('data:image/') === 0) {
      var h = '<div class="bk-cover' + sizeCls + ' bk-cover--img" style="--cover-color:' + color + '" role="img" aria-label="' + escAttr(title + ' 封面') + '">';
      h += '<img class="bk-cover-img" src="' + escAttr(coverUrl) + '" alt="' + escAttr(title) + '" loading="lazy">';
      h += '</div>';
      return h;
    }

    // 无封面图时走版式封面
    var html = '<div class="bk-cover' + sizeCls + '" style="--cover-color:' + color + '" role="img" aria-label="' + escAttr(title + ' 封面') + '">';
    html += '<div class="bk-cover-inner">';
    if (seriesTitle) {
      html += '<div class="bk-cover-series">' + escText(seriesTitle) + '</div>';
    }
    html += '<div class="bk-cover-title">' + escText(title) + '</div>';
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
