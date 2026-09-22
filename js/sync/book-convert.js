/**
 * book-convert.js — 书籍文本转换共享实现（收编重复实现）
 *
 * 收编自以下文件的重复转换函数（以 export-book.js 版本为准）：
 *   - export-book.js:  _exportTxt/_exportMd/_exportEpub 内的拼接逻辑
 *                     → bookToText / bookToMd / bookToEpub
 *   - webdav-upload.js: _bookToText / _bookToMd / _bookToEpub（内联降级版）
 *
 * 合并差异说明（webdav-upload 内联版 → 统一采用 export-book 版）：
 *   1. _bookToText：webdav 版无类型感知（image/list/table 等 item 全部退化为
 *      text||stripHtml，图片占位、列表逐行、表格兜底均丢失）。统一为
 *      export-book 的 _itemToText 类型感知版。
 *   2. _bookToMd：webdav 版同样无类型感知且正文不 escMd 转义。统一为
 *      export-book 的 _itemToMd 版（heading/quote/list/code/image/table 全类型
 *      + escMd 防结构破坏）。
 *   3. _bookToEpub：webdav 版 lang 固定 'zh'、uid 无随机段、所有 item 一律
 *      <p> 包裹（heading/list 等结构全丢）、_escXml 只转义 &<>（引号漏转）、
 *      CSS 为单行压缩版、章题回退无 number。统一为 export-book 完整版
 *      （language 可配、_itemToXhtml 类型感知、_escXml 5 字符转义、
 *      多规则 CSS、章题回退含 number）。
 *
 * 与原 export-book 实现的差异（解耦导出动作，纯转换）：
 *   - 原 _exportTxt/_exportMd/_exportEpub 在拼接完成后调用
 *     BK.Export.exportText/exportBinary 触发下载/保存。本模块只做「数据 →
 *     文本/字节」的转换，导出动作（文件名、MIME、BOM、successMsg、
 *     chooseDestination 等）由调用方（export-book.js / webdav-upload.js）负责。
 *   - bookToEpub(bookData, opts) 通过 opts.JSZip 注入 JSZip 构造器（缺省读
 *     win.JSZip），避免单测依赖 vendor 脚本。
 *
 * 依赖：
 *   - document.createElement（_stripHtml 用，JSDOM/浏览器均可用）
 *   - JSZip（opts.JSZip 或 win.JSZip）— EPUB 打包
 *
 * 挂载：window.BK.BookConvert
 *   .bookToText(bookData)                → string
 *   .bookToMd(bookData)                  → string
 *   .bookToEpub(bookData, opts)          → Promise<Uint8Array>
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

    /** XML 转义 */
    function _escXml(s) {
        if (!s) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    /** HTML 属性转义（复用） */
    function _escAttr(s) {
        return _escXml(s);
    }

    /** 生成唯一 ID（EPUB 打包用） */
    function _uid() {
        return 'bk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
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

    // ── 内容项转换（TXT）─────────────────────────────────────────────────

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

    // ── 章节标题回退 ──────────────────────────────────────────────────────

    /** 章节标题：title → 第<number>章 → 第<index+1>章 */
    function _chapterTitle(ch, index) {
        return ch.title || ('第' + (ch.number || index + 1) + '章');
    }

    // ── TXT 转换 ──────────────────────────────────────────────────────────

    /**
     * 书籍数据 → TXT 纯文本
     * 结构：书名 / 40= 分隔 / 每章【章题】+ 正文 + 40- 分隔
     * @param {Object} bookData
     * @returns {string}
     */
    function bookToText(bookData) {
        var title = bookData.title || bookData.id || '未知';
        var chapters = bookData.chapters || [];
        var lines = [];
        lines.push(title);
        lines.push('========================================');
        lines.push('');
        for (var c = 0; c < chapters.length; c++) {
            var ch = chapters[c];
            lines.push('【' + _chapterTitle(ch, c) + '】');
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
        return lines.join('\n');
    }

    // ── Markdown 转换 ─────────────────────────────────────────────────────

    /**
     * 书籍数据 → Markdown
     * 结构：# 书名 / > 作者 / --- / 每章 ## 章题 + 正文 + ---
     * @param {Object} bookData
     * @returns {string}
     */
    function bookToMd(bookData) {
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
            lines.push('## ' + _escMd(_chapterTitle(ch, c)));
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
        return lines.join('\n');
    }

    // ── EPUB 转换 ─────────────────────────────────────────────────────────

    /**
     * 书籍数据 → EPUB 3.0 字节流
     * 只负责构建 zip（mimetype 首条 STORE + META-INF + OEBPS），不触发下载。
     * @param {Object} bookData
     * @param {Object} [opts]
     *   - opts.JSZip {Function} JSZip 构造器（缺省 win.JSZip）
     * @returns {Promise<Uint8Array>}
     */
    function bookToEpub(bookData, opts) {
        var JSZip = (opts && opts.JSZip) || win.JSZip;
        if (!JSZip) return Promise.reject(new Error('JSZip 未加载，无法导出 EPUB'));

        var title = bookData.title || bookData.id || '未知';
        var author = bookData.author || '未知';
        var lang = bookData.language || 'zh';
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
        manifestItems += '  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n';

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
            navLi += '    <li><a href="chapter-' + (n + 1) + '.xhtml">' + _escXml(_chapterTitle(chapters[n], n)) + '</a></li>\n';
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
            var chapterTitle = _chapterTitle(chapter, ci);
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
        return zip.generateAsync({ type: 'uint8array', mimeType: 'application/epub+zip' });
    }

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.BookConvert = {
        bookToText: bookToText,
        bookToMd: bookToMd,
        bookToEpub: bookToEpub
    };

})(window);
