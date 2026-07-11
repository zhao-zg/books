/**
 * shelf.js — 书架数据层（唯一事实源）
 *
 * 职责：localStorage 中书架记录（已读）的读写，以及跨视图状态同步事件的广播。
 *  - 键命名：bk_shelf:<bookId>  →  JSON { bookId, completedAt, note, rating, status }
 *  - 判定已读 = 该键存在；移除 = 删除该键（含 note/rating 一并清除）。
 *  - 每次写操作后广播全局自定义事件 'bk-shelf-changed'，detail = { bookId, action:'add'|'remove' }。
 *  - 不碰 DOM：纯数据层，供书城卡片与书架页两个视图消费。
 *
 * 暴露：window.BKShelf
 */
(function (win) {
  'use strict';

  var PREFIX = 'bk_shelf:';
  var STATUS = 'read';

  // ── 工具：生成当天 YYYY-MM-DD（本地时区） ──────────────────────────────
  function _today() {
    var d = new Date();
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return y + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  function _key(bookId) { return PREFIX + bookId; }

  function _safeGet(key) {
    try { return win.localStorage.getItem(key); } catch (e) { return null; }
  }
  function _safeSet(key, val) {
    try { win.localStorage.setItem(key, val); } catch (e) {}
  }
  function _safeRemove(key) {
    try { win.localStorage.removeItem(key); } catch (e) {}
  }

  // ── 公共 API ───────────────────────────────────────────────────────────

  /**
   * 读取单条书架记录。
   * @param {string} bookId
   * @returns {Object|null} { bookId, completedAt, note, rating, status }
   */
  function get(bookId) {
    var raw = _safeGet(_key(bookId));
    if (!raw) return null;
    try {
      var rec = JSON.parse(raw);
      if (rec && rec.bookId) return rec;
      return null;
    } catch (e) { return null; }
  }

  /**
   * 写入书架记录（标记已读）。
   * @param {string} bookId
   * @param {Object} [opts] { completedAt?:string(YYYY-MM-DD), note?:string|null, rating?:number|null }
   */
  function add(bookId, opts) {
    opts = opts || {};
    var rec = {
      bookId: bookId,
      completedAt: opts.completedAt || _today(),
      note: (opts.note !== undefined ? opts.note : null),
      rating: (opts.rating !== undefined ? opts.rating : null),
      status: STATUS
    };
    _safeSet(_key(bookId), JSON.stringify(rec));
    emitChanged(bookId, 'add');
  }

  /**
   * 移除书架记录（连同 note/rating 一并清除）。
   * @param {string} bookId
   */
  function remove(bookId) {
    _safeRemove(_key(bookId));
    emitChanged(bookId, 'remove');
  }

  /**
   * 扫描所有 bk_shelf: 前缀键，返回记录数组（按 completedAt 倒序）。
   * @returns {Array<Object>}
   */
  function all() {
    var records = [];
    var ls = win.localStorage;
    var keys = [];
    try {
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (k && k.indexOf(PREFIX) === 0) keys.push(k);
      }
    } catch (e) { return records; }

    for (var j = 0; j < keys.length; j++) {
      var rec = get(keys[j].substring(PREFIX.length));
      if (rec) records.push(rec);
    }

    records.sort(function (a, b) {
      return (b.completedAt || '').localeCompare(a.completedAt || '');
    });
    return records;
  }

  /**
   * 判定书籍是否已读（即记录键是否存在）。
   * @param {string} bookId
   * @returns {boolean}
   */
  function isRead(bookId) {
    return _safeGet(_key(bookId)) !== null;
  }

  /**
   * 阅读统计。
   * @returns {{total:number, thisMonth:number}}
   */
  function stats() {
    var records = all();
    var total = records.length;
    var thisMonth = 0;
    var now = new Date();
    var ym = now.getFullYear() + '-' + (now.getMonth() + 1 < 10 ? '0' + (now.getMonth() + 1) : (now.getMonth() + 1));
    for (var i = 0; i < records.length; i++) {
      var ca = records[i].completedAt || '';
      if (ca.substring(0, 7) === ym) thisMonth++;
    }
    return { total: total, thisMonth: thisMonth };
  }

  /**
   * 广播书架状态变更事件（全局自定义事件）。
   * @param {string} bookId
   * @param {'add'|'remove'} action
   */
  function emitChanged(bookId, action) {
    try {
      win.dispatchEvent(new win.CustomEvent('bk-shelf-changed', {
        detail: { bookId: bookId, action: action }
      }));
    } catch (e) {}
  }

  win.BKShelf = {
    get: get,
    add: add,
    remove: remove,
    all: all,
    isRead: isRead,
    stats: stats,
    emitChanged: emitChanged
  };

})(window);
