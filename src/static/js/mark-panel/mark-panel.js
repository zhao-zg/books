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

        // ─── 公开 API ──────────────────────────────────────────────────

        /**
         * 打开面板
         * @param {string} [tab] - 指定打开的 tab: 'toc'|'bookmark'|'mark'
         */
        open: function (tab) {
            if (MarkPanel._isOpen && MarkPanel._activeTab === (tab || 'toc')) return;

            MarkPanel._detectReaderType();
            MarkPanel._getAdapter();
            MarkPanel._ensureDOM();

            // 确定打开的 Tab
            var targetTab = tab || localStorage.getItem(LAST_TAB_KEY) || 'toc';
            if (TABS.indexOf(targetTab) < 0) targetTab = 'toc';

            MarkPanel._activeTab = targetTab;
            MarkPanel._isOpen = true;

            // 显示
            MarkPanel._drawer.classList.add('bk-mp-visible');
            MarkPanel._overlay.classList.add('bk-mp-visible');

            // 关闭旧 TOC 抽屉（EPUB 端）
            var tocDrawer = document.getElementById('bkTocDrawer');
            if (tocDrawer) tocDrawer.classList.remove('open');
            var tocOverlay = document.getElementById('bkTocOverlay');
            if (tocOverlay) tocOverlay.classList.remove('open');

            // 关闭 PDF 旧抽屉
            MarkPanel._closePdfDrawers();

            // 推入 backStack
            if (win.BKBackStack && win.BKBackStack.push) {
                win.BKBackStack.push('markPanel', function () { MarkPanel.close(); });
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

            document.removeEventListener('keydown', MarkPanel._onEsc);

            if (MarkPanel._autoCloseTimer) {
                clearTimeout(MarkPanel._autoCloseTimer);
                MarkPanel._autoCloseTimer = null;
            }

            // 退出 backStack
            if (win.BKBackStack && win.BKBackStack.silentPop) {
                win.BKBackStack.silentPop('markPanel');
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
            if (!MarkPanel._isOpen) return;
            MarkPanel._loadTabData(MarkPanel._activeTab);
        },

        // ─── 内部方法 ──────────────────────────────────────────────────

        _detectReaderType: function () {
            // PDF 阅读器通过 BKPdf._internal 判断
            MarkPanel._readerType = (win.BKPdf && win.BKPdf._internal) ? 'pdf' : 'epub';
        },

        _getAdapter: function () {
            var adapters = win.BK.MarkPanelAdapters || {};
            MarkPanel._adapter = (MarkPanel._readerType === 'pdf')
                ? adapters.PdfAdapter
                : adapters.EpubAdapter;
        },

        _ensureDOM: function () {
            if (MarkPanel._drawer) return;

            // Overlay
            MarkPanel._overlay = document.createElement('div');
            MarkPanel._overlay.className = 'bk-mp-overlay';
            MarkPanel._overlay.addEventListener('click', function () { MarkPanel.close(); });
            // 触摸穿透阻止
            MarkPanel._overlay.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
            MarkPanel._overlay.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
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

            var closeBtn = document.createElement('button');
            closeBtn.className = 'bk-mp-close';
            closeBtn.textContent = '\u2715'; // ✕
            closeBtn.addEventListener('click', function () { MarkPanel.close(); });

            header.appendChild(titleEl);
            header.appendChild(closeBtn);
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
            searchInput.placeholder = '搜索章节…';
            searchInput.addEventListener('input', win.BK.MarkUtils.debounce(function () {
                MarkPanel._onTocSearch(searchInput.value);
            }, 200));
            search.appendChild(searchInput);
            MarkPanel._searchEl = search;
            MarkPanel._searchInput = searchInput;
            MarkPanel._drawer.appendChild(search);

            // 筛选栏（标记 Tab）
            var filter = document.createElement('div');
            filter.className = 'bk-mp-filter';
            filter.id = 'bk-mp-filter';
            var filterTypes = [
                { key: 'all', label: '全部' },
                { key: 'highlight', label: '\uD83D\uDD8C高亮' },
                { key: 'underline', label: 'U\u0332下划线' },
                { key: 'strikethrough', label: 'S\u0336删除线' },
                { key: 'note', label: '\uD83D\uDCDD批注' }
            ];
            filterTypes.forEach(function (ft) {
                var tag = document.createElement('span');
                tag.className = 'bk-mp-filter-tag' + (ft.key === 'all' ? ' active' : '');
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

            // 加载数据
            MarkPanel._loadTabData(tabId);
        },

        _loadTabData: function (tabId) {
            if (!MarkPanel._adapter) return;

            if (tabId === 'toc') {
                MarkPanel._loadToc();
            } else if (tabId === 'bookmark') {
                MarkPanel._loadBookmarks();
            } else if (tabId === 'mark') {
                MarkPanel._loadMarks();
            }
        },

        // ─── 目录 Tab ──────────────────────────────────────────────────

        _loadToc: function () {
            var adapter = MarkPanel._adapter.toc;
            var pane = document.getElementById('bk-mp-pane-toc');
            if (!pane || !adapter) return;

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
            });
        },

        _renderEpubToc: function (pane, items) {
            var ul = document.createElement('ul');
            ul.className = 'bk-mp-toc-list';

            items.forEach(function (item, idx) {
                var li = document.createElement('li');
                li.className = 'bk-mp-toc-item';
                if (item.isActive) li.classList.add('bk-mp-toc-current');

                var num = document.createElement('span');
                num.className = 'bk-mp-toc-num';
                num.textContent = (idx + 1);

                var title = document.createElement('span');
                title.className = 'bk-mp-toc-title';
                title.textContent = item.title;

                li.appendChild(num);
                li.appendChild(title);

                li.addEventListener('click', function () {
                    MarkPanel._adapter.toc.navigate(item);
                    MarkPanel._scheduleAutoClose();
                });

                ul.appendChild(li);
            });

            pane.appendChild(ul);
        },

        _renderPdfToc: function (pane, items) {
            var ul = document.createElement('ul');
            ul.className = 'bk-mp-toc-tree';

            // 按树形结构渲染
            function renderLevel(levelItems, depth) {
                var parentUl = document.createElement('ul');
                parentUl.className = 'bk-mp-toc-tree';
                if (depth > 0) parentUl.classList.add('bk-mp-toc-tree-children', 'bk-mp-expanded');

                levelItems.forEach(function (item) {
                    var li = document.createElement('li');
                    li.className = 'bk-mp-toc-tree-item';

                    var row = document.createElement('div');
                    row.className = 'bk-mp-toc-tree-row';
                    row.style.paddingLeft = (16 + depth * 16) + 'px';

                    var toggle = document.createElement('button');
                    toggle.className = 'bk-mp-toc-tree-toggle';
                    if (item.hasChildren) {
                        toggle.textContent = '▾';
                    }

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

                    // 点击跳转
                    row.addEventListener('click', function () {
                        MarkPanel._adapter.toc.navigate(item);
                        MarkPanel._scheduleAutoClose();
                    });

                    // 展开/折叠
                    if (item.hasChildren) {
                        var childContainer = document.createElement('div');
                        childContainer.className = 'bk-mp-toc-tree-children';

                        toggle.addEventListener('click', function (e) {
                            e.stopPropagation();
                            var expanded = childContainer.classList.contains('bk-mp-expanded');
                            childContainer.classList.toggle('bk-mp-expanded', !expanded);
                            toggle.textContent = expanded ? '▸' : '▾';
                        });

                        li.appendChild(childContainer);
                    }

                    parentUl.appendChild(li);
                });

                return parentUl;
            }

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
                    MarkPanel._scheduleAutoClose();
                });

                ul.appendChild(li);
            });

            pane.appendChild(ul);
        },

        _onTocSearch: function (keyword) {
            if (MarkPanel._readerType !== 'epub') return;
            var pane = document.getElementById('bk-mp-pane-toc');
            if (!pane) return;

            var items = MarkPanel._adapter.toc.search(keyword);
            pane.innerHTML = '';

            if (!items || items.length === 0) {
                pane.innerHTML = '<div class="bk-mp-empty">无匹配章节</div>';
                return;
            }

            MarkPanel._renderEpubToc(pane, items);
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
                        MarkPanel._scheduleAutoClose();
                    },
                    onDelete: function (item, li) {
                        adapter.remove(item.id).then(function () {
                            win.BK.MarkList.removeItem(li);
                            MarkPanel._updateBookmarkFooter();
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
                        // 删除当前页书签
                        adapter.getItems().then(function (items) {
                            // 找到当前页书签并删除
                            // 简单做法：toggle
                            if (adapter.toggleCurrentPage) adapter.toggleCurrentPage();
                            MarkPanel._loadBookmarks();
                        });
                    } else {
                        adapter.add({}).then(function () {
                            MarkPanel._loadBookmarks();
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

            // 笔记输入
            var noteLabel = document.createElement('div');
            noteLabel.style.cssText = 'font-size:var(--text-sm);color:var(--text-muted);margin:12px 0 4px;';
            noteLabel.textContent = '笔记';
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
                MarkPanel._adapter.bookmark.remove(item.id).then(function () {
                    menu.remove();
                    MarkPanel._loadBookmarks();
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

            adapter.getItems().then(function (items) {
                MarkPanel._allMarks = items || [];
                MarkPanel._renderMarks();
                MarkPanel._updateMarkFooter(items);
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
                    MarkPanel._scheduleAutoClose();
                },
                onDelete: function (item, li) {
                    adapter.remove(item.id).then(function () {
                        win.BK.MarkList.removeItem(li);
                        // 从缓存中移除
                        MarkPanel._allMarks = (MarkPanel._allMarks || []).filter(function (m) { return m.id !== item.id; });
                        MarkPanel._updateMarkFooter(MarkPanel._allMarks);
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

            // 笔记输入
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
                MarkPanel._adapter.mark.remove(item.id).then(function () {
                    menu.remove();
                    MarkPanel._allMarks = (MarkPanel._allMarks || []).filter(function (m) { return m.id !== item.id; });
                    MarkPanel._renderMarks();
                    MarkPanel._updateMarkFooter(MarkPanel._allMarks);
                });
            });

            var saveBtn = document.createElement('button');
            saveBtn.className = 'bk-mp-edit-btn';
            saveBtn.textContent = '保存';
            saveBtn.style.fontWeight = '600';
            saveBtn.addEventListener('click', function () {
                // 笔记更新需要通过各自的底层 API
                // EPUB: BKHighlight.saveNote
                // PDF: pdf-state.setHighlightNote
                var newNote = noteInput.value.trim();
                if (MarkPanel._readerType === 'epub' && win.BKHighlight && win.BKHighlight.saveNote) {
                    win.BKHighlight.saveNote(item.id, newNote);
                } else if (MarkPanel._readerType === 'pdf') {
                    var s = (win.BKPdf && win.BKPdf._state) || win.BKPdfState;
                    var bookId = s ? s.currentBookId() : null;
                    if (s && bookId) s.setHighlightNote(bookId, item.id, newNote);
                }
                // 更新本地缓存
                var mark = (MarkPanel._allMarks || []).find(function (m) { return m.id === item.id; });
                if (mark) mark.note = newNote;
                menu.remove();
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
            var s = (win.BKPdf && win.BKPdf._state) || win.BKPdfState;
            if (s && s.closeAllDrawersExcept) {
                s.closeAllDrawersExcept('markPanel');
            }
        }
    };

    // 监听外部标记变更事件
    document.addEventListener('marks-changed', function () {
        MarkPanel.refresh();
    });

    win.BK.MarkPanel = MarkPanel;
})(window);
