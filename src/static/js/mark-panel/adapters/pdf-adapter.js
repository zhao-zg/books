/**
 * PDF 适配器 — 桥接 BKPdf._internal (outline/bookmark/highlight) 数据到 MarkPanel
 *
 * 依赖: BKPdf._internal, pdf-state.js
 */
(function (win) {
    'use strict';
    win.BK = win.BK || {};
    win.BK.MarkPanelAdapters = win.BK.MarkPanelAdapters || {};

    /**
     * 获取 PDF state 对象
     * 正确路径：win.BKPdf._internal.state（而非 BKPdf._state）
     */
    function _getS() {
        return (win.BKPdf && win.BKPdf._internal && win.BKPdf._internal.state) || null;
    }

    /**
     * 获取 PDF navigator 对象
     * 挂载在 win.BKPdf._internal.nav
     */
    function _getNav() {
        return (win.BKPdf && win.BKPdf._internal && win.BKPdf._internal.nav) || null;
    }

    function _getBookId() {
        var s = _getS();
        return (s && typeof s.currentBookId === 'function') ? s.currentBookId() : null;
    }

    win.BK.MarkPanelAdapters.PdfAdapter = {
        // ─── 目录 ──────────────────────────────────────────────────────
        toc: {
            getItems: function () {
                var s = _getS();
                var bookId = _getBookId();
                if (!s || !bookId) return Promise.resolve([]);

                return (s.ensureOutlineLoad ? s.ensureOutlineLoad(bookId) : Promise.resolve()).then(function () {
                    var outline = s.outline ? s.outline(bookId) : [];
                    var items = [];
                    function flatten(nodes, depth) {
                        (nodes || []).forEach(function (node, idx) {
                            items.push({
                                id: 'pdf-toc-' + depth + '-' + idx,
                                title: node.title || '',
                                depth: depth,
                                position: node.pageNumber || 0,
                                isActive: false,
                                hasChildren: !!(node.children && node.children.length > 0),
                                _node: node
                            });
                            if (node.children && node.children.length > 0) {
                                flatten(node.children, depth + 1);
                            }
                        });
                    }
                    flatten(outline, 0);
                    return items;
                });
            },

            navigate: function (item) {
                if (!item || !item._node) return;
                var pageNum = item._node.pageNumber;
                var s = _getS();
                if (pageNum) {
                    var nav = _getNav();
                    if (nav && nav.goToPage) nav.goToPage(pageNum, true);
                }
            },

            hasSearch: function () { return false; },

            search: function () { return []; }
        },

        // ─── 书签 ──────────────────────────────────────────────────────
        bookmark: {
            getItems: function () {
                var s = _getS();
                var bookId = _getBookId();
                if (!s || !bookId) return Promise.resolve([]);

                var bms = (s.bookmarks ? s.bookmarks(bookId) : []) || [];
                return Promise.resolve(bms.map(function (bm) {
                    return {
                        id: 'pdf-bm-' + bm.page,
                        title: bm.title || ('第 ' + bm.page + ' 页'),
                        subtitle: '第 ' + bm.page + ' 页',
                        position: bm.page,
                        timestamp: bm.timestamp || 0,
                        note: '',
                        page: bm.page
                    };
                }).sort(function (a, b) { return a.position - b.position; }));
            },

            add: function () {
                var s = _getS();
                var bookId = _getBookId();
                if (!s || !bookId) return Promise.resolve();
                var page = s.currentPage ? s.currentPage() : 1;
                if (s.addBookmark) s.addBookmark(bookId, page, '第 ' + page + ' 页');
                return Promise.resolve();
            },

            remove: function (id) {
                var s = _getS();
                var bookId = _getBookId();
                if (!s || !bookId) return Promise.resolve();
                var page = parseInt(id.replace('pdf-bm-', ''), 10);
                if (page && s.removeBookmark) s.removeBookmark(bookId, page);
                return Promise.resolve();
            },

            updateTitle: function (id, title) {
                var s = _getS();
                var bookId = _getBookId();
                if (!s || !bookId) return Promise.resolve();
                var page = parseInt(id.replace('pdf-bm-', ''), 10);
                if (page && s.setBookmarkTitle) s.setBookmarkTitle(bookId, page, title);
                return Promise.resolve();
            },

            updateNote: function () {
                return Promise.resolve();
            },

            navigate: function (item) {
                if (!item || !item.page) return;
                var nav = _getNav();
                if (nav && nav.goToPage) nav.goToPage(item.page, true);
            },

            hasCurrentPage: function () {
                var s = _getS();
                var bookId = _getBookId();
                if (!s || !bookId) return Promise.resolve(false);
                var page = s.currentPage ? s.currentPage() : 0;
                return Promise.resolve(s.isBookmarked ? s.isBookmarked(bookId, page) : false);
            },

            toggleCurrentPage: function () {
                var bm = win.BKPdf && win.BKPdf._internal && win.BKPdf._internal.bookmark;
                if (bm && bm.toggleCurrentPage) bm.toggleCurrentPage();
                return Promise.resolve();
            }
        },

        // ─── 标记（高亮+笔记）──────────────────────────────────────────
        mark: {
            getItems: function () {
                var s = _getS();
                var bookId = _getBookId();
                if (!s || !bookId) return Promise.resolve([]);

                var hls = (s.highlights ? s.highlights(bookId) : []) || [];
                return Promise.resolve(hls.map(function (hl) {
                    return {
                        id: hl.id,
                        text: hl.text || '',
                        color: hl.color || null,
                        type: hl.type || 'highlight',
                        note: hl.note || '',
                        position: hl.page || 0,
                        timestamp: hl.timestamp || 0,
                        page: hl.page
                    };
                }).sort(function (a, b) {
                    if (a.position !== b.position) return a.position - b.position;
                    return (a.timestamp || 0) - (b.timestamp || 0);
                }));
            },

            remove: function (id) {
                var s = _getS();
                var bookId = _getBookId();
                if (!s || !bookId) return Promise.resolve();
                if (s.removeHighlight) s.removeHighlight(bookId, id);
                return Promise.resolve();
            },

            navigate: function (item) {
                if (!item || !item.page) return;
                var nav = _getNav();
                if (nav && nav.goToPage) nav.goToPage(item.page, true);
            },

            getColors: function () {
                return ['yellow', 'green', 'blue', 'pink', 'orange'];
            },

            filterByType: function (items, type) {
                if (!type || type === 'all') return items;
                return items.filter(function (item) { return item.type === type; });
            },

            filterByColor: function (items, color) {
                if (!color || color === 'all') return items;
                return items.filter(function (item) { return item.color === color; });
            }
        }
    };
})(window);
