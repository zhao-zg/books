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
  var _preSwitchScrollRatio = 0; // P2-1: 模式切换前页内滚动比例（0=页顶, 1=页底），用于恢复精确位置

  // ==================== 模式切换延迟清理 ====================

  /**
   * 延迟清理旧模式的 canvas 占位（保留旧画面直到新页面渲染完成）
   * 在遮罩淡出前调用，清理所有标记了 data-pdf-pending-cleanup 的旧页面
   */
  var _pendingCleanup = false;
  function _deferredCleanupOldPages() {
    if (!_pendingCleanup) return;
    _pendingCleanup = false;
    var oldPages = doc.querySelectorAll('.bk-pdf-page[data-pdf-pending-cleanup]');
    for (var i = 0; i < oldPages.length; i++) {
      var pg = oldPages[i];
      pg.removeAttribute('data-pdf-pending-cleanup');
      // 旧 canvas 内容已无用，清空释放内存
      if (pg.querySelector('.bk-pdf-canvas-wrap')) {
        pg.innerHTML = '';
      }
    }
  }

  // ==================== 智能位置恢复 ====================

  /**
   * 智能位置恢复：等待目标页渲染完成后再跳转，替代固定 setTimeout
   * 策略：
   *   1. 先等 100ms 让 IntersectionObserver 有机会触发渲染
   *   2. 检查目标页是否已渲染（data-pdf-rendered="1"）
   *   3. 若未渲染，主动触发渲染并等待 200ms
   *   4. 最多重试 3 次，总等待 ≤ 800ms
   *   5. 超时后强制跳转（即使未渲染完成，比永远不跳好）
   */
  var MAX_RESTORE_RETRIES = 3;
  function _restorePositionWhenReady(targetPage, scrollRatio) {
    var ratio = scrollRatio || 0;
    var retry = 0;
    function tryRestore() {
      var nav = win.BKPdf._internal.nav;
      if (!nav || !nav.goToPage) return;
      // 找到目标页元素
      var targetEl = doc.querySelector('.bk-pdf-page[data-pdf-page="' + targetPage + '"]');
      if (targetEl && targetEl.getAttribute('data-pdf-rendered') === '1') {
        // 已渲染，跳转
        nav.goToPage(targetPage, false);
        // P2-1: 恢复页内滚动偏移（仅 Continuous 模式有意义）
        if (ratio > 0 && S.mode() === S.MODE_CONTINUOUS && targetEl) {
          var r = targetEl.getBoundingClientRect();
          var scrollContainer = nav._getScrollContainer ? nav._getScrollContainer() : null;
          if (scrollContainer && r.height > 0) {
            var offset = r.height * ratio;
            scrollContainer.scrollTop = targetEl.offsetTop + offset;
          }
        }
        _preSwitchScrollRatio = 0; // 用完即清
        return;
      }
      if (retry >= MAX_RESTORE_RETRIES) {
        // 超时，强制跳转
        nav.goToPage(targetPage, false);
        _preSwitchScrollRatio = 0;
        return;
      }
      retry++;
      // 主动触发目标页渲染（如果它在视口附近，observer 会自动触发）
      if (targetEl && targetEl.getAttribute('data-pdf-rendered') !== '1' &&
          targetEl.getAttribute('data-pdf-rendering') !== '1') {
        core.renderPage(targetEl);
      }
      var delay = retry === 1 ? 150 : 200;
      setTimeout(tryRestore, delay);
    }
    // 首次延迟：等 IntersectionObserver 初始化并触发
    setTimeout(tryRestore, 100);
  }

  function _setZoom(pdfBookId, zoom) {
    zoom = Math.max(S.MIN_ZOOM, Math.min(S.MAX_ZOOM, zoom));
    S.zoomState()[pdfBookId] = S.zoomState()[pdfBookId] || {};
    S.zoomState()[pdfBookId].zoom = zoom;
    _updateZoomControls(zoom);

    // Bug12 修复：Reflow 模式下用 font-size 缩放替代 bk-pdf-zoomed class
    // （Reflow 无 .bk-pdf-page 元素，原 _setZoom 对 Reflow 完全无效）
    if (S.mode() === S.MODE_REFLOW) {
      var reflowContainer = _reflowViewEl ||
        doc.getElementById('bkPdfReflowView');
      if (reflowContainer) {
        // 基准字号 16px（移动端 17px），zoom=1.0 时不缩放
        var baseFontSize = 16; // 与 CSS .bk-pdf-reflow-view font-size 对齐
        reflowContainer.style.fontSize = (baseFontSize * zoom) + 'px';
      }
      return zoom;
    }

    // zoom > 1 时让当前书的 .bk-pdf-page 变为可滚动容器
    // 通过 data-pdf-book 过滤，避免影响其他书的页面
    var pages = doc.querySelectorAll('.bk-pdf-page[data-pdf-book="' + pdfBookId + '"]');
    if (!pages.length) {
      // 回退：没有 data-pdf-book 时操作所有 page
      pages = doc.querySelectorAll('.bk-pdf-page');
    }
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
    var vw = win.innerWidth || doc.documentElement.clientWidth;
    for (var i = 0; i < pages.length; i++) {
      var rect = pages[i].getBoundingClientRect();
      var isVisible;
      // 单页模式检查水平可见，连续模式检查垂直可见
      if (S.mode() === S.MODE_SINGLE) {
        isVisible = !(rect.right <= 0 || rect.left >= vw);
      } else {
        isVisible = !(rect.bottom <= 0 || rect.top >= vh);
      }

      if (isVisible) {
        // 可见页：立即重渲染（高清 canvas）
        pages[i].removeAttribute('data-pdf-rendered');
        core.renderPage(pages[i], true);
      } else {
        // ★ 非可见已渲染页：标记为过期，滚进视口时 IntersectionObserver 会自动以新 zoom 重渲染
        // 只移除 data-pdf-rendered 标记，不立即触发重渲染（避免大量后台渲染阻塞主线程）
        // 保留旧 canvas 内容作为占位图，等进入视口再替换，比骨架白屏更平滑
        pages[i].removeAttribute('data-pdf-rendered');
      }
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
   * ★ 优化：并行提取前 3 页文字层（原串行提取延迟 3×100ms+），首屏提速
   * 探测完毕后写入 state，并通知 UI 刷新模式按钮
   */
  function _probeTextLayer(bookId) {
    if (!bookId) return;
    var core = win.BKPdf._internal.core;
    if (!core || !core.getPdfDoc) return;

    core.getPdfDoc(bookId).then(function (pdf) {
      var probePages = Math.min(3, pdf.numPages || 1);
      // ★ 并行提取所有探测页的 getTextContent
      var pagePromises = [];
      for (var i = 1; i <= probePages; i++) {
        (function (pageNum) {
          pagePromises.push(
            pdf.getPage(pageNum).then(function (page) {
              return page.getTextContent({
                includeMarkedContent: false,
                disableCombineTextItems: false
              }).then(function (tc) {
                return (tc.items || []).length;
              });
            }).catch(function () { return 0; })
          );
        })(i);
      }
      return Promise.all(pagePromises).then(function (counts) {
        var totalItems = 0;
        for (var i = 0; i < counts.length; i++) totalItems += counts[i];
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

      // 恢复阅读位置（连续模式也支持，使用智能延迟）
      var savedPage = S.restoreReadingPosition(bookId);
      if (savedPage && savedPage > 1) {
        _restorePositionWhenReady(savedPage, _preSwitchScrollRatio);
        _preSwitchScrollRatio = 0;
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
      // 用户可能在提取过程中导航离开，enterReflowView 返回 null
      if (!container) return;

      _reflowViewEl = container;

      // 初始化子模块
      // - nav：页码跳转/位置恢复
      // - ui：底栏工具按钮（含高亮列表抽屉）
      // - highlight：Reflow 文字选取 → 标注菜单 → 新建高亮/批注（文本匹配渲染）
      // Bug9-12 修复：Reflow 模式下也初始化 bookmark 和 search 模块
      // （bookmark 的 toggleCurrentPage 仅依赖 S 状态，不依赖 DOM 容器；
      //   search 在 Reflow 模式下使用 pdf.js API 全量搜索，需 init 绑定事件）
      var subs = win.BKPdf._internal;
      if (subs.nav && subs.nav.init) subs.nav.init(container, bookId);
      if (subs.ui && subs.ui.init) subs.ui.init(container, bookId);
      if (subs.highlight && subs.highlight.init) subs.highlight.init(container, bookId);
      if (subs.bookmark && subs.bookmark.init) subs.bookmark.init(container, bookId);
      if (subs.search && subs.search.init) subs.search.init(container, bookId);

      // 标记为已初始化（Reflow 模式下 setMode 切换依赖 initialized 状态，
      // 缺失会导致 Reflow→Single/Continuous 切换时 cleanup+init 不执行）
      S.setInitialized(true);

      // 恢复 PDF 阅读模式 body class（cleanup() 移除了 bk-pdf-reading，
      // 但 Reflow 不走主 init() 不会重新添加，导致 CSS 防护失效、
      // 点击屏幕弹出应用级工具栏而非 PDF 工具栏）
      doc.body.classList.add('bk-pdf-reading');

      // Bug10 修复：恢复夜间/护眼模式 body class（cleanup() 移除了
      // bk-pdf-night/bk-pdf-sepia/bk-pdf-green，但 Reflow 不走主 init()
      // 不会重新添加，导致 CSS 选择器 body.bk-pdf-night .bk-pdf-reflow-view
      // 不匹配，Reflow 视图无夜间模式样式）
      var nightMode = S.nightMode();
      if (nightMode === S.NIGHT_INVERT) doc.body.classList.add('bk-pdf-night');
      else if (nightMode === S.NIGHT_SEPIA) doc.body.classList.add('bk-pdf-sepia');
      else if (nightMode === S.NIGHT_GREEN) doc.body.classList.add('bk-pdf-green');

      // 恢复阅读位置（使用智能延迟）
      var savedPage = S.restoreReadingPosition(bookId);
      if (savedPage && savedPage > 1) {
        _restorePositionWhenReady(savedPage, _preSwitchScrollRatio);
        _preSwitchScrollRatio = 0;
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
      // 同时设置 PDF 总页数（修复 Single 模式下进度条显示 1/1 的问题）
      core.getPdfDoc(pdfBookId).then(function (pdf) {
        S.setTotalPages(pdf.numPages);
        // 重通知 UI 更新进度条（nav.init() 时 totalPages 可能尚为 fallback 值）
        var ui = win.BKPdf._internal.ui;
        if (ui && ui.updatePageIndicator) {
          ui.updatePageIndicator(S.currentPage(), pdf.numPages);
        }
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
      // Single: 左右各 2000px（约5页宽度），确保快速滑动时页面已提前渲染
      // Continuous: 上下各 400px
      var rootMargin = (S.mode() === S.MODE_SINGLE)
        ? '0px 2000px 0px 2000px'
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

    // 恢复阅读位置（使用智能延迟替代固定 setTimeout）
    if (pdfBookId) {
      var savedPage = S.restoreReadingPosition(pdfBookId);
      if (savedPage && savedPage > 1) {
        _restorePositionWhenReady(savedPage, _preSwitchScrollRatio);
        _preSwitchScrollRatio = 0;
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

    // 释放所有已渲染 canvas 内存（但不清除 DOM，保留旧渲染内容作为过渡占位）
    // 模式切换后 init() 的 observer 会在新页面渲染完成时触发 _deferredCleanupOldPages
    var active = S.activePages();
    for (var k = 0; k < active.length; k++) {
      var el = active[k];
      if (el) {
        var cv = el.querySelector('.bk-pdf-canvas');
        if (cv) { cv.width = 0; cv.height = 0; }
      }
    }
    S.setActivePages([]);

    // Bug14 修复：重置渲染状态标记，确保 init() 的 observer 不跳过这些页面
    // 但不再立即重置 innerHTML——保留旧 canvas 画面作为过渡占位，
    // 等新模式第一页渲染完成后再清理旧 DOM（消除切换时页面消失的问题）
    var allPdfPages = doc.querySelectorAll('.bk-pdf-page');
    for (var rp = 0; rp < allPdfPages.length; rp++) {
      var pgEl = allPdfPages[rp];
      pgEl.removeAttribute('data-pdf-rendered');
      pgEl.removeAttribute('data-pdf-rendering');
      // 标记为待清理：init() 新模式页面渲染完成时会清理这些旧 canvas
      if (pgEl.querySelector('.bk-pdf-canvas-wrap')) {
        pgEl.setAttribute('data-pdf-pending-cleanup', '1');
      }
    }

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

    // 重置 zoom 状态（避免切换模式时 .bk-pdf-zoomed class 残留）
    var zoomedPages = doc.querySelectorAll('.bk-pdf-page.bk-pdf-zoomed');
    for (var zi = 0; zi < zoomedPages.length; zi++) {
      zoomedPages[zi].classList.remove('bk-pdf-zoomed');
    }
    // 重置 zoom 值（模式切换后页面尺寸变化，旧 zoom 值无意义）
    var bookId = S.currentBookId();
    if (bookId && S.zoomState()[bookId]) {
      S.zoomState()[bookId].zoom = 1.0;
    }

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

    // ★ 2.5) Reflow 模式刷新：Reflow 不使用 .bk-pdf-page，
    //   需单独处理——让 divider observer 重新检测当前页码，
    //   并对可见区域内的图片重新触发渲染（如有需要）
    if (S.mode() === S.MODE_REFLOW) {
      var reflow = win.BKPdf._internal.reflow;
      if (reflow && reflow.detectCurrentPage) {
        var rPage = reflow.detectCurrentPage();
        if (rPage && rPage !== S.currentPage()) {
          S.setCurrentPage(rPage);
          var ui = win.BKPdf._internal.ui;
          if (ui && ui.updatePageIndicator) {
            ui.updatePageIndicator(rPage, S.totalPages() || 1);
          }
        }
      }
      // Reflow 模式无需重渲染 canvas，文字层不受 GPU 纹理回收影响
      return;
    }

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

    // 3) 分帧渲染：每帧最多 2 页，避免阻塞遮罩淡出动画
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
  /**
   * 模式切换过渡遮罩：覆盖 cleanup+reinit 的视觉间隙，消除闪烁
   * 遮罩颜色跟随主题，与 AppLifecycle 恢复遮罩视觉一致
   */
  function _getSwitchMaskColor() {
    try {
      var t = doc.documentElement.getAttribute('data-theme');
      if (t === 'dark') return '#1A1917';
      if (t === 'warm') return '#F7F2E8';
    } catch (e) {}
    return '#525659'; // PDF 中灰背景色（与 #chapterContent 背景 #525659 一致）
  }

  var _switchMask = null;
  function _showSwitchMask() {
    if (_switchMask) return;
    try {
      var mask = doc.createElement('div');
      mask.id = 'bkPdfSwitchMask';
      mask.className = 'bk-pdf-switch-mask bk-pdf-switch-mask-show';
      mask.setAttribute('aria-hidden', 'true');
      mask.style.background = _getSwitchMaskColor();
      doc.body.appendChild(mask);
      _switchMask = mask;
    } catch (e) {}
  }
  function _fadeoutSwitchMask() {
    var mask = _switchMask;
    if (!mask) return;
    _switchMask = null;
    try {
      mask.classList.remove('bk-pdf-switch-mask-show');
      mask.classList.add('bk-pdf-switch-mask-fade');
      setTimeout(function () {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
      }, 250);
    } catch (e) {
      try { if (mask.parentNode) mask.parentNode.removeChild(mask); } catch (e2) {}
    }
  }

  /**
   * 延迟清理旧模式占位并淡出遮罩（新首屏渲染完成后调用）
   */
  function _deferredCleanupAndFadeout() {
    _deferredCleanupOldPages();
    _fadeoutSwitchMask();
  }

  win.BKPdf.setOutline = S.setOutline;
  win.BKPdf.getMode = S.mode;
  win.BKPdf.setMode = function (mode) {
    S.setMode(mode);
    var wasReflow = !!_reflowViewEl;

    // Bug16: 模式切换前保存当前页码，确保 init() 恢复到正确页面
    // cleanup() 会清除 currentBookId，init() 通过 restoreReadingPosition() 恢复页码
    // 但若切换前页码检测有偏差（如 Continuous 下 page 2 略微可见被误检测），
    // 保存的位置可能错误。此处用 S.currentPage() 确保至少与系统当前认知一致
    var _preSwitchBookId = S.currentBookId();
    var _preSwitchPage = S.currentPage();
    _preSwitchScrollRatio = 0; // 重置
    if (_preSwitchBookId && _preSwitchPage > 0) {
      S.saveReadingPosition(_preSwitchBookId, _preSwitchPage);
      // P2-1: 计算 Continuous 模式下的页内滚动比例，模式切换后恢复精确位置
      // Single 模式每页全屏，无需偏移；Reflow 模式由分隔符定位
      if (S.mode() === S.MODE_CONTINUOUS) {
        var _pages = doc.querySelectorAll('.bk-pdf-page');
        for (var _pi = 0; _pi < _pages.length; _pi++) {
          var _pn = parseInt(_pages[_pi].getAttribute('data-pdf-page'), 10) || 0;
          if (_pn === _preSwitchPage) {
            var _rect = _pages[_pi].getBoundingClientRect();
            var _pageH = _rect.height;
            if (_pageH > 0) {
              _preSwitchScrollRatio = Math.max(0, Math.min(1, -_rect.top / _pageH));
            }
            break;
          }
        }
      }
    }

    // ★ 过渡遮罩：覆盖 cleanup+reinit 的视觉间隙
    _showSwitchMask();
    // 标记延迟清理：cleanup 不立即清空旧 canvas，等新模式首屏渲染后再清理
    _pendingCleanup = true;

    if (mode === S.MODE_CONTINUOUS) {
      // 退出 Reflow（如有）——仅清除 reflow DOM
      if (wasReflow) _exitReflowView();

      if (_continuousViewEl) {
        var savedContEl = _continuousViewEl;
        _continuousViewEl = null;
        cleanup();
        _continuousViewEl = savedContEl;
        _continuousViewEl.style.display = '';
        var trackCV = doc.querySelector('.bk-carousel-track');
        if (trackCV) trackCV.style.display = 'none';
        init(_continuousViewEl);
        // 等首屏渲染后再清理旧 canvas 并淡出遮罩
        setTimeout(_deferredCleanupAndFadeout, 500);
      } else if (S.initialized()) {
        _enterContinuousView();
        // _enterContinuousView 是异步的（getPdfDoc），需更长等待
        setTimeout(_deferredCleanupAndFadeout, 1000);
      }
    } else if (mode === S.MODE_SINGLE) {
      if (wasReflow) _exitReflowView();

      if (_continuousViewEl) {
        _exitContinuousView();
      } else if (S.initialized()) {
        var currContent = doc.getElementById('chapterContent');
        if (currContent) {
          cleanup();
          init(currContent);
        }
      }
      // 等首屏渲染后再清理旧 canvas 并淡出遮罩
      setTimeout(_deferredCleanupAndFadeout, 500);
    } else if (mode === S.MODE_REFLOW) {
      if (!_reflowViewEl && S.initialized()) {
        _enterReflowView();
        // enterReflowView 是异步的（提取文字），需更长等待
        setTimeout(_deferredCleanupAndFadeout, 1000);
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
