'use strict';

  // ── 渲染器对象 ──────────────────────────────────────────────────────

  // 公共退出阅读视图：清理资源 + 移除阅读页标记 + 同步进度条清零
  // （5 处退出路径统一调用，避免未来新增路径漏掉进度条清零）
  function _exitReadingView() {
    stopScrollTracking();
    _removeReadingShortcuts();
    _exitSplitMode();
    _cleanupPdfCache();
    document.body.classList.remove('bk-reading-page');
    try { _updateTopReadingProgress(); } catch(e) {}
  }

  // 通知加载页：首屏页面渲染完成，可以消失闪屏了
  // （Splash 等 _bkDataReady + bk-page-rendered 双条件满足后才消失，避免闪白）
  var _firstRenderFired = false;
  function _firePageRendered() {
    if (_firstRenderFired) return;
    _firstRenderFired = true;
    try { document.dispatchEvent(new CustomEvent('bk-page-rendered')); } catch (e) {}
  }

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
      _exitReadingView();
      showHome();
      var homeView = document.getElementById('homeView');
      if (!homeView) return;
      document.title = '书城';
      if (!_zlDmReady) {
        _ensureDmInit().then(function () {
          _renderCityHome(homeView);
          _bindCityEvents(homeView);
          _registerCityGlobalHandlers();
          _firePageRendered();
        }).catch(function () { _firePageRendered(); });
      } else {
        _renderCityHome(homeView);
        _bindCityEvents(homeView);
        _registerCityGlobalHandlers();
        _firePageRendered();
      }
    },

    /**
     * 系列书籍列表页（独立深链 #/series/<id> 或 #/series/<id>/<prefix>）
     * 主轴翻转后：books（跨分类系列）→ 进二级分类列表；其余单分类系列 → 直接进三级书籍列表（implicit）。
     * 若指定 categoryPrefix，则直接进入该分类下的书籍列表（搜索分类入口深链）。
     * 复用书城三级下钻的渲染与无限滚动基建。
     */
    renderSeriesPage: function (seriesId, categoryPrefix) {
      _exitReadingView();
      showHome();
      var homeView = document.getElementById('homeView');
      if (!homeView) return;
      document.title = '书城';

      function render() {
        // ★ 若指定了 categoryPrefix，直接进三级书籍列表
        if (categoryPrefix) {
          var cats = _getSeriesCategories(seriesId);
          var targetCat = null;
          for (var ci = 0; ci < cats.length; ci++) {
            if (cats[ci].prefix === categoryPrefix) { targetCat = cats[ci]; break; }
          }
          if (targetCat) {
            _renderCityBookList(homeView, seriesId, targetCat.name, targetCat.prefix, false);
          } else {
            // prefix 未匹配到分类，降级到分类列表
            _renderCityCategoryList(homeView, seriesId);
          }
        } else if (seriesId === 'books') {
          // 跨分类系列 → 进二级分类列表
          _renderCityCategoryList(homeView, seriesId);
        } else {
          var cats2 = _getSeriesCategories(seriesId);
          if (cats2.length === 1) {
            // 单分类系列 → 隐式跳过二级，直接进三级书籍列表
            _renderCityBookList(homeView, seriesId, cats2[0].name, cats2[0].prefix, true);
          } else {
            // 多分类（理论上非 books 系列均为单分类，此处为兜底）
            _renderCityCategoryList(homeView, seriesId);
          }
        }
        _bindCityEvents(homeView);
        _registerCityGlobalHandlers();
      }

      if (!_zlDmReady) {
        _ensureDmInit().then(function () { render(); _firePageRendered(); }).catch(function () {
          _renderCityHome(homeView);
          _bindCityEvents(homeView);
          _registerCityGlobalHandlers();
          _firePageRendered();
        });
      } else {
        render();
        _firePageRendered();
      }
    },

    // 无限滚动加载更多（测试可调用；内部已含 IntersectionObserver 守卫）
    cityLoadMore: function () {
      _cityLoadMore();
    },

    // ── 目录页：章节列表 ────────────────────────────────────────────

    // ── 我的（个人中心，手机/平板） ─────────────────────────────

    renderMyPage: function () {
      _exitReadingView();
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
      html += '<button class="bk-settings-row" data-action="sponsor" id="bkSponsorBtn" style="display:none"><span class="bk-row-icon">❤️</span><span class="bk-row-label">顾念微工</span><span class="bk-row-arrow">›</span></button>';
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
            if (action === 'clear-data') {
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
              // ★ 手动检查更新——临时允许网络请求
              var _doCheck = function() {
                if (isCapacitor) {
                  if (win.AppUpdate && win.AppUpdate.showCloudflareUpdateDialog) win.AppUpdate.showCloudflareUpdateDialog();
                } else if (win.AppUpdate && win.AppUpdate.showPwaUpdateDialog) {
                  win.AppUpdate.showPwaUpdateDialog();
                }
              };
              if (win.BK && win.BK.withNetworkAllowed) {
                win.BK.withNetworkAllowed(function() {
                  _doCheck();
                  return Promise.resolve();
                });
              } else {
                _doCheck();
              }
            } else if (action === 'guide') {
              if (win.showGuideDialog) win.showGuideDialog();
            } else if (action === 'feedback') {
              if (win.showFeedbackDialog) win.showFeedbackDialog();
            } else if (action === 'sponsor') {
              if (win.showSponsorDialog) win.showSponsorDialog();
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

      // 赞助按钮：如果探测已完成且就绪，直接显示
      if (window._bkSponsorReady === true) {
        var spBtn = document.getElementById('bkSponsorBtn');
        if (spBtn) spBtn.style.display = '';
      }

      // 异步填充统计卡
      _fillSettingsStats();
      _firePageRendered();
    },

    // ── 书架页（新增模块） ────────────────────────────────────────

    renderShelfPage: function () {
      _exitReadingView();
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
      // 筛选栏 + 编辑按钮
      html += '<div class="bk-shelf-filter-bar">';
      html += '<button type="button" class="bk-shelf-filter-btn" id="shelfFilterBtn" aria-haspopup="true" aria-expanded="false">';
      html += '<span class="bk-shelf-filter-label" id="shelfFilterLabel">全部</span>';
      html += '<svg class="bk-shelf-filter-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
      html += '</button>';
      html += '<span class="bk-shelf-filter-count" id="shelfFilterCount">0 本</span>';
      html += '<button type="button" id="shelfEditBtn" class="bk-shelf-edit-btn" aria-label="编辑书架">编辑</button>';
      html += '</div>';
      html += '<div class="bk-shelf-list bk-poster-grid" id="shelfList"></div>';
      // 编辑态底部批量操作条（默认隐藏，is-editing 时显示）
      html += '<div class="bk-shelf-editbar" id="shelfEditBar" role="toolbar" aria-label="批量操作">';
      html += '<button type="button" class="bk-shelf-edit-selectall" id="shelfSelectAll" aria-pressed="false">全选</button>';
      html += '<span class="bk-shelf-edit-count" id="shelfEditCount">已选 0 本</span>';
      html += '<button type="button" class="bk-shelf-edit-action" id="shelfEditMark">标记已读</button>';
      html += '<button type="button" class="bk-shelf-edit-action" id="shelfEditExport">导出</button>';
      html += '<button type="button" class="bk-shelf-edit-action" id="shelfEditWebdavUpload">上传</button>';
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
      // 筛选按钮：点击展开下拉菜单
      var filterBtn = document.getElementById('shelfFilterBtn');
      if (filterBtn) {
        filterBtn.addEventListener('click', function () {
          _toggleShelfFilterMenu();
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
            // 与书城 _handleBookClick 一致：有阅读进度则直接跳到上次阅读位置，否则进目录页
            var _p = getReadingProgress(id);
            win.BKRouter.navigate(_p > 0 ? id + '/' + _p : id);
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
            var _p2 = getReadingProgress(id);
            win.BKRouter.navigate(_p2 > 0 ? id + '/' + _p2 : id);
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
            if (_shelfFilter === 'read') {
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
          // 检测选中书中是否含导入书（imported- 前缀），差异化提示文案
          var hasImported = false;
          for (var i = 0; i < ids.length; i++) {
            if (ids[i].indexOf('imported-') === 0) { hasImported = true; break; }
          }
          var msg;
          if (hasImported) {
            // 混合或全为导入书：需说明导入书清数据、书城书保留缓存
            msg = '确定将选中的 ' + ids.length + ' 本书移出书架？\n\n其中导入书将清除本地数据（缓存、阅读进度、PDF/EPUB 文件等，无法恢复）；书城下载书的本地缓存将予以保留，可随时重新加入。';
          } else {
            // 全为书城下载书：仅移出书架，保留缓存
            msg = '确定将选中的 ' + ids.length + ' 本书移出书架？\n\n本地缓存将予以保留，可随时重新加入书架继续阅读。';
          }
          var ok = (win.confirm) ? win.confirm(msg) : true;
          if (!ok) return;
          for (var j = 0; j < ids.length; j++) {
            if (win.BKShelf && win.BKShelf.purgeBook) {
              win.BKShelf.purgeBook(ids[j]);   // 移出书架 + 按书型差异化清理本地数据
            } else if (win.BKShelf && win.BKShelf.remove) {
              win.BKShelf.remove(ids[j]);       // 降级：仅移出书架记录
            }
          }
          // bk-shelf-changed 触发整体重渲染
        });
      }
      // 批量导出按钮
      var shelfEditExport = document.getElementById('shelfEditExport');
      if (shelfEditExport) {
        shelfEditExport.addEventListener('click', function () {
          if (!_shelfSelected) return;
          var ids = Object.keys(_shelfSelected);
          if (!ids.length) return;
          _doBatchExport(ids);
        });
      }

      // 批量上传到 WebDAV
      var shelfEditWebdav = document.getElementById('shelfEditWebdavUpload');
      if (shelfEditWebdav) {
        shelfEditWebdav.addEventListener('click', function () {
          if (!_shelfSelected) return;
          var ids = Object.keys(_shelfSelected);
          if (!ids.length) return;
          if (win.BK && win.BK.WebDavUpload && win.BK.WebDavUpload.showUploadDialog) {
            win.BK.WebDavUpload.showUploadDialog(ids);
          } else {
            _toast('WebDAV 上传功能未就绪');
          }
        });
      }

      // 进入时先用已有数据同步渲染（避免空白闪烁），再合并导入书籍后更新
      _renderShelfList();
      _mergeImportedBooks().then(function () {
        _renderShelfList();
      }).catch(function () {});

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
          _renderShelfList();
        }).catch(function () {});
      }
      _firePageRendered();
    },

    renderChapterList: function (bookId) {
      // ★ 独立目录页已移除：阅读页左滑抽屉即目录，无需章节列表页。
      //   本函数作为「1 段路由（#/{bookId}）」的中转，统一把用户直接带入阅读视图。
      //   返回键从阅读视图直接回书架（见 nav-back.js 与 renderReadingView 的标记）。
      _exitReadingView();
      showApp();
      var app = getApp();
      app.innerHTML = '<div class="bk-loading"><div class="bk-spinner"></div><div>加载中...</div></div>';

      loadBook(bookId).then(function (book) {
        var chapters = _getUniqueChapters(book.chapters || []);

        // 有阅读进度则恢复到上次章节，否则从第 1 章开始
        var progress = getReadingProgress(bookId);
        var chNum = progress > 0 ? progress : (chapters.length === 1 ? (chapters[0].number || 1) : 1);

        // 校验章节号有效，避免非法进度导致找不到章
        var valid = false;
        for (var _vi = 0; _vi < chapters.length; _vi++) {
          if (chapters[_vi].number === chNum) { valid = true; break; }
        }
        if (!valid) chNum = chapters.length ? (chapters[0].number || 1) : 1;

        // ★ 同步设置标记（renderReadingView 的 loadBook 回调会再次确认）：
        //   __bkIsSingleChapter 仅用于区分单章书；__bkSkipChapterList 恒为 true，
        //   保证返回键从阅读视图直接回书架（不再回到已移除的目录页）。
        win.__bkIsSingleChapter = (chapters.length <= 1);
        win.__bkSkipChapterList = true;

        // ★ 用 navigateReplace 更新 URL 为 2 段（#/{bookId}/{chNum}），
        //   使 URL hash 与 renderReadingView 设置的 __bkCurrentPath 一致，
        //   避免系统返回键"阅读视图→目录页→(自动跳回)阅读视图"的循环。
        if (win.BKRouter) {
          win.BKRouter.navigateReplace(bookId + '/' + chNum);
        } else {
          BKRenderer.renderReadingView(bookId, chNum);
        }
      }).catch(function (err) {
        app.innerHTML = '<div class="bk-error">' +
          '<div class="bk-error-icon">⚠️</div>' +
          '<div class="bk-error-text">加载失败: ' + escText(err.message) + '</div>' +
          '</div>';
        _firePageRendered();
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
        // 修复：只初始化当前章节的 PDF，避免 observer 观察 carousel 相邻页面的 PDF 元素
        // （传 #app 会导致 IntersectionObserver 误检测相邻 carousel-page 内的 .bk-pdf-page）
        var chapterContent = app.querySelector('#chapterContent');
        initPdfPageLazyRender(chapterContent || app);
        document.body.classList.add('bk-reading-page');
        _maybeEnterSplitMode(bookId);

        var pageKey = bookId + '/' + chapterNum;
        win.__bkCurrentPath = pageKey;
        // ★ 单章书标记：供系统返回键跳过目录页直达书架
        //   （单章书目录页会被 renderChapterList 自动跳进阅读视图，返回键回目录页=循环）
        win.__bkIsSingleChapter = (uniqueChapters.length <= 1);
        // ★ 独立目录页已移除：__bkSkipChapterList 恒为 true，
        //   保证返回键从阅读视图直接回书架（不再回到已移除的目录页）。
        win.__bkSkipChapterList = true;
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
              // 恢复滚动后同步顶部进度条
              try { _updateTopReadingProgress(); } catch(e) {}
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
        // carousel 初始化完成后，同步顶部进度条到当前章节段位
        // （_carouselChapterNum/_carouselUniqueChapters 在 _installCarouselSwipe 内才赋值，
        //   早于此刻调用会因变量为 null 被清零；bmScrollY>0 的恢复滚动同步由 rAF 内调用处理）
        try { _updateTopReadingProgress(); } catch(e) {}
        _firePageRendered();
      }).catch(function (err) {
        app.innerHTML = '<div class="bk-error">' +
          '<div class="bk-error-icon">⚠️</div>' +
          '<div class="bk-error-text">加载失败: ' + escText(err.message) + '</div>' +
          '</div>';
        _firePageRendered();
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
    },

    // ── 下载导航协作（书城 + 搜索框共享同一协调机制）─────────────────────
    // 多个入口（书城卡片点击 / 搜索结果点击）都可能启动下载并要求「下载完成后自动跳转」。
    // 通过此协调机制确保并发下载时只有「最后点击的书」才自动跳转，
    // 避免先完成者劫持导航：用户点 A 又点 B，A 先完成时不应抢跳到 A。
    // 详见 _handleBookClick（renderer-city-helpers.js）与 search.js 两处 downloadBook 调用。
    claimDownloadNavigate: function (bookId) {
      _lastClickDownloadId = bookId;
    },

    isClaimedDownloadNavigate: function (bookId) {
      return bookId === _lastClickDownloadId;
    },

    // ★ M3修复：暴露阅读进度查询 API，让 search.js 等外部模块不再直读 localStorage key
    //   （'bk_progress:' 前缀是 renderer 内部约定，不应耦合到其他模块）。
    //   返回 0 表示无进度；> 0 为上次阅读的章节号。
    getReadingProgress: function (bookId) {
      return getReadingProgress(bookId);
    },

    // ★ 暴露滚动位置保存方法（供 AppLifecycle 切后台时调用）
    stopScrollTracking: function () {
      stopScrollTracking();
    },

    saveScrollPosition: function () {
      saveScrollPosition();
    }
  };

  // ── 暴露 ──────────────────────────────────────────────────────────────

  win.BKRenderer = BKRenderer;

  // 暴露版式封面生成器（供 search.js 搜索结果复用）
  win.BKRenderer._coverHTML = _coverHTML;
  // 暴露系列取色器（供 search.js 入口卡片复用）
  win.BKRenderer._getSeriesColor = _getSeriesColor;

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

