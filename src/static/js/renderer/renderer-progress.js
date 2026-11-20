'use strict';

  // ── 阅读进度追踪 ─────────────────────────────────────────────────────

  // 章节滚动完成阈值：滚动到 80% 以上算读完该章
  var _CHAPTER_READ_THRESHOLD = 0.80;

  /**
   * 计算当前章节滚动完成比例 (0~1)。
   * 滚动容器为 carousel page 元素，比较 scrollTop / (scrollHeight - clientHeight)。
   */
  function _getChapterScrollRatio() {
    try {
      var c = _getScrollContainer();
      if (!c) return 0;
      var scrollTop = c.scrollTop || 0;
      var scrollH = c.scrollHeight || 1;
      var clientH = c.clientHeight || 1;
      var maxScroll = scrollH - clientH;
      if (maxScroll <= 0) return 1; // 内容不足一屏，视为 100%
      return Math.min(scrollTop / maxScroll, 1);
    } catch(e) { return 0; }
  }

  /**
   * 检查某章节是否已读（滚动超过阈值）。
   * 从 bk_chapter_read:<bookId>/<chNum> 读取标记。
   * 向后兼容：若无新标记但旧 bk_progress 覆盖该章节，视为已读。
   */
  function _isChapterReadByScroll(bookId, chNum) {
    try {
      if (localStorage.getItem('bk_chapter_read:' + bookId + '/' + chNum) === '1') return true;
      // 旧数据兼容：bk_progress 记录了用户读到的最大章号，chNum <= 该值则视为已读
      var oldProgress = parseInt(localStorage.getItem('bk_progress:' + bookId) || '0', 10);
      return chNum <= oldProgress;
    } catch(e) { return false; }
  }

  /**
   * 标记某章节为已读（滚动超过阈值时调用）。
   */
  function _markChapterReadByScroll(bookId, chNum) {
    try {
      localStorage.setItem('bk_chapter_read:' + bookId + '/' + chNum, '1');
    } catch(e) {}
  }

  /**
   * 计算某本书实际读完的章节数（基于滚动完成标记）。
   * 返回最大已读章节号（0 = 无已读章节）。
   */
  function _getMaxReadChapter(bookId) {
    var maxRead = 0;
    try {
      var book = _findBookById(bookId);
      var cc = (book && book.chapter_count) || 0;
      // 从高到低找最近一个已读章节
      for (var n = cc; n >= 1; n--) {
        if (_isChapterReadByScroll(bookId, n)) {
          maxRead = n;
          break;
        }
      }
    } catch(e) {}
    return maxRead;
  }

  /**
   * 滚动时检查当前章节是否已读满阈值，若是则标记章节已读
   * 并检查全书是否读完。
   */
  function _checkChapterScrollCompletion() {
    if (!_carouselBookId || !_carouselChapterNum) return;
    var ratio = _getChapterScrollRatio();
    if (ratio >= _CHAPTER_READ_THRESHOLD) {
      if (!_isChapterReadByScroll(_carouselBookId, _carouselChapterNum)) {
        _markChapterReadByScroll(_carouselBookId, _carouselChapterNum);
        // 检查全书是否读完
        _checkBookCompletion(_carouselBookId);
      }
    }
  }

  /**
   * 带重试的滚动完成度检查——用于章节切换后短章节/慢渲染场景。
   * 首次在下一帧检查，若 ratio 未达阈值但 scrollHeight 仍在增长则继续重试，
   * 最多重试 _MAX_SCROLL_RETRIES 次（约 1.5~2 秒），确保 DOM 渲染完成后再判定。
   */
  var _MAX_SCROLL_RETRIES = 8;
  var _scrollRetryTimer = null;

  function _retryCheckScrollCompletion(retryCount) {
    if (_scrollRetryTimer) { clearTimeout(_scrollRetryTimer); _scrollRetryTimer = null; }
    if (retryCount === 0) {
      // 首次等一帧，确保基本布局完成
      requestAnimationFrame(function() { _doScrollRetry(0); });
    } else {
      _doScrollRetry(retryCount);
    }
  }

  function _doScrollRetry(count) {
    if (!_carouselBookId || !_carouselChapterNum) return;
    var container = _getScrollContainer();
    if (!container) { if (count < _MAX_SCROLL_RETRIES) _scheduleRetry(count); return; }

    // 重试时同步顶部进度条：内容渲染可能使 scrollHeight 变化，
    // 短章节初始 maxScroll<=0 时 ratio=1 偏高，渲染完成后需修正
    try { _updateTopReadingProgress(); } catch(e) {}

    var ratio = _getChapterScrollRatio();
    if (ratio >= _CHAPTER_READ_THRESHOLD) {
      // ratio 达阈值，但需区分两种情况：
      //   a) 用户确实滚动了足够距离（maxScroll > 0）→ 正常标记
      //   b) maxScroll <= 0（_getChapterScrollRatio 返回 1）→ 内容可能尚未渲染，
      //      不能立即标记；继续重试等渲染完成，重试用尽后确认为短内容
      var _ms = (container.scrollHeight || 1) - (container.clientHeight || 1);
      if (_ms <= 0 && count < _MAX_SCROLL_RETRIES) {
        _scheduleRetry(count);
      } else {
        _checkChapterScrollCompletion();
      }
      return;
    }
    // ratio 未达阈值：内容可能仍在渲染（图片/字体），需要重试
    if (count < _MAX_SCROLL_RETRIES) {
      _scheduleRetry(count);
    } else {
      // 重试用尽，做最后一次检查
      _checkChapterScrollCompletion();
    }
  }

  function _scheduleRetry(count) {
    // 逐步增加间隔：100ms, 150ms, 200ms, 250ms, 300ms, 400ms, 500ms
    var delay = 100 + count * 50;
    _scrollRetryTimer = setTimeout(function() { _doScrollRetry(count + 1); }, delay);
  }

  /**
   * 检查一本书是否所有章节都已读完（基于滚动标记），若满足则自动标记全书已读。
   */
  function _checkBookCompletion(bookId) {
    try {
      var alreadyRead = (win.BKShelf && win.BKShelf.isRead) ? win.BKShelf.isRead(bookId) : false;
      if (alreadyRead) return;
      var cc = (_findBookById(bookId) || {}).chapter_count || 0;
      if (cc <= 0) return;
      // 需要每一个章节都读满阈值才算全书已读
      var allRead = true;
      for (var n = 1; n <= cc; n++) {
        if (!_isChapterReadByScroll(bookId, n)) {
          allRead = false;
          break;
        }
      }
      if (allRead && win.BKShelf && win.BKShelf.markRead) {
        win.BKShelf.markRead(bookId);
      }
    } catch(e) {}
  }

  /**
   * 检查所有已打开过的书的完成状态——用于书架渲染和续读列表，
   * 避免「进度100%但未标记已读」的不一致。
   */
  function _syncAllBookCompletion() {
    try {
      var books = _zlBooks || [];
      for (var i = 0; i < books.length; i++) {
        var b = books[i];
        var cc = b.chapter_count || 0;
        if (cc <= 0) continue;
        // 快速跳过已标记已读的
        if (win.BKShelf && win.BKShelf.isRead && win.BKShelf.isRead(b.id)) continue;
        // 检查是否有任意章节的已读标记（无则直接跳过，避免无效全遍历）
        var hasAny = false;
        for (var n = 1; n <= cc; n++) {
          if (_isChapterReadByScroll(b.id, n)) { hasAny = true; break; }
        }
        if (hasAny) _checkBookCompletion(b.id);
      }
    } catch(e) {}
  }

  function saveReadingProgress(bookId, chapterNum) {
    try {
      var key = 'bk_progress:' + bookId;
      localStorage.setItem(key, String(chapterNum));
      // 记录「最近阅读」时间戳（供书架按 max(入架,阅读) 排序置顶）
      localStorage.setItem('bk_lastread_ts:' + bookId, String(Date.now()));
    } catch(e) {}

    // 自动标记钩子已移至 _checkBookCompletion，由滚动完成度驱动。
    // 此处不再基于 chapterNum >= chapter_count 标记已读。
  }

  function getReadingProgress(bookId) {
    try {
      return parseInt(localStorage.getItem('bk_progress:' + bookId) || '0', 10);
    } catch(e) { return 0; }
  }

  // ── 页面顶部阅读进度条（#bkReadingProgress） ──────────────────────────
  //
  // 语义：按「页面是否在顶部」自动切换显示内容
  //   - 页面在顶部（未滚动 / 刚切章）：显示「全书进度」——
  //     当前章在整本书章节列表中的位置（idx/total，0~100%）
  //   - 滚动离开顶部：显示「章内滚动进度」——当前章滚动完成度（0~100%），
  //     滚到本章结尾即 100%（读满本章即满格）
  // 离开阅读视图时清零，避免残留。
  //
  function _updateTopReadingProgress() {
    var prog = document.getElementById('bkReadingProgress');
    if (!prog) return;

    // 非阅读页：清零并交给 index.html 的 window 滚动逻辑
    if (!document.body.classList.contains('bk-reading-page')) {
      prog.style.width = '0%';
      return;
    }

    var total = (_carouselUniqueChapters && _carouselUniqueChapters.length) || 0;
    if (total <= 0 || !_carouselChapterNum) { prog.style.width = '0%'; return; }

    // 当前章节在去重列表中的索引（0-based）
    var idx = 0;
    for (var i = 0; i < _carouselUniqueChapters.length; i++) {
      if (_carouselUniqueChapters[i].number === _carouselChapterNum) { idx = i; break; }
    }

    var pct;
    var container = _getScrollContainer();
    var scrollTop = (container && container.scrollTop) || 0;
    if (scrollTop <= 1) {
      // 页面在顶部：显示全书进度（当前章在全书中的位置）
      pct = (idx / total) * 100;
    } else {
      // 滚动离开顶部：显示章内滚动进度（0~100%）
      var ratio = _getChapterScrollRatio();
      if (ratio < 0) ratio = 0; else if (ratio > 1) ratio = 1;
      pct = ratio * 100;
    }
    if (pct < 0) pct = 0; else if (pct > 100) pct = 100;
    prog.style.width = pct + '%';
  }

  // ── 阅读时长统计 ─────────────────────────────────────────────────────
  //
  // 语义：用户停留在阅读视图、页面可见且无全屏搜索浮层时的时长。
  //   - 进入阅读视图（renderReadingView）开启会话，退出（_exitReadingView）结束；
  //   - 切后台 / 页面隐藏 / 打开搜索浮层 / 离开阅读页 → 暂停，恢复后重新起算；
  //   - 每 10s tick 跑一次状态机（engaged→累计 / 失焦→暂停），时钟差而非定时器
  //     次数，规避后台定时器挂起；visibilitychange 与 Capacitor AppLifecycle
  //     仅作「立即暂停/恢复」的快路径（双触发幂等）；
  //   - 累计 ≥60s 批量落盘，pagehide / beforeunload 兜底结算落盘；
  //   - 单次对账最大计入 120s，防止休眠/挂起后的巨额跳变。
  // 存储：bk_readtime_total（累计秒数）、bk_readtime_day:<YYYY-MM-DD>（当日秒数，
  //   会话启动时清理 30 天前的旧日键）。

  var _READTIME_KEY_TOTAL = 'bk_readtime_total';
  var _READTIME_KEY_DAY = 'bk_readtime_day:';
  var _READTIME_TICK_MS = 10000;     // 对账间隔
  var _READTIME_FLUSH_MS = 60000;    // 落盘阈值
  var _READTIME_MAX_DELTA = 120000;  // 单次对账最大计入（防跳变）
  var _READTIME_DAY_KEEP = 30;       // 日键保留天数

  var _readTimeSession = null;   // { bookId, lastTs, pendingMs }；lastTs=0 表示暂停态
  var _readTimeTimer = null;
  var _readTimeClock = Date.now;  // 时钟（测试可注入受控时钟驱动对账）
  var _readTimeLifecycleBound = false; // AppLifecycle 快路径是否已注册（惰性，晚加载）

  function _readTimeNow() { return _readTimeClock(); }

  function _readTimeDayKey() {
    var d = new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  /**
   * 当前是否处于「计入时长」状态：
   * 页面可见 + 位于阅读视图（bk-reading-page）+ 无全屏搜索浮层。
   * 任一条件不满足即暂停（MarkPanel 目录/设置面板等书内面板仍视为阅读中）。
   */
  function _readTimeEngaged() {
    try {
      if (document.visibilityState === 'hidden') return false;
      if (!document.body.classList.contains('bk-reading-page')) return false;
      var so = document.querySelector('.bk-search-overlay');
      if (so) {
        var disp = (win.getComputedStyle ? win.getComputedStyle(so).display : so.style.display) || '';
        if (disp !== 'none') return false;
      }
    } catch (e) { /* 环境异常兜底视为计入 */ }
    return true;
  }

  /** 读取累计阅读时长（秒） */
  function _getTotalReadTimeSecs() {
    try { return parseInt(localStorage.getItem(_READTIME_KEY_TOTAL) || '0', 10) || 0; } catch (e) { return 0; }
  }

  /** 读取当日阅读时长（秒） */
  function _getTodayReadTimeSecs() {
    try { return parseInt(localStorage.getItem(_READTIME_KEY_DAY + _readTimeDayKey()) || '0', 10) || 0; } catch (e) { return 0; }
  }

  /** 清理 30 天前的旧日键（会话启动时执行一次） */
  function _pruneOldReadTimeDays() {
    try {
      var ls = localStorage;
      var cutoff = _readTimeNow() - _READTIME_DAY_KEEP * 86400000;
      var remove = [];
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (!k || k.indexOf(_READTIME_KEY_DAY) !== 0) continue;
        var dayStr = k.substring(_READTIME_KEY_DAY.length);
        var t = Date.parse(dayStr);
        if (!isNaN(t) && t < cutoff) remove.push(k);
      }
      for (var j = 0; j < remove.length; j++) ls.removeItem(remove[j]);
    } catch (e) {}
  }

  /** 结算 lastTs 以来的增量并推进基准（仅在 engaged 时调用；lastTs=0 时增量为 0） */
  function _readTimeSettle(now) {
    var s = _readTimeSession;
    if (!s || !now) return;
    var delta = now - (s.lastTs || now);
    if (delta > 0 && delta <= _READTIME_MAX_DELTA) {
      s.pendingMs = (s.pendingMs || 0) + delta;
    }
    s.lastTs = now;
  }

  /** 暂停：结算尾款并落盘，lastTs 归零（幂等：重复调用无副作用） */
  function _readTimePause() {
    var s = _readTimeSession;
    if (!s || !s.lastTs) { if (s) _flushReadTime(); return; }
    var delta = _readTimeNow() - s.lastTs;
    if (delta > 0 && delta <= _READTIME_MAX_DELTA) {
      s.pendingMs = (s.pendingMs || 0) + delta;
    }
    _flushReadTime();
    s.lastTs = 0;
  }

  /** 恢复：重置对账基准（幂等：仅 lastTs=0 时生效） */
  function _readTimeResume() {
    var s = _readTimeSession;
    if (s && !s.lastTs) s.lastTs = _readTimeNow();
  }

  /** pending 落盘：写入总计 + 当日 */
  function _flushReadTime() {
    var s = _readTimeSession;
    if (!s) return;
    var ms = s.pendingMs || 0;
    s.pendingMs = 0;
    if (ms < 1000) return;
    try {
      var secs = Math.floor(ms / 1000);
      localStorage.setItem(_READTIME_KEY_TOTAL, String(_getTotalReadTimeSecs() + secs));
      var dayKey = _READTIME_KEY_DAY + _readTimeDayKey();
      var daySecs = parseInt(localStorage.getItem(dayKey) || '0', 10) || 0;
      localStorage.setItem(dayKey, String(daySecs + secs));
    } catch (e) {}
  }

  /**
   * 定时对账状态机：
   *   engaged →（lastTs=0 时先恢复基准）结算增量，达阈值落盘；
   *   失焦（后台/搜索浮层/离开阅读页）→ 结算尾款并暂停。
   * 搜索浮层无开合事件可挂，靠此轮询完成暂停/恢复。
   */
  function _readTimeTick() {
    var s = _readTimeSession;
    if (!s) return;
    if (_readTimeEngaged()) {
      if (!s.lastTs) { s.lastTs = _readTimeNow(); return; }
      _readTimeSettle(_readTimeNow());
      if ((s.pendingMs || 0) >= _READTIME_FLUSH_MS) _flushReadTime();
    } else if (s.lastTs) {
      _readTimePause();
    }
  }

  /** AppLifecycle 快路径（Capacitor 原生前后台信号；惰性注册，app-lifecycle.js 晚于本文件加载） */
  function _ensureReadTimeLifecycleHooks() {
    if (_readTimeLifecycleBound) return;
    var AL = win.BK && win.BK.AppLifecycle;
    if (!AL || !AL.onBackground || !AL.onForeground) return;
    _readTimeLifecycleBound = true;
    // 双触发幂等：pause 重复调用无副作用（lastTs=0 → 不重复结算），resume 仅 lastTs=0 时生效
    AL.onBackground(function () { _readTimePause(); });
    AL.onForeground(function () { _readTimeResume(); });
  }

  /** 开启（或延续）阅读时长会话；同书重复进入视为同一会话（先结算已历时长） */
  function _startReadTimeSession(bookId) {
    _ensureReadTimeLifecycleHooks();
    if (_readTimeSession && _readTimeSession.bookId === bookId) {
      if (_readTimeEngaged()) _readTimeSettle(_readTimeNow());
      return;
    }
    _stopReadTimeSession();
    _pruneOldReadTimeDays();
    // 后台/搜索浮层中开书：以暂停态起步，恢复时由 tick/事件重置基准
    _readTimeSession = { bookId: bookId, lastTs: _readTimeEngaged() ? _readTimeNow() : 0, pendingMs: 0 };
    if (_readTimeTimer) clearInterval(_readTimeTimer);
    _readTimeTimer = setInterval(_readTimeTick, _READTIME_TICK_MS);
  }

  /** 结束会话：结算尾款并落盘 */
  function _stopReadTimeSession() {
    if (!_readTimeSession) return;
    if (_readTimeSession.lastTs) {
      var delta = _readTimeNow() - _readTimeSession.lastTs;
      if (delta > 0 && delta <= _READTIME_MAX_DELTA) {
        _readTimeSession.pendingMs = (_readTimeSession.pendingMs || 0) + delta;
      }
    }
    _flushReadTime();
    _readTimeSession = null;
    if (_readTimeTimer) { clearInterval(_readTimeTimer); _readTimeTimer = null; }
  }

  // 可见性变化快路径：切后台立即暂停，回前台立即恢复（与 tick 状态机互补）
  document.addEventListener('visibilitychange', function () {
    if (!_readTimeSession) return;
    if (document.visibilityState === 'hidden') _readTimePause();
    else _readTimeResume();
  });
  // 页面卸载兜底：结算尾款并落盘（幂等：暂停态/隐藏态下重复调用无副作用）
  win.addEventListener('pagehide', function () { if (_readTimeSession) _readTimePause(); });
  win.addEventListener('beforeunload', function () { if (_readTimeSession) _readTimePause(); });

  // 挂载到 BKStats（命名空间定义于 renderer-utils.js，先于本文件加载）
  if (win.BKStats) {
    win.BKStats.getTotalReadSecs = _getTotalReadTimeSecs;
    win.BKStats.getTodayReadSecs = _getTodayReadTimeSecs;
    win.BKStats.startReadingTime = _startReadTimeSession;
    win.BKStats.stopReadingTime = _stopReadTimeSession;
    // 测试钩子：注入受控时钟驱动对账/落盘
    win.BKStats.__test = {
      settle: _readTimeSettle,
      flush: _flushReadTime,
      tick: _readTimeTick,
      pause: _readTimePause,
      resume: _readTimeResume,
      engaged: _readTimeEngaged,
      session: function () { return _readTimeSession; },
      setClock: function (fn) { _readTimeClock = (typeof fn === 'function') ? fn : Date.now; }
    };
  }

