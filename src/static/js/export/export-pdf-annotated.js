/**
 * export-pdf-annotated.js — 导出含标注的 PDF
 *
 * 从 localStorage 读取高亮、下划线、删除线、批注和书签数据，
 * 使用 pdf-lib 在 PDF 页面上绘制可视化标注 + 添加标准 PDF 注释对象，
 * 生成带标注的新 PDF 文件。
 *
 * 双重保障策略：
 *   1. 绘制层（drawn on page）：半透明矩形/线条，所有阅读器可见
 *   2. 注释对象（PDF annotation）：标准注释字典，支持弹窗/文本内容/交互
 *
 * 坐标转换：
 *   存储格式为百分比（0-1）相对于 text layer 容器，
 *   PDF 坐标系原点在左下角，Y 轴向上，
 *   转换：pdfX = rect.left * pageWidth
 *         pdfY = (1 - rect.top - rect.height) * pageHeight
 *
 * 依赖：
 *   - pdf-lib (vendor/pdf-lib.min.js)
 *   - BK.Export (export-core.js)
 *   - ImportManager.getPdfDataStore
 *
 * 挂载：window.BK.Export.exportPdfAnnotated(bookId, bookTitle)
 */
(function (win) {
    'use strict';

    var PDFLib = win.PDFLib;

    // ── 颜色映射（CSS 名称 → RGB 0-1 范围）──────────────────────────────
    var COLOR_MAP = {
        yellow: { r: 1.00, g: 0.92, b: 0.23 },
        green:  { r: 0.30, g: 0.69, b: 0.31 },
        blue:   { r: 0.13, g: 0.59, b: 0.95 },
        pink:   { r: 0.91, g: 0.12, b: 0.39 },
        orange: { r: 1.00, g: 0.60, b: 0.00 }
    };

    function _getColor(colorName) {
        return COLOR_MAP[colorName] || COLOR_MAP.yellow;
    }

    // ── 从 localStorage 读取标注数据 ──────────────────────────────────
    function _readHighlights(bookId) {
        // 优先从 BKPdf 状态模块读（内存缓存）
        try {
            var state = win.BKPdf && win.BKPdf._internal && win.BKPdf._internal.state;
            if (state && typeof state.highlights === 'function') {
                var arr = state.highlights(bookId);
                if (arr && arr.length) return arr;
            }
        } catch (e) { /* fallback */ }
        // 兜底直接读 localStorage
        try {
            var raw = localStorage.getItem('bk_pdf_hl:' + bookId);
            if (raw) return JSON.parse(raw);
        } catch (e) {}
        return [];
    }

    function _readBookmarks(bookId) {
        try {
            var state = win.BKPdf && win.BKPdf._internal && win.BKPdf._internal.state;
            if (state && typeof state.bookmarks === 'function') {
                var arr = state.bookmarks(bookId);
                if (arr && arr.length) return arr;
            }
        } catch (e) {}
        try {
            var raw = localStorage.getItem('bk_pdf_bm:' + bookId);
            if (raw) return JSON.parse(raw);
        } catch (e) {}
        return [];
    }

    // ── 坐标转换（百分比 → PDF 坐标）────────────────────────────────
    function _rectToPdf(rect, pageWidth, pageHeight) {
        return {
            x: rect.left * pageWidth,
            y: (1 - rect.top - rect.height) * pageHeight,
            width: rect.width * pageWidth,
            height: rect.height * pageHeight
        };
    }

    // ── 页面绘制层（burned-in，所有阅读器可见）──────────────────────
    function _drawOnPage(page, highlights, pageNum) {
        var pw = page.getWidth();
        var ph = page.getHeight();

        var pageHls = [];
        for (var i = 0; i < highlights.length; i++) {
            if (highlights[i].page === pageNum) pageHls.push(highlights[i]);
        }
        if (!pageHls.length) return;

        for (var h = 0; h < pageHls.length; h++) {
            var hl = pageHls[h];
            var color = _getColor(hl.color || 'yellow');
            var hlType = hl.type || 'highlight';
            var hasNote = !!(hl.note && hl.note.trim());

            for (var r = 0; r < hl.rects.length; r++) {
                var c = _rectToPdf(hl.rects[r], pw, ph);

                if (hlType === 'highlight') {
                    // 半透明矩形覆盖
                    page.drawRectangle({
                        x: c.x, y: c.y,
                        width: Math.max(c.width, 0.5),
                        height: Math.max(c.height, 0.5),
                        color: PDFLib.rgb(color.r, color.g, color.b),
                        opacity: 0.35,
                        borderWidth: 0
                    });
                } else if (hlType === 'underline') {
                    // 底部粗线
                    page.drawLine({
                        start: { x: c.x, y: c.y },
                        end: { x: c.x + c.width, y: c.y },
                        thickness: 1.5,
                        color: PDFLib.rgb(color.r, color.g, color.b),
                        opacity: 0.7
                    });
                } else if (hlType === 'strikethrough') {
                    // 中线
                    var midY = c.y + c.height / 2;
                    page.drawLine({
                        start: { x: c.x, y: midY },
                        end: { x: c.x + c.width, y: midY },
                        thickness: 1.5,
                        color: PDFLib.rgb(color.r, color.g, color.b),
                        opacity: 0.7
                    });
                }

                // 批注标记：小方块图标
                if (hasNote) {
                    var mx = c.x + c.width + 3;
                    var my = c.y + c.height / 2 - 4;
                    page.drawRectangle({
                        x: mx, y: my,
                        width: 8, height: 8,
                        color: PDFLib.rgb(1.0, 0.84, 0.0),
                        opacity: 0.85,
                        borderWidth: 0
                    });
                }
            }
        }
    }

    // ── 注释对象层（PDF annotation dicts，弹窗/交互）────────────────
    function _addAnnotationsToPage(pdfDoc, page, highlights, pageNum) {
        var pw = page.getWidth();
        var ph = page.getHeight();
        var context = pdfDoc.context;
        var PDFName = PDFLib.PDFName;
        var PDFHexString = PDFLib.PDFHexString;
        var PDFNumber = PDFLib.PDFNumber;
        var PDFArray = PDFLib.PDFArray;

        var pageHls = [];
        for (var i = 0; i < highlights.length; i++) {
            if (highlights[i].page === pageNum) pageHls.push(highlights[i]);
        }
        if (!pageHls.length) return;

        // 获取/创建页面 Annots 数组
        var annotsKey = PDFName.of('Annots');
        var annotsArr = page.node.lookup(annotsKey);
        if (!annotsArr || !annotsArr.push) {
            annotsArr = context.obj([]);
            page.node.set(annotsKey, annotsArr);
        }

        for (var h = 0; h < pageHls.length; h++) {
            var hl = pageHls[h];
            var color = _getColor(hl.color || 'yellow');
            var hlType = hl.type || 'highlight';

            // ── 文本标记注释（Highlight / Underline / StrikeOut）──
            var subtype = 'Highlight';
            if (hlType === 'underline') subtype = 'Underline';
            else if (hlType === 'strikethrough') subtype = 'StrikeOut';

            // 计算所有 rect 的边界框
            var bbox = _boundingBox(hl.rects, pw, ph);

            // QuadPoints：每个 rect 一个四边形
            // PDF spec: [x1,y1, x2,y1, x1,y2, x2,y2] （左上、右上、左下、右下）
            var qpValues = [];
            for (var r = 0; r < hl.rects.length; r++) {
                var c = _rectToPdf(hl.rects[r], pw, ph);
                qpValues.push(
                    c.x, c.y + c.height,            // 左上
                    c.x + c.width, c.y + c.height,   // 右上
                    c.x, c.y,                         // 左下
                    c.x + c.width, c.y               // 右下
                );
            }

            var annotFields = {};
            annotFields.Type = PDFName.of('Annot');
            annotFields.Subtype = PDFName.of(subtype);
            annotFields.Rect = context.obj([bbox.x1, bbox.y1, bbox.x2, bbox.y2]);
            annotFields.QuadPoints = context.obj(qpValues);
            annotFields.C = context.obj([color.r, color.g, color.b]);
            annotFields.F = new PDFNumber(4); // Print 标志

            // Contents（选中文本，支持 CJK）
            if (hl.text) {
                annotFields.Contents = PDFHexString.fromText(hl.text.substring(0, 500));
            }

            // T（作者）
            annotFields.T = PDFHexString.fromText('\u4E66\u62A5'); // "书报"

            // 创建注释字典并注册
            var annotDict = context.obj(annotFields);
            var annotRef = context.register(annotDict);
            annotsArr.push(annotRef);

            // ── 批注：额外添加 Text 注释（弹窗）──
            if (hl.note && hl.note.trim()) {
                var noteRect = [
                    bbox.x2 + 2,
                    bbox.y2 - 5,
                    bbox.x2 + 22,
                    bbox.y2 + 15
                ];

                var noteFields = {};
                noteFields.Type = PDFName.of('Annot');
                noteFields.Subtype = PDFName.of('Text');
                noteFields.Rect = context.obj(noteRect);
                noteFields.Contents = PDFHexString.fromText(hl.note.substring(0, 2000));
                noteFields.C = context.obj([color.r, color.g, color.b]);
                noteFields.T = PDFHexString.fromText('\u4E66\u62A5');
                noteFields.Name = PDFName.of('Note');
                noteFields.F = new PDFNumber(4);

                var noteDict = context.obj(noteFields);
                var noteRef = context.register(noteDict);
                annotsArr.push(noteRef);
            }
        }
    }

    // ── 计算所有 rect 的边界框 ──────────────────────────────────────
    function _boundingBox(rects, pw, ph) {
        var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (var i = 0; i < rects.length; i++) {
            var c = _rectToPdf(rects[i], pw, ph);
            if (c.x < x1) x1 = c.x;
            if (c.y < y1) y1 = c.y;
            if (c.x + c.width > x2) x2 = c.x + c.width;
            if (c.y + c.height > y2) y2 = c.y + c.height;
        }
        return { x1: x1, y1: y1, x2: x2, y2: y2 };
    }

    // ── 书签 → PDF Outline ──────────────────────────────────────────
    function _addBookmarksToOutline(pdfDoc, bookmarks) {
        if (!bookmarks || !bookmarks.length) return;

        var context = pdfDoc.context;
        var PDFName = PDFLib.PDFName;
        var PDFHexString = PDFLib.PDFHexString;
        var PDFArray = PDFLib.PDFArray;
        var PDFDict = PDFLib.PDFDict;
        var PDFNumber = PDFLib.PDFNumber;

        // 获取/创建 Outlines 根
        var catalog = pdfDoc.catalog;
        var outlinesKey = PDFName.of('Outlines');
        var outlinesRef = catalog.lookup(outlinesKey);

        if (!outlinesRef) {
            // 创建 Outlines 字典
            var outlinesDict = context.obj({});
            outlinesRef = context.register(outlinesDict);
            catalog.set(outlinesKey, outlinesRef);

            outlinesDict.set(PDFName.of('Type'), PDFName.of('Outlines'));
        }

        // 按 page 排序书签
        var sorted = bookmarks.slice().sort(function (a, b) { return a.page - b.page; });

        // 创建书签条目
        var prevRef = null;
        var firstRef = null;
        var entryRefs = [];

        for (var i = 0; i < sorted.length; i++) {
            var bm = sorted[i];
            var pageNum = bm.page;
            var pageIndex = Math.max(0, Math.min(pageNum - 1, pdfDoc.getPageCount() - 1));
            var page = pdfDoc.getPage(pageIndex);
            var pageRef = page.node.ref || context.add(page.node);

            var entryDict = context.obj({});
            var entryRef = context.register(entryDict);

            entryDict.set(PDFName.of('Title'), PDFHexString.fromText(bm.title || ('\u7B2C' + pageNum + '\u9875')));
            entryDict.set(PDFName.of('Parent'), outlinesRef);
            entryDict.set(PDFName.of('Dest'), context.obj([
                pageRef,
                PDFName.of('XYZ'),
                new PDFNumber(0),
                new PDFNumber(page.getHeight()),
                new PDFNumber(0)
            ]));

            if (prevRef) {
                entryDict.set(PDFName.of('Prev'), prevRef);
                // 在前一个条目上设置 Next
                var prevDict = context.lookup(prevRef);
                if (prevDict && prevDict.set) {
                    prevDict.set(PDFName.of('Next'), entryRef);
                }
            }

            prevRef = entryRef;
            entryRefs.push(entryRef);
            if (i === 0) firstRef = entryRef;
        }

        // 设置 Outlines 根的 First/Last/Count
        var outlinesDictObj = context.lookup(outlinesRef);
        if (outlinesDictObj && outlinesDictObj.set) {
            outlinesDictObj.set(PDFName.of('First'), firstRef);
            outlinesDictObj.set(PDFName.of('Last'), prevRef);
            outlinesDictObj.set(PDFName.of('Count'), new PDFNumber(sorted.length));
        }
    }

    // ── 主函数 ────────────────────────────────────────────────────────
    /**
     * 导出含标注的 PDF
     * @param {string} bookId    书籍 ID
     * @param {string} bookTitle 书名（用于导出文件名）
     * @returns {Promise}
     */
    function exportPdfAnnotated(bookId, bookTitle) {
        if (!PDFLib) {
            return Promise.reject(new Error('pdf-lib 未加载，无法导出带标注PDF'));
        }

        // 1) 读取原始 PDF 数据
        var store = (win.ImportManager && typeof win.ImportManager.getPdfDataStore === 'function')
            ? win.ImportManager.getPdfDataStore() : null;
        if (!store) {
            return Promise.reject(new Error('PDF 数据存储不可用'));
        }

        var pdfBytes;
        var highlights;
        var bookmarks;

        return store.getItem('pdf:' + bookId).then(function (data) {
            if (!data) return Promise.reject(new Error('PDF 数据未找到: ' + bookId));
            pdfBytes = new Uint8Array(data);

            // 2) 读取标注数据
            highlights = _readHighlights(bookId);
            bookmarks = _readBookmarks(bookId);

            // 没有任何标注，直接导出原始 PDF
            if (!highlights.length && !bookmarks.length) {
                var filename = (bookTitle || bookId) + '.pdf';
                if (win.BK && win.BK.Export && win.BK.Export.exportBinary) {
                    return win.BK.Export.exportBinary(pdfBytes, filename, 'application/pdf', {
                        successMsg: '无标注数据，已导出原始PDF',
                        bom: false
                    }).then(function () { return { noAnnotations: true }; });
                }
                return { noAnnotations: true };
            }

            // 3) 加载 PDF
            return PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        }).then(function (result) {
            // 如果已走"无标注"分支直接返回
            if (result && result.noAnnotations) return result;

            var pdfDoc = result;

            // 4) 在每页绘制标注 + 添加注释对象
            var pageCount = pdfDoc.getPageCount();
            for (var i = 0; i < pageCount; i++) {
                var page = pdfDoc.getPage(i);
                var pageNum = i + 1;
                _drawOnPage(page, highlights, pageNum);
                _addAnnotationsToPage(pdfDoc, page, highlights, pageNum);
            }

            // 5) 添加书签到 PDF Outline
            if (bookmarks.length) {
                _addBookmarksToOutline(pdfDoc, bookmarks);
            }

            // 6) 保存
            return pdfDoc.save().then(function (modifiedBytes) {
                var filename = (bookTitle || bookId) + '-标注.pdf';
                var hlCount = highlights.length;
                var bmCount = bookmarks.length;
                var noteCount = 0;
                for (var n = 0; n < highlights.length; n++) {
                    if (highlights[n].note && highlights[n].note.trim()) noteCount++;
                }

                var msg = '已导出含标注PDF（' + hlCount + '条标注' +
                    (noteCount ? '、' + noteCount + '条批注' : '') +
                    (bmCount ? '、' + bmCount + '个书签' : '') + '）';

                if (win.BK && win.BK.Export && win.BK.Export.exportBinary) {
                    return win.BK.Export.exportBinary(
                        new Uint8Array(modifiedBytes), filename, 'application/pdf',
                        { successMsg: msg, bom: false }
                    );
                }
                // 兜底
                return { bytes: modifiedBytes, filename: filename, msg: msg };
            });
        });
    }

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.Export = win.BK.Export || {};
    win.BK.Export.exportPdfAnnotated = exportPdfAnnotated;

})(window);
