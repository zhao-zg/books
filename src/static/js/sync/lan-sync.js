/**
 * lan-sync.js — 局域网同步核心 API
 *
 * 客户端 API（APK + PWA 均可用）：
 *   - connect(ip, port, code)   → GET /info，返回对端设备信息
 *   - pull(ip, port, code, opts) → GET /download → importFromZip 合并
 *   - push(ip, port, code, opts) → generateZipBytes → POST /upload
 *
 * 服务端 JS 桥梁（仅 APK，被 NanoHTTPD 通过 evaluateJs 调用）：
 *   - _handleInfo(requestId)           → 收集设备信息 → deliverResult
 *   - _handleDownload(mode, books, id)  → generateZipBytes → base64 → deliverResult
 *   - _handleUpload(base64Zip, id)      → base64 → importFromZip → deliverResult
 *
 * 依赖：
 *   - BK.Sync.generateZipBytes (sync-export.js, T1)
 *   - BK.Sync.importFromZip (sync-import.js)
 *   - BKShelf.all (shelf.js)
 *   - Capacitor.Plugins.LanSync (仅 APK)
 *
 * 挂载：window.BK.LanSync
 */
(function (win) {
    'use strict';

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

        connect: function (ip, port, code) {
            var url = 'http://' + ip + ':' + port + '/info?code=' + code;
            return win.fetch(url).then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            });
        },

        pull: function (ip, port, code, opts) {
            opts = opts || {};
            var mode = opts.mode || 'data';
            var booksParam = opts.books ? '&books=' + opts.books.join(',') : '';
            var url = 'http://' + ip + ':' + port + '/download?code=' + code + '&mode=' + mode + booksParam;

            return win.fetch(url).then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.arrayBuffer();
            }).then(function (buffer) {
                if (!win.BK || !win.BK.Sync || !win.BK.Sync.importFromZip) {
                    throw new Error('importFromZip 未就绪');
                }
                return win.BK.Sync.importFromZip(buffer);
            });
        },

        push: function (ip, port, code, opts) {
            opts = opts || {};
            var mode = opts.mode || 'data';
            var bookIds = opts.books || [];

            if (!win.BK || !win.BK.Sync || !win.BK.Sync.generateZipBytes) {
                return Promise.reject(new Error('generateZipBytes 未就绪'));
            }

            return win.BK.Sync.generateZipBytes(bookIds, { mode: mode }).then(function (zipBytes) {
                var url = 'http://' + ip + ':' + port + '/upload?code=' + code;
                return win.fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/zip' },
                    body: zipBytes
                }).then(function (res) {
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    return res.json();
                });
            });
        },

        // ── JS 桥梁（被 Java evaluateJs 调用，仅 APK）──────────────────

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

            if (!win.BK || !win.BK.Sync || !win.BK.Sync.generateZipBytes) {
                _deliverResult(requestId, JSON.stringify({ error: 'generateZipBytes 未就绪' }));
                return Promise.resolve();
            }

            return win.BK.Sync.generateZipBytes(bookIds, { mode: mode || 'data' }).then(function (bytes) {
                var base64 = _bytesToBase64(bytes);
                _deliverResult(requestId, base64);
            }).catch(function (err) {
                _deliverResult(requestId, JSON.stringify({ error: err.message }));
            });
        },

        _handleUpload: function (base64Zip, requestId) {
            var buffer;
            try {
                buffer = _base64ToArrayBuffer(base64Zip);
            } catch (e) {
                _deliverResult(requestId, JSON.stringify({ success: 0, failed: 0, errors: ['base64 解码失败'] }));
                return Promise.resolve();
            }

            if (!win.BK || !win.BK.Sync || !win.BK.Sync.importFromZip) {
                _deliverResult(requestId, JSON.stringify({ success: 0, failed: 0, errors: ['importFromZip 未就绪'] }));
                return Promise.resolve();
            }

            return win.BK.Sync.importFromZip(buffer).then(function (result) {
                _deliverResult(requestId, JSON.stringify(result));
            }).catch(function (err) {
                _deliverResult(requestId, JSON.stringify({
                    success: 0, failed: 0, errors: [err.message || String(err)]
                }));
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

    // ── 导出 ──────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.LanSync = LanSync;

})(window);