/*!
 * pdf-ui.js - PDF 用户界面控制器
 *
 * 职责：
 *   - 顶部工具栏（返回/页码/进度条/目录/缩略图/模式切换/夜间/搜索/缩放）
 *   - 页码指示器更新（被 nav 模块调用）
 *   - 进度条拖拽定位
 *   - 工具栏自动隐藏/显示（点击屏幕切换）
 *   - 协调其他 UI 子模块（thumbs/outline/search）的展开/收起
 *
 * 依赖：pdf-state.js, pdf-core.js, pdf-navigator.js
 * 挂载：window.BKPdf._internal.ui
 */
(function (win) {
  'use strict';

  var doc = win.document;
  var S = win.BKPdf._internal.state;

  // ==================== 状态 ====================

  var _topBar = null;
  var _pageInfo = null;
  var _progressBar = null;
  var _pageLabel = null;
  var _uiVisible = true;
  var _uiHideTimer = null;
  var _containerEl = null;

  // ==================== 页码跳转弹窗 ====================

  var _pageJumpOverlay = null;
  var _pageJumpInput = null;
  var _pageJumpError = null;

  // ==================== 顶部工具栏创建 ====================

  function _createTopBar() {
    if (_topBar) return _topBar;

    var bar = doc.createElement('div');
    bar.className = 'bk-pdf-top-bar';
    bar.innerHTML =
      '<button class="bk-pdf-tb-btn bk-pdf-tb-back" aria-label="返回">‹</button>' +
      '<div class="bk-pdf-tb-page-info">' +
        '<span class="bk-pdf-tb-page-label">1 / 1</span>' +
        '<input type="range" class="bk-pdf-tb-progress" min="1" max="1" value="1" step="1" aria-label="页码进度">' +
      '</div>' +
      '<div class="bk-pdf-tb-btn-group">' +
        '<button class="bk-pdf-tb-btn bk-pdf-tb-undo" aria-label="撤销标注" title="撤销标注" disabled>↶</button>' +
        '<button class="bk-pdf-tb-btn bk-pdf-tb-search" aria-label="搜索" title="搜索">🔍</button>' +
        '<button class="bk-pdf-tb-btn bk-pdf-tb-outline" aria-label="目录" title="目录">☰</button>' +
        '<button class="bk-pdf-tb-btn bk-pdf-tb-thumbs" aria-label="缩略图" title="缩略图">▦</button>' +
        '<button class="bk-pdf-tb-btn bk-pdf-tb-bookmark" aria-label="书签" title="书签">🔖</button>' +
        '<button class="bk-pdf-tb-btn bk-pdf-tb-highlight" aria-label="高亮列表" title="高亮列表">🖍</button>' +
        '<button class="bk-pdf-tb-btn bk-pdf-tb-night" aria-label="夜间模式" title="夜间模式">🌙</button>' +
        '<button class="bk-pdf-tb-btn bk-pdf-tb-brightness" aria-label="亮度" title="亮度">☀</button>' +
        '<button class="bk-pdf-tb-btn bk-pdf-tb-mode" aria-label="切换模式" title="切换模式">⇄</button>' +
        '<button class="bk-pdf-tb-btn bk-pdf-tb-zoom" aria-label="缩放" title="缩放">⊕</button>' +
      '</div>';
    doc.body.appendChild(bar);

    _topBar = bar;
    _pageLabel = bar.querySelector('.bk-pdf-tb-page-label');
    _progressBar = bar.querySelector('.bk-pdf-tb-progress');

    _bindTopBarEvents();

    // 页码 label 点击 → 弹出页码跳转
    if (_pageLabel) {
      _pageLabel.addEventListener('click', _showPageJumpDialog);
    }

    return bar;
  }

  function _bindTopBarEvents() {
    if (!_topBar) return;

    // 返回
    var backBtn = _topBar.querySelector('.bk-pdf-tb-back');
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        // 检查是否可以从返回栈返回
        var links = win.BKPdf._internal.links;
        if (links && links.canGoBack && links.canGoBack()) {
          links.goBack();
        } else if (win.BKRouter) {
          win.BKRouter.navigate('');
        } else {
          win.history.back();
        }
      });
    }

    // 进度条拖拽
    if (_progressBar) {
      _progressBar.addEventListener('input', function (e) {
        var page = parseInt(e.target.value, 10);
        if (_pageLabel) _pageLabel.textContent = page + ' / ' + (S.totalPages() || 1);
      });
      _progressBar.addEventListener('change', function (e) {
        var page = parseInt(e.target.value, 10);
        var nav = win.BKPdf._internal.nav;
        if (nav && nav.goToPage) nav.goToPage(page, false);
      });
    }

    // 撤销标注（F5）
    var undoBtn = _topBar.querySelector('.bk-pdf-tb-undo');
    if (undoBtn) {
      undoBtn.addEventListener('click', function () {
        var U = win.BKPdf._internal.undo;
        if (U && U.canUndo && U.canUndo()) {
          U.undo();
        }
      });
    }

    // 搜索
    var searchBtn = _topBar.querySelector('.bk-pdf-tb-search');
    if (searchBtn) {
      searchBtn.addEventListener('click', function () {
        var search = win.BKPdf._internal.search;
        if (search && search.toggle) search.toggle();
      });
    }

    // 目录
    var outlineBtn = _topBar.querySelector('.bk-pdf-tb-outline');
    if (outlineBtn) {
      outlineBtn.addEventListener('click', function () {
        var outline = win.BKPdf._internal.outline;
        if (outline && outline.toggle) outline.toggle();
      });
    }

    // 缩略图
    var thumbsBtn = _topBar.querySelector('.bk-pdf-tb-thumbs');
    if (thumbsBtn) {
      thumbsBtn.addEventListener('click', function () {
        var thumbs = win.BKPdf._internal.thumbs;
        if (thumbs && thumbs.toggle) thumbs.toggle();
      });
    }

    // 书签按钮（单击 toggle 当前页书签，长按打开书签抽屉列表）
    var bookmarkBtn = _topBar.querySelector('.bk-pdf-tb-bookmark');
    if (bookmarkBtn) {
      var _bmPressTimer = null;
      var _bmLongPressed = false;
      var BM_LONGPRESS_MS = 500;

      function _bmStartPress() {
        _bmLongPressed = false;
        _bmPressTimer = setTimeout(function () {
          _bmLongPressed = true;
          _bmPressTimer = null;
          var bm = win.BKPdf._internal.bookmark;
          if (bm && bm.show) bm.show();
          if (navigator.vibrate) navigator.vibrate(10);
        }, BM_LONGPRESS_MS);
      }

      function _bmCancelPress() {
        if (_bmPressTimer) {
          clearTimeout(_bmPressTimer);
          _bmPressTimer = null;
        }
      }

      // pointer 事件统一处理触摸与鼠标，不会出现 touch→mouse 重复触发
      bookmarkBtn.addEventListener('pointerdown', _bmStartPress);
      bookmarkBtn.addEventListener('pointerup', _bmCancelPress);
      bookmarkBtn.addEventListener('pointerleave', _bmCancelPress);
      bookmarkBtn.addEventListener('pointercancel', _bmCancelPress);

      bookmarkBtn.addEventListener('click', function (e) {
        if (_bmLongPressed) {
          // 长按已打开抽屉，跳过 toggle
          _bmLongPressed = false;
          e.preventDefault();
          return;
        }
        var bm = win.BKPdf._internal.bookmark;
        if (bm && bm.toggleCurrentPage) bm.toggleCurrentPage();
      });
      _updateBookmarkBtnState();
    }

    // 高亮列表按钮
    var highlightBtn = _topBar.querySelector('.bk-pdf-tb-highlight');
    if (highlightBtn) {
      highlightBtn.addEventListener('click', function () {
        var hl = win.BKPdf._internal.highlight;
        if (hl && hl.toggle) hl.toggle();
      });
    }

    // 夜间/护眼模式（四档循环：normal → sepia → green → invert → normal）
    var nightBtn = _topBar.querySelector('.bk-pdf-tb-night');
    if (nightBtn) {
      nightBtn.addEventListener('click', function () {
        var cur = S.nightMode();
        var next;
        if (cur === S.NIGHT_NORMAL) next = S.NIGHT_SEPIA;
        else if (cur === S.NIGHT_SEPIA) next = S.NIGHT_GREEN;
        else if (cur === S.NIGHT_GREEN) next = S.NIGHT_INVERT;
        else next = S.NIGHT_NORMAL;
        S.setNightMode(next);
        _updateNightBtnIcon();
      });
      _updateNightBtnIcon();
    }

    // 亮度调节（点击展开亮度滑块）
    var brightnessBtn = _topBar.querySelector('.bk-pdf-tb-brightness');
    if (brightnessBtn) {
      brightnessBtn.addEventListener('click', function () {
        _toggleBrightnessBar();
      });
      _updateBrightnessBtnIcon();
    }

    // 模式切换（三态循环：single → continuous → reflow → single）
    var modeBtn = _topBar.querySelector('.bk-pdf-tb-mode');
    if (modeBtn) {
      modeBtn.addEventListener('click', function () {
        var cur = S.mode();
        var newMode;
        if (cur === S.MODE_SINGLE) newMode = S.MODE_CONTINUOUS;
        else if (cur === S.MODE_CONTINUOUS) newMode = S.MODE_REFLOW;
        else newMode = S.MODE_SINGLE;
        win.BKPdf.setMode(newMode);
        modeBtn.textContent = newMode === S.MODE_SINGLE ? '📜' : (newMode === S.MODE_CONTINUOUS ? '📄' : '⇶');
      });
      // 初始状态
      var curMode = S.mode();
      modeBtn.textContent = curMode === S.MODE_SINGLE ? '📜' : (curMode === S.MODE_CONTINUOUS ? '📄' : '⇶');
    }

    // 缩放（展开缩放控件或直接 zoom in）
    var zoomBtn = _topBar.querySelector('.bk-pdf-tb-zoom');
    if (zoomBtn) {
      zoomBtn.addEventListener('click', function () {
        var bookId = S.currentBookId();
        if (bookId) win.BKPdf.zoomIn(bookId);
      });
    }
  }

  // ==================== 页码指示器更新 ====================

  /**
   * 夜间模式按钮图标同步
   */
  function _updateNightBtnIcon() {
    var nightBtn = _topBar ? _topBar.querySelector('.bk-pdf-tb-night') : null;
    if (!nightBtn) return;
    var mode = S.nightMode();
    if (mode === S.NIGHT_INVERT) nightBtn.textContent = '☀';
    else if (mode === S.NIGHT_SEPIA) nightBtn.textContent = '📙';
    else if (mode === S.NIGHT_GREEN) nightBtn.textContent = '🌿';
    else nightBtn.textContent = '🌙';
  }

  /**
   * 书签按钮状态同步（当前页已加书签时高亮）
   */
  function updateBookmarkBtn() {
    _updateBookmarkBtnState();
  }

  function _updateBookmarkBtnState() {
    var btn = _topBar ? _topBar.querySelector('.bk-pdf-tb-bookmark') : null;
    if (!btn) return;
    var bookId = S.currentBookId();
    var page = S.currentPage();
    if (bookId && page && S.isBookmarked(bookId, page)) {
      btn.classList.add('bk-pdf-tb-bookmark-active');
    } else {
      btn.classList.remove('bk-pdf-tb-bookmark-active');
    }
  }

  // ==================== 亮度调节条 ====================

  var _brightnessBar = null;
  var _brightnessSlider = null;
  var _brightnessLabel = null;

  function _createBrightnessBar() {
    if (_brightnessBar) return _brightnessBar;
    var bar = doc.createElement('div');
    bar.className = 'bk-pdf-brightness-bar';
    bar.innerHTML =
      '<span class="bk-pdf-brightness-label">亮度</span>' +
      '<input type="range" class="bk-pdf-brightness-slider" min="30" max="100" value="' + (S.brightness() || 100) + '" step="1" aria-label="亮度调节">' +
      '<span class="bk-pdf-brightness-value">' + (S.brightness() || 100) + '%</span>';
    doc.body.appendChild(bar);
    _brightnessBar = bar;
    _brightnessSlider = bar.querySelector('.bk-pdf-brightness-slider');
    _brightnessLabel = bar.querySelector('.bk-pdf-brightness-value');

    // 滑块事件
    if (_brightnessSlider) {
      _brightnessSlider.addEventListener('input', function (e) {
        var val = parseInt(e.target.value, 10);
        S.setBrightness(val);
        if (_brightnessLabel) _brightnessLabel.textContent = val + '%';
      });
    }

    // 点击条外部关闭
    bar.addEventListener('click', function (e) {
      if (e.target === bar) _hideBrightnessBar();
    });

    return bar;
  }

  function _toggleBrightnessBar() {
    if (_brightnessBar && _brightnessBar.classList.contains('bk-pdf-brightness-visible')) {
      _hideBrightnessBar();
    } else {
      _showBrightnessBar();
    }
  }

  function _showBrightnessBar() {
    _createBrightnessBar();
    if (_brightnessBar) {
      if (_brightnessSlider) _brightnessSlider.value = S.brightness();
      if (_brightnessLabel) _brightnessLabel.textContent = S.brightness() + '%';
      _brightnessBar.classList.add('bk-pdf-brightness-visible');
    }
    _closeOthersForBrightness();
  }

  function _hideBrightnessBar() {
    if (_brightnessBar) _brightnessBar.classList.remove('bk-pdf-brightness-visible');
  }

  function _closeOthersForBrightness() {
    S.closeAllDrawersExcept('brightness');
  }

  function _updateBrightnessBtnIcon() {
    var btn = _topBar ? _topBar.querySelector('.bk-pdf-tb-brightness') : null;
    if (!btn) return;
    var b = S.brightness();
    if (b < 60) btn.textContent = '🔅';
    else if (b < 85) btn.textContent = '🔆';
    else btn.textContent = '☀';
  }

  // ==================== 页码跳转弹窗 ====================

  function _createPageJumpDialog() {
    if (_pageJumpOverlay) return _pageJumpOverlay;
    var overlay = doc.createElement('div');
    overlay.className = 'bk-pdf-page-jump-overlay';
    overlay.innerHTML =
      '<div class="bk-pdf-page-jump-dialog" role="dialog" aria-label="跳转到页码">' +
        '<div class="bk-pdf-page-jump-title">跳转到页码</div>' +
        '<input type="number" class="bk-pdf-page-jump-input" min="1" inputmode="numeric" placeholder="输入页码">' +
        '<div class="bk-pdf-page-jump-error" hidden></div>' +
        '<div class="bk-pdf-page-jump-actions">' +
          '<button type="button" class="bk-pdf-page-jump-btn bk-pdf-page-jump-cancel">取消</button>' +
          '<button type="button" class="bk-pdf-page-jump-btn bk-pdf-page-jump-go">跳转</button>' +
        '</div>' +
      '</div>';
    doc.body.appendChild(overlay);
    _pageJumpOverlay = overlay;
    _pageJumpInput = overlay.querySelector('.bk-pdf-page-jump-input');
    _pageJumpError = overlay.querySelector('.bk-pdf-page-jump-error');

    // 取消按钮
    var cancelBtn = overlay.querySelector('.bk-pdf-page-jump-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', _hidePageJumpDialog);

    // 跳转按钮
    var goBtn = overlay.querySelector('.bk-pdf-page-jump-go');
    if (goBtn) goBtn.addEventListener('click', _doPageJump);

    // 输入框回车 → 跳转
    if (_pageJumpInput) {
      _pageJumpInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          _doPageJump();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          _hidePageJumpDialog();
        }
      });
      // 输入时清除错误
      _pageJumpInput.addEventListener('input', function () {
        if (_pageJumpError && !_pageJumpError.hasAttribute('hidden')) {
          _pageJumpError.setAttribute('hidden', '');
        }
      });
    }

    // 点击遮罩关闭
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) _hidePageJumpDialog();
    });

    return overlay;
  }

  function _showPageJumpDialog() {
    _createPageJumpDialog();
    if (!_pageJumpOverlay) return;
    // 填入当前页码并选中
    var cur = S.currentPage() || 1;
    var total = S.totalPages() || 1;
    if (_pageJumpInput) {
      _pageJumpInput.max = total;
      _pageJumpInput.value = cur;
      // 显示提示
      _pageJumpInput.placeholder = '1 - ' + total;
    }
    if (_pageJumpError) _pageJumpError.setAttribute('hidden', '');
    _pageJumpOverlay.classList.add('bk-pdf-page-jump-visible');
    // 聚焦并选中（延时等待动画）
    setTimeout(function () {
      if (_pageJumpInput) {
        _pageJumpInput.focus();
        _pageJumpInput.select();
      }
    }, 50);
  }

  function _hidePageJumpDialog() {
    if (!_pageJumpOverlay) return;
    _pageJumpOverlay.classList.remove('bk-pdf-page-jump-visible');
    if (_pageJumpError) _pageJumpError.setAttribute('hidden', '');
    // 失焦收起软键盘
    if (_pageJumpInput) _pageJumpInput.blur();
  }

  function _doPageJump() {
    if (!_pageJumpInput) return;
    var raw = _pageJumpInput.value.trim();
    if (!raw) {
      _showJumpError('请输入页码');
      return;
    }
    var page = parseInt(raw, 10);
    var total = S.totalPages() || 1;
    if (isNaN(page) || page < 1) {
      _showJumpError('页码不能小于 1');
      return;
    }
    if (page > total) {
      _showJumpError('页码不能超过 ' + total);
      return;
    }
    var nav = win.BKPdf._internal.nav;
    if (nav && nav.goToPage) nav.goToPage(page, false);
    _hidePageJumpDialog();
  }

  function _showJumpError(msg) {
    if (!_pageJumpError) return;
    _pageJumpError.textContent = msg;
    _pageJumpError.removeAttribute('hidden');
  }

  function updatePageIndicator(currentPage, totalPages) {
    // 获取章节名
    var chapterName = '';
    var bookId = S.currentBookId();
    if (bookId && currentPage) {
      chapterName = S.getChapterNameByPage(bookId, currentPage);
    }
    if (_pageLabel) {
      // 使用页码标签（如有）
      var label = S.getDisplayPageLabel(currentPage);
      var totalLabel = (totalPages || 1);
      var pct = totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : 0;
      var text = label + ' / ' + totalLabel + '  ' + pct + '%';
      if (chapterName) text = chapterName + ' · ' + text;
      _pageLabel.textContent = text;
    }
    if (_progressBar) {
      _progressBar.max = totalPages || 1;
      _progressBar.value = currentPage || 1;
    }
    // 同步书签按钮状态
    _updateBookmarkBtnState();
  }

  // ==================== 工具栏自动隐藏/显示 ====================

  function _showUI() {
    _uiVisible = true;
    if (_topBar) _topBar.classList.add('bk-pdf-ui-visible');
    if (_uiHideTimer) clearTimeout(_uiHideTimer);
    // 3 秒后自动隐藏
    _uiHideTimer = setTimeout(_hideUI, 3000);
  }

  function _hideUI() {
    _uiVisible = false;
    if (_topBar) _topBar.classList.remove('bk-pdf-ui-visible');
  }

  function _toggleUI() {
    if (_uiVisible) {
      _hideUI();
    } else {
      _showUI();
    }
  }

  // ==================== init / cleanup ====================

  function init(containerEl, bookId) {
    _containerEl = containerEl;
    _createTopBar();
    _showUI();

    // 点击容器区域切换 UI（但不影响 pinch/swipe 手势）
    // 用 click 而非 touchend 避免与 pinch 冲突
    containerEl.addEventListener('click', _onContainerClick);

    // 补一次页码同步：nav 子模块早于 ui init，初次 _notifyPageChange 被丢弃
    // （_pageLabel 当时还是 null），这里 topBar 已创建，重新同步一次
    var nav = win.BKPdf._internal.nav;
    if (nav) {
      var total = (nav.getPageCount ? nav.getPageCount() : (S.totalPages() || 1));
      updatePageIndicator(S.currentPage() || 1, total);
    }

    // F5：监听撤销栈状态，同步 ↶ 按钮启用/禁用
    var U = win.BKPdf._internal.undo;
    if (U && U.onChange) {
      U.onChange(function (canUndo) {
        var btn = _topBar ? _topBar.querySelector('.bk-pdf-tb-undo') : null;
        if (btn) {
          if (canUndo) btn.removeAttribute('disabled');
          else btn.setAttribute('disabled', '');
        }
      });
    }
  }

  function _onContainerClick(e) {
    // 只在点击空白区域（非链接/非文本选择）时切换 UI
    var target = e.target;
    if (target.tagName === 'A' || target.tagName === 'BUTTON') return;
    if (target.closest('[data-pdf-annotation-layer]')) return;
    if (target.closest('.bk-pdf-text-layer') && win.getSelection().toString()) return;
    _toggleUI();
  }

  function cleanup() {
    if (_containerEl) {
      _containerEl.removeEventListener('click', _onContainerClick);
    }
    if (_topBar && _topBar.parentNode) {
      _topBar.parentNode.removeChild(_topBar);
    }
    if (_uiHideTimer) {
      clearTimeout(_uiHideTimer);
      _uiHideTimer = null;
    }
    if (_brightnessBar && _brightnessBar.parentNode) {
      _brightnessBar.parentNode.removeChild(_brightnessBar);
    }
    if (_pageJumpOverlay && _pageJumpOverlay.parentNode) {
      _pageJumpOverlay.parentNode.removeChild(_pageJumpOverlay);
    }
    _brightnessBar = null;
    _brightnessSlider = null;
    _brightnessLabel = null;
    _pageJumpOverlay = null;
    _pageJumpInput = null;
    _pageJumpError = null;
    _topBar = null;
    _pageInfo = null;
    _progressBar = null;
    _pageLabel = null;
    _containerEl = null;
    // 同步通知主入口：zoom 控件也应从 DOM 移除（不再单设置 display:none）
    var main = win.BKPdf._internal;
    if (main && main.zoom && main.zoom.detachControls) {
      main.zoom.detachControls();
    }
  }

  // ==================== 导出 ====================

  win.BKPdf._internal.ui = {
    init: init,
    cleanup: cleanup,
    updatePageIndicator: updatePageIndicator,
    updateBookmarkBtn: updateBookmarkBtn,
    showUI: _showUI,
    hideUI: _hideUI,
    toggleUI: _toggleUI,
    hideBrightnessBar: _hideBrightnessBar
  };

})(window);
