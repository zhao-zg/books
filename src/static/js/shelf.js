/**
 * shelf.js — 书架数据层（唯一事实源）
 *
 * 职责：localStorage 中书架记录（收藏 + 已读）的读写，以及跨视图状态同步事件的广播。
 *
 * 新数据模型（「在架/收藏」与「已读」解耦）：
 *  - 键命名：bk_shelf:<bookId>  →  JSON 记录
 *  - 记录形状：{ bookId, addedAt, finished?, completedAt?, note, rating, status, pinned?, pinnedTs?, favorite?, favoriteTs? }
 *      · finished（布尔，可选）：权威判定「已读」。true=读完；缺省/undefined=未读（在架或在读）。
 *      · completedAt：仅当 finished 时有效/显示（YYYY-MM-DD）；缺省/空表示未读完。
 *      · addedAt：入架日期（YYYY-MM-DD），用于排序兜底（旧记录无 addedAtTs 时）。
 *      · addedAtTs：入架时刻时间戳（ms），书架主排序键——最近加入的在最上面。
 *      · status：文档化字段，固定写 'collected'（旧记录 legacy 'read' 读取时忽略）。
 *      · favorite（布尔，可选）：用户收藏标记，独立于 finished。true=已收藏。
 *      · favoriteTs：收藏时间戳（ms），收藏排序用。
 *  - 入架（add）= 收藏，不写 finished/completedAt（与旧记录形状一致，天然未读）。
 *  - 标记已读（markRead / finish）= 置 finished:true + completedAt；幂等去重。
 *  - 收藏（setFavorite）= 置 favorite:true + favoriteTs，不影响 finished 状态。
 *  - 迁移零成本：旧记录无 finished → isRead 返回 false → 天然转「在读/收藏」，不重写键。
 *  - 每次写操作后广播全局自定义事件 'bk-shelf-changed'，detail = { bookId, action:'add'|'finish'|'remove'|'favorite'|'unfavorite' }。
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
    // 幂等：已在架且未移除则不重写、不广播，避免导入操作把移出的书加回。
    // markRead/setFavorite 等仍可正常更新同一条记录。
    var existing = get(bookId);
    if (existing && existing.status === STATUS) return;
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
   * 独立更新书架记录的笔记字段（不影响 finished/completedAt 等）。
   * 若记录不存在则忽略（不入架、不广播）。
   * @param {string} bookId
   * @param {string|null} note  新笔记内容；null 或空串视为清除笔记
   */
  function updateNote(bookId, note) {
    var rec = get(bookId);
    if (!rec) return;
    rec.note = (note && note.trim()) ? note.trim() : null;
    _safeSet(_key(bookId), JSON.stringify(rec));
    emitChanged(bookId, 'note-update');
  }

  /**
   * 独立删除书架记录的笔记字段（保留其余字段不变）。
   * @param {string} bookId
   */
  function removeNote(bookId) {
    updateNote(bookId, null);
  }

  /**
   * 独立更新书架记录的评分字段（不影响 finished/note 等）。
   * 若记录不存在则忽略。
   * @param {string} bookId
   * @param {number|null} rating  1-5 评分；null 清除评分
   */
  function updateRating(bookId, rating) {
    var rec = get(bookId);
    if (!rec) return;
    rec.rating = (typeof rating === 'number' && rating >= 1 && rating <= 5) ? rating : null;
    _safeSet(_key(bookId), JSON.stringify(rec));
    emitChanged(bookId, 'rating-update');
  }

  /**
   * 移除书架记录（连同 finished/note/rating 一并清除）。
   * 仅清 localStorage 书架记录，不清理 IndexedDB / Cache Storage 数据。
   * 如需「移出书架即彻底清理」，请使用 purgeBook()。
   * @param {string} bookId
   */
  function remove(bookId) {
    _safeRemove(_key(bookId));
    emitChanged(bookId, 'remove');
  }

  /**
   * 「移出书架」：按 bookId 类型差异化清理本地数据。
   *
   * 路由策略：
   *  ① 导入书（bookId 以 'imported-' 开头）：彻底清理。
   *     - localStorage：bk_shelf:<id> / bk_lastread_ts:<id> / bk_progress:<id> / bk_scroll:<id>…；
   *       若 bk_last_read 指向该书，也一并清除。
   *     - IndexedDB：ImportManager.removeImportedBook —— 清 imported-data / imported-pdf-data / zl-data / 索引。
   *     不可恢复。
   *
   *  ② 书城下载书（非 imported- 前缀）：仅移出书架记录，保留本地数据作为离线兜底。
   *     - 仅清 bk_shelf:<id>（由 remove 完成）。
   *     - 保留 zl-data / Cache Storage / 阅读进度 / 滚动位置，下次重新加入书架可无缝续读。
   *
   * 同步立即移出书架并广播 'remove' 事件，触发书架列表就地重渲染；
   * 导入书的 IndexedDB 与剩余 localStorage 在后台异步清理，完成后再次广播 'purge-done'，
   * 供需要更新占用统计的视图消费。书城书无异步清理，仅广播 'purge-done' 以保持事件契约一致。
   *
   * @param {string} bookId
   * @returns {Promise<void>}
   */
  function purgeBook(bookId) {
    if (!bookId) return Promise.resolve();
    // 1) 同步移出书架（触发立即重渲染，避免用户感知卡顿）
    try { remove(bookId); } catch (e) {}

    var isImported = bookId.indexOf('imported-') === 0;

    // 2) 书城下载书：仅移出书架，保留本地数据作为离线兜底（zl-data / 阅读进度 / 滚动位置）
    if (!isImported) {
      // 仍广播 purge-done 以保持事件契约一致（占用统计无需更新，因数据未清）
      return Promise.resolve().then(function () {
        try {
          win.dispatchEvent(new win.CustomEvent('bk-shelf-changed', {
            detail: { bookId: bookId, action: 'purge-done' }
          }));
        } catch (e) {}
      });
    }

    // 3) 导入书：彻底清理 localStorage 与 IndexedDB
    _purgeLocalStorageFor(bookId);

    var p;
    try {
      if (win.ImportManager && win.ImportManager.removeImportedBook) {
        p = Promise.resolve(win.ImportManager.removeImportedBook(bookId));
      } else {
        p = Promise.resolve();
      }
    } catch (e) {
      console.warn('[BKShelf] purgeBook 异步清理失败:', e);
      p = Promise.resolve();
    }

    return p.then(function () {
      try {
        win.dispatchEvent(new win.CustomEvent('bk-shelf-changed', {
          detail: { bookId: bookId, action: 'purge-done' }
        }));
      } catch (e) {}
    }).catch(function () {});
  }

  /**
   * 清理 localStorage 中与一本书关联的所有残留键：
   *   bk_lastread_ts:<id> / bk_progress:<id> / bk_scroll:<id> / bk_scroll:<id>/<chNum>… /
   *   若 bk_last_read 指向该书也清除。
   * 单条失败不影响其他键。
   * @param {string} bookId
   */
  function _purgeLocalStorageFor(bookId) {
    if (!bookId) return;
    var ls = win.localStorage;
    if (!ls) return;
    var prefixes = [
      'bk_lastread_ts:' + bookId,
      'bk_progress:' + bookId,
      'bk_scroll:' + bookId
    ];
    // 精确匹配的键直接删
    for (var i = 0; i < prefixes.length; i++) {
      try { ls.removeItem(prefixes[i]); } catch (e) {}
    }
    // bk_scroll:<bookId>/<chNum> 形式的键需要遍历删除
    var scrollPrefix = 'bk_scroll:' + bookId + '/';
    try {
      var keysToRemove = [];
      for (var j = ls.length - 1; j >= 0; j--) {
        var k = ls.key(j);
        if (k && k.indexOf(scrollPrefix) === 0) keysToRemove.push(k);
      }
      for (var m = 0; m < keysToRemove.length; m++) {
        try { ls.removeItem(keysToRemove[m]); } catch (e) {}
      }
    } catch (e) {}
    // bk_last_read：若指向该书则清除
    try {
      if (ls.getItem('bk_last_read') === bookId) ls.removeItem('bk_last_read');
    } catch (e) {}
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
   * 扫描所有 bk_shelf: 前缀键，返回记录数组。
   * 排序键 = max(入架时间 addedAtTs, 最近阅读时间 bk_lastread_ts) 倒序——最近加入或最近阅读的在最上面。
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
      // 1) 置顶优先：pinned 书永远排在最前
      var pa = (a.pinned === true) ? 1 : 0;
      var pb = (b.pinned === true) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      // 同为置顶：按 pinnedTs 倒序（先置顶的在前）
      if (pa && pb) {
        var pta = a.pinnedTs || 0, ptb = b.pinnedTs || 0;
        if (pta !== ptb) return ptb - pta;
      }
      // 2) 其余：最近加入 / 最近阅读 中更近者（ms 时间戳），倒序——最新的在最上面。
      var ta = (typeof a.addedAtTs === 'number') ? a.addedAtTs : 0;
      var tb = (typeof b.addedAtTs === 'number') ? b.addedAtTs : 0;
      var ka = Math.max(ta, _lastReadTs(a.bookId));
      var kb = Math.max(tb, _lastReadTs(b.bookId));
      if (ka !== kb) return kb - ka;
      // 兜底：同键（多为旧记录无时间戳），按 addedAt 日期字符串倒序。
      var sa = a.addedAt || '';
      var sb = b.addedAt || '';
      return sb.localeCompare(sa);
    });
    return records;
  }

  // 读取某本书的「最近阅读」时间戳（ms）；无记录返回 0。
  // 存储键 bk_lastread_ts:<bookId> 由阅读页写入（saveReadingProgress / 打开章节时）。
  function _lastReadTs(bookId) {
    try {
      var v = parseInt(win.localStorage.getItem('bk_lastread_ts:' + bookId) || '0', 10);
      return isNaN(v) ? 0 : v;
    } catch (e) { return 0; }
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
   * 置顶 / 取消置顶书籍。
   * 置顶写 pinned:true + pinnedTs；取消置顶删除该字段。
   * 列表主排序优先置顶（见 all()）。
   * @param {string} bookId
   * @param {boolean} pinned
   */
  function setPinned(bookId, pinned) {
    if (!bookId) return;
    var rec = get(bookId);
    if (!rec) {
      // 书不在架的极端情况：先入架再置顶
      rec = { bookId: bookId, addedAt: _today(), addedAtTs: Date.now(), note: null, rating: null, status: STATUS };
    }
    if (pinned) {
      rec.pinned = true;
      rec.pinnedTs = Date.now();
    } else {
      delete rec.pinned;
      delete rec.pinnedTs;
    }
    if (!rec.status) rec.status = STATUS;
    _safeSet(_key(bookId), JSON.stringify(rec));
    emitChanged(bookId, pinned ? 'pin' : 'unpin');
  }

  /**
   * 判定书籍是否置顶。
   * @param {string} bookId
   * @returns {boolean}
   */
  function isPinned(bookId) {
    var rec = get(bookId);
    return !!(rec && rec.pinned === true);
  }

  /**
   * 收藏 / 取消收藏书籍（独立于 finished 已读状态）。
   * 收藏写 favorite:true + favoriteTs；取消收藏删除该字段。
   * @param {string} bookId
   * @param {boolean} favorite
   */
  function setFavorite(bookId, favorite) {
    if (!bookId) return;
    var rec = get(bookId);
    if (!rec) {
      // 书不在架的极端情况：先入架再收藏
      rec = { bookId: bookId, addedAt: _today(), addedAtTs: Date.now(), note: null, rating: null, status: STATUS };
    }
    if (favorite) {
      rec.favorite = true;
      rec.favoriteTs = Date.now();
    } else {
      delete rec.favorite;
      delete rec.favoriteTs;
    }
    if (!rec.status) rec.status = STATUS;
    _safeSet(_key(bookId), JSON.stringify(rec));
    emitChanged(bookId, favorite ? 'favorite' : 'unfavorite');
  }

  /**
   * 判定书籍是否已收藏（favorite 标记，独立于 finished 已读）。
   * @param {string} bookId
   * @returns {boolean}
   */
  function isFavorite(bookId) {
    var rec = get(bookId);
    return !!(rec && rec.favorite === true);
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
   * @param {'add'|'finish'|'remove'|'unread'|'pin'|'unpin'|'favorite'|'unfavorite'|'note-update'|'rating-update'} action
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
    purgeBook: purgeBook,     // 移出书架 + 彻底清理本地数据（IndexedDB / localStorage 残留）
    markRead: markRead,
    unmarkRead: unmarkRead,    // 撤销「读完」：finished→false，移回在读
    finish: markRead,        // 别名：语义等价（标记已读）
    updateNote: updateNote,   // 独立更新笔记
    removeNote: removeNote,   // 独立删除笔记
    updateRating: updateRating, // 独立更新评分
    isRead: isRead,
    isCollected: isCollected,
    setPinned: setPinned,
    isPinned: isPinned,
    setFavorite: setFavorite,
    isFavorite: isFavorite,
    all: all,
    stats: stats,
    emitChanged: emitChanged
  };

})(window);
