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
  var _longPressStart = null;  // 长按起点坐标 {x, y}（用于 touchmove 位移超阈值取消）
  var _rafScheduled = false;   // rAF 节流标志
  var LONG_PRESS_MOVE_TOLERANCE = 12; // 长按判定期间手指位移容差（px），超阈值视为滚动/滑动，取消长按
  var _pinchVisiblePages = null; // pinch 期间缓存的可见已渲染页（避免每帧 querySelectorAll + getBoundingClientRect）
  var _zoomAnimating = false;  // 双击缩放过渡动画进行中（防止重入 + 阻止 pinch 抢占）
  var _zoomAnimTimer = null;   // 过渡动画兜底定时器
  var _zoomOnEnd = null;       // 过渡动画 transitionend 监听器引用（供 cleanup 显式移除）
  var _zoomOnEndWrap = null;   // transitionend 监听的目标 wrap 元素
  var ZOOM_TRANSITION_MS = 220; // 双击缩放 CSS 过渡时长（220ms 对标原生 iOS/Android 缩放节奏）

  // ==================== Pinch 实时缩放 ====================

  /**
   * Pinch 状态
   * @typedef {Object} PinchState
   * @property {number} startDist - 双指起始距离
   * @property {number} startZoom - 起始 zoom 值
   * @property {number} currentZoom - 当前实时 zoom（touchmove 期间更新）
   * @property {boolean} active - 是否激活
   * @property {HTMLElement} targetPage - pinch 起始时的 .bk-pdf-page 元素
   * @property {HTMLElement} focusPage - 双指中心所在的焦点页（有 canvas-wrap 时）
   * @property {Object|null} focusPoint - 缩放焦点 {x, y(双指中心在 wrap 局部坐标), ratioX, ratioY(内容比例), vx, vy(双指中心视口坐标)}
   */

  function _onTouchStart(e) {
    if (e.touches.length === 2) {
      // 双指开始 → pinch；同时取消可能进行中的长按判定（双指必然不是长按选词）
      _cancelLongPress();
      // 双击缩放过渡动画进行中：忽略新 pinch，避免动画与 pinch transform 冲突
      if (_zoomAnimating) return;
      _startPinch(e);
    } else if (e.touches.length === 1) {
      // 单指开始 → 记录起点 + 检测长按选词
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
    // 单指移动超过容差 → 判定为滚动/滑动，取消长按选词
    // （否则手指微微滑动后停在文字上，500ms 定时器仍会触发整段全选）
    if (_longPressTimer && e.touches.length === 1) {
      var t = e.touches[0];
      if (_longPressStart &&
          (Math.abs(t.clientX - _longPressStart.x) > LONG_PRESS_MOVE_TOLERANCE ||
           Math.abs(t.clientY - _longPressStart.y) > LONG_PRESS_MOVE_TOLERANCE)) {
        _cancelLongPress();
      }
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

    // ★ 焦点缩放锚点：记录双指中心在焦点页 canvas-wrap 内的局部坐标与内容比例，
    //    pinch 期间以此为 transform-origin，使放大围绕手指所在的内容而非页面中心
    var focusPage = null;
    var focusPoint = null;
    if (targetPage) {
      var fw = targetPage.querySelector('.bk-pdf-canvas-wrap');
      if (fw) {
        var frect = fw.getBoundingClientRect();
        if (frect.width > 0 && frect.height > 0) {
          focusPage = targetPage;
          focusPoint = {
            x: midX - frect.left,          // 双指中心在 wrap 局部 X（transform-origin 用 px）
            y: midY - frect.top,           // 双指中心在 wrap 局部 Y
            ratioX: (midX - frect.left) / frect.width,   // 内容比例（滚动补偿用）
            ratioY: (midY - frect.top) / frect.height,
            vx: midX,                       // 双指中心视口坐标（滚动补偿目标）
            vy: midY,
            startW: frect.width,            // ★ pinch 开始时 wrap 尺寸（轮询就绪判定用，区分旧 canvas 与重渲染后新 canvas）
            startH: frect.height
          };
        }
      }
    }

    _pinchState = {
      startDist: dist,
      startZoom: S.zoom(_gestureBookId),
      currentZoom: S.zoom(_gestureBookId),
      active: true,
      targetPage: targetPage,
      focusPage: focusPage,
      focusPoint: focusPoint
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
    var fp = _pinchState.focusPoint;
    var fPage = _pinchState.focusPage;
    for (var i = 0; i < pages.length; i++) {
      var wrap = pages[i].querySelector('.bk-pdf-canvas-wrap');
      if (wrap) {
        wrap.style.transform = 'scale(' + scaleRatio + ')';
        // ★ 焦点页以双指中心为缩放锚点（对着目标焦点放大），其余页保持中心锚点
        wrap.style.transformOrigin = (fPage && fp && pages[i] === fPage)
          ? fp.x + 'px ' + fp.y + 'px'
          : 'center center';
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
   * 结束 pinch：保留 transform 缩放图，延迟触发高清重渲染（避免手指松开瞬间卡顿）
   * 流程：松手 → 更新 zoom 状态 → 等空闲 → 清 transform + 高清重渲染
   */
  function _endPinch() {
    if (!_pinchState || !_pinchState.active) return;
    _pinchState.active = false;
    var finalZoom = _pinchState.currentZoom;
    var bookId = _gestureBookId;
    // 保存焦点信息供滚动补偿使用（_pinchState 随后置 null）
    var fp = _pinchState.focusPoint;
    var fPage = _pinchState.focusPage;

    // 先更新 zoom 状态（不触发重渲染）
    var zoomApi = win.BKPdf._internal.zoom;
    if (zoomApi) {
      zoomApi.setZoom(bookId, finalZoom);
    }

    _pinchState = null;
    _pinchVisiblePages = null;

    // 延迟 1 帧：让手指松开的 UI 反馈先完成，再触发高清重渲染
    // 此时 transform 仍在，用户看到的仍是 pinch 缩放图（视觉连续）
    (win.requestAnimationFrame || function (cb) { setTimeout(cb, 16); })(function () {
      // 清除所有 transform（此时新 canvas 即将渲染，清除 transform 不会闪烁）
      var wraps = doc.querySelectorAll('.bk-pdf-canvas-wrap');
      for (var i = 0; i < wraps.length; i++) {
        wraps[i].style.transform = '';
        wraps[i].style.transformOrigin = '';
        wraps[i].style.transition = '';
      }
      // 触发高清重渲染
      if (zoomApi && bookId) {
        zoomApi.applyZoomToVisible(bookId);
      }
      // ★ 焦点保持：缩放结束后滚动补偿，让手指中心处的内容仍停留在手指位置
      // （高清 canvas 重渲染是异步的，先等新 canvas 就位再微调滚动位置）
      if (fPage && fp && finalZoom > 1.0) {
        _scheduleFocusScrollCompensation(fPage, fp, finalZoom);
      }
    });
  }

  /**
   * ★ 焦点滚动补偿：pinch 结束后让手指中心处的内容仍停留在手指中心。
   *
   * 原理：pinch 期间以双指中心为 transform-origin 缩放，视觉上焦点被"钉"在手指下；
   * 高清重渲染后 canvas 变为新尺寸（更大），页面滚动容器需重新定位，
   * 使原焦点内容（渲染前记录的内容比例 ratioX/ratioY）恰好落在双指中心处。
   *
   * 计算：新 canvas 下焦点内容在页面内容坐标 = ratio * 新内容尺寸，
   * 减去双指中心到页面左上角的视口偏移，即为所需的 scrollLeft/scrollTop。
   *
   * 滚动参考对象分两种模式：
   * - 单页模式：.bk-pdf-page 自身是滚动容器（bk-pdf-zoomed），直接设置 page.scrollTop/Left；
   * - 连续滚动模式：垂直滚动容器是 .bk-pdf-continuous-view（整本书纵向滚动），
   *   水平方向页面自身滚动（zoom>1 时页宽超出容器），需分别补偿。
   *
   * @param {HTMLElement} page - 焦点页 .bk-pdf-page
   * @param {Object} fp - pinch 开始时记录的 focusPoint
   */
  function _scheduleFocusScrollCompensation(page, fp, finalZoom) {
    // 高清重渲染是异步的（pdf.js 渲染 canvas），需等新 canvas 就绪再补偿。
    // ★ 就绪判定：canvas 尺寸已显著大于 pinch 开始时记录的尺寸（startW/startH）。
    //   旧方案 cw > pageW 在 zoom=1 时就满足（canvas 500 > page 483），导致用旧尺寸算出
    //   targetScrollX=-1 被 clamp 到 0，水平补偿完全失效。
    //   新方案：新 canvas 宽度应接近 startW * finalZoom，用 0.8 容差防 pdf.js 边缘裁切误差。
    var raf = win.requestAnimationFrame || function (cb) { setTimeout(cb, 16); };
    var attempts = 0;
    var MAX_ATTEMPTS = 90; // ~1.5s 上限（15ms/帧 → 90帧）
    var targetW = (fp.startW || 0) * finalZoom;
    var targetH = (fp.startH || 0) * finalZoom;
    var thresholdW = targetW * 0.8;
    var thresholdH = targetH * 0.8;
    function tryCompensate() {
      attempts++;
      if (!page || !page.isConnected) return;
      var wrap = page.querySelector('.bk-pdf-canvas-wrap');
      // ★ wrap/canvas 可能在 pdf.js 重渲染期间被短暂移除再重建，
      //   此时不应急退出，应继续轮询等待新 canvas 就位
      if (!wrap) {
        if (attempts < MAX_ATTEMPTS) { raf(tryCompensate); }
        return;
      }
      var canvas = wrap.querySelector('canvas');
      if (!canvas) {
        if (attempts < MAX_ATTEMPTS) { raf(tryCompensate); }
        return;
      }
      var cw = canvas.clientWidth || 0;
      var ch = canvas.clientHeight || 0;
      if (cw <= 0 || ch <= 0) {
        if (attempts < MAX_ATTEMPTS) { raf(tryCompensate); }
        return;
      }
      // 就绪判定：canvas 尺寸已接近放大后目标尺寸（说明高清重渲染完成）
      if (cw < thresholdW || ch < thresholdH) {
        // 尚未重渲染到目标尺寸，继续等
        if (attempts < MAX_ATTEMPTS) { raf(tryCompensate); }
        return;
      }
      _applyScrollCompensation(page, fp, cw, ch);
    }
    raf(tryCompensate);
  }

  /**
   * 应用滚动补偿（尺寸已就绪后执行）
   */
  function _applyScrollCompensation(page, fp, contentW, contentH) {
    // 焦点在内容中的比例（基于 pinch 时记录的 wrap 局部坐标）
    var ratioX = fp.ratioX;
    var ratioY = fp.ratioY;

    // 连续滚动模式：垂直滚动容器是 .bk-pdf-continuous-view，页面自身只做水平滚动
    // 容器是 position:fixed，offsetParent 恒为 null，不能用 offsetParent 判断存在性；
    // 用 isConnected + getBoundingClientRect 宽度判断（仅当容器真实存在且参与布局时走连续分支）
    var cont = doc.getElementById('bkPdfContinuousView');
    var contRect = cont ? cont.getBoundingClientRect() : null;
    if (cont && contRect && contRect.width > 0 && contRect.height > 0) {
      // 垂直：让焦点内容（页内 ratioY 处）落在双指中心的视口 Y
      // 页面在容器内容坐标中的 Y = 页面视口位置 + 容器 scrollTop - 容器视口位置
      var pageRectC = page.getBoundingClientRect();
      var pageContentTop = pageRectC.top + cont.scrollTop - contRect.top;
      var targetScrollY = pageContentTop + (ratioY * contentH) - (fp.vy - contRect.top);
      var maxScrollY = cont.scrollHeight - cont.clientHeight;
      if (maxScrollY > 0) {
        cont.scrollTop = Math.max(0, Math.min(maxScrollY, targetScrollY));
      }
      // 水平：页面自身滚动（zoom>1 时页宽超出容器，page 是水平滚动容器）
      var targetScrollX = (ratioX * contentW) - (fp.vx - pageRectC.left);
      var maxScrollX = page.scrollWidth - page.clientWidth;
      if (maxScrollX > 0) {
        page.scrollLeft = Math.max(0, Math.min(maxScrollX, targetScrollX));
      }
    } else {
      // 单页模式：page 自身即滚动容器（bk-pdf-zoomed）
      var pageRect = page.getBoundingClientRect();
      var targetScrollX2 = (ratioX * contentW) - (fp.vx - pageRect.left);
      var targetScrollY2 = (ratioY * contentH) - (fp.vy - pageRect.top);
      var maxScrollX2 = page.scrollWidth - page.clientWidth;
      var maxScrollY2 = page.scrollHeight - page.clientHeight;
      if (maxScrollX2 > 0) {
        page.scrollLeft = Math.max(0, Math.min(maxScrollX2, targetScrollX2));
      }
      if (maxScrollY2 > 0) {
        page.scrollTop = Math.max(0, Math.min(maxScrollY2, targetScrollY2));
      }
    }
  }

  // ==================== 双击缩放过渡动画 ====================

  /**
   * 双击缩放过渡：用 CSS transform:scale 实现 220ms 平滑视觉过渡，
   * 过渡结束后**不清 transform**，先触发高清重渲染，
   * 等新 canvas 就绪后再清除 transform（无缝衔接，无闪跳）。
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
      // ★ 不再在此处清 transform！
      // 先调用 onComplete（setZoom + applyZoomToVisible）触发高清重渲染，
      // 等新 canvas 绘制完后再清 transform（由 _clearTransformAfterRender 延迟处理）。
      // 这样过渡视觉 → 新 canvas 出现之间零缝隙，无闪跳。
      _zoomAnimating = false;
      // cleanup 已执行时（_gestureEl 为 null）跳过 onComplete，
      // 避免 onComplete 内用 stale 的 bookId 写入 zoomState 造成 null key 污染
      if (_gestureEl) {
        onComplete();
        // onComplete 触发重渲染后，延迟 2 帧等新 canvas 绘制完成再清 transform
        // 此时新 canvas 已经在 DOM 中，transform 只是视觉缩放了旧 canvas，
        // 清除后新 canvas 立即显现，视觉无跳变
        _scheduleClearTransform(pages, toZoom);
      } else {
        // cleanup 情况：直接清 transform
        _clearTransform(pages, toZoom);
      }
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
   * 延迟清除 transform：等 2 帧（~32ms）让高清 canvas 有时间渲染到屏幕
   * 再清 transform，视觉上无缝切换（新 canvas 直接替代旧缩放图）
   */
  function _scheduleClearTransform(pages, toZoom) {
    (win.requestAnimationFrame || function (cb) { setTimeout(cb, 16); })(function () {
      (win.requestAnimationFrame || function (cb) { setTimeout(cb, 16); })(function () {
        _clearTransform(pages, toZoom);
      });
    });
  }

  /**
   * 清除所有可见页 canvas-wrap 的 transform + transition
   */
  function _clearTransform(pages, toZoom) {
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
  }

  /**
   * 双击缩放公共入口：1x ↔ 2x 切换，带 220ms transform 过渡动画（无缝衔接）
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
    // 记录本次长按起点（供 touchmove 位移超阈值时取消）
    _longPressStart = { x: startX, y: startY };
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

      // 精确选中长按点附近的文本：优先用 caretPositionFromPoint / caretRangeFromPoint
      // 命中文本节点后选中单词，避免之前整段 span 全选的问题
      var targetEl = doc.elementFromPoint(startX, startY);
      if (targetEl && textLayer.contains && textLayer.contains(targetEl)) {
        try {
          var sel = win.getSelection();
          sel.removeAllRanges();
          var caretRange = _caretRangeFromPoint(startX, startY);
          if (caretRange && caretRange.startContainer) {
            var node = caretRange.startContainer;
            var offset = caretRange.startOffset;
            // 命中文本节点：在该节点内做单词级展开，精确选中手指下的单词
            if (node.nodeType === 3) {
              var text = node.nodeValue || '';
              var start = _expandWordStart(text, offset);
              var end = _expandWordEnd(text, offset);
              if (start < end) {
                var range = doc.createRange();
                range.setStart(node, start);
                range.setEnd(node, end);
                sel.addRange(range);
              }
            }
          }
        } catch (err) {}
      }
    }, 500);
  }

  /**
   * 从 caret 偏移向前展开单词边界（含中文：连续非空白字符即视为一个词）
   */
  function _expandWordStart(text, offset) {
    var i = offset;
    while (i > 0) {
      var ch = text.charAt(i - 1);
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') break;
      i--;
    }
    return i;
  }

  /**
   * 从 caret 偏移向后展开单词边界
   */
  function _expandWordEnd(text, offset) {
    var i = offset;
    var len = text.length;
    while (i < len) {
      var ch = text.charAt(i);
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') break;
      i++;
    }
    return i;
  }

  /**
   * 兼容多浏览器的 caret 定位：
   * 优先 document.caretPositionFromPoint（Firefox），回退 caretRangeFromPoint（Chrome/Safari）
   */
  function _caretRangeFromPoint(x, y) {
    if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
    if (doc.caretPositionFromPoint) {
      var pos = doc.caretPositionFromPoint(x, y);
      if (pos) {
        var r = doc.createRange();
        r.setStart(pos.offsetNode, pos.offset);
        return r;
      }
    }
    return null;
  }

  function _cancelLongPress() {
    if (_longPressTimer) {
      clearTimeout(_longPressTimer);
      _longPressTimer = null;
    }
    _longPressStart = null;
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
    _longPressStart = null;
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
