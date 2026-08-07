/**
 * export-batch.js — 批量导出书籍为 ZIP 压缩包
 *
 * 将多本书打包为一个 .zip 文件，结构如下：
 *   bk-books-export-2026-07-26.zip
 *   ├── manifest.json           # 元信息（版本、日期、书目数）
 *   └── books/
 *       ├── <bookId-1>/
 *       │   ├── book.json       # 完整书籍数据
 *       │   ├── userdata.json   # 用户数据（阅读进度、书签、高亮等）
 *       │   └── original.pdf    # （仅 PDF 书）原始 PDF 二进制
 *       ├── <bookId-2>/
 *       │   ├── book.json
 *       │   └── userdata.json
 *       ...
 *
 * 依赖：
 *   - JSZip (vendor/jszip.min.js)
 *   - BK.Export.exportBinary (export-core.js)
 *   - DataManager (dm-api.js)
 *   - ImportManager (import-orchestrator.js)
 *
 * 挂载：window.BK.Export.exportBatch(bookIds, opts?)
 */
(function (win) {
    'use strict';

    var MANIFEST_VERSION = 2;

    // ── 工具函数 ──────────────────────────────────────────────────────────

    /** 文件夹名安全化（ZIP 路径不允许特殊字符） */
    function _sanitizeFolderName(name) {
        return String(name || 'unknown').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    }

    /** 判断书籍数据是否为 PDF 书 */
    function _isPdfBookData(bookData) {
        if (!bookData) return false;
        if (bookData.format === 'pdf') return true;
        var chapters = bookData.chapters || [];
        for (var i = 0; i < chapters.length; i++) {
            var content = chapters[i].content;
            if (Array.isArray(content)) {
                for (var j = 0; j < content.length; j++) {
                    if (content[j] && content[j].type === 'pdf_page') return true;
                }
            }
        }
        return false;
    }

    /** 兜底：二进制下载（无 BK.Export 时的降级） */
    function _fallbackBinaryDownload(bytes, filename, mime) {
        return new Promise(function (resolve, reject) {
            try {
                var blob = new Blob([bytes], { type: mime || 'application/zip' });
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
                    resolve({});
                }, 100);
            } catch (e) { reject(e); }
        });
    }

    // ── 用户数据收集 ──────────────────────────────────────────────────────────

    /**
     * 收集单本书的 localStorage 用户数据（阅读进度、书签、高亮等）
     * @param {string} bookId
     * @returns {Object|null} 用户数据对象，无数据时返回 null
     *
     * 收集的 localStorage key：
     *   bk_progress:<bookId>            — 阅读进度百分比
     *   bk_chapter_read:<bookId>/<ch>   — 章节已读标记（扫描所有 key）
     *   bk_pdf_pos:<bookId>             — PDF 当前页码
     *   bk_pdf_bm:<bookId>             — PDF 书签
     *   bk_pdf_hl:<bookId>             — PDF 高亮/批注
     *   bk_lastread_ts:<bookId>        — 最后阅读时间戳
     */
    function _collectUserData(bookId) {
        try {
            var ls = win.localStorage;
            if (!ls) return null;

            var data = {};

            // 阅读进度
            var progress = ls.getItem('bk_progress:' + bookId);
            if (progress !== null) data.progress = progress;

            // 最后阅读时间
            var lastReadTs = ls.getItem('bk_lastread_ts:' + bookId);
            if (lastReadTs !== null) data.lastReadTs = lastReadTs;

            // PDF 阅读位置
            var pdfPos = ls.getItem('bk_pdf_pos:' + bookId);
            if (pdfPos !== null) data.pdfPos = pdfPos;

            // PDF 书签
            var pdfBm = ls.getItem('bk_pdf_bm:' + bookId);
            if (pdfBm !== null) data.pdfBookmarks = pdfBm;

            // PDF 高亮/批注
            var pdfHl = ls.getItem('bk_pdf_hl:' + bookId);
            if (pdfHl !== null) data.pdfHighlights = pdfHl;

            // 章节已读标记（扫描所有匹配的 key）
            var chapterReads = [];
            var prefix = 'bk_chapter_read:' + bookId + '/';
            for (var i = 0; i < ls.length; i++) {
                var key = ls.key(i);
                if (key && key.indexOf(prefix) === 0) {
                    var chNum = key.substring(prefix.length);
                    if (chNum && ls.getItem(key) === '1') {
                        chapterReads.push(chNum);
                    }
                }
            }
            if (chapterReads.length > 0) data.chapterReads = chapterReads;

            // 有任何数据才返回（progress 值为 '0' 也算有效数据）
            var hasData = data.progress != null
                || data.lastReadTs || data.pdfPos
                || data.pdfBookmarks || data.pdfHighlights || data.chapterReads;
            return hasData ? data : null;
        } catch (e) {
            return null;
        }
    }

    // ── 数据获取 ──────────────────────────────────────────────────────────

    /**
     * 获取单本书的完整数据
     * 优先从 ImportManager（导入书），降级到 DataManager（下载书）
     */
    function _getBookData(bookId) {
        if (win.ImportManager && typeof win.ImportManager.getImportedBook === 'function') {
            return win.ImportManager.getImportedBook(bookId).then(function (book) {
                if (book) return book;
                if (win.DataManager && typeof win.DataManager.getBook === 'function') {
                    return win.DataManager.getBook(bookId);
                }
                return null;
            });
        }
        if (win.DataManager && typeof win.DataManager.getBook === 'function') {
            return win.DataManager.getBook(bookId);
        }
        return Promise.resolve(null);
    }

    /**
     * 获取 PDF 书的原始二进制数据
     */
    function _getPdfData(bookId) {
        var store = (win.ImportManager && typeof win.ImportManager.getPdfDataStore === 'function')
            ? win.ImportManager.getPdfDataStore() : null;
        if (!store) return Promise.resolve(null);
        return store.getItem('pdf:' + bookId).then(function (data) {
            return data || null;
        }).catch(function () { return null; });
    }

    // ── 主入口 ──────────────────────────────────────────────────────────

    /**
     * 批量导出书籍为 ZIP
     * @param {string[]} bookIds  要导出的书籍 ID 列表
     * @param {Object}   [opts]
     *   - {Function} onProgress(current, total, bookTitle)  进度回调
     * @returns {Promise}
     */
    function exportBatch(bookIds, opts) {
        opts = opts || {};
        var JSZip = win.JSZip;
        if (!JSZip) return Promise.reject(new Error('JSZip 未加载，无法打包导出'));

        if (!bookIds || !bookIds.length) {
            return Promise.reject(new Error('未选择任何书籍'));
        }

        var zip = new JSZip();
        var booksFolder = zip.folder('books');
        var errors = [];
        var current = 0;
        var total = bookIds.length;

        // 顺序处理，避免大量书籍时内存爆炸
        var chain = Promise.resolve();

        for (var i = 0; i < bookIds.length; i++) {
            (function (bookId, idx) {
                chain = chain.then(function () {
                    current = idx + 1;
                    return _getBookData(bookId).then(function (bookData) {
                        if (!bookData) {
                            errors.push({ id: bookId, error: '书籍数据未找到' });
                            if (opts.onProgress) opts.onProgress(current, total, bookId);
                            return;
                        }

                        var title = bookData.title || bookId;
                        var folderName = _sanitizeFolderName(bookId);
                        var bookFolder = booksFolder.folder(folderName);
                        var isPdf = _isPdfBookData(bookData);

                        // 写入 book.json（深拷贝，避免污染原始数据）
                        var exportData = JSON.parse(JSON.stringify(bookData));

                        // 清理 PDF 页面大体积数据（已在 original.pdf 中单独保存）
                        // PDF 书的章节 content 中 pdf_page 条目包含大体积数据，导出到 book.json 中无意义
                        if (isPdf && exportData.chapters) {
                            for (var ci = 0; ci < exportData.chapters.length; ci++) {
                                var ch = exportData.chapters[ci];
                                if (Array.isArray(ch.content)) {
                                    for (var cj = ch.content.length - 1; cj >= 0; cj--) {
                                        if (ch.content[cj] && ch.content[cj].type === 'pdf_page') {
                                            ch.content.splice(cj, 1);
                                        }
                                    }
                                    // 内容为空时设为空数组，避免导入时误判为无章书
                                    if (!ch.content.length) ch.content = [];
                                }
                            }
                        }

                        bookFolder.file('book.json', JSON.stringify(exportData, null, 2));

                        // 收集并写入用户数据（阅读进度、书签、高亮等）
                        var userData = _collectUserData(bookId);
                        if (userData) {
                            bookFolder.file('userdata.json', JSON.stringify(userData, null, 2));
                        }

                        // 如果是 PDF 书，尝试包含原始 PDF 二进制
                        if (isPdf) {
                            return _getPdfData(bookId).then(function (pdfData) {
                                if (pdfData) {
                                    bookFolder.file('original.pdf', pdfData);
                                }
                                if (opts.onProgress) opts.onProgress(current, total, title);
                            });
                        }

                        if (opts.onProgress) opts.onProgress(current, total, title);
                    }).catch(function (err) {
                        errors.push({ id: bookId, error: (err && err.message) || '未知错误' });
                        if (opts.onProgress) opts.onProgress(current, total, bookId);
                    });
                });
            })(bookIds[i], i);
        }

        return chain.then(function () {
            // 写入 manifest.json
            var manifest = {
                version: MANIFEST_VERSION,
                exportDate: new Date().toISOString(),
                bookCount: bookIds.length - errors.length,
                errorCount: errors.length,
                errors: errors
            };
            zip.file('manifest.json', JSON.stringify(manifest, null, 2));

            // 生成 ZIP 二进制
            return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
        }).then(function (bytes) {
            var date = new Date();
            var dateStr = date.getFullYear() + '-' +
                ('0' + (date.getMonth() + 1)).slice(-2) + '-' +
                ('0' + date.getDate()).slice(-2);
            var filename = 'bk-books-export-' + dateStr + '.zip';

            if (win.BK && win.BK.Export && win.BK.Export.exportBinary) {
                var successMsg = '已导出 ' + (bookIds.length - errors.length) + ' 本书' +
                    (errors.length ? '（' + errors.length + ' 本跳过）' : '');
                return win.BK.Export.exportBinary(bytes, filename, 'application/zip', {
                    successMsg: successMsg
                });
            }
            return _fallbackBinaryDownload(bytes, filename, 'application/zip');
        });
    }

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.Export = win.BK.Export || {};
    win.BK.Export.exportBatch = exportBatch;

})(window);
