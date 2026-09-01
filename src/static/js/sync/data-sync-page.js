/**
 * data-sync-page.js — 「数据与同步」全屏中心页（BK.DataSyncPage）
 *
 * 四区块结构（设计文档 docs/plans/2026-09-01-data-sync-center-design.md 第 4 节）：
 *   1. 导出区：仅数据 / 完整包 两按钮 → BK.SyncCore.exportData('data'|'full')
 *   2. 导入区：选 ZIP → BK.SyncCore.importFromZip（旧包 v1/v2/v3 直接报错）
 *   3. WebDAV 区：配置管理 + 增量同步状态 + 立即同步 + 从 WebDAV 导入书 + 上传书
 *   4. 局域网区：入口按钮 → BK.LanSyncPanel.show()（复用现有面板，不重做 UI）
 *
 * 依赖（均在前序 defer 加载；运行时守卫访问，不在此处做模块级求值）：
 *   - BK.SyncCore               (sync-core.js)
 *   - BK.SyncWebDAVTrigger      (sync-webdav-trigger.js)
 *   - WebDavManager             (webdav-manager.js)
 *   - BK.WebDavUpload           (webdav-upload.js)
 *   - BK.WebDavConfig           (webdav-config.js，仅读配置展示)
 *   - BK.LanSyncPanel           (lan-sync-panel.js)
 *
 * 挂载：window.BK.DataSyncPage
 *   .show() / .hide()
 *   纯函数（供单测）：formatImportResult / formatImportErrors / syncStateText /
 *                    formatSyncTime / formatSize
 *
 * 样式：css-data-sync.css（Soft Nordic 暖调，对齐 lan-sync 面板 token）
 */
(function (win) {
    'use strict';

    var panelEl = null;

    // ── 纯函数（供单测与 UI 复用）──────────────────────────────────────

    /**
     * 导入结果 → 摘要文案
     * @param {{success:number, skipped:number, failed:number}|null} result
     * @returns {string}
     */
    function formatImportResult(result) {
        if (!result) return '导入完成';
        var parts = [];
        if (result.success) parts.push('成功导入 ' + result.success + ' 本');
        if (result.skipped) parts.push('跳过 ' + result.skipped + ' 本');
        if (result.failed) parts.push('失败 ' + result.failed + ' 本');
        return parts.length ? parts.join('，') : '导入完成';
    }

    /**
     * 失败明细 → 行数组（最多前 5 条，可选汇总行）
     * @param {Array<{id:string, error:string}>|null} errors
     * @param {boolean} [withSummary]  超过 5 条时追加「…等 N 项失败」
     * @returns {string[]}
     */
    function formatImportErrors(errors, withSummary) {
        if (!Array.isArray(errors) || !errors.length) return [];
        var lines = [];
        var max = Math.min(errors.length, 5);
        for (var i = 0; i < max; i++) {
            var e = errors[i] || {};
            var id = e.id || '';
            var msg = e.error || '未知错误';
            lines.push(id ? id + ': ' + msg : msg);
        }
        if (withSummary && errors.length > 5) {
            lines.push('…等 ' + errors.length + ' 项失败');
        }
        return lines;
    }

    /**
     * 时间戳 → 'YYYY-MM-DD HH:mm'（无效输入返回空串）
     * @param {number|null} ts
     * @returns {string}
     */
    function formatSyncTime(ts) {
        if (!ts || isNaN(ts)) return '';
        var d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        function p2(n) { return ('0' + n).slice(-2); }
        return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
            ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    }

    /**
     * 字节数 → 可读大小
     * @param {number|null} bytes
     * @returns {string}
     */
    function formatSize(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        var units = ['B', 'KB', 'MB', 'GB'];
        var i = 0, size = bytes;
        while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
        return size.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
    }

    /**
     * WebDAV 同步状态 → 状态行文案
     * @param {{running:boolean, lastSyncTs:number|null, lastResult:Object|null, lastError:string|null}|null} state
     * @param {boolean} hasConfig  是否已配置 WebDAV
     * @returns {string}
     */
    function syncStateText(state, hasConfig) {
        state = state || {};
        if (state.running) return '同步中…';
        if (!hasConfig) return '未配置 WebDAV 服务器，无法同步';
        if (state.lastError) return '上次同步失败：' + state.lastError;
        if (state.lastResult) {
            var r = state.lastResult;
            var t = formatSyncTime(state.lastSyncTs);
            var counts = '拉取 ' + (r.pulled || 0) + ' · 推送 ' + (r.pushed || 0);
            return '上次同步 ' + t + '，' + counts;
        }
        return '尚未同步过';
    }

    // ── 面板骨架 ──────────────────────────────────────────────────────

    function _ensurePanel() {
        panelEl = document.getElementById('data-sync-page');
        if (!panelEl) {
            panelEl = document.createElement('div');
            panelEl.id = 'data-sync-page';
            panelEl.className = 'dsc-overlay';
            panelEl.style.display = 'none';
            document.body.appendChild(panelEl);
        }
    }

    function show() {
        _ensurePanel();
        _render();
        panelEl.style.display = '';
        _refreshSyncState();
    }

    function hide() {
        _unsubscribeSyncState();
        if (panelEl) panelEl.style.display = 'none';
    }

    // ── 区块渲染 ──────────────────────────────────────────────────────

    function _render() {
        if (!panelEl) return;

        panelEl.innerHTML =
            '<div class="dsc-panel">' +
            '  <div class="dsc-header">' +
            '    <button class="dsc-back" aria-label="返回">←</button>' +
            '    <span class="dsc-title">数据与同步</span>' +
            '  </div>' +
            '  <div class="dsc-body">' +
            '    <div class="dsc-tip">导出数据包可在其他设备导入；WebDAV 同步保持多设备阅读进度一致。</div>' +

            // ── 区块 1：导出 ──
            '    <div class="dsc-section">' +
            '      <div class="dsc-section-title">导出</div>' +
            '      <div class="dsc-card">' +
            '        <div class="dsc-row">' +
            '          <div class="dsc-row-main">' +
            '            <div class="dsc-row-title">仅阅读数据</div>' +
            '            <div class="dsc-row-desc">进度 · 书签 · 划线 · 元数据</div>' +
            '          </div>' +
            '          <button class="dsc-btn" data-action="export-data">导出</button>' +
            '        </div>' +
            '        <div class="dsc-divider"></div>' +
            '        <div class="dsc-row">' +
            '          <div class="dsc-row-main">' +
            '            <div class="dsc-row-title">完整数据包</div>' +
            '            <div class="dsc-row-desc">连同书籍文件一起（体积较大）</div>' +
            '          </div>' +
            '          <button class="dsc-btn" data-action="export-full">导出</button>' +
            '        </div>' +
            '      </div>' +
            '    </div>' +

            // ── 区块 2：导入 ──
            '    <div class="dsc-section">' +
            '      <div class="dsc-section-title">导入</div>' +
            '      <div class="dsc-card">' +
            '        <div class="dsc-row">' +
            '          <div class="dsc-row-main">' +
            '            <div class="dsc-row-title">从 ZIP 文件导入</div>' +
            '            <div class="dsc-row-desc">支持 v4 格式数据包，旧版本包需重新导出</div>' +
            '          </div>' +
            '          <button class="dsc-btn" data-action="import-zip">选择文件</button>' +
            '        </div>' +
            '        <div class="dsc-import-result" id="dscImportResult"></div>' +
            '      </div>' +
            '    </div>' +

            // ── 区块 3：WebDAV ──
            '    <div class="dsc-section">' +
            '      <div class="dsc-section-title">WebDAV 同步</div>' +
            '      <div class="dsc-card">' +
            '        <div id="dscWebdavConfig"></div>' +
            '        <div class="dsc-divider"></div>' +
            '        <div class="dsc-row">' +
            '          <div class="dsc-row-main">' +
            '            <div class="dsc-row-title">增量同步</div>' +
            '            <div class="dsc-row-desc" id="dscSyncState">尚未同步过</div>' +
            '          </div>' +
            '          <button class="dsc-btn" data-action="sync-now">立即同步</button>' +
            '        </div>' +
            '        <div class="dsc-divider"></div>' +
            '        <div class="dsc-row">' +
            '          <div class="dsc-row-main">' +
            '            <div class="dsc-row-title">从 WebDAV 导入书</div>' +
            '            <div class="dsc-row-desc" id="dscWebdavBooksDesc">浏览远端已同步的书籍</div>' +
            '          </div>' +
            '          <button class="dsc-btn" data-action="webdav-import">浏览</button>' +
            '        </div>' +
            '        <div class="dsc-divider"></div>' +
            '        <div class="dsc-row">' +
            '          <div class="dsc-row-main">' +
            '            <div class="dsc-row-title">上传书到 WebDAV</div>' +
            '            <div class="dsc-row-desc">将书架上的书上传到服务器</div>' +
            '          </div>' +
            '          <button class="dsc-btn" data-action="webdav-upload">上传</button>' +
            '        </div>' +
            '      </div>' +
            '    </div>' +

            // ── 区块 4：局域网 ──
            '    <div class="dsc-section">' +
            '      <div class="dsc-section-title">局域网同步</div>' +
            '      <div class="dsc-card">' +
            '        <div class="dsc-row">' +
            '          <div class="dsc-row-main">' +
            '            <div class="dsc-row-title">设备间直连</div>' +
            '            <div class="dsc-row-desc">同一 WiFi 下互传书籍与进度，无需服务器</div>' +
            '          </div>' +
            '          <button class="dsc-btn" data-action="lan-sync">打开</button>' +
            '        </div>' +
            '      </div>' +
            '    </div>' +

            '  </div>' +
            '</div>';

        _renderWebdavConfig();
        _bindEvents();
    }

    /** WebDAV 配置区（服务器下拉 + 管理） */
    function _renderWebdavConfig() {
        var holder = panelEl.querySelector('#dscWebdavConfig');
        if (!holder) return;

        var configs = [];
        var activeId = null;
        try {
            if (win.WebDavManager && typeof win.WebDavManager.getAllConfigs === 'function') {
                configs = win.WebDavManager.getAllConfigs() || [];
                var active = win.WebDavManager.getActiveConfig ? win.WebDavManager.getActiveConfig() : null;
                activeId = active ? active.id : null;
            }
        } catch (e) { /* 配置读取失败 → 空列表 */ }

        if (!configs.length) {
            holder.innerHTML =
                '<div class="dsc-row">' +
                '  <div class="dsc-row-main">' +
                '    <div class="dsc-row-title">未配置服务器</div>' +
                '    <div class="dsc-row-desc">上传或浏览时可添加服务器</div>' +
                '  </div>' +
                '</div>';
            return;
        }

        var options = '';
        for (var i = 0; i < configs.length; i++) {
            var c = configs[i];
            var label = (c.preset ? '★ ' : '') + (c.name || c.url);
            var sel = (c.id === activeId) ? ' selected' : '';
            options += '<option value="' + _esc(c.id) + '"' + sel + '>' + _esc(label) + '</option>';
        }

        holder.innerHTML =
            '<div class="dsc-row">' +
            '  <div class="dsc-row-main">' +
            '    <div class="dsc-row-title">同步服务器</div>' +
            '    <div class="dsc-row-desc">选中后用于增量同步与导入</div>' +
            '  </div>' +
            '</div>' +
            '<div class="dsc-select-wrap">' +
            '  <select class="dsc-select" id="dscWebdavSelect">' + options + '</select>' +
            '</div>';
    }

    // ── 事件绑定 ──────────────────────────────────────────────────────

    function _bindEvents() {
        if (!panelEl) return;

        var backBtn = panelEl.querySelector('.dsc-back');
        if (backBtn) backBtn.onclick = function () { hide(); };

        var btns = panelEl.querySelectorAll('[data-action]');
        for (var i = 0; i < btns.length; i++) {
            btns[i].onclick = function (e) {
                var action = e.currentTarget.getAttribute('data-action');
                _handleAction(action, e.currentTarget);
            };
        }

        var select = panelEl.querySelector('#dscWebdavSelect');
        if (select) select.onchange = function (e) {
            var id = e.target.value;
            try {
                if (win.WebDavManager && win.WebDavManager.setActiveConfig) {
                    win.WebDavManager.setActiveConfig(id);
                    _toast('已切换同步服务器');
                    _refreshSyncState();
                }
            } catch (err) { _toast('切换失败：' + (err.message || err)); }
        };
    }

    function _handleAction(action, btn) {
        switch (action) {
            case 'export-data': return _handleExport('data', btn);
            case 'export-full': return _handleExport('full', btn);
            case 'import-zip': return _handleImportZip();
            case 'sync-now': return _handleSyncNow(btn);
            case 'webdav-import': return _handleWebdavImport();
            case 'webdav-upload': return _handleWebdavUpload();
            case 'lan-sync': return _handleLanSync();
        }
    }

    // ── 区块 1：导出 ──────────────────────────────────────────────────

    function _handleExport(mode, btn) {
        if (!win.BK || !win.BK.SyncCore || !win.BK.SyncCore.exportData) {
            _toast('导出功能未就绪');
            return;
        }
        var busy = mode === 'full' ? '正在导出完整包…' : '正在导出…';
        _setBtnBusy(btn, true, busy);
        win.BK.SyncCore.exportData(mode).then(function (r) {
            _toast(mode === 'full' ? '已导出完整数据包' : '已导出同步数据');
        }).catch(function (err) {
            _toast('导出失败：' + (err && err.message ? err.message : err));
        }).finally(function () {
            _setBtnBusy(btn, false);
        });
    }

    function _setBtnBusy(btn, busy, text) {
        if (!btn) return;
        if (busy) {
            btn.disabled = true;
            btn.dataset.origText = btn.textContent;
            btn.textContent = text || '处理中…';
        } else {
            btn.disabled = false;
            if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
        }
    }

    // ── 区块 2：导入 ──────────────────────────────────────────────────

    function _handleImportZip() {
        if (!win.BK || !win.BK.SyncCore || !win.BK.SyncCore.importFromZip) {
            _toast('导入功能未就绪');
            return;
        }
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip,application/zip';
        input.style.display = 'none';
        input.onchange = function () {
            var file = input.files && input.files[0];
            if (input.parentNode) input.parentNode.removeChild(input);
            if (!file) return;
            _runImport(file);
        };
        document.body.appendChild(input);
        input.click();
    }

    function _runImport(file) {
        var holder = panelEl.querySelector('#dscImportResult');
        _setImportResult(holder, '正在导入《' + file.name + '》…', 'pending');

        win.BK.SyncCore.importFromZip(file).then(function (result) {
            var summary = formatImportResult(result);
            var errs = (result && result.failed) ? formatImportErrors(result.errors, true) : [];
            var cls = result && result.failed ? 'partial' : 'ok';
            _setImportResult(holder, summary, cls, errs);
            _toast(summary);
        }).catch(function (err) {
            // 旧包（v1/v2/v3）与损坏包：错误文案原样展示
            var msg = (err && err.message) ? err.message : String(err);
            _setImportResult(holder, '导入失败：' + msg, 'fail', [msg]);
        });
    }

    function _setImportResult(holder, text, cls, lines) {
        if (!holder) return;
        var html = '<div class="dsc-import-msg ' + (cls ? 'dsc-import-' + cls : '') + '">' + _esc(text) + '</div>';
        if (lines && lines.length) {
            html += '<div class="dsc-import-errors">';
            for (var i = 0; i < lines.length; i++) {
                html += '<div class="dsc-import-error-line">' + _esc(lines[i]) + '</div>';
            }
            html += '</div>';
        }
        holder.innerHTML = html;
    }

    // ── 区块 3：WebDAV 同步 ───────────────────────────────────────────

    function _handleSyncNow(btn) {
        var T = win.BK && win.BK.SyncWebDAVTrigger;
        if (!T || typeof T.runSync !== 'function') {
            _toast('同步功能未就绪');
            return;
        }
        var config = _getActiveWebdavConfig();
        if (!config) {
            _toast('请先配置 WebDAV 服务器');
            return;
        }
        if (btn) {
            _setBtnBusy(btn, true, '同步中…');
        }
        T.runSync().then(function () {
            // 状态行由订阅回调更新；此处只提示完成
        }).catch(function (err) {
            _toast('同步失败：' + (err && err.message ? err.message : err));
        }).finally(function () {
            if (btn) _setBtnBusy(btn, false);
        });
    }

    /** 读激活 WebDAV 配置（未配置返回 null） */
    function _getActiveWebdavConfig() {
        try {
            if (win.WebDavManager && typeof win.WebDavManager.getActiveConfig === 'function') {
                return win.WebDavManager.getActiveConfig() || null;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    /** 订阅同步状态（幂等：先退订旧订阅） */
    var _unsubSyncState = null;

    function _refreshSyncState() {
        var T = win.BK && win.BK.SyncWebDAVTrigger;
        var hasConfig = !!_getActiveWebdavConfig();

        // 初始快照
        var state = null;
        if (T && typeof T.getSyncState === 'function') {
            state = T.getSyncState();
        }
        _renderSyncState(state, hasConfig);

        // 订阅后续变化（无订阅回放语义，初始靠上面 getSyncState）
        if (!T || typeof T.onSyncStateChange !== 'function') return;
        _unsubscribeSyncState();
        _unsubSyncState = T.onSyncStateChange(function (st) {
            _renderSyncState(st, !!_getActiveWebdavConfig());
            // 同步结束（running false）时刷新「立即同步」按钮
            if (!st.running) {
                var btn = panelEl && panelEl.querySelector('[data-action="sync-now"]');
                if (btn) _setBtnBusy(btn, false);
            }
        });
    }

    function _unsubscribeSyncState() {
        if (_unsubSyncState) {
            try { _unsubSyncState(); } catch (e) { /* ignore */ }
            _unsubSyncState = null;
        }
    }

    function _renderSyncState(state, hasConfig) {
        var el = panelEl && panelEl.querySelector('#dscSyncState');
        if (!el) return;
        el.textContent = syncStateText(state, hasConfig);
    }

    /** 「从 WebDAV 导入书」：列出 bk-sync 远端 ZIP → 逐本导入 */
    function _handleWebdavImport() {
        var config = _getActiveWebdavConfig();
        if (!config) { _toast('请先配置 WebDAV 服务器'); return; }
        if (!win.WebDavManager || typeof win.WebDavManager.listDir !== 'function') {
            _toast('WebDAV 功能未就绪');
            return;
        }
        var REMOTE_DIR = (win.BK && win.BK.SyncWebDAV && win.BK.SyncWebDAV.REMOTE_DIR) || 'bk-sync';
        var desc = panelEl.querySelector('#dscWebdavBooksDesc');
        if (desc) desc.textContent = '正在读取远端目录…';

        win.WebDavManager.listDir(config, REMOTE_DIR).then(function (entries) {
            var zips = [];
            for (var i = 0; i < entries.length; i++) {
                var en = entries[i];
                if (!en.isDir && en.name && /\.zip$/i.test(en.name)) zips.push(en);
            }
            if (!zips.length) {
                if (desc) desc.textContent = '远端没有可导入的书籍';
                _toast('远端 bk-sync 目录暂无书籍');
                return;
            }
            _importWebdavBooks(config, zips, desc);
        }).catch(function (err) {
            if (desc) desc.textContent = '浏览远端已同步的书籍';
            _toast('读取远端失败：' + (err && (err.hint || err.message) ? (err.hint || err.message) : err));
        });
    }

    function _importWebdavBooks(config, zips, desc) {
        var total = zips.length;
        var ok = 0, fail = 0;
        var chain = Promise.resolve();

        function _done() {
            if (desc) desc.textContent = '上次导入：成功 ' + ok + ' / ' + total + ' 本';
            _toast(ok === total ? '导入完成：' + ok + ' 本' : '导入完成：成功 ' + ok + ' 本，失败 ' + fail + ' 本');
        }

        zips.forEach(function (entry) {
            chain = chain.then(function () {
                if (desc) desc.textContent = '正在导入 ' + (ok + fail + 1) + '/' + total + '：' + entry.name;
                return win.WebDavManager.downloadFile(config, entry).then(function (info) {
                    var buffer = info && (info.arrayBuffer || info.text);
                    if (!buffer) throw new Error('下载失败：无内容');
                    return win.BK.SyncCore.importFromZip(buffer);
                }).then(function () {
                    ok++;
                }).catch(function () {
                    fail++;
                });
            });
        });
        chain.then(_done, _done);
    }

    /** 「上传书到 WebDAV」：复用 webdav-upload 上传对话框 */
    function _handleWebdavUpload() {
        if (!win.BK || !win.BK.WebDavUpload || !win.BK.WebDavUpload.showUploadDialog) {
            _toast('上传功能未就绪');
            return;
        }
        var ids = _allBookIds();
        if (!ids.length) {
            _toast('书架没有可上传的书');
            return;
        }
        win.BK.WebDavUpload.showUploadDialog(ids);
    }

    function _allBookIds() {
        var ids = [];
        try {
            if (win.BKShelf && typeof win.BKShelf.all === 'function') {
                var shelf = win.BKShelf.all();
                for (var i = 0; i < shelf.length; i++) {
                    var rec = shelf[i];
                    if (rec) {
                        var bid = rec.bookId || rec.id;
                        if (bid) ids.push(bid);
                    }
                }
            }
        } catch (e) { /* ignore */ }
        return ids;
    }

    // ── 区块 4：局域网 ────────────────────────────────────────────────

    function _handleLanSync() {
        if (win.BK && win.BK.LanSyncPanel && typeof win.BK.LanSyncPanel.show === 'function') {
            win.BK.LanSyncPanel.show();
        } else {
            _toast('局域网同步未就绪');
        }
    }

    // ── 工具 ──────────────────────────────────────────────────────────

    function _esc(s) {
        if (!s) return '';
        var div = document.createElement('div');
        div.textContent = String(s);
        return div.innerHTML;
    }

    var _toastTimer = null;
    function _toast(msg) {
        if (!msg) return;
        try {
            if (!document.getElementById('bk-dsc-toast-style')) {
                var st = document.createElement('style');
                st.id = 'bk-dsc-toast-style';
                st.textContent =
                    '.bk-dsc-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%) translateY(12px);' +
                    'background:rgba(26,25,24,.92);color:#fff;padding:10px 18px;border-radius:22px;' +
                    'font-size:14px;z-index:100000;opacity:0;transition:opacity .2s,transform .2s;' +
                    'pointer-events:none;max-width:80vw;white-space:nowrap}' +
                    '.bk-dsc-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}';
                document.head.appendChild(st);
            }
            var el = document.createElement('div');
            el.className = 'bk-dsc-toast';
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
        } catch (e) { /* toast 失败不影响主流程 */ }
    }

    // ── 导出 ──────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.DataSyncPage = {
        show: show,
        hide: hide,
        // 纯函数（供单测）
        formatImportResult: formatImportResult,
        formatImportErrors: formatImportErrors,
        syncStateText: syncStateText,
        formatSyncTime: formatSyncTime,
        formatSize: formatSize
    };

})(window);
