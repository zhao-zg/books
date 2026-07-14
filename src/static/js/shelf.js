/**
 * shelf.js — 书架数据层（唯一事实源）
 *
 * 职责：localStorage 中书架记录（收藏 + 已读）的读写，以及跨视图状态同步事件的广播。
 *
 * 新数据模型（「在架/收藏」与「已读」解耦）：
 *  - 键命名：bk_shelf:<bookId>  →  JSON 记录
 *  - 记录形状：{ bookId, addedAt, finished?, completedAt?, note, rating, status }
 *      · finished（布尔，可选）：权威判定「已读」。true=读完；缺省/undefined=未读（在架或在读）。
 *      · completedAt：仅当 finished 时有效/显示（YYYY-MM-DD）；缺省/空表示未读完。
 *      · addedAt：入架日期（YYYY-MM-DD），用于排序兜底（旧记录无 addedAtTs 时）。
 *      · addedAtTs：入架时刻时间戳（ms），书架主排序键——最近加入的在最上面。
 *      · status：文档化字段，固定写 'collected'（旧记录 legacy 'read' 读取时忽略）。
 *  - 入架（add）= 收藏，不写 finished/completedAt（与旧记录形状一致，天然未读）。
 *  - 标记已读（markRead / finish）= 置 finished:true + completedAt；幂等去重。
 *  - 迁移零成本：旧记录无 finished → isRead 返回 false → 天然转「在读/收藏」，不重写键。
 *  - 每次写操作后广播全局自定义事件 'bk-shelf-changed'，detail = { bookId, action:'add'|'finish'|'remove' }。
 *  - 不碰 DOM：纯数据层，供书城卡片与书架页两个视图消费。
 *
 * 暴露：window.BKShelf
 */
(function (win) {
  'use strict';

  var PREFIX = 'bk_shelf:';
  var STATUS = 'collected';            // 在架(收藏)的文档化标识；旧记录 legacy 'read' 读取时忽略

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
   * @returns {Object|null} { bookId, addedAt, finished?, completedAt?, note, rating, status }
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
   * 加入书架 = 收藏（不标记已读）。
   * 写入 { bookId, addedAt, note, rating, status:'collected' }，不含 finished/completedAt。
   * @param {string} bookId
   * @param {Object} [opts] { addedAt?, note?, rating? }
   */
  function add(bookId, opts) {
    opts = opts || {};
    var rec = {
      bookId: bookId,
      addedAt: opts.addedAt || _today(),
      addedAtTs: (typeof opts.addedAtTs === 'number') ? opts.addedAtTs : Date.now(),
      note: (opts.note !== undefined ? opts.note : null),
      rating: (opts.rating !== undefined ? opts.rating : null),
      status: STATUS
      // 注意：add 仅入架（收藏），不写 finished / completedAt —— 收藏 ≠ 已读
    };
    _safeSet(_key(bookId), JSON.stringify(rec));
    emitChanged(bookId, 'add');
  }

  /**
   * 标记已读（读完）。
   * 置 finished:true + completedAt；若记录不存在则先创建（收藏 + 已读）。
   * 幂等去重：已 finished 直接返回（不重写、不广播）。
   * @param {string} bookId
   * @param {Object} [opts] { completedAt?, addedAt?, note?, rating? }
   */
  function markRead(bookId, opts) {
    opts = opts || {};
    var rec = get(bookId);

    // 幂等：已 finished 直接返回（不重写、不广播），避免重复事件与抖动
    if (rec && rec.finished === true) return;

    var now = _today();
    if (rec) {
      rec.finished = true;
      rec.completedAt = opts.completedAt || rec.completedAt || now;
      if (opts.note !== undefined) rec.note = opts.note;
      if (opts.rating !== undefined) rec.rating = opts.rating;
      if (!rec.status) rec.status = STATUS;
      if (!rec.addedAt) rec.addedAt = opts.addedAt || now;
      if (!rec.addedAtTs) rec.addedAtTs = opts.addedAtTs || Date.now();
    } else {
      // 记录不存在则创建（收藏 + 已读）
      rec = {
        bookId: bookId,
        addedAt: opts.addedAt || now,
        addedAtTs: (typeof opts.addedAtTs === 'number') ? opts.addedAtTs : Date.now(),
        finished: true,
        completedAt: opts.completedAt || now,
        note: (opts.note !== undefined ? opts.note : null),
        rating: (opts.rating !== undefined ? opts.rating : null),
        status: STATUS
      };
    }

    _safeSet(_key(bookId), JSON.stringify(rec));
    emitChanged(bookId, 'finish');
  }

  /**
   * 移除书架记录（连同 finished/note/rating 一并清除）。
   * @param {string} bookId
   */
  function remove(bookId) {
    _safeRemove(_key(bookId));
    emitChanged(bookId, 'remove');
  }

  /**
   * 取消已读（撤销「读完」）：置 finished:false + 清空 completedAt；保留 addedAt/note/rating/status。
   * 幂等：记录不存在或本就未读完（finished!==true）则直接返回（不重写、不广播）。
   * @param {string} bookId
   * @param {Object} [opts] { addedAt? }
   */
  function unmarkRead(bookId, opts) {
    opts = opts || {};
    var rec = get(bookId);
    if (!rec || rec.finished !== true) return; // 无记录或本就未读：无操作、不广播
    rec.finished = false;
    rec.completedAt = null;
    if (opts.addedAt && !rec.addedAt) rec.addedAt = opts.addedAt;
    if (opts.addedAtTs && !rec.addedAtTs) rec.addedAtTs = opts.addedAtTs;
    _safeSet(_key(bookId), JSON.stringify(rec));
    emitChanged(bookId, 'unread');
  }

  /**
   * 扫描所有 bk_shelf: 前缀键，返回记录数组（按 addedAtTs 倒序——最近加入的在最上面）。
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
      // 主排序：入架时间戳倒序——最近加入的在最上面（不受「标记已读」影响）。
      var ta = (typeof a.addedAtTs === 'number') ? a.addedAtTs : 0;
      var tb = (typeof b.addedAtTs === 'number') ? b.addedAtTs : 0;
      if (ta !== tb) return tb - ta;
      // 兜底：旧记录无时间戳，按 addedAt 日期字符串倒序。
      var ka = a.addedAt || '';
      var kb = b.addedAt || '';
      return kb.localeCompare(ka);
    });
    return records;
  }

  /**
   * 判定书籍是否已读（读完）。
   * 新语义：仅当记录存在且 finished === true。旧记录（无 finished）天然返回 false。
   * @param {string} bookId
   * @returns {boolean}
   */
  function isRead(bookId) {
    var rec = get(bookId);
    return !!(rec && rec.finished === true);
  }

  /**
   * 判定书籍是否在架（收藏）。
   * 键存在即 true（在架/收藏），替代旧「键存在 = 已读」语义。
   * @param {string} bookId
   * @returns {boolean}
   */
  function isCollected(bookId) {
    return _safeGet(_key(bookId)) !== null;
  }

  /**
   * 阅读统计。
   * @returns {{total:number, finished:number, thisMonth:number}}
   *   total      = 在架（收藏）总数
   *   finished   = 已读（读完）数
   *   thisMonth  = 本月读完数（finished 且 completedAt 落在本月）
   */
  function stats() {
    var records = all();
    var total = records.length;
    var finished = 0;
    var thisMonth = 0;
    var now = new Date();
    var ym = now.getFullYear() + '-' + (now.getMonth() + 1 < 10 ? '0' + (now.getMonth() + 1) : (now.getMonth() + 1));
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      if (rec.finished === true) {
        finished++;
        var ca = rec.completedAt || '';
        if (ca.substring(0, 7) === ym) thisMonth++;
      }
    }
    return { total: total, finished: finished, thisMonth: thisMonth };
  }

  /**
   * 广播书架状态变更事件（全局自定义事件）。
   * @param {string} bookId
   * @param {'add'|'finish'|'remove'} action
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
    markRead: markRead,
    unmarkRead: unmarkRead,    // 撤销「读完」：finished→false，移回在读
    finish: markRead,        // 别名：语义等价（标记已读）
    isRead: isRead,
    isCollected: isCollected,
    all: all,
    stats: stats,
    emitChanged: emitChanged
  };

})(window);
