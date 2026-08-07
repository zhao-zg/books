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
 *   - DataManager (dm-api.js)
 *   - ImportManager.getPdfDataStore (import-orchestrator.js)
 *   - JSZip (vendor/jszip.min.js) — EPUB 打包
 *
 * 挂载：window.BK.Export.exportBook(bookId, format)
 */
(function (win) {
    'use strict';

    // ── 工具函数 ──────────────────────────────────────────────────────────

    /** HTML 标签剥离（用于 TXT/MD 导出，提取纯文本） */
    function _stripHtml(html) {
        if (!html) return '';
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        return (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();
    }

    /** MD 特殊字符转义（防正文破坏 Markdown 结构） */
    function _escMd(s) {
        if (!s) return '';
        // 转义 \ ` * _ { } [ ] ( ) # + - . ! | > ~ =
        return String(s).replace(/([\\`*_{}\[\]()#+\-.!|>~=])/g, '\\$1');
    }

    /** 内容项 → 纯文本 */
    function _itemToText(item) {
        if (!item) return '';
        var type = item.type || 'paragraph';
        if (type === 'image') return item.alt ? '[图片: ' + item.alt + ']' : '[图片]';
        if (type === 'heading') return item.text || '';
        if (type === 'quote') return item.text || '';
        if (type === 'list') {
            var items = item.items || [];
            var lines = [];
            for (var i = 0; i < items.length; i++) {
                lines.push('  ' + (item.itemHtmls && item.itemHtmls[i] ? _stripHtml(item.itemHtmls[i]) : (items[i] || '')));
            }
            return lines.join('\n');
        }
        if (type === 'table') return item.text || '[表格]';
        if (type === 'code') return item.text || '';
        // 默认：优先取 text，html 做 strip
        return item.text || (item.html ? _stripHtml(item.html) : '');
    }

    /** 内容项 → Markdown */
    function _itemToMd(item) {
        if (!item) return '';
        var type = item.type || 'paragraph';
        if (type === 'image') return '![' + (_escMd(item.alt) || '图片') + '](' + (item.src || '') + ')';
        if (type === 'heading') {
            var level = item.level || 2;
            level = Math.max(1, Math.min(6, level));
            var hashes = '';
            for (var h = 0; h < level; h++) hashes += '#';
            return hashes + ' ' + _escMd(item.text || '');
        }
        if (type === 'quote') return '> ' + _escMd(item.text || '').replace(/\n/g, '\n> ');
        if (type === 'list') {
            var items = item.items || [];
            var itemHtmls = item.itemHtmls || [];
            var ordered = item.attrs && item.attrs.ordered;
            var lines = [];
            for (var i = 0; i < items.length; i++) {
                var prefix = ordered ? (i + 1) + '. ' : '- ';
                lines.push(prefix + _escMd(itemHtmls[i] ? _stripHtml(itemHtmls[i]) : (items[i] || '')));
            }
            return lines.join('\n');
        }
        if (type === 'code') {
            var lang = item.attrs && item.attrs.lang || '';
            return '```' + lang + '\n' + (item.text || '') + '\n```';
        }
        if (type === 'table') {
            // 最小表格：直接输出原文本，或逐行
            return item.text || '[表格]';
        }
        // paragraph / 默认
        var raw = item.text || (item.html ? _stripHtml(item.html) : '');
        return _escMd(raw);
    }

    /** 生成唯一 ID（EPUB 打包用） */
    function _uid() {
        return 'bk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

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
                    bom: false
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
        var chapters = bookData.chapters || [];
        var lines = [];
        lines.push(title);
        lines.push('========================================');
        lines.push('');
        for (var c = 0; c < chapters.length; c++) {
            var ch = chapters[c];
            var chTitle = ch.title || ('第' + (ch.number || c + 1) + '章');
            lines.push('【' + chTitle + '】');
            lines.push('');
            var content = ch.content || [];
            // 兼容 content 为 string
            if (typeof content === 'string') {
                lines.push(content);
            } else {
                for (var i = 0; i < content.length; i++) {
                    var text = _itemToText(content[i]);
                    if (text) lines.push(text);
                }
            }
            lines.push('');
            lines.push('----------------------------------------');
            lines.push('');
        }
        var contentStr = lines.join('\n');
        var filename = title + '.txt';
        if (win.BK && win.BK.Export && win.BK.Export.exportText) {
            return win.BK.Export.exportText(contentStr, filename, 'text/plain;charset=utf-8', {
                successMsg: '已导出《' + title + '》TXT',
                bom: true
            });
        }
        return _fallbackBinaryDownload(new TextEncoder().encode(contentStr), filename, 'text/plain;charset=utf-8');
    }

    // ── Markdown 导出 ─────────────────────────────────────────────────────

    function _exportMd(bookData) {
        var title = bookData.title || bookData.id || '未知';
        var author = bookData.author || '';
        var chapters = bookData.chapters || [];
        var lines = [];
        lines.push('# ' + _escMd(title));
        if (author) lines.push('> ' + _escMd(author));
        lines.push('');
        lines.push('---');
        lines.push('');
        for (var c = 0; c < chapters.length; c++) {
            var ch = chapters[c];
            var chTitle = ch.title || ('第' + (ch.number || c + 1) + '章');
            lines.push('## ' + _escMd(chTitle));
            lines.push('');
            var content = ch.content || [];
            if (typeof content === 'string') {
                lines.push(content);
            } else {
                for (var i = 0; i < content.length; i++) {
                    var md = _itemToMd(content[i]);
                    if (md) lines.push(md);
                }
            }
            lines.push('');
            lines.push('---');
            lines.push('');
        }
        var contentStr = lines.join('\n');
        var filename = title + '.md';
        if (win.BK && win.BK.Export && win.BK.Export.exportText) {
            return win.BK.Export.exportText(contentStr, filename, 'text/markdown;charset=utf-8', {
                successMsg: '已导出《' + title + '》Markdown',
                bom: true
            });
        }
        return _fallbackBinaryDownload(new TextEncoder().encode(contentStr), filename, 'text/markdown;charset=utf-8');
    }

    // ── EPUB 导出 ─────────────────────────────────────────────────────────

    function _exportEpub(bookData) {
        var JSZip = win.JSZip;
        if (!JSZip) return Promise.reject(new Error('JSZip 未加载，无法导出 EPUB'));

        var title = bookData.title || bookData.id || '未知';
        var author = bookData.author || '未知';
        var lang = bookData.language || 'zh';
        var bookId = bookData.id || _uid();
        var chapters = bookData.chapters || [];
        var uid = _uid();

        var zip = new JSZip();

        // 1) mimetype（必须第一个且不压缩）
        zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

        // 2) META-INF/container.xml
        zip.file('META-INF/container.xml',
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
            '  <rootfiles>\n' +
            '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
            '  </rootfiles>\n' +
            '</container>'
        );

        // 3) OEBPS/content.opf
        var manifestItems = '';
        var spineItems = '';
        var navXhtmlId = 'nav';
        manifestItems += '  <item id="' + navXhtmlId + '" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n';

        for (var c = 0; c < chapters.length; c++) {
            var chId = 'ch' + (c + 1);
            var chHref = 'chapter-' + (c + 1) + '.xhtml';
            manifestItems += '  <item id="' + chId + '" href="' + chHref + '" media-type="application/xhtml+xml"/>\n';
            spineItems += '  <itemref idref="' + chId + '"/>\n';
        }

        // CSS
        manifestItems += '  <item id="style" href="style.css" media-type="text/css"/>\n';

        var opfContent =
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n' +
            '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
            '    <dc:identifier id="uid">urn:uuid:' + uid + '</dc:identifier>\n' +
            '    <dc:title>' + _escXml(title) + '</dc:title>\n' +
            '    <dc:creator>' + _escXml(author) + '</dc:creator>\n' +
            '    <dc:language>' + _escXml(lang) + '</dc:language>\n' +
            '    <meta property="dcterms:modified">' + _isoDate() + '</meta>\n' +
            '  </metadata>\n' +
            '  <manifest>\n' + manifestItems +
            '  </manifest>\n' +
            '  <spine>\n' + spineItems +
            '  </spine>\n' +
            '</package>';
        zip.file('OEBPS/content.opf', opfContent);

        // 4) OEBPS/style.css
        zip.file('OEBPS/style.css',
            'body { font-family: serif; margin: 1em; line-height: 1.8; }\n' +
            'h1, h2, h3 { margin: 1em 0 0.5em; }\n' +
            'p { margin: 0.5em 0; text-indent: 2em; }\n' +
            'blockquote { margin: 0.5em 1em; font-style: italic; }\n' +
            'img { max-width: 100%; }\n'
        );

        // 5) OEBPS/nav.xhtml（目录）
        var navLi = '';
        for (var n = 0; n < chapters.length; n++) {
            var chTitle = chapters[n].title || ('第' + (chapters[n].number || n + 1) + '章');
            navLi += '    <li><a href="chapter-' + (n + 1) + '.xhtml">' + _escXml(chTitle) + '</a></li>\n';
        }
        var navContent =
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<!DOCTYPE html>\n' +
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="' + _escXml(lang) + '">\n' +
            '<head><title>' + _escXml(title) + '</title><link rel="stylesheet" href="style.css"/></head>\n' +
            '<body>\n' +
            '  <nav epub:type="toc" id="toc">\n' +
            '    <h1>目录</h1>\n' +
            '    <ol>\n' + navLi +
            '    </ol>\n' +
            '  </nav>\n' +
            '</body></html>';
        zip.file('OEBPS/nav.xhtml', navContent);

        // 6) OEBPS/chapter-N.xhtml（章节正文）
        for (var ci = 0; ci < chapters.length; ci++) {
            var chapter = chapters[ci];
            var chapterTitle = chapter.title || ('第' + (chapter.number || ci + 1) + '章');
            var bodyHtml = '<h1>' + _escXml(chapterTitle) + '</h1>\n';
            var content = chapter.content || [];
            if (typeof content === 'string') {
                bodyHtml += '<p>' + _escXml(content).replace(/\n\n/g, '</p><p>') + '</p>\n';
            } else {
                for (var j = 0; j < content.length; j++) {
                    bodyHtml += _itemToXhtml(content[j]);
                }
            }
            var chapterXhtml =
                '<?xml version="1.0" encoding="UTF-8"?>\n' +
                '<!DOCTYPE html>\n' +
                '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="' + _escXml(lang) + '">\n' +
                '<head><title>' + _escXml(chapterTitle) + '</title><link rel="stylesheet" href="style.css"/></head>\n' +
                '<body>\n' + bodyHtml + '</body></html>';
            zip.file('OEBPS/chapter-' + (ci + 1) + '.xhtml', chapterXhtml);
        }

        // 7) 生成 EPUB 二进制
        return zip.generateAsync({ type: 'uint8array', mimeType: 'application/epub+zip' }).then(function (bytes) {
            var filename = title + '.epub';
            if (win.BK && win.BK.Export && win.BK.Export.exportBinary) {
                return win.BK.Export.exportBinary(bytes, filename, 'application/epub+zip', {
                    successMsg: '已导出《' + title + '》EPUB'
                });
            }
            return _fallbackBinaryDownload(bytes, filename, 'application/epub+zip');
        });
    }

    /** 内容项 → XHTML 片段（EPUB 章节用） */
    function _itemToXhtml(item) {
        if (!item) return '';
        var type = item.type || 'paragraph';
        switch (type) {
            case 'heading':
                var level = item.level || 2;
                level = Math.max(1, Math.min(6, level));
                return '<h' + level + '>' + (item.html || _escXml(item.text || '')) + '</h' + level + '>\n';
            case 'quote':
                return '<blockquote><p>' + (item.html || _escXml(item.text || '')) + '</p></blockquote>\n';
            case 'image':
                return '<figure><img src="' + _escAttr(item.src || '') + '" alt="' + _escAttr(item.alt || '') + '"/></figure>\n';
            case 'list':
                var items = item.items || [];
                var itemHtmls = item.itemHtmls || [];
                var ordered = item.attrs && item.attrs.ordered;
                var tag = ordered ? 'ol' : 'ul';
                var li = '';
                for (var i = 0; i < items.length; i++) {
                    li += '<li>' + (itemHtmls[i] || _escXml(items[i] || '')) + '</li>\n';
                }
                return '<' + tag + '>\n' + li + '</' + tag + '>\n';
            case 'code':
                return '<pre><code>' + _escXml(item.text || '') + '</code></pre>\n';
            case 'table':
                return item.html || '<p>' + _escXml(item.text || '[表格]') + '</p>\n';
            default:
                return '<p>' + (item.html || _escXml(item.text || '')) + '</p>\n';
        }
    }

    /** XML 转义 */
    function _escXml(s) {
        if (!s) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    /** HTML 属性转义（复用） */
    function _escAttr(s) {
        return _escXml(s);
    }

    /** ISO 日期（OPF meta 用） */
    function _isoDate() {
        var d = new Date();
        return d.getFullYear() + '-' +
            ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
            ('0' + d.getDate()).slice(-2) + 'T' +
            ('0' + d.getHours()).slice(-2) + ':' +
            ('0' + d.getMinutes()).slice(-2) + ':' +
            ('0' + d.getSeconds()).slice(-2) + 'Z';
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

    /** 获取书籍数据（优先 ImportManager 导入书，降级 DataManager 下载书） */
    function _getBookData(bookId) {
        if (win.ImportManager && typeof win.ImportManager.getImportedBook === 'function') {
            return win.ImportManager.getImportedBook(bookId).then(function (book) {
                if (book) return book;
                if (win.DataManager && typeof win.DataManager.getBook === 'function') {
                    return win.DataManager.getBook(bookId);
                }
                return null;
            });
        }
        if (win.DataManager && win.DataManager.getBook) {
            return win.DataManager.getBook(bookId);
        }
        return Promise.reject(new Error('数据管理器不可用'));
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
