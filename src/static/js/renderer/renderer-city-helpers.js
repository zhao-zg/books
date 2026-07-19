'use strict';

  // ── zl-html 首页渲染辅助函数 ────────────────────────────────────────

  /**
   * 检查书籍是否已下载（同步，基于缓存的 ID 列表）
   */
  function _isBookDownloaded(bookId) {
    return _zlDownloadedIds.indexOf(bookId) !== -1;
  }

  /**
   * 系列标题显示替换（兜底：CWWL → 李文集）
   */
  function _displaySeriesTitle(title) {
    if (title === 'CWWL') return '李文集';
    return title;
  }

  /**
   * 根据 series ID 获取系列标题
   */
  function _getSeriesTitle(seriesId) {
    // 'imported' 是旧版内部标记，不应泄漏到 UI
    if (seriesId === 'imported') return '';
    if (seriesId === 'imported-local') return '本地导入';
    if (seriesId === 'imported-webdav') return 'WebDAV导入';
    for (var i = 0; i < _zlSeries.length; i++) {
      if (_zlSeries[i].id === seriesId) return _displaySeriesTitle(_zlSeries[i].title);
    }
    return seriesId || '';
  }

  /**
   * 渲染 zl-html 首页完整内容
   */
  /**
   * 取续读列表（有阅读进度的书），按 bk_last_read 置顶、其余按 progress 降序。
   * @param {number} limit 截取数量；<=0 表示不限制（返回全部）
   * @returns {Array<{book, progress, chapterCount, progressPct, chapterTitle}>}
   */
  function _getContinueList(limit) {
    limit = (typeof limit === 'number' && limit > 0) ? limit : 0;

    // 同步完成状态，确保续读列表不会出现「进度100%但仍未标记已读」的书
    _syncAllBookCompletion();

    var items = [];
    for (var i = 0; i < _zlBooks.length; i++) {
      var b = _zlBooks[i];
      var prog = getReadingProgress(b.id);
      if (prog > 0) {
        var chapterCount = b.chapter_count || 0;
        // 基于滚动完成度计算已读百分比
        var _readChCount = 0;
        for (var _rci = 1; _rci <= chapterCount; _rci++) {
          if (_isChapterReadByScroll(b.id, _rci)) _readChCount++;
        }
        var progressPct = (chapterCount > 0 && _readChCount > 0) ? Math.round(_readChCount / chapterCount * 100) : 0;
        items.push({
          book: b,
          progress: prog,
          chapterCount: chapterCount,
          progressPct: progressPct,
          chapterTitle: ''
        });
      }
    }

    // 排序：bk_last_read 置顶，其余按 progress 降序
    var lastId = '';
    try { lastId = localStorage.getItem('bk_last_read') || ''; } catch (e) {}
    items.sort(function (a, b) {
      if (a.book.id === lastId) return -1;
      if (b.book.id === lastId) return 1;
      return b.progress - a.progress;
    });

    if (limit > 0 && items.length > limit) items = items.slice(0, limit);
    return items;
  }

  /**
   * 渲染「继续阅读」列表到 #bkContinueListAnchor。
   * @param {Object} opts { expanded: boolean } 展开后去掉折叠上限并隐藏「查看全部」。
   */
  function _renderContinueList(homeView, opts) {
    opts = opts || {};
    var anchor = homeView.querySelector('#bkContinueListAnchor');
    if (!anchor) return;

    var expanded = !!opts.expanded;
    var all = _getContinueList(0);

    // 无阅读历史 → 引导卡（整卡点击进入书城）
    if (all.length === 0) {
      anchor.innerHTML =
        '<a class="bk-continue-card bk-continue-welcome" href="#/city">' +
          '<div class="bk-continue-info">' +
            '<div class="bk-continue-title">去书城开始阅读</div>' +
            '<div class="bk-continue-chapter">' + _zlBooks.length + ' 本书籍等你探索</div>' +
          '</div>' +
        '</a>';
      var va = homeView.querySelector('#bk-continue-viewall');
      if (va) va.style.display = 'none';
      return;
    }

    var list = expanded ? all : all.slice(0, 6);

    // 「查看全部」按钮：展开后或不足一屏时隐藏
    var vaBtn = homeView.querySelector('#bk-continue-viewall');
    if (vaBtn) {
      vaBtn.style.display = (expanded || all.length <= 6) ? 'none' : '';
    }

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var b = it.book;
      html += '<a class="bk-continue-card" href="#/' + escAttr(b.id) + '/' + (it.progress || 1) + '">';
      html += '<div class="bk-continue-cover">' + _coverHTML(b, { size: 'sm' }) + '</div>';
      html += '<div class="bk-continue-info">';
      html += '<div class="bk-continue-title">' + escText(b.title) + '</div>';
      html += '<div class="bk-continue-chapter">第' + it.progress + '章 / 共' + it.chapterCount + '章</div>';
      html += '<div class="reading-progress"><div class="reading-progress-fill" style="width:' + it.progressPct + '%"></div></div>';
      html += '</div>';
      html += '</a>';
    }
    anchor.innerHTML = html;
  }
  // 系列合并：书籍数 < MIN_SERIES_BOOKS 的系列归入拾遗
  var _MIN_SERIES_BOOKS = 3;
  var _PICKUP_SERIES_ID = 'sy_auto';
  var _PROTECTED_SERIES = { 'books': true, 'sy_auto': true, 'md-bundle': true, 'bundle': true, 'MDC': true, 'imported-local': true, 'imported-webdav': true }; // 不参与合并的系列

  function _getMergedSeries() {
    // 计算每个系列的真实书籍数
    var seriesBookCount = {};
    for (var i = 0; i < _zlBooks.length; i++) {
      var sid = _zlBooks[i].series;
      seriesBookCount[sid] = (seriesBookCount[sid] || 0) + 1;
    }

    var visibleSeries = [];
    var mergedCount = 0; // 被合并掉的系列贡献给拾遗的额外书籍数

    var mergedIds = {};  // 被合并掉的系列ID集合

    for (var i = 0; i < _zlSeries.length; i++) {
      var s = _zlSeries[i];
      var count = seriesBookCount[s.id] || 0;
      if (count < _MIN_SERIES_BOOKS && !_PROTECTED_SERIES[s.id] && s.type !== 'bundle') {
        mergedCount += count;
        mergedIds[s.id] = true;
      } else {
        visibleSeries.push(s);
      }
    }

    // 更新拾遗系列的显示计数
    if (mergedCount > 0) {
      for (var i = 0; i < visibleSeries.length; i++) {
        if (visibleSeries[i].id === _PICKUP_SERIES_ID) {
          visibleSeries[i] = {
            id: visibleSeries[i].id,
            title: visibleSeries[i].title,
            count: (seriesBookCount[_PICKUP_SERIES_ID] || 0) + mergedCount
          };
          break;
        }
      }
    }

    return { series: visibleSeries, bookCount: seriesBookCount, mergedCount: mergedCount, mergedIds: mergedIds };
  }
  /**
   * 构建单个书籍卡片 HTML（纯函数，消除重复代码）
   */
  function _buildBookCard(book, opts) {
    opts = opts || {};
    var chapterCount = book.chapter_count || 0;
    // 纯书籍信息卡（书城三级）不加 is-read 类，避免 sage 内描边等已读状态视觉泄漏到书城。
    // cityBook：书城三级「封面海报 + 下方精简信息条」卡 —— 封面(.bk-cover) 作海报，
    // 下方 .book-caption 显示书名 + 书号(可选) + 章节数；不渲染完整 .book-info（无徽标/进度/标记按钮）。
    var cityBook = (opts.cityBook === true);

    var html = '<div class="book-card zl-book-card' + (cityBook ? ' is-city-book' : '') + '" data-book-id="' + escAttr(book.id) + '" data-series="' + escAttr(book.series) + '" style="--series-color:' + _getSeriesColor(book.series) + '">';
    html += '<div class="book-card-wrapper">';
    html += '<div class="book-link" data-book-id="' + escAttr(book.id) + '" data-series="' + escAttr(book.series) + '" role="button" tabindex="0">';
    // 仅书架/搜索等非书城卡片用固定 60px 小封面(size:'md')；书城 L3 海报由 .bk-city-book-grid 专属规则撑满，md 会被覆盖成死 class，故去掉
    var coverSize = cityBook ? null : 'md';
    html += _coverHTML(book, { size: coverSize, seriesTitle: _sourceLabel(book) || _getSeriesTitle(book.series) });
    if (cityBook) {
      // 书城三级：封面海报 + 下方精简信息条（完整书名 + 章节数）
      // 不单独显示书号行，书名中包含书号则保留完整书名
      html += '<div class="book-caption">';
      html += '<div class="book-caption-title">' + escText(book.title || '') + '</div>';
      html += '<div class="book-caption-meta">';
      html += '<span class="book-caption-chapters">共 ' + chapterCount + ' 章</span>';
      var srcBadge = _sourceBadgeHTML(book);
      if (srcBadge) html += srcBadge;
      html += '</div>';
      html += '</div>';
    }
    // 状态徽章：默认空不显示；下载中/成功/失败时由 _handleBookClick 写入文字并由 CSS 浮到卡片右上角。
    // 此前 _handleBookClick / _refreshAfterDownload 用 querySelector('.cache-status') 取元素，
    // 但 _buildBookCard 从未渲染该元素导致永远为 null —— 下载反馈实际从未生效（潜伏 bug）。
    html += '<div class="cache-status" aria-hidden="true"></div>';
    html += '</div>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  /**
   * 处理书籍卡片点击：已下载则导航，未下载则先下载
   *
   * 体验流程（未下载 → 已下载 → 打开）：
   *   1. 入口防抖：检查 data-downloading，已设置直接 return，避免重复 fetch
   *   2. 卡片置忙：data-downloading="true" + aria-busy，CSS 禁用 .book-link 再次点击
   *   3. 进度反馈：传入 onProgress(percent, status) 回调，实时更新 .cache-status 文字
   *      （此前潜伏 bug：onProgress 从未传入，进度信息全丢）
    *   4. 成功过渡：显示 ✓「下载完成」→ 延迟 400ms → 跳转（仅当本书仍是「最后点击下载的书」
    *      且用户仍停留在书城时才跳，避免并发下载时先完成者劫持导航；尊重历史阅读进度）
    *   5. 失败保留：显示 ✗ + toast 提示，状态保留不回退，由 _refreshAfterDownload 通过
    *      data-download-failed 守卫跳过覆盖，保证用户能看到失败信息
   */
  function _handleBookClick(bookId, series, cardEl) {
    if (_isBookDownloaded(bookId)) {
      // 已下载，检查是否有上次阅读进度
      var progress = getReadingProgress(bookId);
      if (progress > 0 && win.BKRouter) {
        win.BKRouter.navigate(bookId + '/' + progress);
      } else if (win.BKRouter) {
        win.BKRouter.navigate(bookId);
      }
      return;
    }

    // 未下载，尝试下载后打开
    if (!_zlDmReady || !win.DataManager) {
      // DataManager 不可用，直接导航
      if (win.BKRouter) win.BKRouter.navigate(bookId);
      return;
    }

    var cardEl2 = cardEl ? cardEl.closest('.zl-book-card') : null;
    // 防抖：卡片正在下载中，忽略重复点击
    if (cardEl2 && cardEl2.getAttribute('data-downloading') === 'true') {
      return;
    }

    var iconEl = cardEl ? cardEl.querySelector('.cache-status') : null;

    // 取书名（优先 _zlBooks，找不到 fallback bookId）—— 用于失败 toast 文案
    var bookTitle = bookId;
    for (var i = 0; i < _zlBooks.length; i++) {
      if (_zlBooks[i].id === bookId) { bookTitle = _zlBooks[i].title || bookId; break; }
    }

    // ── 卡片置忙 ──────────────────────────────────────────
    // 记录最后一次点击下载的书 ID：下载完成时只有「最后点击的书」才自动跳转，
    // 避免并发下载多本时先完成者劫持导航（用户点 A 又点 B，A 先完成不应抢跳到 A）
    // ★ I1修复：改用 BKRenderer 暴露的 claim API 统一访问 _lastClickDownloadId，
    //   与 search.js 等跨模块调用点保持一致的封装；同一 IIFE 闭包内本可直访，
    //   但统一走 API 便于未来在 claim 内集中加入日志/校验等逻辑。
    BKRenderer.claimDownloadNavigate(bookId);
    if (cardEl2) {
      cardEl2.setAttribute('data-downloading', 'true');
      cardEl2.removeAttribute('data-download-failed');  // 清除上一次的失败状态
    }
    if (iconEl) {
      iconEl.textContent = '⏳ 下载中…';
      iconEl.style.color = 'var(--warning-text, #B5793A)';
      iconEl.setAttribute('aria-hidden', 'false');
    }

    // ── 下载（传入 onProgress 回调，实时更新文字） ────────
    win.DataManager.downloadBook(bookId, series, function (percent, status) {
      // ★ 隐患8修复：percent === -1 表示错误/取消，不再直接丢弃，
      //   先将具体状态文字显示到图标，让用户在 catch 触发前的微任务间隙能短暂看到原因。
      //   catch 紧接着会覆盖为最终失败/取消状态。
      if (percent < 0) {
        if (iconEl && status) {
          iconEl.textContent = '⏳ ' + status;
        }
        return;
      }
      if (!iconEl) return;
      var pct = (percent > 100 ? 100 : percent) | 0;
      iconEl.textContent = '⏳ ' + (status || '下载中') + (pct < 100 ? ' ' + pct + '%' : '');
    })
      .then(function () {
        // 下载成功
        // 去重 push（避免重复下载或刷新后重复触发导致 _zlDownloadedIds 膨胀）
        if (_zlDownloadedIds.indexOf(bookId) === -1) {
          _zlDownloadedIds.push(bookId);
        }
        if (iconEl) {
          iconEl.textContent = '✓ 已下载';
          iconEl.style.color = 'var(--success-text, #3D8A5A)';
        }
        if (cardEl2) cardEl2.removeAttribute('data-downloading');
        // 延迟 400ms 再跳转，让用户看清「已下载」状态后再打开书。
        // ★ 跳转守卫（修复并发下载劫持）：仅当本书仍是「最后点击下载的书」且用户仍停留在
        //   书城视图时才自动跳转。若用户已点击其他书下载、或已手动打开别的书离开书城，
        //   则本书完成后只入库不跳转，避免覆盖用户当前操作。
        // ★ 进度尊重：删书时 localStorage 的 bk_progress:<id> 不会被清理，复下载应回到上次位置。
        setTimeout(function () {
          if (!BKRenderer.isClaimedDownloadNavigate(bookId)) return;  // 已被后续点击覆盖，不抢跳
          var homeEl = document.getElementById('homeView');
          if (!homeEl || homeEl.style.display === 'none') return;  // 用户已离开书城，不劫持
          if (!win.BKRouter) return;
          var progress = getReadingProgress(bookId);
          if (progress > 0) win.BKRouter.navigate(bookId + '/' + progress);
          else win.BKRouter.navigate(bookId + '/1');
        }, 400);
      })
      .catch(function (err) {
        // ★ 隐患4修复：用户主动取消（CANCELLED）时做无声清理，不显示失败图标/toast
        // ★ M5修复：使用 ERR_CANCELLED 常量替代字面量
        if (err && err.code === ERR_CANCELLED) {
          if (iconEl) {
            iconEl.textContent = '';
            iconEl.style.color = '';
            iconEl.setAttribute('aria-hidden', 'true');
          }
          if (cardEl2) cardEl2.removeAttribute('data-downloading');
          return;
        }
        console.error('[Renderer] 书籍下载失败:', err);
        var errMsg = (err && (err.hint || err.message)) ? (err.hint || err.message) : '未知错误';
        if (iconEl) {
          iconEl.textContent = '✗ 下载失败';
          iconEl.style.color = 'var(--danger-text, #C8553D)';
          iconEl.setAttribute('aria-hidden', 'false');
        }
        if (cardEl2) {
          cardEl2.removeAttribute('data-downloading');
          // 标记失败，供 _refreshAfterDownload 跳过覆盖
          cardEl2.setAttribute('data-download-failed', 'true');
        }
        _toast('《' + bookTitle + '》下载失败：' + errMsg);
      });
  }

  /**
   * 重新同步 WebDAV 书籍：禁用按钮 → 调用 WebDavManager.resyncBook → toast 反馈 → 复位按钮。
   * 失败文案优先取错误的 hint，其次 message（与 WebDavManager.wrapError 字段约定一致）。
   *
   * @param {HTMLElement} resyncBtn 触发按钮（.bk-resync-btn[data-book-id]）
   * @param {Object} book 书籍对象（须含 source.type==='webdav'）
   */
  function _doResync(resyncBtn, book) {
    if (!resyncBtn || !book || !book.source || book.source.type !== 'webdav') return;
    var mgr = win.WebDavManager;
    if (!mgr || typeof mgr.resyncBook !== 'function') {
      _toast('当前环境不支持重新同步');
      return;
    }
    // 防重复点击
    resyncBtn.disabled = true;
    resyncBtn.classList.add('is-loading');
    mgr.resyncBook(book)
      .then(function () {
        _toast('重新同步成功');
      })
      .catch(function (err) {
        var hint = (err && (err.hint || err.message)) ? (err.hint || err.message) : '重新同步失败';
        _toast(hint);
      })
      .finally(function () {
        resyncBtn.disabled = false;
        resyncBtn.classList.remove('is-loading');
      });
  }

  /**
   * 书卡点击委托：捕获「重新同步」按钮（.bk-resync-btn[data-book-id]）。
   * 命中后阻止默认/冒泡，避免触发「打开书」导航；查书后调用 _doResync。
   */
  function _onResyncClick(e) {
    if (!e || !e.target || !e.target.closest) return;
    var resyncBtn = e.target.closest('.bk-resync-btn');
    if (!resyncBtn) return;
    // 命中重同步按钮：阻断后续「打开书」导航（按钮为 .book-link 的兄弟节点，亦显式 stop）
    e.preventDefault();
    e.stopPropagation();

    var bookId = resyncBtn.getAttribute('data-book-id');
    if (!bookId) return;
    var book = _findBookById(bookId);
    if (!book) {
      _toast('未找到对应的书籍');
      return;
    }
    // 防御：按钮仅应出现在 webdav 源书卡上，理论上不会进入此分支
    if (!book.source || book.source.type !== 'webdav') return;
    _doResync(resyncBtn, book);
  }

  // 重同步点击委托是否已绑定（document 级，仅一次；覆盖书架 / 书城任意容器渲染的书卡）
  var _resyncHandlerBound = false;
  function _bindResyncHandler() {
    if (_resyncHandlerBound) return;
    _resyncHandlerBound = true;
    document.addEventListener('click', _onResyncClick);
  }

  /**
   * 打开下载管理对话框（使用 BK.openDialog 居中弹出）
   */
  function _openDownloadDialog() {
    // 防重复：如果对话框已存在，直接返回
    if (_dlDialog) return;

    var html =
      '<div class="bk-dialog bk-download-dialog">' +
        '<div class="bk-drawer-header">' +
          '<span class="bk-drawer-title">📥 下载管理</span>' +
          '<button class="bk-drawer-close" id="dlPanelClose" aria-label="关闭">✕</button>' +
        '</div>' +
        '<hr class="bk-drawer-divider">' +
        '<div class="bk-drawer-body">' +
          '<div class="dl-overview">' +
            '<div class="dl-ov-item"><span class="dl-ov-num" id="dlOvSeries">—</span><span class="dl-ov-label">系列</span></div>' +
            '<div class="dl-ov-item"><span class="dl-ov-num" id="dlOvCached">—</span><span class="dl-ov-label">已缓存</span></div>' +
            '<div class="dl-ov-item"><span class="dl-ov-num" id="dlOvSize">—</span><span class="dl-ov-label">占用</span></div>' +
          '</div>' +
          '<div class="download-resource-summary" id="dlResourceSummary">资源统计加载中...</div>' +
          '<div class="download-storage-info" id="dlStorageInfo">存储统计加载中...</div>' +
          '<div class="download-progress" id="dlProgressWrap" style="display:none">' +
            '<div class="download-progress-bar" id="dlProgressBar" style="width:0%"></div>' +
          '</div>' +
          '<div class="download-progress-text" id="dlProgressText" style="display:none"></div>' +
          '<div class="download-controls" id="dlControls" style="display:none">' +
            '<button class="dl-ctrl-btn" id="dlPauseBtn">暂停</button>' +
            '<button class="dl-ctrl-btn" id="dlCancelBtn">取消</button>' +
          '</div>' +
          '<div class="download-series-list" id="dlSeriesList"></div>' +
          '<button class="download-all-btn" id="dlAllBtn">全部下载</button>' +
        '</div>' +
      '</div>';

    _dlDialog = win.BK.openDialog({
      id: 'bk-download-dialog',
      html: html,
      onClose: function () {
        _dlDialog = null;
        _stopProgressPolling();
      }
    });

    if (!_dlDialog) return; // 防重复（同 id 已存在）

    // 关闭按钮
    var dlClose = document.getElementById('dlPanelClose');
    if (dlClose) dlClose.addEventListener('click', function () { _dlDialog.close(); });
    // 全部下载
    var dlAllBtn = document.getElementById('dlAllBtn');
    if (dlAllBtn) dlAllBtn.addEventListener('click', function () { _startAllDownload(); });
    // 暂停 / 恢复
    var dlPause = document.getElementById('dlPauseBtn');
    if (dlPause) dlPause.addEventListener('click', function () {
      if (!win.DataManager) return;
      var status = win.DataManager.getDownloadStatus();
      if (status && status.isPaused) { win.DataManager.resumeDownload(); dlPause.textContent = '暂停'; }
      else { win.DataManager.pauseDownload(); dlPause.textContent = '恢复'; }
    });
    // 取消
    var dlCancel = document.getElementById('dlCancelBtn');
    if (dlCancel) dlCancel.addEventListener('click', function () {
      if (win.DataManager) win.DataManager.cancelDownload();
      _stopProgressPolling();
    });

    // 渲染内容
    _renderDlSeriesList();
    _refreshStorageStats();
  }

  /**
   * 渲染下载面板中的系列列表（每次打开前刷新，保证数据已就绪）。
   * 每行含缓存状态（.series-cache-info[data-series]，供 _refreshSeriesCacheStatus 更新）
   * 与「下载」按钮（触发 _startSeriesDownload）。
   */
  function _renderDlSeriesList() {
    var list = document.getElementById('dlSeriesList');
    if (!list) return;
    var series = (_getMergedSeries().series || []);
    var html = '';
    for (var i = 0; i < series.length; i++) {
      var s = series[i];
      html += '<div class="download-series-row">';
      html += '<span class="download-series-name">' + escText(s.title) + (s.count != null ? ' (' + s.count + '本)' : '') + '</span>';
      html += '<span class="series-cache-info" data-series="' + escAttr(s.id) + '">—</span>';
      html += '<button class="download-series-btn" data-series="' + escAttr(s.id) + '">下载</button>';
      html += '</div>';
    }
    list.innerHTML = html;
    var btns = list.querySelectorAll('.download-series-btn');
    for (var k = 0; k < btns.length; k++) {
      btns[k].addEventListener('click', function () {
        var seriesId = this.getAttribute('data-series');
        _startSeriesDownload(seriesId);
      });
    }
  }

  /**
   * 刷新存储统计信息
   */
  function _refreshStorageStats() {
    if (!_zlDmReady || !win.DataManager) return;
    // 更新资源摘要（checkResources）— 仅显示已缓存/总本数，不再把估算总大小标成「占用」
    var resEl = document.getElementById('dlResourceSummary');
    var ovCached = document.getElementById('dlOvCached');
    if (resEl && win.DataManager.checkResources) {
      win.DataManager.checkResources().then(function (res) {
        var cached = res.downloaded || 0;
        var total = res.total || _zlBooks.length || 0;
        resEl.textContent = '已缓存 ' + cached + ' / 总共 ' + total + ' 本书';
        if (ovCached) ovCached.textContent = cached + '/' + total;
      }).catch(function () {
        resEl.textContent = '资源统计获取失败';
      });
    }
    // 更新存储统计（getStorageStats）— 概览卡「占用」与详细信息均来自真实占用
    // 优先用 navigator.storage.estimate() 的整体占用（覆盖 PDF、资源包等所有源），
    // 退化到 zl-data 书籍估算大小。
    var ovSize = document.getElementById('dlOvSize');
    var el = document.getElementById('dlStorageInfo');
    if (win.DataManager.getStorageStats) {
      win.DataManager.getStorageStats().then(function (stats) {
        var occ = (stats.originUsageBytes > 0)
          ? stats.originUsageFormatted
          : (stats.totalSizeFormatted || '0 B');
        if (ovSize) ovSize.textContent = occ;
        if (el) {
          var detail = '已下载 ' + stats.downloadedCount + ' 本书，占用 ' + occ;
          if (stats.originUsageBytes === 0 && stats.downloadedCount > 0) {
            // 退化路径：浏览器不支持 navigator.storage.estimate() 或返回 0
            // 此时 occ 仅为 zl-data 估算，PDF/资源包等大头未计入，需明确提示
            detail += '（浏览器不支持精确统计，实际占用可能更大）';
          } else if (stats.originUsageBytes > 0) {
            // 优先利用 usageBreakdown 分项（Chrome 92+），展示 IndexedDB / Cache Storage 等分项
            var bk = stats.usageBreakdown;
            if (bk && bk.length > 1) {
              var parts = [];
              for (var bi = 0; bi < bk.length; bi++) {
                if (bk[bi].usage > 0) {
                  // storageType 取值如 'indexeddb' / 'caches' / 'serviceworker' 等
                  var label = bk[bi].storageType === 'indexeddb' ? '数据库'
                    : bk[bi].storageType === 'caches' ? '缓存'
                    : bk[bi].storageType;
                  parts.push(label + ' ' + formatSize(bk[bi].usage));
                }
              }
              if (parts.length) detail += '（' + parts.join('，') + '）';
            } else if (stats.totalSizeBytes > 0) {
              // 无 breakdown 时，仅在差值显著（>50MB）时显示书籍数据分项
              var diff = stats.originUsageBytes - stats.totalSizeBytes;
              if (diff > 50 * 1024 * 1024) {
                detail += '（书籍数据 ' + stats.totalSizeFormatted + '）';
              }
            }
          }
          el.textContent = detail;
        }
      }).catch(function () {
        if (el) el.textContent = '存储统计获取失败';
      });
    }
    // 概览卡：系列数
    var ovSeries = document.getElementById('dlOvSeries');
    if (ovSeries) {
      try { ovSeries.textContent = (_getMergedSeries().series || []).length; } catch (e) {}
    }
    // 更新系列缓存进度
    _refreshSeriesCacheStatus();
  }

  /**
   * 刷新下载面板中各系列的缓存进度显示
   */
  function _refreshSeriesCacheStatus() {
    if (!_zlDmReady || !win.DataManager || !win.DataManager.getBooksBySeriesStatus) return;
    win.DataManager.getBooksBySeriesStatus().then(function (result) {
      var seriesArr = (result && result.series) || [];
      for (var i = 0; i < seriesArr.length; i++) {
        var s = seriesArr[i];
        var infoEls = document.querySelectorAll('.series-cache-info[data-series="' + s.id + '"]');
        for (var j = 0; j < infoEls.length; j++) {
          infoEls[j].textContent = s.cached + '/' + s.total + ' 已缓存';
          infoEls[j].style.color = s.cached === s.total && s.total > 0 ? 'var(--brand)' : 'var(--text-muted)';
        }
      }
    }).catch(function () {});
  }

  /**
   * 开始下载某系列
   */
  function _startSeriesDownload(seriesId) {
    if (!_zlDmReady || !win.DataManager) return;
    _showDownloadProgress();
    var seriesTitle = _getSeriesTitle(seriesId);

    win.DataManager.downloadSeries(seriesId, function (completed, total, currentTitle) {
      _updateDownloadProgressUI(completed, total, currentTitle);
    }).then(function (result) {
      _onDownloadComplete(result, seriesTitle);
    }).catch(function (err) {
      // ★ busy 错误仅 toast 提示，不杀现有进度轮询与控件，避免污染进行中的下载
      if (err && err.code === 'BUSY') {
        _toast(err.message || '已有下载任务正在进行');
        return;
      }
      _onDownloadError(err);
    });
  }

  /**
   * 开始下载全部
   */
  function _startAllDownload() {
    if (!_zlDmReady || !win.DataManager) return;
    _showDownloadProgress();

    win.DataManager.downloadAll(function (completed, total, currentTitle) {
      _updateDownloadProgressUI(completed, total, currentTitle);
    }).then(function (result) {
      _onDownloadComplete(result, '全部');
    }).catch(function (err) {
      if (err && err.code === 'BUSY') {
        _toast(err.message || '已有下载任务正在进行');
        return;
      }
      _onDownloadError(err);
    });
  }

  /**
   * 显示下载进度区域
   */
  function _showDownloadProgress() {
    var wrap = document.getElementById('dlProgressWrap');
    var text = document.getElementById('dlProgressText');
    var controls = document.getElementById('dlControls');
    if (wrap) wrap.style.display = '';
    if (text) { text.style.display = ''; text.textContent = '准备中...'; }
    if (controls) controls.style.display = '';
    // 重置暂停按钮
    var pauseBtn = document.getElementById('dlPauseBtn');
    if (pauseBtn) pauseBtn.textContent = '暂停';
    // 启动进度轮询
    _startProgressPolling();
  }

  /**
   * 更新下载进度 UI
   */
  function _updateDownloadProgressUI(completed, total, currentTitle) {
    var bar = document.getElementById('dlProgressBar');
    var text = document.getElementById('dlProgressText');
    if (total > 0 && bar) {
      bar.style.width = Math.round(completed / total * 100) + '%';
    }
    if (text) {
      text.textContent = completed + ' / ' + total + (currentTitle ? ' — ' + currentTitle : '');
    }
  }

  /**
   * 下载完成处理
   */
  function _onDownloadComplete(result, label) {
    _stopProgressPolling();
    var bar = document.getElementById('dlProgressBar');
    var text = document.getElementById('dlProgressText');
    var controls = document.getElementById('dlControls');
    if (bar) bar.style.width = '100%';
    if (text) {
      var msg = label + ' 下载完成: 成功 ' + result.success + ' 本';
      if (result.failed) {
        msg += '，失败 ' + result.failed + ' 本';
        var names = result.failedBookNames || [];
        if (names.length) {
          var shown = names.slice(0, 3).join('、');
          if (names.length > 3) shown += ' 等 ' + names.length + ' 本';
          msg += '（' + shown + '）';
        }
      }
      text.textContent = msg;
    }
    if (controls) controls.style.display = 'none';
    // 刷新已下载列表和书籍网格
    _refreshAfterDownload();
  }

  /**
   * 下载错误处理
   */
  function _onDownloadError(err) {
    _stopProgressPolling();
    var text = document.getElementById('dlProgressText');
    var controls = document.getElementById('dlControls');
    if (text) text.textContent = '下载出错: ' + (err.message || err);
    if (controls) controls.style.display = 'none';
  }

  /**
   * 启动进度轮询（作为 onProgress 回调的补充）
   */
  function _startProgressPolling() {
    _stopProgressPolling();
    _dlProgressTimer = setInterval(function () {
      if (!win.DataManager) return;
      var status = win.DataManager.getDownloadStatus();
      if (!status.isDownloading) {
        _stopProgressPolling();
        return;
      }
      _updateDownloadProgressUI(status.progress.completed, status.progress.total, status.progress.currentTitle);
    }, 1000);
  }

  /**
   * 停止进度轮询
   */
  function _stopProgressPolling() {
    if (_dlProgressTimer) {
      clearInterval(_dlProgressTimer);
      _dlProgressTimer = null;
    }
  }

  /**
   * 下载完成后刷新书籍网格和统计
   *
   * 状态协调规则（避免覆盖「下载中/失败」的实时反馈）：
   *   - data-downloading="true" → 跳过（用户正在下载，不要覆盖进度文字）
   *   - data-download-failed="true" → 跳过（用户失败状态需保留供查看/重试）
   *   - 其他卡片 → 清空 .cache-status 内容（默认空，CSS 隐藏；不再画常态 ☁/✓ 角标，
   *     因为书城卡已在封面/标题表达了书籍身份，常态徽章是冗余信息）
   */
  function _refreshAfterDownload() {
    if (!_zlDmReady || !win.DataManager) return;
    win.DataManager.getDownloadedBookIds().then(function (ids) {
      _zlDownloadedIds = ids;
      // 刷新书籍网格中的下载图标
      var homeView = document.getElementById('homeView');
      if (homeView) {
        var cards = homeView.querySelectorAll('.zl-book-card');
        for (var i = 0; i < cards.length; i++) {
          // 跳过正在下载或已失败的卡片，避免覆盖实时状态
          if (cards[i].getAttribute('data-downloading') === 'true') continue;
          if (cards[i].getAttribute('data-download-failed') === 'true') continue;
          var statusEl = cards[i].querySelector('.cache-status');
          if (statusEl) {
            // 默认状态清空 —— 常态徽章由 _handleBookClick 在点击时填充
            statusEl.textContent = '';
            statusEl.style.color = '';
            statusEl.setAttribute('aria-hidden', 'true');
          }
        }
      }
      _refreshStorageStats();
    });
  }

  /**
   * 合并导入书籍到首页列表（抽取为公共辅助，供 renderHome 的 then/catch 共用）
   */
  function _mergeImportedBooks() {
    if (!win.ImportManager || !win.ImportManager.getImportedBooks) {
      return Promise.resolve();
    }
    return Promise.resolve().then(function () {
      return win.ImportManager.getImportedBooks();
    }).then(function (imported) {
      // 按来源类型分系列：本地导入 / WebDAV 导入
      var hasLocal = false, hasWebdav = false;
      // 使用 cacheBook 持久化导入书的已下载状态（与内置书统一处理）
      // P2-6: cacheBook 延迟到空闲时执行，不阻塞书城渲染
      var _booksToCache = [];
      for (var ii = 0; ii < imported.length; ii++) {
        var ib = imported[ii];
        // ★ 内置资源 EPUB 已在 loadEpubResources 中设置 series，不覆盖
        if (!ib._bundled) {
          var st = (ib.source && ib.source.type) || '';
          if (st === 'webdav') {
            ib.series = 'imported-webdav';
            hasWebdav = true;
          } else if (st === 'local') {
            ib.series = 'imported-local';
            hasLocal = true;
          } else {
            ib.series = 'imported';
          }
        }
        // 补齐 chapter_count（书城卡片用此字段显示章节数）
        if (!ib.chapter_count && ib.chapters && ib.chapters.length) {
          ib.chapter_count = ib.chapters.length;
        }
        // 幂等：避免重复渲染（导入后调用 renderHome 刷新书城时不产生重复卡片）
        var existingIdx = -1;
        for (var bi = 0; bi < _zlBooks.length; bi++) {
          if (_zlBooks[bi].id === ib.id) { existingIdx = bi; break; }
        }
        if (existingIdx >= 0) {
          // 已有条目：更新 series 和 source（处理从旧 'imported' 迁移到新分组的情况）
          _zlBooks[existingIdx].series = ib.series;
          if (ib.source) _zlBooks[existingIdx].source = ib.source;
        } else {
          _zlBooks.push(ib);
        }
        // 通过 cacheBook 持久化到 DataManager 的已下载列表（刷新后不丢失）
        // P2-6: 仅收集，不在循环中调用（延迟到空闲时批量执行）
        if (win.DataManager && win.DataManager.cacheBook) {
          _booksToCache.push(ib);
        } else {
          // DataManager 不可用时退回内存操作
          var inDl = false;
          for (var di = 0; di < _zlDownloadedIds.length; di++) {
            if (_zlDownloadedIds[di] === ib.id) { inDl = true; break; }
          }
          if (!inDl) _zlDownloadedIds.push(ib.id);
        }
        if (!win.__bkBooks) win.__bkBooks = [];
        var exists = false;
        for (var bj = 0; bj < win.__bkBooks.length; bj++) {
          if (win.__bkBooks[bj].id === ib.id) { exists = true; break; }
        }
        if (!exists) win.__bkBooks.push(ib);
      }

      // 注入系列条目到 _zlSeries（与 _mergeBundledBooks 模式一致）
      var existingSeries = {};
      for (var si = 0; si < _zlSeries.length; si++) {
        existingSeries[_zlSeries[si].id || _zlSeries[si].name] = true;
      }
      if (hasLocal && !existingSeries['imported-local']) {
        _zlSeries.push({ id: 'imported-local', name: '本地导入', title: '本地导入', type: 'import' });
        existingSeries['imported-local'] = true;
      }
      if (hasWebdav && !existingSeries['imported-webdav']) {
        _zlSeries.push({ id: 'imported-webdav', name: 'WebDAV导入', title: 'WebDAV导入', type: 'import' });
        existingSeries['imported-webdav'] = true;
      }

      // 系列数据已变更，失效合并缓存（与 _mergeBundledBooks 一致）
      _invalidateMergedSeriesCache();

      // P2-6: 延迟到空闲时批量执行 cacheBook，不阻塞书城渲染
      if (_booksToCache.length > 0 && win.DataManager && win.DataManager.cacheBook) {
        var _runIdleCache = function () {
          var idlePromises = _booksToCache.map(function (b) { return win.DataManager.cacheBook(b.id, b); });
          Promise.all(idlePromises).then(function () {
            if (win.DataManager.getDownloadedBookIds) {
              win.DataManager.getDownloadedBookIds().then(function (ids) {
                _zlDownloadedIds = ids || [];
              });
            }
          });
        };
        if (win.requestIdleCallback) {
          win.requestIdleCallback(_runIdleCache, { timeout: 2000 });
        } else {
          setTimeout(_runIdleCache, 0);
        }
      }
    });
  }

  /**
   * [已废弃] 合并内置 MD 资源书籍到首页列表
   * 内置书已由构建侧生成 ysz 格式 JSON，随 zl-data/ 一起下发 CDN，
   * 通过 DataManager 统一加载，不再需要从前端 manifest 合并。
   * 保留空桩避免 renderer-data.js 中引用报错。
   */
  function _mergeBundledBooks() {
    return Promise.resolve();
  }

