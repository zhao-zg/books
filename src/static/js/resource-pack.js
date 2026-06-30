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
          '<div class="bk-dialog-title">💾 已缓存书籍</div>' +
          '<div class="bk-rp-list-body" id="bkCachedBody">' +
            '<div class="bk-loading"><div class="bk-spinner"></div>扫描中...</div>' +
          '</div>' +
          '<div class="bk-dialog-actions">' +
            '<button class="bk-dialog-cancel" data-action="close" style="flex:1">关闭</button>' +
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

  win.BKResourcePack = BKResourcePack;

}(window));
