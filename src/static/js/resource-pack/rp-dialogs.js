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
