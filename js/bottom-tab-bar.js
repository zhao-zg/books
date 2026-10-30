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
 * 4 个 Tab（书签已从底栏移除，改由「我的 › 我的书签」进入）：
 *   书架  → window.BKRouter.navigate('shelf')（首屏默认，排在左一）
 *   书城  → window.BKRouter.navigate('city')
 *   搜索  → window.BKSearch.open()
 *   我的  → #/me（平板双栏）或 #/my（手机单栏）
 *
 * 视觉：白色胶囊，border-radius:31px，1px solid var(--border)，无 box-shadow，
 *       仅使用 Soft Nordic 设计令牌（无蓝 / 靛蓝）。
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function (win, doc) {
  'use strict';

  var BAR_ID = 'bkBottomTabBar';
  var ACTIVE_TAB = 'shelf'; // 决策④：首屏为书架，默认高亮 shelf

  // 内联 SVG 图标（currentColor，随 active / inactive 自动变色）
  var ICONS = {
    city:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 5a2 2 0 0 1 2-2h5v16H6a2 2 0 0 0-2 2V5Z"/>' +
      '<path d="M20 5a2 2 0 0 0-2-2h-5v16h5a2 2 0 0 1 2 2V5Z"/></svg>',
    search:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    mine:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>' +
      '<circle cx="12" cy="7" r="4"/></svg>',
    shelf:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 4h18"/><path d="M3 12h18"/><path d="M3 20h18"/>' +
      '<path d="M6 4v16"/><path d="M12 4v16"/><path d="M18 4v16"/></svg>'
  };

  var TABS = [
    { key: 'shelf', label: '书架' },
    { key: 'city', label: '书城' },
    { key: 'search', label: '搜索' },
    { key: 'mine', label: '我的' }
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
        // 决策①：进入书城（#/city 单路由，三级下钻走模块状态机）
        if (win.BKRouter && typeof win.BKRouter.navigate === 'function') {
          win.BKRouter.navigate('city');
        }
        break;
      case 'shelf':
        // 进入书架模块（新路由 #/shelf）
        if (win.BKRouter) win.BKRouter.navigate('shelf');
        break;
      case 'search':
        if (win.BKSearch && typeof win.BKSearch.open === 'function') win.BKSearch.open();
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
    // 书架长按操作菜单（底部 sheet）：打开时隐藏底部 Tab 栏，避免遮挡内容
    if (doc.querySelector('.bk-shelf-quick-mask')) return true;
    // 书架编辑（多选）态：底部编辑工具条接管，隐藏 Tab 栏
    if (doc.querySelector('.bk-shelf-page.is-editing')) return true;
    // 搜索浮层（close 时仅 display:none，需检查可见性）
    var searchOverlay = doc.querySelector('.bk-search-overlay');
    if (searchOverlay && win.getComputedStyle(searchOverlay).display !== 'none') return true;
    // 主题 / 设置面板（已由 BK.openDialog 统一管理，.bk-dialog-mask 已覆盖）
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
    // 我的整页（#/my 手机 / #/me 平板）、书架整页（#/shelf）、
    // 书城整页（#/city，含三级下钻子页，均同 hash）→ 浏览顶层，显示底栏
    if (hash === '#/my' || hash === '#/me' || hash === '#/shelf' || hash === '#/city') {
      return true;
    }
    // 其他子级页面（#/bookmarks、阅读视图等）→ 隐藏底栏
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
        else if (hash === '#/shelf') setActive('shelf');
        else if (hash === '#/city') setActive('city');
        else setActive(ACTIVE_TAB);
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
