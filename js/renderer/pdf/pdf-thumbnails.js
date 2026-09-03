/*!
 * pdf-thumbnails.js - PDF 缩略图导航条
 *
 * 职责：
 *   - 底部可展开/收起的缩略图条
 *   - 懒渲染缩略图（IntersectionObserver + 小 scale 0.15）
 *   - 点击缩略图跳转到对应页
 *   - 高亮当前页缩略图
 *   - 5 个并发节流（避免同时渲染大量缩略图）
 *
 * 依赖：pdf-state.js, pdf-core.js
 * 挂载：window.BKPdf._internal.thumbs
 */
(function (win) {
  'use strict';

  var doc = win.document;
  var S = win.BKPdf._internal.state;
  var core = win.BKPdf._internal.core;

  // ==================== 状态 ====================

  var _thumbsBar = null;
  var _thumbsContainer = null;  // 缩略图容器
  var _thumbObserver = null;    // 缩略图懒渲染 Observer
  var _renderingCount = 0;      // 当前正在渲染的缩略图数
  var _renderQueue = [];        // 等待渲染的队列
  var MAX_CONCURRENT = 5;       // 最大并发渲染数
  var THUMB_SCALE = 0.15;       // 缩略图缩放比
  var _isVisible = false;
  var _inBackStack = false; // 抽屉是否已注册到 backStack（防双重消耗）

  // ==================== 创建缩略图条 ====================

  function _createThumbsBar() {
    if (_thumbsBar) return _thumbsBar;
    var bar = doc.createElement('div');
    bar.className = 'bk-pdf-thumbs-bar';
    bar.innerHTML =
      '<div class="bk-pdf-thumbs-header">' +
        '<span class="bk-pdf-thumbs-title">页面缩略图</span>' +
        '<button class="bk-pdf-thumbs-close" aria-label="收起">✕</button>' +
      '</div>' +
      '<div class="bk-pdf-thumbs-container"></div>';
    doc.body.appendChild(bar);

    _thumbsBar = bar;
    _thumbsContainer = bar.querySelector('.bk-pdf-thumbs-container');

    // 关闭按钮
    var closeBtn = bar.querySelector('.bk-pdf-thumbs-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', hide);
    }

    return bar;
  }

  /**
   * 生成缩略图项的 HTML
   */
  function _generateThumbHTML(pageNum, bookId) {
    return '<div class="bk-pdf-thumb" data-pdf-thumb-page="' + pageNum + '" data-pdf-book="' + S.escAttr(bookId) + '">' +
      '<div class="bk-pdf-thumb-canvas-wrap">' +
        '<canvas class="bk-pdf-thumb-canvas"></canvas>' +
      '</div>' +
      '<span class="bk-pdf-thumb-label">' + pageNum + '</span>' +
    '</div>';
  }

  /**
   * 填充缩略图列表
   */
  function _populateThumbs() {
    if (!_thumbsContainer) return;
    var bookId = S.currentBookId();
    if (!bookId) return;

    // 检查是否已填充
    if (_thumbsContainer.children.length > 0) return;

    var totalPages = S.totalPages();
    if (!totalPages) {
      // 从 DOM 获取
      var pages = doc.querySelectorAll('.bk-pdf-page');
      totalPages = pages.length;
      S.setTotalPages(totalPages);
    }

    var html = '';
    for (var i = 1; i <= totalPages; i++) {
      html += _generateThumbHTML(i, bookId);
    }
    _thumbsContainer.innerHTML = html;

    // 创建懒渲染 Observer
    if (_thumbObserver) _thumbObserver.disconnect();
    _thumbObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          _renderThumb(entries[i].target);
          _thumbObserver.unobserve(entries[i].target);
        }
      }
    }, {
      root: _thumbsContainer,
      rootMargin: '100px',
      threshold: 0
    });

    var thumbs = _thumbsContainer.querySelectorAll('.bk-pdf-thumb');
    for (var j = 0; j < thumbs.length; j++) {
      _thumbObserver.observe(thumbs[j]);
      // 点击跳页
      thumbs[j].addEventListener('click', _onThumbClick);
    }
  }

  /**
   * 渲染单个缩略图
   */
  function _renderThumb(thumbEl) {
    var pageNum = parseInt(thumbEl.getAttribute('data-pdf-thumb-page'), 10);
    var bookId = thumbEl.getAttribute('data-pdf-book') || '';
    var canvas = thumbEl.querySelector('.bk-pdf-thumb-canvas');
    if (!canvas || !bookId || !pageNum) return;

    // 入队等待渲染（并发节流）
    _renderQueue.push({ el: thumbEl, pageNum: pageNum, bookId: bookId, canvas: canvas });
    _processQueue();
  }

  function _processQueue() {
    while (_renderQueue.length > 0 && _renderingCount < MAX_CONCURRENT) {
      var item = _renderQueue.shift();
      _renderingCount++;
      _doRenderThumb(item);
    }
  }

  function _doRenderThumb(item) {
    core.getPdfDoc(item.bookId).then(function (pdf) {
      return pdf.getPage(item.pageNum);
    }).then(function (page) {
      var viewport = page.getViewport({ scale: THUMB_SCALE });
      var canvas = item.canvas;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = Math.floor(viewport.width / 2) + 'px';
      canvas.style.height = Math.floor(viewport.height / 2) + 'px';

      var ctx = canvas.getContext('2d', { alpha: false });
      return page.render({
        canvasContext: ctx,
        viewport: viewport
      }).promise;
    }).then(function () {
      item.el.classList.add('bk-pdf-thumb-rendered');
    }).catch(function (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      console.warn('[PDF] 缩略图渲染失败:', item.pageNum, err);
    }).then(function () {
      _renderingCount--;
      _processQueue();
    });
  }

  // ==================== 事件 ====================

  function _onThumbClick(e) {
    var thumb = e.currentTarget;
    var pageNum = parseInt(thumb.getAttribute('data-pdf-thumb-page'), 10);
    if (pageNum) {
      var nav = win.BKPdf._internal.nav;
      if (nav && nav.goToPage) nav.goToPage(pageNum, false);
    }
  }

  /**
   * 高亮当前页缩略图
   */
  function highlightPage(pageNum) {
    if (!_thumbsContainer) return;
    var thumbs = _thumbsContainer.querySelectorAll('.bk-pdf-thumb');
    for (var i = 0; i < thumbs.length; i++) {
      var p = parseInt(thumbs[i].getAttribute('data-pdf-thumb-page'), 10);
      if (p === pageNum) {
        thumbs[i].classList.add('bk-pdf-thumb-active');
      } else {
        thumbs[i].classList.remove('bk-pdf-thumb-active');
      }
    }
    // 滚动到当前缩略图
    var activeThumb = _thumbsContainer.querySelector('.bk-pdf-thumb-active');
    if (activeThumb) {
      activeThumb.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ==================== 展开/收起 ====================

  function toggle() {
    if (_isVisible) hide();
    else show();
  }

  function show() {
    if (_isVisible) return; // 幂等：已显示时不重复 push 回退栈
    _createThumbsBar();
    _populateThumbs();
    if (_thumbsBar) _thumbsBar.classList.add('bk-pdf-thumbs-visible');
    _isVisible = true;
    // 高亮当前页
    highlightPage(S.currentPage());
    // 关闭其他面板
    _closeOthers('thumbs');
    // 注册到 backStack：系统返回键关闭抽屉
    // push 必须放在 closeOthers 之后，避免被互斥关闭的 discard 误 pop 自己刚 push 的条目
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
    if (_thumbsBar) _thumbsBar.classList.remove('bk-pdf-thumbs-visible');
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
    if (_thumbObserver) {
      _thumbObserver.disconnect();
      _thumbObserver = null;
    }
    if (_thumbsBar && _thumbsBar.parentNode) {
      _thumbsBar.parentNode.removeChild(_thumbsBar);
    }
    _thumbsBar = null;
    _thumbsContainer = null;
    _renderQueue = [];
    _renderingCount = 0;
    _isVisible = false;
    // 书籍退出时抽屉可能仍在回退栈上：弹出回调防孤儿条目（不触发 history.back）
    if (_inBackStack && win.BK && win.BK.backStack) {
      _inBackStack = false;
      win.BK.backStack.silentPop();
    }
  }

  // ==================== 导出 ====================

  win.BKPdf._internal.thumbs = {
    init: init,
    cleanup: cleanup,
    toggle: toggle,
    show: show,
    hide: hide,
    highlightPage: highlightPage
  };

})(window);
