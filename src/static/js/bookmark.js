/**
 * 书签功能模块
 * 支持添加/删除/查看书签，跳转到书签位置，列表弹框展示
 *
 * 数据模型：{id, path, scrollY, title, bookId, chapterNum, note, timestamp}
 * 存储后端：localForage (IndexedDB)，单键 bk_bookmarks → Array
 */
(function (win) {
    'use strict';

    win.BK = win.BK || {};

    // ─── 常量 ─────────────────────────────────────────────────────────────
    var STORAGE_KEY = 'bk_bookmarks';
    var MAX_BOOKMARKS = 100;

    // ─── 存储层 ─────────────────────────────────────────────────────────────
    var _store = null;

    function _initStore() {
        if (_store) return;
        if (typeof localforage === 'undefined') {
            console.warn('[书签] localforage 未加载，降级到 localStorage');
            _store = {
                getItem: function (key) {
                    return Promise.resolve().then(function () {
                        try {
                            return JSON.parse(localStorage.getItem(key) || 'null');
                        } catch (e) { return null; }
                    });
                },
                setItem: function (key, val) {
                    return Promise.resolve().then(function () {
                        try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
                    });
                }
            };
            return;
        }
        _store = localforage.createInstance({
            driver: [localforage.INDEXEDDB, localforage.LOCALSTORAGE],
            name: 'books',
            storeName: 'bookmarks'
        });
    }

    function _load() {
        _initStore();
        var storePromise = _store.getItem(STORAGE_KEY).then(function (arr) {
            return Array.isArray(arr) ? arr : [];
        }).catch(function (e) {
            console.warn('[书签] 读取失败:', e);
            return [];
        });
        var timeoutPromise = new Promise(function (resolve) {
            setTimeout(function () {
                console.warn('[书签] 读取超时(3s)，降级为空列表');
                resolve([]);
            }, 3000);
        });
        return Promise.race([storePromise, timeoutPromise]);
    }

    function _save(arr) {
        _initStore();
        return _store.setItem(STORAGE_KEY, arr).catch(function (e) {
            console.error('[书签] 保存失败:', e);
        });
    }

    // ─── 工具函数 ──────────────────────────────────────────────────────────
    function _genId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
    }

    function _relativeTime(ts) {
        var now = Date.now();
        var diff = now - ts;
        if (diff < 60000) return '刚刚';
        var minutes = Math.floor(diff / 60000);
        if (minutes < 60) return minutes + '分钟前';
        var hours = Math.floor(diff / 3600000);
        if (hours < 24) return hours + '小时前';
        var days = Math.floor(diff / 86400000);
        if (days < 30) return days + '天前';
        var months = Math.floor(days / 30);
        return months + '月前';
    }

    // ─── Toast 通知 ─────────────────────────────────────────────────────────
    var _toastTimer = null;
    var _toastEl = null;

    function _injectToastStyle() {
        if (document.getElementById('bk-bm-toast-style')) return;
        var style = document.createElement('style');
        style.id = 'bk-bm-toast-style';
        style.textContent = [
            '.bk-bm-toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(20px);',
            'background:rgba(50,50,50,.92);color:#fff;padding:10px 18px;border-radius:22px;',
            'font-size:0.875em;z-index:99999;display:flex;align-items:center;gap:12px;',
            'opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;',
            'box-shadow:0 4px 16px rgba(0,0,0,.18)}',
            '.bk-bm-toast.show{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto}',
            '.bk-bm-toast-text{white-space:nowrap}',
            '.bk-bm-toast-undo{color:#90caf9;cursor:pointer;font-weight:500;white-space:nowrap}'
        ].join('\n');
        document.head.appendChild(style);
    }

    function _showToast(text, undoFn) {
        _injectToastStyle();
        if (_toastEl) {
            _toastEl.parentNode && _toastEl.parentNode.removeChild(_toastEl);
            _toastEl = null;
        }
        if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }

        var el = document.createElement('div');
        el.className = 'bk-bm-toast';
        var html = '<span class="bk-bm-toast-text">' + text + '</span>';
        if (undoFn) {
            html += '<span class="bk-bm-toast-undo">撤销</span>';
        }
        el.innerHTML = html;
        document.body.appendChild(el);
        _toastEl = el;

        if (undoFn) {
            var undoBtn = el.querySelector('.bk-bm-toast-undo');
            undoBtn.addEventListener('click', function () {
                _hideToast();
                undoFn();
            });
        }

        void el.offsetWidth;
        el.classList.add('show');

        _toastTimer = setTimeout(function () {
            _hideToast();
        }, 2500);
    }

    function _hideToast() {
        if (!_toastEl) return;
        _toastEl.classList.remove('show');
        var ref = _toastEl;
        setTimeout(function () {
            ref.parentNode && ref.parentNode.removeChild(ref);
        }, 300);
        _toastEl = null;
        if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
    }

    // ─── 核心方法 ──────────────────────────────────────────────────────────
    var BKBookmark = {

        /**
         * 添加书签
         * @param {Object} opts - {path, scrollY, title, bookId, chapterNum, note}
         * @returns {Promise}
         */
        add: function (opts) {
            opts = opts || {};
            var path = opts.path || '';
            var scrollY = opts.scrollY || 0;
            var title = opts.title || '';
            var bookId = opts.bookId || '';
            var chapterNum = opts.chapterNum || 0;
            var note = opts.note || '';

            return _load().then(function (arr) {
                var existIdx = -1;
                for (var i = 0; i < arr.length; i++) {
                    if (arr[i].path === path) {
                        existIdx = i;
                        break;
                    }
                }

                var bookmark;
                var isUpdate = false;
                if (existIdx >= 0) {
                    bookmark = arr[existIdx];
                    bookmark.scrollY = scrollY;
                    bookmark.timestamp = Date.now();
                    if (note) bookmark.note = note;
                    if (title) bookmark.title = title;
                    isUpdate = true;
                    arr.splice(existIdx, 1);
                    arr.unshift(bookmark);
                } else {
                    bookmark = {
                        id: _genId(),
                        path: path,
                        scrollY: scrollY,
                        title: title,
                        bookId: bookId,
                        chapterNum: chapterNum,
                        note: note,
                        timestamp: Date.now()
                    };
                    arr.unshift(bookmark);
                }

                if (arr.length > MAX_BOOKMARKS) {
                    arr = arr.slice(0, MAX_BOOKMARKS);
                }

                return _save(arr).then(function () {
                    var addedId = bookmark.id;
                    _showToast(isUpdate ? '✓ 已更新书签' : '✓ 已添加书签', function () {
                        BKBookmark.remove(addedId);
                    });
                    return bookmark;
                });
            });
        },

        /**
         * 添加当前页书签
         * @param {Object} titleInfo - {bookTitle, chapterNum, chapterTitle}
         * @returns {Promise}
         */
        addCurrent: function (titleInfo) {
            titleInfo = titleInfo || {};
            var path = win.__bkCurrentPath || '';
            var scrollY = win.scrollY || 0;
            var parts = path.split('/').filter(Boolean);
            var bookId = parts[0] || '';
            var chapterNum = parseInt(parts[1], 10) || 0;

            var titleParts = [];
            if (titleInfo.bookTitle) {
                titleParts.push(titleInfo.bookTitle);
            } else if (bookId) {
                titleParts.push(bookId);
            }
            if (titleInfo.chapterTitle) {
                titleParts.push(titleInfo.chapterTitle);
            } else if (chapterNum) {
                titleParts.push('第' + chapterNum + '章');
            }
            var title = titleParts.join(' · ');

            return BKBookmark.add({
                path: path,
                scrollY: scrollY,
                title: title,
                bookId: bookId,
                chapterNum: chapterNum,
                note: ''
            });
        },

        /**
         * 删除书签
         * @param {String} id
         * @returns {Promise}
         */
        remove: function (id) {
            return _load().then(function (arr) {
                var filtered = [];
                for (var i = 0; i < arr.length; i++) {
                    if (arr[i].id !== id) filtered.push(arr[i]);
                }
                return _save(filtered);
            });
        },

        /**
         * 获取全部书签（按时间倒序）
         * @returns {Promise<Array>}
         */
        getAll: function () {
            return _load().then(function (arr) {
                arr.sort(function (a, b) { return b.timestamp - a.timestamp; });
                return arr;
            });
        },

        /**
         * 跳转到书签位置
         * @param {Object} bookmark
         */
        goto: function (bookmark) {
            if (!bookmark || !bookmark.path) return;
            if (win.BKRouter) {
                win.BKRouter.navigate(bookmark.path);
            }
            var targetY = bookmark.scrollY || 0;
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    win.scrollTo(0, targetY);
                });
            });
        },

        /**
         * 显示书签列表弹框
         */
        showList: function () {
            BKBookmark.getAll().then(function (arr) {
                var curPath = win.__bkCurrentPath || '';
                var curParts = curPath.split('/').filter(Boolean);
                var isContentPage = curParts.length >= 2;

                var bodyHtml = '';
                if (!arr.length) {
                    bodyHtml = '<div class="bk-bm-empty">' +
                        '<div class="bk-bm-empty-icon">📑</div>' +
                        '<div class="bk-bm-empty-text">暂无书签</div>' +
                        '<div class="bk-bm-empty-hint">在阅读页点击"添加当前页"按钮</div>' +
                        '</div>';
                } else {
                    for (var i = 0; i < arr.length; i++) {
                        var bm = arr[i];
                        var displayTitle = bm.title || bm.path || '未命名';
                        var meta = _relativeTime(bm.timestamp);
                        if (bm.note) meta += ' · ' + bm.note;
                        bodyHtml += '<div class="bk-bm-item" data-id="' + bm.id + '">' +
                            '<div class="bk-bm-item-main">' +
                            '<div class="bk-bm-item-title">' + _escHtml(displayTitle) + '</div>' +
                            '<div class="bk-bm-item-meta">' + _escHtml(meta) + '</div>' +
                            '</div>' +
                            '<button class="bk-bm-item-del" aria-label="删除">✕</button>' +
                            '</div>';
                    }
                }

                var addBtnHtml = isContentPage
                    ? '<button class="bk-dialog-confirm" data-action="add" style="color:var(--brand);font-weight:600">添加当前页</button>'
                    : '';
                var clearBtnHtml = arr.length
                    ? '<button class="bk-dialog-confirm" data-action="clear" style="color:var(--danger-text)">清空全部</button>'
                    : '';
                var footerHtml = '<div class="bk-dialog-actions">' +
                    '<button class="bk-dialog-cancel" data-action="close"' + (!addBtnHtml && !clearBtnHtml ? ' style="flex:1;border-right:none"' : '') + '>关闭</button>' +
                    addBtnHtml + clearBtnHtml +
                    '</div>';

                var dialogHtml = '<div class="bk-dialog" style="width:min(360px,calc(100vw - 40px))">' +
                    '<div class="bk-dialog-title">📑 我的书签</div>' +
                    '<div class="bk-bm-list-body">' + bodyHtml + '</div>' +
                    footerHtml +
                    '</div>';

                var dlg = win.BK.openDialog({
                    id: 'bk-bookmark-list',
                    html: dialogHtml
                });

                if (!dlg) {
                    console.warn('[书签] openDialog 返回 null，弹框可能已存在');
                    return;
                }

                var dialogEl = document.getElementById('bk-bookmark-list');
                if (!dialogEl) return;

                dialogEl.addEventListener('click', function (e) {
                    var t = e.target;

                    if (t.getAttribute('data-action') === 'close') {
                        dlg.close();
                        return;
                    }

                    if (t.getAttribute('data-action') === 'add') {
                        var p = curParts;
                        // 从缓存的书籍数据中获取标题
                        var bookTitle = '';
                        if (win.__bkBooks) {
                            for (var bi = 0; bi < win.__bkBooks.length; bi++) {
                                if (win.__bkBooks[bi].id === p[0]) {
                                    bookTitle = win.__bkBooks[bi].title || '';
                                    break;
                                }
                            }
                        }
                        dlg.close();
                        BKBookmark.addCurrent({
                            bookTitle: bookTitle,
                            chapterNum: parseInt(p[1], 10) || p[1]
                        });
                        return;
                    }

                    if (t.getAttribute('data-action') === 'clear') {
                        if (!confirm('确定清空全部书签？')) return;
                        _save([]).then(function () {
                            var body = dialogEl.querySelector('.bk-bm-list-body');
                            if (body) {
                                body.innerHTML = '<div class="bk-bm-empty">' +
                                    '<div class="bk-bm-empty-icon">📑</div>' +
                                    '<div class="bk-bm-empty-text">暂无书签</div>' +
                                    '<div class="bk-bm-empty-hint">在阅读页点击"添加当前页"按钮</div>' +
                                    '</div>';
                            }
                            var clearBtn = dialogEl.querySelector('[data-action="clear"]');
                            if (clearBtn) clearBtn.style.display = 'none';
                            var cancelBtn = dialogEl.querySelector('[data-action="close"]');
                            if (cancelBtn) cancelBtn.style.borderRight = 'none';
                        });
                        return;
                    }

                    var delBtn = t.closest ? t.closest('.bk-bm-item-del') : null;
                    if (!delBtn && t.classList && t.classList.contains('bk-bm-item-del')) delBtn = t;
                    if (delBtn) {
                        var itemDiv = delBtn.parentNode;
                        var bmId = itemDiv.getAttribute('data-id');
                        itemDiv.style.opacity = '0';
                        itemDiv.style.transform = 'translateX(30px)';
                        itemDiv.style.transition = 'opacity .2s,transform .2s';
                        setTimeout(function () {
                            if (itemDiv.parentNode) itemDiv.parentNode.removeChild(itemDiv);
                            var remaining = dialogEl.querySelectorAll('.bk-bm-item');
                            if (!remaining.length) {
                                var body = dialogEl.querySelector('.bk-bm-list-body');
                                if (body) {
                                    body.innerHTML = '<div class="bk-bm-empty">' +
                                        '<div class="bk-bm-empty-icon">📑</div>' +
                                        '<div class="bk-bm-empty-text">暂无书签</div>' +
                                        '<div class="bk-bm-empty-hint">在阅读页点击"添加当前页"按钮</div>' +
                                        '</div>';
                                }
                                var clearBtn2 = dialogEl.querySelector('[data-action="clear"]');
                                if (clearBtn2) clearBtn2.style.display = 'none';
                                var cancelBtn2 = dialogEl.querySelector('[data-action="close"]');
                                if (cancelBtn2) cancelBtn2.style.borderRight = 'none';
                            }
                        }, 200);
                        BKBookmark.remove(bmId);
                        return;
                    }

                    var itemMain = t.closest ? t.closest('.bk-bm-item-main') : null;
                    if (!itemMain && t.classList && t.classList.contains('bk-bm-item-main')) itemMain = t;
                    if (!itemMain && t.parentNode && t.parentNode.classList && t.parentNode.classList.contains('bk-bm-item-main')) itemMain = t.parentNode;
                    if (itemMain) {
                        var parentItem = itemMain.parentNode;
                        var targetId = parentItem.getAttribute('data-id');
                        var target = null;
                        for (var k = 0; k < arr.length; k++) {
                            if (arr[k].id === targetId) { target = arr[k]; break; }
                        }
                        var mask = document.getElementById('bk-bookmark-list');
                        if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
                        if (win.BK && win.BK.backStack && win.BK.backStack.discard) win.BK.backStack.discard();
                        if (target && target.path) {
                            var scrollKey = 'bk_scroll:' + target.path;
                            try { localStorage.setItem(scrollKey, String(target.scrollY || 0)); } catch(e) {}
                            if (win.BKRouter && win.BKRouter.navigateReplace) {
                                win.BKRouter.navigateReplace(target.path);
                            } else if (win.BKRouter) {
                                win.BKRouter.navigate(target.path);
                            }
                        }
                    }
                });
            });
        }
    };

    // ─── HTML 转义 ─────────────────────────────────────────────────────────
    function _escHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    // ─── 暴露 ──────────────────────────────────────────────────────────────
    win.BKBookmark = BKBookmark;

}(window));
