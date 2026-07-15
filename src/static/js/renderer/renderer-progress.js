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

    var ratio = _getChapterScrollRatio();
    if (ratio >= _CHAPTER_READ_THRESHOLD) {
      // 已达阈值，正常标记
      _checkChapterScrollCompletion();
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

