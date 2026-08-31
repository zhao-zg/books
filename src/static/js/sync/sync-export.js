/**
 * sync-export.js — 同步数据导出（轻量 ZIP，仅用户数据不含书籍正文）
 *
 * 生成 bk-sync-export-<date>.zip，结构如下：
 *   bk-sync-export-2026-08-31.zip
 *   ├── manifest.json       # {version:3, type:'sync-data', exportDate, bookCount}
 *   ├── shelf.json          # BKShelf.all() 原样数组
 *   └── books/
 *       ├── <bookId>/
 *       │   └── userdata.json   # 进度 + 书签 + 高亮 + 滚动 + PDF 数据（schema:3）
 *       ...
 *
 * mode='data' 时不含 book.json / original.pdf（那些是 mode='full' 的职责）。
 *
 * 依赖：
 *   - JSZip (vendor/jszip.min.js)
 *   - BK.SyncData.collectUserData (sync-data-collect.js)
 *   - BKBookmark.getAll (bookmark.js)
 *   - BKStorage.getAllPages (highlight-shared.js)
 *   - BKShelf.all (shelf.js)
 *   - BK.Export.exportBinary (export-core.js)
 *
 * 挂载：window.BK.Sync.exportData(bookIds, opts)
 */
(function (win) {
    'use strict';

    var MANIFEST_VERSION = 3;
    var SYNC_TYPE = 'sync-data';

    // ── 工具函数 ──────────────────────────────────────────────────────────

    /**
     * 扫描 localStorage 收集章内滚动位置
     * key 格式：bk_scroll:<bookId>/<chNum> → 值为滚动 px
     * 注意排除 bk_scroll:<bookId>（无章号，全局滚动）和其它书的 key
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
     * @param {string} bookId
     * @param {Array} allBookmarks  全量书签（已预取）
     * @param {Array} allPages      全量高亮页（已预取）
     * @returns {Object} userdata（schema:3）
     */
    function _buildUserData(bookId, allBookmarks, allPages) {
        var data = { schema: MANIFEST_VERSION };

        // 1. localStorage 用户数据（进度、PDF 书签/高亮、章节已读）
        var lsData = null;
        if (win.BK && win.BK.SyncData && typeof win.BK.SyncData.collectUserData === 'function') {
            lsData = win.BK.SyncData.collectUserData(bookId);
        }
        if (lsData) {
            // 合并 localStorage 字段（不覆盖 schema）
            if (lsData.progress !== undefined) data.progress = lsData.progress;
            if (lsData.lastReadTs !== undefined) data.lastReadTs = lsData.lastReadTs;
            if (lsData.pdfPos !== undefined) data.pdfPos = lsData.pdfPos;
            if (lsData.pdfBookmarks !== undefined) data.pdfBookmarks = lsData.pdfBookmarks;
            if (lsData.pdfHighlights !== undefined) data.pdfHighlights = lsData.pdfHighlights;
            if (lsData.chapterReads !== undefined) data.chapterReads = lsData.chapterReads;
        }

        // 2. EPUB 书签（从 IndexedDB）
        data.bookmarks = _filterBookmarks(allBookmarks, bookId);

        // 3. EPUB 高亮/划线（从 IndexedDB）
        data.highlights = _filterHighlights(allPages, bookId);

        // 4. 章内滚动位置（从 localStorage 前缀扫描）
        data.scroll = _collectScroll(bookId);

        return data;
    }

    // ── 主入口 ──────────────────────────────────────────────────────────

    /**
     * 导出同步数据 ZIP
     * @param {string[]} bookIds  要导出的书籍 ID 列表
     * @param {Object}   [opts]
     *   - {string} mode  'data'（仅用户数据）或 'full'（含书籍正文，任务3实现）
     * @returns {Promise}
     */
    function exportData(bookIds, opts) {
        opts = opts || {};
        var mode = opts.mode || 'data';

        var JSZip = win.JSZip;
        if (!JSZip) return Promise.reject(new Error('JSZip 未加载，无法打包同步数据'));

        if (!bookIds || !bookIds.length) {
            return Promise.reject(new Error('未选择任何书籍'));
        }

        console.log('[BK.Sync] exportData: 开始打包 ' + bookIds.length + ' 本书（mode=' + mode + '）');
        var t0 = Date.now();

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

            // 逐书写入 userdata.json
            for (var i = 0; i < bookIds.length; i++) {
                var bookId = bookIds[i];
                var userData = _buildUserData(bookId, allBookmarks, allPages);
                var bookFolder = booksFolder.folder(bookId);
                bookFolder.file('userdata.json', JSON.stringify(userData, null, 2));
            }

            // 写入 shelf.json（BKShelf.all() 原样）
            var shelfData = [];
            if (win.BKShelf && typeof win.BKShelf.all === 'function') {
                shelfData = win.BKShelf.all();
            }
            zip.file('shelf.json', JSON.stringify(shelfData, null, 2));

            // 写入 manifest.json
            var manifest = {
                version: MANIFEST_VERSION,
                type: SYNC_TYPE,
                exportDate: new Date().toISOString(),
                bookCount: bookIds.length
            };
            zip.file('manifest.json', JSON.stringify(manifest, null, 2));

            console.log('[BK.Sync] exportData: 打包完成，开始生成 ZIP...');
            return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
        }).then(function (bytes) {
            var date = new Date();
            var dateStr = date.getFullYear() + '-' +
                ('0' + (date.getMonth() + 1)).slice(-2) + '-' +
                ('0' + date.getDate()).slice(-2);
            var filename = 'bk-sync-export-' + dateStr + '.zip';

            console.log('[BK.Sync] exportData: ZIP 生成完成，大小=' + (bytes.length / 1024).toFixed(2) +
                'KB，文件名=' + filename + '，总耗时 ' + (Date.now() - t0) + 'ms');

            if (win.BK && win.BK.Export && win.BK.Export.exportBinary) {
                return win.BK.Export.exportBinary(bytes, filename, 'application/zip', {
                    chooseDestination: true,
                    successMsg: '已导出同步数据'
                });
            }
            console.log('[BK.Sync] exportData: exportBinary 不可用，走 fallback 下载');
            return _fallbackBinaryDownload(bytes, filename, 'application/zip');
        });
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

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.Sync = win.BK.Sync || {};
    win.BK.Sync.exportData = exportData;

})(window);
