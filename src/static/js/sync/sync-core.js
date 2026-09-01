/**
 * sync-core.js — v4 包唯一导出实现（收编 sync-export v3 + export-batch v2）
 *
 * 统一 v4 包格式，两种模式：
 *   bk-book-<date>.zip（v4）
 *   ├─ manifest.json            # { version: 4, mode: "data"|"full", exportedAt, deviceName }
 *   ├─ shelf.json               # 书架列表（BKShelf.all() 原样数组）
 *   └─ books/
 *       └─ <bookId>/
 *           ├─ book.json        # 书元数据（data/full 两种模式都含）
 *           ├─ userdata.json    # 进度/书签/标注
 *           ├─ original.pdf     # 仅 full 模式（PDF 书）
 *           └─ book.<ext>       # 仅 full 模式（txt/md/epub）
 *
 * 与旧版差异：
 *   - v3 sync-export：data 模式不含 book.json（仅 userdata）；v4 统一含 book.json
 *   - v2 export-batch：无 shelf.json；v4 统一含 shelf.json
 *   - manifest version 3→4，新增 mode/deviceName 字段，去掉 type/bookCount/errorCount
 *   - 全量书籍自动收集（不再要求调用方传 bookIds）
 *   - 底层复用 sync-shared.js（getBookData/isPdfBookData）+ sync-data-collect.js（collectUserData）
 *
 * 依赖注入（通过 opts 传入，避免单测碰真 IndexedDB）：
 *   opts.importStore  — localforage 实例（storeName: 'imported-data'）
 *   opts.zlStore      — localforage 实例（storeName: 'zl-data'）
 *   opts.pdfStore     — localforage 实例（storeName: 'imported-pdf-data'）
 *   缺失某 store 时跳过该路径，不崩溃。
 *
 * 依赖（全局）：
 *   - JSZip (win.JSZip)
 *   - BK.SyncShared.getBookData / isPdfBookData (sync-shared.js)
 *   - BK.SyncData.collectUserData (sync-data-collect.js)
 *   - BK.Export.exportBinary (export-core.js)
 *   - BKShelf.all (shelf.js)
 *   - BKBookmark.getAll (bookmark.js)
 *   - BKStorage.getAllPages (highlight-shared.js)
 *   - localStorage（bk_device_name / bk_scroll:* 等）
 *
 * 挂载：window.BK.SyncCore
 *   .generateZipBytes(mode, opts)  → Promise<Uint8Array>
 *   .exportData(mode, opts)        → Promise（生成字节 + exportBinary 写出）
 */
(function (win) {
    'use strict';

    var MANIFEST_VERSION = 4;

    // ── 工具函数 ──────────────────────────────────────────────────────────

    /**
     * 获取设备名
     * 取 localStorage 'bk_device_name'，缺失时回退 '书报-<短ID>'
     * 与 lan-sync.js _getDeviceName 逻辑一致
     * @returns {string}
     */
    function _getDeviceName() {
        try {
            var name = win.localStorage.getItem('bk_device_name');
            if (name) return name;
        } catch (e) { /* ignore */ }
        return '书报-' + _shortId();
    }

    function _shortId() {
        var id = '';
        var chars = '0123456789ABCDEF';
        for (var i = 0; i < 4; i++) {
            id += chars[Math.floor(Math.random() * chars.length)];
        }
        return id;
    }

    /**
     * 扫描 localStorage 收集章内滚动位置
     * key 格式：bk_scroll:<bookId>/<chNum> → 值为滚动 px
     * @param {string} bookId
     * @returns {Object} { "<chNum>": "<scrollPx>", ... }
     */
    function _collectScroll(bookId) {
        var scroll = {};
        try {
            var ls = win.localStorage;
            if (!ls) return scroll;
            var prefix = 'bk_scroll:' + bookId + '/';
            for (var i = 0; i < ls.length; i++) {
                var key = ls.key(i);
                if (key && key.indexOf(prefix) === 0) {
                    var chNum = key.substring(prefix.length);
                    var val = ls.getItem(key);
                    if (chNum && val !== null) {
                        scroll[chNum] = val;
                    }
                }
            }
        } catch (e) { /* 忽略 localStorage 异常 */ }
        return scroll;
    }

    /**
     * 从 BKBookmark.getAll() 过滤指定书的书签
     * @param {Array} allBookmarks
     * @param {string} bookId
     * @returns {Array}
     */
    function _filterBookmarks(allBookmarks, bookId) {
        var result = [];
        for (var i = 0; i < allBookmarks.length; i++) {
            var bm = allBookmarks[i];
            if (bm && bm.bookId === bookId) {
                result.push(bm);
            }
        }
        return result;
    }

    /**
     * 从 BKStorage.getAllPages() 过滤指定书的高亮页
     * key 格式：/<bookId>/<chNum>
     * @param {Array} allPages
     * @param {string} bookId
     * @returns {Array}
     */
    function _filterHighlights(allPages, bookId) {
        var prefix = '/' + bookId + '/';
        var result = [];
        for (var i = 0; i < allPages.length; i++) {
            var page = allPages[i];
            if (page && page.key && page.key.indexOf(prefix) === 0) {
                result.push(page);
            }
        }
        return result;
    }

    /**
     * 为单本书收集完整 userdata（合并 localStorage + IndexedDB 数据）
     * 复用 BK.SyncData.collectUserData（sync-data-collect.js）收集 localStorage 部分
     * 补充 EPUB 书签/高亮（IndexedDB）和章内滚动（localStorage 前缀扫描）
     * @param {string} bookId
     * @param {Array} allBookmarks  全量书签（已预取）
     * @param {Array} allPages      全量高亮页（已预取）
     * @returns {Object} userdata
     */
    function _buildUserData(bookId, allBookmarks, allPages) {
        var data = { schema: MANIFEST_VERSION };

        // 1. localStorage 用户数据（进度、PDF 书签/高亮、章节已读）
        if (win.BK && win.BK.SyncData && typeof win.BK.SyncData.collectUserData === 'function') {
            var lsData = win.BK.SyncData.collectUserData(bookId);
            if (lsData) {
                if (lsData.progress !== undefined) data.progress = lsData.progress;
                if (lsData.lastReadTs !== undefined) data.lastReadTs = lsData.lastReadTs;
                if (lsData.pdfPos !== undefined) data.pdfPos = lsData.pdfPos;
                if (lsData.pdfBookmarks !== undefined) data.pdfBookmarks = lsData.pdfBookmarks;
                if (lsData.pdfHighlights !== undefined) data.pdfHighlights = lsData.pdfHighlights;
                if (lsData.chapterReads !== undefined) data.chapterReads = lsData.chapterReads;
            }
        }

        // 2. EPUB 书签（从 IndexedDB）
        data.bookmarks = _filterBookmarks(allBookmarks, bookId);

        // 3. EPUB 高亮/划线（从 IndexedDB）
        data.highlights = _filterHighlights(allPages, bookId);

        // 4. 章内滚动位置（从 localStorage 前缀扫描）
        data.scroll = _collectScroll(bookId);

        return data;
    }

    /**
     * 根据 bookData.format 决定 full 模式的书文件扩展名
     * PDF 书 → original.pdf（走 PDF 二进制路径）
     * txt → book.txt, md → book.md, epub → book.epub
     * 其他/未知 → book.txt（安全回退）
     * @param {Object} bookData
     * @returns {string} 文件名（不含路径）
     */
    function _bookFileName(bookData) {
        var format = (bookData && bookData.format) || 'txt';
        switch (format) {
            case 'md': return 'book.md';
            case 'epub': return 'book.epub';
            case 'txt': return 'book.txt';
            default: return 'book.txt'; // 安全回退
        }
    }

    /**
     * 获取书城索引缓存（用于 resolveCityBook 二次校验）
     * 尽力获取，获取失败返回 null（不阻断流程）
     * @returns {Object|null}
     */
    function _getCachedIndex() {
        try {
            if (win.DataManager && typeof win.DataManager.getCachedIndex === 'function') {
                return win.DataManager.getCachedIndex();
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // ── 主入口 ──────────────────────────────────────────────────────────

    /**
     * 生成 v4 ZIP 字节流（不触发下载）
     * 供局域网同步 push 模式及 exportData 共用
     * @param {string} mode  'data'（仅用户数据+元数据）或 'full'（含书籍正文）
     * @param {Object} [opts]
     *   - {string[]} bookIds  要打包的书籍 ID 列表（缺省取 BKShelf.all() 全部）
     *   - {Object} importStore  localforage 实例（导入书数据）
     *   - {Object} zlStore      localforage 实例（书城书数据）
     *   - {Object} pdfStore     localforage 实例（PDF 二进制）
     * @returns {Promise<Uint8Array>}
     */
    function generateZipBytes(mode, opts) {
        mode = mode || 'data';
        opts = opts || {};

        if (mode !== 'data' && mode !== 'full') {
            return Promise.reject(new Error('无效的导出模式：' + mode + '（仅支持 data / full）'));
        }

        var JSZip = win.JSZip;
        if (!JSZip) return Promise.reject(new Error('JSZip 未加载，无法打包'));

        // 确定 bookIds：优先用传入的，缺失时从 BKShelf.all() 收集
        var bookIds = opts.bookIds;
        if (!bookIds || !bookIds.length) {
            bookIds = [];
            if (win.BKShelf && typeof win.BKShelf.all === 'function') {
                var shelf = win.BKShelf.all();
                for (var i = 0; i < shelf.length; i++) {
                    if (shelf[i] && shelf[i].id) {
                        bookIds.push(shelf[i].id);
                    }
                }
            }
        }

        if (!bookIds.length) {
            return Promise.reject(new Error('书架为空，无可导出的书籍'));
        }

        console.log('[BK.SyncCore] generateZipBytes: 开始打包 ' + bookIds.length + ' 本书（mode=' + mode + '）');
        var t0 = Date.now();

        // 构造 store 依赖
        var deps = {
            importStore: opts.importStore || null,
            zlStore: opts.zlStore || null
        };
        var pdfStore = opts.pdfStore || null;

        // 预取全量书签和高亮（避免逐书重复调用 getAll）
        var bookmarksPromise = (win.BKBookmark && typeof win.BKBookmark.getAll === 'function')
            ? win.BKBookmark.getAll().catch(function () { return []; })
            : Promise.resolve([]);
        var highlightsPromise = (win.BKStorage && typeof win.BKStorage.getAllPages === 'function')
            ? win.BKStorage.getAllPages().catch(function () { return []; })
            : Promise.resolve([]);

        return Promise.all([bookmarksPromise, highlightsPromise]).then(function (results) {
            var allBookmarks = results[0] || [];
            var allPages = results[1] || [];

            var zip = new JSZip();
            var booksFolder = zip.folder('books');

            // 逐书处理（串行避免内存爆炸）
            var chain = Promise.resolve();
            for (var i = 0; i < bookIds.length; i++) {
                (function (bookId) {
                    chain = chain.then(function () {
                        var bookFolder = booksFolder.folder(bookId);

                        // 用户数据（两种模式都写）
                        var userData = _buildUserData(bookId, allBookmarks, allPages);
                        bookFolder.file('userdata.json', JSON.stringify(userData, null, 2));

                        // 获取书籍数据（两种模式都需要 book.json）
                        // 用 BK.SyncShared.getBookData（依赖注入 store）
                        var getBookPromise;
                        if (win.BK && win.BK.SyncShared && typeof win.BK.SyncShared.getBookData === 'function') {
                            getBookPromise = win.BK.SyncShared.getBookData(bookId, deps);
                        } else {
                            getBookPromise = Promise.resolve(null);
                        }

                        return getBookPromise.then(function (bookData) {
                            if (!bookData) {
                                console.warn('[BK.SyncCore] generateZipBytes: 书籍数据未找到，跳过 book.json id=' + bookId);
                                return;
                            }

                            // 写入 book.json（深拷贝避免污染）
                            var exportBook = JSON.parse(JSON.stringify(bookData));
                            bookFolder.file('book.json', JSON.stringify(exportBook, null, 2));

                            // full 模式：额外打包书本体
                            if (mode !== 'full') return;

                            var isPdf = (win.BK && win.BK.SyncShared && typeof win.BK.SyncShared.isPdfBookData === 'function')
                                ? win.BK.SyncShared.isPdfBookData(bookData)
                                : false;

                            if (isPdf) {
                                // PDF 书：取原始二进制
                                if (!pdfStore) return;
                                return pdfStore.getItem('pdf:' + bookId).then(function (pdfData) {
                                    if (pdfData) {
                                        bookFolder.file('original.pdf', pdfData);
                                    } else {
                                        console.warn('[BK.SyncCore] generateZipBytes: PDF 数据缺失，跳过 original.pdf id=' + bookId);
                                    }
                                }).catch(function () { /* ignore */ });
                            } else {
                                // 非 PDF 书：转文本格式写 book.<ext>
                                var fileName = _bookFileName(bookData);
                                var format = (bookData.format || 'txt').toLowerCase();
                                var contentStr;

                                if (win.BK && win.BK.BookConvert) {
                                    if (format === 'md') {
                                        contentStr = win.BK.BookConvert.bookToMd(bookData);
                                    } else if (format === 'epub') {
                                        // EPUB 返回 Promise<Uint8Array>
                                        return win.BK.BookConvert.bookToEpub(bookData).then(function (epubBytes) {
                                            bookFolder.file(fileName, epubBytes);
                                        }).catch(function (e) {
                                            console.warn('[BK.SyncCore] generateZipBytes: EPUB 转换失败，回退 TXT id=' + bookId, e);
                                            contentStr = win.BK.BookConvert.bookToText(bookData);
                                            bookFolder.file('book.txt', contentStr);
                                        });
                                    } else {
                                        contentStr = win.BK.BookConvert.bookToText(bookData);
                                        bookFolder.file(fileName, contentStr);
                                    }
                                } else {
                                    // BookConvert 未加载时，退化用 bookData 的原始 content 拼接
                                    console.warn('[BK.SyncCore] generateZipBytes: BookConvert 未加载，退化为原始内容');
                                    contentStr = _fallbackText(bookData);
                                    bookFolder.file(fileName, contentStr);
                                }
                            }
                        });
                    });
                })(bookIds[i]);
            }

            return chain.then(function () {
                // 写入 shelf.json（BKShelf.all() 原样）
                var shelfData = [];
                if (win.BKShelf && typeof win.BKShelf.all === 'function') {
                    shelfData = win.BKShelf.all();
                }
                zip.file('shelf.json', JSON.stringify(shelfData, null, 2));

                // 写入 manifest.json（v4 格式）
                var manifest = {
                    version: MANIFEST_VERSION,
                    mode: mode,
                    exportedAt: new Date().toISOString(),
                    deviceName: _getDeviceName()
                };
                zip.file('manifest.json', JSON.stringify(manifest, null, 2));

                console.log('[BK.SyncCore] generateZipBytes: 打包完成，开始生成 ZIP...');
                return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
            });
        }).then(function (bytes) {
            console.log('[BK.SyncCore] generateZipBytes: ZIP 生成完成，大小=' +
                (bytes.length / 1024).toFixed(2) + 'KB，总耗时 ' + (Date.now() - t0) + 'ms');
            return bytes;
        });
    }

    /**
     * BookConvert 未加载时的退化文本拼接
     * 仅拼接 chapters 内的纯文本，不做类型感知
     * @param {Object} bookData
     * @returns {string}
     */
    function _fallbackText(bookData) {
        var title = (bookData && bookData.title) || (bookData && bookData.id) || '未知';
        var chapters = (bookData && bookData.chapters) || [];
        var lines = [title, ''];
        for (var c = 0; c < chapters.length; c++) {
            var content = chapters[c].content;
            if (typeof content === 'string') {
                lines.push(content);
            } else if (Array.isArray(content)) {
                for (var i = 0; i < content.length; i++) {
                    if (content[i] && content[i].text) {
                        lines.push(content[i].text);
                    }
                }
            }
            lines.push('');
        }
        return lines.join('\n');
    }

    /**
     * 导出数据 ZIP（生成字节 + exportBinary 写出）
     * @param {string} mode  'data' 或 'full'
     * @param {Object} [opts]  同 generateZipBytes
     * @returns {Promise}
     */
    function exportData(mode, opts) {
        return generateZipBytes(mode, opts).then(function (bytes) {
            var date = new Date();
            var dateStr = date.getFullYear() + '-' +
                ('0' + (date.getMonth() + 1)).slice(-2) + '-' +
                ('0' + date.getDate()).slice(-2);
            var filename = 'bk-book-' + dateStr + '.zip';

            console.log('[BK.SyncCore] exportData: ZIP 已生成，文件名=' + filename);

            if (win.BK && win.BK.Export && win.BK.Export.exportBinary) {
                return win.BK.Export.exportBinary(bytes, filename, 'application/zip', {
                    chooseDestination: true,
                    successMsg: mode === 'full' ? '已导出完整数据包' : '已导出同步数据'
                });
            }
            console.log('[BK.SyncCore] exportData: exportBinary 不可用，走 fallback 下载');
            return _fallbackBinaryDownload(bytes, filename);
        });
    }

    /** 兜底：二进制下载（无 BK.Export 时的降级） */
    function _fallbackBinaryDownload(bytes, filename) {
        return new Promise(function (resolve, reject) {
            try {
                var blob = new Blob([bytes], { type: 'application/zip' });
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

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.SyncCore = {
        generateZipBytes: generateZipBytes,
        exportData: exportData
    };

})(window);
