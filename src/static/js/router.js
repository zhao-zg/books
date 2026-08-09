/*!
 * router.js — SPA hash 路由
 * Hash 格式：
 *   #/                    → 首页（书籍列表）
 *   #/{book-id}           → 章节列表（目录）
 *   #/{book-id}/{chapter} → 阅读视图
 *   #/my                  → 我的（个人中心，手机）
 *   #/me                  → 我的（个人中心，平板）
 *   #/bookmarks           → 书签列表
 *
 * 暴露：window.BKRouter
 *   .start()
 *   .navigate(hashPath)        e.g. navigate('my-book') or navigate('my-book/3')
 *   .navigateReplace(hashPath) 同 navigate，但用 replaceState（不新增历史条目）
 *   .back()
 */
(function (win) {
  'use strict';

  var _started = false;
  var _skipNextDispatch = false;

  /**
   * 保存最后路由到 localStorage
   * 应用重启时可用于恢复上次退出时的页面
   */
  function _saveLastRoute(path) {
    try { localStorage.setItem('bk_last_route', path || ''); } catch(e) {}
  }

  /**
   * 获取保存的最后路由
   * 仅在启动时 hash 为空（未指定深链）时使用
   */
  function _getLastRoute() {
    try { return localStorage.getItem('bk_last_route') || ''; } catch(e) { return ''; }
  }

  function getPath() {
    var h = win.location.hash || '#/';
    var raw = h.replace(/^#\/?/, '');
    // ★ decode 解码 URL 编码的中文 bookId（如 bundle-内置书库::阅读的艺术）
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
  }

  function dispatch(path) {
    var parts = path.split('/').filter(Boolean);
    win.__bkCurrentPath = path;
    // ★ 保存最后路由到 localStorage，应用重启后可恢复
    _saveLastRoute(path);
    // 路由切换时关闭搜索面板（skipHistory: 导航已在进行中，不需要 history.back()）
    if (win.BKSearch && win.BKSearch.close) {
      try { win.BKSearch.close(true); } catch (e) {}
    }
    // 通知页面变化（MarkPanel 等组件可监听此事件刷新状态）
    try { document.dispatchEvent(new CustomEvent('reader-page-change', { detail: { path: path } })); } catch (e) {}
    var R = win.BKRenderer;
    console.log('[Router] dispatch path="' + path + '" parts=' + JSON.stringify(parts) + ' BKRenderer=' + (R ? 'ok' : 'NULL'));
    if (!R) { console.warn('[Router] BKRenderer 未就绪，dispatch 中止'); return; }
    win.scrollTo(0, 0);
    if (parts.length === 0) {
      // 决策④：首屏落地书架（#/shelf）。归一到 #/shelf 让底栏 hash 显隐逻辑一致。
      if (win.BKRouter && win.BKRouter.navigateReplace) {
        win.BKRouter.navigateReplace('shelf');
      } else {
        R.renderShelfPage();
      }
    } else if (parts.length === 1 && (parts[0] === 'me' || parts[0] === 'my')) {
      // me=平板(双栏) / my=手机(单栏)，都是 renderMyPage
      R.renderMyPage();
    } else if (parts.length === 1 && parts[0] === 'shelf') {
      R.renderShelfPage();
    } else if (parts.length === 1 && parts[0] === 'city') {
      // 决策①：书城入口（分类→系列→书籍 三级下钻，#/city 单路由 + 模块状态机）
      R.renderCityPage();
    } else if (parts.length === 1) {
      R.renderChapterList(parts[0]);
    } else if (parts.length === 2 && parts[0] === 'series') {
      // 决策：#/series/<id> 为系列书籍列表（书城三级下钻的独立深链）。
      // 必须早于通用 2 段路由（否则会被当成 书籍/<章节> 阅读视图 → loadBook 失败）。
      R.renderSeriesPage(parts[1]);
    } else if (parts.length === 2) {
      R.renderReadingView(parts[0], parseInt(parts[1], 10));
    } else {
      R.renderHome();
    }
  }

  function onHashChange() {
    console.log('[Router] hashchange hash="' + win.location.hash + '" __bkExiting=' + !!win.__bkExiting);
    // ★ __bkExiting 不再阻断路由分发：
    //    退出流程的 history.back() 会回退历史栈中的正向导航条目，
    //    如果拦截 hashchange，页面会卡死在中间状态。
    //    退出防重入由 handleBackCommon 的 __bkHandlingBack + 50ms 防抖保障。
    if (_skipNextDispatch) {
      _skipNextDispatch = false;
      console.log('[Router] hashchange skipped (ghost entry)');
      return;
    }
    dispatch(getPath());
  }

  var Router = {
    start: function () {
      if (_started) return;
      _started = true;
      win.addEventListener('hashchange', onHashChange);
      console.log('[Router] start() initialHash="' + win.location.hash + '"');

      // ★ 启动路由恢复：若 URL hash 为空（未指定深链），恢复上次退出时的页面
      var initialPath = getPath();
      if (!initialPath) {
        var saved = _getLastRoute();
        if (saved) {
          // ★ 降级：最后路由是"我的"时，恢复到书架而非"我的"
          var savedRoute = saved.split('/')[0];
          if (savedRoute === 'my' || savedRoute === 'me') {
            console.log('[Router] 最后路由是"我的"，降级恢复至书架');
            saved = 'shelf';
          }
          console.log('[Router] 恢复上次路由: "' + saved + '"');
          // 用 replaceState 恢复 URL，不新增历史条目
          try { win.history.replaceState(null, '', win.location.pathname + '#/' + saved); } catch(e) {}
          initialPath = saved;
        }
      }
      dispatch(initialPath);
    },

    navigate: function (hashPath) {
      win.__bkExiting = false;
      var newHash = '#/' + (hashPath || '');
      console.log('[Router] navigate("' + hashPath + '") curHash="' + win.location.hash + '" → newHash="' + newHash + '"');
      if (win.location.hash === newHash) {
        dispatch(hashPath || '');
        return;
      }
      // 判断是否为同一本书内的章节切换
      var curParts = (win.__bkCurrentPath || '').split('/').filter(Boolean);
      var newParts = (hashPath || '').split('/').filter(Boolean);
      var isSameBookChapterSwitch = (
        curParts.length === 2 && newParts.length === 2 &&
        curParts[0] === newParts[0]
      );
      if (isSameBookChapterSwitch) {
        // 同书章节切换：replaceState 不触发 popstate / hashchange，需手动 dispatch
        try { win.history.replaceState(null, '', win.location.pathname + newHash); } catch(e) {}
        dispatch(hashPath || '');
      } else {
        // 跨层级跳转
        if (win.BK && win.BK.backStack && win.BK.backStack.skipNext) win.BK.backStack.skipNext();
        // ★ 标记正向导航进行中，防止 PWA 场景下 popstate 误触发 backStack fallback
        //    back-stack.js 的 popstate 监听器会消费此标记并跳过 fallback
        //    安全网：5秒后自动清除，防止标记永远残留
        win.__bkForwardNavPending = true;
        win.__bkForwardNavTs = Date.now();
        setTimeout(function() {
          if (win.__bkForwardNavPending && win.__bkForwardNavTs && (Date.now() - win.__bkForwardNavTs >= 5000)) {
            win.__bkForwardNavPending = false;
          }
        }, 5000);
        win.location.hash = newHash;
      }
    },

    back: function () {
      win.history.back();
    },

    navigateReplace: function (hashPath) {
      win.__bkExiting = false;
      var newHash = '#/' + (hashPath || '');
      console.log('[Router] navigateReplace("' + hashPath + '") curHash="' + win.location.hash + '" → newHash="' + newHash + '"');
      _skipNextDispatch = true;
      try { win.history.replaceState(null, '', win.location.pathname + newHash); } catch(e) {}
      dispatch(hashPath || '');
      setTimeout(function() { _skipNextDispatch = false; }, 0);
    },

    skipNextDispatch: function() { _skipNextDispatch = true; },

    currentPath: function () {
      return getPath();
    },

    /** 保存当前路由到 localStorage（供 AppLifecycle 切后台时调用） */
    saveCurrentRoute: function () {
      _saveLastRoute(win.__bkCurrentPath || getPath());
    }
  };

  win.BKRouter = Router;

}(window));
