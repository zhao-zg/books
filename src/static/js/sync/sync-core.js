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
 *   .importFromZip(fileOrBytes, opts) → Promise<{success, skipped, failed, errors}>
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

    // ══════════════════════════════════════════════════════════════════════
    //  v4 导入实现（无委托链）
    // ══════════════════════════════════════════════════════════════════════

    var MAX_BOOKMARKS = 100;

    /**
     * 按 id 合并两个数组（导入版替换重复 id 的条目）
     * @param {Array} local    本地数组
     * @param {Array} imported 导入数组
     * @returns {Array} 合并后的数组
     */
    function _mergeById(local, imported) {
        if (!Array.isArray(local)) local = [];
        if (!Array.isArray(imported)) imported = [];
        var map = {};
        for (var i = 0; i < local.length; i++) {
            var item = local[i];
            if (item && item.id) map[item.id] = item;
        }
        for (var j = 0; j < imported.length; j++) {
            var imp = imported[j];
            if (imp && imp.id) map[imp.id] = imp;
        }
        return Object.keys(map).map(function (k) { return map[k]; });
    }

    /**
     * 书签数组截断为 MAX_BOOKMARKS 条（按 timestamp 降序保留最新）
     */
    function _truncateBookmarks(arr) {
        if (!Array.isArray(arr) || arr.length <= MAX_BOOKMARKS) return arr;
        var sorted = arr.slice().sort(function (a, b) {
            var ta = (a && a.timestamp) ? a.timestamp : 0;
            var tb = (b && b.timestamp) ? b.timestamp : 0;
            return tb - ta;
        });
        return sorted.slice(0, MAX_BOOKMARKS);
    }

    /**
     * 合并阅读进度到 localStorage
     * 仅在导入 lastReadTs 比本地新时覆盖 progress/lastReadTs
     * @param {Object} userData  导入的用户数据
     * @param {string} bookId    目标书籍 ID（可能经过 ID 映射）
     */
    function _mergeProgress(userData, bookId) {
        try {
            var ls = win.localStorage;
            if (!ls || !userData) return;

            var importTs = userData.lastReadTs ? parseInt(userData.lastReadTs, 10) : 0;
            var localTs = 0;
            var localTsRaw = ls.getItem('bk_lastread_ts:' + bookId);
            if (localTsRaw) localTs = parseInt(localTsRaw, 10);

            // 进度：导入比本地新时覆盖
            if (importTs >= localTs) {
                if (userData.progress !== undefined) {
                    ls.setItem('bk_progress:' + bookId, userData.progress);
                }
                if (userData.lastReadTs !== undefined) {
                    ls.setItem('bk_lastread_ts:' + bookId, userData.lastReadTs);
                }
            }

            // PDF 位置
            if (userData.pdfPos !== undefined) {
                ls.setItem('bk_pdf_pos:' + bookId, userData.pdfPos);
            }

            // PDF 书签/高亮：按 id 合并
            if (userData.pdfBookmarks !== undefined) {
                var localPbm = ls.getItem('bk_pdf_bm:' + bookId);
                var localArr = localPbm ? JSON.parse(localPbm) : [];
                var importArr = JSON.parse(userData.pdfBookmarks);
                var merged = _mergeById(localArr, importArr);
                ls.setItem('bk_pdf_bm:' + bookId, JSON.stringify(merged));
            }
            if (userData.pdfHighlights !== undefined) {
                var localPhl = ls.getItem('bk_pdf_hl:' + bookId);
                var localHlArr = localPhl ? JSON.parse(localPhl) : [];
                var importHlArr = JSON.parse(userData.pdfHighlights);
                var mergedHl = _mergeById(localHlArr, importHlArr);
                ls.setItem('bk_pdf_hl:' + bookId, JSON.stringify(mergedHl));
            }

            // 章节已读标记：并集
            if (Array.isArray(userData.chapterReads)) {
                var prefix = 'bk_chapter_read:' + bookId + '/';
                for (var i = 0; i < userData.chapterReads.length; i++) {
                    var chNum = String(userData.chapterReads[i]);
                    if (chNum) ls.setItem(prefix + chNum, '1');
                }
            }

            // 滚动位置：同章在导入比本地新时覆盖，新章直接写入
            if (userData.scroll && typeof userData.scroll === 'object') {
                var scrollPrefix = 'bk_scroll:' + bookId + '/';
                var chKeys = Object.keys(userData.scroll);
                for (var j = 0; j < chKeys.length; j++) {
                    var ch = chKeys[j];
                    var importScroll = userData.scroll[ch];
                    var localScroll = ls.getItem(scrollPrefix + ch);
                    if (localScroll === null || importTs >= localTs) {
                        ls.setItem(scrollPrefix + ch, importScroll);
                    }
                }
            }
        } catch (e) {
            console.warn('[BK.SyncCore] _mergeProgress: 合并进度失败:', bookId, e);
        }
    }

    /**
     * 合并 EPUB 书签到 IndexedDB（BKBookmark store）
     * 按 id 去重，导入版替换重复 id，超 100 条截断
     * @param {Array} importedBookmarks  导入的书签数组
     * @param {Object} idMap            ID 映射表 { oldId: newId }
     */
    function _mergeBookmarks(importedBookmarks, idMap) {
        if (!Array.isArray(importedBookmarks)) return Promise.resolve();

        // ID 映射改写
        var remapped = importedBookmarks.map(function (bm) {
            var copy = Object.assign({}, bm);
            if (idMap && bm.bookId && idMap[bm.bookId]) {
                var newId = idMap[bm.bookId];
                copy.bookId = newId;
                if (copy.path) {
                    copy.path = copy.path.replace('/' + bm.bookId + '/', '/' + newId + '/');
                }
            }
            return copy;
        });

        if (!win.BKBookmark || typeof win.BKBookmark.getAll !== 'function') {
            return Promise.resolve();
        }
        return win.BKBookmark.getAll().then(function (local) {
            var merged = _mergeById(local, remapped);
            merged = _truncateBookmarks(merged);
            if (win.BKBookmark._save) {
                return win.BKBookmark._save(merged);
            }
            return Promise.resolve();
        }).catch(function (e) {
            console.warn('[BK.SyncCore] _mergeBookmarks: 合并书签失败:', e);
        });
    }

    /**
     * 合并 EPUB 高亮到 IndexedDB（highlights store，每页一键）
     * 逐 key 合并，同 key 内按 id 去重
     * @param {Array} importedHighlights  导入的高亮页数组 [{ key, highlights }]
     * @param {Object} idMap              ID 映射表
     */
    function _mergeHighlights(importedHighlights, idMap) {
        if (!Array.isArray(importedHighlights)) return Promise.resolve();
        if (!win.BKStorage || typeof win.BKStorage.getPage !== 'function') {
            return Promise.resolve();
        }

        var chain = Promise.resolve();
        importedHighlights.forEach(function (page) {
            if (!page || !page.key || !Array.isArray(page.highlights)) return;
            chain = chain.then(function () {
                // ID 映射改写 key
                var targetKey = page.key;
                if (idMap) {
                    var match = page.key.match(/^\/([^\/]+)\/(.+)$/);
                    if (match && idMap[match[1]]) {
                        targetKey = '/' + idMap[match[1]] + '/' + match[2];
                    }
                }
                return win.BKStorage.getPage(targetKey).then(function (localArr) {
                    var merged = _mergeById(localArr, page.highlights);
                    return win.BKStorage.setPage(targetKey, merged);
                });
            });
        });
        return chain.catch(function (e) {
            console.warn('[BK.SyncCore] _mergeHighlights: 合并高亮失败:', e);
        });
    }

    /**
     * 合并书架记录（补缺不覆盖已有）
     * shelfData 是导入的 shelf.json 数组
     * 注意：所有书（含书城书）统一走 BKShelf.add + 补缺合并：
     *   - add 幂等，purged 守卫由 shelf.js 内部兜底（不复活已移除书）
     *   - 书城书此前被整体跳过导致 note/rating/finished 无法补缺（审查 P2）
     * @param {Array} shelfData
     * @param {Object} idMap  原始 ID → 目标 ID 映射
     * @param {Object} [excludeIds]  原始 ID 集合：命中的记录不补缺不入架
     *                               （data 模式下本地不存在的导入书，幽灵 ID 防护）
     */
    function _mergeShelf(shelfData, idMap, excludeIds) {
        if (!Array.isArray(shelfData)) return Promise.resolve();

        var chain = Promise.resolve();
        shelfData.forEach(function (rec) {
            var rawId = rec && (rec.bookId || rec.id);
            if (!rawId) return;
            var bookId = rawId;
            // ID 映射
            if (idMap && idMap[rawId]) {
                bookId = idMap[rawId];
            }
            // 幽灵 ID 防护：data 模式下本地不存在的导入书不入架不补缺
            if (excludeIds && excludeIds[rawId]) return;
            chain = chain.then(function () {
                if (win.BKShelf && typeof win.BKShelf.add === 'function') {
                    win.BKShelf.add(bookId);
                }
                if (win.BKShelf && typeof win.BKShelf.get === 'function') {
                    var local = win.BKShelf.get(bookId);
                    if (local) {
                        if ((local.note === null || local.note === undefined) && rec.note) {
                            if (typeof win.BKShelf.updateNote === 'function') {
                                win.BKShelf.updateNote(bookId, rec.note);
                            }
                        }
                        if ((local.rating === null || local.rating === undefined) && typeof rec.rating === 'number') {
                            if (typeof win.BKShelf.updateRating === 'function') {
                                win.BKShelf.updateRating(bookId, rec.rating);
                            }
                        }
                        if (!local.finished && rec.finished) {
                            if (typeof win.BKShelf.markRead === 'function') {
                                win.BKShelf.markRead(bookId, { completedAt: rec.completedAt });
                            }
                        }
                    }
                }
            });
        });
        return chain;
    }

    /**
     * 确定书城索引是否已就绪，未就绪时尝试加载
     * @returns {Promise<void>}
     */
    function _ensureIndexReady() {
        if (win.DataManager && typeof win.DataManager.getCachedIndex === 'function') {
            var idx = win.DataManager.getCachedIndex();
            if (idx && Array.isArray(idx.books) && idx.books.length > 0) {
                return Promise.resolve();
            }
            if (typeof win.DataManager.loadIndex === 'function') {
                return win.DataManager.loadIndex().catch(function () {});
            }
        }
        return Promise.resolve();
    }

    /**
     * 确定每本书的目标 ID
     * - 有 book.json 且非书城书：生成新 imported- ID（仅 full 模式）
     * - 书城书或无 book.json：恒等映射
     * - data 模式：导入书（非书城书且有 book.json）仅当本地已存在才恒等映射，
     *   否则记入 skippedIds（幽灵 ID 防护：不合并不入架）
     * @param {Object} zip          JSZip 实例
     * @param {string[]} bookDirNames  books/ 下的子目录名
     * @param {string} mode         'data' | 'full'
     * @param {Object} opts         依赖注入（importStore 用于本地存在性检查）
     * @returns {Promise<{ idMap, bookDataMap, fullBookDirs, skippedIds }>}
     */
    function _resolveIdMap(zip, bookDirNames, mode, opts) {
        var idMap = {};
        var bookDataMap = {};
        var fullBookDirs = [];
        var skippedIds = {};

        var chain = Promise.resolve();
        bookDirNames.forEach(function (dirName) {
            chain = chain.then(function () {
                var bookJsonEntry = zip.file('books/' + dirName + '/book.json');
                if (!bookJsonEntry) return;
                return bookJsonEntry.async('string').then(function (text) {
                    try {
                        var bd = JSON.parse(text);
                        if (bd && bd.id) {
                            bookDataMap[bd.id] = bd;
                            fullBookDirs.push({ dirName: dirName, bookId: bd.id });
                        }
                    } catch (e) { /* 忽略解析失败 */ }
                });
            });
        });

        return chain.then(function () {
            var indexData = null;
            if (win.DataManager && typeof win.DataManager.getCachedIndex === 'function') {
                indexData = win.DataManager.getCachedIndex();
            }
            var chain2 = Promise.resolve();
            fullBookDirs.forEach(function (entry) {
                chain2 = chain2.then(function () {
                    var oldId = entry.bookId;
                    var isCity = false;
                    if (win.BK && win.BK.SyncShared && typeof win.BK.SyncShared.resolveCityBook === 'function') {
                        isCity = win.BK.SyncShared.resolveCityBook(indexData, oldId);
                    }
                    if (isCity) {
                        // 书城书 ID 跨设备稳定，恒等映射
                        idMap[oldId] = oldId;
                        return;
                    }
                    if (mode !== 'data') {
                        // full 模式：生成新 imported- ID
                        var newId = null;
                        if (win.BK && win.BK.SyncShared && typeof win.BK.SyncShared.generateBookId === 'function') {
                            newId = win.BK.SyncShared.generateBookId();
                        } else {
                            newId = 'imported-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
                        }
                        idMap[oldId] = newId;
                        console.log('[BK.SyncCore] importFromZip: 导入书 ID 映射 ' + oldId + ' → ' + newId);
                        return;
                    }
                    // data 模式：导入书仅当本地已存在才合并（幽灵 ID 防护）
                    var importStore = _resolveImportStore(opts);
                    if (!importStore) {
                        // 无法确认本地是否存在 → 保守跳过
                        skippedIds[oldId] = true;
                        return;
                    }
                    return importStore.getItem((win.BK && win.BK.SyncShared)
                        ? win.BK.SyncShared.KEY_IMPORT_PREFIX + oldId
                        : 'imported_book:' + oldId).then(function (local) {
                        if (local) {
                            idMap[oldId] = oldId;
                        } else {
                            skippedIds[oldId] = true;
                            console.log('[BK.SyncCore] importFromZip: data 模式跳过本地不存在的导入书 ' + oldId);
                        }
                    }).catch(function () {
                        // 本地存在性检查失败 → 保守跳过
                        skippedIds[oldId] = true;
                    });
                });
            });
            return chain2.then(function () {
                return { idMap: idMap, bookDataMap: bookDataMap, fullBookDirs: fullBookDirs, skippedIds: skippedIds };
            });
        });
    }

    /**
     * 保存书本体（book.json + PDF 二进制）到本地存储
     * 仅 full 模式且非书城书执行
     * @param {Object} zip
     * @param {Array} fullBookDirs  [{ dirName, bookId }]
     * @param {Object} idMap
     * @param {Object} bookDataMap
     * @param {Object} opts         依赖注入 stores
     * @returns {Promise<{saved:number, skipped:number, failed:number, errors:Array}>}
     */
    function _saveBookData(zip, fullBookDirs, idMap, bookDataMap, opts) {
        var tally = { saved: 0, skipped: 0, failed: 0, errors: [] };

        var chain = Promise.resolve();
        fullBookDirs.forEach(function (entry) {
            var oldId = entry.bookId;
            var newId = idMap[oldId];
            var bookData = bookDataMap[oldId];
            if (!bookData || !newId) return;

            // 书城书：保持原 ID，缓存到 zl-data
            if (newId === oldId) {
                chain = chain.then(function () {
                    return _saveCityBook(zip, entry, bookData, opts).then(function (res) {
                        tally[res.status]++;
                        if (res.status === 'failed') {
                            tally.errors.push({ id: oldId, error: res.error });
                        }
                    });
                });
                return;
            }

            // 导入书：生成新 imported- ID → imported-data store + 入架
            chain = chain.then(function () {
                return _saveImportedBook(zip, entry, bookData, newId, opts).then(function (res) {
                    tally[res.status]++;
                    if (res.status === 'failed') {
                        tally.errors.push({ id: oldId, error: res.error });
                    }
                });
            });
        });
        return chain.then(function () { return tally; });
    }

    /**
     * 解析 importStore（生产默认：ImportManager.getImportStore）
     */
    function _resolveImportStore(opts) {
        if (opts.importStore) return opts.importStore;
        if (win.ImportManager && typeof win.ImportManager.getImportStore === 'function') {
            try { return win.ImportManager.getImportStore() || null; } catch (e) { return null; }
        }
        return null;
    }

    /**
     * 解析 zlStore（生产默认：DataManager.getZlStore）
     */
    function _resolveZlStore(opts) {
        if (opts.zlStore) return opts.zlStore;
        if (win.DataManager && typeof win.DataManager.getZlStore === 'function') {
            try { return win.DataManager.getZlStore() || null; } catch (e) { return null; }
        }
        return null;
    }

    /**
     * 解析 pdfStore（生产默认：ImportManager.getPdfDataStore）
     */
    function _resolvePdfStore(opts) {
        if (opts.pdfStore) return opts.pdfStore;
        if (win.ImportManager && typeof win.ImportManager.getPdfDataStore === 'function') {
            try { return win.ImportManager.getPdfDataStore() || null; } catch (e) { return null; }
        }
        return null;
    }

    /**
     * 保存书城书到本地
     * - 已下载则跳过不覆盖（计 skipped）
     * - 优先走 DataManager.cacheBook（含 addDownloadedId/建索引副作用）；
     *   cacheBook 不可用时回退直写 zlStore
     * - purged 书：仅直写 zl-data 留作离线兑底，不清 purged 标记、不入架
     * - PDF 书：original.pdf 写入 pdfStore（原 ID）
     * @returns {Promise<{status:'saved'|'skipped'|'failed', error?:string}>}
     */
    function _saveCityBook(zip, entry, bookData, opts) {
        var bookId = bookData.id;
        var zlStore = _resolveZlStore(opts);
        var pdfStore = _resolvePdfStore(opts);
        var isPdf = (win.BK && win.BK.SyncShared && typeof win.BK.SyncShared.isPdfBookData === 'function')
            ? win.BK.SyncShared.isPdfBookData(bookData)
            : (bookData.format === 'pdf');

        // PDF 书：写入 pdfStore（原 ID）
        var pdfPromise = Promise.resolve();
        if (isPdf && pdfStore) {
            var pdfPath = 'books/' + entry.dirName + '/original.pdf';
            var pdfEntry = zip.file(pdfPath);
            if (pdfEntry) {
                pdfPromise = pdfEntry.async('uint8array').then(function (pdfBytes) {
                    return pdfStore.setItem('pdf:' + bookId, pdfBytes.buffer || pdfBytes);
                }).catch(function () {});
            }
        }

        return pdfPromise.then(function () {
            // purged 书：绕过 cacheBook（内部会清 purged 标记），仅直写留离线兑底
            var purged = false;
            try {
                purged = win.localStorage.getItem('bk_purged:' + bookId) === '1';
            } catch (e) {}
            if (purged) {
                return _writeCityBookToZlStore(bookId, bookData, zlStore).then(function () {
                    return { status: 'saved' };
                });
            }

            // 优先 cacheBook（真实副作用：已下载列表 + 内容索引 + 书目索引）
            var dm = win.DataManager;
            if (dm && typeof dm.cacheBook === 'function') {
                return (typeof dm.isBookDownloaded === 'function'
                    ? dm.isBookDownloaded(bookId)
                    : Promise.resolve(false)).then(function (downloaded) {
                    if (downloaded) {
                        console.log('[BK.SyncCore] _saveCityBook: 书城书已缓存，跳过 id=' + bookId);
                        return { status: 'skipped' };
                    }
                    return dm.cacheBook(bookId, bookData).then(function () {
                        console.log('[BK.SyncCore] _saveCityBook: 书城书已缓存(cacheBook) id=' + bookId);
                        return { status: 'saved' };
                    }, function (err) {
                        console.warn('[BK.SyncCore] _saveCityBook: cacheBook 失败 id=' + bookId, err);
                        return { status: 'failed', error: 'cacheBook 失败: ' + (err && err.message ? err.message : err) };
                    });
                });
            }

            // cacheBook 不可用 → 回退直写
            return _writeCityBookToZlStore(bookId, bookData, zlStore).then(function () {
                return { status: 'saved' };
            }, function (err) {
                return { status: 'failed', error: '写入 zlStore 失败: ' + (err && err.message ? err.message : err) };
            });
        });
    }

    function _writeCityBookToZlStore(bookId, bookData, zlStore) {
        if (!zlStore) return Promise.resolve();
        var key = (win.BK && win.BK.SyncShared) ? win.BK.SyncShared.KEY_ZL_PREFIX + bookId : 'zl_book:' + bookId;
        return zlStore.setItem(key, bookData).then(function () {
            console.log('[BK.SyncCore] _saveCityBook: 书城书已缓存到 zl-data id=' + bookId);
        });
    }

    /**
     * 保存导入书到 imported-data store + 入架 + 建索引
     * - 改写 bookData.id 为新 ID
     * - PDF 书：重映射 pdf_page.pdfBookId
     * - PDF 书：original.pdf 写入 pdfStore（新 ID）
     * @returns {Promise<{status:'saved'|'failed', error?:string}>}
     */
    function _saveImportedBook(zip, entry, bookData, newId, opts) {
        var importStore = _resolveImportStore(opts);
        var pdfStore = _resolvePdfStore(opts);
        if (!importStore) {
            return Promise.resolve({ status: 'failed', error: 'importStore 不可用，无法保存导入书' });
        }
        var exportData = JSON.parse(JSON.stringify(bookData));
        exportData.id = newId;

        var isPdf = (win.BK && win.BK.SyncShared && typeof win.BK.SyncShared.isPdfBookData === 'function')
            ? win.BK.SyncShared.isPdfBookData(bookData)
            : (bookData.format === 'pdf');

        // PDF 书：重映射 pdf_page.pdfBookId
        if (isPdf && exportData.chapters) {
            for (var i = 0; i < exportData.chapters.length; i++) {
                var content = exportData.chapters[i].content;
                if (!Array.isArray(content)) continue;
                for (var j = 0; j < content.length; j++) {
                    if (content[j] && content[j].type === 'pdf_page') {
                        content[j].pdfBookId = newId;
                    }
                }
            }
        }

        var savePromise = Promise.resolve();
        if (importStore) {
            var key = (win.BK && win.BK.SyncShared) ? win.BK.SyncShared.KEY_IMPORT_PREFIX + newId : 'imported_book:' + newId;
            savePromise = importStore.setItem(key, exportData).then(function () {
                return importStore.getItem('imported_ids').then(function (ids) {
                    ids = ids || [];
                    if (ids.indexOf(newId) < 0) ids.push(newId);
                    return importStore.setItem('imported_ids', ids);
                });
            });
        }

        return savePromise.then(function () {
            // 入架
            try {
                if (win.BKShelf && win.BKShelf.add) win.BKShelf.add(newId);
            } catch (e) {}
            // 建内容索引 + 书目索引（对照 import-zip.js _saveBook）
            try {
                if (win.DataManager) {
                    if (typeof win.DataManager.buildContentIndex === 'function') {
                        win.DataManager.buildContentIndex(exportData);
                    }
                    if (typeof win.DataManager.addToBookIndex === 'function') {
                        win.DataManager.addToBookIndex(exportData);
                    }
                }
            } catch (e) {}
            // PDF 书：保存原始 PDF 二进制
            if (isPdf && pdfStore) {
                var pdfPath = 'books/' + entry.dirName + '/original.pdf';
                var pdfEntry = zip.file(pdfPath);
                if (pdfEntry) {
                    return pdfEntry.async('uint8array').then(function (pdfBytes) {
                        var pdfKey = (win.BK && win.BK.SyncShared) ? win.BK.SyncShared.KEY_PDF_PREFIX + newId : 'pdf:' + newId;
                        return pdfStore.setItem(pdfKey, pdfBytes.buffer || pdfBytes);
                    }).catch(function () {});
                }
            }
            return { status: 'saved' };
        }).catch(function (err) {
            console.warn('[BK.SyncCore] _saveImportedBook: 保存失败 id=' + newId, err);
            return { status: 'failed', error: '保存导入书失败: ' + (err && err.message ? err.message : err) };
        });
    }

    /**
     * 从 ZIP 中读取所有 books/<dir>/userdata.json 的目录名
     * @param {Object} zip
     * @returns {string[]}
     */
    function _collectBookDirs(zip) {
        var dirs = {};
        zip.forEach(function (relativePath) {
            var match = relativePath.match(/^books\/([^\/]+)\/userdata\.json$/);
            if (match) {
                dirs[match[1]] = true;
            }
        });
        return Object.keys(dirs);
    }

    /**
     * 从 v4 ZIP 导入数据（合并模式）
     *
     * 导入规则：
     *   - manifest.version === 4 → 按 mode 导入
     *     · data 包：合并数据（进度按 lastReadTs 取新、书签按 id 去重截断 100、
     *       chapterReads 并集、shelf 补缺不覆盖已有）
     *     · full 包：连书文件一起导入（非书城书生成新 imported- ID 入架，
     *       书城书保持原 ID 缓存到 zl-data 不入架）
     *   - manifest.version < 4 → 抛错含「旧版本」
     *   - 无 manifest → 抛错「不是有效的书籍数据包」
     *   - 孤儿条目（books/ 有目录但 shelf.json 无记录）忽略并继续
     *
     * @param {File|ArrayBuffer|Uint8Array} fileOrBytes  ZIP 文件数据
     * @param {Object} [opts]
     *   - {Object} importStore  localforage 实例（导入书数据）
     *   - {Object} zlStore      localforage 实例（书城书数据）
     *   - {Object} pdfStore     localforage 实例（PDF 二进制）
     *   - {Function} onProgress(current, total, bookTitle)  进度回调
     * @returns {Promise<{success:number, skipped:number, failed:number, errors:Array}>}
     */
    function importFromZip(fileOrBytes, opts) {
        opts = opts || {};
        var JSZip = win.JSZip;
        if (!JSZip) return Promise.reject(new Error('JSZip 未加载，无法解析 ZIP'));

        // 规范化输入为 JSZip 可接受的格式
        var input = fileOrBytes;

        console.log('[BK.SyncCore] importFromZip: 开始导入，大小=' +
            (input.byteLength || input.length || (input.size ? input.size : 0)) + ' 字节');
        var t0 = Date.now();

        return JSZip.loadAsync(input).then(function (zip) {
            // 1. 验证 manifest.json
            var manifestFile = zip.file('manifest.json');
            if (!manifestFile) {
                return Promise.reject(new Error('不是有效的书籍数据包'));
            }

            return manifestFile.async('string').then(function (manifestText) {
                var manifest;
                try {
                    manifest = JSON.parse(manifestText);
                } catch (e) {
                    return Promise.reject(new Error('不是有效的书籍数据包'));
                }

                if (!manifest || !manifest.version) {
                    return Promise.reject(new Error('不是有效的书籍数据包'));
                }

                // 旧版本包 → 明确报错
                if (manifest.version < MANIFEST_VERSION) {
                    return Promise.reject(new Error(
                        '此包由旧版本导出，请在新旧设备间用局域网同步或重新导出'
                    ));
                }

                if (manifest.version !== MANIFEST_VERSION) {
                    return Promise.reject(new Error('不支持的包版本（期望 v' + MANIFEST_VERSION + '）'));
                }

                var mode = manifest.mode || 'data';
                console.log('[BK.SyncCore] importFromZip: v' + manifest.version + ' 包，mode=' + mode);

                // 2. 收集 books 目录
                var bookDirNames = _collectBookDirs(zip);
                if (!bookDirNames.length) {
                    // 可能只有 shelf.json 无 books 目录（书架补缺场景）
                    var shelfOnlyFile = zip.file('shelf.json');
                    if (shelfOnlyFile) {
                        return _ensureIndexReady().then(function () {
                            return shelfOnlyFile.async('string').then(function (shelfText) {
                                var shelfData;
                                try { shelfData = JSON.parse(shelfText); } catch (e) { shelfData = []; }
                                return _mergeShelf(shelfData, {});
                            });
                        }).then(function () {
                            return { success: 0, skipped: 0, failed: 0, errors: [] };
                        });
                    }
                    return { success: 0, skipped: 0, failed: 0, errors: [] };
                }

                console.log('[BK.SyncCore] importFromZip: 发现 ' + bookDirNames.length + ' 本书的同步数据');

                // 3. 确保书城索引就绪（full 模式分流 + 书城书判定需要）
                return _ensureIndexReady().then(function () {
                    // 4. 解析 ID 映射（full 模式导入书重映射；data 模式本地不存在的
                    //    导入书记入 skippedIds —— 幽灵 ID 防护）
                    return _resolveIdMap(zip, bookDirNames, mode, opts);
                }).then(function (idMapResult) {
                    var idMap = idMapResult.idMap;
                    var bookDataMap = idMapResult.bookDataMap;
                    var fullBookDirs = idMapResult.fullBookDirs;
                    var skippedIds = idMapResult.skippedIds || {};

                    // data 模式资格跳过计数（books/ 有目录但本地不存在）
                    var dataSkippedDirs = 0;
                    if (mode === 'data') {
                        bookDirNames.forEach(function (dirName) {
                            if (skippedIds[dirName]) dataSkippedDirs++;
                        });
                    }
                    // 幽灵 ID 防护：跳过书的 shelf 记录不补缺不入架
                    var excludeIds = skippedIds;

                    // 5. full 模式：保存书本体
                    var saveBooksPromise;
                    if (mode === 'full' && fullBookDirs.length > 0) {
                        saveBooksPromise = _saveBookData(zip, fullBookDirs, idMap, bookDataMap, opts);
                    } else {
                        saveBooksPromise = Promise.resolve({ saved: 0, skipped: 0, failed: 0, errors: [] });
                    }

                    var saveTally = null;
                    return saveBooksPromise.then(function (tally) {
                        saveTally = tally;
                        // 6. 读取 shelf.json
                        var shelfFile = zip.file('shelf.json');
                        return shelfFile
                            ? shelfFile.async('string').then(function (text) {
                                try { return JSON.parse(text); } catch (e) { return []; }
                            })
                            : Promise.resolve([]);
                    }).then(function (shelfData) {
                        // 7. 合并书架
                        return _mergeShelf(shelfData, idMap, excludeIds).then(function () {
                            // 8. 逐书合并 userdata
                            var successCount = 0;
                            var failCount = 0;
                            var errors = [];
                            var current = 0;
                            var total = bookDirNames.length;
                            var chain = Promise.resolve();

                            for (var i = 0; i < bookDirNames.length; i++) {
                                (function (dirName) {
                                    chain = chain.then(function () {
                                        current++;
                                        var udPath = 'books/' + dirName + '/userdata.json';
                                        var udEntry = zip.file(udPath);
                                        if (!udEntry) {
                                            failCount++;
                                            errors.push({ id: dirName, error: 'userdata.json 未找到' });
                                            if (opts.onProgress) opts.onProgress(current, total, dirName);
                                            return;
                                        }
                                        return udEntry.async('string').then(function (udText) {
                                            var userData;
                                            try {
                                                userData = JSON.parse(udText);
                                            } catch (e) {
                                                failCount++;
                                                errors.push({ id: dirName, error: 'userdata.json 解析失败' });
                                                if (opts.onProgress) opts.onProgress(current, total, dirName);
                                                return;
                                            }

                                            // 确定目标 bookId
                                            var targetId = idMap[dirName] || dirName;

                                            // 合并进度（localStorage）
                                            _mergeProgress(userData, targetId);

                                            // 合并 EPUB 书签（IndexedDB）
                                            return _mergeBookmarks(userData.bookmarks, idMap).then(function () {
                                                // 合并 EPUB 高亮（IndexedDB）
                                                return _mergeHighlights(userData.highlights, idMap);
                                            }).then(function () {
                                                successCount++;
                                                if (opts.onProgress) opts.onProgress(current, total, dirName);
                                            });
                                        });
                                    });
                                })(bookDirNames[i]);
                            }

                            return chain.then(function () {
                                var finalResult = {
                                    success: successCount,
                                    skipped: dataSkippedDirs + (saveTally ? saveTally.skipped : 0),
                                    failed: failCount + (saveTally ? saveTally.failed : 0),
                                    errors: errors.concat(saveTally ? saveTally.errors : [])
                                };
                                console.log('[BK.SyncCore] importFromZip: 导入完成，成功=' + finalResult.success +
                                    '，跳过=' + finalResult.skipped + '，失败=' + finalResult.failed +
                                    '，耗时=' + (Date.now() - t0) + 'ms');
                                // 广播事件通知 UI 刷新
                                try {
                                    win.dispatchEvent(new win.CustomEvent('bk:data-synced'));
                                } catch (e) {}
                                return finalResult;
                            });
                        });
                    });
                });
            });
        });
    }

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.SyncCore = {
        generateZipBytes: generateZipBytes,
        exportData: exportData,
        importFromZip: importFromZip
    };

})(window);
