/**
 * 笔记汇总模块
 * 汇总展示划线笔记 + 书签笔记 + 书架读书笔记，支持搜索、按书筛选和导出（txt / markdown）
 *
 * 依赖：
 *   - BKBookmark.getAll()      书签笔记
 *   - BKStorage.getAllPages()  划线笔记
 *   - BKShelf.getAll()         书架读书笔记
 *   - BK.openDialog()          弹窗系统
 *   - win.__bkBooks            书籍列表（用于按书分组）
 */
(function (win) {
    'use strict';

    var BKNoteSummary = {
        _notes: [],         // 合并后的笔记列表
        _filtered: [],      // 过滤后的列表
        _query: '',         // 当前搜索词
        _activeBook: '',    // 当前选中的书名（空=全部）
        _totalHighlights: 0, // 划线总数（含无笔记的）
        _dlg: null,         // 当前弹窗引用

        /**
         * 打开笔记汇总弹框
         */
        show: function () {
            var self = this;
            this._query = '';
            this._activeBook = '';
            this._loadAll().then(function (notes) {
                self._notes = notes;
                self._filtered = notes;
                self._render();
            }).catch(function () {
                self._notes = [];
                self._filtered = [];
                self._render();
            });
        },

        // ─── 数据加载 ─────────────────────────────────────────────────

        /** 加载所有书签笔记 + 划线笔记 + 书架读书笔记，合并为统一列表 */
        _loadAll: function () {
            var promises = [];
            var self = this;
            self._totalHighlights = 0;

            // 书签笔记
            if (win.BKBookmark && win.BKBookmark.getAll) {
                promises.push(
                    win.BKBookmark.getAll().then(function (arr) {
                        var result = [];
                        for (var i = 0; i < arr.length; i++) {
                            var bm = arr[i];
                            if (bm.note) {
                                result.push({
                                    type: 'bookmark',
                                    bookId: bm.bookId || '',
                                    source: bm.title || bm.path || '未命名',
                                    text: bm.note,
                                    highlightText: '',
                                    timestamp: bm.timestamp || 0,
                                    id: bm.id,
                                    path: bm.path || '',
                                    scrollY: bm.scrollY || 0
                                });
                            }
                        }
                        return result;
                    }).catch(function () { return []; })
                );
            } else {
                promises.push(Promise.resolve([]));
            }

            // 划线笔记
            if (win.BKStorage && win.BKStorage.getAllPages) {
                promises.push(
                    win.BKStorage.getAllPages().then(function (pages) {
                        var result = [];
                        for (var p = 0; p < pages.length; p++) {
                            var page = pages[p];
                            var hls = page.highlights || [];
                            for (var h = 0; h < hls.length; h++) {
                                var hl = hls[h];
                                self._totalHighlights++;
                                if (hl.note) {
                                    result.push({
                                        type: 'highlight',
                                        bookId: _extractBookId(page.key),
                                        source: _extractBookName(page.key),
                                        text: hl.note,
                                        highlightText: hl.text || '',
                                        timestamp: hl.timestamp || 0,
                                        id: hl.id,
                                        pageKey: page.key
                                    });
                                }
                            }
                        }
                        return result;
                    }).catch(function () { return []; })
                );
            } else {
                promises.push(Promise.resolve([]));
            }

            // 书架读书笔记
            if (win.BKShelf && win.BKShelf.getAll) {
                promises.push(
                    win.BKShelf.getAll().then(function (shelfItems) {
                        var result = [];
                        for (var s = 0; s < shelfItems.length; s++) {
                            var item = shelfItems[s];
                            if (item.note) {
                                var bookName = _findBookNameById(item.bookId || item.id);
                                result.push({
                                    type: 'shelf',
                                    bookId: item.bookId || item.id || '',
                                    source: bookName || item.bookId || '未知书籍',
                                    text: item.note,
                                    highlightText: '',
                                    timestamp: item.noteTimestamp || item.timestamp || 0,
                                    id: 'shelf:' + (item.bookId || item.id)
                                });
                            }
                        }
                        return result;
                    }).catch(function () { return []; })
                );
            } else {
                promises.push(Promise.resolve([]));
            }

            return Promise.all(promises).then(function (results) {
                var all = (results[0] || []).concat(results[1] || []).concat(results[2] || []);
                // 按时间倒序
                all.sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });
                return all;
            });
        },

        // ─── 渲染 ─────────────────────────────────────────────────────

        _render: function () {
            var self = this;
            var notes = this._filtered;
            var total = this._notes.length;
            var hlCount = 0;
            var bmCount = 0;
            var shelfCount = 0;
            for (var i = 0; i < this._notes.length; i++) {
                if (this._notes[i].type === 'highlight') hlCount++;
                else if (this._notes[i].type === 'shelf') shelfCount++;
                else bmCount++;
            }

            var bodyHtml = '';

            // 搜索栏
            bodyHtml += '<div class="bk-ns-search-bar">';
            bodyHtml += '<input type="text" id="bkNsSearchInput" class="bk-ns-search-input" placeholder="搜索笔记内容..." value="' + _escAttr(this._query) + '">';
            bodyHtml += '</div>';

            // 按书筛选Tab
            bodyHtml += this._renderTabBarHtml();

            // 统计（含划线/书签/书架分类）
            bodyHtml += '<div class="bk-ns-stats">';
            bodyHtml += '共 <strong>' + total + '</strong> 条笔记';
            if (hlCount || bmCount || shelfCount) {
                bodyHtml += '（<strong>' + hlCount + '</strong> 划线 · <strong>' + bmCount + '</strong> 书签 · <strong>' + shelfCount + '</strong> 书架）';
            }
            if (this._totalHighlights) {
                bodyHtml += '，划线 <strong>' + this._totalHighlights + '</strong> 条';
            }
            if (this._query && notes.length !== total) {
                bodyHtml += '，匹配 <strong>' + notes.length + '</strong> 条';
            }
            bodyHtml += '</div>';

            // 笔记列表
            bodyHtml += this._renderListHtml(notes);

            // 底部操作栏
            var exportBtnHtml = notes.length
                ? '<button class="bk-dialog-confirm" data-action="export">导出笔记</button>'
                : '';
            var footerHtml = '<div class="bk-dialog-actions">' +
                '<button class="bk-dialog-cancel" data-action="close">关闭</button>' +
                exportBtnHtml +
                '</div>';

            var dialogHtml = '<div class="bk-dialog" style="width:min(420px,calc(100vw - 32px));max-height:80vh">' +
                '<div class="bk-dialog-title">📝 我的笔记</div>' +
                '<div class="bk-ns-body">' + bodyHtml + '</div>' +
                footerHtml +
                '</div>';

            var dlg = win.BK.openDialog({
                id: 'bk-note-summary',
                html: dialogHtml
            });

            this._dlg = dlg;
            this._bindEvents(dlg);
        },

        /** 渲染按书筛选Tab栏 */
        _renderTabBarHtml: function () {
            var groups = _groupByBook(this._notes);
            var keys = Object.keys(groups);
            if (keys.length <= 1) return ''; // 只有一本书时不显示

            var html = '<div class="bk-ns-tabs">';
            html += '<button class="bk-ns-tab' + (!this._activeBook ? ' active' : '') + '" data-book="">全部</button>';
            for (var i = 0; i < keys.length; i++) {
                var isActive = this._activeBook === keys[i];
                var count = groups[keys[i]].length;
                html += '<button class="bk-ns-tab' + (isActive ? ' active' : '') + '" data-book="' + _escAttr(keys[i]) + '">' + _escHtml(keys[i]) + '<span class="bk-ns-tab-count">' + count + '</span></button>';
            }
            html += '</div>';
            return html;
        },

        /** 渲染笔记列表HTML */
        _renderListHtml: function (notes) {
            var bodyHtml = '';

            // 按书分组
            var groups = _groupByBook(notes);
            var groupKeys = Object.keys(groups);
            for (var g = 0; g < groupKeys.length; g++) {
                var bookName = groupKeys[g];
                var items = groups[bookName];
                bodyHtml += '<div class="bk-ns-group">';
                bodyHtml += '<div class="bk-ns-group-title">' + _escHtml(bookName) + '</div>';
                for (var i = 0; i < items.length; i++) {
                    var item = items[i];
                    var typeLabel = item.type === 'bookmark' ? '📑 书签' : item.type === 'shelf' ? '📚 书架' : '✏️ 划线';
                    var timeStr = item.timestamp ? _relativeTime(item.timestamp) : '';

                    bodyHtml += '<div class="bk-ns-item" data-type="' + item.type + '" data-id="' + _escAttr(item.id || '') + '"';
                    if (item.type === 'bookmark') {
                        bodyHtml += ' data-path="' + _escAttr(item.path || '') + '" data-scroll-y="' + (item.scrollY || 0) + '"';
                    } else if (item.type === 'highlight') {
                        bodyHtml += ' data-page-key="' + _escAttr(item.pageKey || '') + '"';
                    }
                    bodyHtml += '>';

                    bodyHtml += '<div class="bk-ns-item-header">';
                    bodyHtml += '<span class="bk-ns-item-type">' + typeLabel + '</span>';
                    if (timeStr) bodyHtml += '<span class="bk-ns-item-time">' + _escHtml(timeStr) + '</span>';
                    bodyHtml += '</div>';

                    // 划线文本（仅划线类型）
                    if (item.highlightText) {
                        bodyHtml += '<div class="bk-ns-item-hl">「' + _escHtml(item.highlightText) + '」</div>';
                    }

                    // 笔记内容
                    bodyHtml += '<div class="bk-ns-item-text">' + _escHtml(item.text) + '</div>';

                    // 来源
                    if (!item.highlightText) {
                        bodyHtml += '<div class="bk-ns-item-source">来源：' + _escHtml(item.source) + '</div>';
                    }

                    bodyHtml += '</div>';
                }
                bodyHtml += '</div>';
            }

            if (!notes.length) {
                if (this._query || this._activeBook) {
                    bodyHtml += '<div class="bk-ns-empty"><div class="bk-ns-empty-icon">🔍</div><div class="bk-ns-empty-text">没有匹配的笔记</div></div>';
                } else {
                    bodyHtml += '<div class="bk-ns-empty"><div class="bk-ns-empty-icon">📝</div><div class="bk-ns-empty-text">暂无笔记</div><div class="bk-ns-empty-hint">在阅读时选中文本添加划线笔记，给书签添加笔记，或在书架添加读书笔记</div></div>';
                }
            }

            return bodyHtml;
        },

        _bindEvents: function (dlg) {
            var self = this;

            // 搜索
            var input = dlg.querySelector('#bkNsSearchInput');
            if (input) {
                var _timer = null;
                input.addEventListener('input', function () {
                    clearTimeout(_timer);
                    _timer = setTimeout(function () {
                        self._query = (input.value || '').trim();
                        self._doFilter();
                        self._updateList(dlg);
                    }, 250);
                });
            }

            // 按书Tab
            var tabs = dlg.querySelectorAll('.bk-ns-tab');
            for (var t = 0; t < tabs.length; t++) {
                (function (tab) {
                    tab.addEventListener('click', function () {
                        self._activeBook = tab.getAttribute('data-book') || '';
                        // 更新Tab激活状态
                        var allTabs = dlg.querySelectorAll('.bk-ns-tab');
                        for (var j = 0; j < allTabs.length; j++) {
                            allTabs[j].classList.toggle('active', allTabs[j] === tab);
                        }
                        self._doFilter();
                        self._updateList(dlg);
                    });
                })(tabs[t]);
            }

            // 笔记条目交互：单击跳转，长按/右键操作菜单
            var items = dlg.querySelectorAll('.bk-ns-item');
            for (var i = 0; i < items.length; i++) {
                _bindItemInteraction(items[i], self);
            }

            // 按钮
            var btns = dlg.querySelectorAll('[data-action]');
            for (var b = 0; b < btns.length; b++) {
                (function (btn) {
                    btn.addEventListener('click', function () {
                        var action = btn.getAttribute('data-action');
                        if (action === 'close') {
                            if (win.BK && win.BK.closeDialog) win.BK.closeDialog(dlg);
                        } else if (action === 'export') {
                            self._showExportMenu();
                        }
                    });
                })(btns[b]);
            }
        },

        _doFilter: function () {
            var self = this;
            var pool = this._notes;

            // 先按书筛选
            if (this._activeBook) {
                pool = pool.filter(function (n) { return n.source === self._activeBook; });
            }

            // 再按搜索词筛选
            if (!this._query) {
                this._filtered = pool.slice();
                return;
            }
            var q = this._query.toLowerCase();
            this._filtered = [];
            for (var i = 0; i < pool.length; i++) {
                var n = pool[i];
                if ((n.text && n.text.toLowerCase().indexOf(q) >= 0) ||
                    (n.highlightText && n.highlightText.toLowerCase().indexOf(q) >= 0) ||
                    (n.source && n.source.toLowerCase().indexOf(q) >= 0)) {
                    this._filtered.push(n);
                }
            }
        },

        /** 增量更新列表（保留搜索栏和Tab，仅替换统计+列表） */
        _updateList: function (dlg) {
            var self = this;
            var notes = this._filtered;
            var total = this._notes.length;
            var hlCount = 0;
            var bmCount = 0;
            var shelfCount = 0;
            for (var i = 0; i < this._notes.length; i++) {
                if (this._notes[i].type === 'highlight') hlCount++;
                else if (this._notes[i].type === 'shelf') shelfCount++;
                else bmCount++;
            }

            var bodyHtml = '';

            // 统计（含划线/书签/书架分类）
            bodyHtml += '<div class="bk-ns-stats">';
            bodyHtml += '共 <strong>' + total + '</strong> 条笔记';
            if (hlCount || bmCount || shelfCount) {
                bodyHtml += '（<strong>' + hlCount + '</strong> 划线 · <strong>' + bmCount + '</strong> 书签 · <strong>' + shelfCount + '</strong> 书架）';
            }
            if (this._totalHighlights) {
                bodyHtml += '，划线 <strong>' + this._totalHighlights + '</strong> 条';
            }
            if (this._query && notes.length !== total) {
                bodyHtml += '，匹配 <strong>' + notes.length + '</strong> 条';
            }
            bodyHtml += '</div>';

            // 笔记列表
            bodyHtml += this._renderListHtml(notes);

            // 更新导出按钮可见性
            var footerArea = dlg.querySelector('.bk-dialog-actions');
            var oldExportBtn = footerArea ? footerArea.querySelector('[data-action="export"]') : null;
            if (!notes.length && oldExportBtn) {
                oldExportBtn.parentNode.removeChild(oldExportBtn);
            } else if (notes.length && !oldExportBtn) {
                var exportBtn = document.createElement('button');
                exportBtn.className = 'bk-dialog-confirm';
                exportBtn.setAttribute('data-action', 'export');
                exportBtn.textContent = '导出笔记';
                if (footerArea) footerArea.appendChild(exportBtn);
                (function (btn) {
                    btn.addEventListener('click', function () {
                        self._showExportMenu();
                    });
                })(exportBtn);
            }

            // 替换 body 内容（保留搜索栏和Tab）
            var bodyEl = dlg.querySelector('.bk-ns-body');
            if (bodyEl) {
                var lastPreserved = bodyEl.querySelector('.bk-ns-tabs') || bodyEl.querySelector('.bk-ns-search-bar');
                if (lastPreserved) {
                    // 移除 lastPreserved 之后的所有兄弟节点
                    var sibling = lastPreserved.nextSibling;
                    while (sibling) {
                        var next = sibling.nextSibling;
                        bodyEl.removeChild(sibling);
                        sibling = next;
                    }
                    // 插入新的列表内容
                    var tmp = document.createElement('div');
                    tmp.innerHTML = bodyHtml;
                    while (tmp.firstChild) {
                        bodyEl.appendChild(tmp.firstChild);
                    }
                } else {
                    bodyEl.innerHTML = bodyHtml;
                }
            }

            // 重新绑定笔记条目交互
            var items = dlg.querySelectorAll('.bk-ns-item');
            for (var j = 0; j < items.length; j++) {
                _bindItemInteraction(items[j], self);
            }

            // 重新聚焦搜索输入框并将光标放到末尾
            var input = dlg.querySelector('#bkNsSearchInput');
            if (input) {
                input.focus();
                var len = input.value.length;
                try { input.setSelectionRange(len, len); } catch (e) { /* some input types don't support setSelectionRange */ }
            }
        },

        // ─── 条目交互 ─────────────────────────────────────────────────

        /** 单击跳转原文 */
        _onItemTap: function (item) {
            // 先关闭弹窗
            if (this._dlg && win.BK && win.BK.closeDialog) {
                win.BK.closeDialog(this._dlg);
            }
            if (item.type === 'bookmark' && item.path) {
                if (win.BKBookmark && win.BKBookmark.goto) {
                    win.BKBookmark.goto(item);
                } else if (win.BKRouter && win.BKRouter.navigate) {
                    win.BKRouter.navigate(item.path);
                    if (item.scrollY) {
                        requestAnimationFrame(function () {
                            requestAnimationFrame(function () {
                                win.scrollTo(0, item.scrollY);
                            });
                        });
                    }
                }
            } else if (item.type === 'highlight' && item.pageKey) {
                if (win.BKRouter && win.BKRouter.navigate) {
                    win.BKRouter.navigate(item.pageKey);
                }
            } else if (item.type === 'shelf' && item.bookId) {
                /* 书架笔记：跳转到书架页 */
                if (win.BKRouter && win.BKRouter.navigate) {
                    win.BKRouter.navigate('shelf');
                }
            }
        },

        /** 长按/右键：显示操作菜单 */
        _showItemActions: function (item) {
            var self = this;
            var html = '<div class="bk-dialog" style="width:min(280px,calc(100vw - 40px))">';
            html += '<div class="bk-dialog-title">' + _escHtml(item.source) + '</div>';
            html += '<div class="bk-dialog-body" style="padding:8px 0">';

            // 跳转原文
            html += '<button class="bk-ns-action-btn" data-action="goto"><span class="bk-row-icon">📍</span><span class="bk-row-label">跳转原文</span></button>';

            // 编辑笔记（书签和书架类型可直接编辑，划线类型需跳转页面）
            if (item.type === 'bookmark' || item.type === 'shelf') {
                html += '<button class="bk-ns-action-btn" data-action="edit"><span class="bk-row-icon">✏️</span><span class="bk-row-label">编辑笔记</span></button>';
            }

            // 删除笔记
            html += '<button class="bk-ns-action-btn bk-ns-action-danger" data-action="delete"><span class="bk-row-icon">🗑</span><span class="bk-row-label">删除笔记</span></button>';

            html += '</div>';
            html += '<div class="bk-dialog-actions"><button class="bk-dialog-cancel" data-action="close">取消</button></div>';
            html += '</div>';

            var dlg = win.BK.openDialog({ id: 'bk-note-action', html: html });

            var btns = dlg.querySelectorAll('[data-action]');
            for (var i = 0; i < btns.length; i++) {
                (function (btn) {
                    btn.addEventListener('click', function () {
                        var act = btn.getAttribute('data-action');
                        if (act === 'close') {
                            if (win.BK && win.BK.closeDialog) win.BK.closeDialog(dlg);
                        } else if (act === 'goto') {
                            if (win.BK && win.BK.closeDialog) win.BK.closeDialog(dlg);
                            self._onItemTap(item);
                        } else if (act === 'edit') {
                            if (win.BK && win.BK.closeDialog) win.BK.closeDialog(dlg);
                            if (item.type === 'shelf') {
                                self._editShelfNote(item);
                            } else {
                                self._editBookmarkNote(item);
                            }
                        } else if (act === 'delete') {
                            self._deleteItemNote(item, dlg);
                        }
                    });
                })(btns[i]);
            }
        },

        /** 编辑书签笔记 */
        _editBookmarkNote: function (item) {
            var self = this;
            var html = '<div class="bk-dialog" style="width:min(360px,calc(100vw - 40px))">';
            html += '<div class="bk-dialog-title">编辑笔记</div>';
            html += '<div class="bk-dialog-body" style="padding:12px 16px">';
            html += '<textarea id="bkNsEditNote" class="bk-ns-edit-textarea" rows="4" placeholder="输入笔记...">' + _escHtml(item.text) + '</textarea>';
            html += '</div>';
            html += '<div class="bk-dialog-actions">';
            html += '<button class="bk-dialog-cancel" data-action="cancel">取消</button>';
            html += '<button class="bk-dialog-confirm" data-action="save">保存</button>';
            html += '</div></div>';

            var dlg = win.BK.openDialog({ id: 'bk-note-edit', html: html });
            var textarea = dlg.querySelector('#bkNsEditNote');
            if (textarea) {
                setTimeout(function () { textarea.focus(); }, 100);
            }

            var btns = dlg.querySelectorAll('[data-action]');
            for (var i = 0; i < btns.length; i++) {
                (function (btn) {
                    btn.addEventListener('click', function () {
                        var act = btn.getAttribute('data-action');
                        if (act === 'cancel') {
                            if (win.BK && win.BK.closeDialog) win.BK.closeDialog(dlg);
                        } else if (act === 'save') {
                            var newText = textarea ? textarea.value.trim() : '';
                            if (win.BKBookmark && win.BKBookmark.updateNote) {
                                win.BKBookmark.updateNote(item.id, newText).then(function () {
                                    // 更新本地数据
                                    for (var j = 0; j < self._notes.length; j++) {
                                        if (self._notes[j].id === item.id && self._notes[j].type === 'bookmark') {
                                            if (!newText) {
                                                self._notes.splice(j, 1);
                                            } else {
                                                self._notes[j].text = newText;
                                            }
                                            break;
                                        }
                                    }
                                    self._filtered = self._filtered.filter(function (n) {
                                        return newText ? true : !(n.id === item.id && n.type === 'bookmark');
                                    });

                                    self._doFilter();
                                    if (self._dlg) self._updateList(self._dlg);
                                    if (win.BK && win.BK.closeDialog) win.BK.closeDialog(dlg);
                                });
                            }
                        }
                    });
                })(btns[i]);
            }
        },

        /** 删除笔记 */
        _deleteItemNote: function (item, actionDlg) {
            if (!win.confirm('确定删除此笔记？')) return;
            var self = this;

            if (item.type === 'bookmark') {
                /* 删除书签笔记时，同时删除书签本体（避免残留空书签） */
                if (win.BKBookmark && win.BKBookmark.remove) {
                    win.BKBookmark.remove(item.id).then(function () {
                        self._removeFromList(item.id, 'bookmark');
                        if (win.BK && win.BK.closeDialog) win.BK.closeDialog(actionDlg);
                    });
                }
            } else if (item.type === 'shelf') {
                /* 删除书架笔记：清空 note 字段 */
                var shelfBookId = item.bookId || '';
                if (shelfBookId && win.BKShelf && win.BKShelf.removeNote) {
                    win.BKShelf.removeNote(shelfBookId).then(function () {
                        self._removeFromList(item.id, 'shelf');
                        if (win.BK && win.BK.closeDialog) win.BK.closeDialog(actionDlg);
                    });
                }
            } else if (item.type === 'highlight') {
                if (win.BKStorage && win.BKStorage.getPage && win.BKStorage.setPage) {
                    win.BKStorage.getPage(item.pageKey).then(function (arr) {
                        for (var i = 0; i < arr.length; i++) {
                            if (arr[i].id === item.id) {
                                arr[i].note = '';
                                if (!arr[i].color && !arr[i].underline) {
                                    arr.splice(i, 1);
                                }
                                break;
                            }
                        }
                        return win.BKStorage.setPage(item.pageKey, arr);
                    }).then(function () {
                        // 仅当划线被整条 splice 时才标记 highlightRemoved
                        var _hlRemoved = false;
                        for (var _ri = 0; _ri < arr.length; _ri++) {
                            if (arr[_ri].id === item.id) {
                                _hlRemoved = !arr[_ri].color && !arr[_ri].underline;
                                break;
                            }
                        }
                        self._removeFromList(item.id, 'highlight', _hlRemoved);
                        if (win.BK && win.BK.closeDialog) win.BK.closeDialog(actionDlg);
                    });
                }
            }
        },

        /** 从本地列表移除 */
        _removeFromList: function (id, type, highlightRemoved) {
            this._notes = this._notes.filter(function (n) { return !(n.id === id && n.type === type); });
            this._filtered = this._filtered.filter(function (n) { return !(n.id === id && n.type === type); });
            // 仅在整条划线被完全移除时才递减计数（含笔记但无标记时不递减）
            if (highlightRemoved && this._totalHighlights > 0 && type === 'highlight') {
                this._totalHighlights--;
            }
            if (this._dlg) this._updateList(this._dlg);
        },

        // ─── 导出 ─────────────────────────────────────────────────────

        _showExportMenu: function () {
            var self = this;
            var notes = this._filtered;

            var html = '<div class="bk-dialog" style="width:min(300px,calc(100vw - 40px))">' +
                '<div class="bk-dialog-title">导出笔记</div>' +
                '<div class="bk-dialog-body" style="padding:12px 16px">' +
                '<button class="bk-ns-export-btn" data-format="txt"><span class="bk-row-icon">📄</span><span class="bk-row-label">导出为 TXT</span></button>' +
                '<button class="bk-ns-export-btn" data-format="md"><span class="bk-row-icon">📑</span><span class="bk-row-label">导出为 Markdown</span></button>' +
                '</div>' +
                '<div class="bk-dialog-actions"><button class="bk-dialog-cancel" data-action="close">取消</button></div>' +
                '</div>';

            var dlg = win.BK.openDialog({
                id: 'bk-note-export',
                html: html
            });

            var btns = dlg.querySelectorAll('[data-format]');
            for (var i = 0; i < btns.length; i++) {
                (function (btn) {
                    btn.addEventListener('click', function () {
                        var fmt = btn.getAttribute('data-format');
                        self._doExport(fmt, notes);
                        if (win.BK && win.BK.closeDialog) win.BK.closeDialog(dlg);
                    });
                })(btns[i]);
            }

            var closeBtn = dlg.querySelector('[data-action="close"]');
            if (closeBtn) {
                closeBtn.addEventListener('click', function () {
                    if (win.BK && win.BK.closeDialog) win.BK.closeDialog(dlg);
                });
            }
        },

        /** 编辑书架笔记 */
        _editShelfNote: function (item) {
            var self = this;
            var html = '<div class="bk-dialog" style="width:min(360px,calc(100vw - 40px))">';
            html += '<div class="bk-dialog-title">编辑书架笔记</div>';
            html += '<div class="bk-dialog-body" style="padding:12px 16px">';
            html += '<div style="font-size:0.8125em;color:var(--text-secondary);margin-bottom:10px">《' + _escHtml(item.source) + '》</div>';
            html += '<textarea id="bkNsEditNote" class="bk-ns-edit-textarea" rows="4" placeholder="输入读书笔记…">' + _escHtml(item.text) + '</textarea>';
            html += '</div>';
            html += '<div class="bk-dialog-actions">';
            html += '<button class="bk-dialog-cancel" data-action="cancel">取消</button>';
            html += '<button class="bk-dialog-confirm" data-action="save">保存</button>';
            html += '</div></div>';

            var dlg = win.BK.openDialog({ id: 'bk-note-edit-shelf', html: html });
            var textarea = dlg.querySelector('#bkNsEditNote');
            if (textarea) {
                setTimeout(function () { textarea.focus(); }, 100);
            }

            var btns = dlg.querySelectorAll('[data-action]');
            for (var i = 0; i < btns.length; i++) {
                (function (btn) {
                    btn.addEventListener('click', function () {
                        var act = btn.getAttribute('data-action');
                        if (act === 'cancel') {
                            if (win.BK && win.BK.closeDialog) win.BK.closeDialog(dlg);
                        } else if (act === 'save') {
                            var newText = textarea ? textarea.value.trim() : '';
                            var shelfBookId = item.bookId || '';
                            if (shelfBookId && win.BKShelf && win.BKShelf.updateNote) {
                                win.BKShelf.updateNote(shelfBookId, newText || null).then(function () {
                                    /* 更新本地数据 */
                                    for (var j = 0; j < self._notes.length; j++) {
                                        if (self._notes[j].id === item.id && self._notes[j].type === 'shelf') {
                                            if (!newText) {
                                                self._notes.splice(j, 1);
                                            } else {
                                                self._notes[j].text = newText;
                                            }
                                            break;
                                        }
                                    }
                                    self._filtered = self._filtered.filter(function (n) {
                                        return newText ? true : !(n.id === item.id && n.type === 'shelf');
                                    });
                                    self._doFilter();
                                    if (self._dlg) self._updateList(self._dlg);
                                    if (win.BK && win.BK.closeDialog) win.BK.closeDialog(dlg);
                                });
                            }
                        }
                    });
                })(btns[i]);
            }
        },

        _doExport: function (format, notes) {
            var content = '';
            var filename = '我的笔记.' + (format === 'md' ? 'md' : 'txt');

            if (format === 'md') {
                content = '# 我的笔记\n\n';
                content += '> 共 ' + notes.length + ' 条笔记，导出于 ' + _formatDate(Date.now()) + '\n\n---\n\n';

                var groups = _groupByBook(notes);
                var keys = Object.keys(groups);
                for (var g = 0; g < keys.length; g++) {
                    content += '## ' + keys[g] + '\n\n';
                    var items = groups[keys[g]];
                    for (var i = 0; i < items.length; i++) {
                        var item = items[i];
                        var typeLabel = item.type === 'bookmark' ? '📑' : item.type === 'shelf' ? '📚' : '✏️';
                        if (item.highlightText) {
                            content += typeLabel + ' > ' + item.highlightText + '\n\n';
                        }
                        content += item.text + '\n\n';
                        if (item.timestamp) {
                            content += '*' + _formatDate(item.timestamp) + '*\n\n';
                        }
                        content += '---\n\n';
                    }
                }
            } else {
                content = '我的笔记\n';
                content += '共 ' + notes.length + ' 条笔记，导出于 ' + _formatDate(Date.now()) + '\n';
                content += '========================================\n\n';

                var groups2 = _groupByBook(notes);
                var keys2 = Object.keys(groups2);
                for (var g2 = 0; g2 < keys2.length; g2++) {
                    content += '【' + keys2[g2] + '】\n\n';
                    var items2 = groups2[keys2[g2]];
                    for (var j = 0; j < items2.length; j++) {
                        var item2 = items2[j];
                        var typeL2 = item2.type === 'bookmark' ? '[书签]' : item2.type === 'shelf' ? '[书架]' : '[划线]';
                        if (item2.highlightText) {
                            content += typeL2 + ' 「' + item2.highlightText + '」\n';
                        } else {
                            content += typeL2 + ' ' + (item2.source || '') + '\n';
                        }
                        content += '  ' + item2.text + '\n';
                        if (item2.timestamp) {
                            content += '  ' + _formatDate(item2.timestamp) + '\n';
                        }
                        content += '\n';
                    }
                    content += '----------------------------------------\n\n';
                }
            }

            // 触发下载
            var blob = new Blob([content], { type: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 100);
        }
    };

    // ─── 工具函数 ─────────────────────────────────────────────────────

    function _extractBookId(pathKey) {
        var parts = (pathKey || '').split('/').filter(Boolean);
        return parts.length >= 2 ? parts[0] : '';
    }

    function _extractBookName(pathKey) {
        var books = win.__bkBooks || [];
        var parts = (pathKey || '').split('/').filter(Boolean);
        var bookId = parts.length >= 2 ? parts[0] : '';
        for (var i = 0; i < books.length; i++) {
            if (books[i] && (books[i].id === bookId || books[i].bookId === bookId)) {
                return books[i].title || books[i].name || bookId;
            }
        }
        return bookId || pathKey || '未知来源';
    }

    /** 根据 bookId 查找书名（用于书架笔记） */
    function _findBookNameById(bookId) {
        var books = win.__bkBooks || [];
        for (var i = 0; i < books.length; i++) {
            if (books[i] && (books[i].id === bookId || books[i].bookId === bookId)) {
                return books[i].title || books[i].name || bookId;
            }
        }
        return bookId || '';
    }

    function _groupByBook(notes) {
        var map = {};
        for (var i = 0; i < notes.length; i++) {
            var n = notes[i];
            var key = n.source || '未知来源';
            if (!map[key]) map[key] = [];
            map[key].push(n);
        }
        return map;
    }

    function _escHtml(s) {
        if (!s) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function _escAttr(s) {
        return _escHtml(s);
    }

    function _relativeTime(ts) {
        if (!ts) return '';
        var diff = Date.now() - ts;
        var sec = Math.floor(diff / 1000);
        if (sec < 60) return '刚刚';
        var min = Math.floor(sec / 60);
        if (min < 60) return min + '分钟前';
        var hr = Math.floor(min / 60);
        if (hr < 24) return hr + '小时前';
        var day = Math.floor(hr / 24);
        if (day < 30) return day + '天前';
        return _formatDate(ts);
    }

    function _formatDate(ts) {
        if (!ts) return '';
        var d = new Date(ts);
        var y = d.getFullYear();
        var m = ('0' + (d.getMonth() + 1)).slice(-2);
        var day = ('0' + d.getDate()).slice(-2);
        return y + '-' + m + '-' + day;
    }

    // ─── 条目交互绑定 ─────────────────────────────────────────────────

    /** 为单个笔记条目绑定点击跳转 + 长按/右键操作菜单 */
    function _bindItemInteraction(el, summaryObj) {
        var _lpTimer = null;
        var _lpFired = false;
        var _touchFired = false;

        function _getItemData() {
            var type = el.getAttribute('data-type');
            var id = el.getAttribute('data-id');
            var notes = summaryObj._notes;
            for (var i = 0; i < notes.length; i++) {
                if (notes[i].id === id && notes[i].type === type) return notes[i];
            }
            return null;
        }

        // 触摸长按检测
        el.addEventListener('touchstart', function () {
            _lpFired = false;
            _lpTimer = setTimeout(function () {
                _lpFired = true;
                _lpTimer = null;
                var item = _getItemData();
                if (item) summaryObj._showItemActions(item);
            }, 500);
        }, {passive: true});

        el.addEventListener('touchmove', function () {
            clearTimeout(_lpTimer);
            _lpTimer = null;
        }, {passive: true});

        el.addEventListener('touchend', function () {
            clearTimeout(_lpTimer);
            _lpTimer = null;
            if (!_lpFired) {
                _touchFired = true;          // 防止后续 click 重复触发
                var item = _getItemData();
                if (item) summaryObj._onItemTap(item);
            }
        }, {passive: true});

        // 桌面端：点击跳转，右键操作菜单
        el.addEventListener('click', function (e) {
            if (_lpFired) { _lpFired = false; return; }
            if (_touchFired) { _touchFired = false; return; }  // 触屏已处理
            var item = _getItemData();
            if (item) summaryObj._onItemTap(item);
        });

        el.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            clearTimeout(_lpTimer);
            _lpTimer = null;
            _lpFired = true;
            var item = _getItemData();
            if (item) summaryObj._showItemActions(item);
        });
    }

    // 挂载到全局
    win.BKNoteSummary = BKNoteSummary;

})(window);
