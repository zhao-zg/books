/**
 * sync-data-collect.js — 用户数据收集（阅读进度、书签、高亮等）
 *
 * 从 localStorage 收集单本书的用户数据，供导出 / 同步等场景复用。
 * 由 export-batch.js 的 _collectUserData 抽取而来，逻辑逐行保持一致。
 *
 * 收集的 localStorage key：
 *   bk_progress:<bookId>            — 阅读进度百分比
 *   bk_chapter_read:<bookId>/<ch>   — 章节已读标记（扫描所有 key）
 *   bk_pdf_pos:<bookId>             — PDF 当前页码
 *   bk_pdf_bm:<bookId>             — PDF 书签
 *   bk_pdf_hl:<bookId>             — PDF 高亮/批注
 *   bk_lastread_ts:<bookId>        — 最后阅读时间戳
 *
 * 挂载：window.BK.SyncData.collectUserData(bookId)
 */
(function (win) {
    'use strict';

    /**
     * 收集单本书的 localStorage 用户数据（阅读进度、书签、高亮等）
     * @param {string} bookId
     * @returns {Object|null} 用户数据对象，无数据时返回 null
     */
    function collectUserData(bookId) {
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

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.SyncData = win.BK.SyncData || {};
    win.BK.SyncData.collectUserData = collectUserData;

})(window);