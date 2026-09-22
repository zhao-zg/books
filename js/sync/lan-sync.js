/**
 * lan-sync.js — 局域网同步核心 API
 *
 * 客户端 API（APK + PWA 均可用）：
 *   - connect(ip, port)          → GET /info，返回对端设备信息
 *   - pull(ip, port, opts)       → GET /download → importFromZip 合并
 *   - push(ip, port, opts)       → generateZipBytes → POST /upload（multipart）
 *   - discover(handler)          → APK：NSD 自动发现对端（回调 onDeviceFound）
 *   - stopDiscovery()           → 停止 NSD 发现
 *
 * 服务端 JS 桥梁（仅 APK，被 NanoHTTPD 通过 evaluateJs 调用）：
 *   - _handleInfo(requestId)           → 收集设备信息 → deliverResult
 *   - _handleDownload(mode, books, id)  → generateZipBytes → base64 → deliverResult
 *   - _handleUpload(base64Zip, id, senderName) → 接收确认 → importFromZip → deliverResult
 *   - _onDeviceFound(json)             → NSD 发现回调 → 转发给 discover handler
 *
 * 依赖：
 *   - BK.SyncCore.generateZipBytes / importFromZip (sync-core.js)
 *   - BKShelf.all (shelf.js)
 *   - Capacitor.Plugins.LanSync (仅 APK)
 *
 * 挂载：window.BK.LanSync
 */
(function (win) {
    'use strict';

    var _discoverHandler = null;

    var LanSync = {
        // ── 环境检测 ──────────────────────────────────────────────────

        isAvailable: function () {
            return !!(win.Capacitor && win.Capacitor.Plugins && win.Capacitor.Plugins.LanSync);
        },

        isNative: function () {
            return this.isAvailable();
        },

        // ── 服务端（APK only）──────────────────────────────────────────

        startServer: function () {
            if (!this.isAvailable()) return Promise.reject(new Error('仅 APK 端可用'));
            return win.Capacitor.Plugins.LanSync.startServer();
        },

        stopServer: function () {
            if (!this.isAvailable()) return Promise.reject(new Error('仅 APK 端可用'));
            return win.Capacitor.Plugins.LanSync.stopServer();
        },

        getStatus: function () {
            if (!this.isAvailable()) return Promise.reject(new Error('仅 APK 端可用'));
            return win.Capacitor.Plugins.LanSync.getStatus();
        },

        // ── 客户端（APK + PWA）─────────────────────────────────────────

        connect: function (ip, port) {
            var url = 'http://' + ip + ':' + port + '/info';
            return win.fetch(url).then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            });
        },

        pull: function (ip, port, opts) {
            opts = opts || {};
            var mode = opts.mode || 'data';
            var booksParam = opts.books ? '&books=' + win.encodeURIComponent(opts.books.join(',')) : '';
            var url = 'http://' + ip + ':' + port + '/download?mode=' + win.encodeURIComponent(mode) + booksParam;

            return win.fetch(url).then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.arrayBuffer();
            }).then(function (buffer) {
                if (!win.BK || !win.BK.SyncCore || !win.BK.SyncCore.importFromZip) {
                    throw new Error('importFromZip 未就绪');
                }
                return win.BK.SyncCore.importFromZip(buffer);
            });
        },

        push: function (ip, port, opts) {
            opts = opts || {};
            var mode = opts.mode || 'data';
            var bookIds = opts.books || [];

            if (!win.BK || !win.BK.SyncCore || !win.BK.SyncCore.generateZipBytes) {
                return Promise.reject(new Error('generateZipBytes 未就绪'));
            }

            // SyncCore 签名：generateZipBytes(mode, { bookIds })——mode 在前，books 为空时自动取书架全部
            return win.BK.SyncCore.generateZipBytes(mode, { bookIds: bookIds }).then(function (zipBytes) {
                // multipart 上传：Blob 保持二进制，NanoHTTPD 走临时文件分支，避免 UTF-8 字符串化损坏 ZIP
                var form = new FormData();
                form.append('file', new Blob([zipBytes], { type: 'application/zip' }), 'sync.zip');
                form.append('name', _getDeviceName());
                var url = 'http://' + ip + ':' + port + '/upload';
                return win.fetch(url, {
                    method: 'POST',
                    body: form
                }).then(function (res) {
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    return res.json();
                });
            });
        },

        // ── NSD 发现（仅 APK）────────────────────────────────────────

        discover: function (handler) {
            _discoverHandler = typeof handler === 'function' ? handler : null;
            if (!this.isAvailable()) return Promise.reject(new Error('仅 APK 端可用'));
            return win.Capacitor.Plugins.LanSync.discover();
        },

        stopDiscovery: function () {
            _discoverHandler = null;
            if (!this.isAvailable()) return Promise.reject(new Error('仅 APK 端可用'));
            return win.Capacitor.Plugins.LanSync.stopDiscover();
        },

        // 被 Java NSD DiscoveryListener 通过 evaluateJs 调用（仅 APK）
        _onDeviceFound: function (deviceJson) {
            var device = null;
            try {
                device = JSON.parse(deviceJson);
            } catch (e) {
                return;
            }
            if (_discoverHandler) _discoverHandler(device);
        },

        // ── JS 桥（被 Java evaluateJs 调用，仅 APK）──────────────────

        _handleInfo: function (requestId) {
            var info = {
                name: _getDeviceName(),
                version: (win.BK_APP_VERSION || ''),
                books: []
            };

            if (win.BKShelf && typeof win.BKShelf.all === 'function') {
                var shelf = win.BKShelf.all();
                for (var i = 0; i < shelf.length; i++) {
                    var rec = shelf[i];
                    if (rec) {
                        var bid = rec.bookId || rec.id;
                        if (bid) info.books.push({ id: bid, title: rec.title || bid });
                    }
                }
            }

            var json = JSON.stringify(info);
            _deliverResult(requestId, json);
        },

        _handleDownload: function (mode, booksStr, requestId) {
            var bookIds = [];
            if (booksStr) {
                bookIds = booksStr.split(',').filter(function (s) { return s; });
            }
            // 无指定书籍时导出全部
            if (!bookIds.length && win.BKShelf && typeof win.BKShelf.all === 'function') {
                var shelf = win.BKShelf.all();
                for (var i = 0; i < shelf.length; i++) {
                    var rec = shelf[i];
                    if (rec) {
                        var bid = rec.bookId || rec.id;
                        if (bid) bookIds.push(bid);
                    }
                }
            }

            if (!win.BK || !win.BK.SyncCore || !win.BK.SyncCore.generateZipBytes) {
                _deliverResult(requestId, JSON.stringify({ error: 'generateZipBytes 未就绪' }));
                return Promise.resolve();
            }

            // SyncCore 签名：generateZipBytes(mode, { bookIds })；bookIds 空时其内部自动从书架收集全部
            return win.BK.SyncCore.generateZipBytes(mode || 'data', { bookIds: bookIds }).then(function (bytes) {
                var base64 = _bytesToBase64(bytes);
                _deliverResult(requestId, base64);
            }).catch(function (err) {
                _deliverResult(requestId, JSON.stringify({ error: err.message }));
            });
        },

        _handleUpload: function (base64Zip, requestId, senderName) {
            var buffer;
            try {
                buffer = _base64ToArrayBuffer(base64Zip);
            } catch (e) {
                _deliverResult(requestId, JSON.stringify({ success: 0, failed: 0, errors: ['base64 解码失败'] }));
                return Promise.resolve();
            }

            if (!win.BK || !win.BK.SyncCore || !win.BK.SyncCore.importFromZip) {
                _deliverResult(requestId, JSON.stringify({ success: 0, failed: 0, errors: ['importFromZip 未就绪'] }));
                return Promise.resolve();
            }

            // 接收确认：去除配对码后，接收确认框作为唯一安全网（防误收/恶意推送）
            return _askReceiveConfirm(senderName).then(function (accepted) {
                if (!accepted) {
                    _deliverResult(requestId, JSON.stringify({ success: 0, failed: 0, errors: ['接收被拒绝'], cancelled: true }));
                    return;
                }
                return win.BK.SyncCore.importFromZip(buffer).then(function (result) {
                    _deliverResult(requestId, JSON.stringify(result));
                }).catch(function (err) {
                    _deliverResult(requestId, JSON.stringify({
                        success: 0, failed: 0, errors: [err.message || String(err)]
                    }));
                });
            });
        }
    };

    // ── 内部工具 ──────────────────────────────────────────────────

    function _getDeviceName() {
        try {
            var name = win.localStorage.getItem('bk_device_name');
            if (name) return name;
        } catch (e) {}
        return '书报-' + (_shortId());
    }

    function _shortId() {
        var id = '';
        var chars = '0123456789ABCDEF';
        for (var i = 0; i < 4; i++) {
            id += chars[Math.floor(Math.random() * chars.length)];
        }
        return id;
    }

    function _deliverResult(requestId, data) {
        if (win.Capacitor && win.Capacitor.Plugins && win.Capacitor.Plugins.LanSync) {
            win.Capacitor.Plugins.LanSync.deliverResult({ requestId: requestId, data: data });
        }
    }

    function _bytesToBase64(bytes) {
        var binary = '';
        for (var i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return win.btoa(binary);
    }

    function _base64ToArrayBuffer(base64) {
        var binary = win.atob(base64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    /**
     * 弹接收确认框：去除配对码后作为接收端唯一安全网（防误收/恶意推送）。
     * 返回 Promise<boolean>：接受→true，拒绝/取消/超时→false。
     * @param {string} [senderName] 对端设备名（Java 上传链路从 multipart name 字段解析）
     */
    function _askReceiveConfirm(senderName) {
        return new Promise(function (resolve) {
            if (!win.BK || !win.BK.openDialog) {
                // 弹窗系统不可用（理论不该发生）→ 保守拒绝
                resolve(false);
                return;
            }
            var shown = senderName ? _esc(senderName) : '';
            var html =
                '<div class="lan-sync-code-dialog">' +
                '  <div class="lan-sync-code-dialog-title">接收传输？</div>' +
                '  <div class="lan-sync-code-dialog-desc">' + (shown ? '来自「' + shown + '」的传输数据' : '收到一条传输数据') + '</div>' +
                '  <div class="lan-sync-code-dialog-actions">' +
                '    <button class="lan-sync-code-dialog-cancel">拒绝</button>' +
                '    <button class="lan-sync-code-dialog-ok">接收</button>' +
                '  </div>' +
                '</div>';
            var dlg = win.BK.openDialog({
                id: 'bk-lan-sync-receive-dialog',
                html: html,
                onClose: function () {
                    // 系统返回键/点遮罩关闭：视为拒绝。栈条目已被 pop，不再调 dlg.close()
                    _done(false, true);
                }
            });
            if (!dlg) {
                // 已存在同 id 弹窗（上次未关）→ 保守拒绝
                resolve(false);
                return;
            }
            var settled = false;
            /**
             * @param {boolean} ok
             * @param {boolean} [fromOnClose] true=由 onClose 触发（back 键/点遮罩），此时不可再调 dlg.close()
             */
            function _done(ok, fromOnClose) {
                if (settled) return;
                settled = true;
                resolve(ok);
                if (!fromOnClose) {
                    try { dlg.close(); } catch (e) {}
                }
            }
            var cancelBtn = dlg.mask.querySelector('.lan-sync-code-dialog-cancel');
            if (cancelBtn) cancelBtn.addEventListener('click', function () { _done(false); });
            var okBtn = dlg.mask.querySelector('.lan-sync-code-dialog-ok');
            if (okBtn) okBtn.addEventListener('click', function () { _done(true); });
        });
    }

    function _esc(s) {
        if (!s) return '';
        var div = win.document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    // ── 导出 ──────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.LanSync = LanSync;

})(window);