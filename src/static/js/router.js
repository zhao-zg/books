/*!
 * router.js — SPA hash 路由
 * Hash 格式：
 *   #/                    → 首页（书籍列表）
 *   #/{book-id}           → 章节列表（目录）
 *   #/{book-id}/{chapter} → 阅读视图
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

  function getPath() {
    var h = win.location.hash || '#/';
    return h.replace(/^#\/?/, '');
  }

  function dispatch(path) {
    var parts = path.split('/').filter(Boolean);
    win.__bkCurrentPath = path;
    var R = win.BKRenderer;
    console.log('[Router] dispatch path="' + path + '" parts=' + JSON.stringify(parts) + ' BKRenderer=' + (R ? 'ok' : 'NULL'));
    if (!R) { console.warn('[Router] BKRenderer 未就绪，dispatch 中止'); return; }
    win.scrollTo(0, 0);
    if (parts.length === 0) {
      R.renderHome();
    } else if (parts.length === 1) {
      R.renderChapterList(parts[0]);
    } else if (parts.length === 2) {
      R.renderReadingView(parts[0], parseInt(parts[1], 10));
    } else {
      R.renderHome();
    }
  }

  function onHashChange() {
    console.log('[Router] hashchange hash="' + win.location.hash + '" __bkExiting=' + !!win.__bkExiting);
    if (win.__bkExiting) return;
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
      dispatch(getPath());
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
    }
  };

  win.BKRouter = Router;

}(window));
