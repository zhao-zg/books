/**
 * EPUB 适配器 — 桥接 BKBookmark / BKStorage / renderer-toc-drawer 数据到 MarkPanel
 *
 * 依赖: BKBookmark, BKStorage, renderer-toc-drawer
 */
(function (win) {
    'use strict';
    win.BK = win.BK || {};
    win.BK.MarkPanelAdapters = win.BK.MarkPanelAdapters || {};

    win.BK.MarkPanelAdapters.EpubAdapter = {
        // ─── 目录 ──────────────────────────────────────────────────────
        toc: {
            getItems: function () {
                var items = [];
                var chapterItems = document.querySelectorAll('.bk-toc-chapter-item');
                for (var i = 0; i < chapterItems.length; i++) {
                    var el = chapterItems[i];
                    if (el.classList.contains('bk-toc-hidden')) continue;
                    var numEl = el.querySelector('.bk-toc-chapter-num');
                    var titleEl = el.querySelector('.bk-toc-chapter-title');
                    items.push({
                        id: el.getAttribute('data-toc-nav') || el.getAttribute('href') || ('toc-' + i),
                        title: (numEl ? numEl.textContent.trim() + ' ' : '') + (titleEl ? titleEl.textContent.trim() : ''),
                        depth: 0,
                        position: i,
                        isActive: el.classList.contains('bk-toc-current'),
                        element: el
                    });
                }
                return Promise.resolve(items);
            },

            navigate: function (item) {
                if (item && item.element) item.element.click();
            },

            hasSearch: function () { return true; },

            search: function (keyword) {
                var items = [];
                var q = (keyword || '').toLowerCase();
                var chapterItems = document.querySelectorAll('.bk-toc-chapter-item');
                for (var i = 0; i < chapterItems.length; i++) {
                    var el = chapterItems[i];
                    var text = el.textContent.toLowerCase();
                    if (!q || text.indexOf(q) >= 0) {
                        var numEl = el.querySelector('.bk-toc-chapter-num');
                        var titleEl = el.querySelector('.bk-toc-chapter-title');
                        items.push({
                            id: 'toc-' + i,
                            title: (numEl ? numEl.textContent.trim() + ' ' : '') + (titleEl ? titleEl.textContent.trim() : ''),
                            depth: 0,
                            position: i,
                            isActive: el.classList.contains('bk-toc-current'),
                            element: el
                        });
                    }
                }
                return items;
            }
        },

        // ─── 书签 ──────────────────────────────────────────────────────
        bookmark: {
            getItems: function () {
                if (!win.BKBookmark || !win.BKBookmark.getAll) return Promise.resolve([]);
                return win.BKBookmark.getAll().then(function (bookmarks) {
                    return (bookmarks || []).map(function (bm) {
                        return {
                            id: bm.id,
                            title: bm.title || '未命名书签',
                            subtitle: bm.path ? bm.path.replace(/.*\//, '第') + '章' : '',
                            position: bm.chapterNum || 0,
                            timestamp: bm.timestamp,
                            note: bm.note || '',
                            path: bm.path,
                            scrollY: bm.scrollY,
                            bookId: bm.bookId
                        };
                    });
                });
            },

            add: function (opts) {
                if (!win.BKBookmark || !win.BKBookmark.addCurrent) return Promise.resolve();
                return win.BKBookmark.addCurrent(opts || {});
            },

            remove: function (id) {
                if (!win.BKBookmark || !win.BKBookmark.remove) return Promise.resolve();
                return win.BKBookmark.remove(id);
            },

            updateTitle: function (id, title) {
                if (!win.BKBookmark || !win.BKBookmark.updateTitle) return Promise.resolve();
                return win.BKBookmark.updateTitle(id, title);
            },

            updateNote: function (id, note) {
                if (!win.BKBookmark || !win.BKBookmark.updateNote) return Promise.resolve();
                return win.BKBookmark.updateNote(id, note);
            },

            navigate: function (item) {
                if (!win.BKBookmark || !win.BKBookmark.goto) return;
                win.BKBookmark.goto(item);
            },

            hasCurrentPage: function () {
                if (!win.BKBookmark || !win.BKBookmark.getAll) return Promise.resolve(false);
                return win.BKBookmark.getAll().then(function (bms) {
                    var current = (win.BKRouter && win.BKRouter.currentPath) ? win.BKRouter.currentPath() : '';
                    return (bms || []).some(function (bm) { return bm.path === current; });
                });
            },

            toggleCurrentPage: function (opts) {
                if (!win.BKBookmark || !win.BKBookmark.addCurrent) return Promise.resolve();
                return win.BKBookmark.addCurrent(opts || {});
            }
        },

        // ─── 标记（高亮+笔记）──────────────────────────────────────────
        mark: {
            getItems: function () {
                if (!win.BKStorage || !win.BKStorage.getAllPages) return Promise.resolve([]);
                return win.BKStorage.getAllPages().then(function (pages) {
                    var items = [];
                    (pages || []).forEach(function (page) {
                        (page.highlights || []).forEach(function (hl) {
                            var type = 'highlight';
                            if (hl.underline) type = 'underline';
                            if (!hl.color && !hl.underline && hl.note) type = 'note';

                            items.push({
                                id: hl.id,
                                text: hl.text || '',
                                color: hl.color || null,
                                type: type,
                                note: hl.note || '',
                                position: page.key || 0,
                                timestamp: hl.timestamp,
                                pageKey: page.key
                            });
                        });
                    });
                    items.sort(function (a, b) {
                        var pa = String(a.position);
                        var pb = String(b.position);
                        if (pa < pb) return -1;
                        if (pa > pb) return 1;
                        return (a.timestamp || 0) - (b.timestamp || 0);
                    });
                    return items;
                });
            },

            remove: function (id) {
                if (!win.BKStorage) return Promise.resolve();
                return win.BKStorage.getAllPages().then(function (pages) {
                    var promises = [];
                    (pages || []).forEach(function (page) {
                        var changed = false;
                        var remaining = (page.highlights || []).filter(function (hl) {
                            if (hl.id === id) { changed = true; return false; }
                            return true;
                        });
                        if (changed) {
                            promises.push(win.BKStorage.setPage(page.key, remaining));
                        }
                    });
                    return Promise.all(promises);
                });
            },

            navigate: function (item) {
                if (!item || !item.pageKey) return;
                var parts = item.pageKey.split('/').filter(Boolean);
                if (parts.length >= 2) {
                    var route = 'books-' + parts[0] + '/' + parts[1];
                    if (win.BKRouter && win.BKRouter.navigate) {
                        win.BKRouter.navigate(route);
                    }
                }
            },

            getColors: function () {
                return ['yellow', 'green', 'blue', 'pink'];
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
