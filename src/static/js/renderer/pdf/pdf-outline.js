/*!
 * pdf-outline.js - PDF 目录抽屉
 *
 * 职责：
 *   - 从 import-pdf.js 已解析的 outline 数据递归生成目录树
 *   - 右侧抽屉展开/收起
 *   - 点击目录条目跳转到对应页
 *   - 无 outline 时按钮置灰
 *
 * 依赖：pdf-state.js, pdf-core.js
 * 数据来源：import-pdf.js 解析 PDF outline 后通过 BKPdf.setOutline(bookId, outline) 注入
 * outline 数据结构：[{ title, dest, pageNumber, children: [...] }]
 * 挂载：window.BKPdf._internal.outline
 */
(function (win) {
  'use strict';

  var doc = win.document;
  var S = win.BKPdf._internal.state;

  // ==================== 状态 ====================

  var _drawer = null;
  var _drawerBody = null;
  var _isVisible = false;
  var _inBackStack = false; // 抽屉是否已注册到 backStack（防双重消耗）

  // ==================== 创建抽屉 ====================

  function _createDrawer() {
    if (_drawer) return _drawer;
    var drawer = doc.createElement('div');
    drawer.className = 'bk-pdf-outline-drawer';
    drawer.innerHTML =
      '<div class="bk-pdf-outline-header">' +
        '<span class="bk-pdf-outline-title">目录</span>' +
        '<button class="bk-pdf-outline-close" aria-label="关闭">✕</button>' +
      '</div>' +
      '<div class="bk-pdf-outline-body"></div>';
    doc.body.appendChild(drawer);

    _drawer = drawer;
    _drawerBody = drawer.querySelector('.bk-pdf-outline-body');

    // 关闭按钮
    var closeBtn = drawer.querySelector('.bk-pdf-outline-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', hide);
    }

    // 遮罩点击关闭
    drawer.addEventListener('click', function (e) {
      if (e.target === drawer) hide();
    });

    return drawer;
  }

  /**
   * 递归渲染 outline 树
   * @param {Array} outline - outline 数据
   * @param {number} level - 当前层级（0=顶级）
   * @returns {string} HTML
   */
  function _renderOutlineTree(outline, level) {
    if (!outline || !outline.length) return '';
    var html = '<ul class="bk-pdf-outline-list' + (level === 0 ? ' bk-pdf-outline-root' : '') + '">';
    for (var i = 0; i < outline.length; i++) {
      var item = outline[i];
      var title = S.escText(item.title || ('第 ' + (i + 1) + ' 项'));
      var pageNum = item.pageNumber || 0;
      var hasChildren = item.children && item.children.length > 0;

      html += '<li class="bk-pdf-outline-item' + (hasChildren ? ' bk-pdf-outline-has-children' : '') + '">';
      if (hasChildren) {
        html += '<button class="bk-pdf-outline-toggle" aria-label="展开">▸</button>';
      }
      html += '<a class="bk-pdf-outline-link" data-pdf-outline-page="' + pageNum + '" href="javascript:void(0)">' + title + '</a>';
      if (hasChildren) {
        html += '<div class="bk-pdf-outline-children" style="display:none">';
        html += _renderOutlineTree(item.children, level + 1);
        html += '</div>';
      }
      html += '</li>';
    }
    html += '</ul>';
    return html;
  }

  /**
   * 填充目录（异步：先确保 outline 数据已从 localforage 加载到内存）
   */
  function _populateOutline() {
    if (!_drawerBody) return;
    var bookId = S.currentBookId();
    if (!bookId) return;

    // 先显示 loading，再异步拉取 outline 数据
    _drawerBody.innerHTML = '<div class="bk-pdf-outline-empty">加载目录中…</div>';

    var outlineLoad = (typeof S.ensureOutlineLoad === 'function')
      ? S.ensureOutlineLoad(bookId)
      : Promise.resolve(S.outline(bookId));

    outlineLoad.then(function () {
      var outline = S.outline(bookId);
      if (!outline || !outline.length) {
        _drawerBody.innerHTML = '<div class="bk-pdf-outline-empty">此 PDF 没有目录书签</div>';
        return;
      }

      _drawerBody.innerHTML = _renderOutlineTree(outline, 0);

      // 绑定点击事件
      var links = _drawerBody.querySelectorAll('.bk-pdf-outline-link');
      for (var i = 0; i < links.length; i++) {
        links[i].addEventListener('click', _onOutlineClick);
      }

      // 绑定展开/收起
      var toggles = _drawerBody.querySelectorAll('.bk-pdf-outline-toggle');
      for (var j = 0; j < toggles.length; j++) {
        toggles[j].addEventListener('click', _onToggleClick);
      }
    }).catch(function () {
      _drawerBody.innerHTML = '<div class="bk-pdf-outline-empty">目录加载失败</div>';
    });
  }

  function _onOutlineClick(e) {
    e.preventDefault();
    var link = e.currentTarget;
    var pageNum = parseInt(link.getAttribute('data-pdf-outline-page'), 10);
    if (pageNum && pageNum > 0) {
      var nav = win.BKPdf._internal.nav;
      if (nav && nav.goToPage) nav.goToPage(pageNum, true);
      hide();
    }
  }

  function _onToggleClick(e) {
    e.stopPropagation();
    var btn = e.currentTarget;
    var li = btn.closest('.bk-pdf-outline-item');
    if (!li) return;
    var children = li.querySelector('.bk-pdf-outline-children');
    if (!children) return;
    var isHidden = children.style.display === 'none';
    children.style.display = isHidden ? '' : 'none';
    btn.textContent = isHidden ? '▾' : '▸';
  }

  // ==================== 展开/收起 ====================

  function toggle() {
    if (_isVisible) hide();
    else show();
  }

  function show() {
    if (_isVisible) return; // 幂等：已显示时不重复 push 回退栈
    _createDrawer();
    _populateOutline();
    if (_drawer) _drawer.classList.add('bk-pdf-outline-visible');
    _isVisible = true;
    S.closeAllDrawersExcept('outline');
    // 注册到 backStack：系统返回键关闭抽屉
    // push 必须放在 closeAllDrawersExcept 之后，避免被互斥关闭的 discard 误 pop 自己刚 push 的条目
    if (win.BK && win.BK.backStack) {
      _inBackStack = true;
      win.BK.backStack.push(function () {
        _inBackStack = false;
        hide();
      });
    }
  }

  function hide() {
    if (!_isVisible) return; // 幂等：未显示时无栈条目可消耗
    if (_drawer) _drawer.classList.remove('bk-pdf-outline-visible');
    _isVisible = false;
    // 主动关闭（按钮/互斥）：消耗对应 history 条目；
    // 系统返回键触发时回调已置 _inBackStack=false，不会走到这里
    if (_inBackStack && win.BK && win.BK.backStack) {
      _inBackStack = false;
      win.BK.backStack.discard();
    }
  }

  function _closeOthers(except) {
    S.closeAllDrawersExcept(except);
  }

  // ==================== init / cleanup ====================

  function init(containerEl, bookId) {
    // 延迟创建，首次 show 时才创建
  }

  function cleanup() {
    if (_drawer && _drawer.parentNode) {
      _drawer.parentNode.removeChild(_drawer);
    }
    _drawer = null;
    _drawerBody = null;
    _isVisible = false;
    // 书籍退出时抽屉可能仍在回退栈上：弹出回调防孤儿条目（不触发 history.back）
    if (_inBackStack && win.BK && win.BK.backStack) {
      _inBackStack = false;
      win.BK.backStack.silentPop();
    }
  }

  // ==================== 导出 ====================

  win.BKPdf._internal.outline = {
    init: init,
    cleanup: cleanup,
    toggle: toggle,
    show: show,
    hide: hide
  };

})(window);
