/**
 * webdav-file-manager.js — WebDAV 远程文件管理器
 *
 * 功能：
 *   1. 浏览远程目录（文件 + 子目录）
 *   2. 多选文件/目录，批量删除
 *   3. 预置服务器强制密码校验
 *   4. 文件大小显示、类型图标
 *   5. 删除确认弹窗（二次确认）
 *   6. 删除进度反馈
 *
 * 依赖：
 *   - WebDavManager (webdav-manager.js) — 连接/列目录/删除
 *   - BK.openDialog (back-stack.js) — 弹窗系统
 *
 * 挂载：window.BK.WebDavFileManager
 *   .open()         打开文件管理器
 */
(function (win) {
  'use strict';

  // ── 工具函数 ──────────────────────────────────────────────────────────
  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escAttr(s) { return escHtml(s); }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '—';
    if (typeof win.formatSize === 'function') return win.formatSize(bytes);
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0, size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return size.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  function formatTime(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
        ('0' + d.getDate()).slice(-2) + ' ' + ('0' + d.getHours()).slice(-2) + ':' +
        ('0' + d.getMinutes()).slice(-2);
    } catch (e) { return ''; }
  }

  // 文件类型图标
  function fileIcon(entry) {
    if (entry.isDir) return '\ud83d\udcc1'; // 📁
    var name = (entry.name || '').toLowerCase();
    if (name.endsWith('.pdf')) return '\ud83d\udcc4'; // 📄
    if (name.endsWith('.epub')) return '\ud83d\udcda'; // 📚
    if (name.endsWith('.md') || name.endsWith('.markdown')) return '\ud83d\udcc3'; // 📃
    if (name.endsWith('.txt')) return '\ud83d\udcdd'; // 📝
    return '\ud83d\udcc4';
  }

  // 路径转换：完整 URL → 相对路径
  function _toRelativePath(remoteUrl, baseUrl) {
    if (!remoteUrl || !baseUrl) return '';
    try {
      var baseParsed = new URL(baseUrl.replace(/\/+$/, '') + '/');
      var remoteParsed = new URL(remoteUrl);
      var baseSegs = decodeURIComponent(baseParsed.pathname.replace(/\/+$/, '')).split('/').filter(Boolean);
      var remoteSegs = decodeURIComponent(remoteParsed.pathname.replace(/\/+$/, '')).split('/').filter(Boolean);
      if (remoteSegs.length <= baseSegs.length) return '';
      for (var i = 0; i < baseSegs.length; i++) {
        if (baseSegs[i] !== remoteSegs[i]) return '';
      }
      var relSegs = remoteSegs.slice(baseSegs.length);
      return relSegs.length ? '/' + relSegs.join('/') : '';
    } catch (e) { /* ignore */ }
    return '';
  }

  // ── toast ─────────────────────────────────────────────────────────────
  var _toastTimer = null;
  function _toast(msg) {
    if (!msg) return;
    try {
      if (!document.getElementById('bk-wdfm-toast-style')) {
        var st = document.createElement('style');
        st.id = 'bk-wdfm-toast-style';
        st.textContent =
          '.bk-wdfm-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%) translateY(12px);' +
          'background:rgba(26,25,24,.92);color:#fff;padding:10px 18px;border-radius:22px;' +
          'font-size:14px;z-index:99999;opacity:0;transition:opacity .2s,transform .2s;' +
          'pointer-events:none;max-width:80vw;white-space:nowrap}' +
          '.bk-wdfm-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}';
        document.head.appendChild(st);
      }
      var el = document.createElement('div');
      el.className = 'bk-wdfm-toast';
      el.textContent = String(msg);
      document.body.appendChild(el);
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { el.classList.add('show'); });
      } else {
        el.classList.add('show');
      }
      if (_toastTimer) clearTimeout(_toastTimer);
      _toastTimer = setTimeout(function () {
        el.classList.remove('show');
        setTimeout(function () {
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 250);
      }, 2400);
    } catch (e) { /* ignore */ }
  }

  // ── 状态 ──────────────────────────────────────────────────────────────
  var _state = {
    connectedConfig: null,
    currentPath: '',
    entries: [],
    selected: {},    // { remotePath: true }
    loading: false,
    deleting: false
  };

  // ── 主入口 ────────────────────────────────────────────────────────────
  function open() {
    if (!win.WebDavManager) {
      _toast('WebDAV 功能未就绪');
      return;
    }
    if (!win.BK || !win.BK.openDialog) {
      _toast('弹窗系统未就绪');
      return;
    }
    _renderConnectDialog();
  }

  // ── 连接对话框 ──────────────────────────────────────────────────────
  function _renderConnectDialog() {
    // 清理残留的旧弹窗（close() 有 220ms 动画延迟，可能在 DOM 中残留）
    var oldEl = document.getElementById('bk-webdav-fm-connect');
    if (oldEl && oldEl.parentNode) oldEl.parentNode.removeChild(oldEl);
    var oldFmEl = document.getElementById('bk-webdav-fm-main');
    if (oldFmEl && oldFmEl.parentNode) oldFmEl.parentNode.removeChild(oldFmEl);

    var configs = win.WebDavManager.getAllConfigs ? win.WebDavManager.getAllConfigs() : [];
    var configOptions = '<option value="">— 手动输入 —</option>';
    for (var i = 0; i < configs.length; i++) {
      var cfg = configs[i];
      var optLabel = cfg.name || cfg.url;
      if (cfg.preset) optLabel = '\u2605 ' + optLabel;
      configOptions += '<option value="' + escAttr(cfg.id) + '">' + escHtml(optLabel) + '</option>';
    }

    var html =
      '<div class="bk-dialog" style="width:min(400px,calc(100vw - 40px))">' +
        '<div class="bk-drawer-header">' +
          '<div class="bk-drawer-title">WebDAV 远程文件管理</div>' +
          '<button class="bk-drawer-close" data-action="wdfm-close" aria-label="关闭">\u00d7</button>' +
        '</div>' +
        '<div class="bk-drawer-divider"></div>' +
        '<div class="bk-wdfm-body">' +
          '<div class="bk-wdfm-section">' +
            '<div class="bk-wdfm-label">目标服务器</div>' +
            '<select class="bk-field bk-wdfm-select" id="wdfmServerSelect">' + configOptions + '</select>' +
          '</div>' +
          '<div id="wdfmCredFields">' +
            '<input class="bk-field" id="wdfmUrl" placeholder="WebDAV 地址" />' +
            '<input class="bk-field" id="wdfmUser" placeholder="用户名" />' +
            '<input class="bk-field" id="wdfmPass" type="password" placeholder="密码" />' +
          '</div>' +
          '<div class="bk-wdfm-note" id="wdfmNote" style="display:none"></div>' +
          '<div class="bk-wdfm-error" id="wdfmError" style="display:none"></div>' +
        '</div>' +
        '<div class="bk-wdfm-footer">' +
          '<button class="bk-btn bk-btn-secondary" data-action="wdfm-close">取消</button>' +
          '<button class="bk-btn bk-btn-primary" id="wdfmConnectBtn" data-action="wdfm-connect">连接</button>' +
        '</div>' +
      '</div>';

    var dlg = win.BK.openDialog({ id: 'bk-webdav-fm-connect', html: html });
    if (!dlg) return;

    var dialogEl = document.getElementById('bk-webdav-fm-connect');
    if (!dialogEl) return;

    var selectedConfig = null;
    var credFields = dialogEl.querySelector('#wdfmCredFields');
    var urlInput = dialogEl.querySelector('#wdfmUrl');
    var userInput = dialogEl.querySelector('#wdfmUser');
    var passInput = dialogEl.querySelector('#wdfmPass');
    var noteEl = dialogEl.querySelector('#wdfmNote');

    // 同步预置服务器输入框显示状态（用 CSS class 代替 inline style，避免被覆盖）
    function _syncPresetFields(cfg) {
      if (!cfg) {
        if (credFields) credFields.style.display = 'block';
        if (urlInput) { urlInput.value = ''; urlInput.classList.remove('bk-field-hidden'); }
        if (userInput) { userInput.value = ''; userInput.classList.remove('bk-field-hidden'); }
        if (passInput) { passInput.value = ''; passInput.classList.remove('bk-field-hidden'); passInput.placeholder = '密码'; }
        if (noteEl) noteEl.style.display = 'none';
        return;
      }
      if (credFields) credFields.style.display = 'block';
      if (urlInput) { urlInput.value = cfg.url || ''; if (cfg.preset) urlInput.classList.add('bk-field-hidden'); else urlInput.classList.remove('bk-field-hidden'); }
      if (userInput) { userInput.value = cfg.username || ''; if (cfg.preset) userInput.classList.add('bk-field-hidden'); else userInput.classList.remove('bk-field-hidden'); }
      if (cfg.preset) {
        // 预置服务器：查找本地已保存的密码自动填充
        var savedPwd = _getSavedPassword(cfg.id);
        if (passInput) { passInput.value = savedPwd || ''; passInput.placeholder = '请输入密码'; passInput.classList.remove('bk-field-hidden'); }
      } else {
        if (passInput) { passInput.value = cfg.password || ''; passInput.placeholder = '密码'; passInput.classList.remove('bk-field-hidden'); }
      }
      if (noteEl) {
        if (cfg.note) { noteEl.textContent = '\u5907\u6ce8\uff1a' + cfg.note; noteEl.style.display = 'block'; }
        else { noteEl.style.display = 'none'; }
      }
    }

    // 从本地已保存配置中查找密码（预置服务器用）
    function _getSavedPassword(configId) {
      if (!configId) return '';
      var saved = win.WebDavManager.getConfigs();
      for (var i = 0; i < saved.length; i++) {
        if (saved[i].id === configId && saved[i].password) return saved[i].password;
      }
      return '';
    }

    // 服务器选择
    var serverSelect = dialogEl.querySelector('#wdfmServerSelect');
    if (serverSelect) {
      serverSelect.addEventListener('change', function () {
        var id = this.value;
        var errorEl2 = dialogEl.querySelector('#wdfmError');
        if (errorEl2) errorEl2.style.display = 'none';

        if (!id) {
          selectedConfig = null;
          _syncPresetFields(null);
          return;
        }

        var configs2 = win.WebDavManager.getAllConfigs ? win.WebDavManager.getAllConfigs() : [];
        var cfg = null;
        for (var i = 0; i < configs2.length; i++) {
          if (configs2[i].id === id) { cfg = configs2[i]; break; }
        }
        if (!cfg) return;
        selectedConfig = cfg;
        _syncPresetFields(cfg);
      });

      // 默认选中激活的配置
      var activeConfig = win.WebDavManager.getActiveConfig ? win.WebDavManager.getActiveConfig() : null;
      if (activeConfig) {
        serverSelect.value = activeConfig.id;
        serverSelect.dispatchEvent(new Event('change'));
        // 兜底：用 CSS class 确保预置服务器字段隐藏
        // （dispatchEvent 在某些环境下可能不触发闭包内的 DOM 修改）
        if (activeConfig.preset) {
          if (urlInput) urlInput.classList.add('bk-field-hidden');
          if (userInput) userInput.classList.add('bk-field-hidden');
          if (passInput) {
            var savedPwd = _getSavedPassword(activeConfig.id);
            passInput.value = savedPwd || '';
            passInput.classList.remove('bk-field-hidden');
            passInput.placeholder = '请输入密码';
          }
        }
      }
    }

    // 连接按钮
    var connectBtn = dialogEl.querySelector('#wdfmConnectBtn');
    if (connectBtn) {
      connectBtn.addEventListener('click', function () {
        var urlInput = dialogEl.querySelector('#wdfmUrl');
        var userInput = dialogEl.querySelector('#wdfmUser');
        var passInput = dialogEl.querySelector('#wdfmPass');
        var errorEl = dialogEl.querySelector('#wdfmError');

        var url = urlInput ? urlInput.value.trim() : '';
        var username = userInput ? userInput.value.trim() : '';
        var password = passInput ? passInput.value : '';

        if (!url) {
          if (errorEl) { errorEl.textContent = '请填写 WebDAV 地址'; errorEl.style.display = 'block'; }
          return;
        }
        if (selectedConfig && selectedConfig.preset && !password) {
          if (errorEl) { errorEl.textContent = '预置服务器需要输入密码'; errorEl.style.display = 'block'; }
          return;
        }

        var tempConfig = {
          url: url,
          username: username,
          password: password,
          authType: (selectedConfig && selectedConfig.authType) || 'basic',
          urls: (selectedConfig && selectedConfig.urls) || null
        };
        if (selectedConfig) {
          tempConfig.id = selectedConfig.id;
          tempConfig.name = selectedConfig.name;
        }

        connectBtn.disabled = true;
        connectBtn.textContent = '连接中\u2026';
        if (errorEl) errorEl.style.display = 'none';

        win.WebDavManager.connect(tempConfig, { save: false }).then(function (res) {
          _state.connectedConfig = res.config;
          _state.currentPath = '';
          _state.entries = res.entries || [];
          _state.selected = {};
          // 连接成功后自动保存账密到本地（下次不用重复填写）
          var saveCfg = Object.assign({}, res.config);
          if (selectedConfig && selectedConfig.preset) {
            saveCfg.id = selectedConfig.id;
            saveCfg.preset = true;
          }
          win.WebDavManager.saveConfig(saveCfg);
          // 复用连接对话框的 mask，就地替换内容为文件管理器
          // 避免 close() + openDialog() 的 history 时序竞争
          _replaceWithFileManager(dialogEl, dlg);
        }).catch(function (err) {
          if (errorEl) { errorEl.textContent = (err && err.hint) || (err && err.message) || '连接失败'; errorEl.style.display = 'block'; }
        }).then(function () {
          connectBtn.disabled = false;
          connectBtn.textContent = '连接';
        });
      });
    }

    // 关闭按钮
    var closeBtns = dialogEl.querySelectorAll('[data-action="wdfm-close"]');
    for (var i = 0; i < closeBtns.length; i++) {
      closeBtns[i].addEventListener('click', function () {
        if (dlg && dlg.close) dlg.close();
      });
    }
  }

  // ── 复用连接弹窗 mask，替换内容为文件管理器 ────────────────────────────────────
  // 核心思路：连接成功后不 close() + openDialog()，而是直接替换 mask 的 innerHTML
  // 这样不涉及 BKBackStack 的 push/discard 和 history 操作，彻底消除时序竞争
  function _replaceWithFileManager(connectDialogEl, connectDlg) {
    if (!connectDialogEl) return;

    var config = _state.connectedConfig;
    if (!config) return;

    var pathDisplay = _state.currentPath || '根目录';
    var entries = _state.entries;
    var selCount = Object.keys(_state.selected).length;

    // 生成文件列表 HTML
    var listHtml = '';
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i];
      var isSelected = !!_state.selected[en.remotePath || en.href];
      listHtml += '<div class="bk-wdfm-item' + (isSelected ? ' is-selected' : '') + '" data-remote-path="' + escAttr(en.remotePath || en.href) + '" data-is-dir="' + (en.isDir ? '1' : '0') + '" data-name="' + escAttr(en.name) + '">' +
        '<label class="bk-wdfm-check"><input type="checkbox" class="bk-wdfm-checkbox" data-remote-path="' + escAttr(en.remotePath || en.href) + '"' + (isSelected ? ' checked' : '') + ' /></label>' +
        '<span class="bk-wdfm-icon">' + fileIcon(en) + '</span>' +
        '<span class="bk-wdfm-name">' + escHtml(en.name) + '</span>' +
        '<span class="bk-wdfm-meta">' + (en.isDir ? '目录' : formatSize(en.size)) + '</span>' +
      '</div>';
    }
    if (!entries.length) {
      listHtml = '<div class="bk-wdfm-empty">此目录为空</div>';
    }

    var html =
      '<div class="bk-dialog" style="width:min(460px,calc(100vw - 40px));max-height:85vh">' +
        '<div class="bk-drawer-header">' +
          '<div class="bk-drawer-title">远程文件管理</div>' +
          '<button class="bk-drawer-close" data-action="wdfm-fm-close" aria-label="关闭">\u00d7</button>' +
        '</div>' +
        '<div class="bk-drawer-divider"></div>' +
        '<div class="bk-wdfm-fm-body">' +
          '<div class="bk-wdfm-breadcrumb">' +
            '<button class="bk-wdfm-up-btn" data-action="wdfm-up">← 上级</button>' +
            '<span class="bk-wdfm-path">' + escHtml(pathDisplay || '根目录') + '</span>' +
          '</div>' +
          '<div class="bk-wdfm-toolbar">' +
            '<button class="bk-wdfm-tool-btn" data-action="wdfm-select-all">全选</button>' +
            '<button class="bk-wdfm-tool-btn" data-action="wdfm-deselect-all">取消</button>' +
            '<button class="bk-wdfm-tool-btn bk-wdfm-tool-danger" data-action="wdfm-delete-selected"' + (selCount ? '' : ' disabled') + '>删除(' + selCount + ')</button>' +
            '<button class="bk-wdfm-tool-btn" data-action="wdfm-refresh">刷新</button>' +
          '</div>' +
          '<div class="bk-wdfm-list" id="wdfmList">' + listHtml + '</div>' +
          '<div class="bk-wdfm-status" id="wdfmStatus" style="display:none"></div>' +
          '<div class="bk-wdfm-error" id="wdfmError" style="display:none"></div>' +
          '<div class="bk-wdfm-progress-section" id="wdfmProgress" style="display:none">' +
            '<div class="bk-wdfm-progress-text" id="wdfmProgressText"></div>' +
            '<div class="bk-wdfm-progress-bar-wrap"><div class="bk-wdfm-progress-bar" id="wdfmProgressBar"></div></div>' +
          '</div>' +
        '</div>' +
        '<div class="bk-wdfm-footer">' +
          '<button class="bk-btn bk-btn-secondary" data-action="wdfm-fm-close">关闭</button>' +
        '</div>' +
      '</div>';

    // 就地替换 mask 内容
    connectDialogEl.innerHTML = html;
    // 更新 mask id 以匹配文件管理器
    connectDialogEl.id = 'bk-webdav-fm-main';

    // 绑定文件管理器事件
    _bindFileManagerEvents(connectDialogEl, connectDlg);
  }

  // ── 绑定文件管理器事件（复用 mask 场景） ────────────────────────────────
  function _bindFileManagerEvents(dialogEl, dlgObj) {
    // 绑定文件项事件（目录点击 + checkbox）
    _bindFileItemEvents(dialogEl);

    // 上级
    var upBtn = dialogEl.querySelector('[data-action="wdfm-up"]');
    if (upBtn) {
      upBtn.addEventListener('click', function () {
        if (!_state.connectedConfig) return;
        if (!_state.currentPath) return;
        var path = _state.currentPath.replace(/^\/+|\/+$/g, '');
        var idx = path.lastIndexOf('/');
        _state.currentPath = idx > 0 ? path.substring(0, idx) : '';
        _navigateTo(_state.currentPath, dialogEl);
      });
    }

    // 全选
    var selectAllBtn = dialogEl.querySelector('[data-action="wdfm-select-all"]');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', function () {
        var cbs = dialogEl.querySelectorAll('.bk-wdfm-checkbox');
        for (var i = 0; i < cbs.length; i++) {
          cbs[i].checked = true;
          _state.selected[cbs[i].getAttribute('data-remote-path')] = true;
          var item = cbs[i].closest('.bk-wdfm-item'); if (item) item.classList.add('is-selected');
        }
        _updateDeleteCount(dialogEl);
      });
    }

    // 取消全选
    var deselectAllBtn = dialogEl.querySelector('[data-action="wdfm-deselect-all"]');
    if (deselectAllBtn) {
      deselectAllBtn.addEventListener('click', function () {
        var cbs = dialogEl.querySelectorAll('.bk-wdfm-checkbox');
        for (var i = 0; i < cbs.length; i++) {
          cbs[i].checked = false;
          delete _state.selected[cbs[i].getAttribute('data-remote-path')];
          var item = cbs[i].closest('.bk-wdfm-item'); if (item) item.classList.remove('is-selected');
        }
        _updateDeleteCount(dialogEl);
      });
    }

    // 删除选中
    var deleteBtn = dialogEl.querySelector('[data-action="wdfm-delete-selected"]');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', function () {
        var sel = Object.keys(_state.selected);
        if (!sel.length) return;
        _confirmDelete(sel, dialogEl);
      });
    }

    // 刷新
    var refreshBtn = dialogEl.querySelector('[data-action="wdfm-refresh"]');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        _navigateTo(_state.currentPath, dialogEl);
      });
    }

    // 关闭
    var closeBtns = dialogEl.querySelectorAll('[data-action="wdfm-fm-close"]');
    for (var ci = 0; ci < closeBtns.length; ci++) {
      closeBtns[ci].addEventListener('click', function () {
        if (dlgObj && dlgObj.close) dlgObj.close();
      });
    }
  }

  // ── 就地更新文件列表（不重建弹窗）────────────────────────────────────────────
  function _updateFileList(dialogEl) {
    if (!dialogEl) return;
    var listEl = dialogEl.querySelector('#wdfmList');
    var pathEl = dialogEl.querySelector('.bk-wdfm-path');

    // 更新面包屑
    if (pathEl) pathEl.textContent = _state.currentPath || '根目录';

    // 重建列表 HTML
    var entries = _state.entries;
    var listHtml = '';
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i];
      var isSelected = !!_state.selected[en.remotePath || en.href];
      listHtml += '<div class="bk-wdfm-item' + (isSelected ? ' is-selected' : '') + '" data-remote-path="' + escAttr(en.remotePath || en.href) + '" data-is-dir="' + (en.isDir ? '1' : '0') + '" data-name="' + escAttr(en.name) + '">' +
        '<label class="bk-wdfm-check"><input type="checkbox" class="bk-wdfm-checkbox" data-remote-path="' + escAttr(en.remotePath || en.href) + '"' + (isSelected ? ' checked' : '') + ' /></label>' +
        '<span class="bk-wdfm-icon">' + fileIcon(en) + '</span>' +
        '<span class="bk-wdfm-name">' + escHtml(en.name) + '</span>' +
        '<span class="bk-wdfm-meta">' + (en.isDir ? '目录' : formatSize(en.size)) + '</span>' +
      '</div>';
    }
    if (!entries.length) {
      listHtml = '<div class="bk-wdfm-empty">此目录为空</div>';
    }
    if (listEl) listEl.innerHTML = listHtml;

    // 更新删除计数
    _updateDeleteCount(dialogEl);

    // 重新绑定文件项事件
    _bindFileItemEvents(dialogEl);
  }

  // ── 绑定文件项事件（目录点击 + checkbox）───────────────────────────────
  function _bindFileItemEvents(dialogEl) {
    if (!dialogEl) return;
    var items = dialogEl.querySelectorAll('.bk-wdfm-item');
    for (var idx = 0; idx < items.length; idx++) {
      (function (item) {
        item.addEventListener('click', function (e) {
          // 如果点击的是 checkbox，不做目录导航
          if (e.target.classList && e.target.classList.contains('bk-wdfm-checkbox')) return;

          var isDir = item.getAttribute('data-is-dir') === '1';
          if (!isDir) return; // 非目录：仅勾选

          var remotePath = item.getAttribute('data-remote-path');
          if (!remotePath || !_state.connectedConfig) return;

          _showStatus('加载中\u2026');
          win.WebDavManager.listDir(_state.connectedConfig, remotePath).then(function (subEntries) {
            var relPath = _toRelativePath(remotePath, _state.connectedConfig.url || '');
            _state.currentPath = relPath;
            _state.entries = subEntries || [];
            _state.selected = {};
            _updateFileList(dialogEl);
          }).catch(function (err) {
            _toast('加载目录失败');
          });
        });

        // checkbox 变化
        var cb = item.querySelector('.bk-wdfm-checkbox');
        if (cb) {
          cb.addEventListener('change', function () {
            var rp = cb.getAttribute('data-remote-path');
            if (cb.checked) {
              _state.selected[rp] = true;
              item.classList.add('is-selected');
            } else {
              delete _state.selected[rp];
              item.classList.remove('is-selected');
            }
            _updateDeleteCount(dialogEl);
          });
        }
      })(items[idx]);
    }
  }

  // ── 文件管理器主界面（独立打开，非从连接弹窗复用） ──────────────────
  // 此函数仅用于直接打开文件管理器的场景（如已有 connectedConfig）
  // 正常流程通过 _replaceWithFileManager 复用 mask
  function _renderFileManager() {
    var config = _state.connectedConfig;
    if (!config) return;

    var pathDisplay = _state.currentPath || '根目录';
    var entries = _state.entries;
    var selCount = Object.keys(_state.selected).length;

    var listHtml = '';
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i];
      var isSelected = !!_state.selected[en.remotePath || en.href];
      listHtml += '<div class="bk-wdfm-item' + (isSelected ? ' is-selected' : '') + '" data-remote-path="' + escAttr(en.remotePath || en.href) + '" data-is-dir="' + (en.isDir ? '1' : '0') + '" data-name="' + escAttr(en.name) + '">' +
        '<label class="bk-wdfm-check"><input type="checkbox" class="bk-wdfm-checkbox" data-remote-path="' + escAttr(en.remotePath || en.href) + '"' + (isSelected ? ' checked' : '') + ' /></label>' +
        '<span class="bk-wdfm-icon">' + fileIcon(en) + '</span>' +
        '<span class="bk-wdfm-name">' + escHtml(en.name) + '</span>' +
        '<span class="bk-wdfm-meta">' + (en.isDir ? '目录' : formatSize(en.size)) + '</span>' +
      '</div>';
    }

    if (!entries.length) {
      listHtml = '<div class="bk-wdfm-empty">此目录为空</div>';
    }

    var html =
      '<div class="bk-dialog" style="width:min(460px,calc(100vw - 40px));max-height:85vh">' +
        '<div class="bk-drawer-header">' +
          '<div class="bk-drawer-title">远程文件管理</div>' +
          '<button class="bk-drawer-close" data-action="wdfm-fm-close" aria-label="关闭">\u00d7</button>' +
        '</div>' +
        '<div class="bk-drawer-divider"></div>' +
        '<div class="bk-wdfm-fm-body">' +
          '<div class="bk-wdfm-breadcrumb">' +
            '<button class="bk-wdfm-up-btn" data-action="wdfm-up">← 上级</button>' +
            '<span class="bk-wdfm-path">' + escHtml(pathDisplay || '根目录') + '</span>' +
          '</div>' +
          '<div class="bk-wdfm-toolbar">' +
            '<button class="bk-wdfm-tool-btn" data-action="wdfm-select-all">全选</button>' +
            '<button class="bk-wdfm-tool-btn" data-action="wdfm-deselect-all">取消</button>' +
            '<button class="bk-wdfm-tool-btn bk-wdfm-tool-danger" data-action="wdfm-delete-selected"' + (selCount ? '' : ' disabled') + '>删除(' + selCount + ')</button>' +
            '<button class="bk-wdfm-tool-btn" data-action="wdfm-refresh">刷新</button>' +
          '</div>' +
          '<div class="bk-wdfm-list" id="wdfmList">' + listHtml + '</div>' +
          '<div class="bk-wdfm-status" id="wdfmStatus" style="display:none"></div>' +
          '<div class="bk-wdfm-error" id="wdfmError" style="display:none"></div>' +
          '<div class="bk-wdfm-progress-section" id="wdfmProgress" style="display:none">' +
            '<div class="bk-wdfm-progress-text" id="wdfmProgressText"></div>' +
            '<div class="bk-wdfm-progress-bar-wrap"><div class="bk-wdfm-progress-bar" id="wdfmProgressBar"></div></div>' +
          '</div>' +
        '</div>' +
        '<div class="bk-wdfm-footer">' +
          '<button class="bk-btn bk-btn-secondary" data-action="wdfm-fm-close">关闭</button>' +
        '</div>' +
      '</div>';

    var dlg = win.BK.openDialog({ id: 'bk-webdav-fm-main', html: html });
    if (!dlg) return;

    var dialogEl = document.getElementById('bk-webdav-fm-main');
    if (!dialogEl) return;

    // 绑定事件（复用统一函数）
    _bindFileManagerEvents(dialogEl, dlg);
  }

  // ── 导航到目录 ──
  // curDlg 可以是 dlg 对象 { close }，也可以是 dialogEl（DOM 元素）
  function _navigateTo(relPath, curDlgOrEl) {
    if (!_state.connectedConfig) return;
    _showStatus('加载中\u2026');
    win.WebDavManager.listDir(_state.connectedConfig, relPath).then(function (entries) {
      _state.currentPath = relPath || '';
      _state.entries = entries || [];
      _state.selected = {};
      // 优先使用 dialogEl 就地更新，避免 close() + 重建的时序问题
      var dialogEl = (curDlgOrEl && curDlgOrEl.nodeType) ? curDlgOrEl : document.getElementById('bk-webdav-fm-main');
      if (dialogEl) {
        _updateFileList(dialogEl);
      } else {
        _renderFileManager();
      }
    }).catch(function (err) {
      _toast('加载目录失败');
    });
  }

  // ── 更新删除按钮计数 ──
  function _updateDeleteCount(dialogEl) {
    var count = Object.keys(_state.selected).length;
    var btn = dialogEl ? dialogEl.querySelector('[data-action="wdfm-delete-selected"]') : null;
    if (btn) {
      btn.textContent = '\u5220\u9664(' + count + ')';
      btn.disabled = count === 0;
    }
  }

  // ── 删除确认弹窗 ──
  function _confirmDelete(remotePaths, curDlg) {
    var count = remotePaths.length;
    var names = [];
    for (var i = 0; i < remotePaths.length && names.length < 5; i++) {
      var parts = remotePaths[i].replace(/\/+$/, '').split('/');
      names.push(decodeURIComponent(parts[parts.length - 1] || ''));
    }
    var nameList = names.join('、');
    if (count > 5) nameList += ' 等共 ' + count + ' 项';

    var html =
      '<div class="bk-dialog" style="width:min(340px,calc(100vw - 40px))">' +
        '<div class="bk-drawer-header">' +
          '<div class="bk-drawer-title">确认删除</div>' +
          '<button class="bk-drawer-close" data-action="wdfm-del-cancel" aria-label="关闭">\u00d7</button>' +
        '</div>' +
        '<div class="bk-drawer-divider"></div>' +
        '<div class="bk-wdfm-del-body">' +
          '<div class="bk-wdfm-del-warn">\u26a0\ufe0f 删除后无法恢复</div>' +
          '<div class="bk-wdfm-del-list">' + escHtml(nameList) + '</div>' +
          '<div class="bk-wdfm-del-hint">将永久删除选中的文件/目录，此操作不可撤销。</div>' +
        '</div>' +
        '<div class="bk-wdfm-footer">' +
          '<button class="bk-btn bk-btn-secondary" data-action="wdfm-del-cancel">取消</button>' +
          '<button class="bk-btn bk-btn-danger" data-action="wdfm-del-confirm">确认删除</button>' +
        '</div>' +
      '</div>';

    var confirmDlg = win.BK.openDialog({ id: 'bk-webdav-fm-delete', html: html });
    if (!confirmDlg) return;

    var confirmEl = document.getElementById('bk-webdav-fm-delete');
    if (!confirmEl) return;

    // 取消
    var cancelBtns = confirmEl.querySelectorAll('[data-action="wdfm-del-cancel"]');
    for (var i = 0; i < cancelBtns.length; i++) {
      cancelBtns[i].addEventListener('click', function () {
        if (confirmDlg && confirmDlg.close) confirmDlg.close();
      });
    }

    // 确认删除
    var confirmBtn = confirmEl.querySelector('[data-action="wdfm-del-confirm"]');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function () {
        if (confirmDlg && confirmDlg.close) confirmDlg.close();
        _doDelete(remotePaths, curDlg);
      });
    }
  }

  // ── 执行删除 ──
  function _doDelete(remotePaths, curDlg) {
    if (!_state.connectedConfig || _state.deleting) return;
    _state.deleting = true;

    var total = remotePaths.length;
    var current = 0;
    var errors = [];

    var chain = Promise.resolve();
    for (var i = 0; i < remotePaths.length; i++) {
      (function (remotePath, idx) {
        chain = chain.then(function () {
          current = idx + 1;
          _showProgress(current, total);
          return win.WebDavManager.deleteResource(_state.connectedConfig, remotePath).then(function () {
            delete _state.selected[remotePath];
          }).catch(function (err) {
            var parts = remotePath.replace(/\/+$/, '').split('/');
            var name = decodeURIComponent(parts[parts.length - 1] || '');
            errors.push({ name: name, error: (err && err.hint) || (err && err.message) || '删除失败' });
          });
        });
      })(remotePaths[i], i);
    }

    chain.then(function () {
      _state.deleting = false;
      _hideProgress();

      if (errors.length === 0) {
        _toast('已删除 ' + total + ' 项');
      } else if (errors.length < total) {
        _toast('删除完成：' + (total - errors.length) + ' 成功，' + errors.length + ' 失败');
      } else {
        _toast('全部删除失败');
      }

      // 刷新目录（就地更新）
      _navigateTo(_state.currentPath, null);
    });
  }

  // ── UI 辅助 ──
  function _showStatus(msg) { _toast(msg); }
  function _showProgress(current, total) {
    var bar = document.getElementById('wdfmProgressBar');
    var text = document.getElementById('wdfmProgressText');
    var section = document.getElementById('wdfmProgress');
    if (section) section.style.display = 'block';
    if (text) text.textContent = '\u5220\u9664 ' + current + '/' + total;
    if (bar) bar.style.width = Math.round((current / total) * 100) + '%';
  }
  function _hideProgress() {
    var section = document.getElementById('wdfmProgress');
    if (section) section.style.display = 'none';
  }

  // ── 暴露 ──────────────────────────────────────────────────────────────
  win.BK = win.BK || {};
  win.BK.WebDavFileManager = {
    open: open
  };

})(window);
