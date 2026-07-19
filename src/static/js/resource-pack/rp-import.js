  // ── 导入对话框（底部抽屉，复用 ImportManager 完成实际导入）──
  // 来源：〔从文件〕〔从剪贴板〕〔WebDAV〕 三段式（segmented pill）
  BKResourcePack.showImportDialog = function () {
    if (!win.BK || !win.BK.openDialog) return;

    var dlg = win.BK.openDialog({
      id: 'bk-import-dialog',
      html: '<div class="bk-dialog" style="width:min(400px,calc(100vw - 40px))">' +
        '<div class="bk-drawer-header">' +
          '<div class="bk-drawer-title">导入</div>' +
          '<button class="bk-drawer-close" data-action="close" aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="bk-drawer-divider"></div>' +
        '<div class="bk-import-body">' +
          // 来源选择卡片
          '<div class="bk-source-row">' +
            '<button class="bk-source-card active" data-source="file">' +
              '<span class="bk-source-card-icon">📂</span>' +
              '<span class="bk-source-card-label">本地文件</span>' +
            '</button>' +
            '<button class="bk-source-card" data-source="webdav">' +
              '<span class="bk-source-card-icon">☁️</span>' +
              '<span class="bk-source-card-label">WebDAV</span>' +
            '</button>' +
          '</div>' +
          // 本地文件视图
          '<div id="bkImportFileView" style="margin-top:16px">' +
            '<button class="bk-import-action-primary" data-action="pick-files">📂 选择文件</button>' +
            '<div class="bk-import-secondary-row">' +
              '<button class="bk-import-scan-btn" data-action="scan-dir">🔍 扫描文件夹</button>' +
              '<label class="bk-checkbox">' +
                '<input type="checkbox" id="bkScanRecursive">' +
                '<span class="bk-checkbox-mark"></span>' +
                '包含子目录' +
              '</label>' +
            '</div>' +
            '<div class="bk-import-divider"></div>' +
            '<div id="bkImportFileList"></div>' +
            '<div class="bk-label-muted" id="bkImportStatus" style="margin-top:8px"></div>' +
          '</div>' +
          // WebDAV（动态渲染）
          '<div id="bkImportWebdavView" style="display:none"></div>' +
        '</div>' +
        // 底部确认按钮（始终占位）
        '<div class="bk-import-footer">' +
          '<button class="bk-import-confirm-btn bk-import-confirm-idle" id="bkImportConfirm" data-action="import">选择文件开始导入</button>' +
        '</div>' +
        '</div>'
    });

    if (!dlg) return;

    var dialogEl = document.getElementById('bk-import-dialog');
    if (!dialogEl) return;

    // 可导入扩展名（来自 WebDavManager，未加载时回退）
    var IMPORTABLE_EXT_ARR = (win.WebDavManager && win.WebDavManager.IMPORTABLE_EXT) ||
      ['.txt', '.epub', '.md', '.markdown', '.pdf'];

    // 本地文件列表状态
    var fileQueue = [];       // fileInfo[]
    var fileChecked = {};     // index -> true
    var importing = false;

    // WebDAV 局部状态
    var wd = {
      mode: 'disconnected',   // disconnected | connecting | browsing
      config: null,
      path: '',
      entries: [],
      selected: {},           // remotePath -> entry
      formatFilter: true,
      locked: false,
      _usingSavedId: null,
      _progressBars: {},
      _downloadedSet: {}      // remotePath -> imported bookId（当前服务器已下载的文件）
    };

    // 局部 formatSize 已移除——统一使用 dm-shared.js 的全局 formatSize
    // 调用点（renderFileList line 133）已有 f.size ? 守卫，0 字节不会传入

    function renderFileList() {
      var container = document.getElementById('bkImportFileList');
      var status = document.getElementById('bkImportStatus');
      var confirmBtn = document.getElementById('bkImportConfirm');
      if (!container) return;

      if (!fileQueue.length) {
        container.innerHTML = '<div class="bk-import-empty">' +
          '<span class="bk-import-empty-icon">📚</span>' +
          '<span class="bk-import-empty-text">选择要导入的书籍<br/>支持 EPUB、PDF、TXT、Markdown</span>' +
        '</div>';
        if (confirmBtn) {
          confirmBtn.className = 'bk-import-confirm-btn bk-import-confirm-idle';
          confirmBtn.textContent = '选择文件开始导入';
          confirmBtn.disabled = true;
        }
        if (status) status.textContent = '';
        return;
      }

      var html = '<div class="bk-import-list-header">' +
        '<label class="bk-checkbox">' +
          '<input type="checkbox" id="bkImportSelectAll" data-action="toggle-all">' +
          '<span class="bk-checkbox-mark"></span>' +
          '全选' +
        '</label>' +
        '<span style="font-size:var(--text-xs,.75rem);color:var(--text-muted,#9A958C)">' + fileQueue.length + ' 个文件</span>' +
      '</div>';

      var checkedCount = 0;
      for (var i = 0; i < fileQueue.length; i++) {
        var checked = !!fileChecked[i];
        if (checked) checkedCount++;
        var f = fileQueue[i];
        var displayName = f.name;
        var ext = (f.name || '').split('.').pop().toLowerCase();
        var icon = ext === 'epub' ? '📕' : ext === 'pdf' ? '📄' : ext === 'md' ? '📝' : '📋';
        html += '<div class="bk-import-file-card' + (checked ? ' checked' : '') + '">' +
          '<label class="bk-checkbox" style="margin:0">' +
            '<input type="checkbox" data-action="toggle-file" data-idx="' + i + '"' + (checked ? ' checked' : '') + '>' +
            '<span class="bk-checkbox-mark"></span>' +
          '</label>' +
          '<span class="bk-import-file-icon">' + icon + '</span>' +
          '<div class="bk-import-file-info">' +
            '<div class="bk-import-file-name">' + _escHtml(displayName) + '</div>' +
            (f.size ? '<div class="bk-import-file-size">' + formatSize(f.size) + '</div>' : '') +
          '</div>' +
        '</div>';
      }

      container.innerHTML = html;

      // 全选框状态同步
      var allCb = document.getElementById('bkImportSelectAll');
      if (allCb) allCb.checked = checkedCount === fileQueue.length;

      // 确认按钮：始终占位，根据选中数切换状态
      if (confirmBtn) {
        if (checkedCount > 0) {
          confirmBtn.className = 'bk-import-confirm-btn';
          confirmBtn.textContent = '导入' + (checkedCount > 1 ? ' ' + checkedCount + ' 个文件' : '');
          confirmBtn.disabled = false;
        } else {
          confirmBtn.className = 'bk-import-confirm-btn bk-import-confirm-idle';
          confirmBtn.textContent = '选择要导入的文件';
          confirmBtn.disabled = true;
        }
      }
      if (status) status.textContent = checkedCount > 0 ? '已选 ' + checkedCount + ' / ' + fileQueue.length : '';
    }

    function _escHtml(s) {
      return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // 选择文件（多选）
    function doPickFiles() {
      if (importing) return;
      if (!win.ImportManager || !win.ImportManager.pickFiles) return;
      win.ImportManager.pickFiles().then(function(files) {
        if (!files || !files.length) return;
        // 去重（按文件名）
        var existNames = {};
        for (var ei = 0; ei < fileQueue.length; ei++) existNames[fileQueue[ei].name] = true;
        var added = 0;
        for (var i = 0; i < files.length; i++) {
          if (!existNames[files[i].name]) {
            var idx = fileQueue.length;
            fileQueue.push(files[i]);
            fileChecked[idx] = true;
            existNames[files[i].name] = true;
            added++;
          }
        }
        renderFileList();
        var statusEl = document.getElementById('bkImportStatus');
        if (statusEl) statusEl.textContent = added > 0 ? '已添加 ' + added + ' 个文件' : '文件已在列表中';
      }).catch(function() {});
    }

    // 扫描文件夹
    function doScanDir() {
      if (importing) return;
      if (!win.ImportManager || !win.ImportManager.scanDirectory) return;
      var recursiveCb = document.getElementById('bkScanRecursive');
      var recursive = recursiveCb ? recursiveCb.checked : false;
      var statusEl = document.getElementById('bkImportStatus');
      if (statusEl) statusEl.textContent = '正在扫描...';
      win.ImportManager.scanDirectory({ recursive: recursive }).then(function(files) {
        if (!files || !files.length) {
          if (statusEl) statusEl.textContent = '未找到可导入的文件';
          return;
        }
        var existNames = {};
        for (var ei = 0; ei < fileQueue.length; ei++) existNames[fileQueue[ei].name] = true;
        var added = 0;
        for (var i = 0; i < files.length; i++) {
          if (!existNames[files[i].name]) {
            var idx = fileQueue.length;
            fileQueue.push(files[i]);
            fileChecked[idx] = true;
            existNames[files[i].name] = true;
            added++;
          }
        }
        renderFileList();
        if (statusEl) statusEl.textContent = '扫描完成，发现 ' + added + ' 个新文件' + (added < files.length ? '（' + (files.length - added) + ' 个已存在）' : '');
      }).catch(function(err) {
        if (statusEl) statusEl.textContent = err && err.name === 'AbortError' ? '' : '扫描失败';
      });
    }

    // 批量导入选中的文件
    function doImportSelected() {
      if (importing) return;
      var selected = [];
      for (var i = 0; i < fileQueue.length; i++) {
        if (fileChecked[i]) selected.push(fileQueue[i]);
      }
      if (!selected.length) return;
      importing = true;
      var confirmBtn = document.getElementById('bkImportConfirm');
      var statusEl = document.getElementById('bkImportStatus');
      if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '导入中...'; }

      win.ImportManager.importBatch(selected).then(function(results) {
        importing = false;
        var ok = 0, fail = 0;
        for (var i = 0; i < results.length; i++) {
          if (results[i].success) ok++; else fail++;
        }
        // 刷新书架
        if (win.BKRenderer && win.BKRenderer.renderHome) {
          try { win.BKRenderer.renderHome(); } catch (e) {}
        }
        if (fail === 0) {
          dlg.close();
        } else {
          if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '导入选中的文件'; }
          if (statusEl) statusEl.textContent = '完成：成功 ' + ok + ' 个，失败 ' + fail + ' 个';
          // 从队列中移除成功的
          var newQueue = [], newChecked = {};
          for (var j = 0; j < results.length; j++) {
            if (!results[j].success) {
              var nIdx = newQueue.length;
              newQueue.push(selected[j]);
              newChecked[nIdx] = true;
            }
          }
          fileQueue = newQueue;
          fileChecked = newChecked;
          renderFileList();
        }
      }).catch(function(err) {
        importing = false;
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '导入选中的文件'; }
        if (statusEl) statusEl.textContent = '导入出错：' + (err && err.message || '未知错误');
      });
    }

    // ── WebDAV 辅助 ────────────────────────────────────────────────
    function extOf(name) {
      var m = (name || '').split('.');
      return m.length > 1 ? ('.' + m.pop().toLowerCase()) : '';
    }
    function isImportable(name) { return IMPORTABLE_EXT_ARR.indexOf(extOf(name)) >= 0; }

    function findConfig(id) {
      var configs = (win.WebDavManager && win.WebDavManager.getAllConfigs) ? win.WebDavManager.getAllConfigs() : [];
      for (var i = 0; i < configs.length; i++) if (configs[i].id === id) return configs[i];
      return null;
    }
    // 选中服务器时展示其备注（note）
    function showConfigNote(cfg) {
      var noteEl = dialogEl.querySelector('#wdNote');
      if (!noteEl) return;
      if (cfg && cfg.note) {
        noteEl.textContent = '备注：' + cfg.note;
        noteEl.style.display = 'block';
      } else {
        noteEl.style.display = 'none';
      }
    }
    function findEntry(path) {
      for (var i = 0; i < wd.entries.length; i++) if (wd.entries[i].remotePath === path) return wd.entries[i];
      return null;
    }
    // 刷新「当前服务器已下载文件」集合（供浏览器标记 + 下载去重）
    // OPT-P1：增加 force 参数，force=false 且内存中已有数据时跳过全量扫描
    function refreshDownloadedSet(force) {
      wd._downloadedSet = wd._downloadedSet || {};
      if (!wd.config || !win.ImportManager || !win.ImportManager.getImportedBooks) return Promise.resolve();
      // OPT-P1：非强制刷新时，若内存中已有该服务器的去重数据，直接复用（省去遍历IndexedDB）
      if (!force && Object.keys(wd._downloadedSet).length > 0) return Promise.resolve();
      var serverId = wd.config.id;
      return win.ImportManager.getImportedBooks().then(function (books) {
        var map = {};
        for (var i = 0; i < books.length; i++) {
          var s = books[i].source;
          if (s && s.type === 'webdav' && s.serverId === serverId && s.remotePath) {
            map[s.remotePath] = books[i].id;
          }
        }
        wd._downloadedSet = map;
      }).catch(function () { wd._downloadedSet = {}; });
    }
    function readConfigForm() {
      var url = dialogEl.querySelector('#wdUrl');
      var user = dialogEl.querySelector('#wdUser');
      var pass = dialogEl.querySelector('#wdPass');
      var nameEl = dialogEl.querySelector('#wdName');
      return {
        url: url ? url.value.trim() : '',
        username: user ? user.value.trim() : '',
        password: pass ? pass.value : '',
        authType: 'basic',
        name: nameEl ? nameEl.value.trim() : ''
      };
    }
    // 解析 URL 输入：支持逗号 / 空格 / 换行 / 分号分隔的多个域名
    function parseUrlInput(val) {
      val = (val || '').trim();
      if (!val) return { url: '', urls: null };
      var parts = val.split(/[\s,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      var seen = {}, out = [];
      for (var i = 0; i < parts.length; i++) {
        if (!seen[parts[i]]) { seen[parts[i]] = 1; out.push(parts[i]); }
      }
      if (out.length <= 1) return { url: out[0] || '', urls: null };
      return { url: out[0], urls: out };
    }
    function fillConfigForm(cfg) {
      var url = dialogEl.querySelector('#wdUrl');
      var user = dialogEl.querySelector('#wdUser');
      var pass = dialogEl.querySelector('#wdPass');
      var nameEl = dialogEl.querySelector('#wdName');
      if (url) url.value = cfg.url || '';
      if (user) user.value = cfg.username || '';
      if (pass) pass.value = cfg.password || '';
      if (nameEl) nameEl.value = cfg.name || '';
    }
    function readSaveChecked() {
      var c = dialogEl.querySelector('#wdSave');
      return c ? c.checked : true;
    }
    // 合并“已选配置”与“表单输入”，得到最终连接配置
    function currentConnectConfig() {
      var form = readConfigForm();
      var parsed = parseUrlInput(form.url);
      if (wd._usingSavedId) {
        var saved = findConfig(wd._usingSavedId);
        if (saved) {
          var urls = (parsed.urls && parsed.urls.length) ? parsed.urls : (saved.urls || null);
          return {
            id: saved.id,
            name: saved.name,
            url: parsed.url || saved.url,
            urls: urls,
            username: form.username || saved.username,
            password: form.password || saved.password,
            authType: saved.authType || 'basic',
            note: saved.note || '',
            preset: saved.preset || false
          };
        }
      }
      return { url: parsed.url, urls: parsed.urls, username: form.username, password: form.password, authType: 'basic', name: '' };
    }
    function displayPath() {
      if (!wd.path) return '根目录';
      // 不显示完整 URL 路径，只取最后一段目录名
      var parts = wd.path.replace(/\/+$/, '').split('/');
      var last = parts[parts.length - 1];
      return last || '根目录';
    }
    function parentUrl(url) {
      var u = (url || '').replace(/\/+$/, '');
      var idx = u.lastIndexOf('/');
      return idx > 8 ? u.substring(0, idx) : u; // 保留 scheme（https://）
    }

    function setWdError(err) {
      var el = dialogEl.querySelector('#wdError');
      if (!el) return;
      if (!err || !err.hint) { el.style.display = 'none'; return; }
      el.style.display = 'block';
      el.className = (err.type === 'OK') ? 'bk-webdav-error bk-webdav-error-ok' : 'bk-webdav-error';
      el.textContent = err.hint;
    }
    function showStatus(msg) {
      var el = dialogEl.querySelector('#wdStatus');
      if (!el) return;
      el.style.display = 'block';
      // 支持包含 HTML（如取消按钮），但也兼容纯文本
      if (msg.indexOf('<') >= 0) { el.innerHTML = msg; }
      else { el.textContent = msg; }
    }
    function hideStatusAfter(ms) {
      setTimeout(function () {
        var el = dialogEl.querySelector('#wdStatus');
        if (el) el.style.display = 'none';
      }, ms);
    }
    // 中文数字标识：根据 URL 在配置中的索引返回「节点一/二/三…」，仅多域名时有意义
    var CN_NUMS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
    function nodeLabel(cfg, url) {
      if (!cfg) return '';
      var urls = cfg.urls && cfg.urls.length ? cfg.urls : (cfg.url ? [cfg.url] : []);
      if (urls.length <= 1) return '';  // 单域名不需要标识
      var idx = -1;
      for (var i = 0; i < urls.length; i++) {
        if (urls[i] === url) { idx = i; break; }
      }
      if (idx < 0) return '';
      return '节点' + (CN_NUMS[idx] || (idx + 1));
    }
    // 连接成功后提示所选最快节点（仅多域名时）
    function showConnectedNode(res) {
      if (!res || !res.config) return;
      var cfg = res.config;
      if (cfg.multiNode && cfg.connectedUrl) {
        var label = nodeLabel(cfg, cfg.connectedUrl) || '最快节点';
        showStatus('已连接 · ' + label + (cfg.connectMs ? '（' + cfg.connectMs + 'ms）' : ''));
        setTimeout(function () {
          var el = dialogEl.querySelector('#wdStatus');
          if (el) el.style.display = 'none';
        }, 4000);
      }
    }
    function setItemProgress(remotePath, p, show) {
      var bar = wd._progressBars && wd._progressBars[remotePath];
      if (!bar) return;
      bar.style.display = show ? 'block' : 'none';
      var fill = bar.querySelector('.bk-webdav-progress-bar');
      if (fill) {
        if (p < 0) { fill.style.width = '100%'; fill.classList.add('bk-webdav-progress-err'); }
        else { fill.style.width = Math.round(p * 100) + '%'; fill.classList.remove('bk-webdav-progress-err'); }
      }
    }
    function updateBatchBar() {
      var bar = dialogEl.querySelector('#wdBatchBar');
      if (!bar) return;
      var count = Object.keys(wd.selected).length;
      var countEl = bar.querySelector('.bk-webdav-batch-count');
      if (countEl) countEl.textContent = '已选 ' + count + ' 本';
      bar.style.display = count > 0 ? 'flex' : 'none';
    }

    // 渲染 WebDAV 子视图（依据 wd.mode）
    function renderWebdav() {
      var wdView = document.getElementById('bkImportWebdavView');
      if (!wdView) return;
      wd._progressBars = {};

      if (wd.mode === 'connecting') {
        wdView.innerHTML = '<div class="bk-webdav-connecting"><div class="bk-spinner"></div>连接中…<button class="bk-webdav-cancel-btn" data-action="wd-cancel-connect">取消</button></div>';
        return;
      }

      if (wd.mode === 'disconnected') {
        var configs = (win.WebDavManager && win.WebDavManager.getAllConfigs) ? win.WebDavManager.getAllConfigs() : [];
        var savedOptions = '';
        for (var ci = 0; ci < configs.length; ci++) {
          var optLabel = configs[ci].name || configs[ci].url;
          if (configs[ci].preset) optLabel = '★ ' + optLabel; // 标记预置服务器
          savedOptions += '<option value="' + escAttr(configs[ci].id) + '">' + escHtml(optLabel) + '</option>';
        }
        wdView.innerHTML =
          '<div class="bk-webdav-form">' +
            '<div class="bk-label-muted">已保存的服务器</div>' +
            '<select class="bk-field bk-webdav-select" id="wdSavedSelect" data-action="wd-config-select">' +
              '<option value="">— 新建配置 —</option>' + savedOptions +
            '</select>' +
            '<div class="bk-webdav-note" id="wdNote" style="display:none"></div>' +
            '<div id="wdCredFields">' +
              '<input class="bk-field" id="wdUrl" placeholder="WebDAV 地址（多个用逗号/空格分隔，自动选最快）" />' +
              '<input class="bk-field" id="wdUser" placeholder="用户名（可选）" />' +
              '<input class="bk-field" id="wdPass" type="password" placeholder="密码（可选）" />' +
              '<input class="bk-field" id="wdName" placeholder="备注 / 名称（选填，推荐填写，显示在书籍来源）" />' +
              '<label class="bk-webdav-save" id="wdSaveRow"><input type="checkbox" id="wdSave" checked /> 保存此配置到本机</label>' +
            '</div>' +
            '<div class="bk-webdav-error" id="wdError" style="display:none"></div>' +
            '<div class="bk-webdav-actions">' +
              '<button class="bk-btn bk-btn-primary" data-action="wd-connect">连接</button>' +
            '</div>' +
          '</div>';
        return;
      }

      // browsing
      var listHtml = '';
      if (wd._dirLoading) {
        listHtml = '<div class="bk-webdav-connecting"><div class="bk-spinner"></div>加载目录中…</div>';
      } else if (!wd.entries.length) {
        listHtml = '<div class="bk-webdav-empty">该目录为空</div>';
      } else {
        for (var i = 0; i < wd.entries.length; i++) {
          var en = wd.entries[i];
          if (wd.formatFilter && !en.isDir && !isImportable(en.name)) continue;
          if (en.isDir) {
            listHtml += '<div class="bk-webdav-dir" data-action="wd-open-dir" data-path="' + escAttr(en.remotePath) + '">' +
              '<span class="bk-webdav-dir-icon">📁</span>' +
              '<span class="bk-webdav-name">' + escHtml(en.name) + '</span>' +
              '</div>';
          } else {
            var selected = !!wd.selected[en.remotePath];
            var doneId = (wd._downloadedSet && wd._downloadedSet[en.remotePath]) || null;
            var doneCls = doneId ? ' done' : '';
            var dlLabel = doneId ? '重新下载' : '下载';
            var doneTag = doneId ? '<span class="bk-webdav-done-tag">已下载 ✓</span>' : '';
            listHtml += '<div class="bk-webdav-file' + (selected ? ' selected' : '') + doneCls + '">' +
              '<label class="bk-webdav-check"><input type="checkbox" data-action="wd-check" data-path="' + escAttr(en.remotePath) + '"' + (selected ? ' checked' : '') + ' /></label>' +
              '<span class="bk-webdav-name">' + escHtml(en.name) + '</span>' +
              doneTag +
              '<span class="bk-webdav-size">' + formatSize(en.size) + '</span>' +
              '<button class="bk-webdav-dl" data-action="wd-download" data-path="' + escAttr(en.remotePath) + '">' + dlLabel + '</button>' +
              '<div class="bk-webdav-progress" data-path="' + escAttr(en.remotePath) + '" style="display:none"><div class="bk-webdav-progress-bar"></div></div>' +
              '</div>';
          }
        }
      }
      var selCount = Object.keys(wd.selected).length;
      wdView.innerHTML =
        '<div class="bk-webdav-breadcrumb">' +
          '<button class="bk-webdav-up" data-action="wd-nav-up"' + (wd.path === '' ? ' disabled' : '') + '>← 上级</button>' +
          '<span class="bk-webdav-path">' + escHtml((nodeLabel(wd.config, wd.config && wd.config.connectedUrl) ? nodeLabel(wd.config, wd.config.connectedUrl) + ' · ' : '') + displayPath()) + '</span>' +
          '<button class="bk-webdav-disconnect" data-action="wd-disconnect">断开</button>' +
        '</div>' +
        '<label class="bk-webdav-filter"><input type="checkbox" data-action="wd-filter"' + (wd.formatFilter ? ' checked' : '') + ' /> 仅显示可导入格式</label>' +
        '<div class="bk-webdav-status" id="wdStatus" style="display:none"></div>' +
        '<div class="bk-webdav-list">' + listHtml + '</div>' +
        '<div class="bk-webdav-batchbar" id="wdBatchBar" style="display:' + (selCount > 0 ? 'flex' : 'none') + '">' +
          '<span class="bk-webdav-batch-count">已选 ' + selCount + ' 本</span>' +
          '<button class="bk-btn bk-btn-primary" data-action="wd-download-selected">下载选中</button>' +
        '</div>';
      // 建立进度条索引
      var progEls = wdView.querySelectorAll('.bk-webdav-progress');
      for (var pi = 0; pi < progEls.length; pi++) {
        wd._progressBars[progEls[pi].getAttribute('data-path')] = progEls[pi];
      }
    }

    function initWebdav() {
      var active = (win.WebDavManager && win.WebDavManager.getActiveConfig) ? win.WebDavManager.getActiveConfig() : null;
      if (active) {
        // OPT-P2：重连时先检查缓存，命中则跳过 PROPFIND 直接进入浏览
        var cacheKey = active.id + ':';
        var cached = _dirCache[cacheKey];
        if (cached && Date.now() - cached.ts < DIR_CACHE_TTL) {
          wd.config = active; wd.path = ''; wd.entries = cached.entries; wd.selected = {}; wd.mode = 'browsing';
          wd._usingSavedId = active.id;
          refreshDownloadedSet(false).then(function () { renderWebdav(); });
          return;
        }
        wd.mode = 'connecting';
        wd._usingSavedId = active.id;
        renderWebdav();
        var cancelled = false;
        // 点击取消时立即回到断开态
        var cancelBtn = dialogEl.querySelector('[data-action="wd-cancel-connect"]');
        if (cancelBtn) cancelBtn.onclick = function () { cancelled = true; wd.mode = 'disconnected'; wd.config = null; renderWebdav(); };
        win.WebDavManager.listDir(active, '').then(function (entries) {
          if (cancelled) return;
          wd.config = active; wd.path = ''; wd.entries = entries; wd.selected = {}; wd.mode = 'browsing';
          // OPT-P2：写入缓存，供后续重连复用
          _dirCache[cacheKey] = { entries: entries, ts: Date.now() };
          // OPT-P1：初始化首次加载，强制全量刷新
          refreshDownloadedSet(true).then(function () { renderWebdav(); });
        }).catch(function (err) {
          if (cancelled) return;
          wd.mode = 'disconnected'; wd.config = null;
          renderWebdav();
          setWdError(err);
        });
      } else {
        wd.mode = 'disconnected';
        renderWebdav();
      }
    }

    function wdConnect() {
      var cfg = currentConnectConfig();
      if (!cfg.url) { setWdError({ hint: '请填写 WebDAV 地址' }); return; }
      setWdError(null);
      // 预置服务器无需再保存到本机（已随包下发）
      var isPreset = cfg.preset === true;
      wd.locked = true;
      wd.mode = 'connecting';
      renderWebdav();
      var cancelled = false;
      var cancelBtn = dialogEl.querySelector('[data-action="wd-cancel-connect"]');
      if (cancelBtn) cancelBtn.onclick = function () { cancelled = true; wd.locked = false; wd.mode = 'disconnected'; wd.config = null; renderWebdav(); };
      win.WebDavManager.connect(cfg, { save: readSaveChecked() && !isPreset }).then(function (res) {
        if (cancelled) return;
        wd.locked = false;
        wd.config = res.config; wd.path = ''; wd.entries = res.entries; wd.selected = {}; wd.mode = 'browsing';
        wd._usingSavedId = res.config.id;
        // OPT-P2：新连接拿到根目录后写入缓存，供后续重连/浏览复用
        _dirCache[res.config.id + ':'] = { entries: res.entries, ts: Date.now() };
        // OPT-P1：新连接时强制全量刷新
        refreshDownloadedSet(true).then(function () { renderWebdav(); showConnectedNode(res); });
      }).catch(function (err) {
        if (cancelled) return;
        wd.locked = false;
        wd.mode = 'disconnected';
        renderWebdav();
        setWdError(err);
      });
    }

    // OPT-P2：目录列表 LRU 缓存，重复浏览同目录时跳过 PROPFIND
    var _dirCache = {};   // key: serverId:path → { entries, ts }
    var DIR_CACHE_TTL = 300000;  // 300 秒

    function wdOpenDir(path) {
      if (!wd.config) return;
      path = path || '';  // 空字符串 = 根目录（与 initWebdav / wdConnect 一致）
      if (wd._dirLoading) return;  // 防止并发列目录（双击/快速点击时丢弃后续请求）
      // OPT-P2：命中缓存时直接使用，不发 PROPFIND
      var cacheKey = wd.config.id + ':' + path;
      var cached = _dirCache[cacheKey];
      if (cached && Date.now() - cached.ts < DIR_CACHE_TTL) {
        wd.path = path; wd.entries = cached.entries; wd.selected = {}; wd.mode = 'browsing';
        // OPT-P1：浏览已有缓存目录，非强制刷新
        refreshDownloadedSet(false).then(function () { renderWebdav(); });
        return;
      }
      // 保存当前锁定状态（可能正在下载），列目录完成后恢复，避免误解锁
      var prevLocked = wd.locked;
      var prevPath = wd.path;      // 保存当前路径，加载失败时恢复
      wd._dirLoading = true;
      wd.locked = true;
      renderWebdav();  // 立即显示加载中
      win.WebDavManager.listDir(wd.config, path).then(function (entries) {
        wd.path = path; wd.entries = entries; wd.selected = {}; wd.mode = 'browsing';
        wd._dirLoading = false; wd.locked = prevLocked;
        // OPT-P2：写入缓存
        _dirCache[cacheKey] = { entries: entries, ts: Date.now() };
        // OPT-P1：浏览新目录，非强制刷新（内存中已有数据即复用）
        refreshDownloadedSet(false).then(function () { renderWebdav(); });
      }).catch(function (err) {
        wd._dirLoading = false; wd.locked = prevLocked; wd.path = prevPath; renderWebdav(); setWdError(err);
      });
    }

    function wdNavUp() {
      if (!wd.config || wd.path === '') return;
      var parent = parentUrl(wd.path);
      // 导航回根目录时统一用空字符串，匹配缓存键 configId: 和初始状态
      var configUrl = (wd.config.url || '').replace(/\/+$/, '');
      if (parent === configUrl) parent = '';
      wdOpenDir(parent);
    }

    function wdDisconnect() {
      // 仅重置 UI 状态，保留 _dirCache 和 activeConfig，
      // 下次打开弹窗时 initWebdav() 命中缓存即可秒开，无需再次 PROPFIND。
      // 缓存通过 TTL（300s）自动过期，无需主动清理。
      wd.mode = 'disconnected'; wd.config = null; wd.path = ''; wd.entries = []; wd.selected = {}; wd._usingSavedId = null;
      wd._dirLoading = false; wd.locked = false;
      renderWebdav();
    }

    // P3-3: 顺序下载改为 async/await，取代递归 next(i) 模式
    // 顺序下载（并发 1），失败单本继续
    async function downloadAndImport(entries) {
      if (!wd.config || !entries.length || wd.locked) return;
      wd.locked = true;
      wd._downloadCancelled = false;
      // OPT-P1：下载前强制刷新一次「已下载集合」，保证去重判断基于最新记录
      await refreshDownloadedSet(true);
      var done = 0, updated = 0, failed = 0, skipped = 0;
      for (var i = 0; i < entries.length; i++) {
        // 检查取消标志
        if (wd._downloadCancelled) {
          skipped = entries.length - i;
          break;
        }
        var entry = entries[i];
        var existingId = (wd._downloadedSet && wd._downloadedSet[entry.remotePath]) || null;
        showStatus('下载中 (' + (i + 1) + '/' + entries.length + ')：' + entry.name + (existingId ? '（已存在，更新中）' : '') + ' <button class="bk-webdav-cancel-btn" data-action="wd-cancel-download">取消</button>');
        setItemProgress(entry.remotePath, 0, true);
        try {
          var fileInfo = await win.WebDavManager.downloadFile(wd.config, entry, function (p) {
            if (p >= 0) setItemProgress(entry.remotePath, p, true);
          });
          // 下载完成后再次检查取消（下载期间用户可能点了取消）
          if (wd._downloadCancelled) { skipped++; continue; }
          var source = {
            type: 'webdav',
            serverId: wd.config.id,
            remotePath: entry.remotePath,
            serverName: (wd.config.name && wd.config.name.indexOf('://') < 0) ? wd.config.name : (nodeLabel(wd.config, wd.config.connectedUrl) || 'WebDAV')
          };
          // 已下载过则复用原 id（resync/覆盖写），避免重复书
          var importResult = await win.ImportManager.importFromBuffer(fileInfo, { source: source, bookId: existingId || undefined });
          // OPT-P1：增量更新内存去重map，避免每本下载完都重扫IndexedDB
          var newBookId = (importResult && importResult.id) ? importResult.id : (existingId || ('b_' + Date.now()));
          wd._downloadedSet[entry.remotePath] = newBookId;
          if (existingId) updated++; else done++;
          setItemProgress(entry.remotePath, 1, false);
        } catch (err) {
          failed++;
          setItemProgress(entry.remotePath, -1, false);
          showStatus('失败：' + entry.name + ' — ' + (err && err.message ? err.message : String(err)));
        }
      }
      // 收尾
      wd.locked = false;
      wd._downloadCancelled = false;
      wd.selected = {};
      var parts = [skipped > 0 ? '已取消：新导入 ' + done + ' 本' : '导入完成：新导入 ' + done + ' 本'];
      if (updated) parts.push('更新 ' + updated + ' 本');
      if (failed) parts.push('失败 ' + failed + ' 本');
      if (skipped) parts.push('跳过 ' + skipped + ' 本');
      showStatus(parts.join('，'));
      hideStatusAfter(4000);
      // 刷新书城/书架（导入已入架，renderHome 即书架）
      if (win.BKRenderer && win.BKRenderer.renderHome) {
        try { win.BKRenderer.renderHome(); } catch (e) {}
      }
      // OPT-P1：下载完成后不需要全量刷新，内存map已通过增量更新保持最新
      renderWebdav();
    }

    function wdDownloadOne(path) {
      var entry = findEntry(path);
      if (entry) downloadAndImport([entry]);
    }
    function wdDownloadSelected() {
      var entries = Object.keys(wd.selected).map(function (k) { return wd.selected[k]; });
      downloadAndImport(entries);
    }

    function handleWdAction(action, el) {
      if (wd.locked) {
        // 下载中仍允许断开和浏览（目录导航），仅阻止新的下载/选择操作
        if (action === 'wd-disconnect') { wdDisconnect(); return; }
        if (action === 'wd-nav-up') { wdNavUp(); return; }
        if (action === 'wd-open-dir') { wdOpenDir(el.getAttribute('data-path')); return; }
        if (action === 'wd-cancel-download') { wd._downloadCancelled = true; showStatus('正在取消…'); return; }
        // 其他操作给提示
        if (action === 'wd-download' || action === 'wd-download-selected') {
          showStatus('正在下载中，请等待完成…');
          hideStatusAfter(2000);
        }
        return;
      }
      switch (action) {
        case 'wd-config-select': return; // change 事件处理
        case 'wd-connect': wdConnect(); return;
        case 'wd-nav-up': wdNavUp(); return;
        case 'wd-disconnect': wdDisconnect(); return;
        case 'wd-open-dir': wdOpenDir(el.getAttribute('data-path')); return;
        case 'wd-download': wdDownloadOne(el.getAttribute('data-path')); return;
        case 'wd-download-selected': wdDownloadSelected(); return;
        case 'wd-check': return;   // change 事件处理
        case 'wd-filter': return;  // change 事件处理
        default: return;
      }
    }

    // ── 来源切换 ───────────────────────────────────────────────────
    function showSource(source) {
      var cards = dialogEl.querySelectorAll('.bk-source-card');
      for (var i = 0; i < cards.length; i++) {
        cards[i].classList.toggle('active', cards[i].getAttribute('data-source') === source);
      }
      var fileView = document.getElementById('bkImportFileView');
      var wdView = document.getElementById('bkImportWebdavView');
      var confirmBtn = document.getElementById('bkImportConfirm');
      if (fileView) fileView.style.display = (source === 'file') ? 'block' : 'none';
      if (wdView) wdView.style.display = (source === 'webdav') ? 'block' : 'none';
      if (source === 'file') {
        if (confirmBtn) confirmBtn.style.display = '';
        renderFileList();
      } else {
        // WebDAV 有自己的批量操作栏，隐藏底部确认按钮
        if (confirmBtn) confirmBtn.style.display = 'none';
      }
    }

    // ── 事件委托 ───────────────────────────────────────────────────
    dialogEl.addEventListener('click', function (e) {
      var t = e.target;

      // 来源卡片切换（data-source）
      var card = t.closest ? t.closest('.bk-source-card') : null;
      if (card) {
        var source = card.getAttribute('data-source');
        showSource(source);
        if (source === 'webdav') initWebdav();
        return;
      }

      // 向上查找最近的 [data-action] 元素（兼容点击子元素如 span/icon）
      var actionEl = (t.closest && t.closest('[data-action]')) || t;
      var actionAttr = actionEl.getAttribute ? actionEl.getAttribute('data-action') : null;

      if (actionAttr === 'close') { dlg.close(); return; }
      if (actionAttr === 'pick-files') { doPickFiles(); return; }
      if (actionAttr === 'scan-dir') { doScanDir(); return; }
      if (actionAttr === 'import') { doImportSelected(); return; }
      if (actionAttr === 'toggle-all') {
        var allCb2 = document.getElementById('bkImportSelectAll');
        var isChecked = allCb2 ? allCb2.checked : false;
        for (var ai = 0; ai < fileQueue.length; ai++) fileChecked[ai] = isChecked;
        renderFileList();
        return;
      }
      if (actionAttr === 'toggle-file') {
        var idx = parseInt(actionEl.getAttribute('data-idx'), 10);
        if (!isNaN(idx)) { fileChecked[idx] = actionEl.checked; renderFileList(); }
        return;
      }

      // WebDAV 动作（data-action 以 wd- 开头）
      if (actionAttr && actionAttr.indexOf('wd-') === 0) {
        handleWdAction(actionAttr, actionEl);
        return;
      }
    });

    dialogEl.addEventListener('change', function (e) {
      var t = e.target;
      var actionAttr = t.getAttribute && t.getAttribute('data-action');
      if (wd.locked) {
        // 下载中仍允许勾选/取消勾选文件和切换格式过滤
        if (actionAttr !== 'wd-check' && actionAttr !== 'wd-filter') return;
      }
      if (actionAttr === 'wd-config-select') {
        var id = t.value;
        wd._usingSavedId = id || null;
        var credFields = dialogEl.querySelector('#wdCredFields');
        var saveRow = dialogEl.querySelector('#wdSaveRow');
        if (id) {
          var cfg = findConfig(id);
          if (cfg) {
            showConfigNote(cfg);
            if (cfg.preset) {
              // 预置服务器：仅显示名称+备注，隐藏地址/账号/密码等凭据字段
              if (credFields) credFields.style.display = 'none';
              fillConfigForm({ url: '', username: '', password: '' });
            } else {
              // 用户自建配置：显示并回填可编辑的凭据字段
              if (credFields) credFields.style.display = 'block';
              fillConfigForm(cfg);
              if (saveRow) saveRow.style.display = 'flex';
            }
          }
        } else {
          // 新建配置：显示空白可编辑字段
          showConfigNote(null);
          if (credFields) credFields.style.display = 'block';
          fillConfigForm({ url: '', username: '', password: '' });
          if (saveRow) saveRow.style.display = 'flex';
        }
        return;
      }
      if (actionAttr === 'wd-check') {
        var p = t.getAttribute('data-path');
        if (t.checked) wd.selected[p] = findEntry(p); else delete wd.selected[p];
        var row = t.closest ? t.closest('.bk-webdav-file') : null;
        if (row) row.classList.toggle('selected', t.checked);
        updateBatchBar();
        return;
      }
      if (actionAttr === 'wd-filter') {
        wd.formatFilter = t.checked;
        renderWebdav();
        return;
      }
    });

    // 默认来源：从文件
    showSource('file');
  };

  win.BKResourcePack = BKResourcePack;
