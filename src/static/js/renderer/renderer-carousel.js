'use strict';

  // ── 三页轮播（carousel swipe） ────────────────────────────────────────
  //
  // 三页轮播：track 包含 prev/curr/next 三个 page，translateX(-33.333%) 居中当前页。
  // 滑动时直接 translate track，松手后动画完成 → 重排 DOM → 重置 translateX。
  // 每次路由跳转重新渲染 carousel 以确保数据准确。

  var _carouselBookId = null;
  var _carouselChapterNum = null;
  var _carouselUniqueChapters = null;
  var _carouselPages = null;   // { prev, curr, next } 三个 DOM 元素
  var _carouselTrack = null;
  var _swipeState = null;
  var _swipeHandlers = null;
  var _swipeEl = null;
  var _swipeAnimating = false;  // 动画进行中，拒绝新滑动手势
  var _carouselResizeHandler = null;  // 视口变化重算 transform 的防抖处理器
  var _carouselResizeTimer = null;    // 防抖定时器（模块级，_removeSwipeHandler 中需 clearTimeout）
  var SWIPE_THRESHOLD = 80;
  var SWIPE_MAX_VERTICAL = 60;
  var SWIPE_DURATION = 280;

  // 生成单个 carousel page 的 HTML
  function _renderCarouselPage(chapter, pageId) {
    var html = '<div class="bk-carousel-page" id="carouselPage' + pageId + '">';
    html += '<div class="content" id="carouselContent' + pageId + '">';
    if (chapter) {
      html += renderChapterContent(chapter, true);
    }
    html += '</div></div>';
    return html;
  }

  // 获取指定章节号对应的 chapter 对象
  function _getChapter(uniqueChapters, num) {
    if (!uniqueChapters || num == null) return null;
    for (var i = 0; i < uniqueChapters.length; i++) {
      if (uniqueChapters[i].number === num) return uniqueChapters[i];
    }
    return null;
  }

  // 获取当前章节在列表中的索引
  function _getChapterIndex(uniqueChapters, num) {
    for (var i = 0; i < uniqueChapters.length; i++) {
      if (uniqueChapters[i].number === num) return i;
    }
    return -1;
  }

  // 获取相邻章节号
  function _getAdjacentChapterNum(uniqueChapters, currentNum, direction) {
    var idx = _getChapterIndex(uniqueChapters, currentNum);
    if (idx < 0) return null;
    var targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= uniqueChapters.length) return null;
    return uniqueChapters[targetIdx].number;
  }

  // 填充 carousel page 的内容
  function _fillCarouselPage(pageEl, chapter) {
    var contentEl = pageEl.querySelector('.content');
    if (!contentEl) return;
    if (chapter) {
      // 相邻预览页同样需要 eager 加载，避免滑动时才去 lazy 加载而显示空白
      contentEl.innerHTML = renderChapterContent(chapter, true);
      initPdfPageLazyRender(contentEl);
      _applyMdEnhancements(contentEl);
    } else {
      contentEl.innerHTML = '';
    }
  }

  // 滑动完成后重排页面（先重置位置，再移动 DOM，避免中间帧闪烁）
  function _reorderCarousel(direction) {
    if (!_carouselTrack || !_carouselPages) return;
    var prev = _carouselPages.prev;
    var curr = _carouselPages.curr;
    var next = _carouselPages.next;

    // 先重置 translateX 到居中位置，再移动 DOM，
    // 避免先移 DOM 后设 translate 时浏览器在两步之间产生一帧位置跳动
    var pageW = _carouselTrack.parentElement.offsetWidth;
    _carouselTrack.style.transform = 'translateX(' + (-pageW) + 'px)';

    if (direction === 1) {
      // 下一章：prev=旧curr, curr=旧next, next=新下一章
      _carouselTrack.appendChild(prev);
      _carouselPages = { prev: curr, curr: next, next: prev };
    } else {
      // 上一章：prev=新上一章, curr=旧prev, next=旧curr
      _carouselTrack.insertBefore(next, prev);
      _carouselPages = { prev: next, curr: prev, next: curr };
    }

    // 交换内容容器 ID：新 curr 必须是 chapterContent（承载 padding/字号样式）
    // 注意：初始当前页的 id 是 "chapterContent"（非 carouselContent 前缀），
    // 一旦被移除会拿不回 [id^="carouselContent"]，故统一用 .content 定位容器
    var oldCurrContent = curr.querySelector('.content');
    var newCurrContent = _carouselPages.curr.querySelector('.content');
    if (oldCurrContent) {
      oldCurrContent.removeAttribute('id');
    }
    if (newCurrContent) {
      newCurrContent.id = 'chapterContent';
    }
  }

  // 更新相邻页面内容
  function _updateAdjacentPages(bookId, uniqueChapters, chapterNum) {
    var prevNum = _getAdjacentChapterNum(uniqueChapters, chapterNum, -1);
    var nextNum = _getAdjacentChapterNum(uniqueChapters, chapterNum, 1);
    var prevChapter = prevNum != null ? _getChapter(uniqueChapters, prevNum) : null;
    var nextChapter = nextNum != null ? _getChapter(uniqueChapters, nextNum) : null;
    if (_carouselPages) {
      _fillCarouselPage(_carouselPages.prev, prevChapter);
      _fillCarouselPage(_carouselPages.next, nextChapter);
    }
  }

  function _installCarouselSwipe(bookId, uniqueChapters, chapterNum) {
    _removeSwipeHandler();

    var track = document.querySelector('.bk-carousel-track');
    if (!track) return;
    _carouselTrack = track;
    _carouselBookId = bookId;
    _carouselChapterNum = chapterNum;
    _carouselUniqueChapters = uniqueChapters;

    var pages = track.querySelectorAll('.bk-carousel-page');
    if (pages.length !== 3) return;
    _carouselPages = { prev: pages[0], curr: pages[1], next: pages[2] };

    // 用像素精确设定静止位置，与滑动手势的像素定位保持一致，避免亚像素跳动
    if (track.parentElement) {
      var pageW0 = track.parentElement.offsetWidth || win.innerWidth || 0;
      track.style.transform = 'translateX(' + (-pageW0) + 'px)';
    }

    function onTouchStart(e) {
      if (e.touches.length > 1) return;
      if (_swipeAnimating) return;   // 动画进行中不响应新滑动
      // PDF 单页横向滑动模式下手势冲突避让：
      // .bk-pdf-single 容器自身是横向 scroll-snap 容器，需要横向手势翻 PDF 页。
      // carousel 若抢夺 touchmove + preventDefault 会阻止 PDF 翻页，导致横滑切章而非翻页。
      // 此处直接放弃建立 swipeState，让 PDF 容器自己处理横向滚动；
      // 连续模式（无 .bk-pdf-single class）下 carousel 行为不受影响。
      if (e.target && e.target.closest && (e.target.closest('.bk-pdf-single') || e.target.closest('.bk-pdf-continuous-view'))) return;
      var t = e.touches[0];
      _swipeState = {
        startX: t.clientX,
        startY: t.clientY,
        startTime: Date.now(),
        active: false,
        rejected: false
      };
    }

    function onTouchMove(e) {
      if (!_swipeState || _swipeState.rejected || e.touches.length > 1) return;
      var t = e.touches[0];
      var dx = t.clientX - _swipeState.startX;
      var dy = t.clientY - _swipeState.startY;

      if (!_swipeState.active) {
        if (Math.abs(dy) > SWIPE_MAX_VERTICAL) { _swipeState.rejected = true; return; }
        if (Math.abs(dx) < 15) return;
        if (Math.abs(dx) <= Math.abs(dy)) { _swipeState.rejected = true; return; }
        _swipeState.active = true;
        track.classList.add('bk-swipe-active');
        track.style.transition = 'none';
      }

      // 事件可能已被浏览器锁定为滚动（cancelable=false），此时 preventDefault 无效且会刷警告
      if (e.cancelable) e.preventDefault();
      var pageW = track.parentElement.offsetWidth;
      // 用像素定位，避免 -33.333% 这类重复小数产生亚像素抖动
      var px = dx;

      // 从共享状态读取，而非闭包变量，以便 finish() 更新后立即生效
      var _chNum = _carouselChapterNum;
      var _uChs = _carouselUniqueChapters;
      var isAtStart = _chNum <= (_uChs[0] ? _uChs[0].number : 0);
      var isAtEnd = _chNum >= (_uChs[_uChs.length - 1] ? _uChs[_uChs.length - 1].number : 0);
      if ((dx > 0 && isAtStart) || (dx < 0 && isAtEnd)) {
        px *= 0.25;
      }
      track.style.transform = 'translateX(' + (-pageW + px) + 'px)';
      var pct = pageW ? (px / pageW) : 0; // 当前已滑动的页面比例（-1~1 之间）
      _swipeState.currentPct = pct;
      _swipeState.currentDx = dx;
    }

    function onTouchEnd() {
      if (!_swipeState) return;
      var state = _swipeState;
      _swipeState = null;

      if (!state.active) return;

      track.classList.remove('bk-swipe-active');
      var dx = state.currentDx || 0;
      var pct = state.currentPct || 0;
      var elapsed = Date.now() - state.startTime;
      var velocity = Math.abs(dx) / elapsed;
      var pageW = track.parentElement.offsetWidth;

      var shouldNavigate = Math.abs(dx) > SWIPE_THRESHOLD || (velocity > 0.4 && Math.abs(dx) > 30);
      var direction = dx > 0 ? -1 : 1; // -1=上一章, 1=下一章
      // 从共享状态读取，而非闭包变量
      var targetNum = _getAdjacentChapterNum(_carouselUniqueChapters, _carouselChapterNum, direction);

      if (shouldNavigate && targetNum != null) {
        _swipeAnimating = true;  // 加锁：动画期间拒绝新滑动手势
        // 动画滑到相邻页（用像素定位，避免亚像素抖动）
        var targetPx = direction === -1 ? 0 : -2 * pageW;
        track.style.transition = 'transform ' + SWIPE_DURATION + 'ms ease-out';
        track.style.transform = 'translateX(' + targetPx + 'px)';

        // 用 transitionend 在动画恰好结束时重排，避免 setTimeout 与动画不同步造成跳帧抖动
        // 注意：transitionend 会冒泡，子元素（.scripture-ref / .bk-highlight 等）自身的过渡
        // 也会冒泡到 track 并误触发 finish()，导致在滑动动画未完成时就重排/复位。
        // 因此必须过滤：仅当事件目标是 track 自身且属性为 transform 时才执行。
        var finished = false;
        function finish(e) {
          if (finished) return;
          // 由 transitionend 触发时，必须确认是 track 自己的 transform 过渡，忽略子元素冒泡
          if (e && (e.target !== track || e.propertyName !== 'transform')) return;
          finished = true;
          track.removeEventListener('transitionend', finish);
          track.style.transition = 'none';
          _reorderCarousel(direction);

          // 更新共享状态（事件处理器从 _carouselXxx 读取，无需重新绑定）
          _carouselChapterNum = targetNum;

          // 新 curr 已在之前的 _fillCarouselPage / 初始渲染中包含正确的相邻章节内容，
          // 无需重新 innerHTML 替换（这会导致内容闪烁和 justify-content 重新布局的跳动）。
          // 但仍需触发依赖 DOM 的懒加载和初始化：
          var newChapter = _getChapter(_carouselUniqueChapters, targetNum);
          var contentEl = document.getElementById('chapterContent');
          if (contentEl) {
            initPdfPageLazyRender(contentEl);
          }
          // 更新相邻页面（新的 prev/next 需要填充新章节的前后内容）
          _updateAdjacentPages(_carouselBookId, _carouselUniqueChapters, targetNum);

          // 更新 URL（不触发 router 重新渲染）
          // 用 try/finally 保证 _carouselNavigating 一定复位，避免 navigate 抛异常时
          // 标志位卡死为 true，导致后续 renderReadingView 全部 early-return、carousel 被冻结
          _carouselNavigating = true;
          try {
            if (win.BKRouter) {
              win.BKRouter.navigate(_carouselBookId + '/' + targetNum);
            } else {
              win.location.hash = '#/' + _carouselBookId + '/' + targetNum;
            }
          } finally {
            _carouselNavigating = false;
          }

          // 更新缓存的标题和进度
          BKRenderer._currentChapterTitle = newChapter ? (newChapter.title || '') : '';
          // 切章前先检查旧章节的滚动完成度（可能触发章节已读标记）
          _checkChapterScrollCompletion();
          saveReadingProgress(_carouselBookId, targetNum);
          document.title = (BKRenderer._currentBookTitle || '') + ' - ' + (newChapter ? (newChapter.title || '第' + targetNum + '章') : '');

          // 同步浮动顶栏标题（若正显示），避免滑动切章后顶栏残留旧章名
          if (win.BKNavStack && win.BKNavStack.refresh) win.BKNavStack.refresh();

          // 更新进度条（基于滚动完成标记的实际已读章节数）
          var progressBar = document.querySelector('.bk-reading-progress-bar');
          if (progressBar) {
            var totalChapters = _carouselUniqueChapters.length;
            var _readCnt = 0;
            for (var _pci = 1; _pci <= totalChapters; _pci++) {
              if (_isChapterReadByScroll(_carouselBookId, _pci)) _readCnt++;
            }
            var progressPct = totalChapters > 0 ? Math.round(_readCnt / totalChapters * 100) : 0;
            progressBar.style.width = progressPct + '%';
          }

          // 保存"被滑走"的旧章节滚动位置（reorder 后旧当前页已变为 prev）
          if (_carouselPages && _carouselPages.prev) {
            try { localStorage.setItem('bk_scroll:' + _scrollPageKey, String(_carouselPages.prev.scrollTop || 0)); } catch(e) {}
          }

          // 切到新章节：滚动容器复位到顶部（页内滚动，不再依赖 window）
          var _sc = _getScrollContainer();
          if (_sc === win) win.scrollTo(0, 0);
          else _sc.scrollTop = 0;

          // 切章后同步顶部进度条：跳到「当前章节在书中位置」的段位（ratio=0）
          try { _updateTopReadingProgress(); } catch(e) {}

          // 重新初始化依赖 DOM 的功能
          if (win.BKHighlight && win.BKHighlight.rendoHighlights) win.BKHighlight.rendoHighlights();
          if (win.BKScripturePopup && win.BKScripturePopup.init) win.BKScripturePopup.init();
          _applyMdEnhancements(document.getElementById('chapterContent'));

          // 滚动监听改挂到新的当前页（reorder 后 curr 已是新章节元素），
          // 并以新章节 pageKey 记录滚动位置
          _scrollPageKey = _carouselBookId + '/' + targetNum;
          if (_scrollSaveHandler) {
            var _oldT = _scrollTarget || win;
            _oldT.removeEventListener('scroll', _scrollSaveHandler);
            _scrollTarget = _getScrollContainer();
            _scrollTarget.addEventListener('scroll', _scrollSaveHandler, { passive: true });
          }

          // 新章节可能内容很短无需滚动即可完成，延迟检查
          // 使用带重试的检查，防止内容尚未渲染时 maxScroll<=0 误判为已读满
          setTimeout(function() { _retryCheckScrollCompletion(0); }, 500);

          // 不再调用 _installCarouselSwipe() 重新绑定事件（这会产生事件真空期，
          // 导致快速连续滑动时手势丢失）。共享状态 _carouselXxx 已在上方更新，
          // 事件处理器直接从共享状态读取，无需重建闭包。

          _swipeAnimating = false;  // 解锁：允许下一次滑动手势
        }
        track.addEventListener('transitionend', finish);
        setTimeout(finish, SWIPE_DURATION + 80); // 兜底：防止 transitionend 未触发
      } else {
        // 回弹
        track.style.transition = 'transform ' + (SWIPE_DURATION * 0.6) + 'ms ease-out';
        track.style.transform = 'translateX(' + (-pageW) + 'px)';
        setTimeout(function () {
          track.style.transition = 'none';
        }, SWIPE_DURATION * 0.6);
      }
    }

    _swipeHandlers = { touchstart: onTouchStart, touchmove: onTouchMove, touchend: onTouchEnd };
    var readingView = document.getElementById('readingView');
    if (readingView) {
      readingView.addEventListener('touchstart', onTouchStart, { passive: true });
      readingView.addEventListener('touchmove', onTouchMove, { passive: false });
      readingView.addEventListener('touchend', onTouchEnd, { passive: true });
      _swipeEl = readingView;
    }

    // 响应式：视口尺寸变化时重算 track translateX
    // 场景：桌面端窗口宽度变化、手机旋转屏幕、双栏 ↔ 单栏切换。
    // 不重算会导致 carousel 当前页偏移（track 仍按旧 pageW 平移，新视口下页宽已变）。
    if (_carouselResizeHandler) {
      win.removeEventListener('resize', _carouselResizeHandler);
      win.removeEventListener('orientationchange', _carouselResizeHandler);
    }
    _carouselResizeHandler = function () {
      if (_carouselResizeTimer) clearTimeout(_carouselResizeTimer);
      _carouselResizeTimer = setTimeout(function () {
        // 动画进行中跳过，避免打断滑动切章
        if (_swipeAnimating) { _carouselResizeTimer = null; return; }
        if (_carouselTrack && _carouselTrack.parentElement) {
          var pageW = _carouselTrack.parentElement.offsetWidth;
          _carouselTrack.style.transition = 'none';
          _carouselTrack.style.transform = 'translateX(' + (-pageW) + 'px)';
        }
        _carouselResizeTimer = null;
      }, 200);
    };
    win.addEventListener('resize', _carouselResizeHandler);
    win.addEventListener('orientationchange', _carouselResizeHandler);
  }

  function _removeSwipeHandler() {
    if (_swipeHandlers && _swipeEl) {
      _swipeEl.removeEventListener('touchstart', _swipeHandlers.touchstart);
      _swipeEl.removeEventListener('touchmove', _swipeHandlers.touchmove);
      _swipeEl.removeEventListener('touchend', _swipeHandlers.touchend);
      _swipeEl.classList.remove('bk-swipe-active');
      _swipeEl.style.transition = '';
      _swipeEl.style.transform = '';
    }
    _swipeHandlers = null;
    _swipeState = null;
    _swipeEl = null;

    // 移除响应式监听器，避免离开阅读视图后仍触发
    if (_carouselResizeHandler) {
      win.removeEventListener('resize', _carouselResizeHandler);
      win.removeEventListener('orientationchange', _carouselResizeHandler);
      _carouselResizeHandler = null;
    }
    // 清除待执行的 resize 定时器，避免切章后旧定时器操作新页面
    if (_carouselResizeTimer) {
      clearTimeout(_carouselResizeTimer);
      _carouselResizeTimer = null;
    }
  }

  // 防止 carousel 内部导航触发 router 重复渲染
  var _carouselNavigating = false;

