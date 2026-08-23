/**
 * export-core.js — 统一导出出口（v3，分块写入）
 *
 * 导出策略（按优先级）：
 *
 * Android 原生：
 *   1. SAF SaveFile 插件（ACTION_CREATE_DOCUMENT）→ 弹系统"另存为"对话框
 *      - 小文件（base64 ≤ 5MB）：一次性写入
 *      - 大文件（base64 > 5MB）：startWrite → writeChunk * N → finishWrite 分块写入
 *   2. 降级：Cache+Share
 *      - 小文件：Filesystem.writeFile(CACHE) + Share.share
 *      - 大文件：startCacheWrite → writeCacheChunk * N → finishCacheWrite + Share
 *   3. 最终降级：仅写缓存，toast 提示路径
 *   4. skipSAF 模式（批量导出）：跳过 SAF 直接走 Cache+Share
 *
 * Web / PWA：
 *   1. showSaveFilePicker()（File System Access API）→ 弹系统"另存为"对话框
 *   2. 降级：<a download> → 静默下载到浏览器默认目录
 *
 * 能力：
 *   1. 统一出口 BK.Export.exportText / BK.Export.exportBinary
 *   2. 平台自动分支 + 多级降级
 *   3. 分块写入：大文件按 2MB 原始数据拆块，避免 WebView 桥接 OOM
 *   4. UTF-8 BOM：对 text/* 类型自动加 BOM
 *   5. 全程 try-catch + 明确保存位置提示
 *
 * 依赖：
 *   - Android：Capacitor.Plugins.SaveFile（自定义 SAF 插件，支持分块写入）
 *   - Android 降级：Capacitor.Plugins.Filesystem / Capacitor.Plugins.Share
 *   - Web：showSaveFilePicker / Blob / URL.createObjectURL / <a download>
 */
(function (win) {
    'use strict';

    // ── toast ──────────────────────────────────────────────────────────
    var _toastTimer = null;

    /** 注入选择面板样式（幂等，供 _askDestination 和 _toast 共用） */
    function _ensureDestStyle() {
        if (!document.getElementById('bk-export-dest-style')) {
            var dst = document.createElement('style');
            dst.id = 'bk-export-dest-style';
            dst.textContent =
                '.bk-export-dest-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s;font-family:inherit}' +
                '.bk-export-dest-mask.show{opacity:1}' +
                '.bk-export-dest-dialog{width:min(320px,calc(100vw - 40px));background:#fff;border-radius:16px;padding:20px 18px 16px;box-shadow:0 10px 40px rgba(0,0,0,.2);transform:translateY(8px);transition:transform .2s}' +
                '.bk-export-dest-mask.show .bk-export-dest-dialog{transform:translateY(0)}' +
                '.bk-export-dest-title{font-size:16px;font-weight:600;text-align:center;margin-bottom:16px;color:#1a1918}' +
                '.bk-export-dest-opts{display:flex;flex-direction:column;gap:10px;margin-bottom:14px}' +
                '.bk-export-dest-opt{display:flex;align-items:center;gap:10px;padding:13px 14px;border:1px solid #e8e4dd;border-radius:12px;background:#faf8f5;font-size:15px;color:#1a1918;text-align:left;cursor:pointer}' +
                '.bk-export-dest-opt:active{background:#f0ede6}' +
                '.bk-export-dest-icon{font-size:18px;width:24px;text-align:center}' +
                '.bk-export-dest-cancel{display:block;width:100%;padding:11px;border:none;border-radius:12px;background:#f0ede6;font-size:14px;color:#666;cursor:pointer}';
            document.head.appendChild(dst);
        }
    }

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
            // 双动作选择面板样式
            _ensureDestStyle();
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

    // ── 分块大小：每块原始数据 2MB（base64 约 2.67MB），避免桥接 OOM ────
    var CHUNK_RAW_SIZE = 2 * 1024 * 1024; // 2MB 原始数据
    var CHUNK_B64_SIZE = Math.ceil(CHUNK_RAW_SIZE / 3) * 4; // 对应 base64 长度（4 的倍数）

    /**
     * 将 base64 字符串按 CHUNK_B64_SIZE 拆分成块
     * 直接按 base64 长度切分，保证每块长度是 4 的倍数（base64 编码单元）
     */
    function _splitBase64Chunks(base64) {
        var chunks = [];
        for (var i = 0; i < base64.length; i += CHUNK_B64_SIZE) {
            chunks.push(base64.substring(i, Math.min(i + CHUNK_B64_SIZE, base64.length)));
        }
        return chunks;
    }

    /**
     * 分块写入 SAF 流（startWrite → writeChunk * N → finishWrite）
     * @param {string} base64Data  完整 base64 数据
     * @param {string} filename    文件名
     * @param {string} mime        MIME 类型
     * @returns {Promise<{method:string,saved:boolean,uri?:string,cancelled?:boolean}>}
     */
    function _exportNativeSAFChunked(base64Data, filename, mime) {
        var SaveFile = _getPlugins().SaveFile;
        if (!SaveFile) return Promise.reject(new Error('SaveFile 插件不可用'));

        var totalRawSize = Math.floor(base64Data.length * 3 / 4);
        console.log('[BK.Export] SAF 分块写入：启动，文件名=' + filename +
            '，原始大小=' + totalRawSize + '，base64 长度=' + base64Data.length);

        return SaveFile.startWrite({
            filename: filename,
            mimeType: _pureMime(mime),
            totalSize: totalRawSize
        }).then(function (startResult) {
            if (!startResult || !startResult.started) {
                // 用户取消 SAF 对话框
                console.log('[BK.Export] SAF 分块写入：用户取消');
                return { method: 'saf-chunked', saved: false, cancelled: true };
            }
            var sessionId = startResult.sessionId;
            console.log('[BK.Export] SAF 分块写入：会话已建立，sessionId=' + sessionId);

            var chunks = _splitBase64Chunks(base64Data);
            console.log('[BK.Export] SAF 分块写入：拆分为 ' + chunks.length + ' 块');

            // 逐块串行写入
            return chunks.reduce(function (promise, chunk, idx) {
                return promise.then(function () {
                    console.log('[BK.Export] SAF writeChunk: ' + (idx + 1) + '/' + chunks.length +
                        '，base64 长度=' + chunk.length);
                    return SaveFile.writeChunk({ sessionId: sessionId, chunk: chunk });
                });
            }, Promise.resolve()).then(function () {
                console.log('[BK.Export] SAF 分块写入：所有块写入完成，调用 finishWrite');
                return SaveFile.finishWrite({ sessionId: sessionId });
            }).then(function (finishResult) {
                console.log('[BK.Export] SAF 分块写入：完成，uri=' + (finishResult && finishResult.uri));
                return { method: 'saf-chunked', saved: true, uri: finishResult && finishResult.uri };
            });
        }).catch(function (err) {
            console.error('[BK.Export] SAF 分块写入：异常', err);
            throw err;
        });
    }

    /**
     * 分块写入缓存文件（startCacheWrite → writeCacheChunk * N → finishCacheWrite + Share）
     * @param {string} base64Data  完整 base64 数据
     * @param {string} filename    文件名
     * @param {string} mime        MIME 类型
     * @returns {Promise<{method:string,saved?:boolean,shared?:boolean,fileUri?:string}>}
     */
    function _exportNativeShareChunked(base64Data, filename, mime) {
        var plugins = _getPlugins();
        var SaveFile = plugins.SaveFile;
        var Share = plugins.Share;

        if (!SaveFile) return Promise.reject(new Error('SaveFile 插件不可用'));

        var totalRawSize = Math.floor(base64Data.length * 3 / 4);
        console.log('[BK.Export] Cache+Share 分块写入：启动，文件名=' + filename +
            '，原始大小=' + totalRawSize + '，base64 长度=' + base64Data.length);

        return SaveFile.startCacheWrite({
            filename: filename,
            mimeType: _pureMime(mime)
        }).then(function (startResult) {
            if (!startResult || !startResult.started) {
                throw new Error('startCacheWrite 返回未启动');
            }
            var sessionId = startResult.sessionId;
            console.log('[BK.Export] Cache+Share 分块写入：会话已建立，sessionId=' + sessionId);

            var chunks = _splitBase64Chunks(base64Data);
            console.log('[BK.Export] Cache+Share 分块写入：拆分为 ' + chunks.length + ' 块');

            return chunks.reduce(function (promise, chunk, idx) {
                return promise.then(function () {
                    console.log('[BK.Export] Cache writeCacheChunk: ' + (idx + 1) + '/' + chunks.length +
                        '，base64 长度=' + chunk.length);
                    return SaveFile.writeCacheChunk({ sessionId: sessionId, chunk: chunk });
                });
            }, Promise.resolve()).then(function () {
                console.log('[BK.Export] Cache+Share 分块写入：所有块写入完成，调用 finishCacheWrite');
                return SaveFile.finishCacheWrite({ sessionId: sessionId });
            }).then(function (finishResult) {
                var fileUri = finishResult && finishResult.uri;
                var filePath = finishResult && finishResult.path;
                console.log('[BK.Export] Cache+Share 分块写入：缓存写入完成，uri=' + fileUri + '，path=' + filePath);

                if (!fileUri && !filePath) {
                    console.log('[BK.Export] Cache+Share 分块写入：无 URI，降级为 cache-only');
                    return { method: 'cache-only', shared: false, fallback: true };
                }

                if (!Share) {
                    console.log('[BK.Export] Cache+Share 分块写入：Share 插件不可用，降级为 cache-only');
                    return { method: 'cache-only', shared: false, fileUri: fileUri, fallback: true };
                }
                return Share.canShare().then(function (can) {
                    if (!can || !can.value) {
                        console.log('[BK.Export] Cache+Share 分块写入：Share.canShare() 返回不可分享，降级为 cache-only');
                        return { method: 'cache-only', shared: false, fileUri: fileUri, fallback: true };
                    }
                    console.log('[BK.Export] Cache+Share 分块写入：弹出系统分享面板...');
                    return Share.share({
                        title: filename,
                        dialogTitle: '选择保存位置',
                        files: [fileUri]
                    }).then(function () {
                        console.log('[BK.Export] Cache+Share 分块写入：分享成功');
                        return { method: 'share', shared: true, fileUri: fileUri };
                    });
                });
            });
        }).catch(function (err) {
            console.error('[BK.Export] Cache+Share 分块写入：失败', err);
            throw err;
        });
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
    //  小文件（base64 ≤ CHUNKED_THRESHOLD）一次性写入，大文件走分块
    // ====================================================================
    var CHUNKED_THRESHOLD = 5 * 1024 * 1024; // base64 ≤ 5MB 一次性，> 5MB 分块

    function _exportNativeSAF(base64Data, filename, mime) {
        var SaveFile = _getPlugins().SaveFile;
        if (!SaveFile) return Promise.reject(new Error('SaveFile 插件不可用'));

        console.log('[BK.Export] SAF 策略：启动，文件名=' + filename + '，MIME=' + mime + '，base64 长度=' + base64Data.length);

        // 大文件走分块写入
        if (base64Data.length > CHUNKED_THRESHOLD) {
            console.log('[BK.Export] SAF 策略：base64 超过 ' + CHUNKED_THRESHOLD + '，走分块写入');
            return _exportNativeSAFChunked(base64Data, filename, mime);
        }

        // 小文件一次性写入
        return SaveFile.save({
            filename: filename,
            data: base64Data,
            mimeType: _pureMime(mime)
        }).then(function (result) {
            if (result && result.saved) {
                console.log('[BK.Export] SAF 策略：保存成功，uri=' + result.uri);
                return { method: 'saf', saved: true, uri: result.uri };
            }
            // 用户取消
            console.log('[BK.Export] SAF 策略：用户取消或未保存');
            return { method: 'saf', saved: false, cancelled: true };
        }).catch(function (err) {
            console.error('[BK.Export] SAF 策略：异常', err);
            throw err;
        });
    }

    // ====================================================================
    //  Android 策略2（降级）：Filesystem.writeFile(CACHE) + Share.share
    //  小文件走 Filesystem 一次性写入，大文件走 SaveFile 分块写缓存
    // ====================================================================
    function _exportNativeShare(base64Data, filename, mime) {
        var plugins = _getPlugins();
        var Filesystem = plugins.Filesystem;
        var Share = plugins.Share;

        // 大文件走分块写入缓存
        if (base64Data.length > CHUNKED_THRESHOLD && plugins.SaveFile) {
            console.log('[BK.Export] Cache+Share 策略：base64 超过 ' + CHUNKED_THRESHOLD + '，走 SaveFile 分块写缓存');
            return _exportNativeShareChunked(base64Data, filename, mime);
        }

        if (!Filesystem) {
            return Promise.reject(new Error('Filesystem 插件未加载'));
        }

        var path = 'bk-export/' + filename;
        console.log('[BK.Export] Cache+Share 策略：写缓存，文件名=' + filename + '，base64 长度=' + base64Data.length);

        return Filesystem.writeFile({
            path: path,
            data: base64Data,
            directory: 'CACHE',
            recursive: true,
            encoding: 'base64'   // ← 关键：base64 数据必须指定 encoding，否则被当 UTF-8 文本写入
        }).then(function () {
            console.log('[BK.Export] Cache+Share 策略：缓存写入成功，path=' + path);
            return Filesystem.getUri({ path: path, directory: 'CACHE' });
        }).then(function (uriResult) {
            var fileUri = uriResult && uriResult.uri;
            if (!fileUri) throw new Error('无法获取文件 URI');
            console.log('[BK.Export] Cache+Share 策略：文件 URI=' + fileUri);

            if (!Share) {
                console.log('[BK.Export] Cache+Share 策略：Share 插件不可用，降级为 cache-only');
                return { method: 'cache-only', shared: false, fileUri: fileUri, fallback: true };
            }
            return Share.canShare().then(function (can) {
                if (!can || !can.value) {
                    console.log('[BK.Export] Cache+Share 策略：Share.canShare() 返回不可分享，降级为 cache-only');
                    return { method: 'cache-only', shared: false, fileUri: fileUri, fallback: true };
                }
                console.log('[BK.Export] Cache+Share 策略：弹出系统分享面板...');
                return Share.share({
                    title: filename,
                    dialogTitle: '选择保存位置',
                    files: [fileUri]
                }).then(function () {
                    console.log('[BK.Export] Cache+Share 策略：分享成功');
                    return { method: 'share', shared: true, fileUri: fileUri };
                });
            });
        }).catch(function (err) {
            console.error('[BK.Export] Cache+Share 策略：失败', err);
            throw err;
        });
    }

    // ====================================================================
    //  Android 统一入口：SAF → Share 降级
    // ====================================================================
    function _exportNative(base64Data, filename, mime, opts) {
        opts = opts || {};

        // skipSAF：批量导出等场景跳过 SAF 对话框，直接走 Cache+Share
        if (opts.skipSAF) {
            console.log('[BK.Export] _exportNative: skipSAF=true，走 Cache+Share');
            return _exportNativeShare(base64Data, filename, mime);
        }

        // 优先尝试 SAF（弹系统"另存为"对话框，大文件自动走分块写入）
        if (_getPlugins().SaveFile) {
            console.log('[BK.Export] _exportNative: 尝试 SAF 策略...');
            return _exportNativeSAF(base64Data, filename, mime).then(function (result) {
                if (result.cancelled) {
                    // 用户取消 SAF 对话框，不降级，直接返回
                    console.log('[BK.Export] _exportNative: SAF 用户取消');
                    return result;
                }
                if (result.saved) return result;
                // SAF 其他失败，降级到 Cache+Share
                console.log('[BK.Export] _exportNative: SAF 未保存，降级到 Cache+Share');
                return _exportNativeShare(base64Data, filename, mime);
            }).catch(function (err) {
                // SAF 异常（如插件内部错误），降级到 Cache+Share
                console.error('[BK.Export] _exportNative: SAF 异常，降级到 Cache+Share', err);
                return _exportNativeShare(base64Data, filename, mime);
            });
        }
        // 无 SAF 插件，直接走 Cache+Share
        console.log('[BK.Export] _exportNative: 无 SAF 插件，走 Cache+Share');
        return _exportNativeShare(base64Data, filename, mime);
    }

    // ====================================================================
    //  Web 策略1：showSaveFilePicker（File System Access API）
    // ====================================================================
    function _exportWebPicker(content, filename, mime, isBinary) {
        if (typeof win.showSaveFilePicker !== 'function') {
            return Promise.reject(new Error('showSaveFilePicker 不可用'));
        }

        console.log('[BK.Export] Web Picker 策略：启动，文件名=' + filename + '，MIME=' + mime);

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
                console.log('[BK.Export] Web Picker 策略：保存成功');
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
        console.log('[BK.Export] Web Download 策略：降级到 <a download>，文件名=' + filename);
        return new Promise(function (resolve, reject) {
            try {
                var blob = isBinary
                    ? new Blob([content], { type: mime })
                    : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
                console.log('[BK.Export] Web Download: Blob 大小=' + blob.size + ' 字节');
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
                    console.log('[BK.Export] Web Download: 下载触发完成');
                    resolve({ method: 'download', saved: true, fallback: true });
                }, 100);
            } catch (e) {
                console.error('[BK.Export] Web Download: 失败', e);
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
                console.log('[BK.Export] Web: 用户取消 Picker');
                return { method: 'picker', saved: false, cancelled: true };
            }
            // showSaveFilePicker 不可用或其他错误，降级到 <a download>
            console.log('[BK.Export] Web: Picker 不可用，降级到 <a download>，err=' + (err && err.message));
            return _exportWebDownload(content, filename, mime, isBinary);
        });
    }

    // ====================================================================
    //  双动作导出：保存本机 / 分享 / 保存并分享
    //  供单本导出与批量导出共用。native 弹选择面板；Web 端因无系统分享，
    //  直接走默认流程（picker / download）。
    // ====================================================================

    /**
     * 根据用户在面板中的选择，执行「保存到本机（SAF）」和/或「分享（Share）」。
     * @param {boolean} isBinary  是否为二进制内容
     * @param {*}       content   文本字符串 或 Uint8Array
     * @param {string}  filename  文件名
     * @param {string}  mime      MIME
     * @param {Object}  opts      { chooseDestination, skipSAF, successMsg, errorMsg }
     * @returns {Promise<{method:string,saved?:boolean,shared?:boolean,cancelled?:boolean}>}
     */
    function _exportWithDestination(isBinary, content, filename, mime, opts) {
        opts = opts || {};

        // Web 端没有系统分享面板，退化为默认行为
        if (!_isNative()) {
            if (isBinary) return _exportWeb(content, filename, mime, true);
            return _exportWeb(content, filename, mime, false);
        }

        // 预先转 base64（'both' 路径需要复用，避免重复编码大文件）
        var base64Data = isBinary ? _bytesToBase64(content) : _utf8ToBase64(content);
        function _getBase64() { return base64Data; }

        return _askDestination().then(function (choice) {
            if (!choice) {
                // 用户取消选择面板
                return { method: 'choose', saved: false, cancelled: true };
            }
            if (choice === 'save') {
                return _exportNative(_getBase64(), filename, mime, { skipSAF: false });
            }
            if (choice === 'share') {
                return _exportNative(_getBase64(), filename, mime, { skipSAF: true });
            }
            // 'both'：先 SAF 保存到本机，再分享同一内容
            return _exportNative(_getBase64(), filename, mime, { skipSAF: false })
                .then(function (saveRes) {
                    if (saveRes && saveRes.cancelled) {
                        // 用户取消了 SAF 保存对话框，放弃
                        return saveRes;
                    }
                    var savedOk = saveRes && (saveRes.saved || saveRes.shared);
                    // 无论保存是否成功，都继续尝试分享（save 成功优先）
                    return _exportNative(_getBase64(), filename, mime, { skipSAF: true })
                        .then(function (shareRes) {
                            return { method: 'both', saved: !!savedOk, shared: !!(shareRes && (shareRes.shared || shareRes.saved)) };
                        });
                });
        }).catch(function (err) {
            console.error('[BK.Export] 双动作导出失败：', err);
            throw err;
        });
    }

    /**
     * 弹出「保存本机 / 分享 / 保存并分享」选择面板（native only）
     * @returns {Promise<string|null>}  'save' | 'share' | 'both' | null（取消）
     */
    function _askDestination() {
        _ensureDestStyle();
        return new Promise(function (resolve) {
            var mask = document.createElement('div');
            mask.className = 'bk-export-dest-mask';
            var label = '导出到';
            mask.innerHTML =
                '<div class="bk-export-dest-dialog">' +
                  '<div class="bk-export-dest-title">' + label + '</div>' +
                  '<div class="bk-export-dest-opts">' +
                    '<button type="button" class="bk-export-dest-opt" data-v="save"><span class="bk-export-dest-icon">💾</span><span>保存到本机</span></button>' +
                    '<button type="button" class="bk-export-dest-opt" data-v="share"><span class="bk-export-dest-icon">📤</span><span>分享</span></button>' +
                    '<button type="button" class="bk-export-dest-opt" data-v="both"><span class="bk-export-dest-icon">💾📤</span><span>保存并分享</span></button>' +
                  '</div>' +
                  '<button type="button" class="bk-export-dest-cancel" data-v="cancel">取消</button>' +
                '</div>';

            document.body.appendChild(mask);
            void mask.offsetWidth;
            mask.classList.add('show');

            var _done = false;
            function _finish(v) {
                if (_done) return;
                _done = true;
                mask.classList.remove('show');
                setTimeout(function () {
                    if (mask.parentNode) mask.parentNode.removeChild(mask);
                }, 200);
                resolve(v === 'cancel' ? null : v);
            }

            mask.addEventListener('click', function (e) {
                if (e.target === mask) { _finish('cancel'); return; }
                var btn = e.target.closest ? e.target.closest('[data-v]') : null;
                if (btn) _finish(btn.getAttribute('data-v'));
            });
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
     *   - {boolean}  chooseDestination  是否弹「保存本机/分享」选择面板（默认 false，保持旧行为）
     * @returns {Promise<{method:string,saved?:boolean,cancelled?:boolean}>}
     */
    function exportText(content, filename, mime, opts) {
        opts = opts || {};
        mime = mime || 'text/plain;charset=utf-8';
        filename = _sanitizeFilename(filename);

        console.log('[BK.Export] exportText: 文件名=' + filename + '，MIME=' + mime + '，内容长度=' + content.length + '，平台=' + (_isNative() ? 'native' : 'web'));

        // BOM 处理
        var finalContent = _shouldAddBom(mime, opts) ? '\uFEFF' + content : content;

        var successMsg = opts.successMsg || '已导出';
        var errorMsg = opts.errorMsg || '导出失败，请重试';

        return Promise.resolve().then(function () {
            if (opts.chooseDestination) {
                // 双动作：先弹「保存本机 / 分享 / 保存并分享」选择面板
                return _exportWithDestination(false, finalContent, filename, mime, opts);
            }
            if (_isNative()) {
                console.log('[BK.Export] exportText: native 路径，转 base64...');
                var base64 = _utf8ToBase64(finalContent);
                return _exportNative(base64, filename, mime);
            }
            return _exportWeb(finalContent, filename, mime, false);
        }).then(function (result) {
            console.log('[BK.Export] exportText: 结果=', result);
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
     *   - {string}  successMsg 成功 toast 文案
     *   - {string}  errorMsg   失败 toast 文案
     *   - {boolean} skipSAF    跳过 SAF 对话框，直接走 Cache+Share（大文件/批量导出用）
     *   - {boolean} chooseDestination  弹「保存本机/分享」选择面板（默认 false，保持旧行为）
     * @returns {Promise<{method:string,saved?:boolean,cancelled?:boolean}>}
     */
    function exportBinary(bytes, filename, mime, opts) {
        opts = opts || {};
        mime = mime || 'application/octet-stream';
        filename = _sanitizeFilename(filename);

        console.log('[BK.Export] exportBinary: 文件名=' + filename + '，MIME=' + mime +
            '，字节长度=' + bytes.length + '，skipSAF=' + !!opts.skipSAF +
            '，平台=' + (_isNative() ? 'native' : 'web'));

        var successMsg = opts.successMsg || '已导出';
        var errorMsg = opts.errorMsg || '导出失败，请重试';

        return Promise.resolve().then(function () {
            if (opts.chooseDestination) {
                // 双动作：先弹「保存本机 / 分享 / 保存并分享」选择面板
                return _exportWithDestination(true, bytes, filename, mime, opts);
            }
            if (_isNative()) {
                console.log('[BK.Export] exportBinary: native 路径，转 base64...');
                var t0 = Date.now();
                var base64 = _bytesToBase64(bytes);
                console.log('[BK.Export] exportBinary: base64 转换完成，长度=' + base64.length + '，耗时=' + (Date.now() - t0) + 'ms');
                return _exportNative(base64, filename, mime, { skipSAF: opts.skipSAF });
            }
            return _exportWeb(bytes, filename, mime, true);
        }).then(function (result) {
            console.log('[BK.Export] exportBinary: 结果=', result);
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
                case 'saf-chunked':
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
