/*!
 * renderer-pdf.js - PDF 阅读器主入口（聚合模块）
 *
 * 职责：
 *   - 组装 window.BKPdf 公共 API（向后兼容）
 *   - 协调各子模块（state/core/gesture/nav/links/thumbs/outline/ui/search）的 init/cleanup
 *   - 缩放控制（zoomIn/zoomOut/resetZoom）— 临时实现，后续迁移到 ui 模块
 *
 * 加载顺序：此文件必须在所有 pdf-*.js 子模块之后加载
 *
 * 挂载：window.BKPdf
 */
(function (win) {
  'use strict';

  var doc = win.document;
  var S = win.BKPdf._internal.state;
  var core = win.BKPdf._internal.core;

  // ==================== 缩放操作（从原 renderer-pdf.js 迁移）====================

  var _pdfZoomControls = null;
  var _pdfCurrentBookId = null;
  var _origSetTheme = null;  // 保存原始 setTheme 引用
  var _continuousViewEl = null; // 连续滚动模式独立容器
  var _reflowViewEl = null;    // Reflow 重排模式独立容器
  var _lifecycleDisposer = null; // AppLifecycle refresher 的反注册函数

  function _setZoom(pdfBookId, zoom) {
    zoom = Math.max(S.MIN_ZOOM, Math.min(S.MAX_ZOOM, zoom));
    S.zoomState()[pdfBookId] = S.zoomState()[pdfBookId] || {};
    S.zoomState()[pdfBookId].zoom = zoom;
    _updateZoomControls(zoom);
    // zoom > 1 时让 .bk-pdf-page 变为可滚动容器
    var pages = doc.querySelectorAll('.bk-pdf-page');
    for (var i = 0; i < pages.length; i++) {
      if (zoom > 1.0) {
        pages[i].classList.add('bk-pdf-zoomed');
      } else {
        pages[i].classList.remove('bk-pdf-zoomed');
      }
    }
    return zoom;
  }

  function _applyZoomToVisible(pdfBookId) {
    var pages = doc.querySelectorAll('.bk-pdf-page[data-pdf-rendered="1"], .bk-pdf-page[data-pdf-rendering="1"]');
    var vh = win.innerHeight || doc.documentElement.clientHeight;
    for (var i = 0; i < pages.length; i++) {
      var rect = pages[i].getBoundingClientRect();
      // 单页模式检查水平可见，连续模式检查垂直可见
      if (S.mode() === S.MODE_SINGLE) {
        var vw = win.innerWidth || doc.documentElement.clientWidth;
        if (rect.right <= 0 || rect.left >= vw) continue;
      } else {
        if (rect.bottom <= 0 || rect.top >= vh) continue;
      }
      pages[i].removeAttribute('data-pdf-rendered');
      core.renderPage(pages[i], true);
    }
  }

  function zoomIn(pdfBookId) {
    var z = S.zoom(pdfBookId);
    _setZoom(pdfBookId, z + S.ZOOM_STEP);
    _applyZoomToVisible(pdfBookId);
  }

  function zoomOut(pdfBookId) {
    var z = S.zoom(pdfBookId);
    _setZoom(pdfBookId, z - S.ZOOM_STEP);
    _applyZoomToVisible(pdfBookId);
  }

  function resetZoom(pdfBookId) {
    _setZoom(pdfBookId, 1.0);
    _applyZoomToVisible(pdfBookId);
  }

  // ==================== 缩放控件（嵌入底栏，不再独立创建胶囊）====================
  // 历史背景：原为右下角独立浮动胶囊 .bk-pdf-zoom-bar，现迁移到 ui 模块的全宽底栏中。
  // 本模块只负责：查询底栏引用 + 更新百分比文字 + 维护 bookId。

  function _ensureZoomControls() {
    // 底栏的缩放区由 ui 模块创建，这里只查询引用
    if (_pdfZoomControls) return _pdfZoomControls;
    var bottomBar = doc.querySelector('.bk-pdf-bottom-bar');
    if (bottomBar) {
      _pdfZoomControls = bottomBar.querySelector('.bk-pdf-bottom-zoom') || bottomBar;
    }
    return _pdfZoomControls;
  }

  function _showZoomControls(pdfBookId) {
    _pdfCurrentBookId = pdfBookId;
    // 底栏显隐由 ui 模块统一管理，这里只同步百分比文字
    // （若 ui.init 尚未创建底栏，_updateZoomControls 查询会安全跳过）
    _updateZoomControls(S.zoom(pdfBookId));
  }

  function _hideZoomControls() {
    _pdfCurrentBookId = null;
  }

  /**
   * 清空内部引用（底栏 DOM 由 ui 模块 lifecycle 管理移除，不需在此处理）
   */
  function _detachZoomControls() {
    _pdfZoomControls = null;
    _pdfCurrentBookId = null;
  }

  function _updateZoomControls(zoom) {
    // 直接查询底栏中的百分比文字（防止 _pdfZoomControls 引用过期）
    var val = doc.querySelector('.bk-pdf-bottom-bar .bk-pdf-zoom-value');
    if (val) val.textContent = Math.round(zoom * 100) + '%';
  }

  // ==================== 连续滚动模式 ====================

  /**
   * 探测 PDF 是否有可重排文字层
   * 用前 3 页的 getTextContent items 数判断，全部为 0 视为扫描型 PDF
   * 探测完毕后写入 state，并通知 UI 刷新模式按钮
   */
  function _probeTextLayer(bookId) {
    if (!bookId) return;
    var core = win.BKPdf._internal.core;
    if (!core || !core.getPdfDoc) return;

    core.getPdfDoc(bookId).then(function (pdf) {
      var probePages = Math.min(3, pdf.numPages || 1);
      var p = Promise.resolve();
      var totalItems = 0;
      for (var i = 1; i <= probePages; i++) {
        (function (pageNum) {
          p = p.then(function () {
            return pdf.getPage(pageNum).then(function (page) {
              return page.getTextContent({
                includeMarkedContent: false,
                disableCombineTextItems: false
              }).then(function (tc) {
                totalItems += (tc.items || []).length;
              });
            });
          });
        })(i);
      }
      return p.then(function () {
        var hasText = totalItems > 0;
        S.setHasTextLayer(bookId, hasText);
        // 通知 UI 刷新模式按钮可见性
        var ui = win.BKPdf._internal.ui;
        if (ui && ui._refreshModeBtn) ui._refreshModeBtn();
      });
    }).catch(function () {
      // 探测失败：按默认（支持 Reflow）处理，避免误隐藏
      S.setHasTextLayer(bookId, true);
    });
  }

  /**
   * 进入连续滚动模式：隐藏 Carousel，创建全屏滚动容器，一次性渲染所有 PDF 页面
   * 异步执行（需要从 PDF 文档获取总页数），完成后自动 cleanup + init
   */
  function _enterContinuousView() {
    var bookId = S.currentBookId();
    if (!bookId) return;

    core.getPdfDoc(bookId).then(function (pdf) {
      var totalPages = pdf.numPages;
      S.setTotalPages(totalPages);

      // 隐藏 Carousel track
      var track = doc.querySelector('.bk-carousel-track');
      if (track) track.style.display = 'none';

      // 创建全屏滚动容器
      var container = doc.createElement('div');
      container.id = 'bkPdfContinuousView';
      container.className = 'bk-pdf-continuous-view bk-pdf-mode';
      // T1: 单页 PDF 在连续模式下垂直居中，避免顶部贴齐+底部大片灰色空白
      if (totalPages === 1) container.classList.add('bk-pdf-continuous-single');

      // 生成所有 PDF 页面 HTML
      var html = '';
      for (var i = 1; i <= totalPages; i++) {
        html += core.generatePageHTML({ pageNumber: i, pdfBookId: bookId });
      }
      container.innerHTML = html;

      // 插入到 readingView（或 body 回退）
      var readingView = doc.getElementById('readingView');
      if (readingView) {
        readingView.appendChild(container);
      } else {
        doc.body.appendChild(container);
      }

      // 临时清除引用，防止 cleanup 删除刚创建的新容器
      _continuousViewEl = null;

      // 清理旧初始化（observer / 子模块 / body class 等）
      cleanup();

      // cleanup 会恢复 carousel display，需重新隐藏
      var track2 = doc.querySelector('.bk-carousel-track');
      if (track2) track2.style.display = 'none';

      // 设置新容器引用并在其上初始化
      _continuousViewEl = container;
      init(container);

      // 恢复阅读位置（连续模式也支持）
      var savedPage = S.restoreReadingPosition(bookId);
      if (savedPage && savedPage > 1) {
        setTimeout(function () {
          var nav = win.BKPdf._internal.nav;
          if (nav && nav.goToPage) nav.goToPage(savedPage, false);
        }, 300);
      }
    }).catch(function (err) {
      console.warn('[PDF] 进入连续滚动模式失败:', err);
      // 失败时恢复 carousel
      var track = doc.querySelector('.bk-carousel-track');
      if (track) track.style.display = '';
    });
  }

  /**
   * 退出连续滚动模式：移除独立容器，恢复 Carousel，重新初始化
   */
  function _exitContinuousView() {
    // 移除连续视图容器
    if (_continuousViewEl && _continuousViewEl.parentNode) {
      _continuousViewEl.parentNode.removeChild(_continuousViewEl);
    }
    _continuousViewEl = null;

    // 恢复 Carousel track
    var track = doc.querySelector('.bk-carousel-track');
    if (track) track.style.display = '';

    // 在 chapterContent 上重新初始化
    var currContent = doc.getElementById('chapterContent');
    if (currContent) {
      cleanup();
      init(currContent);
    }
  }

  // ==================== Reflow 文字重排模式 ====================

  /**
   * 进入 Reflow 模式：清理旧视图 → 提取文字 → 构建 DOM
   */
  function _enterReflowView() {
    var bookId = S.currentBookId();
    if (!bookId) return;

    // 隐藏 Carousel track
    var track = doc.querySelector('.bk-carousel-track');
    if (track) track.style.display = 'none';

    // 隐藏连续视图（如有）
    if (_continuousViewEl) _continuousViewEl.style.display = 'none';

    // 清理旧初始化（但不删除连续视图容器本身）
    var savedContinuousEl = _continuousViewEl;
    _continuousViewEl = null;
    cleanup();
    _continuousViewEl = savedContinuousEl;

    // cleanup 会恢复 carousel display，需重新隐藏
    var track2 = doc.querySelector('.bk-carousel-track');
    if (track2) track2.style.display = 'none';
    if (_continuousViewEl) _continuousViewEl.style.display = 'none';

    // F：恢复 bookId（cleanup 会清空 _pdfCurrentBookId，但 Reflow 模式下高亮/批注等
    // 子模块仍需通过 S.currentBookId() 拿到当前书 ID；Reflow DOM 没有 data-pdf-book
    // 属性，无法像普通模式那样从 pages[0] 重新推断）
    S.setCurrentBookId(bookId);

    var reflow = win.BKPdf._internal.reflow;
    if (!reflow || !reflow.enterReflowView) {
      console.warn('[PDF] reflow module not loaded');
      return;
    }

    reflow.enterReflowView(bookId).then(function (container) {
      _reflowViewEl = container;

      // 初始化子模块（ui/nav/highlight 在 Reflow 模式下有意义）
      // - nav：页码跳转/位置恢复
      // - ui：底栏工具按钮（含高亮列表抽屉）
      // - highlight：Reflow 文字选取 → 标注菜单 → 新建高亮/批注（文本匹配渲染）
      var subs = win.BKPdf._internal;
      if (subs.nav && subs.nav.init) subs.nav.init(container, bookId);
      if (subs.ui && subs.ui.init) subs.ui.init(container, bookId);
      if (subs.highlight && subs.highlight.init) subs.highlight.init(container, bookId);

      // 标记为已初始化（Reflow 模式下 setMode 切换依赖 initialized 状态，
      // 缺失会导致 Reflow→Single/Continuous 切换时 cleanup+init 不执行）
      S.setInitialized(true);

      // 恢复 PDF 阅读模式 body class（cleanup() 移除了 bk-pdf-reading，
      // 但 Reflow 不走主 init() 不会重新添加，导致 CSS 防护失效、
      // 点击屏幕弹出应用级工具栏而非 PDF 工具栏）
      doc.body.classList.add('bk-pdf-reading');

      // 恢复阅读位置
      var savedPage = S.restoreReadingPosition(bookId);
      if (savedPage && savedPage > 1) {
        setTimeout(function () {
          var nav = subs.nav;
          if (nav && nav.goToPage) nav.goToPage(savedPage, false);
        }, 200);
      }
    }).catch(function (err) {
      console.warn('[PDF] 进入 Reflow 模式失败:', err);
      // 失败时恢复
      _exitReflowView();
    });
  }

  /**
   * 退出 Reflow 模式（仅清除 Reflow DOM，不调用 cleanup/init）
   * 模式切换的完整重建由 setMode() 负责
   */
  function _exitReflowView() {
    var reflow = win.BKPdf._internal.reflow;
    if (reflow && reflow.exitReflowView) reflow.exitReflowView();
    _reflowViewEl = null;
  }

  // ==================== 主题联动 hook ====================

  /**
   * Hook window.setTheme 以在主应用切换主题时同步 PDF 护眼模式
   */
  function _hookSetTheme() {
    if (!win.setTheme || typeof win.setTheme !== 'function') return;
    _origSetTheme = win.setTheme;
    win.setTheme = function (theme) {
      // 调用原始 setTheme
      _origSetTheme.call(win, theme);
      // 同步 PDF 护眼模式（仅在用户未手动覆盖时）
      if (S.initialized()) S.syncFromAppTheme();
    };
  }

  function _unhookSetTheme() {
    if (_origSetTheme && typeof _origSetTheme === 'function') {
      win.setTheme = _origSetTheme;
    }
    _origSetTheme = null;
  }

  // ==================== init / cleanup ====================

  function init(containerEl) {
    var pages = containerEl.querySelectorAll('.bk-pdf-page');
    if (!pages.length) return;

    // 恢复用户偏好（阅读模式、夜间模式）
    S.restoreMode();
    S.restoreNightMode();

    // 主题联动：根据主应用 data-theme 同步护眼模式（仅在用户未手动覆盖时）
    S.syncFromAppTheme();

    // hook setTheme 以在主应用切换主题时同步 PDF 模式
    _hookSetTheme();

    // 标记 PDF 模式 class（:has() 降级）
    var contentCandidates = [];
    if (containerEl.classList && containerEl.classList.contains('content') &&
        containerEl.querySelector('.bk-pdf-page')) {
      contentCandidates.push(containerEl);
    }
    // 连续滚动模式的容器自身就是 .bk-pdf-mode（创建时已加 class）
    if (containerEl.classList.contains('bk-pdf-continuous-view')) {
      contentCandidates.push(containerEl);
    }
    var childContents = containerEl.querySelectorAll('.content');
    for (var ci = 0; ci < childContents.length; ci++) {
      if (childContents[ci].querySelector('.bk-pdf-page')) {
        contentCandidates.push(childContents[ci]);
      }
    }
    for (var cj = 0; cj < contentCandidates.length; cj++) {
      contentCandidates[cj].classList.add('bk-pdf-mode');
      // 单页模式额外标记
      if (S.mode() === S.MODE_SINGLE) {
        contentCandidates[cj].classList.add('bk-pdf-single');
      } else {
        contentCandidates[cj].classList.remove('bk-pdf-single');
      }
    }
    // 强制 reflow
    for (var ck = 0; ck < contentCandidates.length; ck++) {
      void contentCandidates[ck].offsetWidth;
    }
    if (doc.body) doc.body.classList.add('bk-pdf-reading');

    // 推断当前 bookId
    var pdfBookId = pages[0].getAttribute('data-pdf-book') || '';
    if (pdfBookId) {
      S.setCurrentBookId(pdfBookId);
      _showZoomControls(pdfBookId);
      // 异步获取页码标签（如罗马数字等 PDF 内部标签）
      core.getPdfDoc(pdfBookId).then(function (pdf) {
        return pdf.getPageLabels();
      }).then(function (labels) {
        if (labels && labels.length) S.setPageLabels(labels);
      }).catch(function () { /* 静默：无标签不影响功能 */ });

      // 异步探测文字层：扫描型 PDF（items=0）不支持 Reflow，需隐藏 Reflow 按钮
      _probeTextLayer(pdfBookId);
    }
    S.setInitialized(true);

    // 连续模式且尚未创建独立容器时，跳过后续初始化，直接进入连续视图
    // _enterContinuousView 会在创建容器后自动 cleanup + init
    if (S.mode() === S.MODE_CONTINUOUS && !_continuousViewEl) {
      _enterContinuousView();
      return;
    }

    // 创建 IntersectionObserver（懒渲染）
    if (!S.observer()) {
      // 单页模式用水平 rootMargin，连续模式用垂直
      var rootMargin = (S.mode() === S.MODE_SINGLE)
        ? '0px 400px 0px 400px'
        : '400px 0px 400px 0px';
      S.setObserver(new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i];
          if (entry.isIntersecting) {
            if (entry.target.getAttribute('data-pdf-rendered') !== '1' &&
                entry.target.getAttribute('data-pdf-rendering') !== '1') {
              core.renderPage(entry.target);
            }
          }
        }
      }, {
        rootMargin: rootMargin,
        threshold: 0
      }));
    }

    for (var i = 0; i < pages.length; i++) {
      S.observer().observe(pages[i]);
    }

    // 创建当前页检测 observer（J2优化：rootMargin:0 + 多阈值，替代 nav 滚动 O(n) 遍历）
    if (!S.currentPageObserver()) {
      S.setCurrentPageObserver(new IntersectionObserver(function (entries) {
        var nav = win.BKPdf._internal.nav;
        if (nav && nav._onCurrentPageObserved) nav._onCurrentPageObserved(entries);
      }, {
        rootMargin: '0px',
        threshold: [0, 0.25, 0.5, 0.75, 1]
      }));
    }
    for (var j = 0; j < pages.length; j++) {
      S.currentPageObserver().observe(pages[j]);
    }

    // 恢复阅读位置
    if (pdfBookId) {
      var savedPage = S.restoreReadingPosition(pdfBookId);
      if (savedPage && savedPage > 1) {
        // 延迟跳转，等页面渲染
        setTimeout(function () {
          var nav = win.BKPdf._internal.nav;
          if (nav && nav.goToPage) nav.goToPage(savedPage, false);
        }, 300);
      }
    }

    // 初始化子模块（如果已加载）
    var subs = win.BKPdf._internal;
    if (subs.gesture && subs.gesture.init) subs.gesture.init(containerEl, pdfBookId);
    if (subs.nav && subs.nav.init) subs.nav.init(containerEl, pdfBookId);
    if (subs.links && subs.links.init) subs.links.init(containerEl, pdfBookId);
    if (subs.ui && subs.ui.init) subs.ui.init(containerEl, pdfBookId);
    if (subs.thumbs && subs.thumbs.init) subs.thumbs.init(containerEl, pdfBookId);
    if (subs.outline && subs.outline.init) subs.outline.init(containerEl, pdfBookId);
    if (subs.search && subs.search.init) subs.search.init(containerEl, pdfBookId);
    if (subs.bookmark && subs.bookmark.init) subs.bookmark.init(containerEl, pdfBookId);
    if (subs.highlight && subs.highlight.init) subs.highlight.init(containerEl, pdfBookId);
    // 渲染已保存的高亮标注
    if (subs.highlight && subs.highlight.renderAllVisibleHighlights) {
      subs.highlight.renderAllVisibleHighlights();
    }

    // 响应式：视口变化时重渲染
    if (S.resizeHandler()) {
      win.removeEventListener('resize', S.resizeHandler());
      win.removeEventListener('orientationchange', S.resizeHandler());
    }
    var resizeHandler = function () {
      if (S.resizeTimer()) clearTimeout(S.resizeTimer());
      S.setResizeTimer(setTimeout(function () {
        var active = S.activePages();
        for (var i = 0; i < active.length; i++) {
          var pgEl = active[i];
          if (!pgEl) continue;
          if (pgEl.getAttribute('data-pdf-rendered') !== '1') continue;
          var r = pgEl.getBoundingClientRect();
          var inView;
          if (S.mode() === S.MODE_SINGLE) {
            var vw = win.innerWidth || doc.documentElement.clientWidth;
            inView = r.right > 0 && r.left < vw;
          } else {
            inView = r.bottom > 0 && r.top < win.innerHeight;
          }
          if (inView) core.renderPage(pgEl, true);
        }
        S.setResizeTimer(null);
      }, 300));
    };
    S.setResizeHandler(resizeHandler);
    win.addEventListener('resize', resizeHandler);
    win.addEventListener('orientationchange', resizeHandler);

    // 注册到 AppLifecycle：切回前台时刷新可见区域
    if (win.BK && win.BK.AppLifecycle && !_lifecycleDisposer) {
      _lifecycleDisposer = win.BK.AppLifecycle.registerRefresher(refreshVisible, {
        id: 'pdf-refreshVisible',
        priority: 100
      });
    }
  }

  function cleanup() {
    // 取消所有进行中的渲染
    var aborts = S.renderAbort();
    var keys = Object.keys(aborts);
    for (var i = 0; i < keys.length; i++) {
      try { aborts[keys[i]].abort(); } catch (e) {}
    }
    S.renderAbort() && (keys.length = 0);

    // 注意：docCache 销毁已拆分到 destroyPdfCache() 公共 API。模式切换内部仅调 cleanup()，
    // 保留 docCache 以免重新解析 PDF（大文档 2~5s）；仅退出阅读（_cleanupPdfCache）时才销毁。

    // 清理观察器
    if (S.observer()) {
      S.observer().disconnect();
      S.setObserver(null);
    }
    // 清理当前页检测 observer（J2）
    if (S.currentPageObserver()) {
      S.currentPageObserver().disconnect();
      S.setCurrentPageObserver(null);
    }

    // 释放所有已渲染 canvas
    var active = S.activePages();
    for (var k = 0; k < active.length; k++) {
      var el = active[k];
      if (el) {
        var cv = el.querySelector('.bk-pdf-canvas');
        if (cv) { cv.width = 0; cv.height = 0; }
      }
    }
    S.setActivePages([]);

    // 移除响应式监听器
    if (S.resizeHandler()) {
      win.removeEventListener('resize', S.resizeHandler());
      win.removeEventListener('orientationchange', S.resizeHandler());
      S.setResizeHandler(null);
    }
    if (S.resizeTimer()) {
      clearTimeout(S.resizeTimer());
      S.setResizeTimer(null);
    }

    // 移除连续滚动视图容器
    if (_continuousViewEl && _continuousViewEl.parentNode) {
      _continuousViewEl.parentNode.removeChild(_continuousViewEl);
    }
    _continuousViewEl = null;

    // 移除 Reflow 视图容器
    var reflow = win.BKPdf._internal.reflow;
    if (reflow && reflow.exitReflowView) reflow.exitReflowView();
    _reflowViewEl = null;

    // 恢复 Carousel track
    var track = doc.querySelector('.bk-carousel-track');
    if (track) track.style.display = '';

    // 移除 .bk-pdf-mode / .bk-pdf-single / .bk-pdf-reading class
    var pdfModeEls = doc.querySelectorAll('.bk-pdf-mode, .bk-pdf-single');
    for (var m = 0; m < pdfModeEls.length; m++) {
      pdfModeEls[m].classList.remove('bk-pdf-mode', 'bk-pdf-single');
    }
    if (doc.body) {
      doc.body.classList.remove('bk-pdf-reading', 'bk-pdf-night', 'bk-pdf-sepia', 'bk-pdf-green');
    }

    // 恢复原始 setTheme
    _unhookSetTheme();
    // 重置主题联动 override 标记
    S.setThemeUserOverride(false);

    // 隐藏 zoom 控件
    _detachZoomControls();

    // 清理子模块
    var subs = win.BKPdf._internal;
    if (subs.gesture && subs.gesture.cleanup) subs.gesture.cleanup();
    if (subs.nav && subs.nav.cleanup) subs.nav.cleanup();
    if (subs.links && subs.links.cleanup) subs.links.cleanup();
    if (subs.ui && subs.ui.cleanup) subs.ui.cleanup();
    if (subs.thumbs && subs.thumbs.cleanup) subs.thumbs.cleanup();
    if (subs.outline && subs.outline.cleanup) subs.outline.cleanup();
    if (subs.search && subs.search.cleanup) subs.search.cleanup();
    if (subs.bookmark && subs.bookmark.cleanup) subs.bookmark.cleanup();
    if (subs.highlight && subs.highlight.cleanup) subs.highlight.cleanup();
    // F5：清理撤销栈
    if (subs.undo && subs.undo.reset) subs.undo.reset();

    S.setCurrentBookId(null);
    S.setInitialized(false);

    // 取消 AppLifecycle refresher 注册
    if (_lifecycleDisposer) {
      try { _lifecycleDisposer(); } catch (e) {}
      _lifecycleDisposer = null;
    }
  }

  // ==================== 前后台生命周期：刷新可见区域 ====================

  /**
   * 刷新当前可见区域内的 PDF 页面（切回前台时由 AppLifecycle 调用）
   *
   * 解决两个问题：
   *  1) 后台时 IntersectionObserver 可能停止触发，回前台不会主动回调，
   *     导致懒渲染的页面 canvas 是空的
   *  2) Android WebView 后台时可能回收已渲染 canvas 的 GPU 纹理，
   *     回前台后页面"看似已渲染"但实际是空白
   *
   * 实现：
   *  - 先 takeRecords() 让 IntersectionObserver 主动回调
   *  - 后台时长 > RECOVERY_THRESHOLD（5s）时，对可见页强制重渲染
   *    （兜底 GPU 纹理回收：canvas.width/height 不会变，但 backing storage 已空）
   *  - 否则仅重渲染未渲染 / canvas 尺寸为 0 的页面
   *  - 用 rAF 分帧渲染（每帧 2 页），避免阻塞遮罩淡出动画
   *
   * @param {number} bgMs  后台持续毫秒数（由 AppLifecycle 传入）
   */
  var RECOVERY_THRESHOLD = 5000; // 后台超过此值视为长时冻结，强制重渲染可见页

  function refreshVisible(bgMs) {
    if (!S.initialized()) return;

    // 1) 主动触发 IntersectionObserver 回调
    var obs = S.observer();
    if (obs && typeof obs.takeRecords === 'function') {
      try { obs.takeRecords(); } catch (e) {}
    }

    // 2) 扫描页面，挑出需要重绘的
    var pages = doc.querySelectorAll('.bk-pdf-page');
    if (!pages || !pages.length) return;

    var vh = win.innerHeight || doc.documentElement.clientHeight;
    var vw = win.innerWidth || doc.documentElement.clientWidth;
    var isSingle = S.mode() === S.MODE_SINGLE;

    // ★ 长时冻结兜底：后台 > 5s 时 GPU 纹理可能被回收（canvas 尺寸不变但内容空）
    //   对所有可见页强制重渲染，代价低（一屏通常 1~2 页），可靠性大幅提升
    var forceRerenderVisible = (typeof bgMs === 'number') && bgMs > RECOVERY_THRESHOLD;
    if (forceRerenderVisible) {
      console.log('[PDF] refreshVisible: 后台 ' + (bgMs / 1000).toFixed(1) +
                  's 超 ' + (RECOVERY_THRESHOLD / 1000) + 's 阈值，强制重渲染可见页');
    }

    var toRender = [];
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i];
      var rect = p.getBoundingClientRect();
      var inView = isSingle
        ? (rect.right > 0 && rect.left < vw)
        : (rect.bottom > 0 && rect.top < vh);
      if (!inView) continue;

      var rendered = p.getAttribute('data-pdf-rendered') === '1';
      if (!rendered) {
        // 未渲染：加入队列
        toRender.push(p);
      } else if (forceRerenderVisible) {
        // 已渲染但后台太长：GPU 纹理可能被回收，强制重绘
        p.removeAttribute('data-pdf-rendered');
        toRender.push(p);
      } else {
        // 已渲染：检测 canvas 是否被回收（width=0 或 height=0）
        var cv = p.querySelector('.bk-pdf-canvas');
        if (cv && (cv.width === 0 || cv.height === 0)) {
          p.removeAttribute('data-pdf-rendered');
          toRender.push(p);
        }
      }
    }

    if (!toRender.length) {
      console.log('[PDF] refreshVisible: 可见区域全部已渲染，跳过');
      return;
    }
    console.log('[PDF] refreshVisible: 待重绘 ' + toRender.length + ' 页');

    // 3) 分帧渲染：每帧最多 2 页，避免阻塞遮罩淡出
    var idx = 0;
    function renderNext() {
      if (idx >= toRender.length) return;
      var batch = Math.min(2, toRender.length - idx);
      for (var k = 0; k < batch; k++) {
        var el = toRender[idx++];
        try { core.renderPage(el, true); } catch (e) {
          console.warn('[PDF] refreshVisible 渲染异常:', e && e.message);
        }
      }
      if (idx < toRender.length) {
        (win.requestAnimationFrame || function (cb) { setTimeout(cb, 16); })(renderNext);
      }
    }
    renderNext();
  }

  // ==================== 导出（向后兼容 BKPdf API）====================

  win.BKPdf.init = init;
  win.BKPdf.cleanup = cleanup;
  // 退出阅读专用：销毁 pdf.js PDFDocumentProxy 释放内存。模式切换不要调用此 API（仅调 cleanup）。
  win.BKPdf.destroyPdfCache = function () { core.destroyDocCache(); };
  win.BKPdf.renderPage = core.renderPage;
  win.BKPdf.getPdfDoc = core.getPdfDoc;
  win.BKPdf.generatePageHTML = core.generatePageHTML;
  win.BKPdf.zoomIn = zoomIn;
  win.BKPdf.zoomOut = zoomOut;
  win.BKPdf.resetZoom = resetZoom;
  // 前后台生命周期：切回前台时主动刷新可见区域（由 app-lifecycle.js 调用）
  win.BKPdf.refreshVisible = refreshVisible;

  // 暴露 zoom 内部 API（供 gesture 模块调用）
  win.BKPdf._internal.zoom = {
    setZoom: _setZoom,
    applyZoomToVisible: _applyZoomToVisible,
    getZoom: S.zoom,
    detachControls: _detachZoomControls,
    updateZoomControls: _updateZoomControls
  };

  // 新增公共 API（供 UI / 外部调用）
  win.BKPdf.setOutline = S.setOutline;
  win.BKPdf.getMode = S.mode;
  win.BKPdf.setMode = function (mode) {
    S.setMode(mode);
    var wasReflow = !!_reflowViewEl;

    if (mode === S.MODE_CONTINUOUS) {
      // 退出 Reflow（如有）——仅清除 reflow DOM
      if (wasReflow) _exitReflowView();

      if (_continuousViewEl) {
        // 连续视图容器仍在（进入 reflow 前保留的），恢复可见 + 重初始化子模块
        _continuousViewEl.style.display = '';
        var track = doc.querySelector('.bk-carousel-track');
        if (track) track.style.display = 'none';
        var subs = win.BKPdf._internal;
        if (subs.nav && subs.nav.init) subs.nav.init(_continuousViewEl, S.currentBookId());
        if (subs.ui && subs.ui.init) subs.ui.init(_continuousViewEl, S.currentBookId());
        // 恢复 PDF 阅读模式 body class（从 Reflow 切回 Continuous 时
        // 不走主 init()，bk-pdf-reading 缺失导致应用浮栏误显示）
        doc.body.classList.add('bk-pdf-reading');
      } else if (S.initialized()) {
        // 从 single/carousel 进入连续模式
        _enterContinuousView();
      }
    } else if (mode === S.MODE_SINGLE) {
      // 退出 Reflow（如有）——仅清除 reflow DOM
      if (wasReflow) _exitReflowView();

      if (_continuousViewEl) {
        // 退出连续模式，恢复 carousel
        _exitContinuousView();
      } else if (S.initialized()) {
        // 从 reflow 或其他状态恢复到 single/carousel
        var currContent = doc.getElementById('chapterContent');
        if (currContent) {
          cleanup();
          init(currContent);
        }
      }
    } else if (mode === S.MODE_REFLOW) {
      // 首次进入 Reflow
      if (!_reflowViewEl && S.initialized()) {
        _enterReflowView();
      }
    }
  };
  win.BKPdf.setNightMode = S.setNightMode;
  win.BKPdf.getNightMode = S.nightMode;

  // 用户书签公共 API
  win.BKPdf.toggleBookmark = function () {
    var bm = win.BKPdf._internal.bookmark;
    if (bm && bm.toggleCurrentPage) bm.toggleCurrentPage();
  };
  win.BKPdf.getBookmarks = S.bookmarks;
  win.BKPdf.isBookmarked = S.isBookmarked;

  // 高亮标注公共 API
  win.BKPdf.getHighlights = S.highlights;
  win.BKPdf.removeHighlight = S.removeHighlight;

})(window);
