/*!
 * pdf-state.js - PDF 阅读器全局状态管理
 *
 * 所有 PDF 子模块共享的常量、状态和工具函数。
 * 必须在所有 pdf-*.js 之前加载。
 *
 * 挂载：window.BKPdf._internal.state
 */
(function (win) {
  'use strict';

  var doc = win.document;

  // ==================== 常量 ====================

  var PDF_VENDOR_BASE = './vendor/';
  var CMAP_URL = PDF_VENDOR_BASE + 'cmaps/';
  var STANDARD_FONT_URL = PDF_VENDOR_BASE + 'standard_fonts/';
  var IMAGE_RESOURCES_PATH = PDF_VENDOR_BASE + 'images/';

  var MAX_ZOOM = 3.0;           // 最大放大倍数
  var MIN_ZOOM = 1.0;           // 最小倍数（= fit-to-width）
  var ZOOM_STEP = 0.5;          // 每次缩放步长
var RECYCLE_THRESHOLD = 10;   // 超过此数量的已渲染页面触发回收（配合 PRERENDER_ADJACENT=2）
var PRERENDER_ADJACENT = 3;   // 预渲染相邻页数（前后各 3 页），快速滑动时零白屏

  // 阅读模式
  var MODE_SINGLE = 'single';       // 单页横向滑动
  var MODE_CONTINUOUS = 'continuous'; // 连续垂直滚动
  var MODE_REFLOW = 'reflow';       // 文字重排（流式阅读）

  // 夜间/护眼模式
  var NIGHT_NORMAL = 'normal';
  var NIGHT_SEPIA = 'sepia';
  var NIGHT_GREEN = 'green';
  var NIGHT_INVERT = 'invert';

  // ==================== 状态 ====================

  var _pdfDocCache = {};            // pdfBookId → Promise<PDFDocument>
  var _pdfRenderObserver = null;    // IntersectionObserver
  var _pdfCurrentPageObserver = null; // 当前页检测 IntersectionObserver（rootMargin:0，J2优化）
  var _pdfZoomState = {};           // pdfBookId → { zoom }
  var _pdfActivePages = [];         // 当前已渲染的页面元素列表（用于回收）
  var _pdfRenderAbort = {};         // elKey → AbortController（取消进行中的渲染）
  var _pdfCurrentBookId = null;     // 当前阅读的 PDF 书 ID
  var _pdfCurrentChapterNum = null; // 当前章节号
  var _pdfTotalPages = 0;           // 当前 PDF 总页数
  var _pdfMode = MODE_CONTINUOUS;     // 当前阅读模式（默认连续滚动）
  var _pdfNightMode = NIGHT_NORMAL; // 夜间模式
  var _pdfOutlineData = {};         // pdfBookId → outline 树
  var _pdfOutlineStore = null;      // localforage instance（持久化 outline 用）
  // 与 import-shared 一致的 store，便于跨刷新复用
  var _pdfPageLabels = null;        // 页码标签数组（PDF 内部页码 → 显示页码）
  var _pdfResizeHandler = null;     // 视口变化重渲染的防抖处理器
  var _pdfResizeTimer = null;       // 防抖定时器
  var _pdfScrollHandler = null;     // 滚动监听（更新页码指示器）
  var _pdfCurrentPage = 1;          // 当前显示的页码
  var _pdfBackStack = [];           // 跳转后返回栈 [{ bookId, page, scroll }]
  var _pdfSearchState = null;       // 搜索状态 { query, matches, currentIdx, highlights }
  var _pdfThumbnailsRendered = {};  // 已渲染的缩略图 pageNum → true
  var _pdfBookmarks = {};           // bookId → [{ page, title, timestamp }]
  var _pdfHighlights = {};          // bookId → [{ id, page, text, rects, color, timestamp }]
  var _pdfInitialized = false;      // 是否已初始化
  var _themeUserOverride = false;   // 用户是否手动切换过护眼模式（true 时忽略主题联动）
  var _pdfBookTextLayer = {};       // bookId → boolean（PDF 是否有可重排文字层）
  var _pdfTextLayerProbed = {};     // bookId → boolean（是否已完成文字层探测）

  // ==================== 工具函数 ====================

  function escAttr(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escText(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * 获取当前 PDF 书 ID
   */
  function getCurrentBookId() {
    return _pdfCurrentBookId;
  }

  /**
   * 获取当前阅读模式
   */
  function getMode() {
    return _pdfMode;
  }

  /**
   * 设置阅读模式
   */
  function setMode(mode) {
    if (mode !== MODE_SINGLE && mode !== MODE_CONTINUOUS && mode !== MODE_REFLOW) return;
    // 扫描型 PDF（无可重排文字层）回退到 Continuous，避免 Reflow 空白
    if (mode === MODE_REFLOW && _pdfCurrentBookId && _pdfBookTextLayer[_pdfCurrentBookId] === false) {
      mode = MODE_CONTINUOUS;
    }
    _pdfMode = mode;
    // 持久化用户偏好
    try {
      localStorage.setItem('bk_pdf_mode', mode);
    } catch (e) {}
  }

  /**
   * 查询某本书是否支持 Reflow（有可重排的文字层）
   * 未探测完毕时返回 true（默认允许 Reflow，避免误隐藏）
   */
  function hasTextLayer(bookId) {
    if (!bookId) bookId = _pdfCurrentBookId;
    if (!bookId) return true;
    if (_pdfTextLayerProbed[bookId] !== true) return true; // 未探测完毕默认允许
    return _pdfBookTextLayer[bookId] !== false;
  }

  /**
   * 标记某本书的文字层探测结果
   */
  function setHasTextLayer(bookId, has) {
    if (!bookId) return;
    _pdfBookTextLayer[bookId] = !!has;
    _pdfTextLayerProbed[bookId] = true;
  }

  /**
   * 从 localStorage 恢复阅读模式偏好
   */
  function restoreMode() {
    try {
      var saved = localStorage.getItem('bk_pdf_mode');
      if (saved === MODE_SINGLE || saved === MODE_CONTINUOUS || saved === MODE_REFLOW) {
        _pdfMode = saved;
      }
    } catch (e) {}
    return _pdfMode;
  }

  /**
   * 获取夜间模式
   */
  function getNightMode() {
    return _pdfNightMode;
  }

  /**
   * 设置夜间/护眼模式（四档：normal / sepia / green / invert）
   */
  function setNightMode(mode, fromThemeSync) {
    if (mode !== NIGHT_NORMAL && mode !== NIGHT_SEPIA && mode !== NIGHT_GREEN && mode !== NIGHT_INVERT) return;
    _pdfNightMode = mode;
    // 用户手动切换时标记 override，主题联动不再自动覆盖
    if (!fromThemeSync) _themeUserOverride = true;
    try {
      localStorage.setItem('bk_pdf_night', mode);
    } catch (e) {}
    // 应用/移除对应 body class
    if (doc.body) {
      doc.body.classList.remove('bk-pdf-night', 'bk-pdf-sepia', 'bk-pdf-green');
      if (mode === NIGHT_INVERT) doc.body.classList.add('bk-pdf-night');
      else if (mode === NIGHT_SEPIA) doc.body.classList.add('bk-pdf-sepia');
      else if (mode === NIGHT_GREEN) doc.body.classList.add('bk-pdf-green');
    }
  }

  /**
   * 恢复夜间/护眼模式偏好
   */
  function restoreNightMode() {
    try {
      var saved = localStorage.getItem('bk_pdf_night');
      if (saved === NIGHT_SEPIA || saved === NIGHT_GREEN || saved === NIGHT_INVERT) {
        _pdfNightMode = saved;
        if (doc.body) {
          doc.body.classList.remove('bk-pdf-night', 'bk-pdf-sepia', 'bk-pdf-green');
          if (saved === NIGHT_INVERT) doc.body.classList.add('bk-pdf-night');
          else if (saved === NIGHT_SEPIA) doc.body.classList.add('bk-pdf-sepia');
          else if (saved === NIGHT_GREEN) doc.body.classList.add('bk-pdf-green');
        }
      }
    } catch (e) {}
    return _pdfNightMode;
  }

  /**
   * 获取 zoom 值
   */
  function getZoom(pdfBookId) {
    var st = _pdfZoomState[pdfBookId];
    return st ? st.zoom : 1.0;
  }

  /**
   * 获取当前页码
   */
  function getCurrentPage() {
    return _pdfCurrentPage;
  }

  /**
   * 设置当前页码
   */
  function setCurrentPage(page) {
    _pdfCurrentPage = page;
  }

  /**
   * 获取总页数
   */
  function getTotalPages() {
    return _pdfTotalPages;
  }

  /**
   * 设置总页数
   */
  function setTotalPages(total) {
    _pdfTotalPages = total;
  }

  /**
   * 生成页面元素的唯一 key（用于 abort 管理等）
   */
  function pageKey(el) {
    return el.dataset.pdfBook + ':' + el.dataset.pdfPage;
  }

  /**
   * 保存 PDF 阅读位置（页码）
   */
  function saveReadingPosition(bookId, page) {
    if (!bookId || !page) return;
    try {
      localStorage.setItem('bk_pdf_pos:' + bookId, String(page));
    } catch (e) {}
  }

  /**
   * 恢复 PDF 阅读位置
   */
  function restoreReadingPosition(bookId) {
    if (!bookId) return 0;
    try {
      var pos = localStorage.getItem('bk_pdf_pos:' + bookId);
      return pos ? parseInt(pos, 10) : 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 设置 outline 数据（同时持久化到 localforage，防止页面刷新后丢失）
   */
  function setOutline(bookId, outline) {
    var data = outline || [];
    _pdfOutlineData[bookId] = data;
    // 持久化（异步，不阻塞）
    try {
      if (!_pdfOutlineStore && typeof localforage !== 'undefined' && localforage.createInstance) {
        _pdfOutlineStore = localforage.createInstance({
          name: 'books',
          storeName: 'imported-data'
        });
      }
      if (_pdfOutlineStore) {
        _pdfOutlineStore.setItem('pdf-outline:' + bookId, data).catch(function () {});
      }
    } catch (e) {}
  }

  /**
   * 获取 outline 数据（优先内存缓存；若无则从 localforage 异步恢复）
   * 同步返回内存中已有数据；首次刷新页面后内存为空，需调 ensureOutlineLoad 异步预加载
   */
  function getOutline(bookId) {
    return _pdfOutlineData[bookId] || [];
  }

  /**
   * 异步从 localforage 加载 outline 到内存缓存
   * 在 BKPdf.init 时主动调用一次，确保 outline 抽屉可用
   * 返回 Promise<Array>
   */
  function ensureOutlineLoad(bookId) {
    if (_pdfOutlineData[bookId]) return Promise.resolve(_pdfOutlineData[bookId]);
    try {
      if (!_pdfOutlineStore && typeof localforage !== 'undefined' && localforage.createInstance) {
        _pdfOutlineStore = localforage.createInstance({
          name: 'books',
          storeName: 'imported-data'
        });
      }
    } catch (e) {}
    if (!_pdfOutlineStore) return Promise.resolve([]);
    return _pdfOutlineStore.getItem('pdf-outline:' + bookId).then(function (data) {
      if (data && data.length) {
        _pdfOutlineData[bookId] = data;
      }
      return _pdfOutlineData[bookId] || [];
    }).catch(function () { return []; });
  }

  /**
   * 根据页码获取所属章节名（遍历 outline 树）
   * 返回最深层匹配的章节 title
   */
  function getChapterNameByPage(bookId, page) {
    if (!bookId || !page) return '';
    var outline = _pdfOutlineData[bookId];
    if (!outline || !outline.length) return '';
    var result = _findChapterInTree(outline, page, '');
    return result;
  }

  function _findChapterInTree(nodes, page, parentTitle) {
    var bestMatch = '';
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var startPage = node.pageNumber || 0;
      var nextStart = (i + 1 < nodes.length) ? (nodes[i + 1].pageNumber || Infinity) : Infinity;
      // 当前节点覆盖 startPage ~ nextStart 之前
      if (startPage > 0 && startPage <= page && page < nextStart) {
        bestMatch = node.title || parentTitle;
        // 继续深入子节点
        if (node.children && node.children.length) {
          var deeper = _findChapterInTree(node.children, page, bestMatch);
          if (deeper) bestMatch = deeper;
        }
        break;
      }
    }
    return bestMatch;
  }

  // ==================== 用户书签 ====================

  /**
   * 获取指定书的用户书签列表
   */
  function getBookmarks(bookId) {
    if (!bookId) return [];
    if (!_pdfBookmarks[bookId]) {
      _loadBookmarksFromStorage(bookId);
    }
    return _pdfBookmarks[bookId] || [];
  }

  /**
   * 添加用户书签
   */
  function addBookmark(bookId, page, title) {
    if (!bookId || !page) return;
    if (!_pdfBookmarks[bookId]) _pdfBookmarks[bookId] = [];
    // 避免重复
    var existing = _pdfBookmarks[bookId];
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].page === page) return;
    }
    existing.push({
      page: page,
      title: title || ('第 ' + page + ' 页'),
      timestamp: Date.now()
    });
    _saveBookmarksToStorage(bookId);
  }

  /**
   * 删除用户书签
   */
  function removeBookmark(bookId, page) {
    if (!bookId || !page || !_pdfBookmarks[bookId]) return;
    var arr = _pdfBookmarks[bookId];
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i].page === page) {
        arr.splice(i, 1);
        break;
      }
    }
    _saveBookmarksToStorage(bookId);
  }

  /**
   * 判断指定页是否已加书签
   */
  function isBookmarked(bookId, page) {
    if (!bookId || !page || !_pdfBookmarks[bookId]) return false;
    var arr = _pdfBookmarks[bookId];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].page === page) return true;
    }
    return false;
  }

  /**
   * 修改书签标题（F4：书签标题编辑）
   * @returns {boolean} 是否修改成功
   */
  function setBookmarkTitle(bookId, page, title) {
    if (!bookId || !page || !_pdfBookmarks[bookId]) return false;
    var arr = _pdfBookmarks[bookId];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].page === page) {
        var trimmed = (title || '').trim();
        arr[i].title = trimmed || ('第 ' + page + ' 页');
        arr[i].timestamp = Date.now();
        _saveBookmarksToStorage(bookId);
        return true;
      }
    }
    return false;
  }

  function _loadBookmarksFromStorage(bookId) {
    try {
      var raw = localStorage.getItem('bk_pdf_bm:' + bookId);
      if (raw) {
        _pdfBookmarks[bookId] = JSON.parse(raw);
      } else {
        _pdfBookmarks[bookId] = [];
      }
    } catch (e) {
      _pdfBookmarks[bookId] = [];
    }
  }

  function _saveBookmarksToStorage(bookId) {
    try {
      localStorage.setItem('bk_pdf_bm:' + bookId, JSON.stringify(_pdfBookmarks[bookId] || []));
    } catch (e) {}
  }

  // ==================== 页码标签 ====================

  /**
   * 根据页码标签获取显示页码（如罗马数字 "iv"）
   */
  function getDisplayPageLabel(pageNum) {
    if (_pdfPageLabels && _pdfPageLabels.length >= pageNum && pageNum > 0) {
      var label = _pdfPageLabels[pageNum - 1];
      if (label) return label;
    }
    return String(pageNum);
  }

  // ==================== 高亮标注 ====================

  var HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink', 'orange'];

  function getHighlights(bookId) {
    if (!bookId) return [];
    if (!_pdfHighlights[bookId]) _loadHighlightsFromStorage(bookId);
    return _pdfHighlights[bookId] || [];
  }

  function addHighlight(bookId, highlight) {
    if (!bookId || !highlight) return;
    if (!_pdfHighlights[bookId]) _pdfHighlights[bookId] = [];
    highlight.id = 'hl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    highlight.timestamp = Date.now();
    _pdfHighlights[bookId].push(highlight);
    _saveHighlightsToStorage(bookId);
    return highlight.id;
  }

  function removeHighlight(bookId, hlId) {
    if (!bookId || !hlId || !_pdfHighlights[bookId]) return;
    var arr = _pdfHighlights[bookId];
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i].id === hlId) { arr.splice(i, 1); break; }
    }
    _saveHighlightsToStorage(bookId);
  }

  /**
   * 恢复标注（F5：撤销删除用，保留原 id/timestamp，不入栈新记录）
   * 校验必要字段完整性，防止快照损坏导致渲染异常
   */
  function restoreHighlight(bookId, hl) {
    if (!bookId || !hl || !hl.id || !hl.page || !hl.rects || !hl.color) return false;
    if (!_pdfHighlights[bookId]) _pdfHighlights[bookId] = [];
    var arr = _pdfHighlights[bookId];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === hl.id) return false; // 已存在，不重复
    }
    arr.push(hl);
    _saveHighlightsToStorage(bookId);
    return true;
  }

  /**
   * 修改标注批注内容（F5：撤销批注修改用）
   */
  function setHighlightNote(bookId, hlId, note) {
    if (!bookId || !hlId || !_pdfHighlights[bookId]) return false;
    var arr = _pdfHighlights[bookId];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === hlId) {
        arr[i].note = note || '';
        _saveHighlightsToStorage(bookId);
        return true;
      }
    }
    return false;
  }

  function getHighlightsByPage(bookId, page) {
    var all = getHighlights(bookId);
    var result = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].page === page) result.push(all[i]);
    }
    return result;
  }

  function _loadHighlightsFromStorage(bookId) {
    try {
      var raw = localStorage.getItem('bk_pdf_hl:' + bookId);
      if (raw) _pdfHighlights[bookId] = JSON.parse(raw);
      else _pdfHighlights[bookId] = [];
    } catch (e) {
      _pdfHighlights[bookId] = [];
    }
  }

  function _saveHighlightsToStorage(bookId) {
    try {
      localStorage.setItem('bk_pdf_hl:' + bookId, JSON.stringify(_pdfHighlights[bookId] || []));
    } catch (e) {}
  }

  // ==================== 抽屉互斥工具 ====================

  /**
   * 关闭所有抽屉/面板（除了指定模块）
   * 供各子模块在 show() 时调用，替代各自维护的 _closeOthers
   * @param {string} except - 不关闭的模块名（如 'search'）
   */
  function closeAllDrawersExcept(except) {
    var subs = win.BKPdf._internal;
    var drawerNames = ['thumbs', 'outline', 'search', 'bookmark', 'highlight'];
    for (var i = 0; i < drawerNames.length; i++) {
      if (drawerNames[i] === except) continue;
      var mod = subs[drawerNames[i]];
      if (mod && mod.hide) mod.hide();
    }
  }

  // ==================== 导出 ====================

  // 初始化 BKPdf 空壳（各子模块往 _internal 挂载）
  win.BKPdf = win.BKPdf || { _internal: {} };

  win.BKPdf._internal.state = {
    // 常量
    PDF_VENDOR_BASE: PDF_VENDOR_BASE,
    CMAP_URL: CMAP_URL,
    STANDARD_FONT_URL: STANDARD_FONT_URL,
    IMAGE_RESOURCES_PATH: IMAGE_RESOURCES_PATH,
    MAX_ZOOM: MAX_ZOOM,
    MIN_ZOOM: MIN_ZOOM,
    ZOOM_STEP: ZOOM_STEP,
    RECYCLE_THRESHOLD: RECYCLE_THRESHOLD,
    PRERENDER_ADJACENT: PRERENDER_ADJACENT,
    MODE_SINGLE: MODE_SINGLE,
    MODE_CONTINUOUS: MODE_CONTINUOUS,
    MODE_REFLOW: MODE_REFLOW,
    NIGHT_NORMAL: NIGHT_NORMAL,
    NIGHT_SEPIA: NIGHT_SEPIA,
    NIGHT_GREEN: NIGHT_GREEN,
    NIGHT_INVERT: NIGHT_INVERT,
    // 状态（可读写）
    docCache: function () { return _pdfDocCache; },
    setDocCache: function (v) { _pdfDocCache = v; },
    observer: function () { return _pdfRenderObserver; },
    setObserver: function (v) { _pdfRenderObserver = v; },
    currentPageObserver: function () { return _pdfCurrentPageObserver; },
    setCurrentPageObserver: function (v) { _pdfCurrentPageObserver = v; },
    zoomState: function () { return _pdfZoomState; },
    setZoomState: function (v) { _pdfZoomState = v; },
    activePages: function () { return _pdfActivePages; },
    setActivePages: function (v) { _pdfActivePages = v; },
    renderAbort: function () { return _pdfRenderAbort; },
    currentBookId: getCurrentBookId,
    setCurrentBookId: function (v) { _pdfCurrentBookId = v; },
    currentChapterNum: function () { return _pdfCurrentChapterNum; },
    setCurrentChapterNum: function (v) { _pdfCurrentChapterNum = v; },
    totalPages: getTotalPages,
    setTotalPages: setTotalPages,
    currentPage: getCurrentPage,
    setCurrentPage: setCurrentPage,
    mode: getMode,
    setMode: setMode,
    restoreMode: restoreMode,
    nightMode: getNightMode,
    setNightMode: setNightMode,
    restoreNightMode: restoreNightMode,
    // 主题联动 override 标记
    themeUserOverride: function () { return _themeUserOverride; },
    setThemeUserOverride: function (v) { _themeUserOverride = !!v; },
    // 主题联动：根据 data-theme 同步护眼模式
    syncFromAppTheme: syncFromAppTheme,
    zoom: getZoom,
    outline: getOutline,
    setOutline: setOutline,
    ensureOutlineLoad: ensureOutlineLoad,
    getChapterNameByPage: getChapterNameByPage,
    pageLabels: function () { return _pdfPageLabels; },
    setPageLabels: function (v) { _pdfPageLabels = v; },
    getDisplayPageLabel: getDisplayPageLabel,
    // 用户书签
    bookmarks: getBookmarks,
    addBookmark: addBookmark,
    removeBookmark: removeBookmark,
    isBookmarked: isBookmarked,
    setBookmarkTitle: setBookmarkTitle,
    // 高亮标注
    HIGHLIGHT_COLORS: HIGHLIGHT_COLORS,
    highlights: getHighlights,
    addHighlight: addHighlight,
    removeHighlight: removeHighlight,
    restoreHighlight: restoreHighlight,
    setHighlightNote: setHighlightNote,
    highlightsByPage: getHighlightsByPage,
    resizeHandler: function () { return _pdfResizeHandler; },
    setResizeHandler: function (v) { _pdfResizeHandler = v; },
    resizeTimer: function () { return _pdfResizeTimer; },
    setResizeTimer: function (v) { _pdfResizeTimer = v; },
    scrollHandler: function () { return _pdfScrollHandler; },
    setScrollHandler: function (v) { _pdfScrollHandler = v; },
    backStack: function () { return _pdfBackStack; },
    searchState: function () { return _pdfSearchState; },
    setSearchState: function (v) { _pdfSearchState = v; },
    thumbnailsRendered: function () { return _pdfThumbnailsRendered; },
    initialized: function () { return _pdfInitialized; },
    setInitialized: function (v) { _pdfInitialized = v; },
    // 文字层探测（扫描型 PDF 不支持 Reflow）
    hasTextLayer: hasTextLayer,
    setHasTextLayer: setHasTextLayer,
    // 抽屉互斥工具
    closeAllDrawersExcept: closeAllDrawersExcept,
    // 工具
    escAttr: escAttr,
    escText: escText,
    pageKey: pageKey,
    saveReadingPosition: saveReadingPosition,
    restoreReadingPosition: restoreReadingPosition
  };

  /**
   * 根据主应用 data-theme 属性同步 PDF 护眼模式
   * 规则：dark → invert（夜间反色），cool/warm → normal
   * 仅在用户未手动覆盖时执行
   */
  function syncFromAppTheme() {
    if (_themeUserOverride) return;   // 用户手动切换过，不覆盖
    var theme = doc.documentElement.getAttribute('data-theme') || 'cool';
    if (theme === 'dark') {
      if (_pdfNightMode !== NIGHT_INVERT) setNightMode(NIGHT_INVERT, true);
    } else {
      if (_pdfNightMode !== NIGHT_NORMAL) setNightMode(NIGHT_NORMAL, true);
    }
  }


})(window);
