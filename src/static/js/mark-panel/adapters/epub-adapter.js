/**
 * EPUB 适配器 — 桥接 BKBookmark / BKStorage / renderer-toc-drawer 数据到 MarkPanel
 *
 * 依赖: BKBookmark, BKStorage, renderer-toc-drawer
 */
(function (win) {
    'use strict';
    win.BK = win.BK || {};
    win.BK.MarkPanelAdapters = win.BK.MarkPanelAdapters || {};

    /** 获取当前阅读的 EPUB 书籍 ID */
    function _getCurrentBookId() {
        var path = win.__bkCurrentPath || '';
        var parts = path.split('/').filter(Boolean);
        return parts[0] || '';
    }

    win.BK.MarkPanelAdapters.EpubAdapter = {
        // ─── 目录 ──────────────────────────────────────────────────────
        toc: {
            /**
             * 获取目录数据：直接通过 loadBook 获取章节数据，不依赖旧 TOC 抽屉 DOM
             */
            getItems: function () {
                // 优先从旧抽屉 DOM 读取（已打开过的场景）
                var chapterItems = document.querySelectorAll('.bk-toc-chapter-item');
                if (chapterItems.length > 0) {
                    var items = [];
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
                }

                // 降级：通过 loadBook API 获取章节列表
                var bookId = _getCurrentBookId();
                if (!bookId) return Promise.resolve([]);

                if (typeof loadBook !== 'function') return Promise.resolve([]);
                return loadBook(bookId).then(function (book) {
                    if (!book || !book.chapters) return [];
                    var chapters = book.chapters;
                    // 去重
                    var seen = {};
                    var unique = [];
                    for (var j = 0; j < chapters.length; j++) {
                        var ch = chapters[j];
                        var chNum = ch.number || (j + 1);
                        if (!seen[chNum]) {
                            seen[chNum] = true;
                            unique.push(ch);
                        }
                    }
                    var progress = (typeof getReadingProgress === 'function') ? getReadingProgress(bookId) : 0;
                    var items = [];
                    for (var k = 0; k < unique.length; k++) {
                        var c = unique[k];
                        var num = c.number || (k + 1);
                        items.push({
                            id: 'toc-' + num,
                            title: num + ' ' + (c.title || '第' + num + '章'),
                            depth: 0,
                            position: k,
                            isActive: (num === progress),
                            chapterNum: num,
                            bookId: bookId
                        });
                    }
                    return items;
                }).catch(function () { return []; });
            },

            navigate: function (item) {
                if (item && item.element) {
                    // 从旧 DOM 取的条目，直接 click
                    item.element.click();
                    return;
                }
                // 从 loadBook 取的条目，通过路由跳转
                if (item && item.bookId && item.chapterNum) {
                    if (win.BKRouter && win.BKRouter.navigate) {
                        win.BKRouter.navigate(item.bookId + '/' + item.chapterNum);
                    }
                }
            },

            hasSearch: function () { return true; },

            search: function (keyword) {
                var q = (keyword || '').toLowerCase();
                // 先尝试从 DOM 读取
                var chapterItems = document.querySelectorAll('.bk-toc-chapter-item');
                if (chapterItems.length > 0) {
                    var items = [];
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
                // 降级：无法搜索（未加载 DOM），返回空
                return [];
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
                            subtitle: bm.chapterNum ? '第' + bm.chapterNum + '章' : '',
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

            add: function (titleInfo) {
                if (!win.BKBookmark || !win.BKBookmark.addCurrent) return Promise.resolve();
                // 补充 bookTitle（如果外部未传）
                titleInfo = titleInfo || {};
                if (!titleInfo.bookTitle) {
                    titleInfo.bookTitle = (win.BKRenderer && win.BKRenderer._currentBookTitle) || '';
                }
                if (!titleInfo.chapterTitle) {
                    titleInfo.chapterTitle = (win.BKRenderer && win.BKRenderer._currentChapterTitle) || '';
                }
                return win.BKBookmark.addCurrent(titleInfo);
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
                    var current = win.__bkCurrentPath || '';
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
                // pageKey 格式为 "bookId/chapterNum"，直接作为路由路径
                if (win.BKRouter && win.BKRouter.navigate) {
                    win.BKRouter.navigate(item.pageKey);
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
