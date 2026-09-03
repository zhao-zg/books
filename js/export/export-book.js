/**
 * export-book.js — 书籍导出模块
 *
 * 支持 4 种格式：
 *   - PDF：从 pdfStore 读原始二进制，直接导出
 *   - TXT：章节纯文本拼接
 *   - MD：Markdown 格式拼接（含标题层级、引用块等）
 *   - EPUB：用 JSZip 打包最小 EPUB 3.0 结构
 *
 * 所有格式均通过 BK.Export.exportText / BK.Export.exportBinary 统一出口，
 * 原生走 Filesystem+Share，Web 走 a.download。
 *
 * 依赖：
 *   - BK.Export (export-core.js)
 *   - BK.BookConvert (sync/book-convert.js) — TXT/MD/EPUB 文本转换
 *   - BK.SyncShared (sync/sync-shared.js) — getBookData 数据读取
 *   - ImportManager.getPdfDataStore (import-orchestrator.js)
 *   - JSZip (vendor/jszip.min.js) — EPUB 打包
 *
 * 挂载：window.BK.Export.exportBook(bookId, format)
 */
(function (win) {
    'use strict';

    // ── 工具函数 ──────────────────────────────────────────────────────────

    // TXT/MD/EPUB 转换逻辑已收编至 sync/book-convert.js（BK.BookConvert）

    // ── PDF 导出 ──────────────────────────────────────────────────────────

    function _exportPdf(bookId, bookTitle) {
        var store = (win.ImportManager && typeof win.ImportManager.getPdfDataStore === 'function')
            ? win.ImportManager.getPdfDataStore() : null;
        if (!store) {
            return Promise.reject(new Error('PDF 数据存储不可用'));
        }
        return store.getItem('pdf:' + bookId).then(function (data) {
            if (!data) return Promise.reject(new Error('PDF 数据未找到: ' + bookId));
            var bytes = new Uint8Array(data);
            var filename = (bookTitle || bookId) + '.pdf';
            // 走 BK.Export.exportBinary
            if (win.BK && win.BK.Export && win.BK.Export.exportBinary) {
                return win.BK.Export.exportBinary(bytes, filename, 'application/pdf', {
                    successMsg: '已导出《' + bookTitle + '》PDF',
                    bom: false,
                    chooseDestination: true
                });
            }
            // 兜底：直接 a.download
            return _fallbackBinaryDownload(bytes, filename, 'application/pdf');
        });
    }

    /** 兜底：二进制下载（无 BOM，直接 Blob） */
    function _fallbackBinaryDownload(bytes, filename, mime) {
        return new Promise(function (resolve, reject) {
            try {
                var blob = new Blob([bytes], { type: mime });
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
            } catch (e) {
                reject(e);
            }
        });
    }

    // ── TXT 导出 ──────────────────────────────────────────────────────────

    function _exportTxt(bookData) {
        var title = bookData.title || bookData.id || '未知';
        var contentStr = win.BK.BookConvert.bookToText(bookData);
        var filename = title + '.txt';
        if (win.BK && win.BK.Export && win.BK.Export.exportText) {
            return win.BK.Export.exportText(contentStr, filename, 'text/plain;charset=utf-8', {
                successMsg: '已导出《' + title + '》TXT',
                bom: true,
                chooseDestination: true
            });
        }
        return _fallbackBinaryDownload(new TextEncoder().encode(contentStr), filename, 'text/plain;charset=utf-8');
    }

    // ── Markdown 导出 ─────────────────────────────────────────────────────

    function _exportMd(bookData) {
        var title = bookData.title || bookData.id || '未知';
        var contentStr = win.BK.BookConvert.bookToMd(bookData);
        var filename = title + '.md';
        if (win.BK && win.BK.Export && win.BK.Export.exportText) {
            return win.BK.Export.exportText(contentStr, filename, 'text/markdown;charset=utf-8', {
                successMsg: '已导出《' + title + '》Markdown',
                bom: true,
                chooseDestination: true
            });
        }
        return _fallbackBinaryDownload(new TextEncoder().encode(contentStr), filename, 'text/markdown;charset=utf-8');
    }

    // ── EPUB 导出 ─────────────────────────────────────────────────────────

    function _exportEpub(bookData) {
        if (!win.JSZip) return Promise.reject(new Error('JSZip 未加载，无法导出 EPUB'));

        var title = bookData.title || bookData.id || '未知';

        // 7) 生成 EPUB 二进制（zip 构建逻辑在 book-convert.js）
        return win.BK.BookConvert.bookToEpub(bookData).then(function (bytes) {
            var filename = title + '.epub';
            if (win.BK && win.BK.Export && win.BK.Export.exportBinary) {
                return win.BK.Export.exportBinary(bytes, filename, 'application/epub+zip', {
                    successMsg: '已导出《' + title + '》EPUB',
                    chooseDestination: true
                });
            }
            return _fallbackBinaryDownload(bytes, filename, 'application/epub+zip');
        });
    }

    // ── 统一出口 ──────────────────────────────────────────────────────────

    /**
     * 导出书籍
     * @param {string} bookId   书籍 ID
     * @param {string} format   导出格式：'pdf' | 'pdf_annotated' | 'txt' | 'md' | 'epub'
     * @returns {Promise}
     */
    function exportBook(bookId, format) {
        format = (format || 'txt').toLowerCase();

        // PDF（原始，不含标注）
        if (format === 'pdf') {
            return _getBookTitle(bookId).then(function (bookTitle) {
                return _exportPdf(bookId, bookTitle);
            });
        }

        // PDF（含标注）
        if (format === 'pdf_annotated') {
            return _getBookTitle(bookId).then(function (bookTitle) {
                if (win.BK && win.BK.Export && win.BK.Export.exportPdfAnnotated) {
                    return win.BK.Export.exportPdfAnnotated(bookId, bookTitle);
                }
                // 兜底：pdf-lib 未加载时回退到原始 PDF 导出
                return _exportPdf(bookId, bookTitle);
            });
        }

        // 其他格式：需要完整 bookData
        return _getBookData(bookId).then(function (bookData) {
            switch (format) {
                case 'txt':   return _exportTxt(bookData);
                case 'md':    return _exportMd(bookData);
                case 'epub':  return _exportEpub(bookData);
                default:      return Promise.reject(new Error('不支持的格式: ' + format));
            }
        });
    }

    /**
     * 获取书籍数据
     * 降级链：BK.SyncShared.getBookData（双 store 直读）→ DataManager.getBook
     * （书城书本地缓存未命中时在线下载兜底，保持切换前行为）
     */
    function _getBookData(bookId) {
        if (win.BK && win.BK.SyncShared && win.BK.SyncShared.getBookData) {
            return win.BK.SyncShared.getBookData(bookId, _syncSharedDeps()).then(function (book) {
                if (book) return book;
                if (win.DataManager && typeof win.DataManager.getBook === 'function') {
                    return win.DataManager.getBook(bookId);
                }
                return Promise.reject(new Error('数据管理器不可用'));
            });
        }
        return Promise.reject(new Error('数据管理器不可用'));
    }

    /** 构造 SyncShared.getBookData 的 store 依赖（已收编至 BK.SyncShared.resolveSharedDeps） */
    function _syncSharedDeps() {
        return win.BK.SyncShared.resolveSharedDeps(win);
    }

    /** 仅获取书名（PDF 用） */
    function _getBookTitle(bookId) {
        var books = win.__bkBooks || [];
        for (var i = 0; i < books.length; i++) {
            if (books[i] && (books[i].id === bookId || books[i].bookId === bookId)) {
                return Promise.resolve(books[i].title || books[i].name || bookId);
            }
        }
        return Promise.resolve(bookId);
    }

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.Export = win.BK.Export || {};
    win.BK.Export.exportBook = exportBook;

})(window);
