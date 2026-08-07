/**
 * export-core.js — 统一导出出口（v2）
 *
 * 导出策略（按优先级）：
 *
 * Android 原生：
 *   1. SAF SaveFile 插件（ACTION_CREATE_DOCUMENT）→ 弹系统"另存为"对话框，用户选路径
 *   2. 降级：Filesystem.writeFile(CACHE) + Share.share → 写缓存后弹分享面板
 *   3. 最终降级：仅写缓存，toast 提示路径
 *
 * Web / PWA：
 *   1. showSaveFilePicker()（File System Access API）→ 弹系统"另存为"对话框
 *   2. 降级：<a download> → 静默下载到浏览器默认目录
 *
 * 能力：
 *   1. 统一出口 BK.Export.exportText / BK.Export.exportBinary
 *   2. 平台自动分支 + 多级降级
 *   3. UTF-8 BOM：对 text/* 类型自动加 BOM
 *   4. 全程 try-catch + 明确保存位置提示
 *
 * 依赖：
 *   - Android：Capacitor.Plugins.SaveFile（自定义 SAF 插件）
 *   - Android 降级：Capacitor.Plugins.Filesystem / Capacitor.Plugins.Share
 *   - Web：showSaveFilePicker / Blob / URL.createObjectURL / <a download>
 */
(function (win) {
    'use strict';

    // ── toast ──────────────────────────────────────────────────────────
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
            SaveFile: plugins && plugins.SaveFile,
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

    // ── Uint8Array 转 base64（分块）───────────────────────────────────
    function _bytesToBase64(bytes) {
        var binary = '';
        var chunk = 0x8000;
        for (var i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    // ── BOM 控制 ──────────────────────────────────────────────────────────
    function _shouldAddBom(mime, opts) {
        if (opts && typeof opts.bom === 'boolean') return opts.bom;
        return /^text\//i.test(mime || '');
    }

    // ── 文件名安全化（剥离路径分隔符，防注入）────────────────────────────
    function _sanitizeFilename(name) {
        return String(name || 'export').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    }

    // ── 提取 MIME 中的纯类型（去掉 charset 等参数）───────────────────────
    function _pureMime(mime) {
        if (!mime) return 'application/octet-stream';
        var idx = mime.indexOf(';');
        return (idx >= 0 ? mime.substring(0, idx) : mime).trim();
    }

    // ====================================================================
    //  Android 策略1：SAF SaveFile 插件（ACTION_CREATE_DOCUMENT）
    // ====================================================================
    function _exportNativeSAF(base64Data, filename, mime) {
        var SaveFile = _getPlugins().SaveFile;
        if (!SaveFile) return Promise.reject(new Error('SaveFile 插件不可用'));

        return SaveFile.save({
            filename: filename,
            data: base64Data,
            mimeType: _pureMime(mime)
        }).then(function (result) {
            if (result && result.saved) {
                return { method: 'saf', saved: true, uri: result.uri };
            }
            // 用户取消
            return { method: 'saf', saved: false, cancelled: true };
        });
    }

    // ====================================================================
    //  Android 策略2（降级）：Filesystem.writeFile(CACHE) + Share.share
    // ====================================================================
    function _exportNativeShare(base64Data, filename, mime) {
        var plugins = _getPlugins();
        var Filesystem = plugins.Filesystem;
        var Share = plugins.Share;

        if (!Filesystem) {
            return Promise.reject(new Error('Filesystem 插件未加载'));
        }

        var path = 'bk-export/' + filename;

        return Filesystem.writeFile({
            path: path,
            data: base64Data,
            directory: 'CACHE',
            recursive: true
        }).then(function () {
            return Filesystem.getUri({ path: path, directory: 'CACHE' });
        }).then(function (uriResult) {
            var fileUri = uriResult && uriResult.uri;
            if (!fileUri) throw new Error('无法获取文件 URI');

            if (!Share) {
                return { method: 'cache-only', shared: false, fileUri: fileUri, fallback: true };
            }
            return Share.canShare().then(function (can) {
                if (!can || !can.value) {
                    return { method: 'cache-only', shared: false, fileUri: fileUri, fallback: true };
                }
                return Share.share({
                    title: filename,
                    dialogTitle: '选择保存位置',
                    files: [fileUri]
                }).then(function () {
                    return { method: 'share', shared: true, fileUri: fileUri };
                });
            });
        });
    }

    // ====================================================================
    //  Android 统一入口：SAF → Share 降级
    // ====================================================================
    function _exportNative(base64Data, filename, mime) {
        // 优先尝试 SAF（弹系统"另存为"对话框）
        if (_getPlugins().SaveFile) {
            return _exportNativeSAF(base64Data, filename, mime).then(function (result) {
                if (result.cancelled) {
                    // 用户取消 SAF 对话框，不降级，直接返回
                    return result;
                }
                if (result.saved) return result;
                // SAF 其他失败，降级到 Cache+Share
                return _exportNativeShare(base64Data, filename, mime);
            }).catch(function () {
                // SAF 异常（如插件内部错误），降级到 Cache+Share
                return _exportNativeShare(base64Data, filename, mime);
            });
        }
        // 无 SAF 插件，直接走 Cache+Share
        return _exportNativeShare(base64Data, filename, mime);
    }

    // ====================================================================
    //  Web 策略1：showSaveFilePicker（File System Access API）
    // ====================================================================
    function _exportWebPicker(content, filename, mime, isBinary) {
        if (typeof win.showSaveFilePicker !== 'function') {
            return Promise.reject(new Error('showSaveFilePicker 不可用'));
        }

        var pickerOpts = {
            suggestedName: filename
        };

        // 构建 types 过滤器（部分浏览器要求 accept 非空）
        var pureMime = _pureMime(mime);
        var ext = _mimeToExtension(pureMime);
        if (ext) {
            pickerOpts.types = [{
                description: '文件',
                accept: {}
            }];
            pickerOpts.types[0].accept[pureMime] = [ext];
        }
        // 无匹配扩展名时不设 types，浏览器会显示所有文件

        return win.showSaveFilePicker(pickerOpts).then(function (handle) {
            return handle.createWritable().then(function (writable) {
                if (isBinary) {
                    return writable.write(content).then(function () {
                        return writable.close();
                    });
                } else {
                    return writable.write(new Blob([content], { type: mime })).then(function () {
                        return writable.close();
                    });
                }
            }).then(function () {
                return { method: 'picker', saved: true };
            });
        });
    }

    // ── MIME → 扩展名映射（showSaveFilePicker 用）────────────────────
    function _mimeToExtension(mime) {
        var map = {
            'text/plain': '.txt',
            'text/markdown': '.md',
            'application/epub+zip': '.epub',
            'application/pdf': '.pdf',
            'application/zip': '.zip',
            'application/octet-stream': '.bin',
            'application/json': '.json'
        };
        return map[mime] || null;
    }

    // ====================================================================
    //  Web 策略2（降级）：Blob + <a download>
    // ====================================================================
    function _exportWebDownload(content, filename, mime, isBinary) {
        return new Promise(function (resolve, reject) {
            try {
                var blob = isBinary
                    ? new Blob([content], { type: mime })
                    : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
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
                    resolve({ method: 'download', saved: true, fallback: true });
                }, 100);
            } catch (e) {
                reject(e);
            }
        });
    }

    // ====================================================================
    //  Web 统一入口：showSaveFilePicker → <a download> 降级
    // ====================================================================
    function _exportWeb(content, filename, mime, isBinary) {
        // 优先尝试 showSaveFilePicker（用户可选路径）
        return _exportWebPicker(content, filename, mime, isBinary).catch(function (err) {
            // 用户取消选择器，AbortError
            if (err && err.name === 'AbortError') {
                return { method: 'picker', saved: false, cancelled: true };
            }
            // showSaveFilePicker 不可用或其他错误，降级到 <a download>
            return _exportWebDownload(content, filename, mime, isBinary);
        });
    }

    // ====================================================================
    //  统一出口：exportText
    // ====================================================================
    /**
     * 导出文本内容到本地文件
     * @param {string} content  文本内容
     * @param {string} filename 文件名（含扩展名）
     * @param {string} [mime]   MIME 类型，默认 text/plain;charset=utf-8
     * @param {Object} [opts]
     *   - {boolean}  bom        是否加 UTF-8 BOM（默认对 text/* 自动启用）
     *   - {string}   successMsg 成功 toast 文案（默认"已导出"）
     *   - {string}   errorMsg   失败 toast 文案（默认"导出失败"）
     * @returns {Promise<{method:string,saved?:boolean,cancelled?:boolean}>}
     */
    function exportText(content, filename, mime, opts) {
        opts = opts || {};
        mime = mime || 'text/plain;charset=utf-8';
        filename = _sanitizeFilename(filename);

        // BOM 处理
        var finalContent = _shouldAddBom(mime, opts) ? '\uFEFF' + content : content;

        var successMsg = opts.successMsg || '已导出';
        var errorMsg = opts.errorMsg || '导出失败，请重试';

        return Promise.resolve().then(function () {
            if (_isNative()) {
                var base64 = _utf8ToBase64(finalContent);
                return _exportNative(base64, filename, mime);
            }
            return _exportWeb(finalContent, filename, mime, false);
        }).then(function (result) {
            _handleResult(result, successMsg, errorMsg);
            return result;
        }).catch(function (err) {
            console.error('[BK.Export] 导出失败：', err);
            _toast(errorMsg);
            throw err;
        });
    }

    // ====================================================================
    //  统一出口：exportBinary
    // ====================================================================
    /**
     * 导出二进制内容到本地文件（PDF / EPUB / ZIP 等）
     * @param {Uint8Array} bytes   二进制数据
     * @param {string}     filename 文件名
     * @param {string}     [mime]   MIME 类型，默认 application/octet-stream
     * @param {Object}     [opts]
     *   - {string} successMsg 成功 toast 文案
     *   - {string} errorMsg   失败 toast 文案
     * @returns {Promise<{method:string,saved?:boolean,cancelled?:boolean}>}
     */
    function exportBinary(bytes, filename, mime, opts) {
        opts = opts || {};
        mime = mime || 'application/octet-stream';
        filename = _sanitizeFilename(filename);

        var successMsg = opts.successMsg || '已导出';
        var errorMsg = opts.errorMsg || '导出失败，请重试';

        return Promise.resolve().then(function () {
            if (_isNative()) {
                var base64 = _bytesToBase64(bytes);
                return _exportNative(base64, filename, mime);
            }
            return _exportWeb(bytes, filename, mime, true);
        }).then(function (result) {
            _handleResult(result, successMsg, errorMsg);
            return result;
        }).catch(function (err) {
            console.error('[BK.Export] 二进制导出失败：', err);
            _toast(errorMsg);
            throw err;
        });
    }

    // ====================================================================
    //  结果处理：根据导出方式显示不同 toast
    // ====================================================================
    function _handleResult(result, successMsg, errorMsg) {
        if (!result) {
            _toast(successMsg);
            return;
        }

        // 用户取消
        if (result.cancelled) {
            // 静默，不弹 toast
            return;
        }

        // 成功：根据 method 显示不同提示
        if (result.saved || result.shared) {
            switch (result.method) {
                case 'saf':
                    // SAF 保存成功，系统已给反馈，轻提示即可
                    _toast(successMsg);
                    break;
                case 'picker':
                    // Web showSaveFilePicker 保存成功
                    _toast(successMsg);
                    break;
                case 'share':
                    // 通过分享面板保存
                    _toast(successMsg);
                    break;
                case 'download':
                    // Web <a download> 降级，明确提示下载位置
                    _toast(successMsg + '（已下载到浏览器默认目录）');
                    break;
                case 'cache-only':
                    // 仅写入缓存，需用户自行查找
                    _toast('文件已保存到应用缓存，请通过文件管理器查看');
                    break;
                default:
                    _toast(successMsg);
                    break;
            }
            return;
        }

        // 降级场景
        if (result.fallback) {
            _toast('文件已保存到应用缓存，请通过文件管理器查看');
            return;
        }

        _toast(successMsg);
    }

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.Export = {
        exportText: exportText,
        exportBinary: exportBinary,
        // 暴露工具供测试/扩展
        _isNative: _isNative,
        _utf8ToBase64: _utf8ToBase64,
        _bytesToBase64: _bytesToBase64
    };

})(window);
