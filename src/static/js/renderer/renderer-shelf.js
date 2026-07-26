'use strict';

  // ── 书架（书城增强 + 书架页）辅助函数 ────────────────────────────────

  /**
   * 按 id 从公开书籍表（window.__bkBooks）与私有 _zlBooks 查书籍元数据。
   * @param {string} bookId
   * @returns {Object|null}
   */
  function _findBookById(bookId) {
    if (win.__bkBooks) {
      for (var i = 0; i < win.__bkBooks.length; i++) {
        if (win.__bkBooks[i].id === bookId) return win.__bkBooks[i];
      }
    }
    for (var j = 0; j < _zlBooks.length; j++) {
      if (_zlBooks[j].id === bookId) return _zlBooks[j];
    }
    return null;
  }

  /**
   * 全局 bk-shelf-changed 监听：书城卡片就地翻转（不加整页刷新）。
   * 书城 DOM 即便在书架页前台时也仍在文档中（仅隐藏），就地更新无害，且回看时保持状态一致。
   */
  function _bkShelfChangedHandler(e) {
    var detail = (e && e.detail) || {};
    var bookId = detail.bookId;
    if (!bookId) return;
    var book = _findBookById(bookId) || { id: bookId };
    // 统一契约：角标显隐 / is-read 类均由 BKShelf.isRead（finished）决定，
    // 不再依赖 action==='add'（新模型 add=入架≠已读）。
    var read = (win.BKShelf && win.BKShelf.isRead) ? win.BKShelf.isRead(bookId) : false;
    var cards = document.querySelectorAll('.zl-book-card');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (card.getAttribute('data-book-id') !== bookId) continue;

      // 书城纯信息卡不加 is-read 类，避免 sage 内描边泄漏到书城。
      if (card.getAttribute('data-city') === '1') continue;
      // 非书城普通卡（书架/搜索）：is-read 类跟随 BKShelf.isRead 同步
      if (read) card.classList.add('is-read');
      else card.classList.remove('is-read');
    }
  }

  /**
   * 全局 bk-shelf-changed 监听：书架页就地刷新（仅当书架页为前台时）。
   */
  function _shelfPageChangedHandler() {
    var listEl = document.getElementById('shelfList');
    if (!listEl) return; // 书架页不在前台，跳过（回看时由 renderShelfPage 整体重渲染兜底）
    // 先合并导入书籍数据（异步），再渲染书架列表
    // 修复：BKShelf.add() 在 saveBook() 中同步触发 bk-shelf-changed，
    // 但此时新书尚未合并到 _zlBooks/__bkBooks，导致 _findBookById 返回 null，
    // 书架显示 bookId 而非真实标题。
    _mergeImportedBooks().then(function () {
      _renderShelfList();
      // ★ 同步刷新「继续阅读」模块：移出书架后该书的进度记录虽保留（便于续读），
      //   但 isCollected 过滤会使之从续读列表消失，需重渲染才能反映这一变化。
      _renderShelfContinue(document.getElementById('app') || document.body);
    }).catch(function () {
      _renderShelfList(); // 合并失败也兜底渲染，避免书架不刷新
    });
  }

  /**
   * 书架页列表 + 统计渲染（私有）：读 BKShelf.all()/stats() 整体渲染，保证与事实源 100% 一致。
   */
  /**
   * 计算书架统计：已读 / 在读 / 收藏。
   * 已读 = BKShelf 收藏总数；在读 = 有阅读进度且未读完的书数；收藏 = BKShelf 收藏总数。
   * @returns {{read:number, reading:number, collected:number}}
   */


  /**
   * 渲染书架页「继续阅读」模块（复用既有 _renderContinueList 卡片结构）。
   * @param {HTMLElement} app 书架页容器（#app）
   */
  function _renderShelfContinue(app) {
    if (!app) return;
    _renderContinueList(app);
  }

  function _renderShelfList() {
    var listEl = document.getElementById('shelfList');
    var tabsEl = document.getElementById('shelfTabs');
    if (!listEl || !win.BKShelf) return;

    // 同步完成状态：修复「进度100%但未标记已读」的不一致
    _syncAllBookCompletion();

    var records = win.BKShelf.all();
    var _isReadFn = function (id) {
      return (win.BKShelf && win.BKShelf.isRead) ? win.BKShelf.isRead(id) : false;
    };

    // 分桶：在读（未 finished） / 已读（finished）
    var reading = [], read = [];
    for (var i = 0; i < records.length; i++) {
      (_isReadFn(records[i].bookId) ? read : reading).push(records[i]);
    }

    // 分段计数 + 激活态（保留 _shelfActiveTab，bk-shelf-changed 重渲染不跳变）
    var crEl = document.getElementById('shelfCountReading');
    var cdEl = document.getElementById('shelfCountRead');
    if (crEl) crEl.textContent = reading.length;
    if (cdEl) cdEl.textContent = read.length;
    if (tabsEl) {
      var tabBtns = tabsEl.querySelectorAll('.bk-shelf-tab');
      for (var t = 0; t < tabBtns.length; t++) {
        var tb = tabBtns[t];
        var active = tb.getAttribute('data-tab') === _shelfActiveTab;
        tb.classList.toggle('is-active', active);
        tb.setAttribute('aria-selected', active ? 'true' : 'false');
      }
    }

    // 空状态引导
    if (!records.length) {
      listEl.innerHTML =
        '<div class="bk-shelf-empty">' +
          '<div class="bk-shelf-empty-icon">📚</div>' +
          '<div class="bk-shelf-empty-title">你还没有收藏的书</div>' +
          '<button type="button" class="bk-shelf-empty-cta" id="shelfEmptyCta">去书城发现好书 →</button>' +
        '</div>';
      var cta = document.getElementById('shelfEmptyCta');
      if (cta) cta.addEventListener('click', function () {
        if (win.BKRouter) win.BKRouter.navigate('city');
      });
      return;
    }

    // 书架列表（每条记录 = 在架/收藏；是否「读完」由 BKShelf.isRead(finished) 判定）
    // 仅渲染当前激活桶（默认：在读）
    var bucket = (_shelfActiveTab === 'read') ? read : reading;
    if (!bucket.length) {
      listEl.innerHTML =
        '<div class="bk-shelf-tab-empty">' +
          (_shelfActiveTab === 'read' ? '已读列表还是空的' : '在读列表还是空的') +
        '</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < bucket.length; i++) {
      var rec = bucket[i];
      var book = _findBookById(rec.bookId) || { id: rec.bookId, title: rec.bookId, series: '' };
      var title = book.title || (rec.bookId || '未知书籍');
      // 作者：优先真实作者→系列名；来源信息统一由 source 徽标承担，不再降级到 author 行
      var author = book.author || _getSeriesTitle(book.series) || '';
      // 海报封面：复用 .bk-cover，填满卡顶（由 .bk-shelf-row overflow:hidden 裁切 16px 圆角）
      var cover = _coverHTML(book, { seriesTitle: _sourceLabel(book) || _getSeriesTitle(book.series) });
      var isRead = _isReadFn(rec.bookId);
      var pinned = (win.BKShelf && win.BKShelf.isPinned) ? win.BKShelf.isPinned(rec.bookId) : false;

      // 行副文案：读完显「已于 X 读完」；未读完（在读/收藏）显「已读 X%」百分比进度（与书城视觉一致）
      var subText;
      if (isRead) {
        subText = escText(rec.completedAt || '');
      } else {
        // 基于滚动完成度计算已读百分比（而非仅章节号）
        var readChCount = 0;
        var cc = book.chapter_count || 0;
        for (var _rni = 1; _rni <= cc; _rni++) {
          if (_isChapterReadByScroll(rec.bookId, _rni)) readChCount++;
        }
        var pct = (cc > 0 && readChCount > 0) ? Math.round(readChCount / cc * 100) : 0;
        subText = pct > 0 ? ('已读 ' + pct + '%') : '未读';
      }
      // note/rating 数据：支持编辑与展示
      var metaExtra = '';
      if (rec.rating) metaExtra += ' ★' + rec.rating;
      if (rec.note) metaExtra += ' · 有笔记';

      // 海报卡：封面(卡顶) + 信息条(书名 + 单行元数据)，结构与书城 L3 一致
      html += '<div class="bk-shelf-row" data-book-id="' + escAttr(rec.bookId) + '" role="button" tabindex="0" aria-label="打开 ' + escAttr(title) + '">';
      var pinMark = pinned ? '<span class="bk-shelf-pin-mark" aria-label="已置顶" role="img">📌</span>' : '';
      html += '<div class="bk-shelf-row-cover">' + cover + '</div>';
      html += pinMark;
      html += '<button type="button" class="bk-shelf-select" data-book-id="' + escAttr(rec.bookId) + '" aria-label="选择 ' + escAttr(title) + '" aria-pressed="false">✓</button>';
      // 书架：显示完整书名（不切割书号）
      html += '<div class="bk-shelf-row-info">';
      html += '<div class="bk-shelf-row-title">' + escText(title) + '</div>';
      // 单行元数据：进度/已读日期 + 来源徽标，对齐书城 L3 的 .book-caption-meta 结构
      html += '<div class="bk-shelf-row-meta">';
      html += '<span class="bk-shelf-row-progress">' + escText(subText) + escText(metaExtra) + '</span>';
      var srcBadge = _sourceBadgeHTML(book);
      if (srcBadge) html += srcBadge;
      html += '</div>';
      html += '</div>';
      // 隐藏操作区：保留测试契约（.bk-shelf-markread/.bk-shelf-unread/.bk-shelf-remove-btn），
      // 平时不可见；长按菜单 / 编辑态批量操作经 .click() 复用这些处理器。
      html += '<div class="bk-shelf-row-actions" aria-hidden="true">';
      html += isRead
        ? '<button type="button" class="bk-shelf-unread" data-book-id="' + escAttr(rec.bookId) + '" aria-label="取消已读，移回在读"><span class="bk-shelf-btn-ico" aria-hidden="true">↩</span>移回在读</button>'
        : '<button type="button" class="bk-shelf-markread" data-book-id="' + escAttr(rec.bookId) + '" aria-label="标记为已读"><span class="bk-shelf-btn-ico" aria-hidden="true">✓</span>标记已读</button>';
      html += '<button type="button" class="bk-shelf-remove-btn" data-book-id="' + escAttr(rec.bookId) + '" aria-label="移除">移除</button>';
      html += '</div>';
      html += '</div>';
    }
    listEl.innerHTML = html;

    // 绑定「标记已读」按钮（在读行）：点击 → 弹出笔记输入框 → BKShelf.markRead → 移入已读桶
    var markBtns = listEl.querySelectorAll('.bk-shelf-markread');
    for (var m = 0; m < markBtns.length; m++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-book-id');
          if (!id) return;
          _promptMarkReadNote(id);
        });
      })(markBtns[m]);
    }
    // 绑定「取消已读」按钮（已读行）：点击 → BKShelf.unmarkRead → 移回在读桶
    var unreadBtns = listEl.querySelectorAll('.bk-shelf-unread');
    for (var u = 0; u < unreadBtns.length; u++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-book-id');
          if (id && win.BKShelf && win.BKShelf.unmarkRead) win.BKShelf.unmarkRead(id);
        });
      })(unreadBtns[u]);
    }

    // 绑定移除按钮（二次确认后 BKShelf.purgeBook：按书型差异化清理，由事件监听整体重渲染）
    var rmBtns = listEl.querySelectorAll('.bk-shelf-remove-btn');
    for (var j = 0; j < rmBtns.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-book-id');
          if (!id) return;
          var b = _findBookById(id);
          var name = b ? (b.title || id) : id;
          // 按书型差异化文案：
          //  - 导入书：彻底清本地数据，不可恢复
          //  - 书城下载书：仅移出书架，保留本地缓存作离线兜底，可随时重新加入续读
          var isImported = id.indexOf('imported-') === 0;
          var msg;
          if (isImported) {
            msg = '确定将《' + name + '》移出书架？\n\n将同时清除本书的本地数据（缓存、阅读进度、PDF/EPUB 文件等），无法恢复。';
          } else {
            msg = '确定将《' + name + '》移出书架？\n\n本地缓存将予以保留，可随时重新加入书架继续阅读。';
          }
          if (win.confirm && !win.confirm(msg)) return;
          if (win.BKShelf && win.BKShelf.purgeBook) {
            win.BKShelf.purgeBook(id);
          } else if (win.BKShelf && win.BKShelf.remove) {
            // 降级：仅移出书架记录（老版本或 purgeBook 缺失时）
            win.BKShelf.remove(id);
          }
          // 移除后由 bk-shelf-changed 监听整体重渲染（含统计与空状态）
        });
      })(rmBtns[j]);
    }

    // 编辑态：重渲染后同步选中态与计数；当前桶空则自动退出编辑；并据桶是否为空禁用编辑钮
    var _editBtn = document.getElementById('shelfEditBtn');
    if (_editBtn) _editBtn.disabled = (bucket.length === 0);
    if (_shelfEditing) {
      if (!bucket.length) {
        _exitShelfEdit();
      } else {
        _syncShelfEditSelection();
      }
    }
  }

  // ── 书架：编辑（多选）态 + 长按快捷菜单 ───────────────────────

  function _enterShelfEdit() {
    var page = document.querySelector('.bk-shelf-page');
    if (!page) return;
    _shelfEditing = true;
    _shelfSelected = {};
    page.classList.add('is-editing');
    var btn = document.getElementById('shelfEditBtn');
    if (btn) { btn.textContent = '完成'; btn.setAttribute('aria-label', '完成编辑'); }
    var rows = page.querySelectorAll('.bk-shelf-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.remove('is-selected');
      var sb = rows[i].querySelector('.bk-shelf-select');
      if (sb) sb.setAttribute('aria-pressed', 'false');
    }
    _updateShelfEditCount();
  }

  function _exitShelfEdit() {
    _shelfEditing = false;
    _shelfSelected = {};
    var page = document.querySelector('.bk-shelf-page');
    if (page) {
      page.classList.remove('is-editing');
      var rows = page.querySelectorAll('.bk-shelf-row');
      for (var i = 0; i < rows.length; i++) {
        rows[i].classList.remove('is-selected');
        var sb = rows[i].querySelector('.bk-shelf-select');
        if (sb) sb.setAttribute('aria-pressed', 'false');
      }
    }
    var btn = document.getElementById('shelfEditBtn');
    if (btn) { btn.textContent = '编辑'; btn.setAttribute('aria-label', '编辑书架'); }
    _updateShelfEditCount();
  }

  function _toggleShelfSelection(row) {
    if (!row) return;
    var id = row.getAttribute('data-book-id');
    if (!id) return;
    if (!_shelfSelected) _shelfSelected = {};
    var sel = !_shelfSelected[id];
    if (sel) _shelfSelected[id] = true; else delete _shelfSelected[id];
    row.classList.toggle('is-selected', sel);
    var sb = row.querySelector('.bk-shelf-select');
    if (sb) sb.setAttribute('aria-pressed', sel ? 'true' : 'false');
    _updateShelfEditCount();
  }

  function _syncShelfEditSelection() {
    var page = document.querySelector('.bk-shelf-page');
    if (!page) return;
    var rows = page.querySelectorAll('.bk-shelf-row');
    var still = {};
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].getAttribute('data-book-id');
      var sel = !!(_shelfSelected && _shelfSelected[id]);
      rows[i].classList.toggle('is-selected', sel);
      var sb = rows[i].querySelector('.bk-shelf-select');
      if (sb) sb.setAttribute('aria-pressed', sel ? 'true' : 'false');
      if (sel) still[id] = true;
    }
    _shelfSelected = still;
    _updateShelfEditCount();
  }

  function _updateShelfEditCount() {
    var cnt = _shelfSelected ? Object.keys(_shelfSelected).length : 0;
    var el = document.getElementById('shelfEditCount');
    if (el) el.textContent = '已选 ' + cnt + ' 本';
    var mark = document.getElementById('shelfEditMark');
    if (mark) mark.textContent = (_shelfActiveTab === 'read') ? '移回在读' : '标记已读';
    var markBtn = document.getElementById('shelfEditMark');
    var rmBtn = document.getElementById('shelfEditRemove');
    var exportBtn = document.getElementById('shelfEditExport');
    if (markBtn) markBtn.disabled = (cnt === 0);
    if (rmBtn) rmBtn.disabled = (cnt === 0);
    if (exportBtn) exportBtn.disabled = (cnt === 0);
    var selAll = document.getElementById('shelfSelectAll');
    var page = document.querySelector('.bk-shelf-page');
    var total = page ? page.querySelectorAll('.bk-shelf-row').length : 0;
    if (selAll) selAll.textContent = (total > 0 && cnt === total) ? '取消全选' : '全选';
  }

  // ── 长按菜单图标（currentColor 线性图标，与底部 Tab 栏风格一致） ──
  var ICON_CHECK  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  var ICON_UNDO   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/></svg>';
  var ICON_PIN    = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.5V4h6v6.5l2 3.5H7l2-3.5Z"/></svg>';
  var ICON_PIN_ON = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.5V4h6v6.5l2 3.5H7l2-3.5Z"/></svg>';
  var ICON_INFO   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5v.01"/></svg>';
  var ICON_DESKTOP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
  var ICON_TRASH  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>';
  var ICON_NOTE   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>';
  var ICON_EXPORT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5-5 5 5"/><path d="M12 5v12"/></svg>';

  // 书籍来源描述（用于「书籍详情」面板；缺失则空串）
  function _bookSourceText(book) {
    if (!book) return '';
    var s = book.source;
    if (s && s.type === 'webdav') {
      var label = _sourceLabel(book) || 'WebDAV导入';
      var rawPath = s.remotePath || '';
      // 只取最后一段路径，避免泄漏完整 URL 路径
      var path = rawPath.split('/').filter(Boolean).pop() || '';
      // 路径段可能是 URL 编码的（如 %E4%B8%AD），需解码后显示
      try { path = decodeURIComponent(path); } catch (e) {}
      return label + (path ? (' · ' + path) : '');
    }
    if (s && s.type === 'local') return '本地导入';
    if (s && s.type === 'resource') return '内置资源';
    if (book.series) return (_sourceLabel(book) || '书报目录');
    return '';
  }

  // 书籍详情弹窗（BK.openDialog 统一管理：自动注册返回键 + 隐藏底部 Tab 栏）
  function _openBookDetail(book) {
    if (!book) return;
    var title = book.title || book.id || '未知书籍';
    var rows = [];
    function addRow(label, value) {
      if (value === null || value === undefined || value === '') return;
      rows.push(
        '<div class="bk-detail-row"><div class="bk-detail-label">' + escText(label) + '</div>' +
        '<div class="bk-detail-value">' + escText(String(value)) + '</div></div>'
      );
    }
    if (book.author) addRow('作者', book.author);
    if (book.format) addRow('格式', String(book.format).toUpperCase());
    var cc = book.chapter_count || 0;
    if (cc > 0) {
      var tocLen = (book.toc && book.toc.length) ? book.toc.length : 0;
      addRow('章节', cc + ' 章' + (tocLen ? ('（目录 ' + tocLen + ' 条）') : ''));
    }
    if (book.description) {
      rows.push(
        '<div class="bk-detail-row bk-detail-row-block"><div class="bk-detail-label">简介</div>' +
        '<div class="bk-detail-value">' + escText(book.description) + '</div></div>'
      );
    }
    var src = _bookSourceText(book);
    if (src) addRow('来源', src);
    if (book.series) addRow('系列', _getSeriesTitle(book.series) || book.series);

    var initial = title.replace(/^[《「]/, '').charAt(0) || '?';
    var html =
      '<div class="bk-dialog bk-book-detail">' +
        '<div class="bk-drawer-header">' +
          '<div class="bk-drawer-title">书籍详情</div>' +
          '<button type="button" class="bk-drawer-close" data-action="close" aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="bk-drawer-divider"></div>' +
        '<div class="bk-drawer-body">' +
          '<div class="bk-detail-head">' +
            '<div class="bk-detail-cover" style="background:' + _getSeriesColor(book.series) + '">' + escText(initial) + '</div>' +
            '<div class="bk-detail-name">' + escText(title) + '</div>' +
          '</div>' +
          (rows.length ? rows.join('') : '<div class="bk-detail-empty">暂无更多元信息</div>') +
        '</div>' +
        '<div class="bk-dialog-actions">' +
          '<button type="button" class="bk-dialog-cancel" data-action="close">关闭</button>' +
        '</div>' +
      '</div>';

    if (win.BK && typeof win.BK.openDialog === 'function') {
      var dlg = win.BK.openDialog({ id: 'bkBookDetailMask', html: html });
      if (dlg) {
        dlg.mask.addEventListener('click', function (e) {
          if (e.target.closest('[data-action="close"]')) dlg.close();
        });
      }
    }
  }

  // 添加到桌面快捷方式：复制本书深链 + 唤起 PWA 安装（可用时）；否则提示手动添加
  function _addBookToDesktop(book) {
    if (!book) return;
    var name = book.title || '本书';
    var link = (win.location.origin || '') + (win.location.pathname || '/') + '#/' + book.id;
    var copied = false;
    try {
      if (win.navigator && win.navigator.clipboard && typeof win.navigator.clipboard.writeText === 'function') {
        win.navigator.clipboard.writeText(link);
        copied = true;
      }
    } catch (e) {}
    if (win.BK && typeof win.BK.installPWA === 'function' && win._pwaInstallPrompt) {
      win.BK.installPWA();
      _toast(copied ? ('《' + name + '》链接已复制，可安装到桌面快速打开') : ('正在安装《' + name + '》到桌面…'));
    } else {
      _toast(copied
        ? ('《' + name + '》的打开链接已复制，请在浏览器菜单「添加到主屏幕」')
        : ('当前环境暂不支持安装，已复制《' + name + '》链接'));
    }
  }

  var _shelfQuickLockCleanup = null;

  // ── 导出书籍：格式选择弹框 ──────────────────────────────────────────
  function _showExportBookMenu(bookId, bookTitle) {
    // 判断可用格式：PDF 书仅导出 PDF；其他书支持 TXT/MD/EPUB
    var isPdf = _isPdfBook(bookId);
    var html = '<div class="bk-dialog" style="width:min(320px,calc(100vw - 40px))">' +
      '<div class="bk-dialog-title">导出《' + escText(bookTitle) + '》</div>' +
      '<div class="bk-dialog-body" style="padding:12px 16px">';

    if (isPdf) {
      // 检查是否有标注数据
      var hasAnnotations = _pdfBookHasAnnotations(bookId);
      html += '<button class="bk-ns-export-btn" data-format="pdf"><span class="bk-row-icon">📄</span><span class="bk-row-label">导出原始 PDF</span></button>';
      if (hasAnnotations) {
        html += '<button class="bk-ns-export-btn" data-format="pdf_annotated"><span class="bk-row-icon">🖍</span><span class="bk-row-label">导出含标注 PDF</span><span class="bk-row-hint" style="font-size:11px;color:#888;margin-left:6px">高亮/批注/书签</span></button>';
      }
    } else {
      html += '<button class="bk-ns-export-btn" data-format="txt"><span class="bk-row-icon">📄</span><span class="bk-row-label">导出为 TXT</span></button>';
      html += '<button class="bk-ns-export-btn" data-format="md"><span class="bk-row-icon">📑</span><span class="bk-row-label">导出为 Markdown</span></button>';
      html += '<button class="bk-ns-export-btn" data-format="epub"><span class="bk-row-icon">📚</span><span class="bk-row-label">导出为 EPUB</span></button>';
    }

    html += '<div class="bk-ns-export-divider"></div>';
    html += '<button class="bk-ns-export-btn bk-ns-export-webdav" data-action="upload-webdav"><span class="bk-row-icon">☁️</span><span class="bk-row-label">上传到 WebDAV</span></button>';

    html += '</div>' +
      '<div class="bk-dialog-actions"><button class="bk-dialog-cancel" data-action="close">取消</button></div>' +
      '</div>';

    var dlg = win.BK.openDialog({ id: 'bk-book-export', html: html });
    if (!dlg) return;

    var btns = dlg.mask.querySelectorAll('[data-format]');
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var fmt = btn.getAttribute('data-format');
          if (win.BK && win.BK.Export && win.BK.Export.exportBook) {
            win.BK.Export.exportBook(bookId, fmt).catch(function () { /* 已 toast */ });
          } else {
            _toast('导出功能未就绪，请重启应用');
          }
          if (dlg && dlg.close) dlg.close();
        });
      })(btns[i]);
    }

    var closeBtn = dlg.mask.querySelector('[data-action="close"]');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        if (dlg && dlg.close) dlg.close();
      });
    }

    // 上传到 WebDAV
    var webdavBtn = dlg.mask.querySelector('[data-action="upload-webdav"]');
    if (webdavBtn) {
      webdavBtn.addEventListener('click', function () {
        if (dlg && dlg.close) dlg.close();
        if (win.BK && win.BK.WebDavUpload && win.BK.WebDavUpload.showUploadDialog) {
          win.BK.WebDavUpload.showUploadDialog(bookId);
        } else {
          _toast('WebDAV 上传功能未就绪');
        }
      });
    }
  }

  /** 判断是否为 PDF 书籍（chapters 含 pdf_page 类型） */
  function _isPdfBook(bookId) {
    var books = win.__bkBooks || [];
    for (var i = 0; i < books.length; i++) {
      if (books[i] && (books[i].id === bookId || books[i].bookId === bookId)) {
        var chapters = books[i].chapters || [];
        for (var c = 0; c < chapters.length; c++) {
          var content = chapters[c].content || [];
          for (var j = 0; j < content.length; j++) {
            if (content[j] && content[j].type === 'pdf_page') return true;
          }
        }
        return books[i].format === 'pdf';
      }
    }
    return false;
  }

  /** 判断 PDF 书籍是否有标注数据（高亮/批注/书签） */
  function _pdfBookHasAnnotations(bookId) {
    // 检查高亮
    try {
      var state = win.BKPdf && win.BKPdf._internal && win.BKPdf._internal.state;
      if (state && typeof state.highlights === 'function') {
        var hls = state.highlights(bookId);
        if (hls && hls.length) return true;
      }
      var hlRaw = localStorage.getItem('bk_pdf_hl:' + bookId);
      if (hlRaw) { var parsed = JSON.parse(hlRaw); if (parsed && parsed.length) return true; }
    } catch (e) {}
    // 检查书签
    try {
      var state2 = win.BKPdf && win.BKPdf._internal && win.BKPdf._internal.state;
      if (state2 && typeof state2.bookmarks === 'function') {
        var bms = state2.bookmarks(bookId);
        if (bms && bms.length) return true;
      }
      var bmRaw = localStorage.getItem('bk_pdf_bm:' + bookId);
      if (bmRaw) { var parsed2 = JSON.parse(bmRaw); if (parsed2 && parsed2.length) return true; }
    } catch (e) {}
    return false;
  }

  function _openShelfQuickMenu(row) {
    if (!row) return;
    _closeShelfQuickMenu();
    var page = document.querySelector('.bk-shelf-page');
    if (!page) return;
    var bookId = row.getAttribute('data-book-id');
    var book = _findBookById(bookId) || { id: bookId };
    var isRead = (win.BKShelf && win.BKShelf.isRead) ? win.BKShelf.isRead(bookId) : false;
    var isPinned = (win.BKShelf && win.BKShelf.isPinned) ? win.BKShelf.isPinned(bookId) : false;
    var title = book.title || bookId;
    var author = book.author || '';
    // 头像首字母：去掉前导编号（如"1210-神赐…"取"神"而非"1"）和书名号
    var initial = title.replace(/^[\d]+\s*[-–—:：·.\s]+/, '').replace(/^[《「]/, '').charAt(0) || '?';

    var mask = document.createElement('div');
    mask.className = 'bk-shelf-quick-mask';
    mask.setAttribute('role', 'presentation');
    var sheet = document.createElement('div');
    sheet.className = 'bk-shelf-quick-menu';
    sheet.setAttribute('role', 'menu');
    sheet.setAttribute('aria-label', '书籍操作');

    // 头部：迷你封面 + 书名 + 作者
    sheet.innerHTML =
      '<div class="bk-shelf-quick-head">' +
        '<div class="bk-shelf-quick-cover" style="background:' + _getSeriesColor(book.series) + '">' + escText(initial) + '</div>' +
        '<div class="bk-shelf-quick-headtext">' +
          '<div class="bk-shelf-quick-title">' + escText(title) + '</div>' +
          (author ? '<div class="bk-shelf-quick-author">' + escText(author) + '</div>' : '') +
        '</div>' +
      '</div>';

    var actions = [];
    if (!isRead) {
      actions.push({ icon: ICON_CHECK, label: '标记已读', sel: '.bk-shelf-markread' });
    } else {
      actions.push({ icon: ICON_UNDO, label: '移回在读', sel: '.bk-shelf-unread' });
    }
    actions.push({ icon: isPinned ? ICON_PIN_ON : ICON_PIN, label: isPinned ? '取消置顶' : '置顶本书', act: 'pin', on: isPinned });
    actions.push({ icon: ICON_INFO, label: '书籍详情', act: 'detail' });
    // 笔记操作：有笔记显示"编辑笔记"，无笔记显示"添加笔记"
    var shelfRec = (win.BKShelf && win.BKShelf.get) ? win.BKShelf.get(bookId) : null;
    var hasNote = !!(shelfRec && shelfRec.note);
    actions.push({ icon: ICON_NOTE, label: hasNote ? '编辑笔记' : '添加笔记', act: 'edit-note', hasNote: hasNote });
    actions.push({ icon: ICON_DESKTOP, label: '添加到桌面', act: 'desktop' });
    actions.push({ icon: ICON_EXPORT, label: '导出书籍', act: 'export' });
    actions.push({ icon: ICON_TRASH, label: '移出书架', sel: '.bk-shelf-remove-btn', danger: true });

    actions.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'bk-shelf-quick-item' + (a.danger ? ' is-danger' : '') + (a.on ? ' is-on' : '');
      b.setAttribute('role', 'menuitem');
      b.setAttribute('data-act', a.act || '');
      b.innerHTML =
        '<span class="qi-ico" aria-hidden="true">' + (a.icon || '') + '</span>' +
        '<span class="qi-label">' + escText(a.label) + '</span>' +
        (a.on ? '<span class="qi-trail">已置顶</span>' : '');
      b.addEventListener('click', function () {
        if (a.sel) {
          var target = row.querySelector(a.sel);
          _closeShelfQuickMenu();
          if (target) target.click();
        } else if (a.act === 'pin') {
          _closeShelfQuickMenu();
          if (win.BKShelf && win.BKShelf.setPinned) win.BKShelf.setPinned(bookId, !isPinned);
        } else if (a.act === 'detail') {
          _closeShelfQuickMenu();
          _openBookDetail(book);
        } else if (a.act === 'edit-note') {
          _closeShelfQuickMenu();
          _editShelfNote(bookId);
        } else if (a.act === 'desktop') {
          _closeShelfQuickMenu();
          _addBookToDesktop(book);
        } else if (a.act === 'export') {
          _closeShelfQuickMenu();
          _showExportBookMenu(bookId, title);
        }
      });
      sheet.appendChild(b);
    });

    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'bk-shelf-quick-item bk-shelf-quick-cancel';
    cancel.textContent = '取消';
    cancel.setAttribute('role', 'menuitem');
    cancel.addEventListener('click', function () { _closeShelfQuickMenu(); });
    sheet.appendChild(cancel);

    mask.appendChild(sheet);
    mask.addEventListener('click', function (e) { if (e.target === mask) _closeShelfQuickMenu(); });
    page.appendChild(mask);
    // 防触摸穿透：锁定遮罩滚动
    if (win.BK && win.BK.lockOverlayScroll) {
      _shelfQuickLockCleanup = win.BK.lockOverlayScroll(mask, function() { _closeShelfQuickMenu(); });
    }
    // 触发入场动画
    if (win.requestAnimationFrame) {
      win.requestAnimationFrame(function () { mask.classList.add('is-open'); });
    } else {
      mask.classList.add('is-open');
    }
  }

  function _closeShelfQuickMenu() {
    if (_shelfQuickLockCleanup) { _shelfQuickLockCleanup(); _shelfQuickLockCleanup = null; }
    var m = document.querySelector('.bk-shelf-quick-mask');
    if (m && m.parentNode) m.parentNode.removeChild(m);
  }

  /**
   * 编辑/添加书架笔记（独立面板，不影响已读状态）
   * 支持新建笔记、修改已有笔记、删除笔记
   */
  function _editShelfNote(bookId) {
    var book = _findBookById(bookId);
    var name = book ? (book.title || bookId) : bookId;
    var shelfRec = (win.BKShelf && win.BKShelf.get) ? win.BKShelf.get(bookId) : null;
    var existingNote = (shelfRec && shelfRec.note) || '';

    if (!win.BK || !win.BK.openDialog) {
      // 降级：无法弹窗
      return;
    }

    var html =
      '<div class="bk-dialog" style="width:min(340px,calc(100vw - 40px))">' +
        '<div class="bk-dialog-title">' + (existingNote ? '编辑笔记' : '添加笔记') + '</div>' +
        '<div class="bk-dialog-body" style="padding:12px 16px">' +
          '<div style="font-size:0.8125em;color:var(--text-secondary);margin-bottom:10px">《' + _escShelfHtml(name) + '》</div>' +
          '<textarea class="bk-note-textarea" id="bkShelfEditNoteTa" placeholder="输入读书笔记…" rows="5" style="width:100%;box-sizing:border-box">' + _escShelfHtml(existingNote) + '</textarea>' +
        '</div>' +
        '<div class="bk-dialog-actions">' +
          (existingNote ? '<button class="bk-dialog-cancel" style="color:var(--danger,#d9534f)" id="bkShelfEditNoteDel">删除笔记</button>' : '') +
          '<button class="bk-dialog-cancel" id="bkShelfEditNoteCancel">取消</button>' +
          '<button class="bk-dialog-confirm" id="bkShelfEditNoteOk">保存</button>' +
        '</div>' +
      '</div>';

    var dlg = win.BK.openDialog({ id: 'bk-shelf-edit-note-dialog', html: html });
    if (!dlg) return;

    var dialogEl = document.getElementById('bk-shelf-edit-note-dialog');
    if (!dialogEl) return;

    var ta = dialogEl.querySelector('#bkShelfEditNoteTa');
    var cancelBtn = dialogEl.querySelector('#bkShelfEditNoteCancel');
    var okBtn = dialogEl.querySelector('#bkShelfEditNoteOk');
    var delBtn = dialogEl.querySelector('#bkShelfEditNoteDel');

    if (cancelBtn) cancelBtn.addEventListener('click', function () { dlg.close(); });
    if (okBtn) okBtn.addEventListener('click', function () {
      var note = ta ? ta.value.trim() : '';
      if (win.BKShelf && win.BKShelf.updateNote) win.BKShelf.updateNote(bookId, note || null);
      dlg.close();
    });
    if (delBtn) delBtn.addEventListener('click', function () {
      if (win.confirm && !win.confirm('确定删除此笔记？')) return;
      if (win.BKShelf && win.BKShelf.removeNote) win.BKShelf.removeNote(bookId);
      dlg.close();
    });
    if (ta) setTimeout(function () {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }, 50);
  }

  /**
   * 标记已读时弹出可选笔记输入框
   * 用户可快速点"确定"跳过笔记（保持原行为），或输入笔记后确认
   */
  function _promptMarkReadNote(bookId) {
    var book = _findBookById(bookId);
    var name = book ? (book.title || bookId) : bookId;

    if (!win.BK || !win.BK.openDialog) {
      // 降级：直接标记无笔记
      if (win.BKShelf && win.BKShelf.markRead) win.BKShelf.markRead(bookId);
      return;
    }

    var html =
      '<div class="bk-dialog" style="width:min(340px,calc(100vw - 40px))">' +
        '<div class="bk-dialog-title">标记已读</div>' +
        '<div class="bk-dialog-body" style="padding:12px 16px">' +
          '<div style="font-size:0.8125em;color:var(--text-secondary);margin-bottom:10px">《' + _escShelfHtml(name) + '》</div>' +
          '<textarea class="bk-bm-note-textarea" id="bkShelfNoteTa" placeholder="添加读书笔记（可选）" rows="3" style="width:100%;box-sizing:border-box"></textarea>' +
        '</div>' +
        '<div class="bk-dialog-actions">' +
          '<button class="bk-dialog-cancel" id="bkShelfNoteCancel">取消</button>' +
          '<button class="bk-dialog-confirm" id="bkShelfNoteOk">确定</button>' +
        '</div>' +
      '</div>';

    var dlg = win.BK.openDialog({ id: 'bk-shelf-note-dialog', html: html });
    if (!dlg) {
      if (win.BKShelf && win.BKShelf.markRead) win.BKShelf.markRead(bookId);
      return;
    }

    var dialogEl = document.getElementById('bk-shelf-note-dialog');
    if (!dialogEl) return;

    var ta = dialogEl.querySelector('#bkShelfNoteTa');
    var cancelBtn = dialogEl.querySelector('#bkShelfNoteCancel');
    var okBtn = dialogEl.querySelector('#bkShelfNoteOk');

    if (cancelBtn) cancelBtn.addEventListener('click', function () { dlg.close(); });
    if (okBtn) okBtn.addEventListener('click', function () {
      var note = ta ? ta.value.trim() : '';
      if (win.BKShelf && win.BKShelf.markRead) win.BKShelf.markRead(bookId, { note: note || null });
      dlg.close();
    });
    if (ta) setTimeout(function () { ta.focus(); }, 50);
  }

  /**
   * 批量导出选中的书籍为 ZIP 压缩包
   * @param {string[]} bookIds  选中的书籍 ID 列表
   */
  function _doBatchExport(bookIds) {
    if (!bookIds || !bookIds.length) return;
    if (!win.BK || !win.BK.Export || !win.BK.Export.exportBatch) {
      _toast('导出功能未就绪，请重启应用');
      return;
    }

    // 弹出进度对话框
    var progressHtml =
      '<div class="bk-dialog" style="width:min(320px,calc(100vw - 40px))">' +
        '<div class="bk-dialog-title">批量导出</div>' +
        '<div class="bk-dialog-body" style="padding:16px;text-align:center">' +
          '<div id="bkBatchExportText">正在准备... 0/' + bookIds.length + '</div>' +
          '<div style="margin-top:12px;height:6px;border-radius:3px;background:var(--bg-surface,#f0ece6);overflow:hidden">' +
            '<div id="bkBatchExportBar" style="height:100%;width:0%;background:var(--primary,#4a90d9);border-radius:3px;transition:width .2s"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    var progressDlg = win.BK.openDialog({ id: 'bk-batch-export-progress', html: progressHtml });
    var closed = false;

    win.BK.Export.exportBatch(bookIds, {
      onProgress: function (current, total, bookTitle) {
        var textEl = document.getElementById('bkBatchExportText');
        var barEl = document.getElementById('bkBatchExportBar');
        if (textEl) textEl.textContent = '正在导出 ' + current + '/' + total + ' 《' + bookTitle + '》';
        if (barEl) barEl.style.width = Math.round((current / total) * 100) + '%';
      }
    }).then(function () {
      closed = true;
      if (progressDlg && progressDlg.close) progressDlg.close();
    }).catch(function (err) {
      closed = true;
      if (progressDlg && progressDlg.close) progressDlg.close();
      console.error('[批量导出] 失败：', err);
      _toast('导出失败：' + (err && err.message || '未知错误'));
    });
  }

  function _escShelfHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

