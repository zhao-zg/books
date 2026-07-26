/**
 * export-core.js — 统一导出出口
 *
 * 背景：
 *   原导出实现（note-summary.js._doExport）直接用 <a download> 触发下载，
 *   在 Capacitor 原生 WebView 中基本失效（Android System WebView / iOS WKWebView
 *   对 download 属性支持极不稳定），且全程无错误处理、无用户反馈。
 *
 * 能力：
 *   1. 统一出口 BK.Export.exportText(content, filename, mime, opts?)
 *   2. 平台自动分支：原生走 Filesystem.writeFile + Share.share；Web 走 a.download
 *   3. UTF-8 BOM：对 text/* 类型自动加 BOM，解决 Windows 记事本乱码
 *   4. 全程 try-catch：失败 console.error + toast；成功 toast 反馈
 *
 * 依赖：
 *   - 原生：Capacitor.Plugins.Filesystem / Capacitor.Plugins.Share（@capacitor/filesystem + @capacitor/share）
 *   - Web：Blob / URL.createObjectURL / <a download>
 *
 * 用法：
 *   BK.Export.exportText(mdContent, '我的标记-2026-07-20.md', 'text/markdown;charset=utf-8', {
 *       successMsg: '已导出 87 条标记',
 *       bom: true   // 默认对 text/* 自动启用，可显式覆盖
 *   }).catch(function(){ /* 已 toast，通常无需处理 *\/ });
 */
(function (win) {
    'use strict';

    // ── toast（最小实现，与 renderer-utils._toast 风格一致，避免加载顺序依赖）────
    var _toastTimer = null;
    function _toast(msg) {
        if (!msg) return;
        try {
            if (!document.getElementById('bk-export-toast-style')) {
                var st = document.createElement('style');
                st.id = 'bk-export-toast-style';
                st.textContent =
                    '.bk-export-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%) translateY(12px);' +
                    'background:rgba(26,25,24,.92);color:#fff;padding:10px 18px;border-radius:22px;' +
                    'font-size:14px;z-index:99999;opacity:0;transition:opacity .2s,transform .2s;' +
                    'pointer-events:none;max-width:80vw;white-space:nowrap}' +
                    '.bk-export-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}';
                document.head.appendChild(st);
            }
            var el = document.createElement('div');
            el.className = 'bk-export-toast';
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

    // ── 平台检测 ─────────────────────────────────────────────────────────
    function _isNative() {
        try {
            return !!(win.Capacitor && typeof win.Capacitor.isNativePlatform === 'function' && win.Capacitor.isNativePlatform());
        } catch (e) {
            return false;
        }
    }

    function _getPlugins() {
        var plugins = win.Capacitor && win.Capacitor.Plugins;
        return {
            Filesystem: plugins && plugins.Filesystem,
            Share: plugins && plugins.Share
        };
    }

    // ── UTF-8 字符串转 base64（分块，避免大文本栈溢出）──────────────────────
    function _utf8ToBase64(str) {
        var encoder = new TextEncoder();
        var bytes = encoder.encode(str);
        var binary = '';
        var chunk = 0x8000; // 32KB 一块
        for (var i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    // ── BOM 控制 ──────────────────────────────────────────────────────────
    // 默认对 text/* 类型启用 BOM，解决 Windows 记事本乱码；JSON 等不加。
    function _shouldAddBom(mime, opts) {
        if (opts && typeof opts.bom === 'boolean') return opts.bom;
        return /^text\//i.test(mime || '');
    }

    // ── 文件名安全化（剥离路径分隔符，防注入）────────────────────────────
    function _sanitizeFilename(name) {
        return String(name || 'export').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    }

    // ── 原生分支：Filesystem.writeFile + Share.share ─────────────────────
    function _exportNative(content, filename, mime, opts) {
        var plugins = _getPlugins();
        var Filesystem = plugins.Filesystem;
        var Share = plugins.Share;

        if (!Filesystem) {
            return Promise.reject(new Error('Filesystem 插件未加载'));
        }

        var path = 'bk-export/' + filename;
        var data = _utf8ToBase64(content);

        // 1) 写入 Cache 目录（Android 默认仅允许 caches 目录被分享）
        //    Capacitor 6 Filesystem：不传 encoding 时，data 默认按 base64 解码写入
        //    传 encoding:'base64' 会报 "Unsupported encoding"（v6 Encoding 枚举无 base64 值）
        return Filesystem.writeFile({
            path: path,
            data: data,
            directory: 'CACHE',
            recursive: true
        }).then(function () {
            // 2) 取 file:// URI
            return Filesystem.getUri({ path: path, directory: 'CACHE' });
        }).then(function (uriResult) {
            var fileUri = uriResult && uriResult.uri;
            if (!fileUri) throw new Error('无法获取文件 URI');

            // 3) Share 分享面板（若 Share 插件可用）
            //    分享失败不致命（文件已落盘），降级为成功提示
            if (!Share) {
                return { shared: false, fileUri: fileUri, fallback: true };
            }
            return Share.canShare().then(function (can) {
                if (!can || !can.value) {
                    return { shared: false, fileUri: fileUri, fallback: true };
                }
                return Share.share({
                    title: filename,
                    dialogTitle: '选择保存位置',
                    files: [fileUri]
                }).then(function () {
                    return { shared: true, fileUri: fileUri };
                });
            });
        });
    }

    // ── Web 分支：Blob + <a download> ─────────────────────────────────────
    function _exportWeb(content, filename, mime, opts) {
        return new Promise(function (resolve, reject) {
            try {
                var blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                setTimeout(function () {
                    if (a.parentNode) a.parentNode.removeChild(a);
                    URL.revokeObjectURL(url);
                    resolve({ shared: false, fallback: false });
                }, 100);
            } catch (e) {
                reject(e);
            }
        });
    }

    // ── 统一出口 ──────────────────────────────────────────────────────────
    /**
     * 导出文本内容到本地文件
     * @param {string} content  文本内容
     * @param {string} filename 文件名（含扩展名）
     * @param {string} [mime]   MIME 类型，默认 text/plain;charset=utf-8
     * @param {Object} [opts]
     *   - {boolean}  bom        是否加 UTF-8 BOM（默认对 text/* 自动启用）
     *   - {string}   successMsg 成功 toast 文案（默认"已导出"）
     *   - {string}   errorMsg   失败 toast 文案（默认"导出失败"）
     * @returns {Promise<{shared:boolean,fileUri?:string}>}
     */
    function exportText(content, filename, mime, opts) {
        opts = opts || {};
        mime = mime || 'text/plain;charset=utf-8';
        filename = _sanitizeFilename(filename);

        // BOM 处理：在内容前前置 \uFEFF（Blob 会按 UTF-8 编码，BOM 字节为 EF BB BF）
        var finalContent = _shouldAddBom(mime, opts) ? '\uFEFF' + content : content;

        var successMsg = opts.successMsg || '已导出';
        var errorMsg = opts.errorMsg || '导出失败，请重试';

        return Promise.resolve().then(function () {
            if (_isNative()) {
                return _exportNative(finalContent, filename, mime, opts);
            }
            return _exportWeb(finalContent, filename, mime, opts);
        }).then(function (result) {
            // 原生侧若 Share 不可用但文件已落盘，提示路径而非报错
            if (result && result.fallback) {
                _toast('文件已保存到应用缓存，请通过文件管理器查看');
            } else {
                _toast(successMsg);
            }
            return result;
        }).catch(function (err) {
            console.error('[BK.Export] 导出失败：', err);
            _toast(errorMsg);
            throw err;
        });
    }

    // ── 二进制导出 ─────────────────────────────────────────────────────────
    /**
     * 导出二进制内容到本地文件（PDF / EPUB 等）
     * @param {Uint8Array} bytes   二进制数据
     * @param {string}     filename 文件名
     * @param {string}     [mime]   MIME 类型，默认 application/octet-stream
     * @param {Object}     [opts]
     *   - {string} successMsg 成功 toast 文案
     *   - {string} errorMsg   失败 toast 文案
     * @returns {Promise<{shared:boolean,fileUri?:string}>}
     */
    function exportBinary(bytes, filename, mime, opts) {
        opts = opts || {};
        mime = mime || 'application/octet-stream';
        filename = _sanitizeFilename(filename);

        var successMsg = opts.successMsg || '已导出';
        var errorMsg = opts.errorMsg || '导出失败，请重试';

        return Promise.resolve().then(function () {
            if (_isNative()) {
                return _exportNativeBinary(bytes, filename, mime, opts);
            }
            return _exportWebBinary(bytes, filename, mime, opts);
        }).then(function (result) {
            if (result && result.fallback) {
                _toast('文件已保存到应用缓存，请通过文件管理器查看');
            } else {
                _toast(successMsg);
            }
            return result;
        }).catch(function (err) {
            console.error('[BK.Export] 二进制导出失败：', err);
            _toast(errorMsg);
            throw err;
        });
    }

    // ── 原生二进制分支：Uint8Array → base64 → Filesystem.writeFile → Share ──
    function _exportNativeBinary(bytes, filename, mime, opts) {
        var plugins = _getPlugins();
        var Filesystem = plugins.Filesystem;
        var Share = plugins.Share;

        if (!Filesystem) {
            return Promise.reject(new Error('Filesystem 插件未加载'));
        }

        var path = 'bk-export/' + filename;
        // Uint8Array → base64（分块，防栈溢出）
        var binary = '';
        var chunk = 0x8000;
        for (var i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        var base64 = btoa(binary);

        // Capacitor 6 Filesystem：不传 encoding 时，data 默认按 base64 解码写入
        return Filesystem.writeFile({
            path: path,
            data: base64,
            directory: 'CACHE',
            recursive: true
        }).then(function () {
            return Filesystem.getUri({ path: path, directory: 'CACHE' });
        }).then(function (uriResult) {
            var fileUri = uriResult && uriResult.uri;
            if (!fileUri) throw new Error('无法获取文件 URI');
            if (!Share) {
                return { shared: false, fileUri: fileUri, fallback: true };
            }
            return Share.canShare().then(function (can) {
                if (!can || !can.value) {
                    return { shared: false, fileUri: fileUri, fallback: true };
                }
                return Share.share({
                    title: filename,
                    dialogTitle: '选择保存位置',
                    files: [fileUri]
                }).then(function () {
                    return { shared: true, fileUri: fileUri };
                });
            });
        });
    }

    // ── Web 二进制分支：Blob + a.download ───────────────────────────────
    function _exportWebBinary(bytes, filename, mime, opts) {
        return new Promise(function (resolve, reject) {
            try {
                var blob = new Blob([bytes], { type: mime });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                setTimeout(function () {
                    if (a.parentNode) a.parentNode.removeChild(a);
                    URL.revokeObjectURL(url);
                    resolve({ shared: false, fallback: false });
                }, 100);
            } catch (e) {
                reject(e);
            }
        });
    }

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.Export = {
        exportText: exportText,
        exportBinary: exportBinary,
        // 暴露工具供测试/扩展
        _isNative: _isNative,
        _utf8ToBase64: _utf8ToBase64
    };

})(window);
