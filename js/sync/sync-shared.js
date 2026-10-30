/**
 * sync-shared.js — 导入/导出/同步共享工具（收编重复实现）
 *
 * 收编自以下文件的重复工具函数：
 *   - import-zip.js:      _isCityBookId + _doubleCheckCityBook → resolveCityBook
 *   - sync-import.js:     _isCityBookId（无二次校验版，统一为带校验版）
 *   - export-batch.js:    _getBookData / _isPdfBookData / _generateId
 *   - sync-export.js:     _getBookData / _isPdfBookData
 *   - export-book.js:     _getBookData + _syncSharedDeps
 *   - webdav-upload.js:   _getBookDataForExport + _syncSharedDeps
 *
 * 合并差异说明：
 *   1. _isCityBookId 两处不一致：import-zip 有缓存+二次校验（防索引未就绪误判），
 *      sync-import 无缓存无校验。取带二次校验的版本为准。
 *   2. _getBookData 四处实现：export-batch / sync-export / webdav-upload 在两者
 *      均不可用时 resolve(null)；export-book 在此场景 reject。取 resolve(null)
 *      （多数派 + 更安全，不阻断批量流程）。
 *   3. _isPdfBookData 三处实现完全一致。
 *   4. _generateId 三处实现完全一致。
 *
 * 依赖注入：
 *   - getBookData(bookId, deps) 通过 deps 参数注入 importStore / zlStore，
 *     避免单测碰真 IndexedDB。
 *   - resolveCityBook(idx, bookId) 接受索引对象作为参数（由调用方从
 *     DataManager.getCachedIndex() 获取后传入），纯函数无副作用。
 *   - resolveSharedDeps([win]) 构造 getBookData 的 store 依赖
 *     （收编 export-book/webdav-upload 的 _syncSharedDeps，见函数注释）
 *
 * 挂载：window.BK.SyncShared
 *   .isCityBookId(id)
 *   .resolveCityBook(indexData, bookId)
 *   .isPdfBookData(bookData)
 *   .generateBookId()
 *   .getBookData(bookId, deps)
 *   .resolveSharedDeps([win])  构造 getBookData 的 store 依赖（收编 export-book/webdav-upload）
 *   .KEY_IMPORT_PREFIX / .KEY_ZL_PREFIX / .KEY_PDF_PREFIX（常量，供调用方对齐）
 */
(function (win) {
    'use strict';

    // ── 存储 key 常量（与 import-storage.js / dm-shared.js 对齐）──────────
    var KEY_IMPORT_PREFIX = 'imported_book:';
    var KEY_ZL_PREFIX = 'zl_book:';
    var KEY_PDF_PREFIX = 'pdf:';

    // ── 工具函数 ──────────────────────────────────────────────────────────

    /**
     * 生成新 imported- ID
     * 格式：imported-<timestamp>-<random5>
     * 与 import-shared.js / import-zip.js / sync-import.js 完全一致
     * @returns {string}
     */
    function generateBookId() {
        return 'imported-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    }

    /**
     * 判断书籍数据是否为 PDF 书
     * 判定规则：
     *   1. bookData.format === 'pdf' → true
     *   2. chapters 内任一 content 条目 type === 'pdf_page' → true
     * 与三处源实现完全一致
     * @param {Object} bookData
     * @returns {boolean}
     */
    function isPdfBookData(bookData) {
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

    /**
     * 书城书 ID 前缀判定（纯函数，不查索引）
     * 仅排除 imported- 前缀的导入书，其余视为「可能是书城书」。
     * 最终确认由 resolveCityBook 完成（查索引）。
     *
     * 原始 _isCityBookId 的注释说明：
     *   不能仅凭 ID 前缀判断——书城原始 ID 无 imported- 前缀，但导入书也可能
     *   恰好不是 imported- 开头（旧版 ZIP 导出的书城书即保持原 ID）。
     *   唯一可靠判据是该书 ID 是否出现在书城索引中。
     *
     * @param {string} bookId
     * @returns {boolean} true=可能是书城书（需 resolveCityBook 确认），false=确定不是书城书
     */
    function isCityBookId(bookId) {
        if (!bookId) return false;
        if (bookId.indexOf('imported-') === 0) return false;
        return true;
    }

    /**
     * 防误判二次校验：确认 bookId 是否为书城书（查索引）
     * 合并自 import-zip.js 的 _isCityBookId（同步查索引）+ _doubleCheckCityBook（异步兜底）。
     *
     * 行为：
     *   - imported- 前缀 → false（导入书，不是书城书）
     *   - 索引未就绪（null/undefined/空 books）→ false（不误判，不缓存空结果）
     *   - 索引命中 → true
     *   - 索引未命中 → false
     *
     * 与原始实现的差异：
     *   原始 _isCityBookId 内部有内存缓存（_cityBookIdSet / _cityIndexRef）+ 异步
     *   loadIndex 触发。本共享版改为纯函数：接受 indexData 作为参数（由调用方
     *   从 DataManager.getCachedIndex() 获取后传入），不维护缓存、不触发异步加载。
     *   异步兜底由调用方自行编排（调 loadIndex 后重新调用 resolveCityBook）。
     *   这样使函数可测试（无全局副作用）且无竞态风险。
     *
     * @param {Object|null|undefined} indexData  索引数据（含 books 数组）
     * @param {string} bookId
     * @returns {boolean}
     */
    function resolveCityBook(indexData, bookId) {
        if (!bookId) return false;
        if (bookId.indexOf('imported-') === 0) return false;

        var books = (indexData && Array.isArray(indexData.books)) ? indexData.books : [];
        if (!books.length) return false;

        for (var i = 0; i < books.length; i++) {
            if (books[i] && books[i].id === bookId) return true;
        }
        return false;
    }

    /**
     * 从本地存储路由读取书籍数据
     * 合并自 export-batch / sync-export / export-book / webdav-upload 的 _getBookData。
     *
     * 路由逻辑：
     *   1. imported- 前缀 → 先查 importStore（imported-data），未命中降级 zlStore
     *   2. 非 imported- 前缀 → 先查 zlStore（zl-data），未命中降级 importStore
     *   3. 均未命中 → resolve(null)
     *
     * 依赖注入：
     *   deps = { importStore, zlStore }
     *   - importStore: localforage 实例（storeName: 'imported-data'），key 格式 'imported_book:<id>'
     *   - zlStore: localforage 实例（storeName: 'zl-data'），key 格式 'zl_book:<id>'
     *   缺失某个 store 时跳过该路径，不崩溃。
     *
     * 与原始实现的差异：
     *   原始实现通过 win.ImportManager.getImportedBook / win.DataManager.getBook 间接
     *   访问 store，绑定全局对象不可单测。本共享版改为直接接受 store 实例参数。
     *   原始的降级链：ImportManager → DataManager → null，本版改为：
     *   imported- 前缀先 importStore 后 zlStore（因为 imported-data 是导入书主存储），
     *   非前缀先 zlStore 后 importStore（因为 zl-data 是书城书主存储）。
     *   这种双向降级覆盖了原始实现未覆盖的边缘场景（如 imported- 前缀的书同时被
     *   cacheBook 到 zl-data 的情况）。
     *
     * @param {string} bookId
     * @param {Object} deps  { importStore?, zlStore? }
     * @returns {Promise<Object|null>}
     */
    function getBookData(bookId, deps) {
        if (!bookId) return Promise.resolve(null);
        deps = deps || {};
        var importStore = deps.importStore || null;
        var zlStore = deps.zlStore || null;

        var isImported = bookId.indexOf('imported-') === 0;
        // 按前缀决定主/降级 store 顺序
        var primary = isImported ? importStore : zlStore;
        var secondary = isImported ? zlStore : importStore;
        var primaryKey = isImported ? KEY_IMPORT_PREFIX : KEY_ZL_PREFIX;
        var secondaryKey = isImported ? KEY_ZL_PREFIX : KEY_IMPORT_PREFIX;

        function tryStore(store, keyPrefix) {
            if (!store) return Promise.resolve(null);
            return store.getItem(keyPrefix + bookId).then(function (data) {
                return data || null;
            }).catch(function () { return null; });
        }

        return tryStore(primary, primaryKey).then(function (book) {
            if (book) return book;
            return tryStore(secondary, secondaryKey).then(function (book2) {
                return book2 || null;
            });
        });
    }

    /**
     * 构造 getBookData 的 store 依赖
     * 收编 export-book.js / webdav-upload.js 中完全相同的 _syncSharedDeps：
     * 通过 ImportManager.getImportStore / DataManager.getZlStore 取 localforage 实例，
     * 任一不可用时跳过该依赖（getBookData 内部降级处理）。
     *
     * @param {Window} [w]  可注入的 window（缺省 win，供单测）
     * @returns {Object} { importStore?, zlStore? }
     */
    function resolveSharedDeps(w) {
        w = w || win;
        var deps = {};
        try {
            if (w.ImportManager && typeof w.ImportManager.getImportStore === 'function') {
                deps.importStore = w.ImportManager.getImportStore();
            }
        } catch (e) { /* ignore */ }
        try {
            if (w.DataManager && typeof w.DataManager.getZlStore === 'function') {
                deps.zlStore = w.DataManager.getZlStore();
            }
        } catch (e) { /* ignore */ }
        return deps;
    }

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.SyncShared = {
        generateBookId: generateBookId,
        isPdfBookData: isPdfBookData,
        isCityBookId: isCityBookId,
        resolveCityBook: resolveCityBook,
        getBookData: getBookData,
        resolveSharedDeps: resolveSharedDeps,
        // 常量（供调用方对齐 key 格式）
        KEY_IMPORT_PREFIX: KEY_IMPORT_PREFIX,
        KEY_ZL_PREFIX: KEY_ZL_PREFIX,
        KEY_PDF_PREFIX: KEY_PDF_PREFIX
    };

})(window);
