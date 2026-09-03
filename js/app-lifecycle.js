/*!
 * app-lifecycle.js — 应用前后台生命周期管理器
 *
 * 解决问题：Capacitor / PWA 应用从后台切回前台时白屏、需要点击屏幕才渲染。
 * 根因：Android WebView 切后台时会冻结 GPU 合成层与渲染线程；回前台后浏览器
 * 不会主动 resume 渲染，需要页面侧主动发送「渲染信号」（forced reflow +
 * requestAnimationFrame），并刷新当前可见区域（懒渲染的 IntersectionObserver
 * 不会立即触发回调）。
 *
 * 暴露：window.BK.AppLifecycle
 *   .init()                       自动启动（监听 Capacitor / visibilitychange / pageshow）
 *   .isBackground()               当前是否处于后台状态
 *   .backgroundDuration()         后台持续毫秒数（前台时为 0）
 *   .onBackground(cb)             注册切后台回调，返回 disposer
 *   .onForeground(cb)             注册切前台回调，cb(backgroundMs)，返回 disposer
 *   .registerRefresher(fn, opts)  注册「刷新可见区域」回调，回前台时优先调用
 *                                 fn 签名：fn(backgroundMs:number)
 *                                 opts: { priority?: number, id?: string }
 *   .unregisterRefresher(id)      按 id 移除 refresher
 *
 * 实现要点：
 *  1) 双重监听：Capacitor Plugins.App.appStateChange（原生）+ document.visibilitychange（PWA/浏览器）
 *  2) pageshow/pagehide 兜底：处理 iOS bfcache 场景
 *  3) 前台遮罩：切前台瞬间插入 .bk-resume-mask 盖住 WebView 重建造成的白屏，
 *     100ms 后开始淡出，300ms 后移除；遮罩颜色跟随主题，视觉无突兀
 *  4) 强制渲染信号：opacity 抖动 + offsetWidth 触发 forced reflow，唤醒合成层
 *  5) 分级 refresher：高 priority 先调用（PDF），低 priority 后调用（TTS、下载状态）
 *     refresher 接收 backgroundMs，可据此判断是否需要强制重渲染（如 GPU 纹理回收）
 *  6) 双触发幂等：visibilitychange + appStateChange 可能同时触发，
 *     状态变更与监听器通知始终执行，UI 动作（遮罩/reflow/refresher）防抖去重
 *
 * ★ 与 background-download.js 解耦：本模块只发「生命周期信号」，不干预下载逻辑。
 *   下载管理器可自行 onForeground 重新拉取状态。
 */
(function (win) {
  'use strict';

  var doc = win.document;

  // ==================== 状态 ====================

  var _state = {
    initialized: false,
    background: false,
    backgroundSince: 0,
    lastBackgroundMs: 0,

    // refresher 注册表：[{ id, fn, priority }]
    refreshers: [],
    // onBackground / onForeground 监听器
    bgListeners: [],
    fgListeners: [],

    // Capacitor App listener handle
    appListener: null,
    // 事件监听引用（移除时用）
    visHandler: null,
    pageShowHandler: null,
    pageHideHandler: null,

    // 前台遮罩元素
    resumeMask: null,
    // 防止短时间多次触发
    lastFgTime: 0,
    fgDebounceMs: 300
  };

  // ==================== 工具 ====================

  function _isNative() {
    return !!(win.Capacitor && win.Capacitor.isNativePlatform &&
              win.Capacitor.isNativePlatform());
  }

  function _now() { return Date.now(); }

  /**
   * 取主题色作为遮罩背景，跟随用户当前主题（cool/warm/dark）
   */
  function _getMaskColor() {
    // 与 index.html 顶部 meta[theme-color] 逻辑保持一致
    var theme = 'cool';
    try {
      var t = doc.documentElement.getAttribute('data-theme');
      if (t === 'warm' || t === 'dark' || t === 'cool') theme = t;
    } catch (e) {}
    if (theme === 'warm') return '#F7F2E8';
    if (theme === 'dark') return '#1A1917';
    return '#F5F4F1';
  }

  // ==================== 核心逻辑 ====================

  /**
   * 切到后台：标记状态、保存时间戳、通知监听器
   * 不显示遮罩（让系统前台快照保持显示，遮罩在回前台瞬间才出现）
   */
  function _goBackground() {
    if (_state.background) return; // 已经在后台
    _state.background = true;
    _state.backgroundSince = _now();
    console.log('[AppLifecycle] → 后台');
    // ★ 切后台时主动保存滚动位置和路由状态
    //    避免进程被杀后 300ms debounce 未完成导致滚动位置丢失
    _saveStateOnBackground();
    // 通知 refresher 停止渲染
    _notifyBackground();
  }

  /**
   * 切后台时保存关键状态到 localStorage
   * - 滚动位置：直接调用 saveScrollPosition()，不中断跟踪
   * - 最后路由：确保重启后能恢复到正确页面
   */
  function _saveStateOnBackground() {
    try {
      // 保存滚动位置（renderer-data.js 的 saveScrollPosition，不中断 scroll 跟踪）
      if (win.BKRenderer && win.BKRenderer.saveScrollPosition) {
        win.BKRenderer.saveScrollPosition();
      }
      // 保存最后路由（router.js 的 _saveLastRoute）
      if (win.BKRouter && win.BKRouter.saveCurrentRoute) {
        win.BKRouter.saveCurrentRoute();
      }
    } catch(e) {
      console.warn('[AppLifecycle] 保存后台状态失败:', e && e.message);
    }
  }

  /**
   * 切回前台：核心动作
   *   1) 状态变更 + onForeground 监听器通知（始终执行，避免双触发漏通知）
   *   2) UI 动作防抖：避免 visibilitychange 与 appStateChange 双触发重复执行
   *   3) 插入遮罩盖住 WebView 重建
   *   4) 立刻发送 forced reflow 唤醒合成层
   *   5) rAF 触发 refresher 刷新可见区域（try/finally 保证遮罩一定淡出）
   *   6) 100ms 后淡出遮罩，300ms 后移除
   */
  function _goForeground() {
    if (!_state.background) return; // 本来就在前台

    var now = _now();
    var bgMs = _state.backgroundSince ? (now - _state.backgroundSince) : 0;

    // ── 状态变更：始终执行（无论是否防抖）
    _state.background = false;
    _state.lastBackgroundMs = bgMs;
    _state.backgroundSince = 0;

    // ── 监听器通知：始终执行（双触发场景下第二次通知幂等，但保证不漏）
    //    放在 UI 防抖之前，让依赖状态同步的监听器（如下载进度重拉）拿到正确状态
    _notifyForeground(bgMs);

    // ── UI 动作防抖：只去重 showMask/forceRepaint/runRefreshers
    //    避免双触发时重复创建遮罩、重复 forced reflow
    if (now - _state.lastFgTime < _state.fgDebounceMs) {
      console.log('[AppLifecycle] ← 前台，后台时长 ' + (bgMs / 1000).toFixed(1) + 's（UI 动作防抖忽略）');
      return;
    }
    _state.lastFgTime = now;
    console.log('[AppLifecycle] ← 前台，后台时长 ' + (bgMs / 1000).toFixed(1) + 's');

    // 1) 立即插入遮罩（盖住 WebView 重建过程中的白屏）
    _showResumeMask();

    // 2) 强制渲染信号：唤醒 Android WebView 渲染线程
    //    通过 opacity 抖动 + forced reflow 让合成层重新调度
    _forceRepaint();

    // 3) 下一帧触发 refresher（让 PDF / Carousel 等刷新可见区域）
    //    用 raf 确保在合成层重建完成后再渲染，避免被丢弃
    try {
      (win.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); })(function () {
        // ★ try/finally 兜底：即使 _runRefreshers 整体抛错（含未来扩展代码），
        //   finally 也会保证遮罩淡出，避免遮罩永久停留导致 UI 卡死
        try {
          _runRefreshers(bgMs);
        } catch (e) {
          console.warn('[AppLifecycle] runRefreshers 整体异常:', e && e.message);
        } finally {
          // 4) 200ms 后开始淡出遮罩（让 refresher 有时间渲染首屏，比 100ms 更可靠）
          setTimeout(_fadeoutResumeMask, 200);
        }
      });
    } catch (e) {
      // raf 本身异常兜底：同步触发 + 淡出遮罩
      try { _runRefreshers(bgMs); } catch (e2) {
        console.warn('[AppLifecycle] runRefreshers 兜底异常:', e2 && e2.message);
      }
      setTimeout(_fadeoutResumeMask, 200);
    }
  }

  /**
   * 强制重绘：唤醒 WebView 渲染线程
   * 关键技巧：opacity 抖动 + offsetWidth 读取触发同步布局
   */
  function _forceRepaint() {
    try {
      var body = doc.body;
      var html = doc.documentElement;
      if (!body) return;

      // 操作 1：opacity 微抖动（合成层重新调度）
      body.style.opacity = '0.999';

      // 操作 2：forced reflow（读取 offsetWidth 触发布局同步）
      void body.offsetWidth;
      void html.offsetHeight;

      // 操作 3：下一帧恢复
      (win.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); })(function () {
        body.style.opacity = '';
      });
    } catch (e) {
      console.warn('[AppLifecycle] forceRepaint 失败:', e && e.message);
    }
  }

  // ==================== 前台遮罩 ====================

  function _showResumeMask() {
    // 已存在则不重复创建
    if (_state.resumeMask) return;
    try {
      var mask = doc.createElement('div');
      mask.id = 'bkResumeMask';
      mask.className = 'bk-resume-mask bk-resume-mask-show';
      mask.setAttribute('aria-hidden', 'true');
      mask.style.background = _getMaskColor();
      // 触摸拦截：遮罩存在期间禁止用户交互（避免在视觉未恢复时误触）
      mask.addEventListener('touchstart', function (e) { e.preventDefault(); e.stopPropagation(); }, { passive: false });
      mask.addEventListener('touchmove', function (e) { e.preventDefault(); e.stopPropagation(); }, { passive: false });
      mask.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); }, { passive: false });
      doc.body.appendChild(mask);
      _state.resumeMask = mask;
    } catch (e) {
      console.warn('[AppLifecycle] 遮罩创建失败:', e && e.message);
    }
  }

  function _fadeoutResumeMask() {
    var mask = _state.resumeMask;
    if (!mask) return;
    try {
      mask.classList.remove('bk-resume-mask-show');
      mask.classList.add('bk-resume-mask-fade');
      // 等待 CSS 过渡（200ms）后移除
      setTimeout(function () {
        if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
        if (_state.resumeMask === mask) _state.resumeMask = null;
      }, 250);
    } catch (e) {
      // 兜底：直接移除
      try { if (mask && mask.parentNode) mask.parentNode.removeChild(mask); } catch (e2) {}
      _state.resumeMask = null;
    }
  }

  // ==================== Refresher 注册与执行 ====================

  /**
   * 执行已注册的 refresher，按 priority 降序、同 priority 按注册顺序
   * @param {number} bgMs  后台持续毫秒数（供 refresher 判断是否需要强制重渲染等）
   */
  function _runRefreshers(bgMs) {
    if (!_state.refreshers.length) return;
    // 按 priority 降序排（高优先级先执行），同 priority 按注册顺序
    var list = _state.refreshers.slice().sort(function (a, b) {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.seq - b.seq;
    });
    for (var i = 0; i < list.length; i++) {
      try {
        list[i].fn(bgMs);
      } catch (e) {
        console.warn('[AppLifecycle] refresher "' + list[i].id + '" 异常:', e && e.message);
      }
    }
  }

  var _refresherSeq = 0;
  function registerRefresher(fn, opts) {
    opts = opts || {};
    var id = opts.id || ('refresher-' + (++_refresherSeq));
    // 同 id 先移除
    _state.refreshers = _state.refreshers.filter(function (r) { return r.id !== id; });
    _state.refreshers.push({
      id: id,
      fn: fn,
      priority: typeof opts.priority === 'number' ? opts.priority : 0,
      seq: ++_refresherSeq
    });
    return function () {
      _state.refreshers = _state.refreshers.filter(function (r) { return r.id !== id; });
    };
  }

  function unregisterRefresher(id) {
    _state.refreshers = _state.refreshers.filter(function (r) { return r.id !== id; });
  }

  // ==================== onBackground / onForeground ====================

  function _notifyBackground() {
    for (var i = 0; i < _state.bgListeners.length; i++) {
      try { _state.bgListeners[i](); } catch (e) {
        console.warn('[AppLifecycle] onBackground 监听器异常:', e && e.message);
      }
    }
  }

  function _notifyForeground(bgMs) {
    for (var i = 0; i < _state.fgListeners.length; i++) {
      try { _state.fgListeners[i](bgMs); } catch (e) {
        console.warn('[AppLifecycle] onForeground 监听器异常:', e && e.message);
      }
    }
  }

  function onBackground(cb) {
    _state.bgListeners.push(cb);
    return function () {
      _state.bgListeners = _state.bgListeners.filter(function (fn) { return fn !== cb; });
    };
  }

  function onForeground(cb) {
    _state.fgListeners.push(cb);
    return function () {
      _state.fgListeners = _state.fgListeners.filter(function (fn) { return fn !== cb; });
    };
  }

  // ==================== 事件处理器 ====================

  function _onVisibilityChange() {
    if (doc.visibilityState === 'visible') {
      _goForeground();
    } else if (doc.visibilityState === 'hidden') {
      _goBackground();
    }
  }

  function _onAppStateChange(state) {
    if (state && state.isActive) {
      _goForeground();
    } else {
      _goBackground();
    }
  }

  // bfcache 兜底：iOS WKWebView 切回时可能只触发 pageshow
  function _onPageShow(e) {
    if (e && e.persisted) {
      // 从 bfcache 恢复，等同于回到前台
      _goForeground();
    }
  }

  function _onPageHide(e) {
    if (e && e.persisted) {
      // 进入 bfcache，等同于切到后台
      _goBackground();
    }
  }

  // ==================== 公共 API ====================

  function isBackground() { return _state.background; }
  function backgroundDuration() {
    if (!_state.background) return 0;
    return _now() - _state.backgroundSince;
  }

  /**
   * 启动生命周期管理器
   * - 自动监听 Capacitor / visibilitychange / pageshow
   * - 幂等：多次调用只生效一次
   */
  function init() {
    if (_state.initialized) return;
    _state.initialized = true;

    // Capacitor 原生：App.appStateChange
    if (_isNative() && win.Capacitor && win.Capacitor.Plugins && win.Capacitor.Plugins.App) {
      try {
        var p = win.Capacitor.Plugins.App.addListener('appStateChange', _onAppStateChange);
        if (p && typeof p.then === 'function') {
          p.then(function (h) { _state.appListener = h; })
           .catch(function (e) { console.warn('[AppLifecycle] App listener 注册失败:', e && e.message); });
        } else {
          _state.appListener = p;
        }
      } catch (e) {
        console.warn('[AppLifecycle] Capacitor App 监听失败:', e && e.message);
      }
    }

    // PWA / 浏览器 / WKWebView 兜底
    _state.visHandler = _onVisibilityChange;
    doc.addEventListener('visibilitychange', _state.visHandler);

    // bfcache 兼容
    _state.pageShowHandler = _onPageShow;
    _state.pageHideHandler = _onPageHide;
    win.addEventListener('pageshow', _state.pageShowHandler);
    win.addEventListener('pagehide', _state.pageHideHandler);

    // 初始状态校准：若启动时已在后台（极少见），直接标记
    if (doc.visibilityState === 'hidden') {
      _state.background = true;
      _state.backgroundSince = _now();
    }

    console.log('[AppLifecycle] 已启动 (native=' + _isNative() + ')');
  }

  // ==================== 导出 ====================

  win.BK = win.BK || {};
  win.BK.AppLifecycle = {
    init: init,
    isBackground: isBackground,
    backgroundDuration: backgroundDuration,
    onBackground: onBackground,
    onForeground: onForeground,
    registerRefresher: registerRefresher,
    unregisterRefresher: unregisterRefresher
  };

})(window);
