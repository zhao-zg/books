/*!
 * pdf-undo.js - PDF 标注撤销栈（F5）
 *
 * 职责：
 *   - 记录标注（高亮/下划线/删除线/批注）的增删改操作
 *   - 提供 undo() 弹出栈顶并执行反向操作
 *   - 每本书独立栈（按 bookId 隔离），容量 20
 *   - 通过 onChange 回调通知 UI 刷新按钮态
 *
 * 依赖：pdf-state.js（restoreHighlight/removeHighlight/setHighlightNote）,
 *       pdf-highlight.js（refreshAfterUndo）
 * 挂载：window.BKPdf._internal.undo
 *
 * 数据结构：
 *   栈项 { op:'add'|'remove'|'note', bookId, hlId?, page?, snapshot?, oldNote?, newNote? }
 *   - 'add'    : 撤销时移除该 hlId
 *   - 'remove' : 撤销时把 snapshot 原样插回（保留 id）
 *   - 'note'   : 撤销时把 note 改回 oldNote
 */
(function (win) {
  'use strict';

  // ==================== 状态 ====================

  var MAX_UNDO = 20;
  var _stack = [];          // 撤销栈（按 bookId 自动隔离，切换书时 reset）
  var _bookId = null;       // 当前栈归属书 id
  var _changeCb = null;     // 栈变化回调（用于 UI 启用/禁用按钮）

  // ==================== 内部工具 ====================

  function _clone(o) {
    if (!o) return o;
    try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; }
  }

  function _ensureBook(bookId) {
    if (!bookId) return;
    if (_bookId !== bookId) {
      _bookId = bookId;
      _stack = [];
      _notify();
    }
  }

  function _push(item) {
    _stack.push(item);
    while (_stack.length > MAX_UNDO) _stack.shift();
    _notify();
  }

  function _notify() {
    if (typeof _changeCb === 'function') {
      try { _changeCb(_stack.length > 0); } catch (e) {}
    }
  }

  // ==================== 记录 API（供 highlight 模块调用） ====================

  /**
   * 记录一次"新增标注"操作（撤销时移除该标注）
   * @param {string} bookId
   * @param {object} hlSnapshot 撤销所需的完整标注快照（含 id/page/rects/color/type/note 等）
   */
  function recordAdd(bookId, hlSnapshot) {
    if (!bookId || !hlSnapshot || !hlSnapshot.id) return;
    _ensureBook(bookId);
    _push({
      op: 'add',
      bookId: bookId,
      hlId: hlSnapshot.id,
      page: hlSnapshot.page,
      snapshot: _clone(hlSnapshot)
    });
  }

  /**
   * 记录一次"删除标注"操作（撤销时把快照原样插回）
   */
  function recordRemove(bookId, hlSnapshot) {
    if (!bookId || !hlSnapshot || !hlSnapshot.id) return;
    _ensureBook(bookId);
    _push({
      op: 'remove',
      bookId: bookId,
      page: hlSnapshot.page,
      snapshot: _clone(hlSnapshot)
    });
  }

  /**
   * 记录一次"修改批注"操作（撤销时把 note 改回 oldNote）
   * @param {string} bookId
   * @param {object} noteSnapshot { hlId, page, oldNote, newNote }
   */
  function recordNote(bookId, noteSnapshot) {
    if (!bookId || !noteSnapshot || !noteSnapshot.hlId) return;
    _ensureBook(bookId);
    _push({
      op: 'note',
      bookId: bookId,
      hlId: noteSnapshot.hlId,
      page: noteSnapshot.page,
      oldNote: noteSnapshot.oldNote || '',
      newNote: noteSnapshot.newNote || ''
    });
  }

  // ==================== 撤销执行 ====================

  /**
   * 执行一次撤销
   * @returns {boolean} 是否成功撤销
   */
  function undo() {
    if (!_stack.length) return false;
    var item = _stack.pop();
    var S = win.BKPdf._internal.state;
    var hl = win.BKPdf._internal.highlight;
    var ok = false;

    try {
      if (item.op === 'add') {
        // 撤销新增 = 删除
        S.removeHighlight(item.bookId, item.hlId);
        ok = true;
      } else if (item.op === 'remove') {
        // 撤销删除 = 原样插回（保留 id）
        S.restoreHighlight(item.bookId, item.snapshot);
        ok = true;
      } else if (item.op === 'note') {
        // 撤销批注修改 = 改回 oldNote
        S.setHighlightNote(item.bookId, item.hlId, item.oldNote);
        ok = true;
      }
    } catch (e) {
      ok = false;
    }

    // 重新渲染高亮 + 刷新抽屉（如打开）
    if (ok && hl && hl.refreshAfterUndo) {
      try { hl.refreshAfterUndo(); } catch (e) {}
    }
    // 同步刷新 Reflow 视图中的标注（如当前在 Reflow 模式）
    if (ok && S.mode() === S.MODE_REFLOW) {
      var reflow = win.BKPdf._internal.reflow;
      if (reflow && reflow.refreshAnnotations) {
        try { reflow.refreshAnnotations(); } catch (e) {}
      }
    }
    _notify();
    return ok;
  }

  // ==================== 其他 API ====================

  function canUndo() {
    return _stack.length > 0;
  }

  function size() {
    return _stack.length;
  }

  function onChange(cb) {
    _changeCb = (typeof cb === 'function') ? cb : null;
    _notify();
  }

  /**
   * 重置撤销栈（切换书 / cleanup 时调用）
   */
  function reset() {
    _stack = [];
    _bookId = null;
    _notify();
  }

  // ==================== 导出 ====================

  win.BKPdf._internal.undo = {
    recordAdd: recordAdd,
    recordRemove: recordRemove,
    recordNote: recordNote,
    undo: undo,
    canUndo: canUndo,
    size: size,
    onChange: onChange,
    reset: reset
  };

})(window);
