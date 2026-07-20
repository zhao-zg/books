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
    if (pageNum < 1) pageNum = 1;
    if (pageNum > pages.length) pageNum = pages.length;

    var target = pages[pageNum - 1];
    if (!target) return;

    _isProgrammaticScroll = true;

    if (S.mode() === S.MODE_SINGLE) {
      // 单页模式：横向 scroll-snap，scrollLeft 跳转
      var scrollEl = _getScrollContainer();
      if (scrollEl) {
        // 计算目标页的 offsetLeft
        var targetLeft = target.offsetLeft;
        scrollEl.scrollTo({ left: targetLeft, behavior: 'smooth' });
      }
    } else {
      // 连续模式：垂直滚动
      // 注意：position:fixed 容器中 scrollIntoView 可能不生效（Chromium 已知行为），
      // 使用 offsetTop + scrollTo 替代
      var scrollEl = _getScrollContainer();
      if (scrollEl) {
        var targetTop = target.offsetTop;
        scrollEl.scrollTo({ top: targetTop, behavior: 'smooth' });
      } else {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    setTimeout(function () { _isProgrammaticScroll = false; }, 500);
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
    goToPage(1, false);
  }

  function goToLast() {
    var total = _getPageCount();
    goToPage(total, false);
  }

  function _getPageCount() {
    if (_navContainer) {
      return _navContainer.querySelectorAll('.bk-pdf-page').length;
    }
    return S.totalPages();
  }

  /**
   * 获取滚动容器
   * 单页模式：横向滚动容器（.content 或更上层）
   * 连续模式：.content 本身
   */
  function _getScrollContainer() {
    if (!_navContainer) return null;
    // 单页模式下 .content 自身是横向 scroll-snap 容器
    return _navContainer;
  }

  // ==================== 滚动监听 → 页码更新 + 位置记忆 ====================

  function _onScroll() {
    if (_scrollTimer) clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(function () {
      _detectCurrentPage();
      _scrollTimer = null;
    }, 150);
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
      // 单页模式：视口中心
      var scrollEl = _getScrollContainer();
      if (!scrollEl) return;
      var scrollLeft = scrollEl.scrollLeft;
      var containerW = scrollEl.clientWidth;
      var centerX = scrollLeft + containerW / 2;

      for (var i = 0; i < pages.length; i++) {
        var left = pages[i].offsetLeft;
        var right = left + pages[i].offsetWidth;
        if (centerX >= left && centerX < right) {
          currentPage = i + 1;
          break;
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
          bestPage = j + 1;
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
      ui.updatePageIndicator(pageNum, _getPageCount());
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

    // 设置总页数
    var pageEls = containerEl.querySelectorAll('.bk-pdf-page');
    S.setTotalPages(pageEls.length);

    // 初始化当前页码
    S.setCurrentPage(1);

    // 绑定滚动监听
    containerEl.addEventListener('scroll', _onScroll, { passive: true });

    // 通知初始页码
    _notifyPageChange(1);
  }

  function cleanup() {
    if (_navContainer) {
      _navContainer.removeEventListener('scroll', _onScroll);
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
    goToPage: goToPage,
    goToNext: goToNext,
    goToPrev: goToPrev,
    goToFirst: goToFirst,
    goToLast: goToLast,
    getCurrentPage: function () { return S.currentPage(); },
    getPageCount: _getPageCount
  };

})(window);
