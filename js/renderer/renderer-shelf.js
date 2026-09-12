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
    }).catch(function () {
      _renderShelfList(); // 合并失败也兜底渲染，避免书架不刷新
    });
  }

  /**
   * 书架筛选选项定义。
   * value 对应 _shelfFilter 状态值。
   */
  var SHELF_FILTERS = [
    { value: 'all',       label: '全部' },
    { value: 'favorite',  label: '收藏' },
    { value: 'read',      label: '已读' },
    { value: 'imported',  label: '本地导入' },
    { value: 'city',      label: '书城' },
    { value: 'webdav',    label: 'WebDAV' }
  ];

  /**
   * 判断单本书是否符合当前筛选条件。
   * @param {Object} rec 书架记录
   * @param {Object|null} book 书籍元数据
   * @returns {boolean}
   */
  function _matchShelfFilter(rec, book) {
    switch (_shelfFilter) {
      case 'all':
        return true;
      case 'favorite':
        return !!(rec && rec.favorite === true);
      case 'read':
        return !!(rec && rec.finished === true);
      case 'imported':
        return rec.bookId.indexOf('imported-') === 0;
      case 'city':
        return rec.bookId.indexOf('imported-') !== 0;
      case 'webdav':
        return !!(book && book.source && book.source.type === 'webdav');
      default:
        return true;
    }
  }

  /**
   * 获取当前筛选的显示名称。
   * @returns {string}
   */
  function _shelfFilterLabel() {
    for (var i = 0; i < SHELF_FILTERS.length; i++) {
      if (SHELF_FILTERS[i].value === _shelfFilter) return SHELF_FILTERS[i].label;
    }
    return '全部';
  }

  /**
   * 打开/关闭书架筛选下拉菜单。
   */
  function _toggleShelfFilterMenu() {
    var existing = document.querySelector('.bk-shelf-filter-dropdown');
    if (existing) { _closeShelfFilterMenu(); return; }
    _openShelfFilterMenu();
  }

  function _openShelfFilterMenu() {
    var btn = document.getElementById('shelfFilterBtn');
    if (!btn) return;
    _closeShelfFilterMenu(); // 先清理残留

    var dropdown = document.createElement('div');
    dropdown.className = 'bk-shelf-filter-dropdown';
    dropdown.setAttribute('role', 'menu');
    dropdown.setAttribute('aria-label', '筛选书籍');

    for (var i = 0; i < SHELF_FILTERS.length; i++) {
      var f = SHELF_FILTERS[i];
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'bk-shelf-filter-item' + (f.value === _shelfFilter ? ' is-active' : '');
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', f.value === _shelfFilter ? 'true' : 'false');
      item.setAttribute('data-filter', f.value);
      item.innerHTML =
        '<span class="bk-shelf-filter-item-label">' + escText(f.label) + '</span>' +
        (f.value === _shelfFilter ? '<svg class="bk-shelf-filter-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : '');
      (function (val) {
        item.addEventListener('click', function () {
          _shelfFilter = val;
          _closeShelfFilterMenu();
          _renderShelfList();
        });
      })(f.value);
      dropdown.appendChild(item);
    }

    // 将 dropdown 放在 body 末尾避免被裁切
    document.body.appendChild(dropdown);

    // 定位到按钮下方
    var btnRect = btn.getBoundingClientRect();
    var dropdownRect = dropdown.getBoundingClientRect();
    var left = btnRect.left;
    // 如果右侧溢出，则右对齐按钮
    if (left + dropdownRect.width > window.innerWidth - 8) {
      left = btnRect.right - dropdownRect.width;
    }
    if (left < 8) left = 8;
    dropdown.style.left = left + 'px';
    dropdown.style.top = (btnRect.bottom + 4) + 'px';

    if (btn) btn.setAttribute('aria-expanded', 'true');

    // 点击外部关闭
    setTimeout(function () {
      var mask = document.createElement('div');
      mask.className = 'bk-shelf-filter-mask';
      mask.style.position = 'fixed';
      mask.style.inset = '0';
      mask.style.zIndex = '999';
      mask.addEventListener('click', function () {
        _closeShelfFilterMenu();
      });
      document.body.appendChild(mask);
      dropdown._mask = mask;
    }, 0);

    // 入场动画
    if (win.requestAnimationFrame) {
      win.requestAnimationFrame(function () { dropdown.classList.add('is-open'); });
    } else {
      dropdown.classList.add('is-open');
    }
  }

  function _closeShelfFilterMenu() {
    var dropdown = document.querySelector('.bk-shelf-filter-dropdown');
    if (dropdown) {
      if (dropdown._mask && dropdown._mask.parentNode) dropdown._mask.parentNode.removeChild(dropdown._mask);
      if (dropdown.parentNode) dropdown.parentNode.removeChild(dropdown);
    }
    var btn = document.getElementById('shelfFilterBtn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }


  function _renderShelfList() {
    var listEl = document.getElementById('shelfList');
    if (!listEl || !win.BKShelf) return;

    // 同步完成状态：修复「进度100%但未标记已读」的不一致
    _syncAllBookCompletion();

    var records = win.BKShelf.all();
    var _isReadFn = function (id) {
      return (win.BKShelf && win.BKShelf.isRead) ? win.BKShelf.isRead(id) : false;
    };

    // 筛选当前条件下的书籍
    var bucket = [];
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      var book = _findBookById(rec.bookId) || { id: rec.bookId };
      if (_matchShelfFilter(rec, book)) bucket.push(rec);
    }

    // 更新筛选标签和计数
    var labelEl = document.getElementById('shelfFilterLabel');
    if (labelEl) labelEl.textContent = _shelfFilterLabel();
    var countEl = document.getElementById('shelfFilterCount');
    if (countEl) countEl.textContent = bucket.length + ' 本';
    // 更新筛选按钮激活态
    var filterBtn = document.getElementById('shelfFilterBtn');
    if (filterBtn) filterBtn.classList.toggle('has-filter', _shelfFilter !== 'all');

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
    if (!bucket.length) {
      listEl.innerHTML =
        '<div class="bk-shelf-tab-empty">' +
          _shelfFilterLabel() + '列表还是空的' +
        '</div>';
      return;
    }

    var html = '';
    for (var i2 = 0; i2 < bucket.length; i2++) {
      var rec2 = bucket[i2];
      var book2 = _findBookById(rec2.bookId) || { id: rec2.bookId, title: rec2.bookId, series: '' };
      var title = book2.title || (rec2.bookId || '未知书籍');
      var author = book2.author || _getSeriesTitle(book2.series) || '';
      var cover = _coverHTML(book2, { varyByBook: true, seriesTitle: _sourceLabel(book2) || _getSeriesTitle(book2.series) });
      var isRead = _isReadFn(rec2.bookId);
      var pinned = (win.BKShelf && win.BKShelf.isPinned) ? win.BKShelf.isPinned(rec2.bookId) : false;
      var isFav = (win.BKShelf && win.BKShelf.isFavorite) ? win.BKShelf.isFavorite(rec2.bookId) : false;

      // 行副文案：读完显「已于 X 读完」；未读完显「已读 X%」百分比进度
      var subText;
      if (isRead) {
        subText = escText(rec2.completedAt || '');
      } else {
        var readChCount = 0;
        var cc = book2.chapter_count || 0;
        for (var _rni = 1; _rni <= cc; _rni++) {
          if (_isChapterReadByScroll(rec2.bookId, _rni)) readChCount++;
        }
        var pct = (cc > 0 && readChCount > 0) ? Math.round(readChCount / cc * 100) : 0;
        subText = pct > 0 ? ('已读 ' + pct + '%') : '未读';
      }
      var metaExtra = '';
      if (rec2.rating) metaExtra += ' ★' + rec2.rating;
      if (rec2.note) metaExtra += ' · 有笔记';

      // 海报卡
      html += '<div class="bk-shelf-row bk-poster-card' + (isRead ? ' is-read' : '') + '" data-book-id="' + escAttr(rec2.bookId) + '" role="button" tabindex="0" aria-label="打开 ' + escAttr(title) + '">';
      var pinMark = pinned ? '<span class="bk-shelf-pin-mark" aria-label="已置顶" role="img">📌</span>' : '';
      var favMark = isFav ? '<span class="bk-shelf-fav-mark" aria-label="已收藏" role="img">❤</span>' : '';
      var srcBadge = _sourceBadgeHTML(book2);
      html += '<div class="bk-shelf-row-cover">' + cover + (srcBadge ? '<div class="bk-shelf-row-badge">' + srcBadge + '</div>' : '') + '</div>';
      html += pinMark;
      html += favMark;
      html += '<button type="button" class="bk-shelf-select" data-book-id="' + escAttr(rec2.bookId) + '" aria-label="选择 ' + escAttr(title) + '" aria-pressed="false">✓</button>';
      html += '<div class="bk-shelf-row-info bk-poster-card__caption">';
      html += '<div class="bk-shelf-row-title bk-poster-card__title">' + escText(title) + '</div>';
      html += '<div class="bk-shelf-row-meta bk-poster-card__meta">';
      html += '<span class="bk-shelf-row-progress">' + escText(subText) + '</span>';
      html += '</div>';
      html += '</div>';
      // 隐藏操作区
      html += '<div class="bk-shelf-row-actions" aria-hidden="true">';
      html += isRead
        ? '<button type="button" class="bk-shelf-unread" data-book-id="' + escAttr(rec2.bookId) + '" aria-label="取消已读，移回在读"><span class="bk-shelf-btn-ico" aria-hidden="true">↩</span>移回在读</button>'
        : '<button type="button" class="bk-shelf-markread" data-book-id="' + escAttr(rec2.bookId) + '" aria-label="标记为已读"><span class="bk-shelf-btn-ico" aria-hidden="true">✓</span>标记已读</button>';
      html += '<button type="button" class="bk-shelf-remove-btn" data-book-id="' + escAttr(rec2.bookId) + '" aria-label="移除">移除</button>';
      html += '</div>';
      html += '</div>';
    }
    listEl.innerHTML = html;

    // 绑定「标记已读」按钮
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
    // 绑定「取消已读」按钮
    var unreadBtns = listEl.querySelectorAll('.bk-shelf-unread');
    for (var u = 0; u < unreadBtns.length; u++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-book-id');
          if (id && win.BKShelf && win.BKShelf.unmarkRead) win.BKShelf.unmarkRead(id);
        });
      })(unreadBtns[u]);
    }

    // 绑定移除按钮
    var rmBtns = listEl.querySelectorAll('.bk-shelf-remove-btn');
    for (var j = 0; j < rmBtns.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-book-id');
          if (!id) return;
          var b = _findBookById(id);
          var name = b ? (b.title || id) : id;
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
            win.BKShelf.remove(id);
          }
        });
      })(rmBtns[j]);
    }

    // 编辑态：重渲染后同步选中态与计数
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
    if (mark) mark.textContent = (_shelfFilter === 'read') ? '移回在读' : '标记已读';
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
  var ICON_FAV     = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/></svg>';
  var ICON_FAV_ON  = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/></svg>';
  var ICON_INFO   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5v.01"/></svg>';

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
    // 书架记录字段（卡面只留进度/日期，评分/笔记/收藏/读完日期移至详情）
    var shelfRec = (win.BKShelf && win.BKShelf.get) ? win.BKShelf.get(book.id) : null;
    if (shelfRec) {
      if (shelfRec.favorite === true) addRow('收藏', '❤ 已收藏');
      if (shelfRec.completedAt) addRow('读完于', shelfRec.completedAt);
      if (shelfRec.addedAt) addRow('收藏于', shelfRec.addedAt);
      if (shelfRec.rating) addRow('评分', '★'.repeat(shelfRec.rating) + ' ' + shelfRec.rating + '/5');
      if (shelfRec.note) addRow('笔记', shelfRec.note);
    }

    var initial = title.replace(/^[《「]/, '').charAt(0) || '?';
    // 阅读进度（用于 CTA 文案与跳转落点）；多来源兜底，缺失则回退为「开始阅读」
    var _prog = 0;
    try {
      if (typeof getReadingProgress === 'function') _prog = getReadingProgress(book.id);
      else if (win.BK && typeof win.BK.getReadingProgress === 'function') _prog = win.BK.getReadingProgress(book.id);
    } catch (e) {}
    var _ctaLabel = _prog > 0 ? '继续阅读' : '开始阅读';
    var html =
      '<div class="bk-dialog bk-book-detail">' +
        '<div class="bk-drawer-header">' +
          '<div class="bk-drawer-title">书籍详情</div>' +
          '<button type="button" class="bk-drawer-close" data-action="close" aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="bk-drawer-divider"></div>' +
        '<div class="bk-drawer-body">' +
          '<div class="bk-detail-head">' +
            '<div class="bk-detail-cover-wrap">' + _coverHTML(book, { size: 'lg' }) + '</div>' +
            '<div class="bk-detail-name-block">' +
              '<div class="bk-detail-name">' + escText(title) + '</div>' +
              (book.author ? '<div class="bk-detail-author">' + escText(book.author) + '</div>' : '') +
            '</div>' +
          '</div>' +
          (rows.length ? rows.join('') : '<div class="bk-detail-empty">暂无更多元信息</div>') +
        '</div>' +
        '<div class="bk-dialog-actions">' +
          '<button type="button" class="bk-dialog-cancel" data-action="close">关闭</button>' +
          '<button type="button" class="bk-dialog-primary" data-action="open-book">' + escText(_ctaLabel) + '</button>' +
        '</div>' +
      '</div>';

    if (win.BK && typeof win.BK.openDialog === 'function') {
      var dlg = win.BK.openDialog({ id: 'bkBookDetailMask', html: html });
      if (dlg) {
        dlg.mask.addEventListener('click', function (e) {
          if (e.target.closest('[data-action="close"]')) { dlg.close(); return; }
          if (e.target.closest('[data-action="open-book"]')) {
            if (win.BKRouter) {
              var _p = 0;
              try {
                if (typeof getReadingProgress === 'function') _p = getReadingProgress(book.id);
                else if (win.BK && typeof win.BK.getReadingProgress === 'function') _p = win.BK.getReadingProgress(book.id);
              } catch (e2) {}
              win.BKRouter.navigate(book.id + (_p > 0 ? '/' + _p : ''));
            }
            dlg.close();
          }
        });
      }
    }
  }

  var _shelfQuickLockCleanup = null;
  var _quickMenuInBackStack = false; // 快捷菜单是否已注册到 backStack（防双重消耗）

  // ── 导出书籍：格式选择弹框 ──────────────────────────────────────────
  function _showExportBookMenu(bookId, bookTitle) {
    // 获取书籍原始导入格式，用于默认选中
    var bookObj = _findBookById(bookId);
    var originalFormat = bookObj && bookObj.format ? bookObj.format : '';
    // 判断是否为 PDF 书
    var isPdf = _isPdfBook(bookId);

    var html = '<div class="bk-dialog" style="width:min(320px,calc(100vw - 40px))">' +
      '<div class="bk-dialog-title">导出《' + escText(bookTitle) + '》</div>' +
      '<div class="bk-dialog-body" style="padding:12px 16px">';

    if (isPdf) {
      // 检查是否有标注数据
      var hasAnnotations = _pdfBookHasAnnotations(bookId);
      html += '<button class="bk-ns-export-btn' + (originalFormat === 'pdf' || !originalFormat ? ' bk-ns-export-selected' : '') + '" data-format="pdf"><span class="bk-row-icon">📄</span><span class="bk-row-label">导出原始 PDF</span></button>';
      if (hasAnnotations) {
        html += '<button class="bk-ns-export-btn' + (originalFormat === 'pdf_annotated' ? ' bk-ns-export-selected' : '') + '" data-format="pdf_annotated"><span class="bk-row-icon">🖍</span><span class="bk-row-label">导出含标注 PDF</span><span class="bk-row-hint" style="font-size:11px;color:#888;margin-left:6px">高亮/批注/书签</span></button>';
      }
    } else {
      var fmtHint = function(fmt) {
        return originalFormat === fmt ? '<span class="bk-row-hint" style="font-size:11px;color:#888;margin-left:6px">原始格式</span>' : '';
      };
      var fmtCls = function(fmt) {
        return originalFormat === fmt ? ' bk-ns-export-selected' : '';
      };
      html += '<button class="bk-ns-export-btn' + fmtCls('txt') + '" data-format="txt"><span class="bk-row-icon">📄</span><span class="bk-row-label">导出为 TXT</span>' + fmtHint('txt') + '</button>';
      html += '<button class="bk-ns-export-btn' + fmtCls('md') + '" data-format="md"><span class="bk-row-icon">📑</span><span class="bk-row-label">导出为 Markdown</span>' + fmtHint('md') + '</button>';
      html += '<button class="bk-ns-export-btn' + fmtCls('epub') + '" data-format="epub"><span class="bk-row-icon">📚</span><span class="bk-row-label">导出为 EPUB</span>' + fmtHint('epub') + '</button>';
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
    var isFav = (win.BKShelf && win.BKShelf.isFavorite) ? win.BKShelf.isFavorite(bookId) : false;
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
    actions.push({ icon: isFav ? ICON_FAV_ON : ICON_FAV, label: isFav ? '取消收藏' : '收藏本书', act: 'favorite', on: isFav });
    actions.push({ icon: ICON_INFO, label: '书籍详情', act: 'detail' });
    // 笔记操作：有笔记显示"编辑笔记"，无笔记显示"添加笔记"
    var shelfRec = (win.BKShelf && win.BKShelf.get) ? win.BKShelf.get(bookId) : null;
    var hasNote = !!(shelfRec && shelfRec.note);
    actions.push({ icon: ICON_NOTE, label: hasNote ? '编辑批注' : '添加批注', act: 'edit-note', hasNote: hasNote });
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
        (a.on ? '<span class="qi-trail">' + (a.act === 'favorite' ? '已收藏' : '已置顶') + '</span>' : '');
      b.addEventListener('click', function () {
        if (a.sel) {
          var target = row.querySelector(a.sel);
          _closeShelfQuickMenu();
          if (target) target.click();
        } else if (a.act === 'pin') {
          _closeShelfQuickMenu();
          if (win.BKShelf && win.BKShelf.setPinned) win.BKShelf.setPinned(bookId, !isPinned);
        } else if (a.act === 'favorite') {
          _closeShelfQuickMenu();
          if (win.BKShelf && win.BKShelf.setFavorite) win.BKShelf.setFavorite(bookId, !isFav);
        } else if (a.act === 'detail') {
          _closeShelfQuickMenu();
          _openBookDetail(book);
        } else if (a.act === 'edit-note') {
          _closeShelfQuickMenu();
          _editShelfNote(bookId);
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
    // 注册到 backStack：系统返回键关闭快捷菜单（对齐 data-sync-page 模式）
    if (win.BK && win.BK.backStack) {
      _quickMenuInBackStack = true;
      win.BK.backStack.push(function () {
        _quickMenuInBackStack = false;
        _closeShelfQuickMenu();
      });
    }
  }

  function _closeShelfQuickMenu() {
    if (_shelfQuickLockCleanup) { _shelfQuickLockCleanup(); _shelfQuickLockCleanup = null; }
    var m = document.querySelector('.bk-shelf-quick-mask');
    if (m && m.parentNode) m.parentNode.removeChild(m);
    // 主动关闭（点选菜单项/取消/遮罩等）：消耗对应 history 条目；
    // 系统返回键触发时回调已置 _quickMenuInBackStack=false，不会走到这里
    if (_quickMenuInBackStack && win.BK && win.BK.backStack) {
      _quickMenuInBackStack = false;
      win.BK.backStack.discard();
    }
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
        '<div class="bk-dialog-title">' + (existingNote ? '编辑批注' : '添加批注') + '</div>' +
        '<div class="bk-dialog-body" style="padding:12px 16px">' +
          '<div style="font-size:0.8125em;color:var(--text-secondary);margin-bottom:10px">《' + _escShelfHtml(name) + '》</div>' +
          '<textarea class="bk-note-textarea" id="bkShelfEditNoteTa" placeholder="输入批注…" rows="5" style="width:100%;box-sizing:border-box">' + _escShelfHtml(existingNote) + '</textarea>' +
        '</div>' +
        '<div class="bk-dialog-actions">' +
          (existingNote ? '<button class="bk-dialog-cancel" style="color:var(--danger,#d9534f)" id="bkShelfEditNoteDel">删除批注</button>' : '') +
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
      if (win.confirm && !win.confirm('确定删除此批注？')) return;
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
   * 批量导出选中的书籍为 ZIP 压缩包（BK.SyncCore v4 完整数据包）
   * @param {string[]} bookIds  选中的书籍 ID 列表
   */
  function _doBatchExport(bookIds) {
    if (!bookIds || !bookIds.length) return;
    if (!win.BK || !win.BK.SyncCore || !win.BK.SyncCore.exportData) {
      _toast('导出功能未就绪，请重启应用');
      return;
    }

    // 弹出进度提示（SyncCore 无逐本进度回调，仅显示一次性文案）
    var progressHtml =
      '<div class="bk-dialog" style="width:min(320px,calc(100vw - 40px))">' +
        '<div class="bk-dialog-title">批量导出</div>' +
        '<div class="bk-dialog-body" style="padding:16px;text-align:center">' +
          '<div id="bkBatchExportText">正在导出 ' + bookIds.length + ' 本书…</div>' +
        '</div>' +
      '</div>';

    var progressDlg = win.BK.openDialog({ id: 'bk-batch-export-progress', html: progressHtml });

    win.BK.SyncCore.exportData('full', { bookIds: bookIds }).then(function () {
      if (progressDlg && progressDlg.close) progressDlg.close();
    }).catch(function (err) {
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

