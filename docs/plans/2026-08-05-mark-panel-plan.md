---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'd21225f2-7d28-400d-a8b2-93eb85aac619'
  PropagateID: 'd21225f2-7d28-400d-a8b2-93eb85aac619'
  ReservedCode1: '73c9d932-7bf3-4127-88f1-b6af0978b83f'
  ReservedCode2: '73c9d932-7bf3-4127-88f1-b6af0978b83f'
---

# MarkPanel 统一标记面板 — 实现计划

> **For implementer:** Use TDD throughout. Write failing test first. Watch it fail. Then implement.

**Goal:** 将分散的目录/书签/高亮标记功能合并为统一的左侧抽屉面板，3 Tab 切换（目录|书签|标记），EPUB 和 PDF 共享同一套 UI 组件。

**Architecture:** 适配器模式 — MarkPanel 统一 UI 通过适配器抽象 EPUB/PDF 数据差异，条目采用紧凑列表 + 左侧颜色条，按页码排序。

**Tech Stack:** 纯前端 HTML/CSS/JS，无框架依赖，复用现有 BKStorage/BKBookmark/pdf-state 数据层。

**Design Doc:** `docs/plans/2026-08-05-mark-panel-design.md`

---

## Task 1: 工具函数模块 mark-utils.js

**Files:**
- Create: `src/static/js/mark-panel/mark-utils.js`

**Step 1: Create mark-utils.js with all utility functions**

```javascript
/**
 * MarkPanel 工具函数
 * - 时间相对格式化
 * - 文本截断
 * - 颜色映射
 * - 防抖
 */
(function (win) {
    'use strict';
    win.BK = win.BK || {};
    win.BK.MarkUtils = {
        /**
         * 相对时间格式化
         * @param {number} timestamp - 毫秒时间戳
         * @returns {string} 如 "3分钟前"、"昨天"、"2天前"
         */
        relativeTime: function (timestamp) {
            var now = Date.now();
            var diff = now - timestamp;
            var seconds = Math.floor(diff / 1000);
            var minutes = Math.floor(seconds / 60);
            var hours = Math.floor(minutes / 60);
            var days = Math.floor(hours / 24);

            if (seconds < 60) return '刚刚';
            if (minutes < 60) return minutes + '分钟前';
            if (hours < 24) return hours + '小时前';
            if (days === 1) return '昨天';
            if (days < 30) return days + '天前';
            // 超过30天显示日期
            var d = new Date(timestamp);
            return (d.getMonth() + 1) + '/' + d.getDate();
        },

        /**
         * 文本截断
         * @param {string} text - 原文
         * @param {number} maxLen - 最大字符数
         * @returns {string}
         */
        truncate: function (text, maxLen) {
            if (!text) return '';
            maxLen = maxLen || 80;
            return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
        },

        /**
         * 高亮颜色映射 → CSS 变量值
         */
        COLOR_MAP: {
            yellow: '#F4E6C0',
            green:  '#D8EBDD',
            blue:   '#E3EFE8',
            pink:   '#F3DDD3',
            orange: '#F5D5B0',
            bookmark: '#E8943A'  // 书签专属橙色
        },

        /**
         * 标记类型显示名称
         */
        TYPE_LABELS: {
            highlight:      '高亮',
            underline:      '下划线',
            strikethrough:  '删除线',
            note:           '批注'
        },

        /**
         * 防抖
         */
        debounce: function (fn, ms) {
            var timer = null;
            return function () {
                var args = arguments;
                var ctx = this;
                if (timer) clearTimeout(timer);
                timer = setTimeout(function () { fn.apply(ctx, args); }, ms);
            };
        }
    };
})(window);
```

**Step 2: Verify** — Open in browser console, check `BK.MarkUtils.relativeTime(Date.now() - 60000)` returns `"1分钟前"`.

**Step 3: Commit**
```
git add src/static/js/mark-panel/mark-utils.js
git commit -m "feat: add MarkUtils utility module for MarkPanel"
```

---

## Task 2: EPUB 适配器 epub-adapter.js

**Files:**
- Create: `src/static/js/mark-panel/adapters/epub-adapter.js`

**Step 1: Create EPUB adapter implementing all three adapter interfaces**

```javascript
/**
 * EPUB 适配器 — 桥接 BKBookmark / BKStorage / renderer-toc-drawer 数据到 MarkPanel
 *
 * 依赖: BKBookmark, BKStorage, renderer-toc-drawer 的 _fillTocDrawer 数据逻辑
 */
(function (win) {
    'use strict';
    win.BK = win.BK || {};
    win.BK.MarkPanelAdapters = win.BK.MarkPanelAdapters || {};

    win.BK.MarkPanelAdapters.EpubAdapter = {
        // ─── 目录 ──────────────────────────────────────────────────────
        toc: {
            /**
             * 获取目录条目
             * @returns {Promise<Array<{id, title, depth, position, isActive}>>}
             */
            getItems: function () {
                // 从 renderer-toc-drawer 的现有 DOM 读取数据
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
                // 复用 renderer-toc-drawer 的跳转逻辑
                if (item && item.element) {
                    item.element.click();
                }
            },

            hasSearch: function () { return true; },

            search: function (keyword) {
                // 搜索由 renderer-toc-drawer 的 DOM 过滤实现，这里返回过滤后的列表
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
                            subtitle: bm.path || '',
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
                // 检查当前路径是否已有书签
                if (!win.BKBookmark || !win.BKBookmark.getAll) return Promise.resolve(false);
                return win.BKBookmark.getAll().then(function (bms) {
                    var current = win.BKRouter && win.BKRouter.currentPath ? win.BKRouter.currentPath() : '';
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
                                position: page.key || 0,  // key = /{bookId}/{chapter}
                                timestamp: hl.timestamp,
                                pageKey: page.key
                            });
                        });
                    });
                    // 按页码顺序排序
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
                // 需要遍历所有页找到该高亮并删除
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
                // 解析 pageKey: /{bookId}/{chapter} → 路由到该章节
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
```

**Step 2: Verify** — In browser on EPUB reading page, `BK.MarkPanelAdapters.EpubAdapter.bookmark.getItems()` returns bookmark array.

**Step 3: Commit**
```
git add src/static/js/mark-panel/adapters/epub-adapter.js
git commit -m "feat: add EPUB adapter for MarkPanel"
```

---

## Task 3: PDF 适配器 pdf-adapter.js

**Files:**
- Create: `src/static/js/mark-panel/adapters/pdf-adapter.js`

**Step 1: Create PDF adapter implementing all three adapter interfaces**

```javascript
/**
 * PDF 适配器 — 桥接 BKPdf._internal (outline/bookmark/highlight) 数据到 MarkPanel
 *
 * 依赖: BKPdf._internal.outline, BKPdf._internal.bookmark, BKPdf._internal.highlight
 *       以及 pdf-state.js 的 S.bookmarks / S.highlights / S.outline
 */
(function (win) {
    'use strict';
    win.BK = win.BK || {};
    win.BK.MarkPanelAdapters = win.BK.MarkPanelAdapters || {};

    function _getS() {
        // pdf-state.js 挂载在 BKPdf._state 或全局
        return (win.BKPdf && win.BKPdf._state) || win.BKPdfState;
    }

    function _getBookId() {
        var s = _getS();
        return s ? s.currentBookId() : null;
    }

    win.BK.MarkPanelAdapters.PdfAdapter = {
        // ─── 目录 ──────────────────────────────────────────────────────
        toc: {
            getItems: function () {
                var s = _getS();
                var bookId = _getBookId();
                if (!s || !bookId) return Promise.resolve([]);

                return s.ensureOutlineLoad(bookId).then(function () {
                    var outline = s.outline(bookId);
                    var items = [];
                    function flatten(nodes, depth) {
                        (nodes || []).forEach(function (node, idx) {
                            items.push({
                                id: 'pdf-toc-' + depth + '-' + idx,
                                title: node.title || '',
                                depth: depth,
                                position: node.pageNumber || 0,
                                isActive: false,
                                children: (node.children && node.children.length > 0) ? true : false,
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
                if (pageNum && _getS() && _getS().nav) {
                    _getS().nav.goToPage(pageNum);
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

                var bms = s.bookmarks(bookId) || [];
                var currentPage = s.currentPage ? s.currentPage() : 0;

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
                s.addBookmark(bookId, page, '第 ' + page + ' 页');
                return Promise.resolve();
            },

            remove: function (id) {
                // id 格式: "pdf-bm-{page}"
                var s = _getS();
                var bookId = _getBookId();
                if (!s || !bookId) return Promise.resolve();
                var page = parseInt(id.replace('pdf-bm-', ''), 10);
                if (page) s.removeBookmark(bookId, page);
                return Promise.resolve();
            },

            updateTitle: function (id, title) {
                var s = _getS();
                var bookId = _getBookId();
                if (!s || !bookId) return Promise.resolve();
                var page = parseInt(id.replace('pdf-bm-', ''), 10);
                if (page) s.setBookmarkTitle(bookId, page, title);
                return Promise.resolve();
            },

            updateNote: function () {
                // PDF 书签暂不支持笔记
                return Promise.resolve();
            },

            navigate: function (item) {
                if (!item || !item.page) return;
                var s = _getS();
                if (s && s.nav) s.nav.goToPage(item.page);
            },

            hasCurrentPage: function () {
                var s = _getS();
                var bookId = _getBookId();
                if (!s || !bookId) return Promise.resolve(false);
                var page = s.currentPage ? s.currentPage() : 0;
                return Promise.resolve(s.isBookmarked(bookId, page));
            },

            toggleCurrentPage: function () {
                var s = _getS();
                var bookId = _getBookId();
                if (!s || !bookId) return Promise.resolve();
                var bm = win.BKPdf._internal.bookmark;
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

                var hls = s.highlights(bookId) || [];
                return Promise.resolve(hls.map(function (hl) {
                    var type = hl.type || 'highlight';
                    return {
                        id: hl.id,
                        text: hl.text || '',
                        color: hl.color || null,
                        type: type,
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
                s.removeHighlight(bookId, id);
                return Promise.resolve();
            },

            navigate: function (item) {
                if (!item || !item.page) return;
                var s = _getS();
                if (s && s.nav) s.nav.goToPage(item.page);
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
```

**Step 2: Verify** — In browser on PDF reading page, `BK.MarkPanelAdapters.PdfAdapter.bookmark.getItems()` returns bookmarks.

**Step 3: Commit**
```
git add src/static/js/mark-panel/adapters/pdf-adapter.js
git commit -m "feat: add PDF adapter for MarkPanel"
```

---

## Task 4: 通用列表渲染组件 mark-list.js

**Files:**
- Create: `src/static/js/mark-panel/mark-list.js`

**Step 1: Create unified list renderer with left color bar + swipe-to-delete**

```javascript
/**
 * MarkPanel 通用列表渲染组件
 * - 紧凑列表 + 左侧颜色条
 * - 左滑删除手势
 * - 点击跳转 / 长按编辑
 * - 笔记折叠预览
 */
(function (win) {
    'use strict';
    win.BK = win.BK || {};

    var MarkList = {
        /**
         * 渲染书签/标记列表
         * @param {HTMLElement} container - 列表容器
         * @param {Array} items - 条目数组
         * @param {Object} opts - 选项
         *   opts.colorBar: Boolean - 是否显示颜色条 (default true)
         *   opts.defaultColor: String - 默认颜色条颜色
         *   opts.onNavigate: Function(item) - 点击跳转回调
         *   opts.onDelete: Function(item) - 删除回调
         *   opts.onEdit: Function(item) - 长按编辑回调
         *   opts.emptyText: String - 空状态文案
         */
        render: function (container, items, opts) {
            opts = opts || {};
            container.innerHTML = '';

            if (!items || items.length === 0) {
                container.innerHTML = '<div class="bk-mp-empty">' +
                    (opts.emptyText || '暂无内容') + '</div>';
                return;
            }

            var ul = document.createElement('ul');
            ul.className = 'bk-mp-list';

            items.forEach(function (item) {
                var li = document.createElement('li');
                li.className = 'bk-mp-item';
                li.setAttribute('data-id', item.id);

                // 颜色条
                var barColor = item.color ? (win.BK.MarkUtils.COLOR_MAP[item.color] || item.color) : (opts.defaultColor || win.BK.MarkUtils.COLOR_MAP.bookmark);

                var bar = document.createElement('div');
                bar.className = 'bk-mp-color-bar';
                bar.style.background = barColor;

                // 内容区
                var content = document.createElement('div');
                content.className = 'bk-mp-item-content';

                // 标题行
                var title = document.createElement('div');
                title.className = 'bk-mp-item-title';
                title.textContent = item.title || item.text || '未命名';

                content.appendChild(title);

                // 元信息行
                var meta = document.createElement('div');
                meta.className = 'bk-mp-item-meta';
                var metaParts = [];
                if (item.subtitle) metaParts.push(item.subtitle);
                if (opts.typeLabel) metaParts.push(opts.typeLabel);
                else if (item.type && win.BK.MarkUtils.TYPE_LABELS[item.type]) {
                    metaParts.push(win.BK.MarkUtils.TYPE_LABELS[item.type]);
                }
                if (item.timestamp) metaParts.push(win.BK.MarkUtils.relativeTime(item.timestamp));
                meta.textContent = metaParts.join(' · ');
                content.appendChild(meta);

                // 笔记预览行
                if (item.note) {
                    var noteEl = document.createElement('div');
                    noteEl.className = 'bk-mp-item-note';
                    noteEl.textContent = item.note;
                    content.appendChild(noteEl);
                }

                li.appendChild(bar);
                li.appendChild(content);

                // 事件：点击跳转
                li.addEventListener('click', function (e) {
                    if (li._swiped) { li._swiped = false; return; }
                    if (opts.onNavigate) opts.onNavigate(item);
                });

                // 事件：长按编辑
                var longPressTimer = null;
                var moved = false;
                li.addEventListener('touchstart', function (e) {
                    moved = false;
                    longPressTimer = setTimeout(function () {
                        if (!moved && opts.onEdit) opts.onEdit(item);
                    }, 500);
                }, { passive: true });
                li.addEventListener('touchmove', function () {
                    moved = true;
                    clearTimeout(longPressTimer);
                }, { passive: true });
                li.addEventListener('touchend', function () {
                    clearTimeout(longPressTimer);
                });

                // 左滑删除手势
                var startX = 0, currentX = 0, swiping = false;
                li.addEventListener('touchstart', function (e) {
                    startX = e.touches[0].clientX;
                    currentX = 0;
                }, { passive: true });
                li.addEventListener('touchmove', function (e) {
                    var dx = e.touches[0].clientX - startX;
                    if (dx < -20 && !swiping) swiping = true;
                    if (swiping) {
                        currentX = Math.max(dx, -80);
                        li.style.transform = 'translateX(' + currentX + 'px)';
                        li.style.transition = 'none';
                    }
                }, { passive: true });
                li.addEventListener('touchend', function () {
                    li.style.transition = 'transform 0.2s ease';
                    if (currentX < -40) {
                        li.style.transform = 'translateX(-80px)';
                        li._swiped = true;
                        // 显示删除提示
                        if (!li.querySelector('.bk-mp-item-delete')) {
                            var del = document.createElement('button');
                            del.className = 'bk-mp-item-delete';
                            del.textContent = '删除';
                            del.addEventListener('click', function (e) {
                                e.stopPropagation();
                                if (opts.onDelete) opts.onDelete(item, li);
                            });
                            li.appendChild(del);
                        }
                    } else {
                        li.style.transform = 'translateX(0)';
                        li._swiped = false;
                    }
                    swiping = false;
                });

                ul.appendChild(li);
            });

            container.appendChild(ul);
        }
    };

    win.BK.MarkList = MarkList;
})(window);
```

**Step 2: Verify** — Call `BK.MarkList.render(container, mockItems, opts)` and verify DOM structure.

**Step 3: Commit**
```
git add src/static/js/mark-panel/mark-list.js
git commit -m "feat: add MarkList unified list renderer with swipe-to-delete"
```

---

## Task 5: MarkPanel 主控 mark-panel.js

**Files:**
- Create: `src/static/js/mark-panel/mark-panel.js`

**Step 1: Create main MarkPanel controller — drawer creation, Tab switching, event dispatch**

This is the core component. It creates the left-side drawer, manages 3 tabs, delegates to adapters, and handles open/close/toggle.

Key structure:
- Drawer DOM: fixed left, width 320px max 85vw, z-index 1000
- Overlay: fixed inset, z-index 999
- Header: book title + close button
- Tab bar: 3 tabs (目录/书签/标记), pill style
- Content area: switched by active tab
- Footer: add bookmark button (only in bookmark tab) + stats

Key methods:
- `open(tab)` — open drawer, switch to specified tab, load data
- `close()` — close drawer, push back stack
- `toggle(tab)` — toggle open/close
- `_switchTab(tabId)` — switch tab content
- `_loadTabData(tabId)` — call adapter, render list
- `_detectReaderType()` — returns 'epub' or 'pdf'
- `_getAdapter()` — returns EpubAdapter or PdfAdapter based on reader type
- `_onMarksChanged()` — listener for external mark changes

**Step 2: Verify** — Open in browser, call `BK.MarkPanel.open('toc')` and verify drawer appears with 3 tabs.

**Step 3: Commit**
```
git add src/static/js/mark-panel/mark-panel.js
git commit -m "feat: add MarkPanel main controller with drawer and tab switching"
```

---

## Task 6: CSS 样式 css-mark-panel.css

**Files:**
- Create: `src/static/css/style/css-mark-panel.css`

**Step 1: Create complete stylesheet for MarkPanel**

Key styles to include:
- `.bk-mp-drawer` — fixed left drawer, translateX animation (same as bk-toc-drawer)
- `.bk-mp-overlay` — semi-transparent overlay
- `.bk-mp-header` — book title + close button
- `.bk-mp-tabs` — tab bar with pill-style active indicator
- `.bk-mp-tab-btn` / `.bk-mp-tab-btn.active` — tab buttons
- `.bk-mp-content` — scrollable content area
- `.bk-mp-list` / `.bk-mp-item` — list items with left color bar
- `.bk-mp-color-bar` — 4px rounded color bar
- `.bk-mp-item-title` / `.bk-mp-item-meta` / `.bk-mp-item-note` — text styles
- `.bk-mp-item-delete` — red delete button (left swipe)
- `.bk-mp-empty` — empty state
- `.bk-mp-footer` — footer with add bookmark button
- `.bk-mp-filter` — filter bar for marks tab (pill tags)
- Responsive: handle small screens, landscape
- CSS variables: reuse `--brand`, `--text`, `--border`, etc.

**Step 2: Verify** — Visual check in browser.

**Step 3: Commit**
```
git add src/static/css/style/css-mark-panel.css
git commit -m "feat: add MarkPanel CSS stylesheet"
```

---

## Task 7: 入口桥接 — 迁移底栏和旧接口到 MarkPanel

**Files:**
- Modify: `src/static/js/nav-stack/nav-float-bar.js` — EPUB 底栏书签按钮 → `BK.MarkPanel.open('bookmark')`
- Modify: `src/static/js/renderer/pdf/pdf-ui.js` — PDF 底栏书签长按 → `BK.MarkPanel.open('bookmark')`; 高亮按钮 → `BK.MarkPanel.open('mark')`
- Modify: `src/static/js/bookmark.js` — `showList()` → 调用 `BK.MarkPanel.open('bookmark')`
- Modify: `src/static/js/note-summary.js` — `show()` → 调用 `BK.MarkPanel.open(tab)`

**Key changes:**

1. **nav-float-bar.js** — Replace `BKNoteSummary.show()` / `BKBookmark.showList()` calls with `BK.MarkPanel.open('bookmark')`
2. **pdf-ui.js** — Long press on bookmark button calls `BK.MarkPanel.open('bookmark')`; highlight button calls `BK.MarkPanel.open('mark')`
3. **bookmark.js** — `showList()` becomes a wrapper: `if (BK.MarkPanel) BK.MarkPanel.open('bookmark'); else /* original code */`
4. **note-summary.js** — `show(opts)` becomes a wrapper: maps `opts.tab` to MarkPanel tab

**Step 2: Verify** — Click bookmark button on both EPUB and PDF pages, verify MarkPanel opens.

**Step 3: Commit**
```
git add src/static/js/nav-stack/nav-float-bar.js src/static/js/renderer/pdf/pdf-ui.js src/static/js/bookmark.js src/static/js/note-summary.js
git commit -m "feat: bridge legacy entry points to MarkPanel"
```

---

## Task 8: TOC Tab 渲染整合 — 目录 Tab 在 MarkPanel 内正确渲染

**Files:**
- Modify: `src/static/js/mark-panel/mark-panel.js` — 添加目录 Tab 的渲染逻辑
- Modify: `src/static/js/renderer/renderer-toc-drawer.js` — 将 TOC 数据填充逻辑迁移到适配器调用

**Key changes:**

1. EPUB TOC Tab: 调用 `EpubAdapter.toc.getItems()` 获取章节列表，在 MarkPanel content area 渲染平铺列表（复用 bk-toc-chapter-item 样式），支持搜索
2. PDF TOC Tab: 调用 `PdfAdapter.toc.getItems()` 获取树形数据，在 MarkPanel content area 渲染树形列表（复用 bk-pdf-outline 样式），支持展开/折叠
3. 渲染复用现有 TOC 数据获取逻辑，但不再由独立的 renderer-toc-drawer.js 控制 DOM，改为 MarkPanel 统一管理

**Step 2: Verify** — Open MarkPanel on both EPUB and PDF pages, switch to TOC tab, verify chapters render correctly and click-to-navigate works.

**Step 3: Commit**
```
git add src/static/js/mark-panel/mark-panel.js
git commit -m "feat: integrate TOC tab rendering into MarkPanel"
```

---

## Task 9: 书签 Tab 完整功能 — 列表渲染 + 添加/删除/编辑/跳转

**Files:**
- Modify: `src/static/js/mark-panel/mark-panel.js` — 书签 Tab 完整交互

**Key features:**

1. 列表渲染：左侧橙色条 + 标题 + 元信息（章节/页码/时间）+ 笔记折叠预览
2. Footer 按钮：「添加当前页书签」/ 「移除当前页书签」（根据当前页状态切换）
3. 点击跳转：调用 `adapter.bookmark.navigate(item)`
4. 左滑删除：调用 `adapter.bookmark.remove(id)`，局部移除 DOM
5. 长按编辑：弹出编辑菜单（编辑标题 / 编辑笔记 / 删除）
6. 编辑标题：弹窗输入框，调用 `adapter.bookmark.updateTitle(id, title)`
7. 编辑笔记：弹窗 textarea，调用 `adapter.bookmark.updateNote(id, note)`

**Step 2: Verify** — Add/remove/edit bookmarks on both EPUB and PDF pages.

**Step 3: Commit**
```
git add src/static/js/mark-panel/mark-panel.js
git commit -m "feat: implement bookmark tab with full CRUD and navigation"
```

---

## Task 10: 标记 Tab 完整功能 — 列表渲染 + 筛选 + 删除/跳转

**Files:**
- Modify: `src/static/js/mark-panel/mark-panel.js` — 标记 Tab 完整交互

**Key features:**

1. 筛选栏：pill 样式标签（全部 | 高亮 | 下划线 | 删除线 | 批注），点击筛选
2. 列表渲染：左侧颜色条（与高亮颜色一致）+ 原文摘要 + 元信息 + 笔记预览
3. 点击跳转：调用 `adapter.mark.navigate(item)`
4. 左滑删除：调用 `adapter.mark.remove(id)`
5. 长按编辑：弹出编辑菜单（编辑笔记 / 删除）
6. 外部同步：监听 `marks-changed` 自定义事件，刷新列表

**Step 2: Verify** — Add highlights on EPUB/PDF page, open MarkPanel marks tab, verify listing and filtering.

**Step 3: Commit**
```
git add src/static/js/mark-panel/mark-panel.js
git commit -m "feat: implement marks tab with filtering, swipe-delete and navigation"
```

---

## Task 11: 构建脚本集成 — 将新文件加入构建流程

**Files:**
- Modify: 构建脚本（Python/JS），将 `mark-panel/` 目录下的 JS 文件和 CSS 文件加入打包

**Key changes:**

1. 在构建脚本中添加 `mark-panel/mark-utils.js`, `mark-panel/adapters/epub-adapter.js`, `mark-panel/adapters/pdf-adapter.js`, `mark-panel/mark-list.js`, `mark-panel/mark-panel.js` 到 JS 合并列表
2. 添加 `css-mark-panel.css` 到 CSS 合并列表
3. 确保加载顺序：mark-utils → adapters → mark-list → mark-panel

**Step 2: Verify** — Run build, verify output contains new code, test in browser.

**Step 3: Commit**
```
git add <build-script>
git commit -m "build: integrate MarkPanel files into build pipeline"
```

---

## Task 12: 旧抽屉/弹框兼容处理 — 确保 PDF 旧抽屉不冲突

**Files:**
- Modify: `src/static/js/renderer/pdf/pdf-state.js` — `closeAllDrawersExcept` 增加 'markPanel' 项
- Modify: `src/static/js/renderer/renderer-toc-drawer.js` — 打开 MarkPanel 时关闭旧 TOC 抽屉

**Key changes:**

1. PDF 端：MarkPanel 打开时，关闭所有旧 PDF 抽屉（outline/bookmark/highlight）
2. PDF 端：旧抽屉打开时，关闭 MarkPanel
3. EPUB 端：MarkPanel 打开时，关闭旧 TOC 抽屉；旧 TOC 打开时，关闭 MarkPanel
4. 返回键（backStack）：MarkPanel 加入 backStack 管理

**Step 2: Verify** — Toggle between old drawers and MarkPanel, verify no conflicts.

**Step 3: Commit**
```
git add src/static/js/renderer/pdf/pdf-state.js src/static/js/renderer/renderer-toc-drawer.js
git commit -m "feat: ensure MarkPanel and legacy drawers coexist without conflicts"
```

---

## Task 13: 最终集成测试 — 端到端验证

**Files:**
- No new files — manual + browser testing

**Test scenarios:**

1. **EPUB 页面**:
   - 底栏目录按钮 → MarkPanel 打开，Tab=目录，章节列表正确渲染
   - 切换到书签 Tab → 显示书签列表，添加/删除/编辑/跳转正常
   - 切换到标记 Tab → 显示高亮列表，筛选/删除/跳转正常
   - 搜索功能（目录 Tab）正常
   - 返回键关闭 MarkPanel

2. **PDF 页面**:
   - 目录 Tab → 树形列表，展开/折叠/跳转正常
   - 书签 Tab → 添加/删除/编辑/跳转正常，短按底栏仍 toggle 书签
   - 标记 Tab → 高亮列表，类型筛选正常

3. **互斥测试**:
   - MarkPanel 打开时旧抽屉不显示
   - 旧抽屉打开时 MarkPanel 不显示
   - Tab 记忆：关闭再打开恢复上次 Tab

4. **外部同步**:
   - MarkPanel 打开状态下，在阅读页添加高亮 → 标记 Tab 自动刷新

**Commit:**
```
git commit --allow-empty -m "test: MarkPanel end-to-end integration verified"
```