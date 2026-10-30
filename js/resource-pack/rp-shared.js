/*!
 * resource-pack.js — 书籍资源包下载管理
 *
 * 暴露：window.BKResourcePack
 *   .showPacksDialog()    打开资源包下载弹层
 *   .showCachedDialog()   打开已缓存书籍管理弹层
 *   .isPackCached(pack)   → Promise<boolean>
 */
  'use strict';
  var win = window;

  var CACHE_NAME = 'rp-data';
  var SOURCES_KEY = 'bk_pack_sources';

  function getRoot() {
    return win.BK_ROOT || './';
  }

  function entryToUrl(entryName) {
    var clean = entryName.replace(/^\/+/, '');
    return win.location.origin + '/' + clean;
  }

  // fmtSize 已移除——统一使用 dm-shared.js 的全局 formatSize（加载顺序：dm-shared 先于 rp-* 执行）

  function escHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escAttr(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  // ── 旧缓存迁移 ────────────────────────────────────────────────────
  // 将 bk-main 中的资源包数据迁移到 rp-data，避免被 SW activate 误删。
  // 迁移完成后自动删除 bk-main。仅执行一次（rp-data 存在时跳过）。
  function _migrateOldCache() {
    if (!('caches' in win)) return;
    caches.has(CACHE_NAME).then(function(hasNew) {
      if (hasNew) return;
      caches.has('bk-main').then(function(hasOld) {
        if (!hasOld) return;
        caches.open('bk-main').then(function(oldCache) {
          oldCache.keys().then(function(reqs) {
            if (!reqs.length) return caches.delete('bk-main');
            caches.open(CACHE_NAME).then(function(newCache) {
              Promise.all(reqs.map(function(req) {
                return oldCache.match(req).then(function(resp) {
                  if (resp) return newCache.put(req, resp);
                });
              })).then(function() { caches.delete('bk-main'); });
            });
          });
        });
      });
    }).catch(function() {});
  }
  _migrateOldCache();

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
      if (idx >= urls.length) {
        // ★ 所有服务器均失败：清理竞速缓存，下次请求重新竞速
        if (win.BK && win.BK.RaceFastest) {
          win.BK.RaceFastest.invalidateVersion();
        }
        return Promise.reject(new Error('无法获取资源包清单'));
      }
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
          // ★ 所有下载源均失败：清理竞速缓存，下次请求重新竞速
          if (win.BK && win.BK.RaceFastest) {
            win.BK.RaceFastest.invalidateVersion();
          }
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
