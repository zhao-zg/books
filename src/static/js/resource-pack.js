/*!
 * resource-pack.js — 书籍资源包下载管理
 *
 * 暴露：window.BKResourcePack
 *   .showPacksDialog()    打开资源包下载弹层
 *   .showCachedDialog()   打开已缓存书籍管理弹层
 *   .isPackCached(pack)   → Promise<boolean>
 */
(function (win) {
  'use strict';

  var CACHE_NAME = 'bk-main';
  var SOURCES_KEY = 'bk_pack_sources';

  function getRoot() {
    return win.BK_ROOT || './';
  }

  function entryToUrl(entryName) {
    var clean = entryName.replace(/^\/+/, '');
    return win.location.origin + '/' + clean;
  }

  function fmtSize(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
  }

  function escHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escAttr(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  // ── 清单获取 ─────────────────────────────────────────────────────────

  var _manifest = null;

  function fetchManifest() {
    if (win.__BK_LOCAL_DEV__) return Promise.reject(new Error('本地开发模式，跳过远程请求'));
    if (_manifest) return Promise.resolve(_manifest);
    var servers = (win.BK_SERVERS && win.BK_SERVERS.cloudflare) || [];
    var bust = '?t=' + Date.now();
    var urls = servers.map(function (s) {
      return s.replace(/\/$/, '') + '/resource-packs.json' + bust;
    });
    urls.push(getRoot() + 'resource-packs.json' + bust);

    function tryNext(idx) {
      if (idx >= urls.length) return Promise.reject(new Error('无法获取资源包清单'));
      return fetch(urls[idx], { cache: 'no-cache' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (data) {
          _manifest = data;
          return data;
        })
        .catch(function () { return tryNext(idx + 1); });
    }
    return tryNext(0);
  }

  // ── 缓存检查 ─────────────────────────────────────────────────────────

  function isPackCached(pack) {
    if (!('caches' in win)) return Promise.resolve(false);
    var probe = pack.books && pack.books[0];
    if (!probe) return Promise.resolve(false);
    var url = entryToUrl(probe.path + '/book.json');
    return caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(url).then(function (r) { return !!r; });
    }).catch(function () { return false; });
  }

  function isBookCached(bookPath) {
    if (!('caches' in win)) return Promise.resolve(false);
    var url = win.location.origin + '/' + bookPath + '/book.json';
    return caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(url).then(function (r) { return !!r; });
    }).catch(function () { return false; });
  }

  // ── 来源追踪 ─────────────────────────────────────────────────────────

  function _loadSources() {
    try { return JSON.parse(win.localStorage.getItem(SOURCES_KEY) || '{}'); }
    catch (e) { return {}; }
  }

  function _saveSources(obj) {
    try { win.localStorage.setItem(SOURCES_KEY, JSON.stringify(obj)); } catch (e) {}
  }

  function _markPackSources(pack) {
    var sources = _loadSources();
    var ts = Date.now();
    (pack.books || []).forEach(function (b) {
      sources[b.path] = { packPath: pack.path, packLabel: pack.label, ts: ts };
    });
    _saveSources(sources);
  }

  // ── 删除操作 ────────────────────────────────────────────────────────

  function deletePack(pack, onDone) {
    if (!('caches' in win)) { if (onDone) onDone(); return; }
    var sources = _loadSources();
    var pathsToDelete = (pack.books || []).filter(function (b) {
      var rec = sources[b.path];
      return !rec || rec.packPath === pack.path;
    }).map(function (b) { return b.path; });
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.keys().then(function (keys) {
        var toDelete = keys.filter(function (req) {
          var p = new URL(req.url).pathname.replace(/^\/+/, '');
          return pathsToDelete.some(function (bp) {
            return p === bp + '/book.json' || p.startsWith(bp + '/');
          });
        });
        return Promise.all(toDelete.map(function (req) { return cache.delete(req); }));
      });
    }).then(function () {
      var newSources = _loadSources();
      pathsToDelete.forEach(function (bp) { delete newSources[bp]; });
      _saveSources(newSources);
      if (onDone) onDone();
    }).catch(function () { if (onDone) onDone(); });
  }

  function deleteBook(bookPath, onDone) {
    if (!('caches' in win)) { if (onDone) onDone(); return; }
    var prefix = '/' + bookPath + '/';
    var namedName = 'bk-' + bookPath;
    var p1 = caches.has(namedName).then(function (exists) {
      if (exists) return caches.delete(namedName);
    }).catch(function () {});
    var p2 = caches.open(CACHE_NAME).then(function (cache) {
      return cache.keys().then(function (keys) {
        var toDelete = keys.filter(function (req) {
          var p = new URL(req.url).pathname;
          return p === prefix || p.startsWith(prefix);
        });
        return Promise.all(toDelete.map(function (req) { return cache.delete(req); }));
      });
    }).catch(function () {});
    Promise.all([p1, p2])
      .then(function () { if (onDone) onDone(); })
      .catch(function () { if (onDone) onDone(); });
  }

  // ── 下载资源包（ZIP 解压到 Cache Storage）──────────────────────────

  function downloadPack(pack, onProgress, onDone) {
    if (!('caches' in win)) { if (onDone) onDone(new Error('不支持缓存')); return; }
    if (!win.JSZip) { if (onDone) onDone(new Error('JSZip 未加载')); return; }

    var servers = (win.BK_SERVERS && win.BK_SERVERS.cloudflare) || [];
    var urls = servers.map(function (s) { return s.replace(/\/$/, '') + '/' + pack.path; });
    urls.push(getRoot() + pack.path);

    function tryDownload(idx) {
      if (idx >= urls.length) {
        if (onDone) onDone(new Error('所有下载源均失败'));
        return;
      }
      var url = urls[idx];
      if (onProgress) onProgress('正在下载 ' + pack.label + '...');

      fetch(url, { cache: 'no-cache' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        })
        .then(function (buf) {
          if (onProgress) onProgress('正在解压...');
          return win.JSZip.loadAsync(buf);
        })
        .then(function (zip) {
          if (onProgress) onProgress('正在缓存...');
          return caches.open(CACHE_NAME).then(function (cache) {
            var entries = [];
            zip.forEach(function (relPath, file) {
              if (file.dir) return;
              entries.push({ relPath: relPath, file: file });
            });

            var chain = Promise.resolve();
            entries.forEach(function (entry) {
              chain = chain.then(function () {
                return entry.file.async('blob').then(function (blob) {
                  var resp = new Response(blob, {
                    headers: { 'Content-Type': _guessMime(entry.relPath) }
                  });
                  var cacheUrl = entryToUrl(entry.relPath);
                  return cache.put(new Request(cacheUrl), resp);
                });
              });
            });
            return chain;
          });
        })
        .then(function () {
          _markPackSources(pack);
          if (onProgress) onProgress('✓ ' + pack.label + ' 下载完成');
          if (onDone) onDone();
        })
        .catch(function (err) {
          tryDownload(idx + 1);
        });
    }

    tryDownload(0);
  }

  function _guessMime(path) {
    if (/\.json$/.test(path)) return 'application/json';
    if (/\.html?$/.test(path)) return 'text/html';
    if (/\.css$/.test(path)) return 'text/css';
    if (/\.js$/.test(path)) return 'application/javascript';
    if (/\.png$/.test(path)) return 'image/png';
    if (/\.jpe?g$/.test(path)) return 'image/jpeg';
    if (/\.svg$/.test(path)) return 'image/svg+xml';
    return 'application/octet-stream';
  }

  // ── 资源包列表弹框 ──────────────────────────────────────────────────

  var BKResourcePack = {

    showPacksDialog: function () {
      if (!win.BK || !win.BK.openDialog) return;

      var dlg = win.BK.openDialog({
        id: 'bk-resource-packs',
        html: '<div class="bk-dialog" style="width:min(400px,calc(100vw - 40px))">' +
          '<div class="bk-dialog-title">📦 书籍资源包</div>' +
          '<div class="bk-rp-list-body" id="bkRpListBody">' +
            '<div class="bk-loading"><div class="bk-spinner"></div>加载中...</div>' +
          '</div>' +
          '<div class="bk-dialog-actions">' +
            '<button class="bk-dialog-cancel" data-action="close" style="flex:1">关闭</button>' +
          '</div>' +
          '</div>'
      });

      if (!dlg) return;

      var dialogEl = document.getElementById('bk-resource-packs');
      if (!dialogEl) return;

      dialogEl.addEventListener('click', function (e) {
        if (e.target.getAttribute('data-action') === 'close') dlg.close();
      });

      fetchManifest().then(function (manifest) {
        var packs = manifest.packs || [];
        var body = document.getElementById('bkRpListBody');
        if (!body) return;

        if (!packs.length) {
          body.innerHTML = '<div class="bk-rp-empty">暂无可用资源包</div>';
          return;
        }

        var html = '';
        var checkPromises = [];
        packs.forEach(function (pack, idx) {
          checkPromises.push(
            isPackCached(pack).then(function (cached) {
              var statusText = cached ? '✓ 已下载' : '下载';
              var statusClass = cached ? 'bk-rp-downloaded' : 'bk-rp-download';
              html += '<div class="bk-rp-item" data-idx="' + idx + '">' +
                '<div class="bk-rp-item-info">' +
                  '<div class="bk-rp-item-label">' + escHtml(pack.label) + '</div>' +
                  '<div class="bk-rp-item-meta">' +
                    (pack.book_count || (pack.books || []).length) + ' 本书' +
                    (pack.size ? ' · ' + fmtSize(pack.size) : '') +
                  '</div>' +
                '</div>' +
                '<button class="bk-rp-btn ' + statusClass + '" data-action="' + (cached ? 'delete' : 'download') + '" data-idx="' + idx + '">' +
                  statusText +
                '</button>' +
                '</div>';
            })
          );
        });

        Promise.all(checkPromises).then(function () {
          body.innerHTML = html;

          // 事件委托
          body.addEventListener('click', function (e) {
            var btn = e.target.closest('.bk-rp-btn');
            if (!btn) return;
            var idx = parseInt(btn.getAttribute('data-idx'), 10);
            var pack = packs[idx];
            if (!pack) return;

            var action = btn.getAttribute('data-action');
            if (action === 'download') {
              btn.disabled = true;
              btn.textContent = '⏳';
              downloadPack(pack, function (msg) {
                btn.textContent = msg;
              }, function (err) {
                btn.disabled = false;
                if (err) {
                  btn.textContent = '下载失败';
                } else {
                  btn.textContent = '✓ 已下载';
                  btn.className = 'bk-rp-btn bk-rp-downloaded';
                  btn.setAttribute('data-action', 'delete');
                }
              });
            } else if (action === 'delete') {
              if (!confirm('确定删除资源包 "' + pack.label + '" 的缓存？')) return;
              btn.disabled = true;
              btn.textContent = '⏳';
              deletePack(pack, function () {
                btn.disabled = false;
                btn.textContent = '下载';
                btn.className = 'bk-rp-btn bk-rp-download';
                btn.setAttribute('data-action', 'download');
              });
            }
          });
        });
      }).catch(function (err) {
        var body = document.getElementById('bkRpListBody');
        if (body) body.innerHTML = '<div class="bk-rp-error">加载失败: ' + escHtml(err.message) + '</div>';
      });
    },

    showCachedDialog: function () {
      // 已缓存书籍管理 - 列出 bk-main 缓存中的书籍
      if (!win.BK || !win.BK.openDialog) return;

      var dlg = win.BK.openDialog({
        id: 'bk-cached-books',
        html: '<div class="bk-dialog" style="width:min(400px,calc(100vw - 40px))">' +
          '<div class="bk-drawer-header">' +
            '<div class="bk-drawer-title">已缓存</div>' +
            '<button class="bk-drawer-close" data-action="close" aria-label="关闭">×</button>' +
          '</div>' +
          '<div class="bk-rp-list-body" id="bkCachedBody">' +
            '<div class="bk-loading"><div class="bk-spinner"></div>扫描中...</div>' +
          '</div>' +
          '</div>'
      });

      if (!dlg) return;

      var dialogEl = document.getElementById('bk-cached-books');
      if (!dialogEl) return;

      dialogEl.addEventListener('click', function (e) {
        if (e.target.getAttribute('data-action') === 'close') dlg.close();
      });

      if (!('caches' in win)) {
        var body = document.getElementById('bkCachedBody');
        if (body) body.innerHTML = '<div class="bk-rp-empty">不支持缓存</div>';
        return;
      }

      caches.open(CACHE_NAME).then(function (cache) {
        return cache.keys().then(function (reqs) {
          var bookPaths = {};
          reqs.forEach(function (req) {
            var m = new URL(req.url).pathname.match(/\/([^/]+)\/book\.json$/);
            if (m) bookPaths[m[1]] = true;
          });

          var paths = Object.keys(bookPaths);
          var body = document.getElementById('bkCachedBody');
          if (!body) return;

          if (!paths.length) {
            body.innerHTML = '<div class="bk-rp-empty">暂无缓存书籍</div>';
            return;
          }

          var html = '';
          paths.forEach(function (p) {
          html += '<div class="bk-rp-item" data-path="' + escAttr(p) + '">' +
            '<div class="bk-rp-item-info">' +
              '<div class="bk-rp-item-label">' + escHtml(p) + '</div>' +
              '<div class="bk-rp-item-meta">已缓存 · 点击「删除」清除离线副本</div>' +
            '</div>' +
            '<button class="bk-rp-btn bk-rp-delete" data-action="del-book" data-path="' + escAttr(p) + '">删除</button>' +
            '</div>';
          });

          body.innerHTML = html;

          body.addEventListener('click', function (e) {
            var btn = e.target.closest('[data-action="del-book"]');
            if (!btn) return;
            var path = btn.getAttribute('data-path');
            if (!confirm('确定删除 "' + path + '" 的缓存？')) return;
            btn.disabled = true;
            btn.textContent = '⏳';
            deleteBook(path, function () {
              var item = btn.closest('.bk-rp-item');
              if (item && item.parentNode) item.parentNode.removeChild(item);
              var remaining = body.querySelectorAll('.bk-rp-item');
              if (!remaining.length) {
                body.innerHTML = '<div class="bk-rp-empty">暂无缓存书籍</div>';
              }
            });
          });
        });
      });
    }
  };

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

    function formatSize(bytes) {
      if (!bytes) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

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
    function refreshDownloadedSet() {
      wd._downloadedSet = wd._downloadedSet || {};
      if (!wd.config || !win.ImportManager || !win.ImportManager.getImportedBooks) return Promise.resolve();
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
      try {
        var u = new URL(wd.path);
        var p = u.pathname.replace(/^\/+/, '');
        return p || '根目录';
      } catch (e) {
        return wd.path.split('/').pop() || wd.path;
      }
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
      el.textContent = msg;
    }
    // 连接成功后提示所选最快节点（仅多域名时）
    function showConnectedNode(res) {
      if (!res || !res.config) return;
      var cfg = res.config;
      if (cfg.multiNode && cfg.connectedUrl) {
        var host = cfg.connectedUrl.replace(/^https?:\/\//, '').split('/')[0];
        showStatus('已连接 · 最快节点：' + host + (cfg.connectMs ? '（' + cfg.connectMs + 'ms）' : ''));
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
        wdView.innerHTML = '<div class="bk-webdav-connecting"><div class="bk-spinner"></div>连接中…</div>';
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
      if (!wd.entries.length) {
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
              '<span class="bk-webdav-size">' + fmtSize(en.size) + '</span>' +
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
          '<span class="bk-webdav-path">' + escHtml(displayPath()) + '</span>' +
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
        wd.mode = 'connecting';
        wd._usingSavedId = active.id;
        renderWebdav();
        win.WebDavManager.listDir(active, '').then(function (entries) {
          wd.config = active; wd.path = ''; wd.entries = entries; wd.selected = {}; wd.mode = 'browsing';
          refreshDownloadedSet().then(function () { renderWebdav(); });
        }).catch(function (err) {
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
      var connBtn = dialogEl.querySelector('[data-action="wd-connect"]');
      if (connBtn) { connBtn.disabled = true; connBtn.textContent = '连接中…'; }
      win.WebDavManager.connect(cfg, { save: readSaveChecked() && !isPreset }).then(function (res) {
        wd.locked = false;
        if (connBtn) { connBtn.disabled = false; connBtn.textContent = '连接'; }
        wd.config = res.config; wd.path = ''; wd.entries = res.entries; wd.selected = {}; wd.mode = 'browsing';
        wd._usingSavedId = res.config.id;
        refreshDownloadedSet().then(function () { renderWebdav(); showConnectedNode(res); });
      }).catch(function (err) {
        wd.locked = false;
        if (connBtn) { connBtn.disabled = false; connBtn.textContent = '连接'; }
        setWdError(err);
      });
    }

    function wdOpenDir(path) {
      if (!wd.config || !path) return;
      wd.locked = true;
      win.WebDavManager.listDir(wd.config, path).then(function (entries) {
        wd.path = path; wd.entries = entries; wd.selected = {}; wd.mode = 'browsing'; wd.locked = false;
        refreshDownloadedSet().then(function () { renderWebdav(); });
      }).catch(function (err) {
        wd.locked = false; setWdError(err);
      });
    }

    function wdNavUp() {
      if (!wd.config || wd.path === '') return;
      wdOpenDir(parentUrl(wd.path));
    }

    function wdDisconnect() {
      wd.mode = 'disconnected'; wd.config = null; wd.path = ''; wd.entries = []; wd.selected = {}; wd._usingSavedId = null;
      renderWebdav();
    }

    // 顺序下载（并发 1），失败单本继续
    function downloadAndImport(entries) {
      if (!wd.config || !entries.length || wd.locked) return;
      wd.locked = true;
      // 下载前先刷新「已下载集合」，保证去重判断基于最新记录
      refreshDownloadedSet().then(function () {
        var done = 0, updated = 0, failed = 0;
        function next(i) {
          if (i >= entries.length) {
            wd.locked = false;
            wd.selected = {};   // 清空选择
            var parts = ['导入完成：新导入 ' + done + ' 本'];
            if (updated) parts.push('更新 ' + updated + ' 本');
            if (failed) parts.push('失败 ' + failed + ' 本');
            showStatus(parts.join('，'));
            setTimeout(function () {
              var el = dialogEl.querySelector('#wdStatus');
              if (el) el.style.display = 'none';
            }, 4000);
            // 刷新书城/书架（导入已入架，renderHome 即书架）
            if (win.BKRenderer && win.BKRenderer.renderHome) {
              try { win.BKRenderer.renderHome(); } catch (e) {}
            }
            // 重渲染浏览器：更新「已下载」标记
            refreshDownloadedSet().then(function () { renderWebdav(); });
            return;
          }
          var entry = entries[i];
          var existingId = (wd._downloadedSet && wd._downloadedSet[entry.remotePath]) || null;
          showStatus('下载中 (' + (i + 1) + '/' + entries.length + ')：' + entry.name + (existingId ? '（已存在，更新中）' : ''));
          setItemProgress(entry.remotePath, 0, true);
          win.WebDavManager.downloadFile(wd.config, entry, function (p) {
            if (p >= 0) setItemProgress(entry.remotePath, p, true);
          }).then(function (fileInfo) {
            var source = {
              type: 'webdav',
              serverId: wd.config.id,
              remotePath: entry.remotePath,
              serverName: wd.config.name || wd.config.url
            };
            // 已下载过则复用原 id（resync/覆盖写），避免重复书
            return win.ImportManager.importFromBuffer(fileInfo, { source: source, bookId: existingId || undefined });
          }).then(function () {
            if (existingId) updated++; else done++;
            setItemProgress(entry.remotePath, 1, false);
            next(i + 1);
          }).catch(function (err) {
            failed++;
            setItemProgress(entry.remotePath, -1, false);
            showStatus('失败：' + entry.name + ' — ' + (err && err.message ? err.message : String(err)));
            next(i + 1);
          });
        }
        next(0);
      });
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
      if (wd.locked) return; // 下载中禁止其它操作
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
      if (t.getAttribute && t.getAttribute('data-action') === 'close') { dlg.close(); return; }

      // 来源卡片切换
      var card = t.closest ? t.closest('.bk-source-card') : null;
      if (card) {
        var source = card.getAttribute('data-source');
        showSource(source);
        if (source === 'webdav') initWebdav();
        return;
      }

      var actionAttr = t.getAttribute && t.getAttribute('data-action');
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
        var idx = parseInt(t.getAttribute('data-idx'), 10);
        if (!isNaN(idx)) { fileChecked[idx] = t.checked; renderFileList(); }
        return;
      }

      // WebDAV 动作（data-action 以 wd- 开头）
      if (actionAttr && actionAttr.indexOf('wd-') === 0) {
        handleWdAction(actionAttr, t);
        return;
      }
    });

    dialogEl.addEventListener('change', function (e) {
      if (wd.locked) return;
      var t = e.target;
      var actionAttr = t.getAttribute && t.getAttribute('data-action');
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

}(window));
