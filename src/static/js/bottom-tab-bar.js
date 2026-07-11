/**
 * bottom-tab-bar.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 常驻底部 4-Tab 导航栏（Soft Nordic 设计语言）
 *
 * 仅在「浏览顶层视图」显示：
 *   - #homeView 可见、#app 隐藏（即未进入阅读 / 目录）
 *   - 当前 hash 为 '#/' 或空
 *   - 没有任何 overlay / dialog 打开（搜索、书签、主题面板、目录抽屉、安装遮罩、伪装维护页等）
 *
 * 进入阅读 / 目录（#app 显示）或任何 overlay 打开时自动隐藏。
 * 显隐逻辑完全自管理（与 nav-stack.js 的浮动栏同样模式），不依赖其他模块调用。
 *
 * 4 个 Tab：
 *   书架  → window._bkShowHome() + BKRouter.navigateReplace('')（保持 hash 为 '#/'）
 *   搜索  → window.BKSearch.open()
 *   书签  → window.BKBookmark.showList()
 *   我的  → window.toggleThemePanel()
 *
 * 视觉：白色胶囊，border-radius:31px，1px solid var(--border)，无 box-shadow，
 *       仅使用 Soft Nordic 设计令牌（无蓝 / 靛蓝）。
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function (win, doc) {
  'use strict';

  var BAR_ID = 'bkBottomTabBar';
  var ACTIVE_TAB = 'city'; // 默认高亮：书城（首页）

  // 内联 SVG 图标（currentColor，随 active / inactive 自动变色）
  var ICONS = {
    city:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 5a2 2 0 0 1 2-2h5v16H6a2 2 0 0 0-2 2V5Z"/>' +
      '<path d="M20 5a2 2 0 0 0-2-2h-5v16h5a2 2 0 0 1 2 2V5Z"/></svg>',
    search:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    bookmark:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/></svg>',
    mine:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>',
    shelf:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 4h18"/><path d="M3 12h18"/><path d="M3 20h18"/>' +
      '<path d="M6 4v16"/><path d="M12 4v16"/><path d="M18 4v16"/></svg>'
  };

  var TABS = [
    { key: 'city', label: '书城' },
    { key: 'search', label: '搜索' },
    { key: 'bookmark', label: '书签' },
    { key: 'mine', label: '我的' },
    { key: 'shelf', label: '书架' }
  ];

  var _bar = null;
  var _raf = 0;

  // ── 构建 DOM ─────────────────────────────────────────────────────────────
  function buildBar() {
    if (doc.getElementById(BAR_ID)) return doc.getElementById(BAR_ID);

    var bar = doc.createElement('div');
    bar.id = BAR_ID;
    bar.className = 'bk-bottom-tab-bar';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', '主导航');

    var html = '';
    for (var i = 0; i < TABS.length; i++) {
      var t = TABS[i];
      var active = t.key === ACTIVE_TAB;
      html +=
        '<button type="button" class="bk-tab' + (active ? ' is-active' : '') + '"' +
        ' data-tab="' + t.key + '" role="tab" aria-selected="' + (active ? 'true' : 'false') + '">' +
        '<span class="bk-tab-icon">' + (ICONS[t.key] || '') + '</span>' +
        '<span class="bk-tab-label">' + t.label + '</span>' +
        '</button>';
    }
    bar.innerHTML = html;
    doc.body.appendChild(bar);

    bar.addEventListener('click', onBarClick);
    return bar;
  }

  // ── Tab 点击处理 ──────────────────────────────────────────────────────────
  function onBarClick(e) {
    var btn = closestTab(e.target);
    if (!btn) return;
    var tab = btn.getAttribute('data-tab');
    setActive(tab); // 视觉反馈（overlay 类 Tab 会立即隐藏，无副作用）
    handleTab(tab);
  }

  function closestTab(node) {
    var el = node;
    while (el && el !== _bar) {
      if (el.classList && el.classList.contains('bk-tab')) return el;
      el = el.parentElement;
    }
    return null;
  }

  function handleTab(tab) {
    switch (tab) {
      case 'city':
        // 回到浏览顶层（书城 = 原「书架」指向的系列分组首页）：显示 homeView 并将 hash 归位为 '#/'
        if (typeof win._bkShowHome === 'function') win._bkShowHome();
        if (win.BKRouter && typeof win.BKRouter.navigateReplace === 'function') {
          win.BKRouter.navigateReplace('');
        } else if (win.BKRouter && typeof win.BKRouter.navigate === 'function') {
          win.BKRouter.navigate('');
        }
        break;
      case 'shelf':
        // 进入书架模块（新路由 #/shelf）
        if (win.BKRouter) win.BKRouter.navigate('shelf');
        break;
      case 'search':
        if (win.BKSearch && typeof win.BKSearch.open === 'function') win.BKSearch.open();
        break;
      case 'bookmark':
        if (win.BKBookmark && typeof win.BKBookmark.showList === 'function') win.BKBookmark.showList();
        break;
      case 'mine':
        // 路由到 #/me（平板双栏）或 #/my（手机单栏）
        if (win.BKRouter) {
          var route = (win.matchMedia && win.matchMedia('(min-width: 768px)').matches) ? 'me' : 'my';
          win.BKRouter.navigate(route);
        }
        break;
    }
  }

  function setActive(tab) {
    if (!_bar) return;
    var btns = _bar.querySelectorAll('.bk-tab');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-tab') === tab;
      btns[i].classList.toggle('is-active', on);
      btns[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  // ── 显隐判定 ──────────────────────────────────────────────────────────────
  function anyOverlayOpen() {
    // 通用对话框遮罩（书签、管理面板、各类子对话框等，均经 BK.openDialog 创建）
    if (doc.querySelector('.bk-dialog-mask')) return true;
    // 搜索浮层
    if (doc.querySelector('.bk-search-overlay')) return true;
    // 主题 / 设置面板
    var tp = doc.getElementById('themePanel');
    if (tp && tp.classList.contains('show')) return true;
    var tpo = doc.getElementById('themePanelOverlay');
    if (tpo && tpo.classList.contains('show')) return true;
    // 目录抽屉
    if (doc.querySelector('.bk-toc-drawer.open')) return true;
    if (doc.querySelector('.bk-toc-drawer-overlay.open')) return true;
    // 安装遮罩
    if (doc.getElementById('bkInstallMask')) return true;
    // 伪装维护页（html.bk-disguise 时 #bkMaintenance 显示）
    if (doc.documentElement.classList.contains('bk-disguise')) return true;
    return false;
  }

  function isBrowseTopLevel() {
    if (anyOverlayOpen()) return false;
    var hash = win.location.hash || '';
    // 首页（#homeView 可见、#app 隐藏）
    if (hash === '' || hash === '#' || hash === '#/') {
      var home = doc.getElementById('homeView');
      var app = doc.getElementById('app');
      if (!home || !app) return false;
      return win.getComputedStyle(home).display !== 'none' &&
             win.getComputedStyle(app).display === 'none';
    }
    // 我的整页（#/my 手机 / #/me 平板）、书签整页（#/bookmarks）、书架整页（#/shelf）→ 浏览顶层，显示底栏
    if (hash === '#/my' || hash === '#/me' || hash === '#/bookmarks' || hash === '#/shelf') {
      return true;
    }
    // 设置整页（#/settings）→ 子级页面，隐藏底栏
    return false;
  }

  function sync() {
    if (_raf) return;
    _raf = win.requestAnimationFrame(function () {
      _raf = 0;
      if (!_bar) return;
      if (isBrowseTopLevel()) {
        _bar.classList.add('is-visible');
        // 根据 hash 高亮 Tab
        var hash = win.location.hash || '';
        if (hash === '#/me' || hash === '#/my') setActive('mine');
        else if (hash === '#/bookmarks') setActive('bookmark');
        else if (hash === '#/shelf') setActive('shelf');
        else setActive('city');
      } else {
        _bar.classList.remove('is-visible');
      }
    });
  }

  // ── 初始化 ────────────────────────────────────────────────────────────────
  function init() {
    _bar = buildBar();
    // 路由变化
    win.addEventListener('hashchange', sync);
    win.addEventListener('popstate', sync);
    // DOM 变化（对话框 / 浮层 / 目录抽屉 / 主题面板 / 伪装 / 安装遮罩）
    if (typeof win.MutationObserver === 'function') {
      var mo = new win.MutationObserver(sync);
      mo.observe(doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
    }
    sync();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window, document);
