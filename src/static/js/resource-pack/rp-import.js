  // ── 导入对话框（底部抽屉，复用 ImportManager 完成实际导入）──
  // 仅本地文件导入（WebDAV 导入已迁入「数据与同步」中心页 BK.DataSyncPage）
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

    // 本地文件列表状态
    var fileQueue = [];       // fileInfo[]
    var fileChecked = {};     // index -> true
    var importing = false;

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
        var icon = ext === 'epub' ? '📕' : ext === 'pdf' ? '📄' : ext === 'md' ? '📝' : ext === 'zip' ? '📦' : '📋';
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

      // 分离 .zip 文件和普通文件
      var zipFiles = [];
      var normalFiles = [];
      for (var s = 0; s < selected.length; s++) {
        var ext = (selected[s].name || '').split('.').pop().toLowerCase();
        if (ext === 'zip') zipFiles.push(selected[s]);
        else normalFiles.push(selected[s]);
      }

      importing = true;
      var confirmBtn = document.getElementById('bkImportConfirm');
      var statusEl = document.getElementById('bkImportStatus');
      if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '导入中...'; }

      // 先处理普通文件，再处理 ZIP 文件
      var normalPromise = normalFiles.length
        ? win.ImportManager.importBatch(normalFiles)
        : Promise.resolve([]);

      normalPromise.then(function(normalResults) {
        // 逐个处理 ZIP 文件
        var chain = Promise.resolve();
        var zipResults = [];
        for (var z = 0; z < zipFiles.length; z++) {
          (function(zipFile) {
            chain = chain.then(function() {
              if (!win.BK || !win.BK.ImportZip) {
                zipResults.push({ success: false, name: zipFile.name, error: 'ZIP 导入功能不可用' });
                return;
              }
              var buf = zipFile.arrayBuffer || zipFile.data;
              if (buf && !(buf instanceof ArrayBuffer)) {
                // base64 → ArrayBuffer
                try {
                  var bin = atob(buf);
                  var arr = new Uint8Array(bin.length);
                  for (var k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
                  buf = arr.buffer;
                } catch (e) {
                  zipResults.push({ success: false, name: zipFile.name, error: 'ZIP 数据读取失败' });
                  return;
                }
              }
              if (!buf) {
                zipResults.push({ success: false, name: zipFile.name, error: 'ZIP 数据为空' });
                return;
              }
              if (statusEl) statusEl.textContent = '正在解压 ' + zipFile.name + '...';
              return win.BK.ImportZip.importFromZip(buf, zipFile.name).then(function(result) {
                // 将 ZIP 导入结果展开为单条记录
                for (var r = 0; r < (result.success || 0); r++) {
                  zipResults.push({ success: true, name: zipFile.name });
                }
                if (result.errors && result.errors.length) {
                  for (var e = 0; e < result.errors.length; e++) {
                    zipResults.push({ success: false, name: result.errors[e].title || zipFile.name, error: result.errors[e].error });
                  }
                }
              }).catch(function(err) {
                zipResults.push({ success: false, name: zipFile.name, error: (err && err.message) || 'ZIP 解析失败' });
              });
            });
          })(zipFiles[z]);
        }

        return chain.then(function() { return normalResults.concat(zipResults); });
      }).then(function(results) {
        importing = false;
        var ok = 0, fail = 0;
        for (var i = 0; i < results.length; i++) {
          if (results[i].success) ok++; else fail++;
        }
        // 刷新书架
        // ★ 修复：renderHome 无条件渲染书架页，导致从书城页导入后「页面是书架但 Tab 高亮书城」。
        //   按当前 hash 分发到对应视图；hash 为空/未知时走 renderHome 兜底（书架）。
        if (win.BKRenderer) {
          var _h2 = (win.location && win.location.hash) || '';
          var _r2 = _h2.replace(/^#\/?/, '').split('/')[0] || '';
          try {
            if (_r2 === 'city') {
              if (win.BKRenderer.renderCityPage) win.BKRenderer.renderCityPage();
            } else if (_r2 === 'shelf') {
              if (win.BKRenderer.renderShelfPage) win.BKRenderer.renderShelfPage();
            } else if (win.BKRenderer.renderHome) {
              win.BKRenderer.renderHome();
            }
          } catch (e) {}
        }
        if (fail === 0) {
          dlg.close();
        } else {
          if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '导入选中的文件'; }
          if (statusEl) statusEl.textContent = '完成：成功 ' + ok + ' 个，失败 ' + fail + ' 个';
          // 从队列中移除成功的（按文件名匹配，避免 ZIP 展开后索引错位）
          var failedNames = {};
          for (var j = 0; j < results.length; j++) {
            if (!results[j].success && results[j].name) {
              failedNames[results[j].name] = true;
            }
          }
          var newQueue = [], newChecked = {};
          for (var k = 0; k < selected.length; k++) {
            if (failedNames[selected[k].name]) {
              var nIdx = newQueue.length;
              newQueue.push(selected[k]);
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

    // ── 事件委托 ───────────────────────────────────────────────────
    dialogEl.addEventListener('click', function (e) {
      var t = e.target;

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
    });

    // 初始渲染空列表
    renderFileList();
  };

  win.BKResourcePack = BKResourcePack;
