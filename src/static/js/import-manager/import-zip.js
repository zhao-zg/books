/**
 * import-zip.js — 从 ZIP 压缩包批量导入书籍
 *
 * 解析 export-batch.js 导出的 ZIP 格式：
 *   bk-books-export.zip
 *   ├── manifest.json
 *   └── books/
 *       ├── <bookId-1>/
 *       │   ├── book.json       # 书籍数据
 *       │   ├── userdata.json   # 用户数据（阅读进度、书签、高亮等，v2+）
 *       │   └── original.pdf    # （仅 PDF 书）原始 PDF 二进制
 *       ...
 *
 * 导入策略：
 *   - book.json 中已有完整书籍数据，直接写入本地存储，无需重新解析
 *   - PDF 书额外写入原始 PDF 二进制到 pdfStore
 *   - userdata.json 中的用户数据恢复到 localStorage
 *   - 对已有 ID 的书籍执行覆盖写（备份还原场景）
 *   - 非导入书 ID 自动加 'imported-' 前缀，避免与书城书冲突
 *
 * 依赖：
 *   - JSZip (vendor/jszip.min.js)
 *   - localforage (全局)
 *   - BKShelf (书架管理)
 *   - DataManager (内容索引)
 *
 * 挂载：window.BK.ImportZip.importFromZip(buffer, fileName, opts?)
 */
(function (win) {
    'use strict';

    // ── 存储实例（与 import-storage.js 保持一致）────────────────────────
    var _importStore = localforage.createInstance({
        name: 'books',
        storeName: 'imported-data'
    });
    var KEY_PREFIX = 'imported_book:';
    var KEY_IDS = 'imported_ids';

    // ── 工具函数 ──────────────────────────────────────────────────────────

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

    /** 生成新 ID（与 import-shared.js 格式一致） */
    function _generateId() {
        return 'imported-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    }

    // ── 存储操作 ──────────────────────────────────────────────────────────

    /**
     * 保存书籍数据到本地存储
     * 复刻 import-storage.js 的 saveBook 逻辑（入架 + 建索引）
     * @param {Object} bookData  完整书籍数据
     * @returns {Promise<Object>}  保存后的书籍对象
     */
    function _saveBook(bookData) {
        var bookId = bookData.id;
        if (!bookId) {
            bookId = _generateId();
            bookData.id = bookId;
        }

        console.log('[BK.ImportZip] _saveBook: 保存书籍 id=' + bookId + '，title=' + (bookData.title || '?'));

        return _importStore.setItem(KEY_PREFIX + bookId, bookData).then(function () {
            return _importStore.getItem(KEY_IDS).then(function (ids) {
                ids = ids || [];
                if (ids.indexOf(bookId) < 0) ids.push(bookId);
                return _importStore.setItem(KEY_IDS, ids);
            });
        }).then(function () {
            // 入架
            try { if (win.BKShelf && win.BKShelf.add) win.BKShelf.add(bookId); } catch (e) {}
            // 建内容索引 + 书目索引
            try {
                if (win.DataManager) {
                    if (win.DataManager.buildContentIndex) win.DataManager.buildContentIndex(bookData);
                    if (win.DataManager.addToBookIndex) win.DataManager.addToBookIndex(bookData);
                }
            } catch (e) {}
            return bookData;
        });
    }

    /**
     * 保存 PDF 二进制数据到 pdfStore
     * @param {Uint8Array} pdfBytes  PDF 原始二进制
     * @param {string} bookId        书籍 ID
     * @returns {Promise}
     */
    function _savePdfData(pdfBytes, bookId) {
        var store = (win.ImportManager && typeof win.ImportManager.getPdfDataStore === 'function')
            ? win.ImportManager.getPdfDataStore() : null;
        if (!store) return Promise.resolve();
        return store.setItem('pdf:' + bookId, pdfBytes.buffer || pdfBytes).catch(function () {});
    }

    // ── 单本导入 ──────────────────────────────────────────────────────────

    /**
     * 恢复单本书的用户数据到 localStorage
     * @param {Object} userData  从 userdata.json 解析的数据
     * @param {string} bookId    目标书籍 ID（可能已变化，如书城书加了 imported- 前缀）
     */
    function _restoreUserData(userData, bookId) {
        try {
            var ls = win.localStorage;
            if (!ls || !userData) return;

            if (userData.progress) ls.setItem('bk_progress:' + bookId, userData.progress);
            if (userData.lastReadTs) ls.setItem('bk_lastread_ts:' + bookId, userData.lastReadTs);
            if (userData.pdfPos) ls.setItem('bk_pdf_pos:' + bookId, userData.pdfPos);
            if (userData.pdfBookmarks) ls.setItem('bk_pdf_bm:' + bookId, userData.pdfBookmarks);
            if (userData.pdfHighlights) ls.setItem('bk_pdf_hl:' + bookId, userData.pdfHighlights);

            // 恢复章节已读标记
            var chapterReads = userData.chapterReads;
            if (Array.isArray(chapterReads)) {
                for (var i = 0; i < chapterReads.length; i++) {
                    var chNum = String(chapterReads[i]);
                    if (chNum) ls.setItem('bk_chapter_read:' + bookId + '/' + chNum, '1');
                }
            }
        } catch (e) {
            console.warn('[导入] 恢复用户数据失败:', bookId, e);
        }
    }

    /**
     * 从 ZIP 中导入单本书
     *
     * 导入策略（v2+ 分流）：
     *   - 书城书（id 不以 imported- 开头）：保持原 ID → DataManager.cacheBook() 存入 zl-data，
     *     不入书架，已有缓存则跳过不覆盖。与下载书籍统一管理。
     *   - 导入书（id 以 imported- 开头）：走 _saveBook() → imported-data store + 入架（原有逻辑）。
     *
     * @param {JSZip} zip    JSZip 实例
     * @param {string} bookDirName  书籍目录名（books/ 下的子目录名）
     * @returns {Promise<{success:boolean, skipped?:boolean, id?:string, title?:string, error?:string}>}
     */
    function _importOneBook(zip, bookDirName) {
        var bookJsonPath = 'books/' + bookDirName + '/book.json';
        var bookJsonEntry = zip.file(bookJsonPath);
        if (!bookJsonEntry) {
            console.warn('[BK.ImportZip] _importOneBook: book.json 未找到，dir=' + bookDirName);
            return Promise.resolve({ success: false, id: bookDirName, error: 'book.json 未找到' });
        }

        var originalId = null;

        return bookJsonEntry.async('string').then(function (bookJsonText) {
            var bookData;
            try {
                bookData = JSON.parse(bookJsonText);
            } catch (e) {
                console.error('[BK.ImportZip] _importOneBook: book.json 解析失败，dir=' + bookDirName, e);
                return { success: false, id: bookDirName, error: 'book.json 解析失败' };
            }

            if (!bookData || !bookData.id) {
                console.error('[BK.ImportZip] _importOneBook: book.json 缺少 id，dir=' + bookDirName);
                return { success: false, id: bookDirName, error: 'book.json 缺少 id' };
            }

            originalId = bookData.id;
            var isCityBook = originalId.indexOf('imported-') !== 0;

            // ── 分流：书城书 vs 导入书 ──────────────────────────────
            if (isCityBook) {
                // 书城书：保持原 ID → zl-data 缓存，不入架，不覆盖
                return _importCityBook(zip, bookDirName, bookData, originalId);
            } else {
                // 导入书：走现有 _saveBook 逻辑
                return _importImportedBook(zip, bookDirName, bookData, originalId);
            }
        }).catch(function (err) {
            return { success: false, id: bookDirName, error: (err && err.message) || '读取失败' };
        });
    }

    /**
     * 书城书导入：保持原 ID → DataManager.cacheBook() 存入 zl-data，
     * 不入书架，已有缓存则跳过不覆盖。
     */
    function _importCityBook(zip, bookDirName, bookData, originalId) {
        var isPdf = _isPdfBookData(bookData);

        // 1. 检查是否已缓存，已有则跳过
        if (win.DataManager && win.DataManager.isBookDownloaded) {
            return win.DataManager.isBookDownloaded(originalId).then(function (alreadyCached) {
                if (alreadyCached) {
                    console.log('[BK.ImportZip] _importCityBook: 已缓存，跳过 id=' + originalId);
                    return { success: true, skipped: true, id: originalId, title: bookData.title || originalId };
                }
                return _cacheCityBook(zip, bookDirName, bookData, originalId, isPdf);
            });
        }
        // DataManager 不可用时退化：直接缓存
        return _cacheCityBook(zip, bookDirName, bookData, originalId, isPdf);
    }

    /**
     * 将书城书写入 zl-data 缓存（通过 DataManager.cacheBook）
     */
    function _cacheCityBook(zip, bookDirName, bookData, originalId, isPdf) {
        if (!win.DataManager || !win.DataManager.cacheBook) {
            console.warn('[BK.ImportZip] _cacheCityBook: DataManager.cacheBook 不可用，跳过 id=' + originalId);
            return Promise.resolve({ success: false, id: originalId, title: bookData.title, error: 'DataManager 不可用' });
        }
        console.log('[BK.ImportZip] _cacheCityBook: 缓存书城书 id=' + originalId + '，title=' + (bookData.title || '?'));
        return win.DataManager.cacheBook(originalId, bookData).then(function () {
            // PDF 书：额外保存原始 PDF 二进制
            if (isPdf) {
                var pdfPath = 'books/' + bookDirName + '/original.pdf';
                var pdfEntry = zip.file(pdfPath);
                if (pdfEntry) {
                    return pdfEntry.async('uint8array').then(function (pdfBytes) {
                        return _savePdfData(pdfBytes, originalId).then(function () {
                            return { success: true, id: originalId, title: bookData.title || originalId };
                        });
                    });
                }
            }
            return { success: true, id: originalId, title: bookData.title || originalId };
        }).then(function (result) {
            // 恢复用户数据（阅读进度、书签、高亮等），用原 ID
            return _restoreUserDataFromZip(zip, bookDirName, originalId, result);
        }).catch(function (err) {
            return { success: false, id: originalId, title: bookData.title, error: (err && err.message) || '缓存失败' };
        });
    }

    /**
     * 导入书导入：加新 imported- 前缀 ID → _saveBook() → 入架（原有逻辑）
     */
    function _importImportedBook(zip, bookDirName, bookData, originalId) {
        // 自动加前缀避免与书城书冲突
        var newId = _generateId();
        console.log('[BK.ImportZip] _importImportedBook: 导入书 ID=' + originalId + ' → 新 ID=' + newId);
        bookData.id = newId;

        var isPdf = _isPdfBookData(bookData);

        // PDF 书：ID 变化后需重映射 pdf_page.pdfBookId
        if (isPdf && bookData.chapters) {
            var mappedCount = 0;
            for (var chIdx = 0; chIdx < bookData.chapters.length; chIdx++) {
                var chContent = bookData.chapters[chIdx].content;
                if (!Array.isArray(chContent)) continue;
                for (var cIdx = 0; cIdx < chContent.length; cIdx++) {
                    if (chContent[cIdx] && chContent[cIdx].type === 'pdf_page') {
                        chContent[cIdx].pdfBookId = bookData.id;
                        mappedCount++;
                    }
                }
            }
            if (mappedCount) {
                console.log('[BK.ImportZip] _importImportedBook: 重映射 ' + mappedCount + ' 个 pdf_page 的 pdfBookId → ' + bookData.id);
            }
        }

        return _saveBook(bookData).then(function () {
            // PDF 书：额外保存原始 PDF 二进制
            if (isPdf) {
                var pdfPath = 'books/' + bookDirName + '/original.pdf';
                var pdfEntry = zip.file(pdfPath);
                if (pdfEntry) {
                    return pdfEntry.async('uint8array').then(function (pdfBytes) {
                        return _savePdfData(pdfBytes, bookData.id).then(function () {
                            return { success: true, id: bookData.id, title: bookData.title || bookData.id };
                        });
                    });
                }
            }
            return { success: true, id: bookData.id, title: bookData.title || bookData.id };
        }).then(function (result) {
            // 恢复用户数据（用新 ID）
            return _restoreUserDataFromZip(zip, bookDirName, bookData.id, result);
        }).catch(function (err) {
            return { success: false, id: bookData.id, title: bookData.title, error: (err && err.message) || '保存失败' };
        });
    }

    /**
     * 从 ZIP 中恢复单本书的用户数据（阅读进度、书签、高亮等）
     * @param {JSZip} zip
     * @param {string} bookDirName
     * @param {string} bookId  目标书籍 ID
     * @param {Object} result   导入结果对象
     * @returns {Promise<Object>}
     */
    function _restoreUserDataFromZip(zip, bookDirName, bookId, result) {
        var udPath = 'books/' + bookDirName + '/userdata.json';
        var udEntry = zip.file(udPath);
        if (udEntry) {
            return udEntry.async('string').then(function (udText) {
                try {
                    var userData = JSON.parse(udText);
                    _restoreUserData(userData, bookId);
                } catch (e) { /* 静默失败 */ }
                return result;
            }).catch(function () { return result; });
        }
        return result;
    }

    // ── 主入口 ──────────────────────────────────────────────────────────

    /**
     * 从 ZIP 缓冲区批量导入书籍
     * @param {ArrayBuffer|Uint8Array} buffer  ZIP 文件数据
     * @param {string} fileName  文件名（用于日志）
     * @param {Object} [opts]
     *   - {Function} onProgress(current, total, bookTitle)  进度回调
     * @returns {Promise<{success:number, skipped:number, failed:number, errors:Array}>}
     */
    function importFromZip(buffer, fileName, opts) {
        opts = opts || {};
        var JSZip = win.JSZip;
        if (!JSZip) return Promise.reject(new Error('JSZip 未加载，无法解析 ZIP'));

        console.log('[BK.ImportZip] importFromZip: 开始导入，文件名=' + fileName + '，buffer 大小=' + (buffer.byteLength || buffer.length || 0) + ' 字节');
        var t0 = Date.now();

        return JSZip.loadAsync(buffer).then(function (zip) {
            // 1. 验证 manifest.json
            var manifestFile = zip.file('manifest.json');
            if (!manifestFile) {
                return Promise.reject(new Error('无效的书籍包：缺少 manifest.json'));
            }

            return manifestFile.async('string').then(function (manifestText) {
                var manifest;
                try {
                    manifest = JSON.parse(manifestText);
                } catch (e) {
                    return Promise.reject(new Error('无效的 manifest.json'));
                }

                if (!manifest || (manifest.version !== 1 && manifest.version !== 2)) {
                    return Promise.reject(new Error('不支持的书籍包版本（期望 v1/v2）'));
                }

                // 2. 收集书籍目录名
                var bookDirs = {};
                zip.forEach(function (relativePath) {
                    // 匹配 books/<folderName>/book.json
                    var match = relativePath.match(/^books\/([^\/]+)\/book\.json$/);
                    if (match) {
                        bookDirs[match[1]] = true;
                    }
                });

                var bookDirNames = Object.keys(bookDirs);
                if (!bookDirNames.length) {
                    return Promise.reject(new Error('ZIP 中未找到任何书籍数据'));
                }

                console.log('[BK.ImportZip] importFromZip: 发现 ' + bookDirNames.length + ' 本书，版本=' + manifest.version +
                    '，开始逐本导入...');

                // 3. 逐本导入（顺序执行，避免大量写入并发）
                var successCount = 0;
                var failCount = 0;
                var skippedCount = 0;
                var errors = [];
                var current = 0;
                var total = bookDirNames.length;
                var chain = Promise.resolve();

                for (var i = 0; i < bookDirNames.length; i++) {
                    (function (dirName, idx) {
                        chain = chain.then(function () {
                            current = idx + 1;
                            return _importOneBook(zip, dirName).then(function (result) {
                                if (result.success) {
                                    if (result.skipped) skippedCount++;
                                    else successCount++;
                                } else { failCount++; errors.push(result); }
                                if (opts.onProgress) opts.onProgress(current, total, result.title || dirName);
                            });
                        });
                    })(bookDirNames[i], i);
                }

                return chain.then(function () {
                    console.log('[BK.ImportZip] importFromZip: 导入完成，成功=' + successCount +
                        '，跳过=' + skippedCount + '，失败=' + failCount + '，耗时=' + (Date.now() - t0) + 'ms');
                    if (errors.length) console.warn('[BK.ImportZip] importFromZip: 失败详情=', errors);
                    return {
                        success: successCount,
                        skipped: skippedCount,
                        failed: failCount,
                        errors: errors
                    };
                });
            });
        });
    }

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.ImportZip = {
        importFromZip: importFromZip
    };

})(window);
