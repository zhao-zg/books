/*!
 * pdf-search.js - PDF 全文搜索
 *
 * 职责：
 *   - 全文搜索（遍历所有页的 textLayer）
 *   - 关键词高亮（在 textLayer 上叠加高亮层）
 *   - 上一个/下一个匹配项跳转
 *   - 搜索进度显示（大 PDF 搜索耗时）
 *
 * 依赖：pdf-state.js, pdf-core.js, pdf-navigator.js
 * 挂载：window.BKPdf._internal.search
 */
(function (win) {
  'use strict';

  var doc = win.document;
  var S = win.BKPdf._internal.state;
  var core = win.BKPdf._internal.core;

  // ==================== 状态 ====================

  var _searchBar = null;
  var _searchInput = null;
  var _searchResults = null;
  var _searchCancelBtn = null;
  var _isVisible = false;
  var _matches = [];          // [{ pageNum, textLayer, span, text }]
  var _currentMatchIdx = -1;
  var _isSearching = false;
  var _searchAbort = null;

  // ==================== 容器范围辅助 ====================

  /**
   * 获取当前激活的 PDF 容器（连续模式：#bkPdfContinuousView；单页模式：document）
   * 避免在连续模式下命中 carousel 中隐藏的同 pageNum 占位元素
   */
  function _getActiveRoot() {
    if (S.mode() === S.MODE_CONTINUOUS) {
      var cv = doc.getElementById('bkPdfContinuousView');
      if (cv) return cv;
    }
    // Bug11: Reflow 模式下搜索范围是 Reflow 容器
    if (S.mode() === S.MODE_REFLOW) {
      var reflow = win.BKPdf._internal.reflow;
      if (reflow && reflow.container && reflow.container()) {
        return reflow.container();
      }
    }
    return doc;
  }

  /** 获取当前范围内所有 .bk-pdf-page */
  function _getAllPages() {
    return _getActiveRoot().querySelectorAll('.bk-pdf-page');
  }

  /** 按页码获取当前范围内的 page 元素 */
  function _getPageByNum(pageNum) {
    return _getActiveRoot().querySelector('.bk-pdf-page[data-pdf-page="' + pageNum + '"]');
  }

  // ==================== 创建搜索栏 ====================

  function _createSearchBar() {
    if (_searchBar) return _searchBar;
    var bar = doc.createElement('div');
    bar.className = 'bk-pdf-search-bar';
    bar.innerHTML =
      '<div class="bk-pdf-search-row">' +
        '<input type="text" class="bk-pdf-search-input" placeholder="搜索 PDF 内容…" autocomplete="off">' +
        '<button class="bk-pdf-search-cancel" aria-label="取消搜索" hidden>✕取消</button>' +
        '<button class="bk-pdf-search-prev" aria-label="上一个">↑</button>' +
        '<button class="bk-pdf-search-next" aria-label="下一个">↓</button>' +
        '<button class="bk-pdf-search-close" aria-label="关闭">✕</button>' +
      '</div>' +
      '<div class="bk-pdf-search-info"></div>';
    doc.body.appendChild(bar);

    _searchBar = bar;
    _searchInput = bar.querySelector('.bk-pdf-search-input');
    _searchResults = bar.querySelector('.bk-pdf-search-info');
    _searchCancelBtn = bar.querySelector('.bk-pdf-search-cancel');

    // 事件
    var inputTimer = null;
    if (_searchInput) {
      _searchInput.addEventListener('input', function (e) {
        if (inputTimer) clearTimeout(inputTimer);
        inputTimer = setTimeout(function () {
          doSearch(e.target.value);
        }, 400);
      });
      _searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (_matches.length) goToNext();
        } else if (e.key === 'Escape') {
          if (_isSearching) {
            _cancelSearch();
          } else {
            hide();
          }
        }
      });
    }

    var prevBtn = bar.querySelector('.bk-pdf-search-prev');
    if (prevBtn) prevBtn.addEventListener('click', goToPrev);

    var nextBtn = bar.querySelector('.bk-pdf-search-next');
    if (nextBtn) nextBtn.addEventListener('click', goToNext);

    var closeBtn = bar.querySelector('.bk-pdf-search-close');
    if (closeBtn) closeBtn.addEventListener('click', function () {
      if (_isSearching) _cancelSearch();
      hide();
    });

    if (_searchCancelBtn) {
      _searchCancelBtn.addEventListener('click', function () {
        _cancelSearch();
        _updateInfo('已取消');
      });
    }

    return bar;
  }

  // ==================== 搜索逻辑 ====================

  /**
   * 执行搜索
   * 连续模式下使用 pdf.js getTextContent API 全量搜索（不依赖 DOM 已渲染），
   * 单页模式下仍使用 DOM textLayer span 搜索（页面已渲染）
   */
  function doSearch(query) {
    // 取消上一次搜索
    _cancelSearch();
    _clearHighlights();

    if (!query || !query.trim()) {
      _updateInfo('');
      _matches = [];
      _currentMatchIdx = -1;
      return;
    }

    query = query.trim();
    var bookId = S.currentBookId();
    if (!bookId) return;

    _isSearching = true;
    _updateInfo('搜索中…');
    _matches = [];
    _currentMatchIdx = -1;

    // 连续模式 / Reflow 模式：使用 pdf.js API 全量搜索（覆盖未渲染页）
    // Bug11 修复：Reflow 模式无 DOM textLayer，需走 API 搜索路径
    if (S.mode() === S.MODE_CONTINUOUS || S.mode() === S.MODE_REFLOW) {
      _searchViaPdfApi(query, bookId);
      return;
    }

    // 单页模式：DOM textLayer span 搜索（同原逻辑）
    _searchViaDomSpans(query);
  }

  /**
   * 通过 pdf.js getTextContent API 全量搜索（连续模式）
   * 逐页提取文本内容，不依赖 DOM 已渲染
   */
  function _searchViaPdfApi(query, bookId) {
    var lowerQuery = query.toLowerCase();
    var totalPages = S.totalPages();
    if (!totalPages) {
      // fallback 到 DOM 搜索
      _searchViaDomSpans(query);
      return;
    }

    var abortCtrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    _searchAbort = abortCtrl;

    // 显示取消按钮 + 初始进度（仅连续模式 API 搜索有分页进度可显示）
    _showCancelBtn(true);
    _updateInfo('0 / ' + totalPages + ' 页…');

    var searchChain = Promise.resolve();
    for (var p = 1; p <= totalPages; p++) {
      (function (pageNum) {
        searchChain = searchChain.then(function () {
          // 检查是否已取消
          if (abortCtrl && abortCtrl.signal.aborted) return;
          return core.getPdfDoc(bookId).then(function (pdf) {
            if (abortCtrl && abortCtrl.signal.aborted) return;
            return pdf.getPage(pageNum);
          }).then(function (page) {
            if (!page || (abortCtrl && abortCtrl.signal.aborted)) return;
            return page.getTextContent();
          }).then(function (textContent) {
            if (!textContent || (abortCtrl && abortCtrl.signal.aborted)) return;
            var items = textContent.items || [];
            var fullPageText = '';
            var itemOffsets = []; // { start, end, item }
            for (var i = 0; i < items.length; i++) {
              var itemText = items[i].str || '';
              itemOffsets.push({ start: fullPageText.length, end: fullPageText.length + itemText.length, item: items[i] });
              fullPageText += itemText;
              // 行尾加空格分隔（pdf.js 文本项之间可能有断行）
              if (items[i].hasEOL) fullPageText += '\n';
            }

            var lowerPageText = fullPageText.toLowerCase();
            var matchStart = lowerPageText.indexOf(lowerQuery);
            while (matchStart !== -1) {
              var matchEnd = matchStart + query.length;
              var matchText = fullPageText.substring(matchStart, matchEnd);

              // 找到 matchStart 落入第几个 item（当匹配不跨 item 边界时有效），
              // 用于后续 textLayer 渲染后的 span 定位 fallback
              var matchItemIdx = -1;
              for (var k = 0; k < itemOffsets.length; k++) {
                if (itemOffsets[k].start <= matchStart && matchEnd <= itemOffsets[k].end) {
                  matchItemIdx = k;
                  break;
                }
              }

              _matches.push({
                pageNum: pageNum,
                matchStart: matchStart,
                matchEnd: matchEnd,
                matchItemIdx: matchItemIdx,
                pageText: fullPageText,
                // API 搜索无 DOM 引用，需渲染后才能定位 span
                text: matchText,
                span: null,
                textLayer: null
              });
              matchStart = lowerPageText.indexOf(lowerQuery, matchEnd);
            }
            // 进度更新：当前页/总页数 + 已找到匹配数（避免 0 时显示 awkward）
            var foundStr = _matches.length > 0 ? ' (已找到 ' + _matches.length + ')' : '';
            _updateInfo(pageNum + ' / ' + totalPages + ' 页…' + foundStr);
          });
        });
      })(p);
    }

    searchChain.then(function () {
      if (abortCtrl && abortCtrl.signal.aborted) return;
      _isSearching = false;
      _searchAbort = null;
      _showCancelBtn(false);

      if (_matches.length > 0) {
        _currentMatchIdx = 0;
        _focusMatch(0);
        _updateInfo(_matches.length + ' 个结果');
      } else {
        _updateInfo('无结果');
      }
    }).catch(function (err) {
      if (abortCtrl && abortCtrl.signal.aborted) return;
      console.warn('[PDF] 搜索失败:', err);
      _isSearching = false;
      _searchAbort = null;
      _showCancelBtn(false);
      _updateInfo('搜索出错');
    });
  }

  /**
   * 通过 DOM textLayer span 搜索（单页模式，原逻辑）
   */
  function _searchViaDomSpans(query) {
    var lowerQuery = query.toLowerCase();
    var pages = _getAllPages();

    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      var pageNum = parseInt(page.getAttribute('data-pdf-page'), 10) || (i + 1);
      var textLayer = page.querySelector('[data-pdf-text-layer]');
      if (!textLayer) continue;

      var spans = textLayer.querySelectorAll('span');
      for (var j = 0; j < spans.length; j++) {
        var text = spans[j].textContent || '';
        var lowerText = text.toLowerCase();
        var idx = lowerText.indexOf(lowerQuery);

        while (idx !== -1) {
          _highlightMatch(spans[j], idx, query.length, pageNum, textLayer);
          _matches.push({
            pageNum: pageNum,
            textLayer: textLayer,
            span: spans[j],
            text: text.substring(idx, idx + query.length)
          });
          idx = lowerText.indexOf(lowerQuery, idx + query.length);
        }
      }
    }

    _isSearching = false;

    if (_matches.length > 0) {
      _currentMatchIdx = 0;
      _focusMatch(0);
      _updateInfo(_matches.length + ' 个结果');
    } else {
      _updateInfo('无结果');
    }
  }

  /**
   * 高亮单个匹配项
   */
  function _highlightMatch(span, startIdx, length, pageNum, textLayer) {
    // 在 span 上加高亮标记 class
    span.classList.add('bk-pdf-search-match');
    span.setAttribute('data-pdf-search-page', pageNum);
  }

  /**
   * 聚焦到指定匹配项
   */
  function _focusMatch(idx) {
    // 清除上一个的高亮
    if (_currentMatchIdx >= 0 && _currentMatchIdx < _matches.length) {
      var prev = _matches[_currentMatchIdx];
      if (prev && prev.span) prev.span.classList.remove('bk-pdf-search-current');
    }

    _currentMatchIdx = idx;
    var match = _matches[idx];
    if (!match) return;

    // 高亮当前（DOM 模式）
    if (match.span) match.span.classList.add('bk-pdf-search-current');

    // 跳转到匹配页
    var nav = win.BKPdf._internal.nav;
    if (nav && nav.goToPage) nav.goToPage(match.pageNum, false);

    // API 搜索模式：跳转后等待页面渲染完成，再在 textLayer 中定位高亮
    if (!match.span && match.textLayer === null) {
      _highlightSearchResultAfterRender(match, idx);
    }

    _updateInfo((idx + 1) + ' / ' + _matches.length);
  }

  /**
   * API 搜索模式：跳转到目标页后，定位并高亮匹配文本
   * Bug11 修复：Reflow 模式下通过文本匹配在 Reflow DOM 中高亮搜索结果
   */
  function _highlightSearchResultAfterRender(match, idx) {
    // Reflow 模式：在 Reflow 文本中定位并高亮
    if (S.mode() === S.MODE_REFLOW) {
      _highlightSearchResultInReflow(match, idx);
      return;
    }

    var pageNum = match.pageNum;
    var pageEl = _getPageByNum(pageNum);
    if (!pageEl) return;

    // 如果页面已渲染，直接定位
    if (pageEl.getAttribute('data-pdf-rendered') === '1') {
      _locateAndHighlightInTextLayer(pageEl, match, idx);
      return;
    }

    // 页面未渲染：强制渲染后定位
    var coreRef = win.BKPdf._internal.core;
    if (coreRef && coreRef.renderPage) {
      coreRef.renderPage(pageEl);
      // 等待渲染完成（轮询 data-pdf-rendered）
      var pollTimer = setInterval(function () {
        if (pageEl.getAttribute('data-pdf-rendered') === '1') {
          clearInterval(pollTimer);
          setTimeout(function () {
            _locateAndHighlightInTextLayer(pageEl, match, idx);
          }, 200);
        }
      }, 200);
      // 超时保护 10s
      setTimeout(function () { clearInterval(pollTimer); }, 10000);
    }
  }

  /**
   * Bug11: 在 Reflow 视图中定位并高亮搜索结果
   * 策略：在目标页码对应的 Reflow 段落中搜索匹配文本，
   * 找到后添加搜索高亮 class
   */
  function _highlightSearchResultInReflow(match, idx) {
    var reflow = win.BKPdf._internal.reflow;
    if (!reflow || !reflow.container) return;
    var container = reflow.container();
    if (!container) return;

    var searchText = (match.text || '').toLowerCase();
    if (!searchText) return;

    // 在目标页码的 Reflow 段落中搜索
    var pageNum = match.pageNum;
    var paras = container.querySelectorAll('[data-reflow-page="' + pageNum + '"]');
    for (var i = 0; i < paras.length; i++) {
      var paraText = (paras[i].textContent || '').toLowerCase();
      if (paraText.indexOf(searchText) !== -1) {
        // 找到匹配段落，添加搜索高亮
        paras[i].classList.add('bk-pdf-search-match');
        if (i === 0) {
          paras[i].classList.add('bk-pdf-search-current');
          // 更新 match 引用
          _matches[idx].span = paras[i];
        }
      }
    }

    // 清除旧高亮
    if (idx > 0 && _matches[idx - 1] && _matches[idx - 1].span) {
      _matches[idx - 1].span.classList.remove('bk-pdf-search-current');
    }
  }

  /**
   * 在已渲染的 textLayer 中精确定位匹配文本对应的 span 集合并高亮
   * 支持跨 span 匹配（匹配字符落在多个 span 时全部高亮）
   *
   * 定位策略（按优先级）：
   *   1. 按"出现序号"精确匹配：match.matchStart 在 pageText 中是第 K 次出现 → domText 中取第 K 次
   *      避免 indexOf 含子串匹配导致的页内多次出现时高亮错位（如搜索"复兴"页内有多个"复兴"，原 indexOf 取第一个，可能不对）
   *   2. itemIdx 映射：若匹配完全落在单个 textContent.item 内，且 item 与 span 一一对应时直接取 spans[matchItemIdx]
   *   3. indexOf 单 span 匹配（原行为，最后兜底）
   */
  function _locateAndHighlightInTextLayer(pageEl, match, matchIdx) {
    var textLayer = pageEl.querySelector('[data-pdf-text-layer]');
    if (!textLayer) return false;

    var spans = textLayer.querySelectorAll('span');
    if (!spans.length) return false;

    // 构建 domText 和每个 span 的 [start, end] 区间
    var spanRanges = [];
    var domText = '';
    for (var i = 0; i < spans.length; i++) {
      var txt = spans[i].textContent || '';
      spanRanges.push({ start: domText.length, end: domText.length + txt.length, span: spans[i] });
      domText += txt;
    }

    // 策略 1：按出现序号精确匹配
    var foundSpans = _locateByOccurrence(spanRanges, domText, match);

    // 策略 2：fallback - itemIdx 对应 span
    if (!foundSpans.length && typeof match.matchItemIdx === 'number' &&
        match.matchItemIdx >= 0 && match.matchItemIdx < spans.length) {
      foundSpans.push(spans[match.matchItemIdx]);
    }

    // 策略 3：fallback - indexOf 单 span 匹配（原行为）
    if (!foundSpans.length) {
      var lowerMatch = (match.text || '').toLowerCase();
      for (var i = 0; i < spans.length; i++) {
        if ((spans[i].textContent || '').toLowerCase().indexOf(lowerMatch) !== -1) {
          foundSpans.push(spans[i]);
          break;
        }
      }
    }

    if (!foundSpans.length) return false;

    // 高亮：所有命中 span 加 match，第一个加 current
    for (var i = 0; i < foundSpans.length; i++) {
      foundSpans[i].classList.add('bk-pdf-search-match');
      foundSpans[i].setAttribute('data-pdf-search-page', match.pageNum);
    }
    foundSpans[0].classList.add('bk-pdf-search-current');

    // 更新 match 对象的 DOM 引用
    _matches[matchIdx].span = foundSpans[0];
    _matches[matchIdx].textLayer = textLayer;
    _matches[matchIdx].highlightSpans = foundSpans;

    return true;
  }

  /**
   * 按"匹配在 pageText 中是第 K 次出现 → domText 中也取第 K 次"原则定位 span 集合
   * 思路：连续模式下 _searchViaPdfApi 已在 pageText 中按 indexOf 找到所有匹配并记录 matchStart；
   *       domText 与 pageText 在 pdf.js textLayer 渲染下结构基本一致，用 matchStart 反推出 K 值，
   *       到 domText 中取第 K 次出现即可定位正确 span（避免 indexOf 单 span 模糊匹配命中错位）
   * @returns Array<HTMLElement> 未命中则返回空数组
   */
  function _locateByOccurrence(spanRanges, domText, match) {
    if (!domText || !match.pageText || !match.text) return [];

    var lowerMatch = match.text.toLowerCase();
    var lowerPage = match.pageText.toLowerCase();
    var lowerDom = domText.toLowerCase();

    // step1: 计算 match.matchStart 在 pageText 中是第 K 次出现 matchText
    var k = 0;
    var pos = lowerPage.indexOf(lowerMatch);
    var foundK = -1;
    while (pos !== -1) {
      if (pos === match.matchStart) { foundK = k; break; }
      pos = lowerPage.indexOf(lowerMatch, pos + lowerMatch.length);
      k++;
    }
    if (foundK < 0) return [];

    // step2: 在 domText 中找第 foundK 次出现
    var domPos = lowerDom.indexOf(lowerMatch);
    var domCount = 0;
    while (domPos !== -1) {
      if (domCount === foundK) {
        return _collectSpansInRange(spanRanges, domPos, domPos + lowerMatch.length);
      }
      domPos = lowerDom.indexOf(lowerMatch, domPos + lowerMatch.length);
      domCount++;
    }

    return [];
  }

  /**
   * 收集与 [domStart, domEnd) 字符范围相交的所有 span
   * 支持跨 span 匹配（如匹配词被拆到相邻 span 中）
   */
  function _collectSpansInRange(spanRanges, domStart, domEnd) {
    var found = [];
    for (var i = 0; i < spanRanges.length; i++) {
      if (spanRanges[i].end > domStart && spanRanges[i].start < domEnd) {
        found.push(spanRanges[i].span);
      }
    }
    return found;
  }

  function goToNext() {
    if (!_matches.length) return;
    var next = (_currentMatchIdx + 1) % _matches.length;
    _focusMatch(next);
  }

  function goToPrev() {
    if (!_matches.length) return;
    var prev = (_currentMatchIdx - 1 + _matches.length) % _matches.length;
    _focusMatch(prev);
  }

  /**
   * 显示/隐藏取消搜索按钮
   */
  function _showCancelBtn(visible) {
    if (_searchCancelBtn) {
      if (visible) {
        _searchCancelBtn.removeAttribute('hidden');
      } else {
        _searchCancelBtn.setAttribute('hidden', '');
      }
    }
  }

  function _cancelSearch() {
    _isSearching = false;
    if (_searchAbort) {
      try { _searchAbort.abort(); } catch (e) {}
      _searchAbort = null;
    }
    _showCancelBtn(false);
  }

  function _clearHighlights() {
    var highlighted = _getActiveRoot().querySelectorAll('.bk-pdf-search-match, .bk-pdf-search-current');
    for (var i = 0; i < highlighted.length; i++) {
      highlighted[i].classList.remove('bk-pdf-search-match', 'bk-pdf-search-current');
      highlighted[i].removeAttribute('data-pdf-search-page');
    }
  }

  function _updateInfo(text) {
    if (_searchResults) _searchResults.textContent = text;
  }

  // ==================== 展开/收起 ====================

  function toggle() {
    if (_isVisible) hide();
    else show();
  }

  function show() {
    _createSearchBar();
    if (_searchBar) _searchBar.classList.add('bk-pdf-search-visible');
    _isVisible = true;
    if (_searchInput) {
      _searchInput.focus();
      _searchInput.select();
    }
    _closeOthers('search');
  }

  function hide() {
    if (_searchBar) _searchBar.classList.remove('bk-pdf-search-visible');
    _isVisible = false;
    _clearHighlights();
  }

  function _closeOthers(except) {
    S.closeAllDrawersExcept(except);
  }

  // ==================== init / cleanup ====================

  function init(containerEl, bookId) {
    // 延迟创建，首次 show 时才创建
  }

  function cleanup() {
    _cancelSearch();
    _clearHighlights();
    if (_searchBar && _searchBar.parentNode) {
      _searchBar.parentNode.removeChild(_searchBar);
    }
    _searchBar = null;
    _searchInput = null;
    _searchResults = null;
    _searchCancelBtn = null;
    _matches = [];
    _currentMatchIdx = -1;
    _isVisible = false;
  }

  // ==================== 导出 ====================

  win.BKPdf._internal.search = {
    init: init,
    cleanup: cleanup,
    toggle: toggle,
    show: show,
    hide: hide,
    doSearch: doSearch,
    goToNext: goToNext,
    goToPrev: goToPrev
  };

})(window);
