/**
 * sync-import.js — 同步数据导入（合并模式）
 *
 * 解析 sync-export.js 生成的 ZIP（manifest version:3, type:'sync-data'），
 * 按 id 去重合并书签/高亮，进度按 lastReadTs 取新，书架记录补全缺失字段。
 *
 * 对于旧版 ZIP（manifest version 1/2），委托给 BK.ImportZip.importFromZip，
 * 保持向后兼容。
 *
 * 合并规则：
 *   - 书签：BKBookmark.getAll() 与导入数组按 id 去重（导入版替换重复 id），超 100 条截断
 *   - 高亮：逐 key 合并，同 key 内按 id 去重（导入版替换重复 id）
 *   - 进度：bk_progress/bk_lastread_ts 仅在导入 lastReadTs 比本地新时覆盖
 *   - 滚动：bk_scroll:<id>/<ch> 同章取导入 lastReadTs 更新时覆盖，新章直接写入
 *   - 章节已读：并集（本地 ∪ 导入）
 *   - PDF 书签/高亮：bk_pdf_bm / bk_pdf_hl 数组按 id 合并
 *   - 书架：BKShelf.add（幂等）→ 本地无 note/rating/finished 时用导入值
 *
 * 书 ID 映射（任务5）：
 *   - mode='full' 且含 book.json 的导入书（非书城书）：生成新 imported- ID，
 *     书签/高亮/进度/滚动中的旧 bookId 改写为新 ID
 *   - 书城书：ID 恒等映射
 *   - mode='data'（无 book.json）：无法判断是否为书城书，保持原 ID（恒等映射）
 *
 * 依赖：
 *   - JSZip (vendor/jszip.min.js)
 *   - BKBookmark.getAll / _save (bookmark.js)
 *   - BKStorage.getAllPages / setPage (highlight-shared.js)
 *   - BKShelf.all / add / get / updateNote / updateRating / markRead (shelf.js)
 *   - BK.SyncData.collectUserData (sync-data-collect.js)
 *   - ImportManager.getImportedBook / getPdfDataStore / getImportStore (import-orchestrator.js)
 *   - DataManager.getCachedIndex / loadIndex / isBookDownloaded / cacheBook (dm-api.js)
 *   - BK.ImportZip.importFromZip (import-zip.js，旧版兼容)
 *
 * 挂载：window.BK.Sync.importFromZip(buffer, opts)
 */
(function (win) {
    'use strict';

    var MANIFEST_VERSION = 3;
    var SYNC_TYPE = 'sync-data';
    var MAX_BOOKMARKS = 100;

    // ── 工具函数 ──────────────────────────────────────────────────────────

    /**
     * 生成新 imported- ID（与 import-zip.js 格式一致）
     */
    function _generateId() {
        return 'imported-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    }

    /**
     * 判断 bookId 是否为书城书（存在于书城索引）
     * 与 import-zip.js 的 _isCityBookId 逻辑一致
     */
    function _isCityBookId(bookId) {
        if (!bookId) return false;
        if (bookId.indexOf('imported-') === 0) return false;
        try {
            if (!win.DataManager || typeof win.DataManager.getCachedIndex !== 'function') return false;
            var indexData = win.DataManager.getCachedIndex();
            var books = (indexData && Array.isArray(indexData.books)) ? indexData.books : [];
            if (!books.length) return false;
            for (var i = 0; i < books.length; i++) {
                if (books[i].id === bookId) return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

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
        // 先放本地
        for (var i = 0; i < local.length; i++) {
            var item = local[i];
            if (item && item.id) map[item.id] = item;
        }
        // 导入替换重复 id
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

    // ── 进度合并 ──────────────────────────────────────────────────────────

    /**
     * 合并阅读进度到 localStorage
     * 仅在导入 lastReadTs 比本地新时覆盖 progress/lastReadTs
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
                    // 导入比本地新时覆盖；本地无则直接写入
                    if (localScroll === null || importTs >= localTs) {
                        ls.setItem(scrollPrefix + ch, importScroll);
                    }
                }
            }
        } catch (e) {
            console.warn('[BK.Sync] 合并进度失败:', bookId, e);
        }
    }

    // ── 书签合并（IndexedDB） ─────────────────────────────────────────────

    /**
     * 合并 EPUB 书签到 IndexedDB（BKBookmark store）
     * 按 id 去重，导入版替换重复 id，超 100 条截断
     */
    function _mergeBookmarks(importedBookmarks, bookId, idMap) {
        if (!Array.isArray(importedBookmarks)) return Promise.resolve();

        // ID 映射改写
        var remapped = importedBookmarks.map(function (bm) {
            var copy = Object.assign({}, bm);
            if (idMap && idMap[copy.bookId]) {
                var newId = idMap[copy.bookId];
                copy.bookId = newId;
                // path 中的 bookId 也需改写
                if (copy.path) {
                    copy.path = copy.path.replace('/' + bm.bookId + '/', '/' + newId + '/');
                }
            }
            return copy;
        });

        return win.BKBookmark.getAll().then(function (local) {
            var merged = _mergeById(local, remapped);
            merged = _truncateBookmarks(merged);
            if (win.BKBookmark._save) {
                return win.BKBookmark._save(merged);
            }
            return Promise.resolve();
        }).catch(function (e) {
            console.warn('[BK.Sync] 合并书签失败:', bookId, e);
        });
    }

    // ── 高亮合并（IndexedDB） ─────────────────────────────────────────────

    /**
     * 合并 EPUB 高亮到 IndexedDB（highlights store，每页一键）
     * 逐 key 合并，同 key 内按 id 去重
     */
    function _mergeHighlights(importedHighlights, bookId, idMap) {
        if (!Array.isArray(importedHighlights)) return Promise.resolve();

        // 逐页处理
        var chain = Promise.resolve();
        importedHighlights.forEach(function (page) {
            if (!page || !page.key || !Array.isArray(page.highlights)) return;
            chain = chain.then(function () {
                // ID 映射改写 key
                var targetKey = page.key;
                if (idMap) {
                    // key 格式 /<oldBookId>/<chNum>
                    var match = page.key.match(/^\/([^\/]+)\/(.+)$/);
                    if (match && idMap[match[1]]) {
                        targetKey = '/' + idMap[match[1]] + '/' + match[2];
                    }
                }
                // 读取本地该页高亮
                return win.BKStorage.getPage(targetKey).then(function (localArr) {
                    var merged = _mergeById(localArr, page.highlights);
                    return win.BKStorage.setPage(targetKey, merged);
                });
            });
        });
        return chain.catch(function (e) {
            console.warn('[BK.Sync] 合并高亮失败:', bookId, e);
        });
    }

    // ── 书架合并 ──────────────────────────────────────────────────────────

    /**
     * 合并书架记录
     * shelfData 是导入的 shelf.json 数组，每条含 { bookId, note?, rating?, finished?, completedAt? }
     * 注意：书架记录字段为 bookId（shelf.js），兼容旧数据/历史包里的 id。
     */
    function _mergeShelf(shelfData) {
        if (!Array.isArray(shelfData)) return Promise.resolve();

        var chain = Promise.resolve();
        shelfData.forEach(function (rec) {
            var bookId = (rec && (rec.bookId || rec.id));
            if (!bookId) return;
            chain = chain.then(function () {
                // 入架（幂等）
                if (win.BKShelf && typeof win.BKShelf.add === 'function') {
                    win.BKShelf.add(bookId);
                }
                // 本地无 note/rating/finished 时用导入值
                if (win.BKShelf && typeof win.BKShelf.get === 'function') {
                    var local = win.BKShelf.get(bookId);
                    if (local) {
                        // note：本地无时用导入值
                        if ((local.note === null || local.note === undefined) && rec.note) {
                            if (typeof win.BKShelf.updateNote === 'function') {
                                win.BKShelf.updateNote(bookId, rec.note);
                            }
                        }
                        // rating：本地无时用导入值
                        if ((local.rating === null || local.rating === undefined) && typeof rec.rating === 'number') {
                            if (typeof win.BKShelf.updateRating === 'function') {
                                win.BKShelf.updateRating(bookId, rec.rating);
                            }
                        }
                        // finished：本地未标记已读时，导入标记已读
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

    // ── 书 ID 映射 ─────────────────────────────────────────────────────────

    /**
     * 确定每本书的目标 ID
     * - 有 book.json 且非书城书：生成新 imported- ID
     * - 书城书或无 book.json：恒等映射
     * 返回 { idMap: { oldId: newId }, bookDataMap: { oldId: bookJson } }
     */
    function _resolveIdMap(zip, bookDirNames) {
        var idMap = {};
        var bookDataMap = {};
        var fullBookDirs = [];  // 有 book.json 的目录

        // 先收集所有 book.json
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
            // 确定 ID 映射
            fullBookDirs.forEach(function (entry) {
                var oldId = entry.bookId;
                if (_isCityBookId(oldId)) {
                    // 书城书：恒等映射
                    idMap[oldId] = oldId;
                } else {
                    // 导入书：生成新 ID
                    var newId = _generateId();
                    idMap[oldId] = newId;
                    console.log('[BK.Sync] importFromZip: 导入书 ID 映射 ' + oldId + ' → ' + newId);
                }
            });
            return { idMap: idMap, bookDataMap: bookDataMap, fullBookDirs: fullBookDirs };
        });
    }

    /**
     * 保存书本体（book.json + PDF 二进制）到本地存储
     * 仅对有 book.json 且非书城书的条目执行
     */
    function _saveBookData(zip, fullBookDirs, idMap, bookDataMap) {
        var chain = Promise.resolve();
        fullBookDirs.forEach(function (entry) {
            var oldId = entry.bookId;
            var newId = idMap[oldId];
            var bookData = bookDataMap[oldId];
            if (!bookData || !newId) return;
            // 书城书：ID 不变，不保存（已有缓存或由 DataManager 管理）
            if (newId === oldId) return;

            chain = chain.then(function () {
                // 改写 bookData.id
                var exportData = JSON.parse(JSON.stringify(bookData));
                exportData.id = newId;

                // PDF 书：重映射 pdf_page.pdfBookId
                if (exportData.format === 'pdf' && exportData.chapters) {
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

                // 保存到 imported-data store
                var importStore = (win.ImportManager && typeof win.ImportManager.getImportStore === 'function')
                    ? win.ImportManager.getImportStore() : null;
                var savePromise = Promise.resolve();
                if (importStore) {
                    savePromise = importStore.setItem('imported_book:' + newId, exportData).then(function () {
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
                    // PDF 书：保存原始 PDF 二进制
                    if (exportData.format === 'pdf') {
                        var pdfPath = 'books/' + entry.dirName + '/original.pdf';
                        var pdfEntry = zip.file(pdfPath);
                        if (pdfEntry) {
                            return pdfEntry.async('uint8array').then(function (pdfBytes) {
                                var pdfStore = (win.ImportManager && typeof win.ImportManager.getPdfDataStore === 'function')
                                    ? win.ImportManager.getPdfDataStore() : null;
                                if (pdfStore) {
                                    return pdfStore.setItem('pdf:' + newId, pdfBytes.buffer || pdfBytes);
                                }
                            });
                        }
                    }
                });
            });
        });
        return chain;
    }

    // ── 主入口 ──────────────────────────────────────────────────────────

    /**
     * 从同步 ZIP 导入数据（合并模式）
     * @param {ArrayBuffer|Uint8Array} buffer  ZIP 文件数据
     * @param {Object} [opts]
     *   - {Function} onProgress(current, total, bookTitle)  进度回调
     * @returns {Promise<{success:number, skipped:number, failed:number, errors:Array}>}
     */
    function importFromZip(buffer, opts) {
        opts = opts || {};
        var JSZip = win.JSZip;
        if (!JSZip) return Promise.reject(new Error('JSZip 未加载，无法解析 ZIP'));

        console.log('[BK.Sync] importFromZip: 开始导入，buffer 大小=' + (buffer.byteLength || buffer.length || 0) + ' 字节');
        var t0 = Date.now();

        return JSZip.loadAsync(buffer).then(function (zip) {
            // 1. 验证 manifest.json
            var manifestFile = zip.file('manifest.json');
            if (!manifestFile) {
                return Promise.reject(new Error('无效的同步包：缺少 manifest.json'));
            }

            return manifestFile.async('string').then(function (manifestText) {
                var manifest;
                try {
                    manifest = JSON.parse(manifestText);
                } catch (e) {
                    return Promise.reject(new Error('无效的 manifest.json'));
                }

                if (!manifest) {
                    return Promise.reject(new Error('无效的 manifest.json'));
                }

                // 旧版 ZIP（v1/v2）：委托给 BK.ImportZip.importFromZip
                if (manifest.version === 1 || manifest.version === 2) {
                    console.log('[BK.Sync] importFromZip: 检测到旧版 v' + manifest.version + ' ZIP，委托给 ImportZip');
                    if (win.BK && win.BK.ImportZip && typeof win.BK.ImportZip.importFromZip === 'function') {
                        return win.BK.ImportZip.importFromZip(buffer, 'sync-import.zip', opts);
                    }
                    return Promise.reject(new Error('旧版 ZIP 需 ImportZip 模块支持'));
                }

                // v3 同步包
                if (manifest.version !== MANIFEST_VERSION) {
                    return Promise.reject(new Error('不支持的同步包版本（期望 v' + MANIFEST_VERSION + '）'));
                }

                // 2. 收集书籍目录名
                var bookDirs = {};
                zip.forEach(function (relativePath) {
                    var match = relativePath.match(/^books\/([^\/]+)\/userdata\.json$/);
                    if (match) {
                        bookDirs[match[1]] = true;
                    }
                });
                var bookDirNames = Object.keys(bookDirs);
                if (!bookDirNames.length) {
                    return Promise.reject(new Error('ZIP 中未找到任何同步数据'));
                }

                console.log('[BK.Sync] importFromZip: 发现 ' + bookDirNames.length + ' 本书的同步数据，开始处理...');

                // 3. 确保书城索引已加载
                var indexReadyP;
                if (win.DataManager && typeof win.DataManager.getCachedIndex === 'function') {
                    var idx = win.DataManager.getCachedIndex();
                    if (idx && Array.isArray(idx.books) && idx.books.length > 0) {
                        indexReadyP = Promise.resolve();
                    } else if (typeof win.DataManager.loadIndex === 'function') {
                        indexReadyP = win.DataManager.loadIndex().catch(function () {});
                    } else {
                        indexReadyP = Promise.resolve();
                    }
                } else {
                    indexReadyP = Promise.resolve();
                }

                return indexReadyP.then(function () {
                    // 4. 解析 ID 映射（有 book.json 的书可能需要重映射 ID）
                    return _resolveIdMap(zip, bookDirNames);
                }).then(function (idMapResult) {
                    var idMap = idMapResult.idMap;
                    var bookDataMap = idMapResult.bookDataMap;
                    var fullBookDirs = idMapResult.fullBookDirs;

                    // 5. 保存书本体（仅导入书，书城书跳过）
                    return _saveBookData(zip, fullBookDirs, idMap, bookDataMap).then(function () {
                        // 6. 读取 shelf.json
                        var shelfFile = zip.file('shelf.json');
                        var shelfPromise = shelfFile
                            ? shelfFile.async('string').then(function (text) {
                                try { return JSON.parse(text); } catch (e) { return []; }
                            })
                            : Promise.resolve([]);

                        return shelfPromise.then(function (shelfData) {
                            // 7. 合并书架
                            return _mergeShelf(shelfData).then(function () {
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

                                                // 确定目标 bookId（可能经过 ID 映射）
                                                var targetId = idMap[dirName] || dirName;

                                                // 合并进度（localStorage）
                                                _mergeProgress(userData, targetId);

                                                // 合并 EPUB 书签（IndexedDB）
                                                return _mergeBookmarks(userData.bookmarks, targetId, idMap).then(function () {
                                                    // 合并 EPUB 高亮（IndexedDB）
                                                    return _mergeHighlights(userData.highlights, targetId, idMap);
                                                }).then(function () {
                                                    successCount++;
                                                    if (opts.onProgress) opts.onProgress(current, total, dirName);
                                                });
                                            });
                                        });
                                    })(bookDirNames[i]);
                                }

                                return chain.then(function () {
                                    console.log('[BK.Sync] importFromZip: 导入完成，成功=' + successCount +
                                        '，失败=' + failCount + '，耗时=' + (Date.now() - t0) + 'ms');
                                    // 广播事件通知 UI 刷新
                                    try {
                                        win.dispatchEvent(new win.CustomEvent('bk:data-synced'));
                                    } catch (e) {}
                                    return {
                                        success: successCount,
                                        skipped: 0,
                                        failed: failCount,
                                        errors: errors
                                    };
                                });
                            });
                        });
                    });
                });
            });
        });
    }

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.Sync = win.BK.Sync || {};
    win.BK.Sync.importFromZip = importFromZip;

})(window);
