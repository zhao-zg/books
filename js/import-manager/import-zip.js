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
 *   - 分流处理（v2+）：
 *       · 书城书（ID 存在于书城索引）：保持原 ID → DataManager.cacheBook() 写入 zl-data
 *         （离线可读 + 书城显示「✓ 已下载」角标），不写入 imported store、不入书架。
 *         书城书「入架」由用户在书城点击打开时决定（BKShelf.add 幂等）。
 *       · 导入书（ID 以 'imported-' 开头，或不在书城索引）：加新 imported- 前缀 ID
 *         → imported-data store + 入架（原有逻辑）。
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

    /** 内存缓存：书城索引 ID 集合（避免每本导入重复遍历） */
    var _cityBookIdSet = null;
    /** 与 _cityBookIdSet 对应的索引数据引用（同一份索引只构建一次；索引刷新后自动重建） */
    var _cityIndexRef = null;

    /**
     * 判断书籍 ID 是否为「书城书」（存在于书城索引 books-index.json 中）。
     * 依据 DataManager.getCachedIndex()（含 series/category_prefix/group 等书城元数据）。
     * 注意：不能仅凭 ID 前缀判断——书城原始 ID 无 imported- 前缀，但导入书也可能
     * 恰好不是 imported- 开头（旧版 ZIP 导出的书城书即保持原 ID）。唯一可靠判据是
     * 该书 ID 是否出现在书城索引中。
     *
     * ★ 索引就绪保障（修复误判 bug）：
     *   此前 _cityBookIdSet 在首次调用时被初始化，若当时索引尚未加载完成
     *   （getCachedIndex() 返回 null/空），会缓存一个【空 Set】并永久短路，
     *   导致后续所有书城书（如 books-2-2082）被误判为导入书。
     *   现改为：
     *   1) 索引未就绪时**不缓存**空 Set（_cityBookIdSet 保持 null），并异步
     *      触发 DataManager.loadIndex()，加载完成后后续调用自动正确构建；
     *   2) 每次构建前校验索引完整性（books 数量），避免把空索引固化成缓存；
     *   3) 用 _cityIndexRef 记录已构建 Set 对应的索引数据引用：同一份索引
     *      只构建一次，索引刷新后（_cachedIndex 换新对象）自动失效重建，
     *      不会缓存过期空 Set。
     * @param {string} bookId
     * @returns {boolean}
     */
    function _isCityBookId(bookId) {
        if (!bookId) return false;
        // 导入书 ID 前缀，必不在书城索引
        if (bookId.indexOf('imported-') === 0) return false;

        // 从当前索引数据（已就绪）直接构建/复用 Set
        var indexData = (win.DataManager && typeof win.DataManager.getCachedIndex === 'function')
            ? win.DataManager.getCachedIndex() : null;
        var books = (indexData && Array.isArray(indexData.books)) ? indexData.books : [];
        // 索引未就绪（null/空）：不缓存，直接返回 false，并触发异步加载
        // （加载完成后 _cityBookIdSet 会被正确构建，后续调用不再走这里）
        if (!books.length) {
            // 触发一次异步加载（幂等：DataManager.loadIndex 内部有 _cachedIndex 守卫）
            try {
                if (win.DataManager && typeof win.DataManager.loadIndex === 'function') {
                    win.DataManager.loadIndex();
                }
            } catch (e) {}
            return false;
        }

        if (!_cityBookIdSet || _cityIndexRef !== indexData) {
            _cityBookIdSet = new Set();
            _cityIndexRef = indexData;
            for (var i = 0; i < books.length; i++) {
                _cityBookIdSet.add(books[i].id);
            }
        }
        return _cityBookIdSet.has(bookId);
    }

    /**
     * 二次校验：异步确认 bookId 是否为书城书。
     * 不依赖 _cityBookIdSet 内存缓存，直接从 DataManager 索引数据逐条比对。
     * 用于 _isCityBookId 返回 false 后的兜底（防止索引未就绪导致的误判）。
     * @param {string} bookId
     * @returns {Promise<boolean>}
     */
    function _doubleCheckCityBook(bookId) {
        if (!bookId || bookId.indexOf('imported-') === 0) return Promise.resolve(false);
        try {
            if (!win.DataManager || typeof win.DataManager.getCachedIndex !== 'function') return Promise.resolve(false);
            var indexData = win.DataManager.getCachedIndex();
            if (indexData && Array.isArray(indexData.books) && indexData.books.length > 0) {
                // 索引已就绪：直接遍历比对（不走缓存，确保结果准确）
                for (var i = 0; i < indexData.books.length; i++) {
                    if (indexData.books[i].id === bookId) return Promise.resolve(true);
                }
                return Promise.resolve(false);
            }
            // 索引未就绪：触发 loadIndex 后再检查
            console.log('[BK.ImportZip] _doubleCheckCityBook: 索引未就绪，触发 loadIndex 后重试');
            return win.DataManager.loadIndex().then(function () {
                var idx = win.DataManager.getCachedIndex();
                if (!idx || !Array.isArray(idx.books)) return false;
                for (var j = 0; j < idx.books.length; j++) {
                    if (idx.books[j].id === bookId) return true;
                }
                return false;
            }).catch(function () { return false; });
        } catch (e) {
            return Promise.resolve(false);
        }
    }

    // ── 存储操作 ──────────────────────────────────────────────────────────

    /**
     * 将 bookId 记录到 imported_ids（imported-data store）。
     *
     * 注意：此函数当前无调用方。_importCityBook 已不再调用此函数——
     * 书城书（ZIP 导入）只加到 zl-data 缓存，不写入 imported_ids，
     * purgeBook 时走「书城书分支」（设 purged 标记、保留 zl-data 缓存）。
     * 保留此函数以备将来可能的扩展用途。
     *
     * @param {string} bookId
     * @returns {Promise<void>}
     */
    function _addImportedId(bookId) {
        return _importStore.getItem(KEY_IDS).then(function (ids) {
            ids = ids || [];
            if (ids.indexOf(bookId) < 0) ids.push(bookId);
            return _importStore.setItem(KEY_IDS, ids);
        }).catch(function (e) {
            console.warn('[BK.ImportZip] _addImportedId: 写入 imported_ids 失败 id=' + bookId, e);
        });
    }

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
     * @param {string} bookId    目标书籍 ID（书城书保持原 ID，导入书用新 imported- ID）
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
     *   - 书城书（ID 存在于书城索引 books-index.json）：保持原 ID → DataManager.cacheBook()
     *     存入 zl-data，不入书架，已有缓存则跳过不覆盖。与下载书籍统一管理。
     *   - 导入书（ID 以 imported- 开头，或不在书城索引）：走 _saveBook() → imported-data store
     *     + 入架（原有逻辑）。
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

            // ── 分流：书城书 vs 导入书 ──────────────────────────────
            // ★ 书城书（ID 存在于书城索引）：保持原 ID 缓存到 zl-data、不入书架、
            //   不写 imported_ids。书城卡片显示「✓ 已下载」角标、离线可读。
            //   用户主动在书城点开时才入架。purgeBook 走「书城书分支」
            //   （设 purged 标记、保留 zl-data 缓存），purged 标记阻止复活。
            // ★ 导入书（imported- 前缀或不在书城索引）：加前缀入 imported-data + 入架，
            //   移出书架即彻底清理（imported-data + zl-data + PDF 一并清除）。
            //
            // ★★ 二次校验（兜底）：_isCityBookId 依赖 getCachedIndex() 的内存缓存，
            //   若索引未就绪（如清空数据后竞态）会返回 false 导致误判。此处对
            //   非 imported- 前缀的书做异步二次校验：直接遍历 DataManager 索引数据
            //   逐条比对 ID，不依赖 _cityBookIdSet 缓存。若命中则改走 _importCityBook。
            if (_isCityBookId(originalId)) {
                return _importCityBook(zip, bookDirName, bookData);
            }
            // 二次校验：非 imported- 前缀且索引可能未就绪时，异步确认
            if (originalId.indexOf('imported-') !== 0) {
                return _doubleCheckCityBook(originalId).then(function (isCity) {
                    if (isCity) {
                        console.log('[BK.ImportZip] _importOneBook: 二次校验命中书城书 id=' + originalId);
                        return _importCityBook(zip, bookDirName, bookData);
                    }
                    return _importImportedBook(zip, bookDirName, bookData, originalId);
                });
            }
            return _importImportedBook(zip, bookDirName, bookData, originalId);
        }).catch(function (err) {
            return { success: false, id: bookDirName, error: (err && err.message) || '读取失败' };
        });
    }

    /**
     * 书城书导入：保持原 ID → DataManager.cacheBook() 存入 zl-data → 不入书架。
     *
     * 效果：
     *   - 书城卡片显示「✓ 已下载」角标（_isBookDownloaded 命中已下载列表）
     *   - 离线可读（zl-data 缓存 + 内容索引）
     *   - 不入 imported store、不建 imported_ids 记录、不 BKShelf.add
     *   - 用户稍后在书城点开该书时 BKShelf.add() 自动入架（幂等），
     *     此时「入架」是用户主动行为，符合语义
     *
     * 历史 bug 规避（「移出书架后又出现」）：
     *   - 不写 imported_ids → _mergeImportedBooks() 不会把它合并进 _zlBooks，
     *     也不会 cacheBook 回填；purgeBook 对无前缀且不在 imported_ids 的书走
     *     「仅移出书架 + 设 purged 标记、保留 zl-data 缓存」分支，
     *     purged 标记阻止书城点开时 BKShelf.add 自动入架导致复活。
     *   - 用户重新主动下载（downloadBook/cacheBook）时清除 purged 标记，方可重新入架。
     *
     * @param {JSZip} zip
     * @param {string} bookDirName
     * @param {Object} bookData  完整书籍数据（id 为书城原始 ID）
     * @returns {Promise<Object>}  { success, skipped, id, title }
     */
    function _importCityBook(zip, bookDirName, bookData) {
        var bookId = bookData.id;
        var isPdf = _isPdfBookData(bookData);

        // PDF 书：保持原 ID，pdf_page.pdfBookId 无需重映射（与 ID 一致）；
        // 原始 PDF 二进制需一并写入 pdfStore（键 'pdf:' + bookId）
        var pdfPromise = Promise.resolve();
        if (isPdf) {
            pdfPromise = (function () {
                var pdfPath = 'books/' + bookDirName + '/original.pdf';
                var pdfEntry = zip.file(pdfPath);
                if (!pdfEntry) return Promise.resolve();
                return pdfEntry.async('uint8array').then(function (pdfBytes) {
                    return _savePdfData(pdfBytes, bookId);
                });
            })();
        }

        return pdfPromise.then(function () {
            // 已下载/已缓存则不覆盖（保持用户当前本地数据，避免导入把更新内容回滚）
            return win.DataManager.isBookDownloaded(bookId).then(function (downloaded) {
                if (downloaded) {
                    console.log('[BK.ImportZip] _importCityBook: 书城书已缓存，跳过写入 id=' + bookId +
                        '，title=' + (bookData.title || '?'));
                    // 不写 imported_ids：书城书只加到 zl-data 缓存，不入导入库。
                    // purgeBook 时走「书城书分支」（设 purged 标记、保留 zl-data 缓存），
                    // purged 标记阻止书城点开 BKShelf.add 自动入架导致复活。
                    return { success: true, skipped: true, id: bookId, title: bookData.title || bookId };
                }
                return win.DataManager.cacheBook(bookId, bookData).then(function () {
                    console.log('[BK.ImportZip] _importCityBook: 书城书已缓存到 zl-data id=' + bookId +
                        '，title=' + (bookData.title || '?') + '，不入书架');
                    // 不写 imported_ids：书城书只加到 zl-data 缓存，不入导入库。
                    // purgeBook 时走「书城书分支」（设 purged 标记、保留 zl-data 缓存），
                    // purged 标记阻止书城点开 BKShelf.add 自动入架导致复活。
                    return { success: true, id: bookId, title: bookData.title || bookId };
                });
            });
        }).then(function (result) {
            // 恢复用户数据（用原 ID）
            return _restoreUserDataFromZip(zip, bookDirName, bookId, result);
        });
    }

    /**
     * 导入书导入：加新 imported- 前缀 ID → _saveBook() → 入架（原有逻辑）
     * 适用于 ID 以 'imported-' 开头的导入书，或不在书城索引中的书籍。
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

                // 2.5. ★ 确保书城索引已加载完毕
                // 分流逻辑 _isCityBookId 依赖 getCachedIndex() 返回有效索引；
                // 若索引未就绪（如清空数据后首次操作），_isCityBookId 同步返回 false，
                // 导致书城书（含 bundled 书）被误判为导入书 → 加 imported- 前缀入架，
                // 移出书架后无法彻底清理。必须在导入前确保索引就绪。
                var indexReadyP;
                if (win.DataManager && typeof win.DataManager.loadIndex === 'function' &&
                    win.DataManager.getCachedIndex() &&
                    (win.DataManager.getCachedIndex().books || []).length > 0) {
                    // 索引已就绪，无需等待
                    indexReadyP = Promise.resolve();
                } else {
                    console.log('[BK.ImportZip] importFromZip: 书城索引未就绪，等待加载...');
                    indexReadyP = win.DataManager.loadIndex().catch(function (e) {
                        console.warn('[BK.ImportZip] importFromZip: 索引加载失败，继续导入（非书城书不受影响）:', e);
                    });
                }

                return indexReadyP.then(function () {

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

                }); // end indexReadyP.then
            });
        });
    }

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.ImportZip = {
        importFromZip: importFromZip,
        _doubleCheckCityBook: _doubleCheckCityBook
    };

})(window);
