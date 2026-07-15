'use strict';

  // ── 渲染器对象 ──────────────────────────────────────────────────────

  var BKRenderer = {

    // zl-html 渲染器激活标志
    _zlActive: false,

    // ── 首页：书籍列表（增强版：zl-html 系列分类 + 下载管理）──────────

    renderHome: function () {
      // 决策④：首屏由书城改为书架（#/shelf）。renderHome 薄转发，
      // 旧 _renderEnhancedHome / _renderZlHome 已随书城改为 #/city 而下线。
      BKRenderer.renderShelfPage();
    },

    // ── 书城：多级下钻（系列 → 分类 → 书籍）──────────────────────────
    // 渲染进 #homeView；内部状态机（_city*）表达三级下钻，不进 hash。

    renderCityPage: function () {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
      _cleanupPdfCache();
      document.body.classList.remove('bk-reading-page');
      showHome();
      var homeView = document.getElementById('homeView');
      if (!homeView) return;
      document.title = '书城';
      if (!_zlDmReady) {
        _ensureDmInit().then(function () {
          _renderCityHome(homeView);
          _bindCityEvents(homeView);
          _registerCityGlobalHandlers();
        }).catch(function () {});
      } else {
        _renderCityHome(homeView);
        _bindCityEvents(homeView);
        _registerCityGlobalHandlers();
      }
    },

    /**
     * 系列书籍列表页（独立深链 #/series/<id>，来自搜索「热门系列」卡片）
     * 主轴翻转后：books（跨分类系列）→ 进二级分类列表；其余单分类系列 → 直接进三级书籍列表（implicit）。
     * 复用书城三级下钻的渲染与无限滚动基建。
     */
    renderSeriesPage: function (seriesId) {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
      _cleanupPdfCache();
      document.body.classList.remove('bk-reading-page');
      showHome();
      var homeView = document.getElementById('homeView');
      if (!homeView) return;
      document.title = '书城';

      function render() {
        if (seriesId === 'books') {
          // 跨分类系列 → 进二级分类列表
          _renderCityCategoryList(homeView, seriesId);
        } else {
          var cats = _getSeriesCategories(seriesId);
          if (cats.length === 1) {
            // 单分类系列 → 隐式跳过二级，直接进三级书籍列表
            _renderCityBookList(homeView, seriesId, cats[0].name, cats[0].prefix, true);
          } else {
            // 多分类（理论上非 books 系列均为单分类，此处为兜底）
            _renderCityCategoryList(homeView, seriesId);
          }
        }
        _bindCityEvents(homeView);
        _registerCityGlobalHandlers();
      }

      if (!_zlDmReady) {
        _ensureDmInit().then(function () { render(); }).catch(function () {
          _renderCityHome(homeView);
          _bindCityEvents(homeView);
          _registerCityGlobalHandlers();
        });
      } else {
        render();
      }
    },

    // 无限滚动加载更多（测试可调用；内部已含 IntersectionObserver 守卫）
    cityLoadMore: function () {
      _cityLoadMore();
    },

    // ── 目录页：章节列表 ────────────────────────────────────────────

    // ── 我的（个人中心，手机/平板） ─────────────────────────────

    renderMyPage: function () {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
      _cleanupPdfCache();
      document.body.classList.remove('bk-reading-page');
      showApp();
      var app = getApp();

      // 环境判断（与 themePanel 一致的可见性规则，避免「点了没反应」的无效行）
      var ua = navigator.userAgent;
      var isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
      var isNativeApp = isCapacitor;
      var isPwaStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone;
      var isAndroid = /Android/i.test(ua);
      var isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
      var isStandalone = (window.navigator.standalone === true) || window.matchMedia('(display-mode: standalone)').matches;
      var canUpdate = isCapacitor || (isStandalone && ('caches' in window));

      var html = '<div class="bk-settings-page">';
      html += '<div class="bk-settings-header"><h1>我的</h1></div>';
      html += '<div class="bk-settings-grid">';
      html += '<div class="bk-settings-left">';

      // 个人卡
      html += '<div class="bk-profile-card">';
      html += '<div class="bk-profile-avatar">读</div>';
      html += '<div class="bk-profile-info"><div class="bk-profile-name">书报读者</div><div class="bk-profile-sub">在阅读中遇见美好</div></div>';
      html += '</div>';

      // 统计卡
      html += '<div class="bk-stats-card">';
      html += '<div class="bk-stat"><span class="bk-stat-num" id="meStatBooks">—</span><span class="bk-stat-label">书籍</span></div>';
      html += '<div class="bk-stat"><span class="bk-stat-num" id="meStatChapters">—</span><span class="bk-stat-label">章节</span></div>';
      html += '<div class="bk-stat"><span class="bk-stat-num" id="meStatBookmarks">—</span><span class="bk-stat-label">书签</span></div>';
      html += '</div>';

      // 设置入口：打开阅读界面的设置弹窗（阅读模式 + 字体大小），避免「我的」页内联冗余
      html += '<button class="bk-settings-entry" data-action="open-theme-panel" type="button">';
      html += '<span class="bk-settings-entry-icon">⚙️</span>';
      html += '<span class="bk-settings-entry-text"><span class="bk-settings-entry-label">设置</span><span class="bk-settings-entry-sub">阅读模式 · 字体大小</span></span>';
      html += '<span class="bk-settings-entry-arrow">›</span>';
      html += '</button>';

      // 内容与数据
      html += '<div class="bk-settings-section">';
      html += '<div class="bk-settings-section-title">内容与数据</div>';
      html += '<button class="bk-settings-row" data-action="bookmarks"><span class="bk-row-icon">📑</span><span class="bk-row-label">我的书签</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" data-action="clear-data"><span class="bk-row-icon">🧹</span><span class="bk-row-label">清理数据</span><span class="bk-row-arrow">›</span></button>';
      html += '</div>';
      html += '</div>'; // bk-settings-left end

      html += '<div class="bk-settings-right">';

      // 应用（按环境显示，避免无效行）
      html += '<div class="bk-settings-section">';
      html += '<div class="bk-settings-section-title">应用</div>';
      if (!isNativeApp && !isPwaStandalone) {
        html += '<button class="bk-settings-row" data-action="install-pwa"><span class="bk-row-icon">📲</span><span class="bk-row-label">发送桌面</span><span class="bk-row-arrow">›</span></button>';
        html += '<div class="cache-status" id="meInstallStatus" style="display:none"></div>';
      }
      if (isAndroid && !isCapacitor) {
        html += '<button class="bk-settings-row" data-action="android-apk"><span class="bk-row-icon">📱</span><span class="bk-row-label">安卓APK</span><span class="bk-row-arrow">›</span></button>';
        html += '<div class="cache-status" id="meApkStatus" style="display:none"></div>';
      }
      if (canUpdate) {
        html += '<button class="bk-settings-row" data-action="check-update"><span class="bk-row-icon">🔄</span><span class="bk-row-label">检查更新</span><span class="bk-row-arrow">›</span></button>';
      }
      html += '<button class="bk-settings-row" data-action="guide"><span class="bk-row-icon">📖</span><span class="bk-row-label">使用说明</span><span class="bk-row-arrow">›</span></button>';
      html += '<button class="bk-settings-row" data-action="feedback"><span class="bk-row-icon">💬</span><span class="bk-row-label">问题反馈</span><span class="bk-row-arrow">›</span></button>';
      html += '</div>';

      // 资源管理
      html += '<div class="bk-settings-section">';
      html += '<div class="bk-settings-section-title">资源管理</div>';
      html += '<button class="bk-settings-row" data-action="download-mgr"><span class="bk-row-icon">📥</span><span class="bk-row-label">下载管理</span><span class="bk-row-arrow">›</span></button>';
      html += '</div>';

      // 高级（内联开关）
      html += '<div class="bk-settings-section">';
      html += '<div class="bk-settings-section-title">高级</div>';
      if (canUpdate) {
        html += '<div class="pref-row"><div class="pref-label-wrap"><span class="pref-title">自动检查更新</span><span class="pref-desc">启动时自动检查是否有新版本</span></div><label class="pref-toggle"><input type="checkbox" id="meAutoCheckToggle"><span class="pref-toggle-slider"></span></label></div>';
      }
      html += '<div class="pref-row"><div class="pref-label-wrap"><span class="pref-title">开发者模式</span><span class="pref-desc">在页面底部显示调试日志</span></div><label class="pref-toggle"><input type="checkbox" id="meDevToggle"><span class="pref-toggle-slider"></span></label></div>';
      html += '</div>';

      html += '</div>'; // bk-settings-right end
      html += '</div>'; // bk-settings-grid end
      html += '</div>'; // bk-settings-page end

      app.innerHTML = html;

      // 注：阅读模式 / 字号设置已收归阅读设置弹窗（#themePanel），由上方「设置」入口打开，无需在此初始化。

      // 高级开关初始化
      if (canUpdate) {
        var ac0 = document.getElementById('meAutoCheckToggle');
        if (ac0) { try { ac0.checked = localStorage.getItem('bk_auto_check_update') === '1'; } catch (e) {} }
      }
      var dt0 = document.getElementById('meDevToggle');
      if (dt0) { try { dt0.checked = localStorage.getItem('bk_dev_mode') === '1'; } catch (e) {} }

      // 绑定功能行点击
      var rows = app.querySelectorAll('.bk-settings-row');
      for (var i = 0; i < rows.length; i++) {
        (function(row) {
          row.addEventListener('click', function() {
            var action = row.getAttribute('data-action');
            if (action === 'bookmarks') {
              if (win.BKBookmark && win.BKBookmark.showList) win.BKBookmark.showList();
            } else if (action === 'clear-data') {
              if (win.BK && win.BK.clearData) win.BK.clearData();
            } else if (action === 'download-mgr') {
              if (win.BKRenderer && win.BKRenderer.openDownloadManager) win.BKRenderer.openDownloadManager();
            } else if (action === 'install-pwa') {
              var st = document.getElementById('meInstallStatus');
              function setSt(msg, cls) { if (st) { st.textContent = msg; st.className = 'cache-status' + (cls ? ' ' + cls : ''); st.style.display = ''; } }
              if (win.BK && win.BK.installPWA) { win.BK.installPWA(); return; }
              var p = win._pwaInstallPrompt;
              if (p) { win._pwaInstallPrompt = null; p.prompt(); return; }
              if (isIOS && !isStandalone) { setSt('请点击浏览器底部「分享」按钮，选择「添加到主屏幕」'); return; }
              setSt('当前环境暂不支持自动安装，请用浏览器菜单添加到主屏幕', 'error');
            } else if (action === 'android-apk') {
              var apkSt = document.getElementById('meApkStatus');
              if (apkSt) apkSt.style.display = '';
              if (win.BKDownloadApk) win.BKDownloadApk(apkSt);
            } else if (action === 'check-update') {
              if (isCapacitor) {
                if (win.AppUpdate && win.AppUpdate.showCloudflareUpdateDialog) win.AppUpdate.showCloudflareUpdateDialog();
              } else if (win.AppUpdate && win.AppUpdate.showPwaUpdateDialog) {
                win.AppUpdate.showPwaUpdateDialog();
              }
            } else if (action === 'guide') {
              if (win.showGuideDialog) win.showGuideDialog();
            } else if (action === 'feedback') {
              if (win.showFeedbackDialog) win.showFeedbackDialog();
            }
          });
        })(rows[i]);
      }

      // 设置入口：打开阅读界面的设置弹窗（阅读模式 + 字体大小）
      var entry = app.querySelector('.bk-settings-entry');
      if (entry) {
        entry.addEventListener('click', function(e) {
          e.stopPropagation();
          if (typeof window.toggleThemePanel === 'function') {
            window.toggleThemePanel();
          } else {
            console.warn('[BK] toggleThemePanel 未就绪，设置弹窗无法打开');
          }
        });
      }

      // 高级开关绑定
      if (canUpdate) {
        var ac2 = document.getElementById('meAutoCheckToggle');
        if (ac2) ac2.addEventListener('change', function() {
          try { if (this.checked) localStorage.setItem('bk_auto_check_update', '1'); else localStorage.removeItem('bk_auto_check_update'); } catch (e) {}
        });
      }
      var dt2 = document.getElementById('meDevToggle');
      if (dt2) dt2.addEventListener('change', function() {
        var on = this.checked;
        try { localStorage.setItem('bk_dev_mode', on ? '1' : '0'); } catch (e) {}
        if (on && win.BKDevConsole) win.BKDevConsole.init();
        else if (!on && win.BKDevConsole) win.BKDevConsole.destroy();
      });

      // 异步填充统计卡
      _fillSettingsStats();
    },

    // ── 书架页（新增模块） ────────────────────────────────────────

    renderShelfPage: function () {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
      _cleanupPdfCache();
      document.body.classList.remove('bk-reading-page');
      showApp();
      var app = getApp();
      document.title = '书架';
      _shelfEditing = false;
      _shelfSelected = {};

      var html = '<div class="bk-shelf-page">';
      html += '<div class="bk-city-header">';
      html += '<h1 class="bk-city-title">书架</h1>';
      html += '<button type="button" id="shelfImportBtn" class="bk-city-search-btn" aria-label="导入">📂</button>';
      html += '</div>';
      // 继续阅读模块（决策④：阅读进度归书架，首屏顶部续读）
      html += '<div class="bk-section-header">';
      html += '<span class="bk-section-title-lg">继续阅读</span>';
      html += '<span class="bk-view-all" id="bk-continue-viewall" role="button" tabindex="0">查看全部</span>';
      html += '</div>';
      html += '<div id="bkContinueListAnchor"></div>';
      // 书架分段切换（在读 / 已读；默认在读；收藏冗余已去除）
      html += '<div class="bk-shelf-tabs" id="shelfTabs" role="tablist">';
      html += '<button type="button" class="bk-shelf-tab is-active" data-tab="reading" role="tab" aria-selected="true">在读 <span class="bk-shelf-tab-count" id="shelfCountReading">0</span></button>';
      html += '<button type="button" class="bk-shelf-tab" data-tab="read" role="tab" aria-selected="false">已读 <span class="bk-shelf-tab-count" id="shelfCountRead">0</span></button>';
      html += '</div>';
      // 我的书架
      html += '<div class="bk-section-header"><span class="bk-section-title-lg">我的书架</span><button type="button" id="shelfEditBtn" class="bk-shelf-edit-btn" aria-label="编辑书架">编辑</button></div>';
      html += '<div class="bk-shelf-list" id="shelfList"></div>';
      // 编辑态底部批量操作条（默认隐藏，is-editing 时显示）
      html += '<div class="bk-shelf-editbar" id="shelfEditBar" role="toolbar" aria-label="批量操作">';
      html += '<button type="button" class="bk-shelf-edit-selectall" id="shelfSelectAll" aria-pressed="false">全选</button>';
      html += '<span class="bk-shelf-edit-count" id="shelfEditCount">已选 0 本</span>';
      html += '<button type="button" class="bk-shelf-edit-action" id="shelfEditMark">标记已读</button>';
      html += '<button type="button" class="bk-shelf-edit-action bk-shelf-edit-danger" id="shelfEditRemove">移出书架</button>';
      html += '</div>';
      html += '</div>';

      app.innerHTML = html;

      // 导入按钮：打开导入对话框（支持从文件/WebDAV）
      var importBtn = document.getElementById('shelfImportBtn');
      if (importBtn) {
        importBtn.addEventListener('click', function () {
          if (win.BKResourcePack && win.BKResourcePack.showImportDialog) {
            win.BKResourcePack.showImportDialog();
          } else if (win.BKRenderer && win.BKRenderer.pickAndImport) {
            win.BKRenderer.pickAndImport();
          }
        });
      }
      // 继续阅读「查看全部」：原地展开（首屏默认最多 6 张）
      var viewAllBtn = document.getElementById('bk-continue-viewall');
      if (viewAllBtn) {
        viewAllBtn.addEventListener('click', function () { _renderContinueList(app, { expanded: true }); });
      }

      // 分段切换（在读 / 已读）：点击仅改激活桶并重渲染列表（bk-shelf-changed 监听复用）
      var tabsEl2 = document.getElementById('shelfTabs');
      if (tabsEl2) {
        tabsEl2.addEventListener('click', function (e) {
          var tab = e.target.closest('.bk-shelf-tab');
          if (!tab) return;
          _shelfActiveTab = tab.getAttribute('data-tab') || 'reading';
          _renderShelfList();
        });
      }

      // 书架行点击进入阅读：整行（封面/标题/信息）可点开书籍；行内按钮各自处理，不触发跳转
      // 书架行交互：点封面进阅读；编辑态点卡=切换选中；长按/右键=快捷菜单
      var shelfListNav = document.getElementById('shelfList');
      if (shelfListNav) {
        // 选择圈（编辑态）：点按切换选中，不触发导航
        shelfListNav.addEventListener('click', function (e) {
          var selBtn = e.target.closest('.bk-shelf-select');
          if (selBtn) {
            var srow = selBtn.closest('.bk-shelf-row');
            if (srow) _toggleShelfSelection(srow);
            return;
          }
          if (e.target.closest('button')) return; // 其它按钮（隐藏操作区）自行处理
          if (_suppressNextClick) { _suppressNextClick = false; return; } // 长按菜单已拦截，吞掉随后 click
          var row = e.target.closest('.bk-shelf-row');
          if (!row) return;
          if (_shelfEditing) { _toggleShelfSelection(row); return; } // 编辑态：点卡=切换选中
          var id = row.getAttribute('data-book-id');
          if (id && win.BKRouter && typeof win.BKRouter.navigate === 'function') {
            win.BKRouter.navigate(id);
          }
        });
        // 键盘可达：行聚焦时 Enter / 空格 打开书籍（编辑态则切换选中）
        shelfListNav.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          if (e.target.closest('button')) return;
          var row = e.target.closest('.bk-shelf-row');
          if (!row) return;
          e.preventDefault();
          if (_shelfEditing) { _toggleShelfSelection(row); return; }
          var id = row.getAttribute('data-book-id');
          if (id && win.BKRouter && typeof win.BKRouter.navigate === 'function') {
            win.BKRouter.navigate(id);
          }
        });

        // 长按（≥450ms）弹快捷菜单；移动超 12px 视为滚动取消
        var _lpTimer = null, _lpFired = false, _lpX = 0, _lpY = 0;
        function _clearLp() { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } _lpFired = false; }
        shelfListNav.addEventListener('pointerdown', function (e) {
          if (_shelfEditing) return; // 编辑态用点按选择，不弹菜单
          var row = e.target.closest('.bk-shelf-row');
          if (!row) return;
          _lpFired = false; _lpX = e.clientX; _lpY = e.clientY;
          _lpTimer = setTimeout(function () {
            _lpFired = true;
            _openShelfQuickMenu(row);
            _suppressNextClick = true;
          }, 450);
        });
        shelfListNav.addEventListener('pointermove', function (e) {
          if (!_lpTimer) return;
          if (Math.abs(e.clientX - _lpX) > 12 || Math.abs(e.clientY - _lpY) > 12) _clearLp();
        });
        shelfListNav.addEventListener('pointerup', _clearLp);
        shelfListNav.addEventListener('pointercancel', _clearLp);
        shelfListNav.addEventListener('pointerleave', _clearLp);
        // 右键 / 长按等价可达路径（桌面 & 读屏）
        shelfListNav.addEventListener('contextmenu', function (e) {
          if (_shelfEditing) return;
          var row = e.target.closest('.bk-shelf-row');
          if (!row) return;
          e.preventDefault();
          _openShelfQuickMenu(row);
          _suppressNextClick = true;
        });
      }

      // 编辑按钮：进入 / 退出 编辑态
      var shelfEditBtn = document.getElementById('shelfEditBtn');
      if (shelfEditBtn) {
        shelfEditBtn.addEventListener('click', function () {
          if (_shelfEditing) _exitShelfEdit(); else _enterShelfEdit();
        });
      }
      // 批量操作条
      var shelfSelectAll = document.getElementById('shelfSelectAll');
      if (shelfSelectAll) {
        shelfSelectAll.addEventListener('click', function () {
          var page = document.querySelector('.bk-shelf-page');
          if (!page) return;
          var rows = page.querySelectorAll('.bk-shelf-row');
          var total = rows.length;
          var allSel = total > 0 && _shelfSelected && Object.keys(_shelfSelected).length === total;
          _shelfSelected = {};
          if (!allSel) {
            for (var i = 0; i < total; i++) _shelfSelected[rows[i].getAttribute('data-book-id')] = true;
          }
          _syncShelfEditSelection();
        });
      }
      var shelfEditMark = document.getElementById('shelfEditMark');
      if (shelfEditMark) {
        shelfEditMark.addEventListener('click', function () {
          if (!_shelfSelected) return;
          var ids = Object.keys(_shelfSelected);
          if (!ids.length) return;
          for (var i = 0; i < ids.length; i++) {
            if (_shelfActiveTab === 'read') {
              if (win.BKShelf && win.BKShelf.unmarkRead) win.BKShelf.unmarkRead(ids[i]);
            } else {
              if (win.BKShelf && win.BKShelf.markRead) win.BKShelf.markRead(ids[i]);
            }
          }
          // bk-shelf-changed 触发整体重渲染并同步选中态
        });
      }
      var shelfEditRemove = document.getElementById('shelfEditRemove');
      if (shelfEditRemove) {
        shelfEditRemove.addEventListener('click', function () {
          if (!_shelfSelected) return;
          var ids = Object.keys(_shelfSelected);
          if (!ids.length) return;
          var ok = (win.confirm) ? win.confirm('确定将选中的 ' + ids.length + ' 本书移出书架？') : true;
          if (!ok) return;
          for (var i = 0; i < ids.length; i++) {
            if (win.BKShelf && win.BKShelf.remove) win.BKShelf.remove(ids[i]);
          }
          // bk-shelf-changed 触发整体重渲染
        });
      }

      // 进入时整体读取 BKShelf 渲染（兜底一致）
      _renderShelfContinue(app);
      _renderShelfList();

      // 订阅 bk-shelf-changed 做就地刷新（仅注册一次）
      if (!_shelfPageChangedBound) {
        win.addEventListener('bk-shelf-changed', _shelfPageChangedHandler);
        _shelfPageChangedBound = true;
      }

      // 注册书城所需的全局监听（bk-shelf-changed 就地翻转 + 后台索引更新，仅一次）
      _registerCityGlobalHandlers();

      startScrollTracking('shelf');
      restoreScrollPosition('shelf');

      // 数据未就绪时确保 DataManager 初始化后再填充动态区
      if (!_zlDmReady) {
        _ensureDmInit().then(function () {
          _renderShelfContinue(app);
          _renderShelfList();
        }).catch(function () {});
      }
    },

    renderChapterList: function (bookId) {
      stopScrollTracking();
      _removeReadingShortcuts();
      _exitSplitMode();
      _cleanupPdfCache();
      document.body.classList.remove('bk-reading-page');
      showApp();
      var app = getApp();
      app.innerHTML = '<div class="bk-loading"><div class="bk-spinner"></div><div>加载中...</div></div>';

      loadBook(bookId).then(function (book) {
        var chapters = _getUniqueChapters(book.chapters || []);

        // 只有一章时直接进入阅读视图，跳过目录页
        if (chapters.length <= 1) {
          var chNum = chapters.length === 1 ? (chapters[0].number || 1) : 1;
          BKRenderer.renderReadingView(bookId, chNum);
          return;
        }
        var progress = getReadingProgress(bookId);

        var html = '<div class="bk-chapter-list-view">';

        // 顶部栏已移至浮动导航（nav-stack.js），不再渲染永久顶栏

        // 书籍信息头部
        html += '<div class="bk-book-header">';
        if (book.cover) {
          html += '<img class="bk-book-header-cover" src="' + escAttr(book.cover) + '" alt="' + escAttr(book.title) + '">';
        }
        html += '<h1 class="bk-book-header-title">' + escText(book.title) + '</h1>';
        if (book.author) html += '<div class="bk-book-header-author">' + escText(book.author) + '</div>';
        if (book.description) html += '<div class="bk-book-header-desc">' + escText(book.description) + '</div>';
        html += '<div class="bk-book-header-stats">';
        html += '<span class="bk-stat">' + chapters.length + ' 章</span>';
        if (progress > 0) html += '<span class="bk-stat">· 读到第' + progress + '章</span>';
        html += '</div>';
        html += '</div>';

        // 章节列表
        html += '<div class="bk-chapter-list">';
        for (var i = 0; i < chapters.length; i++) {
          var ch = chapters[i];
          var chNum = ch.number || (i + 1);
          var isCurrent = chNum === progress;
          var isRead = _isChapterReadByScroll(bookId, chNum);
          // 如果当前章节也已读满阈值，显示为已读
          if (isCurrent && isRead) isCurrent = false;
          var statusClass = isCurrent ? ' bk-chapter-current' : (isRead ? ' bk-chapter-read' : '');
          html += '<a class="bk-chapter-item' + statusClass + '" href="#/' + escAttr(bookId) + '/' + chNum + '">';
          html += '<span class="bk-chapter-num">' + chNum + '</span>';
          html += '<span class="bk-chapter-title">' + escText(ch.title || '第' + chNum + '章') + '</span>';
          if (isCurrent) html += '<span class="bk-chapter-badge">在读</span>';
          else if (isRead) html += '<span class="bk-chapter-status">✓</span>';
          html += '</a>';
        }
        html += '</div>';
        html += '</div>';

        app.innerHTML = html;

        var pageKey = bookId;
        startScrollTracking(pageKey);
        restoreScrollPosition(pageKey);

        // 初始化 TTS
        if (win.BKSpeech && win.BKSpeech.cancel) win.BKSpeech.cancel();
      }).catch(function (err) {
        app.innerHTML = '<div class="bk-error">' +
          '<div class="bk-error-icon">⚠️</div>' +
          '<div class="bk-error-text">加载失败: ' + escText(err.message) + '</div>' +
          '</div>';
      });
    },

    // ── 阅读视图 ────────────────────────────────────────────────────

    renderReadingView: function (bookId, chapterNum) {
      // 防止 carousel 内部导航触发重复渲染
      if (_carouselNavigating) return;

      stopScrollTracking();
      _removeReadingShortcuts();
      _removeChapterLinkHandler();
      showApp();
      var app = getApp();
      app.innerHTML = '<div class="bk-loading"><div class="bk-spinner"></div><div>加载中...</div></div>';

      loadBook(bookId).then(function (book) {
        var uniqueChapters = _getUniqueChapters(book.chapters || []);
        var chapter = null;
        var chapterIdx = -1;
        for (var i = 0; i < uniqueChapters.length; i++) {
          if (uniqueChapters[i].number === chapterNum) {
            chapter = uniqueChapters[i];
            chapterIdx = i;
            break;
          }
        }

        if (!chapter) {
          app.innerHTML = '<div class="bk-error">' +
            '<div class="bk-error-icon">⚠️</div>' +
            '<div class="bk-error-text">未找到第 ' + chapterNum + ' 章</div>' +
            '</div>';
          return;
        }

        // 保存阅读进度
        saveReadingProgress(bookId, chapterNum);

        // 缓存当前书名和章节标题（供浮动导航栏使用）
        BKRenderer._currentBookTitle = book.title || '';
        BKRenderer._currentChapterTitle = chapter.title || '';

        // 设置文档标题
        document.title = (book.title || '') + ' - ' + (chapter.title || '第' + chapterNum + '章');

        // 获取前后章节
        var prevChapter = chapterIdx > 0 ? uniqueChapters[chapterIdx - 1] : null;
        var nextChapter = chapterIdx < uniqueChapters.length - 1 ? uniqueChapters[chapterIdx + 1] : null;

        // 渲染页面结构（三页轮播 carousel）
        var html = '<div class="reading-view" id="readingView">';

        // 阅读进度条（基于滚动完成标记的实际已读章节数）
        var totalChapters = uniqueChapters.length;
        var _initReadCnt = 0;
        for (var _irp = 1; _irp <= totalChapters; _irp++) {
          if (_isChapterReadByScroll(bookId, _irp)) _initReadCnt++;
        }
        var progressPct = totalChapters > 0 ? Math.round(_initReadCnt / totalChapters * 100) : 0;
        html += '<div class="bk-reading-progress">' +
          '<div class="bk-reading-progress-bar" style="width:' + progressPct + '%"></div>' +
          '</div>';

        // 三页轮播 track：prev / curr / next
        html += '<div class="bk-carousel-track">';
        html += _renderCarouselPage(prevChapter, 'Prev');
        // 当前页用 id="chapterContent" 以便 TTS/字号/高亮等模块引用
        html += '<div class="bk-carousel-page" id="carouselPageCurr">' +
          '<div class="content" id="chapterContent">' +
          renderChapterContent(chapter, true) +
          '</div></div>';
        html += _renderCarouselPage(nextChapter, 'Next');
        html += '</div>';

        // TTS 控制栏（隐藏宿主，供 speech.js 绑定事件）
        html += buildBottomControlBar();

        html += '</div>';

        app.innerHTML = html;
        initPdfPageLazyRender(app);
        document.body.classList.add('bk-reading-page');
        _maybeEnterSplitMode(bookId);

        var pageKey = bookId + '/' + chapterNum;
        win.__bkCurrentPath = pageKey;
        try {
          localStorage.setItem('bk_last_read', bookId);
          // 记录「最近阅读」时间戳（供书架按 max(入架,阅读) 排序置顶）
          localStorage.setItem('bk_lastread_ts:' + bookId, String(Date.now()));
        } catch(e) {}
        startScrollTracking(pageKey);

        // 检查是否有书签恢复的滚动位置
        var bmScrollKey = 'bk_scroll:' + pageKey;
        var bmScrollY = 0;
        try { bmScrollY = parseInt(localStorage.getItem(bmScrollKey) || '0', 10); } catch(e) {}
        if (bmScrollY > 0) {
          requestAnimationFrame(function() {
            requestAnimationFrame(function() {
              var c = _getScrollContainer();
              if (c === win) win.scrollTo(0, bmScrollY);
              else c.scrollTop = bmScrollY;
              // 恢复滚动位置后用重试检查，确保 DOM 渲染完成后再判定
              _retryCheckScrollCompletion(0);
            });
          });
        } else {
          // 无滚动位置恢复时也需检查（短章节可能无需滚动即完成）
          // 使用 rAF + 重试确保 DOM 渲染完成后再判定
          _retryCheckScrollCompletion(0);
        }

        // 初始化 TTS
        if (win.BKSpeech) {
          if (win.BKSpeech.cancel) win.BKSpeech.cancel();
          if (win.BKSpeech.init) {
            win.BKSpeech.init({
              getElements: function() {
                var container = document.getElementById('chapterContent');
                if (!container) return [];
                var els = [];
                var paragraphs = container.querySelectorAll('.bk-paragraph, .bk-quote-content, .bk-heading, .bk-code, li');
                for (var pi = 0; pi < paragraphs.length; pi++) {
                  els.push({ el: paragraphs[pi] });
                }
                return els;
              }
            });
          }
        }

        // 恢复划线
        if (win.BKHighlight && win.BKHighlight.rendoHighlights) {
          win.BKHighlight.rendoHighlights();
        }

        // 初始化经文弹窗
        if (win.BKScripturePopup && win.BKScripturePopup.init) {
          win.BKScripturePopup.init();
        }

        // Markdown 增强后处理（代码高亮、Mermaid、Lightbox）
        _applyMdEnhancements(document.getElementById('chapterContent'));
        _applyMdEnhancements(document.getElementById('carouselContentPrev'));
        _applyMdEnhancements(document.getElementById('carouselContentNext'));

        // 安装键盘快捷键 + 三页轮播滑动手势
        _installReadingShortcuts(bookId, uniqueChapters, chapterNum);
        _installCarouselSwipe(bookId, uniqueChapters, chapterNum);
        _installChapterLinkHandler(bookId);
      }).catch(function (err) {
        app.innerHTML = '<div class="bk-error">' +
          '<div class="bk-error-icon">⚠️</div>' +
          '<div class="bk-error-text">加载失败: ' + escText(err.message) + '</div>' +
          '</div>';
      });
    },

    // ── 管理模式切换（从设置面板调用）──────────────────────────

    toggleManageMode: function () {
      _manageMode = !_manageMode;

      // 进入/退出管理模式：重渲染当前可见视图，使卡片按 _manageMode 重建（删除按钮随之显隐）
      _rerenderCurrentView();

      // 关闭设置面板
      if (typeof window.closeThemePanel === 'function') {
        window.closeThemePanel();
      }
    },

    // ── 打开下载管理面板（从设置面板调用）───────────────────────

    openDownloadManager: function () {
      // 关闭设置面板
      if (typeof window.closeThemePanel === 'function') {
        window.closeThemePanel();
      }
      // 等待数据就绪后打开对话框
      var open = function () {
        _openDownloadDialog();
      };
      if (_zlDmReady) open();
      else if (typeof _ensureDmInit === 'function') _ensureDmInit().then(open).catch(open);
    },

    // ── 查询管理模式状态 ──────────────────────────────────────

    isManageMode: function () {
      return _manageMode;
    },

    // ── 导入外部书籍（从设置面板调用）─────────────────────────

    pickAndImport: function () {
      if (!win.ImportManager || !win.ImportManager.pickAndImport) return;
      // 关闭设置面板
      if (typeof window.closeThemePanel === 'function') {
        window.closeThemePanel();
      }
      win.ImportManager.pickAndImport().then(function(bookData) {
        if (!bookData) return;
        bookData.series = 'imported';
        var dupBook = false;
        for (var di = 0; di < _zlBooks.length; di++) {
          if (_zlBooks[di].id === bookData.id) { dupBook = true; break; }
        }
        if (!dupBook) _zlBooks.push(bookData);
        if (_zlDownloadedIds.indexOf(bookData.id) === -1) _zlDownloadedIds.push(bookData.id);
        if (!win.__bkBooks) win.__bkBooks = [];
        win.__bkBooks.push(bookData);
        if (win.BKRouter) win.BKRouter.navigate(bookData.id);
      }).catch(function(err) {
        if (err && err.message) console.error('[导入]', err.message);
      });
    },

    // ── 书城三级下钻内部回退（供 nav-stack 原生返回键调用）─────────────
    // 主轴翻转后：L3 多分类 → 回 L2 分类列表；L3 单分类隐式 / L2 分类列表 → 回 L1 系列网格。
    // 返回 true 表示已处理逐级回退，false 表示已在书城一级 / 书架（交给路由 / 浏览器后退）
    goBackInHome: function () {
      if (_cityLevel() === 3 && !_cityImplicit) {
        _cityBackToCategories(); // 多分类书籍 → 分类列表（L2）
        return true;
      }
      if (_cityLevel() >= 2) {
        _cityBackToSeries();      // 单分类隐式书籍 / 分类列表 → 系列网格（L1）
        return true;
      }
      return false;
    },

    // ── 工具方法（供 nav-stack.js 等外部模块调用）─────────────────────

    _getBookTitle: function (bookId) {
      if (_zlBooks) {
        for (var i = 0; i < _zlBooks.length; i++) {
          if (_zlBooks[i].id === bookId) return _zlBooks[i].title || '';
        }
      }
      return '';
    }
  };

  // ── 暴露 ──────────────────────────────────────────────────────────────

  win.BKRenderer = BKRenderer;

  // 暴露版式封面生成器（供 search.js 搜索结果复用）
  win.BKRenderer._coverHTML = _coverHTML;
  win.BKRenderer._cleanBookTitle = _cleanBookTitle;

  // 测试钩子（仅供单元测试直接调用，不影响运行时行为）：重同步事件分支与查书工具
  win.BKRenderer.__test = {
    doResync: _doResync,
    onResyncClick: _onResyncClick,
    findBookById: _findBookById,
    renderContentItem: renderContentItem
  };

  // 初始化目录 Drawer 全局事件（页面加载时一次）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      _initTocDrawerEvents();
      _bindResyncHandler();
    });
  } else {
    _initTocDrawerEvents();
    _bindResyncHandler();
  }

