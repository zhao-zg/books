/**
 * MarkPanel 统一标记面板 — 主控
 * 左侧抽屉 + 3 Tab（目录|书签|标记）+ 适配器桥接
 *
 * 依赖: BK.MarkUtils, BK.MarkList, BK.MarkPanelAdapters.EpubAdapter, BK.MarkPanelAdapters.PdfAdapter
 */
(function (win) {
    'use strict';
    win.BK = win.BK || {};

    var TABS = ['toc', 'bookmark', 'mark'];
    var TAB_LABELS = { toc: '目录', bookmark: '书签', mark: '标记' };
    var LAST_TAB_KEY = 'bk_mp_last_tab';

    var MarkPanel = {
        _drawer: null,
        _overlay: null,
        _isOpen: false,
        _activeTab: 'toc',
        _adapter: null,
        _readerType: null,  // 'epub' | 'pdf'
        _autoCloseTimer: null,
        _bookTitle: '',
        _dirtyTabs: { toc: true, bookmark: true, mark: true },
        _scrollCleanup: null,  // lockOverlayScroll 的 cleanup 函数
        _lastBookId: '',  // 记录最近一次面板感知的书籍 ID，用于切换书籍时重置目录/标记缓存
        _lastChapterNum: 0,  // 记录最近一次感知的章节号，用于切章后刷新目录高亮

        // ─── 公开 API ──────────────────────────────────────────────────

        /**
         * 打开面板
         * @param {string} [tab] - 指定打开的 tab: 'toc'|'bookmark'|'mark'
         */
        open: function (tab) {
            if (MarkPanel._isOpen && MarkPanel._activeTab === (tab || 'toc')) return;

            MarkPanel._detectReaderType();
            MarkPanel._getAdapter();
            // 切换书籍时重置目录/标记脏标记（避免显示上一本书的残留数据）
            MarkPanel._syncBookContext();
            MarkPanel._ensureDOM();

            // 书名：通过适配器获取（适配器内部区分 EPUB/PDF 数据源）
            MarkPanel._bookTitle = (MarkPanel._adapter && MarkPanel._adapter.getBookTitle) ? MarkPanel._adapter.getBookTitle() : '';
            MarkPanel._titleEl.textContent = MarkPanel._bookTitle || document.title || '';

            // 确定打开的 Tab
            var targetTab = tab || localStorage.getItem(LAST_TAB_KEY) || 'toc';
            if (TABS.indexOf(targetTab) < 0) targetTab = 'toc';

            MarkPanel._activeTab = targetTab;
            MarkPanel._isOpen = true;

            // 显示
            MarkPanel._drawer.classList.add('bk-mp-visible');
            MarkPanel._overlay.classList.add('bk-mp-visible');

            // 触摸穿透防护 + 点空白关闭（使用通用 lockOverlayScroll）
            if (MarkPanel._scrollCleanup) { MarkPanel._scrollCleanup(); MarkPanel._scrollCleanup = null; }
            if (win.BK && win.BK.lockOverlayScroll) {
                MarkPanel._scrollCleanup = win.BK.lockOverlayScroll(MarkPanel._overlay, function () { MarkPanel.close(); });
            }

            // 关闭旧 TOC 抽屉（EPUB 端）
            var tocDrawer = document.getElementById('bkTocDrawer');
            if (tocDrawer) tocDrawer.classList.remove('open');
            var tocOverlay = document.getElementById('bkTocOverlay');
            if (tocOverlay) tocOverlay.classList.remove('open');

            // 关闭 PDF 旧抽屉
            MarkPanel._closePdfDrawers();

            // 推入 backStack（系统返回键关闭面板）
            if (win.BKBackStack && win.BKBackStack.push) {
                win.BKBackStack.push(function () { MarkPanel.close(); });
            }

            // ESC 键关闭
            document.addEventListener('keydown', MarkPanel._onEsc);

            // 切换 Tab 并加载数据
            MarkPanel._switchTab(targetTab);
        },

        /**
         * 关闭面板
         */
        close: function () {
            if (!MarkPanel._isOpen) return;
            MarkPanel._isOpen = false;

            if (MarkPanel._drawer) MarkPanel._drawer.classList.remove('bk-mp-visible');
            if (MarkPanel._overlay) MarkPanel._overlay.classList.remove('bk-mp-visible');

            // 释放滚动锁定
            if (MarkPanel._scrollCleanup) { MarkPanel._scrollCleanup(); MarkPanel._scrollCleanup = null; }

            document.removeEventListener('keydown', MarkPanel._onEsc);

            if (MarkPanel._autoCloseTimer) {
                clearTimeout(MarkPanel._autoCloseTimer);
                MarkPanel._autoCloseTimer = null;
            }

            // 退出 backStack（仅弹出回调，不触发 history.back）
            if (win.BKBackStack && win.BKBackStack.silentPop) {
                win.BKBackStack.silentPop();
            }
        },

        /**
         * 切换打开/关闭
         */
        toggle: function (tab) {
            if (MarkPanel._isOpen) {
                MarkPanel.close();
            } else {
                MarkPanel.open(tab);
            }
        },

        /**
         * 监听外部标记变更
         */
        refresh: function () {
            // 无论面板是否打开，都标记所有相关 Tab 为脏
            // 这样下次打开面板或切换 Tab 时会重新加载数据
            MarkPanel._dirtyTabs.bookmark = true;
            MarkPanel._dirtyTabs.mark = true;
            if (!MarkPanel._isOpen) return;
            MarkPanel._loadTabData(MarkPanel._activeTab);
        },

        // ─── 内部方法 ──────────────────────────────────────────────────

        _detectReaderType: function () {
            // 判断当前是否在 PDF 阅读模式
            // BKPdf._internal 在 EPUB 页也存在（JS 文件都加载了），但不能仅凭其存在判断
            // 可靠方式：state.currentBookId() 返回非空值 → 正在阅读 PDF
            var internal = win.BKPdf && win.BKPdf._internal;
            var state = internal && internal.state;
            var isPdf = state && typeof state.currentBookId === 'function' && state.currentBookId();
            MarkPanel._readerType = isPdf ? 'pdf' : 'epub';
        },

        _getAdapter: function () {
            var adapters = win.BK.MarkPanelAdapters || {};
            MarkPanel._adapter = (MarkPanel._readerType === 'pdf')
                ? adapters.PdfAdapter
                : adapters.EpubAdapter;
        },

        /**
         * 获取当前阅读的书籍 ID（EPUB：__bkCurrentPath 首段；PDF：由适配器状态决定）。
         * 若无法确定返回空串。
         */
        _getCurrentBookId: function () {
            var path = win.__bkCurrentPath || '';
            var parts = path.split('/').filter(Boolean);
            return parts[0] || '';
        },

        /**
         * 检测书籍是否已切换（相对上一次面板感知的书籍）。
         * 切换时重置目录(toc)与标记(mark)脏标记，确保下次加载的是新书数据，
         * 避免连续切换书籍查看目录时显示上一本书的残留内容。
         * 返回 true 表示书籍发生变化并已重置；false 表示无变化或无法判断。
         */
        _syncBookContext: function () {
            var bookId = MarkPanel._getCurrentBookId();
            if (!bookId) return false;
            if (bookId === MarkPanel._lastBookId) return false;
            MarkPanel._lastBookId = bookId;
            MarkPanel._lastChapterNum = 0;  // 切书后章节感知重置
            // 书籍切换：目录与标记均为新书数据，强制重新加载
            MarkPanel._dirtyTabs.toc = true;
            MarkPanel._dirtyTabs.mark = true;
            // 清空纲目缓存（适配器内部）
            if (MarkPanel._adapter && MarkPanel._adapter.clearOutlineCache) {
                MarkPanel._adapter.clearOutlineCache();
            }
            return true;
        },

        _ensureDOM: function () {
            if (MarkPanel._drawer) return;

            // Overlay（触摸穿透防护 + 点空白关闭统一由 lockOverlayScroll 处理）
            MarkPanel._overlay = document.createElement('div');
            MarkPanel._overlay.className = 'bk-mp-overlay';
            // 桌面端：点击遮罩区域关闭
            MarkPanel._overlay.addEventListener('click', function (e) {
                if (e.target === MarkPanel._overlay) MarkPanel.close();
            });
            document.body.appendChild(MarkPanel._overlay);

            // Drawer
            MarkPanel._drawer = document.createElement('div');
            MarkPanel._drawer.className = 'bk-mp-drawer';

            // Header
            var header = document.createElement('div');
            header.className = 'bk-mp-header';

            var titleEl = document.createElement('div');
            titleEl.className = 'bk-mp-header-title';
            titleEl.id = 'bk-mp-title';
            MarkPanel._titleEl = titleEl;

            header.appendChild(titleEl);
            // 不添加关闭按钮，用户可通过点击遮罩层或滑动关闭
            MarkPanel._drawer.appendChild(header);

            // Tab 栏
            var tabs = document.createElement('div');
            tabs.className = 'bk-mp-tabs';
            TABS.forEach(function (tabId) {
                var btn = document.createElement('button');
                btn.className = 'bk-mp-tab-btn';
                btn.setAttribute('data-tab', tabId);
                btn.textContent = TAB_LABELS[tabId];
                btn.addEventListener('click', function () { MarkPanel._switchTab(tabId); });
                tabs.appendChild(btn);
            });
            MarkPanel._drawer.appendChild(tabs);

            // 搜索框（目录 Tab）
            var search = document.createElement('div');
            search.className = 'bk-mp-search';
            search.id = 'bk-mp-search';
            var searchInput = document.createElement('input');
            searchInput.className = 'bk-mp-search-input';
            searchInput.placeholder = '搜索章节或正文…';
            searchInput.addEventListener('input', win.BK.MarkUtils.debounce(function () {
                MarkPanel._onTocSearch(searchInput.value);
            }, 200));
            search.appendChild(searchInput);
            MarkPanel._searchEl = search;
            MarkPanel._searchInput = searchInput;
            MarkPanel._drawer.appendChild(search);

            // 筛选栏（标记 Tab）— 容器，内容由 _renderFilterBar 动态填充
            var filter = document.createElement('div');
            filter.className = 'bk-mp-filter';
            filter.id = 'bk-mp-filter';
            MarkPanel._filterEl = filter;
            MarkPanel._activeFilter = 'all';
            MarkPanel._drawer.appendChild(filter);

            // Content Area
            var content = document.createElement('div');
            content.className = 'bk-mp-content';

            // 三个 Tab Pane
            TABS.forEach(function (tabId) {
                var pane = document.createElement('div');
                pane.className = 'bk-mp-tab-pane';
                pane.id = 'bk-mp-pane-' + tabId;
                content.appendChild(pane);
            });

            MarkPanel._drawer.appendChild(content);
            MarkPanel._contentEl = content;

            // Footer
            var footer = document.createElement('div');
            footer.className = 'bk-mp-footer';
            footer.id = 'bk-mp-footer';
            MarkPanel._footerEl = footer;
            MarkPanel._drawer.appendChild(footer);

            document.body.appendChild(MarkPanel._drawer);
        },

        _switchTab: function (tabId) {
            MarkPanel._activeTab = tabId;
            localStorage.setItem(LAST_TAB_KEY, tabId);

            // 更新 Tab 按钮样式
            var tabBtns = MarkPanel._drawer.querySelectorAll('.bk-mp-tab-btn');
            tabBtns.forEach(function (btn) {
                btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
            });

            // 切换 Pane 显示
            TABS.forEach(function (t) {
                var pane = document.getElementById('bk-mp-pane-' + t);
                if (pane) pane.classList.toggle('active', t === tabId);
            });

            // 搜索框只在目录 Tab 显示
            MarkPanel._searchEl.style.display = (tabId === 'toc') ? 'block' : 'none';

            // 筛选栏只在标记 Tab 显示
            MarkPanel._filterEl.style.display = (tabId === 'mark') ? 'flex' : 'none';

            // Footer 只在书签/标记 Tab 显示
            MarkPanel._footerEl.style.display = (tabId === 'toc') ? 'none' : 'flex';

            // 加载数据（仅在脏标记为 true 时加载）
            MarkPanel._loadTabData(tabId);
        },

        _loadTabData: function (tabId) {
            if (!MarkPanel._adapter) return;
            // 跳过已加载且未脏的 Tab
            if (!MarkPanel._dirtyTabs[tabId]) return;
            MarkPanel._dirtyTabs[tabId] = false;

            if (tabId === 'toc') {
                MarkPanel._loadToc();
            } else if (tabId === 'bookmark') {
                MarkPanel._loadBookmarks();
            } else if (tabId === 'mark') {
                MarkPanel._loadMarks();
            }
        },

        /**
         * 标记某个 Tab 数据已过期，下次切换时重新加载
         */
        markDirty: function (tabId) {
            if (tabId) {
                MarkPanel._dirtyTabs[tabId] = true;
            } else {
                // 无参数时全部标记脏
                MarkPanel._dirtyTabs = { toc: true, bookmark: true, mark: true };
            }
        },

        // ─── 目录 Tab ──────────────────────────────────────────────────

        _loadToc: function () {
            var adapter = MarkPanel._adapter.toc;
            var pane = document.getElementById('bk-mp-pane-toc');
            if (!pane || !adapter) return;

            // 搜索框有值时恢复搜索结果（面板关闭再打开场景）
            if (MarkPanel._searchInput && MarkPanel._searchInput.value.trim()) {
                MarkPanel._onTocSearch(MarkPanel._searchInput.value);
                return;
            }

            adapter.getItems().then(function (items) {
                pane.innerHTML = '';

                if (!items || items.length === 0) {
                    pane.innerHTML = '<div class="bk-mp-empty">暂无目录</div>';
                    return;
                }

                if (MarkPanel._readerType === 'pdf') {
                    MarkPanel._renderPdfToc(pane, items);
                } else {
                    MarkPanel._renderEpubToc(pane, items);
                }

                // ★ 自动展开当前章节的纲目并定位，便于看到当前读到的具体纲目。
                //   仅在目录初次加载/切章刷新时触发，用户手动展开的其他章节不受影响。
                MarkPanel._autoExpandCurrentChapter(pane);
            });
        },

        /**
         * 目录渲染后，自动展开当前章节的纲目子列表，并滚动到可见。
         * 定位当前读到的章节内具体位置。
         * @param {HTMLElement} pane 目录 pane
         */
        _autoExpandCurrentChapter: function (pane) {
            if (!pane || MarkPanel._readerType !== 'epub') return;
            var currentLi = pane.querySelector('.bk-mp-toc-current');
            if (!currentLi) return;
            var li = currentLi.closest ? currentLi.closest('.bk-mp-toc-item-wrapper') : null;
            if (!li) return;
            // 仅当尚未加载纲目时才自动展开；已展开则直接滚动定位
            var existing = li.querySelector('.bk-mp-toc-outline');
            if (!existing) {
                var toggle = li.querySelector('.bk-mp-toc-toggle');
                if (toggle) {
                    var _item = null;
                    // 从已渲染数据反查当前章节 item（toggle 上暂未存引用，直接构造）
                    // 复用以渲染的 DOM 数据构造最小 item
                    var numEl = li.querySelector('.bk-mp-toc-num');
                    var titleEl = li.querySelector('.bk-mp-toc-title');
                    var bookId = MarkPanel._getCurrentBookId();
                    var num = numEl ? parseInt(numEl.textContent.trim(), 10) : 0;
                    _item = { bookId: bookId, chapterNum: num, num: num, title: titleEl ? titleEl.textContent.trim() : '' };
                    MarkPanel._toggleOutline(li, _item);
                }
            } else {
                li.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        },

        _renderEpubToc: function (pane, items) {
            var ul = document.createElement('ul');
            ul.className = 'bk-mp-toc-list';

            items.forEach(function (item, idx) {
                var li = document.createElement('li');
                li.className = 'bk-mp-toc-item-wrapper';

                // 章节行（含展开箭头）
                var row = document.createElement('div');
                row.className = 'bk-mp-toc-item';
                if (item.isActive) row.classList.add('bk-mp-toc-current');

                var toggle = document.createElement('button');
                toggle.className = 'bk-mp-toc-toggle';
                toggle.textContent = '\u25b8';

                var num = document.createElement('span');
                num.className = 'bk-mp-toc-num';
                num.textContent = item.num || (idx + 1);

                var title = document.createElement('span');
                title.className = 'bk-mp-toc-title';
                title.textContent = item.title;

                row.appendChild(toggle);
                row.appendChild(num);
                row.appendChild(title);
                li.appendChild(row);

                // 搜索上下文片段（全文搜索结果才有）
                if (item.context) {
                    var ctx = document.createElement('div');
                    ctx.className = 'bk-mp-toc-context';
                    ctx.innerHTML = MarkPanel._highlightContext(item.context, MarkPanel._searchQuery);
                    li.appendChild(ctx);
                }

                // 点击章节标题区域 → 跳转
                row.addEventListener('click', function (e) {
                    if (e.target === toggle || (e.target.closest && e.target.closest('.bk-mp-toc-toggle'))) return;
                    MarkPanel._adapter.toc.navigate(item);
                    MarkPanel.close();
                });

                // 点击展开箭头 → 加载/切换纲目子列表
                toggle.addEventListener('click', function (e) {
                    e.stopPropagation();
                    MarkPanel._toggleOutline(li, item);
                });

                ul.appendChild(li);
            });

            pane.appendChild(ul);
        },

        _renderPdfToc: function (pane, items) {
            var ul = document.createElement('ul');
            ul.className = 'bk-mp-toc-tree';

            // 简单平铺（flat items），通过 depth 缩进
            items.forEach(function (item) {
                var li = document.createElement('li');
                li.className = 'bk-mp-toc-tree-item';

                var row = document.createElement('div');
                row.className = 'bk-mp-toc-tree-row';
                row.style.paddingLeft = (16 + item.depth * 16) + 'px';

                var toggle = document.createElement('button');
                toggle.className = 'bk-mp-toc-tree-toggle';
                toggle.textContent = item.hasChildren ? '▾' : '';

                var title = document.createElement('span');
                title.className = 'bk-mp-toc-tree-title';
                title.textContent = item.title;

                var page = document.createElement('span');
                page.className = 'bk-mp-toc-tree-page';
                if (item.position) page.textContent = item.position;

                row.appendChild(toggle);
                row.appendChild(title);
                row.appendChild(page);
                li.appendChild(row);

                row.addEventListener('click', function () {
                    MarkPanel._adapter.toc.navigate(item);
                    MarkPanel.close();
                    // 跳转后延迟刷新目录高亮
                    setTimeout(function () { MarkPanel.markDirty('toc'); MarkPanel._loadTabData('toc'); }, 300);
                });

                ul.appendChild(li);
            });

            pane.appendChild(ul);
        },

        _onTocSearch: function (keyword) {
            if (MarkPanel._readerType !== 'epub') return;
            var pane = document.getElementById('bk-mp-pane-toc');
            if (!pane) return;

            MarkPanel._searchQuery = keyword || '';

            // 空关键词：恢复完整目录
            if (!keyword || !keyword.trim()) {
                MarkPanel._loadToc();
                return;
            }

            // 搜索可能触发内容索引异步加载（首次搜索），search() 返回 Promise
            var result = MarkPanel._adapter.toc.search(keyword);
            if (result && typeof result.then === 'function') {
                // 加载中提示
                pane.innerHTML = '<div class="bk-mp-empty">\u641c\u7d22\u4e2d\u2026</div>';
                result.then(function (items) {
                    // 关键词可能已变化，仅处理仍匹配的搜索结果
                    if (MarkPanel._searchQuery !== keyword) return;
                    MarkPanel._renderTocSearchResult(pane, items);
                });
                return;
            }
            MarkPanel._renderTocSearchResult(pane, result);
        },

        _renderTocSearchResult: function (pane, items) {
            pane.innerHTML = '';

            if (!items || items.length === 0) {
                pane.innerHTML = '<div class="bk-mp-empty">\u65e0\u5339\u914d\u7ae0\u8282</div>';
                return;
            }

            MarkPanel._renderEpubToc(pane, items);
        },

        // ─── 纲目展开 ──────────────────────────────────────────────────

        _toggleOutline: function (li, chapterItem) {
            var existing = li.querySelector('.bk-mp-toc-outline');
            if (existing) {
                // 已有子列表：切换显示
                var isExpanded = existing.style.display !== 'none';
                existing.style.display = isExpanded ? 'none' : 'block';
                li.classList.toggle('bk-mp-toc-expanded', !isExpanded);
                var toggle = li.querySelector('.bk-mp-toc-toggle');
                if (toggle) toggle.textContent = isExpanded ? '\u25b8' : '\u25be';
                return;
            }

            // 无子列表：异步加载
            var toggle = li.querySelector('.bk-mp-toc-toggle');
            if (toggle) { toggle.textContent = '\u2026'; toggle.disabled = true; }

            var bookId = chapterItem.bookId || MarkPanel._getCurrentBookId();
            var chapterNum = chapterItem.chapterNum || chapterItem.num;

            MarkPanel._adapter.toc.getOutlines(bookId, chapterNum).then(function (outlines) {
                if (!outlines || outlines.length === 0) {
                    // 无纲目：隐藏箭头
                    if (toggle) { toggle.textContent = ''; toggle.style.visibility = 'hidden'; }
                    return;
                }

                var sub = document.createElement('ul');
                sub.className = 'bk-mp-toc-outline';

                outlines.forEach(function (outline) {
                    var subLi = document.createElement('li');
                    subLi.className = 'bk-mp-toc-outline-item';
                    subLi.style.paddingLeft = (28 + (outline.level - 1) * 12) + 'px';

                    var dot = document.createElement('span');
                    dot.className = 'bk-mp-toc-outline-dot';
                    dot.textContent = '\u00b7';

                    var text = document.createElement('span');
                    text.className = 'bk-mp-toc-outline-text';
                    text.textContent = outline.text;

                    subLi.appendChild(dot);
                    subLi.appendChild(text);

                    subLi.addEventListener('click', function () {
                        MarkPanel._adapter.toc.navigateOutline(bookId, chapterNum, outline.index);
                        MarkPanel.close();
                    });

                    sub.appendChild(subLi);
                });

                li.appendChild(sub);
                li.classList.add('bk-mp-toc-expanded');
                if (toggle) { toggle.textContent = '\u25be'; toggle.disabled = false; }

                // 若是当前章节（自动展开定位场景），展开后滚动到可见
                if (li.querySelector('.bk-mp-toc-current')) {
                    li.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }
            });
        },

        // ─── 搜索高亮辅助 ──────────────────────────────────────────────

        _highlightContext: function (text, query) {
            if (!query || !query.trim()) return MarkPanel._escText(text);
            // 先转义文本，再转义每个关键词后匹配（避免关键词匹配到 HTML 实体内部）
            var html = MarkPanel._escText(text);
            var terms = query.trim().split(/\s+/).filter(Boolean);
            for (var i = 0; i < terms.length; i++) {
                var escapedTerm = MarkPanel._escText(terms[i]);
                var re = new RegExp('(' + MarkPanel._escRe(escapedTerm) + ')', 'gi');
                html = html.replace(re, '<span class="bk-mp-toc-hl">$1</span>');
            }
            return html;
        },

        /** HTML 转义（与 search.js 的 esc 一致） */
        _escText: function (s) {
            return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },

        /** 正则转义（与 search.js 的 escRe 一致） */
        _escRe: function (s) {
            return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        },

        // ─── 书签 Tab ──────────────────────────────────────────────────

        _loadBookmarks: function () {
            var adapter = MarkPanel._adapter.bookmark;
            var pane = document.getElementById('bk-mp-pane-bookmark');
            if (!pane || !adapter) return;

            adapter.getItems().then(function (items) {
                // 更新标题
                MarkPanel._titleEl.textContent = MarkPanel._bookTitle || document.title || '';

                win.BK.MarkList.render(pane, items, {
                    defaultColor: win.BK.MarkUtils.COLOR_MAP.bookmark,
                    emptyText: '暂无书签',
                    onNavigate: function (item) {
                        adapter.navigate(item);
                        MarkPanel.close();
                    },
                    onDelete: function (item, li) {
                        if (li._deleting) return;
                        li._deleting = true;
                        // 保存快照用于撤销恢复
                        var snapshot = Object.assign({}, item);
                        adapter.remove(item.id).then(function () {
                            win.BK.MarkList.removeItem(li);
                            // 延迟触发全局刷新，避免截断删除动画
                            setTimeout(function () {
                                MarkPanel._fireMarksChanged();
                                MarkPanel._updateBookmarkFooter();
                            }, 280);
                            win.BK.MarkList.showUndoToast('书签已删除', function () {
                                // 撤销：重新添加
                                (adapter.addFromSnapshot || adapter.add)(snapshot).then(function () {
                                    MarkPanel._fireMarksChanged();
                                    MarkPanel._loadBookmarks();
                                });
                            });
                        });
                    },
                    onEdit: function (item) {
                        MarkPanel._showBookmarkEditMenu(item);
                    }
                });

                MarkPanel._updateBookmarkFooter();
            });
        },

        _updateBookmarkFooter: function () {
            var footer = MarkPanel._footerEl;
            if (!footer) return;

            var adapter = MarkPanel._adapter.bookmark;
            if (!adapter) return;

            adapter.hasCurrentPage().then(function (hasBookmark) {
                footer.innerHTML = '';

                var btn = document.createElement('button');
                btn.className = 'bk-mp-add-btn' + (hasBookmark ? ' bk-mp-add-active' : '');
                btn.textContent = hasBookmark ? '移除当前页书签' : '添加当前页书签';
                btn.addEventListener('click', function () {
                    if (hasBookmark) {
                        // 删除当前页书签：先获取完整快照，再 toggle
                        var snapshotPromise = adapter.getItems ? adapter.getItems().then(function (items) {
                            var curr = items && items.filter(function (it) { return adapter.hasCurrentPage ? true : it.id; });
                            return (curr && curr[0]) ? Object.assign({}, curr[0]) : null;
                        }) : Promise.resolve(null);

                        snapshotPromise.then(function (snapshot) {
                            var toggleP = adapter.toggleCurrentPage ? adapter.toggleCurrentPage() : Promise.resolve();
                            toggleP.then(function () {
                                MarkPanel._fireMarksChanged();
                                MarkPanel._loadBookmarks();
                                win.BK.MarkList.showUndoToast('书签已删除', function () {
                                    // 撤销：优先用快照恢复，否则用 titleInfo 重建
                                    if (snapshot) {
                                        (adapter.addFromSnapshot || adapter.add)(snapshot).then(function () {
                                            MarkPanel._fireMarksChanged();
                                            MarkPanel._loadBookmarks();
                                        });
                                    } else {
                                        var titleInfo = { bookTitle: MarkPanel._bookTitle || '' };
                                        if (MarkPanel._readerType === 'epub') {
                                            titleInfo.chapterTitle = (win.BKRenderer && win.BKRenderer._currentChapterTitle) || '';
                                        }
                                        adapter.add(titleInfo).then(function () {
                                            MarkPanel._fireMarksChanged();
                                            MarkPanel._loadBookmarks();
                                        });
                                    }
                                });
                            });
                        });
                    } else {
                        // 传入 titleInfo 以生成正确的书签标题
                        var titleInfo = {
                            bookTitle: MarkPanel._bookTitle || ''
                        };
                        // EPUB: 补充 chapterTitle
                        if (MarkPanel._readerType === 'epub') {
                            titleInfo.chapterTitle = (win.BKRenderer && win.BKRenderer._currentChapterTitle) || '';
                        }
                        adapter.add(titleInfo).then(function () {
                            MarkPanel._loadBookmarks();
                            MarkPanel._fireMarksChanged();
                        });
                    }
                });
                footer.appendChild(btn);
            });
        },

        _showBookmarkEditMenu: function (item) {
            var menu = document.createElement('div');
            menu.className = 'bk-mp-edit-overlay';
            menu.addEventListener('click', function (e) {
                if (e.target === menu) menu.remove();
            });

            var dialog = document.createElement('div');
            dialog.className = 'bk-mp-edit-dialog';

            var header = document.createElement('div');
            header.className = 'bk-mp-edit-header';
            header.textContent = '编辑书签';
            dialog.appendChild(header);

            var body = document.createElement('div');
            body.className = 'bk-mp-edit-body';

            // 标题输入
            var titleLabel = document.createElement('div');
            titleLabel.style.cssText = 'font-size:var(--text-sm);color:var(--text-muted);margin-bottom:4px;';
            titleLabel.textContent = '标题';
            body.appendChild(titleLabel);

            var titleInput = document.createElement('input');
            titleInput.className = 'bk-mp-edit-input';
            titleInput.value = item.title || '';
            body.appendChild(titleInput);

            // 批注输入
            var noteLabel = document.createElement('div');
            noteLabel.style.cssText = 'font-size:var(--text-sm);color:var(--text-muted);margin:12px 0 4px;';
            noteLabel.textContent = '批注';
            body.appendChild(noteLabel);

            var noteInput = document.createElement('textarea');
            noteInput.className = 'bk-mp-edit-input';
            noteInput.value = item.note || '';
            body.appendChild(noteInput);

            dialog.appendChild(body);

            // 操作按钮
            var actions = document.createElement('div');
            actions.className = 'bk-mp-edit-actions';

            var cancelBtn = document.createElement('button');
            cancelBtn.className = 'bk-mp-edit-btn';
            cancelBtn.textContent = '取消';
            cancelBtn.addEventListener('click', function () { menu.remove(); });

            var deleteBtn = document.createElement('button');
            deleteBtn.className = 'bk-mp-edit-btn bk-mp-edit-destructive';
            deleteBtn.textContent = '删除';
            deleteBtn.addEventListener('click', function () {
                var snapshot = Object.assign({}, item);
                MarkPanel._adapter.bookmark.remove(item.id).then(function () {
                    menu.remove();
                    MarkPanel._fireMarksChanged();
                    MarkPanel._loadBookmarks();
                    win.BK.MarkList.showUndoToast('书签已删除', function () {
                        (MarkPanel._adapter.bookmark.addFromSnapshot || MarkPanel._adapter.bookmark.add)(snapshot).then(function () {
                            MarkPanel._fireMarksChanged();
                            MarkPanel._loadBookmarks();
                        });
                    });
                });
            });

            var saveBtn = document.createElement('button');
            saveBtn.className = 'bk-mp-edit-btn';
            saveBtn.textContent = '保存';
            saveBtn.style.fontWeight = '600';
            saveBtn.addEventListener('click', function () {
                var newTitle = titleInput.value.trim();
                var newNote = noteInput.value.trim();
                var p = Promise.resolve();
                if (newTitle !== item.title) {
                    p = MarkPanel._adapter.bookmark.updateTitle(item.id, newTitle);
                }
                p.then(function () {
                    if (newNote !== (item.note || '')) {
                        return MarkPanel._adapter.bookmark.updateNote(item.id, newNote);
                    }
                }).then(function () {
                    menu.remove();
                    MarkPanel._loadBookmarks();
                });
            });

            actions.appendChild(cancelBtn);
            actions.appendChild(deleteBtn);
            actions.appendChild(saveBtn);
            dialog.appendChild(actions);

            menu.appendChild(dialog);
            document.body.appendChild(menu);

            titleInput.focus();
        },

        // ─── 标记 Tab ──────────────────────────────────────────────────

        _loadMarks: function () {
            var adapter = MarkPanel._adapter.mark;
            var pane = document.getElementById('bk-mp-pane-mark');
            if (!pane || !adapter) return;

            // 根据适配器动态渲染筛选栏
            MarkPanel._renderFilterBar();

            adapter.getItems().then(function (items) {
                MarkPanel._allMarks = items || [];
                MarkPanel._renderMarks();
                MarkPanel._updateMarkFooter(items);
            });
        },

        /**
         * 根据适配器返回的 getFilterTypes() 动态渲染筛选栏
         * EPUB 无删除线，PDF 有删除线
         */
        _renderFilterBar: function () {
            var filter = MarkPanel._filterEl;
            if (!filter) return;
            var adapter = MarkPanel._adapter && MarkPanel._adapter.mark;
            if (!adapter || !adapter.getFilterTypes) return;

            var filterTypes = adapter.getFilterTypes();
            filter.innerHTML = '';

            filterTypes.forEach(function (ft) {
                var tag = document.createElement('span');
                tag.className = 'bk-mp-filter-tag' + (ft.key === MarkPanel._activeFilter ? ' active' : '');
                tag.setAttribute('data-filter', ft.key);
                tag.textContent = ft.label;
                tag.addEventListener('click', function () {
                    MarkPanel._activeFilter = ft.key;
                    filter.querySelectorAll('.bk-mp-filter-tag').forEach(function (t) { t.classList.remove('active'); });
                    tag.classList.add('active');
                    MarkPanel._renderMarks();
                });
                filter.appendChild(tag);
            });
        },

        _renderMarks: function () {
            var pane = document.getElementById('bk-mp-pane-mark');
            if (!pane) return;

            var adapter = MarkPanel._adapter.mark;
            var items = MarkPanel._allMarks || [];

            // 按筛选类型过滤
            if (MarkPanel._activeFilter && MarkPanel._activeFilter !== 'all') {
                items = adapter.filterByType(items, MarkPanel._activeFilter);
            }

            win.BK.MarkList.render(pane, items, {
                showColorBar: true,
                emptyText: '暂无标记',
                onNavigate: function (item) {
                    adapter.navigate(item);
                    MarkPanel.close();
                },
                onDelete: function (item, li) {
                    if (li._deleting) return;
                    li._deleting = true;
                    var snapshot = Object.assign({}, item);
                    adapter.remove(item.id).then(function () {
                        win.BK.MarkList.removeItem(li);
                        // 从缓存中移除
                        MarkPanel._allMarks = (MarkPanel._allMarks || []).filter(function (m) { return m.id !== item.id; });
                        // 延迟触发全局刷新，避免截断删除动画
                        setTimeout(function () {
                            MarkPanel._fireMarksChanged();
                            MarkPanel._updateMarkFooter(MarkPanel._allMarks);
                        }, 280);
                        win.BK.MarkList.showUndoToast('标记已删除', function () {
                            // 撤销：重新添加
                            (adapter.addFromSnapshot || adapter.add)(snapshot).then(function () {
                                MarkPanel._fireMarksChanged();
                                MarkPanel._loadMarks();
                            });
                        });
                    });
                },
                onEdit: function (item) {
                    MarkPanel._showMarkEditMenu(item);
                }
            });
        },

        _updateMarkFooter: function (items) {
            var footer = MarkPanel._footerEl;
            if (!footer) return;

            var total = (items || []).length;
            var noteCount = (items || []).filter(function (m) { return m.note; }).length;

            footer.innerHTML = '';
            var stats = document.createElement('span');
            stats.className = 'bk-mp-stats';
            stats.textContent = '共 ' + total + ' 条标记' + (noteCount > 0 ? (' · ' + noteCount + ' 条批注') : '');
            footer.appendChild(stats);
        },

        _showMarkEditMenu: function (item) {
            var menu = document.createElement('div');
            menu.className = 'bk-mp-edit-overlay';
            menu.addEventListener('click', function (e) {
                if (e.target === menu) menu.remove();
            });

            var dialog = document.createElement('div');
            dialog.className = 'bk-mp-edit-dialog';

            var header = document.createElement('div');
            header.className = 'bk-mp-edit-header';
            header.textContent = '编辑标记';
            dialog.appendChild(header);

            var body = document.createElement('div');
            body.className = 'bk-mp-edit-body';

            // 批注输入
            var noteLabel = document.createElement('div');
            noteLabel.style.cssText = 'font-size:var(--text-sm);color:var(--text-muted);margin-bottom:4px;';
            noteLabel.textContent = '批注';
            body.appendChild(noteLabel);

            var noteInput = document.createElement('textarea');
            noteInput.className = 'bk-mp-edit-input';
            noteInput.value = item.note || '';
            body.appendChild(noteInput);

            dialog.appendChild(body);

            // 操作按钮
            var actions = document.createElement('div');
            actions.className = 'bk-mp-edit-actions';

            var cancelBtn = document.createElement('button');
            cancelBtn.className = 'bk-mp-edit-btn';
            cancelBtn.textContent = '取消';
            cancelBtn.addEventListener('click', function () { menu.remove(); });

            var deleteBtn = document.createElement('button');
            deleteBtn.className = 'bk-mp-edit-btn bk-mp-edit-destructive';
            deleteBtn.textContent = '删除';
            deleteBtn.addEventListener('click', function () {
                var snapshot = Object.assign({}, item);
                MarkPanel._adapter.mark.remove(item.id).then(function () {
                    menu.remove();
                    MarkPanel._allMarks = (MarkPanel._allMarks || []).filter(function (m) { return m.id !== item.id; });
                    MarkPanel._fireMarksChanged();
                    MarkPanel._renderMarks();
                    MarkPanel._updateMarkFooter(MarkPanel._allMarks);
                    win.BK.MarkList.showUndoToast('标记已删除', function () {
                        (MarkPanel._adapter.mark.addFromSnapshot || MarkPanel._adapter.mark.add)(snapshot).then(function () {
                            MarkPanel._fireMarksChanged();
                            MarkPanel._loadMarks();
                        });
                    });
                });
            });

            var saveBtn = document.createElement('button');
            saveBtn.className = 'bk-mp-edit-btn';
            saveBtn.textContent = '保存';
            saveBtn.style.fontWeight = '600';
            saveBtn.addEventListener('click', function () {
                // 笔记更新通过适配器统一处理
                var newNote = noteInput.value.trim();
                if (MarkPanel._adapter && MarkPanel._adapter.mark && MarkPanel._adapter.mark.updateNote) {
                    MarkPanel._adapter.mark.updateNote(item.id, newNote);
                }
                // 更新本地缓存
                var mark = (MarkPanel._allMarks || []).find(function (m) { return m.id === item.id; });
                if (mark) mark.note = newNote;
                menu.remove();
                MarkPanel._fireMarksChanged();
                MarkPanel._renderMarks();
            });

            actions.appendChild(cancelBtn);
            actions.appendChild(deleteBtn);
            actions.appendChild(saveBtn);
            dialog.appendChild(actions);

            menu.appendChild(dialog);
            document.body.appendChild(menu);

            noteInput.focus();
        },

        // ─── 辅助方法 ──────────────────────────────────────────────────

        _scheduleAutoClose: function () {
            if (MarkPanel._autoCloseTimer) clearTimeout(MarkPanel._autoCloseTimer);
            MarkPanel._autoCloseTimer = setTimeout(function () {
                MarkPanel.close();
            }, 5000);
        },

        _onEsc: function (e) {
            if (e.key === 'Escape') MarkPanel.close();
        },

        _closePdfDrawers: function () {
            if (MarkPanel._readerType !== 'pdf') return;
            var s = win.BKPdf && win.BKPdf._internal && win.BKPdf._internal.state;
            if (s && s.closeAllDrawersExcept) {
                s.closeAllDrawersExcept('markPanel');
            }
        },

        /**
         * 派发 marks-changed 事件，通知其他组件（如书架统计等）
         */
        _fireMarksChanged: function () {
            // 数据变更后标记书签和标记 Tab 为脏
            MarkPanel._dirtyTabs.bookmark = true;
            MarkPanel._dirtyTabs.mark = true;
            try {
                document.dispatchEvent(new CustomEvent('marks-changed'));
            } catch (e) {}
        },

        /**
         * 刷新内容页面上的视觉标记（高亮/下划线/批注图标等）
         * 标记删除后内容页面残留旧标记，需重渲染覆盖层
         */
        _refreshContentHighlights: function () {
            // PDF：重渲所有可见页的高亮覆盖层
            if (win.BKPdf && win.BKPdf._internal && win.BKPdf._internal.highlight) {
                var renderFn = win.BKPdf._internal.highlight.renderAllVisibleHighlights;
                if (typeof renderFn === 'function') renderFn();
            }
            // EPUB：清除所有 DOM 标记再重渲
            if (win.BKHighlight) {
                if (typeof win.BKHighlight.clearAllMarks === 'function') {
                    win.BKHighlight.clearAllMarks();
                }
                if (typeof win.BKHighlight.restoreHighlights === 'function') {
                    win.BKHighlight.restoreHighlights();
                }
            }
        }
    };

        // 监听外部标记变更事件（如书签添加/删除、高亮变更等）
        // 事件可由任何模块派发：document.dispatchEvent(new CustomEvent('marks-changed'))
        document.addEventListener('marks-changed', function () {
            MarkPanel.refresh();
            MarkPanel._refreshContentHighlights();
        });

        // 监听页面变化（PDF 翻页 / EPUB 切章），刷新书签 footer 按钮状态
        document.addEventListener('reader-page-change', function (e) {
            // 书籍切换时重置目录/标记脏标记（本次面板感知的书籍与上次不同）
            MarkPanel._syncBookContext();
            // 翻页后当前页的书签状态可能变化，标记 bookmark 为脏
            MarkPanel._dirtyTabs.bookmark = true;
            // ★ EPUB 切章：目录高亮需跟随当前章节（同书不同章）
            //   reader-page-change 在切章/翻页时派发。检测到当前章节号变化时，
            //   将目录(toc)标记为脏，确保下次打开或切到目录 Tab 时重新计算高亮，
            //   避免目录一直停留在"抽屉打开那一刻"的章节。
            if (MarkPanel._readerType === 'epub') {
                var _path = (e && e.detail && e.detail.path) || win.__bkCurrentPath || '';
                var _parts = String(_path).split('/').filter(Boolean);
                var _chNum = _parts.length >= 2 ? parseInt(_parts[1], 10) : 0;
                if (_chNum && _chNum !== MarkPanel._lastChapterNum) {
                    MarkPanel._lastChapterNum = _chNum;
                    MarkPanel._dirtyTabs.toc = true;
                    // 面板开着且正停在目录 Tab 时，重渲染以更新高亮。
                    // ★ 延迟到渲染器完成章节切换后再加载（reader-page-change 在
                    //   dispatch 时同步派发，此刻 loadBook/carousel 数据可能尚未更新，
                    //   立即调用会拿到旧数据渲染成"暂无目录"）。
                    if (MarkPanel._isOpen && MarkPanel._activeTab === 'toc') {
                        setTimeout(function () { MarkPanel._loadTabData('toc'); }, 150);
                    }
                }
            }
            if (MarkPanel._isOpen && MarkPanel._activeTab === 'bookmark') {
                MarkPanel._updateBookmarkFooter();
            }
        });

    win.BK.MarkPanel = MarkPanel;
})(window);
