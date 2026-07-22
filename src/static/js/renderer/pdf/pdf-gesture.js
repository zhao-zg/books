/*!
 * pdf-gesture.js - PDF 触摸手势控制器
 *
 * 职责：
 *   - Pinch 实时缩放：touchmove 期间用 CSS transform:scale 实时缩放（零延迟反馈），
 *     touchend 后触发高清重渲染
 *   - 手势委托：监听器绑定到容器而非逐页（性能优化，避免长 PDF 绑数百个监听器）
 *   - 双击缩放：1x ↔ 2x 切换
 *   - 长按选词优化：移动端长按触发文本选择
 *   - rAF 节流：pinch touchmove 用 requestAnimationFrame 节流，避免高频主线程卡顿
 *
 * 依赖：pdf-state.js, pdf-core.js, renderer-pdf.js（需要 _internal.zoom）
 * 挂载：window.BKPdf._internal.gesture
 */
(function (win) {
  'use strict';

  var doc = win.document;
  var S = win.BKPdf._internal.state;

  // ==================== 状态 ====================

  var _gestureEl = null;       // 手势监听绑定的容器元素
  var _gestureBookId = null;   // 当前 PDF 书 ID
  var _pinchState = null;      // pinch 状态
  var _dblTapState = null;     // 双击检测状态
  var _longPressTimer = null;  // 长按定时器
  var _rafScheduled = false;   // rAF 节流标志
  var _pinchVisiblePages = null; // pinch 期间缓存的可见已渲染页（避免每帧 querySelectorAll + getBoundingClientRect）
  var _zoomAnimating = false;  // 双击缩放过渡动画进行中（防止重入 + 阻止 pinch 抢占）
  var _zoomAnimTimer = null;   // 过渡动画兜底定时器
  var _zoomOnEnd = null;       // 过渡动画 transitionend 监听器引用（供 cleanup 显式移除）
  var _zoomOnEndWrap = null;   // transitionend 监听的目标 wrap 元素
  var ZOOM_TRANSITION_MS = 280; // 双击缩放 CSS 过渡时长（与 --ease-out 对齐）

  // ==================== Pinch 实时缩放 ====================

  /**
   * Pinch 状态
   * @typedef {Object} PinchState
   * @property {number} startDist - 双指起始距离
   * @property {number} startZoom - 起始 zoom 值
   * @property {number} currentZoom - 当前实时 zoom（touchmove 期间更新）
   * @property {boolean} active - 是否激活
   * @property {HTMLElement} targetPage - pinch 起始时的 .bk-pdf-page 元素
   */

  function _onTouchStart(e) {
    if (e.touches.length === 2) {
      // 双击缩放过渡动画进行中：忽略新 pinch，避免动画与 pinch transform 冲突
      if (_zoomAnimating) return;
      // 双指开始 → pinch
      _startPinch(e);
    } else if (e.touches.length === 1) {
      // 单指开始 → 检测长按选词
      _startLongPressCheck(e);
    }
  }

  function _onTouchMove(e) {
    if (_pinchState && _pinchState.active && e.touches.length === 2) {
      e.preventDefault();
      _updatePinch(e);
    } else if (_pinchState && _pinchState.active && e.touches.length !== 2) {
      // 从双指变单指，结束 pinch
      _endPinch();
    }
  }

  function _onTouchEnd(e) {
    if (_pinchState && _pinchState.active) {
      _endPinch();
    }
    // 双击检测
    _checkDoubleTap(e);
    // 清除长按
    _cancelLongPress();
  }

  function _onTouchCancel() {
    if (_pinchState && _pinchState.active) {
      _endPinch();
    }
    _cancelLongPress();
  }

  /**
   * 开始 pinch
   */
  function _startPinch(e) {
    var t0 = e.touches[0];
    var t1 = e.touches[1];
    var dx = t0.clientX - t1.clientX;
    var dy = t0.clientY - t1.clientY;
    var dist = Math.sqrt(dx * dx + dy * dy);

    // 找到 pinch 中心所在的 .bk-pdf-page
    var midX = (t0.clientX + t1.clientX) / 2;
    var midY = (t0.clientY + t1.clientY) / 2;
    var targetPage = doc.elementFromPoint(midX, midY);
    if (targetPage) {
      targetPage = targetPage.closest('.bk-pdf-page');
    }

    _pinchState = {
      startDist: dist,
      startZoom: S.zoom(_gestureBookId),
      currentZoom: S.zoom(_gestureBookId),
      active: true,
      targetPage: targetPage
    };
    // 缓存当前视口内已渲染页：pinch 期间复用此引用列表，
    // 避免 _applyPinchTransform 每帧 querySelectorAll + getBoundingClientRect 触发布局抖动
    _pinchVisiblePages = _collectVisibleRenderedPages();
  }

  /**
   * 实时更新 pinch（rAF 节流）
   * touchmove 期间用 CSS transform:scale 实时缩放 canvas，零延迟反馈
   */
  function _updatePinch(e) {
    if (!_pinchState || !_pinchState.active) return;
    var t0 = e.touches[0];
    var t1 = e.touches[1];
    var dx = t0.clientX - t1.clientX;
    var dy = t0.clientY - t1.clientY;
    var dist = Math.sqrt(dx * dx + dy * dy);

    if (_pinchState.startDist > 0) {
      var ratio = dist / _pinchState.startDist;
      var newZoom = _pinchState.startZoom * ratio;
      // 钳制范围
      newZoom = Math.max(S.MIN_ZOOM, Math.min(S.MAX_ZOOM, newZoom));
      _pinchState.currentZoom = newZoom;

      // rAF 节流：每帧只更新一次 transform
      if (!_rafScheduled) {
        _rafScheduled = true;
        (win.requestAnimationFrame || function (cb) { setTimeout(cb, 16); })(function () {
          _rafScheduled = false;
          _applyPinchTransform();
        });
      }
    }
  }

  /**
   * 应用 pinch 实时缩放transform
   * 对当前页面的 canvas 应用 CSS transform:scale，不触发重渲染
   */
  function _applyPinchTransform() {
    if (!_pinchState || !_pinchState.active) return;
    var zoom = _pinchState.currentZoom;
    var startZoom = _pinchState.startZoom;

    // 更新 zoom 控件显示
    var zoomVal = doc.querySelector('.bk-pdf-zoom-value');
    if (zoomVal) zoomVal.textContent = Math.round(zoom * 100) + '%';

    // 如果 zoom 没变化，不需要 transform
    if (Math.abs(zoom - startZoom) < 0.01) return;

    // 复用 pinch 开始时缓存的可见页引用，避免每帧 querySelectorAll + getBoundingClientRect 触发布局抖动
    var scaleRatio = zoom / startZoom;
    var pages = _pinchVisiblePages || [];
    for (var i = 0; i < pages.length; i++) {
      var wrap = pages[i].querySelector('.bk-pdf-canvas-wrap');
      if (wrap) {
        wrap.style.transform = 'scale(' + scaleRatio + ')';
        wrap.style.transformOrigin = 'center center';
        wrap.style.transition = 'none';
      }
      // zoom > 1 时加 zoomed class 让容器可滚动
      if (zoom > 1.0) {
        pages[i].classList.add('bk-pdf-zoomed');
      } else {
        pages[i].classList.remove('bk-pdf-zoomed');
      }
    }
  }

  /**
   * 收集当前视口内已渲染的 PDF 页面（pinch 开始时调用一次，pinch 期间复用）
   * @returns {Array<HTMLElement>}
   */
  function _collectVisibleRenderedPages() {
    var pages = doc.querySelectorAll('.bk-pdf-page[data-pdf-rendered="1"]');
    var result = [];
    var isSingle = S.mode() === S.MODE_SINGLE;
    var vw = win.innerWidth || doc.documentElement.clientWidth;
    var vh = win.innerHeight || doc.documentElement.clientHeight;
    for (var i = 0; i < pages.length; i++) {
      var rect = pages[i].getBoundingClientRect();
      var inView = isSingle
        ? (rect.right > 0 && rect.left < vw)
        : (rect.bottom > 0 && rect.top < vh);
      if (inView) result.push(pages[i]);
    }
    return result;
  }

  /**
   * 结束 pinch：清除 transform，触发高清重渲染
   */
  function _endPinch() {
    if (!_pinchState || !_pinchState.active) return;
    _pinchState.active = false;
    var finalZoom = _pinchState.currentZoom;

    // 清除所有 transform
    var wraps = doc.querySelectorAll('.bk-pdf-canvas-wrap');
    for (var i = 0; i < wraps.length; i++) {
      wraps[i].style.transform = '';
      wraps[i].style.transformOrigin = '';
      wraps[i].style.transition = '';
    }

    // 更新 zoom 状态并触发高清重渲染
    var zoomApi = win.BKPdf._internal.zoom;
    if (zoomApi) {
      zoomApi.setZoom(_gestureBookId, finalZoom);
      zoomApi.applyZoomToVisible(_gestureBookId);
    }

    _pinchState = null;
    _pinchVisiblePages = null;
  }

  // ==================== 双击缩放过渡动画 ====================

  /**
   * 双击缩放过渡：用 CSS transform:scale 实现 280ms 平滑视觉过渡，
   * 过渡结束后清除 transform 并调用 onComplete 触发高清重渲染。
   *
   * 为什么要过渡：原直接 setZoom+applyZoomToVisible 是同步重渲染，
   * 用户会看到内容从 1x 瞬间跳到 2x 的硬切感，且重渲染阻塞主线程造成卡顿。
   * 改用 transform 过渡后：先视觉平滑放大，再异步高清重渲染，体验更流畅。
   *
   * @param {number} fromZoom - 起始 zoom 值
   * @param {number} toZoom - 目标 zoom 值
   * @param {Function} onComplete - 过渡结束后回调（应在此回调内 setZoom + applyZoomToVisible）
   */
  function _animateZoomTransition(fromZoom, toZoom, onComplete) {
    var pages = _collectVisibleRenderedPages();
    if (!pages.length || Math.abs(toZoom - fromZoom) < 0.01) {
      // 无可见页或无变化：跳过过渡直接完成
      onComplete();
      return;
    }
    var scaleRatio = toZoom / fromZoom;

    // 放大目标立即加 zoomed class 让容器变 overflow:auto
    if (toZoom > 1.0) {
      for (var i = 0; i < pages.length; i++) pages[i].classList.add('bk-pdf-zoomed');
    }

    // 应用 transform + transition 到所有可见页的 canvas-wrap
    for (var j = 0; j < pages.length; j++) {
      var wrap = pages[j].querySelector('.bk-pdf-canvas-wrap');
      if (wrap) {
        wrap.style.transform = 'scale(' + scaleRatio + ')';
        wrap.style.transformOrigin = 'center center';
        wrap.style.transition = 'transform ' + ZOOM_TRANSITION_MS + 'ms cubic-bezier(0.16, 1, 0.3, 1)';
      }
    }

    _zoomAnimating = true;
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      if (_zoomAnimTimer) { clearTimeout(_zoomAnimTimer); _zoomAnimTimer = null; }
      // 清除 transform + transition，让 setZoom+applyZoomToVisible 之后用真实高清 canvas
      for (var k = 0; k < pages.length; k++) {
        var w = pages[k].querySelector('.bk-pdf-canvas-wrap');
        if (w) {
          w.style.transform = '';
          w.style.transformOrigin = '';
          w.style.transition = '';
        }
        // 缩小目标移除 zoomed class
        if (toZoom <= 1.0) pages[k].classList.remove('bk-pdf-zoomed');
      }
      _zoomAnimating = false;
      // cleanup 已执行时（_gestureEl 为 null）跳过 onComplete，
      // 避免 onComplete 内用 stale 的 bookId 写入 zoomState 造成 null key 污染
      if (_gestureEl) onComplete();
    }

    // 用第一个 wrap 的 transitionend 作为完成信号（监听一次即移除）
    var firstWrap = pages[0].querySelector('.bk-pdf-canvas-wrap');
    if (firstWrap) {
      var onEnd = function (e) {
        if (e.target !== firstWrap || e.propertyName !== 'transform') return;
        firstWrap.removeEventListener('transitionend', onEnd);
        _zoomOnEnd = null;
        _zoomOnEndWrap = null;
        finish();
      };
      _zoomOnEnd = onEnd;       // 供 cleanup 显式移除
      _zoomOnEndWrap = firstWrap;
      firstWrap.addEventListener('transitionend', onEnd);
    }
    // 兜底：动画时长 + 40ms 后强制完成（防止 transitionend 未触发）
    _zoomAnimTimer = setTimeout(finish, ZOOM_TRANSITION_MS + 40);
  }

  /**
   * 双击缩放公共入口：1x ↔ 2x 切换，带 280ms transform 过渡动画
   * @param {number} clientX - 双击位置 X（用于滚动定位）
   * @param {number} clientY - 双击位置 Y
   */
  function _performDoubleTapZoom(clientX, clientY) {
    if (_zoomAnimating) return;  // 防止重入
    var bookId = _gestureBookId;  // 捕获到本地，防止 cleanup 置 null 后 onComplete 读到 null
    if (!bookId) return;
    var cur = S.zoom(bookId);
    var targetZoom = cur > 1.0 ? 1.0 : 2.0;
    var zoomApi = win.BKPdf._internal.zoom;
    _animateZoomTransition(cur, targetZoom, function () {
      // 过渡结束后：更新 zoom 状态 + 触发高清重渲染
      if (zoomApi) {
        zoomApi.setZoom(bookId, targetZoom);
        zoomApi.applyZoomToVisible(bookId);
      }
      // 让双击位置保持可见
      _scrollToZoomPoint(clientX, clientY, targetZoom);
    });
  }

  // ==================== 缩放后定位滚动 ====================

  /**
   * 缩放后让双击/双击位置保持可见：
   * 放大时 — 找到点击所在 .bk-pdf-page，让该 page 的 scrollTop/left 对准点击位置；
   * 缩小时 — 无需特殊处理（页面已 fit-to-screen）
   */
  function _scrollToZoomPoint(clientX, clientY, newZoom) {
    if (newZoom <= 1.0) return;  // 缩小无需定位
    var el = doc.elementFromPoint(clientX, clientY);
    if (!el) return;
    var page = el.closest('.bk-pdf-page');
    if (!page) return;
    // 计算点击在 page 内的偏移比例，让放大后此位置仍可见
    var pageRect = page.getBoundingClientRect();
    var ratioX = (clientX - pageRect.left) / pageRect.width;
    var ratioY = (clientY - pageRect.top) / pageRect.height;
    // 放大后 page 变 overflow:auto，可独立滚动
    // 延迟一帧等渲染完成后再调整滚动位置
    (win.requestAnimationFrame || function (cb) { setTimeout(cb, 16); })(function () {
      var scrollW = page.scrollWidth - page.clientWidth;
      var scrollH = page.scrollHeight - page.clientHeight;
      if (scrollW > 0) page.scrollLeft = Math.round(ratioX * scrollW);
      if (scrollH > 0) page.scrollTop = Math.round(ratioY * scrollH);
    });
  }

  // ==================== 双击缩放 ====================

  /**
   * 双击检测：350ms 内两次 touchend → 切换 1x ↔ 2x
   */
  function _checkDoubleTap(e) {
    var now = Date.now();
    var touch = e.changedTouches && e.changedTouches[0];
    if (!touch) return;

    if (_dblTapState && (now - _dblTapState.time < 350)) {
      var dx = Math.abs(touch.clientX - _dblTapState.x);
      var dy = Math.abs(touch.clientY - _dblTapState.y);
      if (dx < 30 && dy < 30) {
        // 双击！
        e.preventDefault();
        e.stopPropagation();
        _performDoubleTapZoom(touch.clientX, touch.clientY);
        _dblTapState = null;
        return;
      }
    }
    _dblTapState = { time: now, x: touch.clientX, y: touch.clientY };
  }

  // ==================== 桌面端双击缩放 ====================

  /**
   * 桌面端 dblclick：1x ↔ 2x 切换
   * 移动端由 _checkDoubleTap（touchend 时间戳差值）处理，桌面端走此路径
   */
  function _onDblClick(e) {
    e.preventDefault();
    e.stopPropagation();
    _performDoubleTapZoom(e.clientX, e.clientY);
  }

  // ==================== 长按选词优化 ====================

  /**
   * 长按检测：500ms 不移动 → 触发文本选择模式
   * 优化移动端 textLayer 选词体验，让用户长按后可直接选择文本
   */
  function _startLongPressCheck(e) {
    var touch = e.touches[0];
    if (!touch) return;
    var startX = touch.clientX;
    var startY = touch.clientY;

    _cancelLongPress();
    _longPressTimer = setTimeout(function () {
      // 长按触发：找到 textLayer 并尝试选中附近文本
      var el = doc.elementFromPoint(startX, startY);
      if (!el) return;
      var page = el.closest('.bk-pdf-page');
      if (!page) return;
      var textLayer = page.querySelector('[data-pdf-text-layer]');
      if (!textLayer) return;

      // 标记长按激活，让 textLayer 可选中
      textLayer.classList.add('bk-pdf-text-selecting');
      page.classList.add('bk-pdf-long-press');

      // 尝试选中 touch 点附近的 span
      var targetEl = doc.elementFromPoint(startX, startY);
      if (targetEl && textLayer.contains && textLayer.contains(targetEl)) {
        // 使用 Selection API 尝试选词
        try {
          var range = doc.createRange();
          range.selectNodeContents(targetEl);
          var sel = win.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (err) {}
      }
    }, 500);
  }

  function _cancelLongPress() {
    if (_longPressTimer) {
      clearTimeout(_longPressTimer);
      _longPressTimer = null;
    }
    // 移除长按标记
    var selecting = doc.querySelectorAll('.bk-pdf-text-selecting, .bk-pdf-long-press');
    for (var i = 0; i < selecting.length; i++) {
      selecting[i].classList.remove('bk-pdf-text-selecting', 'bk-pdf-long-press');
    }
  }

  // ==================== init / cleanup ====================

  function init(containerEl, bookId) {
    _gestureEl = containerEl;
    _gestureBookId = bookId;

    // 手势委托：监听器绑到容器，而非逐页绑定（性能优化）
    // passive: false 让 touchmove 可 preventDefault（pinch 需要）
    containerEl.addEventListener('touchstart', _onTouchStart, { passive: true });
    containerEl.addEventListener('touchmove', _onTouchMove, { passive: false });
    containerEl.addEventListener('touchend', _onTouchEnd, { passive: false });
    containerEl.addEventListener('touchcancel', _onTouchCancel, { passive: true });
    // 桌面端双击缩放：touch 事件在桌面不触发，需监听 dblclick
    containerEl.addEventListener('dblclick', _onDblClick);
  }

  function cleanup() {
    if (_gestureEl) {
      _gestureEl.removeEventListener('touchstart', _onTouchStart);
      _gestureEl.removeEventListener('touchmove', _onTouchMove);
      _gestureEl.removeEventListener('touchend', _onTouchEnd);
      _gestureEl.removeEventListener('touchcancel', _onTouchCancel);
      _gestureEl.removeEventListener('dblclick', _onDblClick);
    }
    _gestureEl = null;
    _gestureBookId = null;
    _pinchState = null;
    _pinchVisiblePages = null;
    _dblTapState = null;
    // 中断可能进行中的缩放动画：移除 transitionend 监听器 + 清除 transform 残留 + 复位标志
    if (_zoomAnimTimer) { clearTimeout(_zoomAnimTimer); _zoomAnimTimer = null; }
    if (_zoomOnEnd && _zoomOnEndWrap) {
      _zoomOnEndWrap.removeEventListener('transitionend', _zoomOnEnd);
      _zoomOnEnd = null;
      _zoomOnEndWrap = null;
    }
    if (_zoomAnimating) {
      var wraps = doc.querySelectorAll('.bk-pdf-canvas-wrap');
      for (var i = 0; i < wraps.length; i++) {
        wraps[i].style.transform = '';
        wraps[i].style.transformOrigin = '';
        wraps[i].style.transition = '';
      }
      _zoomAnimating = false;
    }
    _cancelLongPress();
  }

  // ==================== 导出 ====================

  win.BKPdf._internal.gesture = {
    init: init,
    cleanup: cleanup
  };

})(window);
