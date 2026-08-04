/*!
 * pdf-bookmark.js - PDF 用户书签抽屉
 *
 * 职责：
 *   - 用户手动添加/删除的书签（不同于 PDF 内置大纲 outline）
 *   - 右侧抽屉展开/收起（复用 outline 抽屉样式）
 *   - 点击书签跳转到对应页
 *   - 书签数据由 pdf-state.js 管理（localStorage 持久化）
 *
 * 依赖：pdf-state.js, pdf-navigator.js
 * 挂载：window.BKPdf._internal.bookmark
 */
(function (win) {
  'use strict';

  var doc = win.document;
  var S = win.BKPdf._internal.state;

  // ==================== 状态 ====================

  var _drawer = null;
  var _drawerBody = null;
  var _isVisible = false;

  // 编辑对话框
  var _editOverlay = null;
  var _editInput = null;
  var _editingPage = null;

  // ==================== 创建抽屉 ====================

  function _createDrawer() {
    if (_drawer) return _drawer;
    var drawer = doc.createElement('div');
    drawer.className = 'bk-pdf-bookmark-drawer';
    drawer.innerHTML =
      '<div class="bk-pdf-bookmark-header">' +
        '<span class="bk-pdf-bookmark-title">我的书签</span>' +
        '<button class="bk-pdf-bookmark-close" aria-label="关闭">✕</button>' +
      '</div>' +
      '<div class="bk-pdf-bookmark-body"></div>';
    doc.body.appendChild(drawer);

    _drawer = drawer;
    _drawerBody = drawer.querySelector('.bk-pdf-bookmark-body');

    // 关闭按钮
    var closeBtn = drawer.querySelector('.bk-pdf-bookmark-close');
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
   * 填充书签列表
   */
  function _populateBookmarks() {
    if (!_drawerBody) return;
    var bookId = S.currentBookId();
    if (!bookId) return;

    var bookmarks = S.bookmarks(bookId);
    if (!bookmarks || !bookmarks.length) {
      _drawerBody.innerHTML = '<div class="bk-pdf-outline-empty">暂无书签</div>';
      return;
    }

    // 按页码排序
    var sorted = bookmarks.slice().sort(function (a, b) { return a.page - b.page; });

    var html = '<ul class="bk-pdf-outline-list bk-pdf-bookmark-list">';
    for (var i = 0; i < sorted.length; i++) {
      var bm = sorted[i];
      var pageLabel = S.getDisplayPageLabel(bm.page);
      html += '<li class="bk-pdf-outline-item bk-pdf-bookmark-item">';
      html += '<a class="bk-pdf-outline-link bk-pdf-bookmark-link" data-pdf-bm-page="' + bm.page + '" href="javascript:void(0)">';
      html += S.escText(bm.title || ('第 ' + bm.page + ' 页'));
      html += ' <span class="bk-pdf-bookmark-page-num">P' + pageLabel + '</span>';
      html += '</a>';
      html += '<button class="bk-pdf-bookmark-edit" data-pdf-bm-edit="' + bm.page + '" aria-label="编辑书签标题" title="编辑">✎</button>';
      html += '<button class="bk-pdf-bookmark-del" data-pdf-bm-del="' + bm.page + '" aria-label="删除书签" title="删除">✕</button>';
      html += '</li>';
    }
    html += '</ul>';
    _drawerBody.innerHTML = html;

    // 绑定点击跳转
    var links = _drawerBody.querySelectorAll('.bk-pdf-bookmark-link');
    for (var j = 0; j < links.length; j++) {
      links[j].addEventListener('click', _onBookmarkClick);
    }

    // 绑定编辑
    var editBtns = _drawerBody.querySelectorAll('.bk-pdf-bookmark-edit');
    for (var m = 0; m < editBtns.length; m++) {
      editBtns[m].addEventListener('click', _onEditClick);
    }

    // 绑定删除
    var delBtns = _drawerBody.querySelectorAll('.bk-pdf-bookmark-del');
    for (var k = 0; k < delBtns.length; k++) {
      delBtns[k].addEventListener('click', _onDeleteClick);
    }
  }

  function _onBookmarkClick(e) {
    e.preventDefault();
    var link = e.currentTarget;
    var pageNum = parseInt(link.getAttribute('data-pdf-bm-page'), 10);
    if (pageNum && pageNum > 0) {
      var nav = win.BKPdf._internal.nav;
      if (nav && nav.goToPage) nav.goToPage(pageNum, true);
      hide();
    }
  }

  function _onDeleteClick(e) {
    e.stopPropagation();
    var btn = e.currentTarget;
    var pageNum = parseInt(btn.getAttribute('data-pdf-bm-del'), 10);
    var bookId = S.currentBookId();
    if (bookId && pageNum) {
      S.removeBookmark(bookId, pageNum);
      _populateBookmarks(); // 刷新列表
      // 通知 UI 同步书签按钮状态
      _notifyBookmarkChanged();
    }
  }

  // ==================== 书签标题编辑（F4） ====================

  function _onEditClick(e) {
    e.stopPropagation();
    var btn = e.currentTarget;
    var pageNum = parseInt(btn.getAttribute('data-pdf-bm-edit'), 10);
    var bookId = S.currentBookId();
    if (!bookId || !pageNum) return;
    // 查找原标题
    var bookmarks = S.bookmarks(bookId) || [];
    var oldTitle = '';
    for (var i = 0; i < bookmarks.length; i++) {
      if (bookmarks[i].page === pageNum) {
        oldTitle = bookmarks[i].title || ('第 ' + pageNum + ' 页');
        break;
      }
    }
    _showEditDialog(pageNum, oldTitle);
  }

  function _createEditDialog() {
    if (_editOverlay) return _editOverlay;
    var overlay = doc.createElement('div');
    overlay.className = 'bk-pdf-page-jump-overlay bk-pdf-bm-edit-overlay';
    overlay.innerHTML =
      '<div class="bk-pdf-page-jump-dialog bk-pdf-bm-edit-dialog" role="dialog" aria-label="编辑书签标题">' +
        '<div class="bk-pdf-page-jump-title">编辑书签标题</div>' +
        '<input type="text" class="bk-pdf-page-jump-input bk-pdf-bm-edit-input" maxlength="60" placeholder="输入书签标题">' +
        '<div class="bk-pdf-bm-edit-hint">留空则恢复为默认标题</div>' +
        '<div class="bk-pdf-page-jump-actions">' +
          '<button type="button" class="bk-pdf-page-jump-btn bk-pdf-page-jump-cancel">取消</button>' +
          '<button type="button" class="bk-pdf-page-jump-btn bk-pdf-page-jump-go">保存</button>' +
        '</div>' +
      '</div>';
    doc.body.appendChild(overlay);
    _editOverlay = overlay;
    _editInput = overlay.querySelector('.bk-pdf-bm-edit-input');

    var cancelBtn = overlay.querySelector('.bk-pdf-page-jump-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', _hideEditDialog);

    var saveBtn = overlay.querySelector('.bk-pdf-page-jump-go');
    if (saveBtn) saveBtn.addEventListener('click', _doSaveTitle);

    if (_editInput) {
      _editInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          _doSaveTitle();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          _hideEditDialog();
        }
      });
    }

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) _hideEditDialog();
    });
    // 移动端：拦截触摸事件，防止穿透到底层 PDF 页面
    overlay.addEventListener('touchstart', function (e) {
      if (e.target === overlay) { e.preventDefault(); e.stopPropagation(); }
    }, { passive: false });
    overlay.addEventListener('touchmove', function (e) {
      if (e.target === overlay) { e.preventDefault(); e.stopPropagation(); }
    }, { passive: false });

    return overlay;
  }

  function _showEditDialog(page, oldTitle) {
    _createEditDialog();
    if (!_editOverlay) return;
    _editingPage = page;
    if (_editInput) {
      _editInput.value = oldTitle;
    }
    _editOverlay.classList.add('bk-pdf-page-jump-visible');
    setTimeout(function () {
      if (_editInput) {
        _editInput.focus();
        _editInput.select();
      }
    }, 50);
  }

  function _hideEditDialog() {
    if (!_editOverlay) return;
    _editOverlay.classList.remove('bk-pdf-page-jump-visible');
    _editingPage = null;
    if (_editInput) _editInput.blur();
  }

  function _doSaveTitle() {
    if (_editingPage == null || !_editInput) return;
    var bookId = S.currentBookId();
    if (!bookId) return;
    var newTitle = _editInput.value;
    S.setBookmarkTitle(bookId, _editingPage, newTitle);
    _populateBookmarks();
    _hideEditDialog();
  }

  /**
   * 切换当前页书签（添加/删除）
   */
  function toggleCurrentPage() {
    var bookId = S.currentBookId();
    var page = S.currentPage();
    if (!bookId || !page) return;

    if (S.isBookmarked(bookId, page)) {
      S.removeBookmark(bookId, page);
    } else {
      S.addBookmark(bookId, page);
    }
    _notifyBookmarkChanged();
  }

  function _notifyBookmarkChanged() {
    // 通知 ui 模块更新书签按钮状态
    var ui = win.BKPdf._internal.ui;
    if (ui && ui.updateBookmarkBtn) ui.updateBookmarkBtn();
  }

  // ==================== 展开/收起 ====================

  function toggle() {
    if (_isVisible) hide();
    else show();
  }

  function show() {
    _createDrawer();
    _populateBookmarks();
    if (_drawer) _drawer.classList.add('bk-pdf-bookmark-visible');
    _isVisible = true;
    S.closeAllDrawersExcept('bookmark');
  }

  function hide() {
    if (_drawer) _drawer.classList.remove('bk-pdf-bookmark-visible');
    _isVisible = false;
  }

  // _closeOthers 已抽取为公共工具 S.closeAllDrawersExcept

  // ==================== init / cleanup ====================

  function init(containerEl, bookId) {
    // 延迟创建，首次 show 时才创建
  }

  function cleanup() {
    if (_drawer && _drawer.parentNode) {
      _drawer.parentNode.removeChild(_drawer);
    }
    if (_editOverlay && _editOverlay.parentNode) {
      _editOverlay.parentNode.removeChild(_editOverlay);
    }
    _drawer = null;
    _drawerBody = null;
    _editOverlay = null;
    _editInput = null;
    _editingPage = null;
    _isVisible = false;
  }

  // ==================== 导出 ====================

  win.BKPdf._internal.bookmark = {
    init: init,
    cleanup: cleanup,
    toggle: toggle,
    toggleCurrentPage: toggleCurrentPage,
    show: show,
    hide: hide
  };

})(window);
