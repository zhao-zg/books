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

    // ── 纲目提取缓存 ──────────────────────────────────────────────
    var _outlineCache = {};
    // 注：全文搜索所需的内容索引加载由 DataManager.loadContentIndexes() 幂等管理，
    // 无需在本适配器维护独立的加载状态标志。

    // ── 纲目提取辅助函数 ──────────────────────────────────────────

    function _cacheKey(bookId, chapterNum) {
        return bookId + '_' + chapterNum;
    }

    /** 从 Content[] 数组提取 heading（导入书路径） */
    function _extractOutlinesFromArray(contentArr) {
        var outlines = [];
        for (var i = 0; i < contentArr.length; i++) {
            var item = contentArr[i];
            if (item && item.type === 'heading') {
                outlines.push({
                    text: item.text || '',
                    level: item.level || 2,
                    index: i
                });
            }
        }
        return outlines;
    }

    /** 从纯字符串 content 提取 heading（书城书路径） */
    function _extractOutlinesFromString(contentStr, chapter) {
        if (!contentStr) return [];
        var renderFn = win.renderChapterContent || (typeof renderChapterContent !== 'undefined' ? renderChapterContent : null);
        if (!renderFn) return [];

        var hidden = document.createElement('div');
        hidden.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;';
        hidden.innerHTML = renderFn(chapter, false);
        document.body.appendChild(hidden);

        var headings = hidden.querySelectorAll('.bk-heading');
        var outlines = [];
        for (var i = 0; i < headings.length; i++) {
            var h = headings[i];
            var levelMatch = /bk-h(\d)/.exec(h.className || '');
            outlines.push({
                text: h.textContent.trim(),
                level: levelMatch ? parseInt(levelMatch[1], 10) : 2,
                index: i
            });
        }
        document.body.removeChild(hidden);
        return outlines;
    }

    /** 从 carousel 已渲染的 DOM 提取 heading（优化路径，仅从当前页） */
    function _extractOutlinesFromCarousel() {
        var currPage = document.getElementById('carouselPageCurr');
        if (currPage) {
            var headings = currPage.querySelectorAll('.bk-heading');
            if (headings.length > 0) return _headingsToOutlines(headings);
        }
        return null;
    }

    function _headingsToOutlines(headings) {
        var outlines = [];
        for (var i = 0; i < headings.length; i++) {
            var h = headings[i];
            var levelMatch = /bk-h(\d)/.exec(h.className || '');
            outlines.push({
                text: h.textContent.trim(),
                level: levelMatch ? parseInt(levelMatch[1], 10) : 2,
                index: i
            });
        }
        return outlines;
    }

    /** 全词 AND 匹配：所有关键词都出现在 hay 中才算匹配 */
    function _allMatch(hay, terms) {
        for (var i = 0; i < terms.length; i++) {
            if (hay.indexOf(terms[i]) === -1) return false;
        }
        return true;
    }

    win.BK.MarkPanelAdapters.EpubAdapter = {
        // ─── 通用 ──────────────────────────────────────────────────────
        getBookTitle: function () {
            return (win.BKRenderer && win.BKRenderer._currentBookTitle) || '';
        },

        /** 清空纲目缓存（切换书籍时调用） */
        clearOutlineCache: function () {
            _outlineCache = {};
        },

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
                            title: titleEl ? titleEl.textContent.trim() : '',
                            num: numEl ? parseInt(numEl.textContent.trim(), 10) : (i + 1),
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
                            title: c.title || ('\u7b2c' + num + '\u7ae0'),
                            num: num,
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

            /**
             * 获取章节纲目列表
             * @param {string} bookId
             * @param {number} chapterNum
             * @returns {Promise<Array<{text, level, index}>>}
             */
            getOutlines: function (bookId, chapterNum) {
                var key = _cacheKey(bookId, chapterNum);
                if (_outlineCache[key]) {
                    return Promise.resolve(_outlineCache[key]);
                }

                // 优先从 carousel DOM 提取（仅当请求的是当前正在阅读的章节）
                var pathParts = (win.__bkCurrentPath || '').split('/').filter(Boolean);
                var currChapterNum = pathParts[1] ? parseInt(pathParts[1], 10) : -1;
                if (currChapterNum === chapterNum) {
                    var fromCarousel = _extractOutlinesFromCarousel();
                    if (fromCarousel) {
                        _outlineCache[key] = fromCarousel;
                        return Promise.resolve(fromCarousel);
                    }
                }

                // 降级：通过 loadBook 获取章节数据后提取
                if (typeof loadBook !== 'function') return Promise.resolve([]);
                return loadBook(bookId).then(function (book) {
                    if (!book || !book.chapters) return [];
                    var chapter = null;
                    for (var i = 0; i < book.chapters.length; i++) {
                        if (book.chapters[i].number === chapterNum) {
                            chapter = book.chapters[i];
                            break;
                        }
                    }
                    if (!chapter) return [];

                    var content = chapter.content;
                    var outlines;

                    // 判断 content 类型选择提取策略
                    if (Array.isArray(content)) {
                        // Content[] 数组（导入书）
                        outlines = _extractOutlinesFromArray(content);
                    } else if (typeof content === 'string') {
                        // 纯字符串（书城书）
                        outlines = _extractOutlinesFromString(content, chapter);
                    } else {
                        outlines = [];
                    }

                    _outlineCache[key] = outlines;
                    return outlines;
                }).catch(function () { return []; });
            },

            /**
             * 跳转到章节并滚动到纲目 heading 位置
             * @param {string} bookId
             * @param {number} chapterNum
             * @param {number} outlineIndex  heading 在 querySelectorAll('.bk-heading') 中的索引
             */
            navigateOutline: function (bookId, chapterNum, outlineIndex) {
                // 1. 路由跳转到章节
                if (win.BKRouter && win.BKRouter.navigate) {
                    win.BKRouter.navigate(bookId + '/' + chapterNum);
                }
                // 2. 延迟后滚动到 heading（等待章节渲染完成）
                setTimeout(function () {
                    var contentEl = document.getElementById('chapterContent') ||
                                    document.querySelector('.bk-carousel-page .content');
                    if (!contentEl) return;
                    var headings = contentEl.querySelectorAll('.bk-heading');
                    if (outlineIndex >= 0 && outlineIndex < headings.length) {
                        headings[outlineIndex].scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                }, 350);
            },

            hasSearch: function () { return true; },

            search: function (keyword) {
                var q = (keyword || '').trim().toLowerCase();
                if (!q) return Promise.resolve([]);
                var bookId = _getCurrentBookId();
                if (!bookId) return Promise.resolve([]);

                var terms = q.split(/\s+/).filter(Boolean);
                var self = this;

                // ── 阶段1：标题匹配（loadBook 数据源，不依赖旧抽屉 DOM）──
                function matchTitles() {
                    var results = [];

                    // 旧抽屉 DOM 已打开时优先（含 isActive 高亮，可即时响应）
                    var chapterItems = document.querySelectorAll('.bk-toc-chapter-item');
                    if (chapterItems.length > 0) {
                        for (var i = 0; i < chapterItems.length; i++) {
                            var el = chapterItems[i];
                            var numEl = el.querySelector('.bk-toc-chapter-num');
                            var titleEl = el.querySelector('.bk-toc-chapter-title');
                            var num = numEl ? parseInt(numEl.textContent.trim(), 10) : (i + 1);
                            var title = titleEl ? titleEl.textContent.trim() : '';
                            if (_allMatch(title.toLowerCase(), terms)) {
                                results.push({
                                    id: 'toc-' + num,
                                    title: title,
                                    num: num,
                                    depth: 0,
                                    position: i,
                                    isActive: el.classList.contains('bk-toc-current'),
                                    element: el,
                                    context: '',
                                    score: 2
                                });
                            }
                        }
                        return Promise.resolve(results);
                    }

                    // 无旧抽屉 DOM：通过 loadBook 获取章节列表做标题匹配
                    if (typeof loadBook !== 'function') return Promise.resolve(results);
                    return loadBook(bookId).then(function (book) {
                        if (!book || !book.chapters) return results;
                        var seen = {};
                        var matched = [];
                        var progress = (typeof getReadingProgress === 'function') ? getReadingProgress(bookId) : 0;
                        var chapters = book.chapters;
                        for (var j = 0; j < chapters.length; j++) {
                            var ch = chapters[j];
                            var num = ch.number || (j + 1);
                            if (seen[num]) continue;
                            seen[num] = true;
                            var title = ch.title || ('\u7b2c' + num + '\u7ae0');
                            if (_allMatch(title.toLowerCase(), terms)) {
                                matched.push({
                                    id: 'toc-' + num,
                                    title: title,
                                    num: num,
                                    depth: 0,
                                    position: j,
                                    isActive: (num === progress),
                                    context: '',
                                    score: 2,
                                    chapterNum: num,
                                    bookId: bookId
                                });
                            }
                        }
                        return results.concat(matched);
                    }).catch(function () { return results; });
                }

                // ── 阶段2：全文匹配（复用 DataManager 内容索引）──
                function matchChapters(titleResults) {
                    var DM = win.DataManager;
                    if (!DM || !DM.getContentIndexMap || !DM.loadContentIndexes) {
                        return Promise.resolve(titleResults);
                    }

                    var indexMap = DM.getContentIndexMap();
                    // 索引尚未加载：触发加载后重跑整个搜索（标题+全文）
                    if (!indexMap) {
                        return DM.loadContentIndexes().then(function () {
                            return self.search(keyword);
                        }).catch(function () {
                            return titleResults;
                        });
                    }

                    // 索引已加载但当前书无索引（未下载/未导入或索引缺失）：仅标题结果
                    var bookIdx = indexMap[bookId];
                    if (!bookIdx || !bookIdx.chapters) return Promise.resolve(titleResults);

                    var results = titleResults.slice();
                    var chapters = bookIdx.chapters;
                    for (var c = 0; c < chapters.length; c++) {
                        var ch = chapters[c];
                        var hayTitle = (ch.t || '').toLowerCase();
                        var hayContent = (ch.c || '').toLowerCase();
                        var hayCombined = hayTitle + ' ' + hayContent;
                        if (!_allMatch(hayCombined, terms)) continue;

                        // 跳过已通过标题匹配添加的结果
                        var chNum = ch.n;
                        var dup = false;
                        for (var r = 0; r < results.length; r++) {
                            if (results[r].num === chNum) { dup = true; break; }
                        }
                        if (dup) continue;

                        // 提取上下文片段
                        var context = '';
                        if (hayContent) {
                            var firstPos = -1;
                            for (var t = 0; t < terms.length; t++) {
                                var p = hayContent.indexOf(terms[t]);
                                if (p !== -1 && (firstPos === -1 || p < firstPos)) firstPos = p;
                            }
                            if (firstPos !== -1) {
                                var ctxFrom = Math.max(0, firstPos - 30);
                                var ctxTo = Math.min(hayContent.length, firstPos + 30);
                                context = (ctxFrom > 0 ? '\u2026' : '') +
                                    ch.c.substring(ctxFrom, ctxTo) +
                                    (ctxTo < hayContent.length ? '\u2026' : '');
                            }
                        }

                        results.push({
                            id: 'toc-' + chNum,
                            title: ch.t || ('\u7b2c' + chNum + '\u7ae0'),
                            num: chNum,
                            depth: 0,
                            position: results.length,
                            isActive: false,
                            context: context,
                            score: 1,
                            chapterNum: chNum,
                            bookId: bookId
                        });
                    }

                    // 按评分排序：标题匹配(score 2)优先
                    results.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
                    return Promise.resolve(results);
                }

                return matchTitles().then(matchChapters);
            }
        },

        // ─── 书签 ──────────────────────────────────────────────────────
        bookmark: {
            getItems: function () {
                if (!win.BKBookmark || !win.BKBookmark.getAll) return Promise.resolve([]);
                var currentBookId = _getCurrentBookId();
                return win.BKBookmark.getAll().then(function (bookmarks) {
                    return (bookmarks || []).filter(function (bm) {
                        // 仅返回当前书籍的书签（bookId 为空时兼容旧数据，保留显示）
                        return !bm.bookId || !currentBookId || bm.bookId === currentBookId;
                    }).map(function (bm) {
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

            addFromSnapshot: function (snapshot) {
                // 从快照恢复书签（撤销删除用）
                if (!win.BKBookmark || !win.BKBookmark.addFromSnapshot) {
                    // 降级：重新添加当前页
                    return win.BK.MarkPanelAdapters.EpubAdapter.bookmark.add(snapshot);
                }
                return win.BKBookmark.addFromSnapshot(snapshot);
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
                if (!win.BKBookmark || !win.BKBookmark.getAll || !win.BKBookmark.addCurrent || !win.BKBookmark.remove) return Promise.resolve();
                var current = win.__bkCurrentPath || '';
                return win.BKBookmark.getAll().then(function (bms) {
                    var existing = (bms || []).find(function (bm) { return bm.path === current; });
                    if (existing) {
                        return win.BKBookmark.remove(existing.id);
                    } else {
                        return win.BKBookmark.addCurrent(opts || {});
                    }
                });
            }
        },

        // ─── 标记（高亮+批注）──────────────────────────────────────────
        mark: {
            getItems: function () {
                if (!win.BKStorage || !win.BKStorage.getAllPages) return Promise.resolve([]);
                var currentBookId = _getCurrentBookId();
                return win.BKStorage.getAllPages().then(function (pages) {
                    var items = [];
                    (pages || []).forEach(function (page) {
                        // 仅加载当前书籍的标记（pageKey 格式为 "/bookId/chapterNum"，带前导 /）
                        if (currentBookId && page.key && page.key.indexOf('/' + currentBookId + '/') !== 0) return;

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

            addFromSnapshot: function (snapshot) {
                // 从快照恢复标记（撤销删除用）
                if (!win.BKStorage || !win.BKStorage.addHighlightFromSnapshot) {
                    // 降级：无操作，无法恢复
                    return Promise.resolve();
                }
                return win.BKStorage.addHighlightFromSnapshot(snapshot);
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

            updateNote: function (id, note) {
                if (win.BKHighlight && win.BKHighlight.saveNote) {
                    win.BKHighlight.saveNote(id, note);
                    // saveNote 是异步存储的，通知 MarkPanel 刷新
                    try { document.dispatchEvent(new CustomEvent('marks-changed')); } catch (e) {}
                }
                return Promise.resolve();
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

            getFilterTypes: function () {
                return [
                    { key: 'all', label: '全部' },
                    { key: 'highlight', label: '\uD83D\uDD8C高亮' },
                    { key: 'underline', label: 'U\u0332下划线' },
                    { key: 'note', label: '\uD83D\uDCDD批注' }
                ];
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
