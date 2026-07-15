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
    // 'imported' 是内部标记，不应泄漏到 UI；来源信息由 _sourceLabel / _sourceBadgeHTML 承担
    if (seriesId === 'imported') return '';
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
      html += '<div class="bk-continue-title">' + escText(_cleanBookTitle(b.title)) + '</div>';
      html += '<div class="bk-continue-chapter">读到第' + it.progress + '章 / 共' + it.chapterCount + '章</div>';
      html += '</div>';
      html += '<div class="reading-progress"><div class="reading-progress-fill" style="width:' + it.progressPct + '%"></div></div>';
      html += '<div class="bk-continue-arrow">›</div>';
      html += '</a>';
    }
    anchor.innerHTML = html;
  }
  // 系列合并：书籍数 < MIN_SERIES_BOOKS 的系列归入拾遗
  var _MIN_SERIES_BOOKS = 3;
  var _PICKUP_SERIES_ID = 'sy_auto';
  var _PROTECTED_SERIES = { 'books': true, 'sy_auto': true, 'md-bundle': true, 'bundle': true, 'MDC': true }; // 不参与合并的系列（含 _bundled 的系列还会被动态保护）

  function _getMergedSeries() {
    // 计算每个系列的真实书籍数，同时检测含 _bundled 书籍的系列
    var seriesBookCount = {};
    var seriesHasBundled = {};
    for (var i = 0; i < _zlBooks.length; i++) {
      var sid = _zlBooks[i].series;
      seriesBookCount[sid] = (seriesBookCount[sid] || 0) + 1;
      if (_zlBooks[i]._bundled) seriesHasBundled[sid] = true;
    }

    var visibleSeries = [];
    var mergedCount = 0; // 被合并掉的系列贡献给拾遗的额外书籍数

    var mergedIds = {};  // 被合并掉的系列ID集合

    for (var i = 0; i < _zlSeries.length; i++) {
      var s = _zlSeries[i];
      var count = seriesBookCount[s.id] || 0;
      // 包含 _bundled 书籍的系列动态保护，不受最低书籍数限制
      if (count < _MIN_SERIES_BOOKS && !_PROTECTED_SERIES[s.id] && !seriesHasBundled[s.id]) {
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
      // 书城三级：封面海报 + 下方精简信息条（书名 + 书号(可选) + 章节数）
      var bookNo = _extractBookNo(book.title);
      html += '<div class="book-caption">';
      html += '<div class="book-caption-title">' + escText(_cleanBookTitle(book.title)) + '</div>';
      html += '<div class="book-caption-meta">';
      if (bookNo) {
        html += '<span class="book-caption-no">书号 ' + escText(bookNo) + '</span>';
      }
      html += '<span class="book-caption-chapters">共 ' + chapterCount + ' 章</span>';
      var srcBadge = _sourceBadgeHTML(book);
      if (srcBadge) html += srcBadge;
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  /**
   * 处理书籍卡片点击：已下载则导航，未下载则先下载
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

    // 显示下载中状态
    var cardEl2 = cardEl ? cardEl.closest('.zl-book-card') : null;
    var iconEl = cardEl ? cardEl.querySelector('.cache-status') : null;
    if (iconEl) { iconEl.textContent = '⏳'; iconEl.style.color = '#ff9800'; }
    if (cardEl2) cardEl2.setAttribute('data-downloading', 'true');

    win.DataManager.downloadBook(bookId, series)
      .then(function () {
        // 下载成功，更新状态
        _zlDownloadedIds.push(bookId);
        if (iconEl) { iconEl.textContent = '✓'; iconEl.style.color = 'var(--brand)'; }
        if (cardEl2) cardEl2.removeAttribute('data-downloading');
        // 导航到书籍
        if (win.BKRouter) win.BKRouter.navigate(bookId);
      })
      .catch(function (err) {
        console.error('[Renderer] 书籍下载失败:', err);
        if (iconEl) { iconEl.textContent = '✗'; iconEl.style.color = '#f44336'; }
        if (cardEl2) cardEl2.removeAttribute('data-downloading');
        setTimeout(function () { if (iconEl) { iconEl.textContent = '☁'; iconEl.style.color = 'var(--text-muted)'; } }, 2000);
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
    // 更新资源摘要（checkResources）
    var resEl = document.getElementById('dlResourceSummary');
    var ovCached = document.getElementById('dlOvCached');
    var ovSize = document.getElementById('dlOvSize');
    if (resEl && win.DataManager.checkResources) {
      win.DataManager.checkResources().then(function (res) {
        var cached = res.downloaded || 0;
        var total = res.total || _zlBooks.length || 0;
        var sizeMB = res.estimatedTotalSize
          ? (res.estimatedTotalSize / 1024 / 1024).toFixed(1)
          : '未知';
        resEl.textContent = '已缓存 ' + cached + ' / 总共 ' + total + ' 本书（约 ' + sizeMB + ' MB）';
        if (ovCached) ovCached.textContent = cached + '/' + total;
        if (ovSize) ovSize.textContent = sizeMB + ' MB';
      }).catch(function () {
        resEl.textContent = '资源统计获取失败';
      });
    }
    // 更新存储统计（getStorageStats）
    var el = document.getElementById('dlStorageInfo');
    if (el) {
      win.DataManager.getStorageStats().then(function (stats) {
        el.textContent = '已下载 ' + stats.downloadedCount + ' 本书，占用 ' + stats.totalSizeFormatted;
      }).catch(function () {
        el.textContent = '存储统计获取失败';
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
          var bookId = cards[i].getAttribute('data-book-id');
          var isDown = _isBookDownloaded(bookId);
          var statusEl = cards[i].querySelector('.cache-status');
          if (statusEl) {
            statusEl.textContent = isDown ? '✓' : '☁';
            statusEl.style.color = isDown ? 'var(--brand)' : 'var(--text-muted)';
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
      for (var ii = 0; ii < imported.length; ii++) {
        var ib = imported[ii];
        // ★ 内置资源 EPUB 已在 loadEpubResources 中设置 series，不覆盖为 'imported'
        if (!ib._bundled) ib.series = 'imported';
        // 补齐 chapter_count（书城卡片用此字段显示章节数）
        if (!ib.chapter_count && ib.chapters && ib.chapters.length) {
          ib.chapter_count = ib.chapters.length;
        }
        // 幂等：避免重复渲染（导入后调用 renderHome 刷新书城时不产生重复卡片）
        var inBooks = false;
        for (var bi = 0; bi < _zlBooks.length; bi++) {
          if (_zlBooks[bi].id === ib.id) { inBooks = true; break; }
        }
        if (!inBooks) _zlBooks.push(ib);
        var inDl = false;
        for (var di = 0; di < _zlDownloadedIds.length; di++) {
          if (_zlDownloadedIds[di] === ib.id) { inDl = true; break; }
        }
        if (!inDl) _zlDownloadedIds.push(ib.id);
        if (!win.__bkBooks) win.__bkBooks = [];
        var exists = false;
        for (var bj = 0; bj < win.__bkBooks.length; bj++) {
          if (win.__bkBooks[bj].id === ib.id) { exists = true; break; }
        }
        if (!exists) win.__bkBooks.push(ib);
      }
    });
  }

  /**
   * 合并内置 MD 资源书籍到首页列表
   * 机制与 _mergeImportedBooks 平行，但 bundled books 不走 IndexedDB
   */
  function _mergeBundledBooks() {
    if (!win.ImportManager || !win.ImportManager.loadBundledBooks) {
      return Promise.resolve();
    }
    return win.ImportManager.loadBundledBooks().then(function (result) {
      if (!result || !result.books || !result.books.length) return;
      var bundled = result.books;
      var seriesMap = result.seriesMap || {};

      // 注入 series 到 _zlSeries（从 manifest 自动发现多个系列）
      var existingSeries = {};
      for (var si = 0; si < _zlSeries.length; si++) {
        existingSeries[_zlSeries[si].id || _zlSeries[si].name] = true;
      }
      for (var sId in seriesMap) {
        if (!seriesMap.hasOwnProperty(sId)) continue;
        if (!existingSeries[sId]) {
          var meta = seriesMap[sId];
          _zlSeries.push({
            id: meta.id,
            name: meta.name,
            title: meta.name,
            type: 'bundle'
          });
          existingSeries[sId] = true;
        }
      }

      // 幂等合并到 _zlBooks、_zlDownloadedIds、__bkBooks
      for (var ii = 0; ii < bundled.length; ii++) {
        var bb = bundled[ii];
        // 补齐 chapter_count（书城卡片用此字段显示章节数）
        if (!bb.chapter_count && bb.chapters && bb.chapters.length) {
          bb.chapter_count = bb.chapters.length;
        }
        var inBooks = false;
        for (var bj = 0; bj < _zlBooks.length; bj++) {
          if (_zlBooks[bj].id === bb.id) { inBooks = true; break; }
        }
        if (!inBooks) _zlBooks.push(bb);

        var inDl = false;
        for (var di = 0; di < _zlDownloadedIds.length; di++) {
          if (_zlDownloadedIds[di] === bb.id) { inDl = true; break; }
        }
        if (!inDl) _zlDownloadedIds.push(bb.id);

        if (!win.__bkBooks) win.__bkBooks = [];
        var exists = false;
        for (var bk = 0; bk < win.__bkBooks.length; bk++) {
          if (win.__bkBooks[bk].id === bb.id) { exists = true; break; }
        }
        if (!exists) win.__bkBooks.push(bb);
      }
      _invalidateMergedSeriesCache();

      // 合并后若当前书城/书架可见则就地重渲染
      var appEl = document.getElementById('app');
      if (appEl && appEl.style.display !== 'none') {
        if (win.location.hash.indexOf('city') !== -1) {
          if (BKRenderer.renderCityPage) BKRenderer.renderCityPage();
        } else if (BKRenderer.renderShelfPage) {
          BKRenderer.renderShelfPage();
        }
      }
    });
  }

