/*!
 * pdf-navigator.js - PDF 页面导航控制器
 *
 * 职责：
 *   - 单页横向滑动模式：scroll-snap-x + 居中对齐
 *   - 连续垂直滚动模式：保持现有垂直堆叠
 *   - 翻页 API：goToPage/goToNext/goToPrev/goToFirst/goToLast
 *   - 阅读位置记忆：scroll 监听 → 更新当前页码 → 持久化
 *   - 页码变化通知：滚动时检测当前页并通知 UI 模块
 *
 * 依赖：pdf-state.js, pdf-core.js
 * 挂载：window.BKPdf._internal.nav
 */
(function (win) {
  'use strict';

  var doc = win.document;
  var S = win.BKPdf._internal.state;
  var core = win.BKPdf._internal.core;

  // ==================== 状态 ====================

  var _navContainer = null;     // 导航容器（.content 或 #chapterContent）
  var _navBookId = null;
  var _scrollTimer = null;      // 滚动防抖定时器
  var _isProgrammaticScroll = false;  // 程序触发的滚动（不记录位置）
  var JUMP_THRESHOLD = 5;             // 超过此页数跨度的跳转改用瞬时滚动，避免 smooth 扫过中间页触发大量渲染
  var _singleRafId = null;            // P1-4: Single 模式 rAF 页码检测 ID

  // ==================== 模式切换 ====================

  /**
   * 应用阅读模式到容器
   * 单页模式：.content 变为横向 scroll-snap 容器
   * 连续模式：.content 保持垂直滚动
   */
  function applyMode() {
    if (!_navContainer) return;
    if (S.mode() === S.MODE_SINGLE) {
      _navContainer.classList.add('bk-pdf-single');
    } else {
      _navContainer.classList.remove('bk-pdf-single');
    }
    // Reflow 模式由 reflow 模块自行管理 DOM，不在 nav 容器上加 class
  }

  // ==================== 翻页 API ====================

  /**
   * 跳转到指定页（1-based）
   * @param {number} pageNum - 目标页码
   * @param {boolean} recordBack - 是否记录返回栈（默认 true）
   */
  function goToPage(pageNum, recordBack) {
    if (!_navContainer) return;

    // Reflow 模式：委托 reflow 模块滚动
    if (S.mode() === S.MODE_REFLOW) {
      var reflow = win.BKPdf._internal.reflow;
      if (reflow && reflow.scrollToPage) {
        reflow.scrollToPage(pageNum);
      }
      S.setCurrentPage(pageNum);
      if (_navBookId) S.saveReadingPosition(_navBookId, pageNum);
      _notifyPageChange(pageNum);
      return;
    }

    var pages = _navContainer.querySelectorAll('.bk-pdf-page');
    if (!pages.length) return;
    var totalPages = S.totalPages() || pages.length;
    if (pageNum < 1) pageNum = 1;
    if (pageNum > totalPages) pageNum = totalPages;

    // Bug6 修复："每页=1章"结构（Single 模式下容器只有1个 .bk-pdf-page）
    // 需通过路由跳转到目标章节（=目标PDF页），而非在容器内 scrollLeft
    if (S.mode() === S.MODE_SINGLE && pages.length <= 1 && _navBookId) {
      // 容器内只有1页，检查当前页是否就是目标页
      var currentPageNum = parseInt(pages[0].getAttribute('data-pdf-page'), 10) || 1;
      if (pageNum === currentPageNum) return; // 已在目标页
      // 通过路由跳转：pageNum 即章节号（"每页=1章"结构中章节号=页码）
      if (win.BKRouter) {
        win.BKRouter.navigate(_navBookId + '/' + pageNum);
      } else {
        win.location.hash = '#/' + _navBookId + '/' + pageNum;
      }
      S.setCurrentPage(pageNum);
      if (_navBookId) S.saveReadingPosition(_navBookId, pageNum);
      _notifyPageChange(pageNum);
      return;
    }

    // "全书=1章"结构：容器内有多个 .bk-pdf-page，在容器内滚动跳转
    if (pageNum > pages.length) pageNum = pages.length;
    var target = pages[pageNum - 1];

    // Bug7 修复：远页跳转——目标页可能尚未渲染（懒加载），
    // 需先触发渲染再滚动，否则 Single 模式 canvas 为空/offsetLeft 不准，
    // Continuous 模式跳转后目标页白屏
    if (target &&
        target.getAttribute('data-pdf-rendered') !== '1' &&
        target.getAttribute('data-pdf-rendering') !== '1') {
      core.renderPage(target);
    }

    if (!target) return;

    _isProgrammaticScroll = true;

    // 远距离跳转用瞬时滚动（behavior:'auto'），避免 smooth 扫过中间页进入 observer rootMargin 边界触发大量中间页渲染卡顿；
    // 近距离（≤JUMP_THRESHOLD 页）保持 smooth 平滑体验。瞬时跳转后 IntersectionObserver 仅对状态变化的页回调，中间页不触发渲染。
    var distance = Math.abs(pageNum - S.currentPage());
    var behavior = distance > JUMP_THRESHOLD ? 'auto' : 'smooth';

    // P1-3: 远跳时暂停 IntersectionObserver，防止中间页短暂进入 rootMargin 触发无谓渲染
    // 瞬时跳转后恢复 observer，仅目标页及周边页触发渲染
    var observerPaused = false;
    if (distance > JUMP_THRESHOLD && S.observer()) {
      S.observer().disconnect();
      observerPaused = true;
    }

    if (S.mode() === S.MODE_SINGLE) {
      // 单页模式：横向 scroll-snap，scrollLeft 跳转
      var scrollEl = _getScrollContainer();
      if (scrollEl) {
        // 计算目标页的 offsetLeft
        var targetLeft = target.offsetLeft;
        scrollEl.scrollTo({ left: targetLeft, behavior: behavior });
      }
    } else {
      // 连续模式：垂直滚动
      // 注意：position:fixed 容器中 scrollIntoView 可能不生效（Chromium 已知行为），
      // 使用 offsetTop + scrollTo 替代
      var scrollEl = _getScrollContainer();
      if (scrollEl) {
        var targetTop = target.offsetTop;
        scrollEl.scrollTo({ top: targetTop, behavior: behavior });
      } else {
        target.scrollIntoView({ behavior: behavior, block: 'start' });
      }
    }

    // 更新当前页码
    S.setCurrentPage(pageNum);

    // 保存阅读位置
    if (_navBookId) {
      S.saveReadingPosition(_navBookId, pageNum);
    }

    // 通知 UI 模块更新页码指示器
    _notifyPageChange(pageNum);

    // 短暂延时后复位程序滚动标志
    setTimeout(function () {
      _isProgrammaticScroll = false;
      // P1-3: 恢复 IntersectionObserver（远跳时已暂停）
      // 延迟恢复确保瞬时滚动已完成，observer 仅对当前可见页及 rootMargin 内页触发渲染
      if (observerPaused && S.observer() && _navContainer) {
        var allPages = _navContainer.querySelectorAll('.bk-pdf-page');
        for (var op = 0; op < allPages.length; op++) {
          S.observer().observe(allPages[op]);
        }
      }
    }, 500);
  }

  function goToNext() {
    var cur = S.currentPage();
    var total = _getPageCount();
    if (cur < total) goToPage(cur + 1, false);
  }

  function goToPrev() {
    var cur = S.currentPage();
    if (cur > 1) goToPage(cur - 1, false);
  }

  function goToFirst() {
    // Bug8 修复 + Bug6 适配："每页=1章"结构下 goToFirst 等同 goToPage(1)
    if (!_navContainer) return;
    var pages = _navContainer.querySelectorAll('.bk-pdf-page');
    if (S.mode() === S.MODE_SINGLE && pages.length <= 1 && _navBookId) {
      // "每页=1章"结构：通过路由跳转到第1章
      if (win.BKRouter) {
        win.BKRouter.navigate(_navBookId + '/1');
      } else {
        win.location.hash = '#/' + _navBookId + '/1';
      }
      S.setCurrentPage(1);
      if (_navBookId) S.saveReadingPosition(_navBookId, 1);
      _notifyPageChange(1);
      return;
    }
    var scrollEl = _getScrollContainer();
    if (scrollEl) {
      _isProgrammaticScroll = true;
      if (S.mode() === S.MODE_SINGLE) {
        scrollEl.scrollTo({ left: 0, behavior: 'smooth' });
      } else {
        scrollEl.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } else {
      goToPage(1, false);
    }
    S.setCurrentPage(1);
    if (_navBookId) S.saveReadingPosition(_navBookId, 1);
    _notifyPageChange(1);
    setTimeout(function () { _isProgrammaticScroll = false; }, 500);
  }

  function goToLast() {
    var total = _getPageCount();
    goToPage(total, false);
  }

  function _getPageCount() {
    if (_navContainer) {
      var pdfPages = _navContainer.querySelectorAll('.bk-pdf-page');
      if (pdfPages.length > 1) return pdfPages.length;
      // 单页容器（"每页=1章"结构）：DOM 计数为1不正确，fallback 到 S.totalPages()
      if (pdfPages.length === 1) return S.totalPages() || 1;
      // Fallback: Reflow 模式下从分隔符计数
      var dividers = _navContainer.querySelectorAll('.bk-pdf-reflow-page-divider');
      if (dividers.length > 0) return dividers.length;
    }
    return S.totalPages();
  }

  /**
   * 获取滚动容器
   * 单页模式：横向滚动容器（.content 自身即为 scroll-snap 容器）
   * 连续模式：.content 本身
   * 
   * Bug6 修复：在 Single 模式下，.content.bk-pdf-single 虽是横向 scroll-snap
   * 容器，但如果 clientWidth=0（可能因布局尚未完成或容器被隐藏），
   * 向上查找最近的可滚动祖先元素作为 fallback。
   */
  function _getScrollContainer() {
    if (!_navContainer) return null;
    // 单页模式下优先检查 .content 自身是否可横向滚动
    if (S.mode() === S.MODE_SINGLE) {
      // 强制 reflow 确保布局已计算
      void _navContainer.offsetWidth;
      if (_navContainer.clientWidth > 0) {
        return _navContainer;
      }
      // Fallback: 向上查找可横向滚动的祖先（如 .bk-carousel-page）
      var ancestor = _navContainer.parentElement;
      while (ancestor) {
        var style = win.getComputedStyle(ancestor);
        if (style && (style.overflowX === 'auto' || style.overflowX === 'scroll')) {
          return ancestor;
        }
        ancestor = ancestor.parentElement;
      }
    }
    return _navContainer;
  }

  // ==================== 滚动监听 → 页码更新 + 位置记忆 ====================

  function _onScroll() {
    if (_scrollTimer) clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(function () {
      // J2优化：若 current-page observer 已接管检测则跳过 O(n) 遍历，由 observer 回调负责
      if (!S.currentPageObserver()) {
        _detectCurrentPage();
      }
      _scrollTimer = null;
    }, 150);
  }

  /**
   * IntersectionObserver 回调：检测当前页（J2优化，替代 _detectCurrentPage 的 O(n) 遍历）
   * 取交叉 entries 里 intersectionRatio 最大的页作为当前页。
   * 滚动时仅状态变化的页进入 entries，开销 O(k)（k 通常 1~3），远低于遍历全部页 + getBoundingClientRect。
   * _detectCurrentPage 作为 observer 不可用时的 fallback 保留。
   */
  function _onCurrentPageObserved(entries) {
    if (!_navContainer) return;

    // Reflow 模式：容器结构不同，仍委托 reflow 模块检测
    if (S.mode() === S.MODE_REFLOW) {
      var reflow = win.BKPdf._internal.reflow;
      if (reflow && reflow.detectCurrentPage) {
        var rpage = reflow.detectCurrentPage();
        if (rpage !== S.currentPage()) {
          S.setCurrentPage(rpage);
          _notifyPageChange(rpage);
          if (!_isProgrammaticScroll && _navBookId) {
            S.saveReadingPosition(_navBookId, rpage);
          }
        }
      }
      return;
    }

    var bestPage = 0;

    if (S.mode() === S.MODE_CONTINUOUS) {
      // Bug16 修复：连续模式下不能取 intersectionRatio 最大的页
      // 手机上 2 页 PDF 同时可见时，page 2 可能 ratio 更大（page 1 顶部被裁剪），
      // 导致误检测为 page 2。正确逻辑：取视口顶部最近的页（与 _detectCurrentPage fallback 一致）
      var entriesMap = {};
      for (var e = 0; e < entries.length; e++) {
        if (entries[e].isIntersecting) {
          var pgNum = parseInt(entries[e].target.getAttribute('data-pdf-page'), 10) || 0;
          if (pgNum > 0) entriesMap[pgNum] = entries[e].target;
        }
      }
      // 如果 observer 只报告了部分页，补充查询所有页
      var allPages = _navContainer.querySelectorAll('.bk-pdf-page');
      for (var ap = 0; ap < allPages.length; ap++) {
        var apNum = parseInt(allPages[ap].getAttribute('data-pdf-page'), 10) || 0;
        if (apNum > 0 && !entriesMap[apNum]) entriesMap[apNum] = allPages[ap];
      }

      var bestDist = Infinity;
      var pageKeys = Object.keys(entriesMap);
      for (var k = 0; k < pageKeys.length; k++) {
        var pNum = parseInt(pageKeys[k], 10);
        var target = entriesMap[pageKeys[k]];
        var rect = target.getBoundingClientRect();
        // 取距视口顶部（+2px 容差）最近的页
        var dist = Math.abs(rect.top - 2);
        if (dist < bestDist) {
          bestDist = dist;
          bestPage = pNum;
        }
      }
    } else {
      // Single 模式
      var allPdfPages = _navContainer.querySelectorAll('.bk-pdf-page');
      if (allPdfPages.length <= 1) {
        // "每页=1章"结构：容器只有1页，直接取 data-pdf-page，无需 ratio 比较
        // 避免 IntersectionObserver 回调时序不确定导致页码闪烁（切章后旧 observer
        // 残留回调可能短暂报告错误页码，覆盖 init() 设置的正确值）
        bestPage = allPdfPages.length === 1
          ? (parseInt(allPdfPages[0].getAttribute('data-pdf-page'), 10) || 1)
          : 1;
      } else {
        // "全书=1章"结构：容器内多页，取 intersectionRatio 最大的页
        var bestRatio = -1;
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) continue;
          var pgNum2 = parseInt(entries[i].target.getAttribute('data-pdf-page'), 10) || 0;
          if (pgNum2 <= 0) continue;
          if (entries[i].intersectionRatio > bestRatio) {
            bestRatio = entries[i].intersectionRatio;
            bestPage = pgNum2;
          }
        }
      }
    }

    if (bestPage > 0 && bestPage !== S.currentPage()) {
      S.setCurrentPage(bestPage);
      _notifyPageChange(bestPage);
      if (!_isProgrammaticScroll && _navBookId) {
        S.saveReadingPosition(_navBookId, bestPage);
      }
    }
  }

  /**
   * 检测当前页码（基于滚动位置）
   * 单页模式：找到视口中心的 .bk-pdf-page
   * 连续模式：找到视口顶部的 .bk-pdf-page
   */
  function _detectCurrentPage() {
    if (!_navContainer) return;

    // Reflow 模式：委托 reflow 模块检测
    if (S.mode() === S.MODE_REFLOW) {
      var reflow = win.BKPdf._internal.reflow;
      if (reflow && reflow.detectCurrentPage) {
        var rpage = reflow.detectCurrentPage();
        if (rpage !== S.currentPage()) {
          S.setCurrentPage(rpage);
          _notifyPageChange(rpage);
          if (!_isProgrammaticScroll && _navBookId) {
            S.saveReadingPosition(_navBookId, rpage);
          }
        }
      }
      return;
    }

    var pages = _navContainer.querySelectorAll('.bk-pdf-page');
    if (!pages.length) return;

    var currentPage = 1;
    if (S.mode() === S.MODE_SINGLE) {
      // Bug6 修复："每页=1章"结构下容器只有1页，直接从 data-pdf-page 取绝对页码
      if (pages.length <= 1) {
        currentPage = parseInt(pages[0].getAttribute('data-pdf-page'), 10) || 1;
      } else {
        // "全书=1章"结构：视口中心定位
        var scrollEl = _getScrollContainer();
        if (!scrollEl) return;
        var scrollLeft = scrollEl.scrollLeft;
        var containerW = scrollEl.clientWidth;
        var centerX = scrollLeft + containerW / 2;

        for (var i = 0; i < pages.length; i++) {
          var left = pages[i].offsetLeft;
          var right = left + pages[i].offsetWidth;
          if (centerX >= left && centerX < right) {
            currentPage = parseInt(pages[i].getAttribute('data-pdf-page'), 10) || (i + 1);
            break;
          }
        }
      }
    } else {
      // 连续模式：视口顶部附近
      var viewTop = _navContainer.scrollTop;
      var bestPage = 1;
      var bestDist = Infinity;
      for (var j = 0; j < pages.length; j++) {
        var rect = pages[j].getBoundingClientRect();
        var dist = Math.abs(rect.top);
        if (dist < bestDist) {
          bestDist = dist;
          bestPage = parseInt(pages[j].getAttribute('data-pdf-page'), 10) || (j + 1);
        }
      }
      currentPage = bestPage;
    }

    if (currentPage !== S.currentPage()) {
      S.setCurrentPage(currentPage);
      _notifyPageChange(currentPage);
      // 非程序滚动时保存位置
      if (!_isProgrammaticScroll && _navBookId) {
        S.saveReadingPosition(_navBookId, currentPage);
      }
    }
  }

  /**
   * 通知 UI 模块更新页码指示器
   */
  function _notifyPageChange(pageNum) {
    var ui = win.BKPdf._internal.ui;
    if (ui && ui.updatePageIndicator) {
      ui.updatePageIndicator(pageNum, S.totalPages() || _getPageCount());
    }
    var thumbs = win.BKPdf._internal.thumbs;
    if (thumbs && thumbs.highlightPage) {
      thumbs.highlightPage(pageNum);
    }
  }

  // ==================== init / cleanup ====================

  function init(containerEl, bookId) {
    _navContainer = containerEl;
    _navBookId = bookId;

    // 应用模式
    applyMode();

    // 设置总页数（仅作为 fallback，异步会从 pdf.numPages 设置正确值）
    var pageEls = containerEl.querySelectorAll('.bk-pdf-page');
    if (!S.totalPages()) S.setTotalPages(pageEls.length);

    // 初始化当前页码（从 data-pdf-page 取绝对页码，而非固定 1）
    var firstPageNum = pageEls.length ? (parseInt(pageEls[0].getAttribute('data-pdf-page'), 10) || 1) : 1;
    S.setCurrentPage(firstPageNum);

    // 绑定滚动监听
    containerEl.addEventListener('scroll', _onScroll, { passive: true });

    // P1-4: Single 模式 rAF 驱动即时页码检测
    // IntersectionObserver 在 scroll-snap 动画期间回调延迟，
    // 用户翻页后页码指示器不实时。添加 rAF 滚动监听，
    // 每帧检测当前页码，实现即时反馈
    if (S.mode() === S.MODE_SINGLE) {
      _cancelSingleRaf();
      containerEl.addEventListener('scroll', _onSingleScrollRaf, { passive: true });
    }

    // 通知初始页码
    _notifyPageChange(firstPageNum);
  }

  // P1-4: Single 模式 rAF 滚动监听——每帧检测页码，即时反馈
  function _onSingleScrollRaf() {
    if (_singleRafId) return; // 上一帧尚未处理，跳过
    _singleRafId = (win.requestAnimationFrame || function (cb) { setTimeout(cb, 16); })(function () {
      _singleRafId = null;
      if (!_navContainer || S.mode() !== S.MODE_SINGLE) return;
      _detectCurrentPage(); // 直接检测，无防抖延迟
    });
  }

  function _cancelSingleRaf() {
    if (_singleRafId) {
      (win.cancelAnimationFrame || clearTimeout)(_singleRafId);
      _singleRafId = null;
    }
  }

  function cleanup() {
    _cancelSingleRaf();
    if (_navContainer) {
      _navContainer.removeEventListener('scroll', _onScroll);
      _navContainer.removeEventListener('scroll', _onSingleScrollRaf);
    }
    if (_scrollTimer) {
      clearTimeout(_scrollTimer);
      _scrollTimer = null;
    }
    _navContainer = null;
    _navBookId = null;
    _isProgrammaticScroll = false;
  }

  // ==================== 导出 ====================

  win.BKPdf._internal.nav = {
    init: init,
    cleanup: cleanup,
    applyMode: applyMode,
    _onCurrentPageObserved: _onCurrentPageObserved,
    goToPage: goToPage,
    goToNext: goToNext,
    goToPrev: goToPrev,
    goToFirst: goToFirst,
    goToLast: goToLast,
    getCurrentPage: function () { return S.currentPage(); },
    getPageCount: _getPageCount
  };

})(window);
