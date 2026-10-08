/*!
 * background-download.js — 下载时的后台保活与生命周期兜底
 *
 * 暴露：window.BK.BackgroundDownload
 *   .acquire({ onBackground, onForeground })  下载开始时调用，获取 WakeLock 并注册前后台监听
 *   .release()                                下载结束/取消/出错时调用，释放资源
 *   .isActive()                               当前是否处于激活态
 *
 * 实现：
 *  1. WakeLock（navigator.wakeLock）：保持屏幕常亮，避免 Android WebView 因息屏被系统降频/暂停
 *     - 页面切到后台时 WakeLock 会被系统自动释放，回前台时自动重新获取
 *  2. Capacitor App.appStateChange：原生层前后台切换事件，切后台时记录时间戳，
 *     回前台时通过 onForeground(backgroundMs) 通知调用方，让 UI 重同步进度
 *  3. visibilitychange：PWA / 浏览器环境兜底
 *
 * ★ 与 search.js / renderer-city-helpers.js 解耦：只暴露生命周期信号，
 *   不干预下载逻辑本身。下载切后台时 Promise 链仍可运行（WebView JS 在一定时间内不会被冻结），
 *   回前台时 UI 通过 getDownloadStatus() 重新拉取最新进度即可。
 */
(function () {
  'use strict';
  var win = window;
  var _state = {
    active: false,
    wakeLock: null,
    appListener: null,
    visListener: null,
    backgroundSince: 0,
    onBackgroundCb: null,
    onForegroundCb: null
  };

  function _isNative() {
    return !!(win.Capacitor && win.Capacitor.isNativePlatform &&
              win.Capacitor.isNativePlatform());
  }

  function _requestWakeLock() {
    // 只有 web WakeLock API 可用时才走（Android WebView 9+ / Chrome 84+ / Safari 16.4+）
    if (!('wakeLock' in navigator)) {
      console.log('[BGDownload] navigator.wakeLock 不可用，跳过 WakeLock');
      return Promise.resolve();
    }
    return navigator.wakeLock.request('screen')
      .then(function (wl) {
        _state.wakeLock = wl;
        console.log('[BGDownload] WakeLock 已获取（screen）');
      })
      .catch(function (err) {
        // 常见失败：用户尚未与页面交互、屏幕已锁、隐私模式
        // 不阻塞下载流程，仅记录告警
        console.warn('[BGDownload] WakeLock 获取失败:', err && err.message);
      });
  }

  function _releaseWakeLock() {
    if (_state.wakeLock) {
      try { _state.wakeLock.release(); } catch (e) {}
      _state.wakeLock = null;
    }
  }

  // 页面回前台时 WakeLock 已被系统自动释放，需要重新获取
  function _reacquireWakeLock() {
    if (_state.active && !_state.wakeLock) {
      _requestWakeLock();
    }
  }

  function _handleGoBackground() {
    _state.backgroundSince = Date.now();
    console.log('[BGDownload] App 进入后台');
    if (typeof _state.onBackgroundCb === 'function') {
      try { _state.onBackgroundCb(); } catch (e) {}
    }
  }

  function _handleGoForeground() {
    var bgMs = _state.backgroundSince ? (Date.now() - _state.backgroundSince) : 0;
    _state.backgroundSince = 0;
    console.log('[BGDownload] App 回到前台，后台时长 ' + (bgMs / 1000).toFixed(1) + 's');
    _reacquireWakeLock();
    if (typeof _state.onForegroundCb === 'function') {
      try { _state.onForegroundCb(bgMs); } catch (e) {}
    }
  }

  // visibilitychange 回调（PWA / 浏览器兜底）
  function _onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      if (_state.backgroundSince) _handleGoForeground();
    } else {
      _handleGoBackground();
    }
  }

  // Capacitor App.appStateChange 回调（原生层）
  function _onAppStateChange(state) {
    if (state && state.isActive) {
      _handleGoForeground();
    } else {
      _handleGoBackground();
    }
  }

  /**
   * 激活后台保活
   * @param {object} [opts]
   * @param {function} [opts.onBackground]  切到后台时调用（无参）
   * @param {function} [opts.onForeground]  回到前台时调用 (backgroundMs: number)
   */
  function acquire(opts) {
    if (_state.active) return;
    opts = opts || {};
    _state.active = true;
    _state.onBackgroundCb = opts.onBackground || null;
    _state.onForegroundCb = opts.onForeground || null;

    _requestWakeLock();

    // 原生 App：监听 Capacitor App 插件的 appStateChange 事件
    if (_isNative() && win.Capacitor.Plugins && win.Capacitor.Plugins.App) {
      var p = win.Capacitor.Plugins.App.addListener('appStateChange', _onAppStateChange);
      if (p && typeof p.then === 'function') {
        p.then(function (h) { _state.appListener = h; })
         .catch(function (e) { console.warn('[BGDownload] App listener 注册失败:', e && e.message); });
      } else {
        // 旧版 Capacitor 同步返回 PluginListenerHandle
        _state.appListener = p;
      }
    }

    // PWA / 浏览器兜底
    document.addEventListener('visibilitychange', _onVisibilityChange);
  }

  /**
   * 释放资源（下载结束/取消/出错时调用）
   */
  function release() {
    if (!_state.active) return;
    _state.active = false;
    _releaseWakeLock();

    if (_state.appListener) {
      try { _state.appListener.remove(); } catch (e) {}
      _state.appListener = null;
    }
    document.removeEventListener('visibilitychange', _onVisibilityChange);
    _state.onBackgroundCb = null;
    _state.onForegroundCb = null;
    _state.backgroundSince = 0;
    console.log('[BGDownload] 已释放');
  }

  function isActive() {
    return _state.active;
  }

  win.BK = win.BK || {};
  win.BK.BackgroundDownload = {
    acquire: acquire,
    release: release,
    isActive: isActive,
    isNative: _isNative
  };
})();
