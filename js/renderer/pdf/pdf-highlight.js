/*!
 * pdf-highlight.js - PDF 文本高亮标注
 *
 * 职责：
 *   - 监听文本选中，弹出操作面板（高亮/复制/批注）
 *   - 在 text layer 上渲染高亮矩形（CSS 绝对定位 div）
 *   - 高亮数据由 pdf-state.js 管理（localStorage 持久化）
 *   - 高亮列表抽屉（查看/删除所有高亮）
 *
 * 依赖：pdf-state.js, pdf-core.js, pdf-navigator.js
 * 挂载：window.BKPdf._internal.highlight
 */
(function (win) {
  'use strict';

  var doc = win.document;
  var S = win.BKPdf._internal.state;

  // ==================== 状态 ====================

  var _actionPanel = null;
  var _actionInBackStack = false; // 操作面板是否已注册到 backStack（防双重消耗）
  var _currentSelection = null; // { page, text, rects }
  var _highlightOverlays = {};  // pageNum → [div elements]（以页码为 key，避免 DOM 元素回收后引用失效）
  var _pendingRenderPages = {};  // pageNum → true（textLayer 尚未就绪时暂存，待渲染完成后补渲）
  var _highlightColor = 'yellow'; // 当前选中颜色
  var _drawer = null;
  var _drawerBody = null;
  var _drawerVisible = false;
  var _drawerInBackStack = false; // 抽屉是否已注册到 backStack（防双重消耗）
  var _pageObserver = null; // MutationObserver 引用（防止内存泄漏）

  // ==================== 文本选中监听 ====================

  function init(containerEl, bookId) {
    // 普通模式：监听所有 text layer 的 mouseup/touchend
    var textLayers = containerEl.querySelectorAll('.bk-pdf-text-layer');
    for (var i = 0; i < textLayers.length; i++) {
      _bindTextLayer(textLayers[i], bookId);
    }
    // 也监听后续渲染的页面（通过 MutationObserver）
    // Reflow 模式不需要 observer：没有 .bk-pdf-text-layer 子元素会被动态添加
    if (!_isReflowMode()) {
      _observeNewPages(containerEl, bookId);
    }

    // Reflow 模式：监听 Reflow 容器（选取文字 → 弹标注菜单 → 新建标注）
    var reflowEl = (containerEl.id === 'bkPdfReflowView')
      ? containerEl
      : containerEl.querySelector('#bkPdfReflowView');
    if (reflowEl) {
      _bindReflowContainer(reflowEl, bookId);
    }
  }

  /**
   * Reflow 模式下是否处于激活状态
   */
  function _isReflowMode() {
    return S.mode() === S.MODE_REFLOW;
  }

  /**
   * Reflow 模式下刷新标注渲染（重建 Reflow HTML 以触发文本匹配）
   */
  function _refreshReflowAnnotations() {
    var reflow = win.BKPdf._internal.reflow;
    if (reflow && reflow.refreshAnnotations) reflow.refreshAnnotations();
  }

  /**
   * 绑定 Reflow 容器的选取监听
   * Reflow 段落是真实 DOM 文本，mouseup/touchend 后检查 selection
   */
  function _bindReflowContainer(reflowEl, bookId) {
    reflowEl.addEventListener('mouseup', function () {
      setTimeout(function () { _checkSelection(reflowEl, bookId); }, 50);
    });
    reflowEl.addEventListener('touchend', function () {
      setTimeout(function () { _checkSelection(reflowEl, bookId); }, 150);
    });
  }

  function _bindTextLayer(textLayerEl, bookId) {
    textLayerEl.addEventListener('mouseup', function (e) {
      setTimeout(function () { _checkSelection(textLayerEl, bookId); }, 50);
    });
    textLayerEl.addEventListener('touchend', function (e) {
      setTimeout(function () { _checkSelection(textLayerEl, bookId); }, 150);
    });
  }

  function _observeNewPages(containerEl, bookId) {
    // 先断开旧 observer（防止模式切换/换书时累积泄漏）
    if (_pageObserver) _pageObserver.disconnect();
    _pageObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        for (var j = 0; j < mutations[i].addedNodes.length; j++) {
          var node = mutations[i].addedNodes[j];
          if (node.nodeType === 1) {
            var tls = node.querySelectorAll ? node.querySelectorAll('.bk-pdf-text-layer') : [];
            for (var k = 0; k < tls.length; k++) {
              _bindTextLayer(tls[k], bookId);
            }
            if (node.classList && node.classList.contains('bk-pdf-text-layer')) {
              _bindTextLayer(node, bookId);
            }
          }
        }
      }
    });
    _pageObserver.observe(containerEl, { childList: true, subtree: true });
  }

  function _checkSelection(containerEl, bookId) {
    var sel = win.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      _hideActionPanel();
      _currentSelection = null;
      return;
    }

    var text = sel.toString().trim();
    if (!text) return;

    // === Reflow 模式分支 ===
    // Reflow 段落带 data-reflow-page 属性，向上 closest 可拿到页码
    if (_isReflowMode()) {
      var range = sel.getRangeAt(0);
      var startNode = range.startContainer;
      var endNode = range.endContainer;
      var startEl = (startNode.nodeType === 1) ? startNode : startNode.parentNode;
      var endEl = (endNode.nodeType === 1) ? endNode : endNode.parentNode;
      var reflowPara = startEl.closest ? startEl.closest('[data-reflow-page]') : null;
      var endPara = endEl.closest ? endEl.closest('[data-reflow-page]') : null;
      // 页码分隔符不参与标注（仅有 data-reflow-page 但不是正文段落）
      if (reflowPara && reflowPara.classList.contains('bk-pdf-reflow-page-divider')) {
        _hideActionPanel();
        _currentSelection = null;
        return;
      }
      // 跨段选取拦截：Reflow 文本匹配是逐行 indexOf，跨段文字无法匹配渲染
      if (reflowPara && endPara && reflowPara !== endPara) {
        _hideActionPanel();
        _currentSelection = null;
        return;
      }
      if (!reflowPara) {
        _hideActionPanel();
        return;
      }
      var reflowPageNum = parseInt(reflowPara.getAttribute('data-reflow-page'), 10) || 1;
      // Reflow 下 rects 留空（文本匹配渲染不需要坐标）
      _currentSelection = { page: reflowPageNum, text: text, rects: [] };
      _showActionPanel(range, reflowPara);
      return;
    }

    // === 普通模式分支 ===
    // 找到所属的 .bk-pdf-page 元素
    var pageEl = containerEl.closest ? containerEl.closest('.bk-pdf-page') : null;
    if (!pageEl) {
      // fallback: 向上遍历
      var p = containerEl.parentNode;
      while (p && !p.classList.contains('bk-pdf-page')) p = p.parentNode;
      pageEl = p;
    }
    if (!pageEl) return;

    var pageNum = parseInt(pageEl.getAttribute('data-pdf-page'), 10) || 1;

    // 获取选中区域的矩形
    var range2 = sel.getRangeAt(0);
    var rects = _getNormalizedRects(range2, containerEl);

    _currentSelection = { page: pageNum, text: text, rects: rects, bookId: bookId };

    // 显示操作面板（在选区上方）
    _showActionPanel(range2, containerEl);
  }

  /**
   * 获取选中矩形（归一化为相对于 text layer 的百分比坐标）
   */
  function _getNormalizedRects(range, textLayerEl) {
    var rangeRects = range.getClientRects();
    var containerRect = textLayerEl.getBoundingClientRect();
    var cw = containerRect.width || 1;
    var ch = containerRect.height || 1;
    var rects = [];
    for (var i = 0; i < rangeRects.length; i++) {
      var r = rangeRects[i];
      if (r.width < 1 || r.height < 1) continue;
      rects.push({
        left: (r.left - containerRect.left) / cw,
        top: (r.top - containerRect.top) / ch,
        width: r.width / cw,
        height: r.height / ch
      });
    }
    return rects;
  }

  // ==================== 操作面板 ====================

  /**
   * 创建颜色选择行 HTML（5 色圆点）
   * 复用 state.HIGHLIGHT_COLORS，颜色 class 与 css-pdf.css 中 .bk-pdf-hl-{color} 对应
   */
  function _buildColorRowHTML() {
    var colors = S.HIGHLIGHT_COLORS || ['yellow', 'green', 'blue', 'pink', 'orange'];
    var html = '<div class="bk-pdf-hl-color-row" role="radiogroup" aria-label="高亮颜色">';
    for (var i = 0; i < colors.length; i++) {
      var c = colors[i];
      var active = (c === _highlightColor) ? ' bk-pdf-hl-color-active' : '';
      html += '<button class="bk-pdf-hl-color-dot bk-pdf-hl-color-' + c + active + '"' +
        ' data-color="' + c + '" role="radio" aria-checked="' + (active ? 'true' : 'false') + '"' +
        ' aria-label="' + c + '" title="' + c + '"></button>';
    }
    html += '</div>';
    return html;
  }

  function _refreshColorRow() {
    if (!_actionPanel) return;
    var row = _actionPanel.querySelector('.bk-pdf-hl-color-row');
    if (!row) return;
    var dots = row.querySelectorAll('.bk-pdf-hl-color-dot');
    for (var i = 0; i < dots.length; i++) {
      var c = dots[i].getAttribute('data-color');
      var isActive = (c === _highlightColor);
      dots[i].classList.toggle('bk-pdf-hl-color-active', isActive);
      dots[i].setAttribute('aria-checked', isActive ? 'true' : 'false');
    }
  }

  function _createActionPanel() {
    if (_actionPanel) return _actionPanel;
    var panel = doc.createElement('div');
    panel.className = 'bk-pdf-hl-action-panel';
    panel.innerHTML =
      _buildColorRowHTML() +
      '<div class="bk-pdf-hl-btn-row">' +
        '<button class="bk-pdf-hl-btn bk-pdf-hl-highlight-btn" title="高亮">🖍</button>' +
        '<button class="bk-pdf-hl-btn bk-pdf-hl-underline-btn" title="下划线">U̲</button>' +
        '<button class="bk-pdf-hl-btn bk-pdf-hl-strike-btn" title="删除线">S̶</button>' +
        '<button class="bk-pdf-hl-btn bk-pdf-hl-copy-btn" title="复制">📋</button>' +
        '<button class="bk-pdf-hl-btn bk-pdf-hl-note-btn" title="批注">📝</button>' +
      '</div>';

    doc.body.appendChild(panel);
    _actionPanel = panel;

    // 颜色选择 - 事件委托（避免重渲染后绑定丢失）
    panel.querySelector('.bk-pdf-hl-color-row').addEventListener('click', function (e) {
      var dot = e.target.closest('.bk-pdf-hl-color-dot');
      if (!dot) return;
      _highlightColor = dot.getAttribute('data-color') || 'yellow';
      _refreshColorRow();
      // 切换颜色后保持面板可见，方便用户继续操作
    });

    // 高亮按钮
    var hlBtn = panel.querySelector('.bk-pdf-hl-highlight-btn');
    hlBtn.addEventListener('click', function () {
      _doHighlight();
      _hideActionPanel();
    });

    // 下划线按钮
    var ulBtn = panel.querySelector('.bk-pdf-hl-underline-btn');
    ulBtn.addEventListener('click', function () {
      _doUnderline();
      _hideActionPanel();
    });

    // 删除线按钮
    var stBtn = panel.querySelector('.bk-pdf-hl-strike-btn');
    stBtn.addEventListener('click', function () {
      _doStrikethrough();
      _hideActionPanel();
    });

    // 复制按钮
    var copyBtn = panel.querySelector('.bk-pdf-hl-copy-btn');
    copyBtn.addEventListener('click', function () {
      if (_currentSelection && _currentSelection.text) {
        _copyToClipboard(_currentSelection.text);
      }
      _hideActionPanel();
      win.getSelection().removeAllRanges();
    });

    // 批注按钮
    var noteBtn = panel.querySelector('.bk-pdf-hl-note-btn');
    noteBtn.addEventListener('click', function () {
      // 先关操作面板（discard 消耗自己的栈条目），再创建高亮+弹批注面板（push 新条目）。
      // 顺序反了会导致 discard 误 pop 批注面板刚 push 的条目
      _hideActionPanel();
      _doHighlightWithNote();
    });

    return panel;
  }

  function _showActionPanel(range, textLayerEl) {
    if (_actionPanel && _actionPanel.classList.contains('bk-pdf-hl-panel-visible')) return; // 幂等
    _createActionPanel();
    // 每次显示前刷新颜色选中态（外部代码可能改过 _highlightColor）
    _refreshColorRow();
    var rangeRect = range.getBoundingClientRect();
    var panelW = 210;
    var panelH = 78; // 颜色行(28) + 间距(4) + 按钮行(40) + 内边距(6*2)，从原 40 调整
    var left = rangeRect.left + rangeRect.width / 2 - panelW / 2;
    var top = rangeRect.top - panelH - 8;

    // 边界修正
    if (left < 8) left = 8;
    if (left + panelW > win.innerWidth - 8) left = win.innerWidth - panelW - 8;
    if (top < 8) top = rangeRect.bottom + 8;

    _actionPanel.style.left = left + 'px';
    _actionPanel.style.top = top + 'px';
    _actionPanel.classList.add('bk-pdf-hl-panel-visible');
    // 注册到 backStack：系统返回键关闭面板
    if (win.BK && win.BK.backStack) {
      _actionInBackStack = true;
      win.BK.backStack.push(function () {
        _actionInBackStack = false;
        _hideActionPanel();
      });
    }
  }

  function _hideActionPanel() {
    if (_actionPanel) {
      _actionPanel.classList.remove('bk-pdf-hl-panel-visible');
      // 主动关闭（按钮/选区消失）：消耗对应 history 条目；
      // 系统返回键触发时回调已置 _actionInBackStack=false，不会走到这里
      if (_actionInBackStack && win.BK && win.BK.backStack) {
        _actionInBackStack = false;
        win.BK.backStack.discard();
      }
    }
  }

  // ==================== 批注浮动输入框 ====================

  var _notePanel = null;
  var _noteTextarea = null;
  var _noteTargetHlId = null; // 正在编辑批注的高亮 id
  var _noteInBackStack = false; // 批注面板是否已注册到 backStack（防双重消耗）

  function _createNotePanel() {
    if (_notePanel) return _notePanel;
    var panel = doc.createElement('div');
    panel.className = 'bk-pdf-note-panel';
    panel.innerHTML =
      '<div class="bk-pdf-note-header">' +
        '<span class="bk-pdf-note-title">批注</span>' +
        '<button class="bk-pdf-note-close" aria-label="关闭">✕</button>' +
      '</div>' +
      '<textarea class="bk-pdf-note-input" placeholder="输入批注内容…" rows="3"></textarea>' +
      '<div class="bk-pdf-note-actions">' +
        '<button class="bk-pdf-note-save">保存</button>' +
        '<button class="bk-pdf-note-cancel">取消</button>' +
      '</div>';
    doc.body.appendChild(panel);
    _notePanel = panel;
    _noteTextarea = panel.querySelector('.bk-pdf-note-input');

    // 关闭按钮
    panel.querySelector('.bk-pdf-note-close').addEventListener('click', _hideNotePanel);
    // 取消按钮
    panel.querySelector('.bk-pdf-note-cancel').addEventListener('click', _hideNotePanel);
    // 保存按钮
    panel.querySelector('.bk-pdf-note-save').addEventListener('click', function () {
      _saveNote();
    });

    return panel;
  }

  function _showNotePanel(hlId, existingNote, anchorRect) {
    if (_notePanel && _notePanel.classList.contains('bk-pdf-note-panel-visible')) return; // 幂等
    _createNotePanel();
    _noteTargetHlId = hlId;
    if (_noteTextarea) {
      _noteTextarea.value = existingNote || '';
      _noteTextarea.focus();
    }

    // 定位在锚点附近
    var left = anchorRect ? anchorRect.left + anchorRect.width / 2 - 120 : win.innerWidth / 2 - 120;
    var top = anchorRect ? anchorRect.bottom + 8 : win.innerHeight / 2 - 80;
    if (left < 8) left = 8;
    if (left + 240 > win.innerWidth - 8) left = win.innerWidth - 248;
    if (top + 180 > win.innerHeight) top = (anchorRect ? anchorRect.top - 180 : win.innerHeight / 2 - 80);

    _notePanel.style.left = left + 'px';
    _notePanel.style.top = top + 'px';
    _notePanel.classList.add('bk-pdf-note-panel-visible');
    // 注册到 backStack：系统返回键关闭面板
    if (win.BK && win.BK.backStack) {
      _noteInBackStack = true;
      win.BK.backStack.push(function () {
        _noteInBackStack = false;
        _hideNotePanel();
      });
    }
  }

  function _hideNotePanel() {
    if (_notePanel) {
      _notePanel.classList.remove('bk-pdf-note-panel-visible');
      // 主动关闭（保存/取消/关闭按钮）：消耗对应 history 条目；
      // 系统返回键触发时回调已置 _noteInBackStack=false，不会走到这里
      if (_noteInBackStack && win.BK && win.BK.backStack) {
        _noteInBackStack = false;
        win.BK.backStack.discard();
      }
    }
    _noteTargetHlId = null;
    // 关闭批注面板时通知刷新（高亮可能已创建但批注未保存）
    try { document.dispatchEvent(new CustomEvent('marks-changed')); } catch (e) {}
  }

  function _saveNote() {
    if (!_noteTargetHlId || !_noteTextarea) return;
    var note = _noteTextarea.value.trim();
    var bookId = S.currentBookId();
    if (!bookId) return;

    // F5：记录批注修改前的旧值用于撤销
    var oldNote = '';
    var pageNo = null;
    var hlArr = S.highlights(bookId);
    for (var i = 0; i < hlArr.length; i++) {
      if (hlArr[i].id === _noteTargetHlId) {
        oldNote = hlArr[i].note || '';
        pageNo = hlArr[i].page;
        break;
      }
    }
    var newNote = note || '';
    S.setHighlightNote(bookId, _noteTargetHlId, newNote);
    var U = win.BKPdf._internal.undo;
    if (U && pageNo != null && oldNote !== newNote) {
      U.recordNote(bookId, { hlId: _noteTargetHlId, page: pageNo, oldNote: oldNote, newNote: newNote });
    }
    _hideNotePanel();
    // 刷新抽屉（如打开）
    if (_drawerVisible) _populateDrawer();
    // Reflow 模式下重建 HTML 以刷新徽章
    if (_isReflowMode()) _refreshReflowAnnotations();
    try { document.dispatchEvent(new CustomEvent('marks-changed')); } catch (e) {}
  }

  function _doHighlightWithNote() {
    if (!_currentSelection) return;
    var bookId = S.currentBookId();
    if (!bookId) return;

    // 先添加高亮
    var hl = {
      page: _currentSelection.page,
      text: _currentSelection.text,
      rects: _currentSelection.rects,
      color: _highlightColor,
      type: 'highlight',
      note: ''
    };
    var hlId = S.addHighlight(bookId, hl);
    // F5：记录撤销（含 note 变化，所以同时记 add + note 初始为空）
    var U = win.BKPdf._internal.undo;
    if (U && hlId) U.recordAdd(bookId, hl);

    // 立即弹出批注输入框
    var sel = _currentSelection;
    _currentSelection = null;

    // Reflow 模式：用选区 range rect 作为锚点；普通模式：用 text layer + rects 计算
    var anchorRect = null;
    if (_isReflowMode()) {
      _refreshReflowAnnotations();
      win.getSelection().removeAllRanges();
      // Reflow 下没有 rects，用第一段已渲染的高亮 span 作为近似锚点
      var hlSpan = doc.querySelector('.bk-pdf-reflow-hl[data-reflow-hl-id="' + hlId + '"]');
      if (hlSpan) {
        var r = hlSpan.getBoundingClientRect();
        anchorRect = { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom };
      }
    } else {
      _renderHighlightOnPage(sel.page);
      win.getSelection().removeAllRanges();
      try {
        var pageEl = doc.querySelector('.bk-pdf-page[data-pdf-page="' + sel.page + '"]');
        if (pageEl) {
          var textLayer = pageEl.querySelector('.bk-pdf-text-layer');
          if (textLayer) {
            var tlRect = textLayer.getBoundingClientRect();
            var lastRect = sel.rects.length ? sel.rects[sel.rects.length - 1] : null;
            if (lastRect) {
              anchorRect = {
                left: tlRect.left + lastRect.left * tlRect.width,
                top: tlRect.top + lastRect.top * tlRect.height,
                width: lastRect.width * tlRect.width,
                height: lastRect.height * tlRect.height,
                bottom: tlRect.top + (lastRect.top + lastRect.height) * tlRect.height
              };
            }
          }
        }
      } catch (e) {}
    }

    _showNotePanel(hlId, '', anchorRect);
    // 创建高亮后即通知 MarkPanel 刷新（即使批注尚未输入）
    try { document.dispatchEvent(new CustomEvent('marks-changed')); } catch (e) {}
  }

  // ==================== 高亮渲染 ====================

  function _doHighlight() {
    if (!_currentSelection) return;
    var bookId = S.currentBookId();
    if (!bookId) return;

    var hl = {
      page: _currentSelection.page,
      text: _currentSelection.text,
      rects: _currentSelection.rects,
      color: _highlightColor,
      type: 'highlight'
    };
    var hlId = S.addHighlight(bookId, hl);
    // F5：记录撤销
    var U = win.BKPdf._internal.undo;
    if (U && hlId) U.recordAdd(bookId, hl);
    if (_isReflowMode()) {
      _refreshReflowAnnotations();
    } else {
      _renderHighlightOnPage(_currentSelection.page);
    }
    win.getSelection().removeAllRanges();
    _currentSelection = null;
    try { document.dispatchEvent(new CustomEvent('marks-changed')); } catch (e) {}
  }

  function _doUnderline() {
    if (!_currentSelection) return;
    var bookId = S.currentBookId();
    if (!bookId) return;

    var hl = {
      page: _currentSelection.page,
      text: _currentSelection.text,
      rects: _currentSelection.rects,
      color: _highlightColor,
      type: 'underline'
    };
    var hlId = S.addHighlight(bookId, hl);
    var U = win.BKPdf._internal.undo;
    if (U && hlId) U.recordAdd(bookId, hl);
    if (_isReflowMode()) {
      _refreshReflowAnnotations();
    } else {
      _renderHighlightOnPage(_currentSelection.page);
    }
    win.getSelection().removeAllRanges();
    _currentSelection = null;
    try { document.dispatchEvent(new CustomEvent('marks-changed')); } catch (e) {}
  }

  function _doStrikethrough() {
    if (!_currentSelection) return;
    var bookId = S.currentBookId();
    if (!bookId) return;

    var hl = {
      page: _currentSelection.page,
      text: _currentSelection.text,
      rects: _currentSelection.rects,
      color: _highlightColor,
      type: 'strikethrough'
    };
    var hlId = S.addHighlight(bookId, hl);
    var U = win.BKPdf._internal.undo;
    if (U && hlId) U.recordAdd(bookId, hl);
    if (_isReflowMode()) {
      _refreshReflowAnnotations();
    } else {
      _renderHighlightOnPage(_currentSelection.page);
    }
    win.getSelection().removeAllRanges();
    _currentSelection = null;
    try { document.dispatchEvent(new CustomEvent('marks-changed')); } catch (e) {}
  }

  /**
   * 渲染指定页面的所有高亮
   */
  function _renderHighlightOnPage(pageNum) {
    var bookId = S.currentBookId();
    var highlights = S.highlightsByPage(bookId, pageNum);

    // 找到页面元素
    var pageEl = doc.querySelector('.bk-pdf-page[data-pdf-page="' + pageNum + '"]');
    if (!pageEl) return;

    var textLayer = pageEl.querySelector('.bk-pdf-text-layer');
    // textLayer 不存在：页面可能正在渲染中，加入待渲队列
    if (!textLayer) {
      _pendingRenderPages[pageNum] = true;
      return;
    }

    // 先清除旧的高亮覆盖层
    _clearHighlightOverlays(pageNum);

    // 没有标记数据时只做清除即可
    if (!highlights.length) return;

    // 创建新覆盖层
    var overlays = [];
    for (var i = 0; i < highlights.length; i++) {
      var hl = highlights[i];
      var color = hl.color || 'yellow';
      var hlType = hl.type || 'highlight';
      for (var j = 0; j < hl.rects.length; j++) {
        var rect = hl.rects[j];
        var div = doc.createElement('div');
        var cls = 'bk-pdf-hl-overlay bk-pdf-hl-' + color;
        if (hlType === 'underline') cls += ' bk-pdf-hl-underline';
        else if (hlType === 'strikethrough') cls += ' bk-pdf-hl-strikethrough';
        if (hl.note) cls += ' bk-pdf-hl-note';
        div.className = cls;
        div.setAttribute('data-pdf-hl-id', hl.id || '');
        div.style.left = (rect.left * 100) + '%';
        div.style.top = (rect.top * 100) + '%';
        div.style.width = (rect.width * 100) + '%';
        div.style.height = (rect.height * 100) + '%';
        textLayer.appendChild(div);
        overlays.push(div);
      }
    }
    _highlightOverlays[pageNum] = overlays;
    // 该页高亮已成功渲染，移除待渲标记
    delete _pendingRenderPages[pageNum];
  }

  function _clearHighlightOverlays(pageNum) {
    var old = _highlightOverlays[pageNum];
    if (old) {
      for (var i = 0; i < old.length; i++) {
        if (old[i].parentNode) old[i].parentNode.removeChild(old[i]);
      }
    }
    _highlightOverlays[pageNum] = [];
  }

  /**
   * 渲染所有可见页面的所有高亮
   */
  function renderAllVisibleHighlights() {
    var bookId = S.currentBookId();
    if (!bookId) return;
    var pages = doc.querySelectorAll('.bk-pdf-page');
    for (var i = 0; i < pages.length; i++) {
      var pn = parseInt(pages[i].getAttribute('data-pdf-page'), 10);
      if (pn > 0) _renderHighlightOnPage(pn);
    }
  }

  /**
   * F5：撤销后刷新入口 —— 重渲所有可见页 + 如抽屉打开则刷新列表
   * 供 pdf-undo.js 调用
   */
  function refreshAfterUndo() {
    renderAllVisibleHighlights();
    if (_drawerVisible) _populateDrawer();
  }

  /**
   * 补渲之前因 textLayer 不存在而暂存的高亮
   * 由 pdf-core.js 在 renderPage 完成后调用
   */
  function flushPendingRenders() {
    var pages = Object.keys(_pendingRenderPages);
    for (var i = 0; i < pages.length; i++) {
      var pn = parseInt(pages[i], 10);
      if (pn > 0) _renderHighlightOnPage(pn);
    }
  }

  // ==================== 高亮列表抽屉 ====================

  var _drawerFilter = 'all'; // all | highlight | underline | strikethrough | note

  function _createDrawer() {
    if (_drawer) return _drawer;
    var drawer = doc.createElement('div');
    drawer.className = 'bk-pdf-hl-drawer';
    drawer.innerHTML =
      '<div class="bk-pdf-hl-drawer-header">' +
        '<span class="bk-pdf-hl-drawer-title">高亮标注</span>' +
        '<button class="bk-pdf-hl-drawer-close" aria-label="关闭">✕</button>' +
      '</div>' +
      '<div class="bk-pdf-hl-drawer-tabs">' +
        '<button class="bk-pdf-hl-tab bk-pdf-hl-tab-active" data-filter="all">全部</button>' +
        '<button class="bk-pdf-hl-tab" data-filter="highlight">🖍高亮</button>' +
        '<button class="bk-pdf-hl-tab" data-filter="underline">U̲下划线</button>' +
        '<button class="bk-pdf-hl-tab" data-filter="strikethrough">S̶删除线</button>' +
        '<button class="bk-pdf-hl-tab" data-filter="note">📝批注</button>' +
      '</div>' +
      '<div class="bk-pdf-hl-drawer-body"></div>' +
      '<div class="bk-pdf-hl-drawer-footer"></div>';
    doc.body.appendChild(drawer);

    _drawer = drawer;
    _drawerBody = drawer.querySelector('.bk-pdf-hl-drawer-body');

    var closeBtn = drawer.querySelector('.bk-pdf-hl-drawer-close');
    if (closeBtn) closeBtn.addEventListener('click', hide);

    drawer.addEventListener('click', function (e) {
      if (e.target === drawer) hide();
    });

    // 筛选标签
    var tabs = drawer.querySelectorAll('.bk-pdf-hl-tab');
    for (var t = 0; t < tabs.length; t++) {
      tabs[t].addEventListener('click', function () {
        _drawerFilter = this.getAttribute('data-filter');
        var allTabs = _drawer.querySelectorAll('.bk-pdf-hl-tab');
        for (var a = 0; a < allTabs.length; a++) {
          allTabs[a].classList.toggle('bk-pdf-hl-tab-active', allTabs[a] === this);
        }
        _populateDrawer();
      });
    }

    return drawer;
  }

  function _populateDrawer() {
    if (!_drawerBody) return;
    var bookId = S.currentBookId();
    if (!bookId) return;

    var highlights = S.highlights(bookId);
    if (!highlights.length) {
      _drawerBody.innerHTML = '<div class="bk-pdf-outline-empty">暂无标注</div>';
      _updateDrawerFooter(0, 0, 0, 0);
      return;
    }

    var sorted = highlights.slice().sort(function (a, b) { return a.page - b.page || (a.timestamp || 0) - (b.timestamp || 0); });

    // 按筛选条件过滤
    var filtered = sorted;
    if (_drawerFilter === 'highlight') {
      filtered = sorted.filter(function (h) { return (!h.type || h.type === 'highlight'); });
    } else if (_drawerFilter === 'underline') {
      filtered = sorted.filter(function (h) { return h.type === 'underline'; });
    } else if (_drawerFilter === 'strikethrough') {
      filtered = sorted.filter(function (h) { return h.type === 'strikethrough'; });
    } else if (_drawerFilter === 'note') {
      filtered = sorted.filter(function (h) { return h.note && h.note.trim(); });
    }

    // 统计
    var hlCount = sorted.filter(function (h) { return !h.type || h.type === 'highlight'; }).length;
    var ulCount = sorted.filter(function (h) { return h.type === 'underline'; }).length;
    var stCount = sorted.filter(function (h) { return h.type === 'strikethrough'; }).length;
    var noteCount = sorted.filter(function (h) { return h.note && h.note.trim(); }).length;
    _updateDrawerFooter(hlCount, ulCount, stCount, noteCount);

    if (!filtered.length) {
      _drawerBody.innerHTML = '<div class="bk-pdf-outline-empty">当前筛选无结果</div>';
      return;
    }

    var html = '<ul class="bk-pdf-outline-list bk-pdf-hl-list">';
    for (var i = 0; i < filtered.length; i++) {
      var hl = filtered[i];
      var pageLabel = S.getDisplayPageLabel(hl.page);
      var color = hl.color || 'yellow';
      var hlType = hl.type || 'highlight';
      var typeIcon = hlType === 'underline' ? 'U̲' : (hlType === 'strikethrough' ? 'S̶' : '🖍');
      var noteSnippet = hl.note ? (' <span class="bk-pdf-hl-note-badge" data-pdf-hl-note-id="' + (hl.id || '') + '" title="' + S.escAttr(hl.note) + '">📝</span>') : '';
      var textSnippet = (hl.text || '').substring(0, 80);
      html += '<li class="bk-pdf-outline-item bk-pdf-hl-item" data-pdf-hl-type="' + hlType + '">';
      html += '<span class="bk-pdf-hl-type-icon">' + typeIcon + '</span>';
      html += '<span class="bk-pdf-hl-list-dot bk-pdf-hl-list-dot-' + color + '"></span>';
      html += '<a class="bk-pdf-outline-link bk-pdf-hl-link" data-pdf-hl-page="' + hl.page + '" data-pdf-hl-id="' + (hl.id || '') + '" href="javascript:void(0)">';
      html += S.escText(textSnippet);
      html += ' <span class="bk-pdf-hl-page-num">P' + pageLabel + '</span>';
      html += noteSnippet;
      html += '</a>';
      // 批注预览（如有）
      if (hl.note && hl.note.trim()) {
        html += '<div class="bk-pdf-hl-note-preview">📝 ' + S.escText((hl.note || '').substring(0, 120)) + '</div>';
      }
      html += '<button class="bk-pdf-bookmark-del bk-pdf-hl-del" data-pdf-hl-del="' + (hl.id || '') + '" aria-label="删除标注" title="删除">✕</button>';
      html += '</li>';
    }
    html += '</ul>';
    _drawerBody.innerHTML = html;

    // 绑定跳转
    var links = _drawerBody.querySelectorAll('.bk-pdf-hl-link');
    for (var j = 0; j < links.length; j++) {
      links[j].addEventListener('click', _onHlClick);
    }

    // 绑定批注徽章点击（查看/编辑批注）
    var noteBadges = _drawerBody.querySelectorAll('.bk-pdf-hl-note-badge');
    for (var nb = 0; nb < noteBadges.length; nb++) {
      noteBadges[nb].addEventListener('click', function (e) {
        e.stopPropagation();
        var hlId = e.target.getAttribute('data-pdf-hl-note-id');
        var bookId = S.currentBookId();
        if (!bookId || !hlId) return;
        var hlArr = S.highlights(bookId);
        var found = null;
        for (var i = 0; i < hlArr.length; i++) {
          if (hlArr[i].id === hlId) { found = hlArr[i]; break; }
        }
        if (found) {
          var badgeRect = e.target.getBoundingClientRect();
          _showNotePanel(hlId, found.note || '', badgeRect);
        }
      });
    }

    // 绑定删除
    var delBtns = _drawerBody.querySelectorAll('.bk-pdf-hl-del');
    for (var k = 0; k < delBtns.length; k++) {
      delBtns[k].addEventListener('click', _onHlDelete);
    }
  }

  function _onHlClick(e) {
    e.preventDefault();
    var link = e.currentTarget;
    var pageNum = parseInt(link.getAttribute('data-pdf-hl-page'), 10);
    if (pageNum && pageNum > 0) {
      var nav = win.BKPdf._internal.nav;
      if (nav && nav.goToPage) nav.goToPage(pageNum, true);
      hide();
    }
  }

  function _onHlDelete(e) {
    e.stopPropagation();
    var btn = e.currentTarget;
    var hlId = btn.getAttribute('data-pdf-hl-del');
    var bookId = S.currentBookId();
    if (bookId && hlId) {
      // F5：删除前抓快照用于撤销
      var snapshot = null;
      var hlArr = S.highlights(bookId);
      for (var i = 0; i < hlArr.length; i++) {
        if (hlArr[i].id === hlId) { snapshot = hlArr[i]; break; }
      }
      S.removeHighlight(bookId, hlId);
      var U = win.BKPdf._internal.undo;
      if (U && snapshot) U.recordRemove(bookId, snapshot);
      _populateDrawer();
      // 重新渲染高亮覆盖层
      if (_isReflowMode()) {
        _refreshReflowAnnotations();
      } else {
        renderAllVisibleHighlights();
      }
      try { document.dispatchEvent(new CustomEvent('marks-changed')); } catch (e) {}
    }
  }

  // ==================== 底部统计栏 ====================

  function _updateDrawerFooter(hlCount, ulCount, stCount, noteCount) {
    var footer = _drawer ? _drawer.querySelector('.bk-pdf-hl-drawer-footer') : null;
    if (!footer) return;
    var total = hlCount + ulCount + stCount;
    footer.innerHTML =
      '<span class="bk-pdf-hl-stat">共 ' + total + ' 条标注</span>' +
      '<span class="bk-pdf-hl-stat-dot">·</span>' +
      '<span class="bk-pdf-hl-stat">' + noteCount + ' 条批注</span>';
  }

  // ==================== 展开/收起抽屉 ====================

  function toggle() {
    if (_drawerVisible) hide();
    else show();
  }

  function show() {
    if (_drawerVisible) return; // 幂等：已显示时不重复 push 回退栈
    _createDrawer();
    _populateDrawer();
    if (_drawer) _drawer.classList.add('bk-pdf-hl-drawer-visible');
    _drawerVisible = true;
    S.closeAllDrawersExcept('highlight');
    // 注册到 backStack：系统返回键关闭抽屉
    // push 必须放在 closeAllDrawersExcept 之后，避免被互斥关闭的 discard 误 pop 自己刚 push 的条目
    if (win.BK && win.BK.backStack) {
      _drawerInBackStack = true;
      win.BK.backStack.push(function () {
        _drawerInBackStack = false;
        hide();
      });
    }
  }

  function hide() {
    if (!_drawerVisible) return; // 幂等：未显示时无栈条目可消耗
    if (_drawer) _drawer.classList.remove('bk-pdf-hl-drawer-visible');
    _drawerVisible = false;
    // 主动关闭（按钮/互斥）：消耗对应 history 条目；
    // 系统返回键触发时回调已置 _drawerInBackStack=false，不会走到这里
    if (_drawerInBackStack && win.BK && win.BK.backStack) {
      _drawerInBackStack = false;
      win.BK.backStack.discard();
    }
  }

  // _closeOthers 已抽取为公共工具 S.closeAllDrawersExcept

  // ==================== 复制到剪贴板 ====================

  function _copyToClipboard(text) {
    if (win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) {
      win.navigator.clipboard.writeText(text).catch(function () {
        _fallbackCopy(text);
      });
    } else {
      _fallbackCopy(text);
    }
  }

  function _fallbackCopy(text) {
    var ta = doc.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    doc.body.appendChild(ta);
    ta.select();
    try { doc.execCommand('copy'); } catch (e) {}
    doc.body.removeChild(ta);
  }

  // ==================== init / cleanup ====================

  function cleanup() {
    // 注意：cleanup 直接移除 DOM，不走 hide() 的 discard 逻辑。
    // 若直接调 _hideActionPanel/_hideNotePanel，当栈顶不是自己时 discard 会误 pop 别人的条目，
    // 故这里只复位标志 + silentPop 弹出自己的回调（不动 history）。
    if (_actionPanel) _actionPanel.classList.remove('bk-pdf-hl-panel-visible');
    if (_actionInBackStack && win.BK && win.BK.backStack) {
      _actionInBackStack = false;
      win.BK.backStack.silentPop();
    }
    if (_notePanel) _notePanel.classList.remove('bk-pdf-note-panel-visible');
    if (_noteInBackStack && win.BK && win.BK.backStack) {
      _noteInBackStack = false;
      win.BK.backStack.silentPop();
    }
    if (_actionPanel && _actionPanel.parentNode) {
      _actionPanel.parentNode.removeChild(_actionPanel);
    }
    _actionPanel = null;
    if (_notePanel && _notePanel.parentNode) {
      _notePanel.parentNode.removeChild(_notePanel);
    }
    _notePanel = null;
    _noteTextarea = null;
    _noteTargetHlId = null;
    if (_drawer && _drawer.parentNode) {
      _drawer.parentNode.removeChild(_drawer);
    }
    _drawer = null;
    _drawerBody = null;
    _drawerVisible = false;
    _drawerFilter = 'all';
    // 书籍退出时抽屉可能仍在回退栈上：弹出回调防孤儿条目（不触发 history.back）
    if (_drawerInBackStack && win.BK && win.BK.backStack) {
      _drawerInBackStack = false;
      win.BK.backStack.silentPop();
    }
    // 清除所有高亮覆盖层
    var keys = Object.keys(_highlightOverlays);
    for (var i = 0; i < keys.length; i++) {
      _clearHighlightOverlays(keys[i]);
    }
    _highlightOverlays = {};
    _pendingRenderPages = {};
    _currentSelection = null;
    // 断开 MutationObserver（防止内存泄漏）
    if (_pageObserver) { _pageObserver.disconnect(); _pageObserver = null; }
  }

  // ==================== 导出 ====================

  win.BKPdf._internal.highlight = {
    init: init,
    cleanup: cleanup,
    toggle: toggle,
    show: show,
    hide: hide,
    renderAllVisibleHighlights: renderAllVisibleHighlights,
    renderHighlightOnPage: _renderHighlightOnPage,
    refreshAfterUndo: refreshAfterUndo,
    flushPendingRenders: flushPendingRenders,
    showNotePanel: _showNotePanel,
    _doHighlight: _doHighlight,
    _hideActionPanel: _hideActionPanel
  };

})(window);
