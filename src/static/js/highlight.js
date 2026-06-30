/**
 * 划线标记与笔记功能
 * 支持文本选中后划线、添加笔记、保存到本地存储、恢复划线
 *
 * 数据模型：{id, start, end, text, color, underline, note, timestamp}
 * underline/note 字段为新增，旧数据读取时自动补默认值。
 * 存储后端：localForage (IndexedDB)，每页独立一个键
 */
(function () {
    'use strict';

    // ─── IndexedDB 存储适配层 ─────────────────────────────────────────────
    var BKStorage = (function () {
        var _store = null;
        var MIGRATED_KEY = 'bk_hl_migrated';
        var MIGRATED_VER = '1';

        function init() {
            if (typeof localforage === 'undefined') {
                console.warn('[划线] localforage 未加载，降级到 localStorage');
                return _initLegacy();
            }
            _store = localforage.createInstance({
                driver:      [localforage.INDEXEDDB, localforage.LOCALSTORAGE],
                name:        'books',
                storeName:   'highlights',
                description: '书报划线笔记'
            });
            return Promise.resolve();
        }

        function _normalizePath(path) {
            return path
                .replace(/^\/android_asset\/public/, '')
                .replace(/^\/public(?=\/)/, '')
                .replace(/^\/index\.html$/, '/');
        }

        // localForage 不可用时的 localStorage Promise 包装（接口一致）
        function _initLegacy() {
            _store = {
                getItem: function (key) {
                    return Promise.resolve().then(function () {
                        try {
                            var all = JSON.parse(localStorage.getItem('bk_highlights') || '{}');
                            return all[key] || null;
                        } catch (e) { return null; }
                    });
                },
                setItem: function (key, val) {
                    return Promise.resolve().then(function () {
                        try {
                            var all = JSON.parse(localStorage.getItem('bk_highlights') || '{}');
                            all[key] = val;
                            localStorage.setItem('bk_highlights', JSON.stringify(all));
                        } catch (e) {}
                    });
                },
                clear: function () {
                    return Promise.resolve().then(function () {
                        try { localStorage.removeItem('bk_highlights'); } catch (e) {}
                    });
                }
            };
            return Promise.resolve();
        }

        function getPage(pathname) {
            return _store.getItem(pathname).then(function (arr) {
                return Array.isArray(arr) ? arr : [];
            }).catch(function () { return []; });
        }

        function setPage(pathname, arr) {
            return _store.setItem(pathname, arr).catch(function (e) {
                console.error('[划线] 保存失败:', e);
            });
        }

        function clear() {
            return _store ? _store.clear().catch(function (e) {
                console.error('[划线] 清除失败:', e);
            }) : Promise.resolve();
        }

        return { init: init, getPage: getPage, setPage: setPage, clear: clear };
    })();

    var BKHighlight = {

        // ─── 配置 ─────────────────────────────────────────────────
        config: {
            storageKey: 'bk_highlights',
            colors: {
                yellow: '#fff59d',
                green:  '#a5d6a7',
                blue:   '#90caf9',
                pink:   '#f48fb1'
            },
            defaultColor: 'yellow'
        },

        highlights: [],

        // 操作状态
        _pendingRange:       null,
        _pendingHighlightId: null,
        _selectedColor:      'yellow',
        _selectedUnderline:  false,
        _pointerDown:        false,
        _restoreGen:         0,

        // ─── 初始化 ───────────────────────────────────────────────
        init: function () {
            this._selectedColor = this.config.defaultColor;
            this.createMenus();
            this.setupEventListeners();
            var self = this;
            BKStorage.init().then(function () { self.restoreHighlights(); });
        },

        // ─── 供外部在异步内容渲染后调用 ────────────────────────────
        redoHighlights: function () {
            this.clearAllMarks();
            this.restoreHighlights();
        },

        // ─── 存储键 ───────────────────────────────────────────────
        // SPA 模式下从 hash 推导 key: /{book-id}/{chapter}
        getPageKey: function () {
            var hash = window.location.hash.replace(/^#\/?/, '');
            if (hash) {
                var parts = hash.split('/').filter(Boolean);
                if (parts.length >= 2) {
                    return '/' + parts[0] + '/' + parts[1];
                }
                if (parts.length === 1) {
                    return '/' + parts[0];
                }
            }
            return window.location.pathname;
        },

        // ─── 从 IndexedDB 加载当前页划线（异步，返回 Promise）────────────
        loadHighlights: function () {
            var self = this;
            var key = this.getPageKey();

            var keyVariants = [
                key,
                '/android_asset/public' + key,
                '/public' + key,
                key.replace(/\.htm$/, '.html'),
                '/android_asset/public' + key.replace(/\.htm$/, '.html')
            ];

            function tryLocalStorageDirect(k) {
                try {
                    var all = JSON.parse(localStorage.getItem('bk_highlights') || '{}');
                    var variants = [k, '/android_asset/public' + k,
                                    k.replace(/\.htm$/, '.html'),
                                    '/android_asset/public' + k.replace(/\.htm$/, '.html')];
                    for (var i = 0; i < variants.length; i++) {
                        if (all[variants[i]] && all[variants[i]].length) {
                            return all[variants[i]];
                        }
                    }
                } catch (e) {}
                return null;
            }

            function tryVariants(index) {
                if (index >= keyVariants.length) return Promise.resolve(null);
                return BKStorage.getPage(keyVariants[index]).then(function (arr) {
                    if (arr && arr.length) {
                        if (keyVariants[index] !== key) {
                            BKStorage.setPage(key, arr).catch(function () {});
                        }
                        return arr;
                    }
                    return tryVariants(index + 1);
                });
            }

            return tryVariants(0).then(function (arr) {
                if (!arr || !arr.length) {
                    var lsArr = tryLocalStorageDirect(key);
                    if (lsArr) {
                        BKStorage.setPage(key, lsArr).catch(function () {});
                        arr = lsArr;
                    }
                }
                self.highlights = (arr || []).map(function (h) {
                    if (h.underline === undefined) h.underline = false;
                    if (h.note      === undefined) h.note      = '';
                    return h;
                });
            }).catch(function (e) {
                console.error('[划线] 加载失败:', e);
                self.highlights = [];
            });
        },

        // ─── 保存当前页划线到 IndexedDB ────────────────────────────
        saveHighlights: function () {
            var native = this.highlights.filter(function (h) { return !h._paired; });
            return BKStorage.setPage(this.getPageKey(), native);
        },

        // ─── 文本节点遍历 ───────────────────────────────────────────
        getTextNodes: function (element) {
            var textNodes = [];
            var walker = document.createTreeWalker(
                element,
                NodeFilter.SHOW_TEXT,
                null
            );
            var node;
            while ((node = walker.nextNode())) textNodes.push(node);
            return textNodes;
        },

        // ─── 选区 → 绝对字符偏移 ────────────────────────────────────
        getSelectionPosition: function (container, range) {
            var textNodes = this.getTextNodes(container);
            var charCount = 0, start = -1, end = -1;
            for (var i = 0; i < textNodes.length; i++) {
                var node = textNodes[i];
                var nodeLength = node.textContent.length;
                if (node === range.startContainer) start = charCount + range.startOffset;
                if (node === range.endContainer)   { end = charCount + range.endOffset; break; }
                charCount += nodeLength;
            }
            return (start >= 0 && end >= 0 && end > start) ? { start: start, end: end } : null;
        },

        // ─── 应用单个划线到 DOM ──────────────────────────────────────
        applyHighlight: function (highlight) {
            var container = document.querySelector('#app .content') || document.querySelector('.content');
            if (!container) return;
            if (document.querySelector('.bk-highlight[data-highlight-id="' + highlight.id + '"]')) return;
            var textNodes = this.getTextNodes(container);
            var charCount = 0;
            var self = this;

            // 多节点跨段时，先用字符偏移提取全文做整体校验
            if (highlight.text) {
                var fullText = '';
                for (var j = 0; j < textNodes.length; j++) {
                    var tn = textNodes[j];
                    var tnStart = charCount;
                    var tnEnd   = tnStart + tn.textContent.length;
                    if (tnEnd > highlight.start && tnStart < highlight.end) {
                        var s = Math.max(0, highlight.start - tnStart);
                        var e = Math.min(tn.textContent.length, highlight.end - tnStart);
                        fullText += tn.textContent.substring(s, e);
                    }
                    charCount += tn.textContent.length;
                    if (tnStart >= highlight.end) break;
                }
                charCount = 0;
                if (fullText !== highlight.text) {
                    var pageText = '';
                    for (var k = 0; k < textNodes.length; k++) pageText += textNodes[k].textContent;

                    var candidates = [];
                    var searchFrom = 0;
                    while (true) {
                        var pos = pageText.indexOf(highlight.text, searchFrom);
                        if (pos < 0) break;
                        candidates.push(pos);
                        searchFrom = pos + 1;
                    }
                    if (!candidates.length) {
                        console.warn('[划线] 文本已不存在，跳过恢复:', highlight.text.substring(0, 20));
                        return;
                    }

                    var bestPos = -1;
                    if (highlight.prefix !== undefined && highlight.suffix !== undefined) {
                        var bestScore = -1;
                        for (var ci = 0; ci < candidates.length; ci++) {
                            var cp = candidates[ci];
                            var ce = cp + highlight.text.length;
                            var actualPrefix = pageText.substring(Math.max(0, cp - 25), cp);
                            var actualSuffix = pageText.substring(ce, Math.min(pageText.length, ce + 25));
                            var score = self._overlapRight(highlight.prefix, actualPrefix) +
                                        self._overlapLeft(highlight.suffix, actualSuffix);
                            if (score > bestScore ||
                                (score === bestScore && Math.abs(cp - highlight.start) < Math.abs(bestPos - highlight.start))) {
                                bestScore = score;
                                bestPos = cp;
                            }
                        }
                    } else {
                        var bestDist = Infinity;
                        for (var di = 0; di < candidates.length; di++) {
                            var dist = Math.abs(candidates[di] - highlight.start);
                            if (dist < bestDist) { bestDist = dist; bestPos = candidates[di]; }
                        }
                    }

                    highlight.start = bestPos;
                    highlight.end   = bestPos + highlight.text.length;
                    var newCtx = self._extractContext(pageText, highlight.start, highlight.end);
                    highlight.prefix = newCtx.prefix;
                    highlight.suffix = newCtx.suffix;
                    var selfHeal = self;
                    setTimeout(function() { selfHeal.saveHighlights(); }, 0);
                    charCount = 0;
                }
            }

            for (var i = 0; i < textNodes.length; i++) {
                var node       = textNodes[i];
                var nodeLength = node.textContent.length;
                var nodeStart  = charCount;
                var nodeEnd    = charCount + nodeLength;

                if (nodeEnd > highlight.start && nodeStart < highlight.end) {
                    var startOffset = Math.max(0, highlight.start - nodeStart);
                    var endOffset   = Math.min(nodeLength, highlight.end - nodeStart);

                    var range = document.createRange();
                    range.setStart(node, startOffset);
                    range.setEnd(node, endOffset);

                    var mark = document.createElement('mark');
                    mark.className = 'bk-highlight';

                    if (highlight.color && highlight.color !== 'note' && self.config.colors[highlight.color]) {
                        mark.style.backgroundColor = self.config.colors[highlight.color];
                    } else {
                        mark.style.backgroundColor = 'transparent';
                    }

                    if (highlight.underline) {
                        mark.style.borderBottom    = '2px solid #e53935';
                        mark.style.paddingBottom   = '1px';
                    }
                    if (highlight.note) {
                        mark.style.textDecoration      = 'underline wavy #eb6c05 1px';
                        mark.style.textUnderlineOffset = '2px';
                    }

                    mark.dataset.highlightId = highlight.id;

                    try {
                        range.surroundContents(mark);
                        if (highlight.note && (nodeStart + endOffset >= highlight.end)) {
                            self._insertNoteIcon(mark, highlight.id);
                        }
                    } catch (e) {
                        console.warn('[划线] 无法应用划线:', e);
                    }
                }

                charCount += nodeLength;
            }
        },

        _insertNoteIcon: function (markEl, highlightId) {
            if (document.querySelector('.bk-note-icon[data-highlight-id="' + highlightId + '"]')) return;
            var next = markEl.nextSibling;
            if (next && next.classList && next.classList.contains('bk-note-icon')) return;
            var icon = document.createElement('span');
            icon.className = 'bk-note-icon';
            icon.textContent = '📝';
            icon.dataset.highlightId = highlightId;
            markEl.parentNode.insertBefore(icon, markEl.nextSibling);
        },

        // ─── TextQuoteSelector 辅助函数 ─────────────────────────────────
        _extractContext: function (pageText, start, end, win) {
            win = win || 25;
            return {
                prefix: pageText.substring(Math.max(0, start - win), start),
                suffix: pageText.substring(end, Math.min(pageText.length, end + win))
            };
        },

        _overlapRight: function (saved, actual) {
            var i = saved.length - 1, j = actual.length - 1, count = 0;
            while (i >= 0 && j >= 0 && saved[i] === actual[j]) { i--; j--; count++; }
            return count;
        },

        _overlapLeft: function (saved, actual) {
            var i = 0, count = 0;
            while (i < saved.length && i < actual.length && saved[i] === actual[i]) { i++; count++; }
            return count;
        },

        // ─── 恢复全部划线 ─────────────────────────────────────────────
        restoreHighlights: function () {
            var self = this;
            var gen = ++this._restoreGen;
            return this.loadHighlights().then(function () {
                if (self._restoreGen !== gen) return;
                var seen = {};
                self.highlights = self.highlights.filter(function (h) {
                    if (seen[h.id]) return false;
                    seen[h.id] = true;
                    return true;
                });
                self.highlights.forEach(function (h) { self.applyHighlight(h); });
            });
        },

        // ─── 清除所有 DOM 标记 ────────────────────────────────────
        clearAllMarks: function () {
            document.querySelectorAll('.bk-note-icon').forEach(function (el) { el.remove(); });
            document.querySelectorAll('.bk-highlight').forEach(function (mark) {
                var parent = mark.parentNode;
                while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
                parent.removeChild(mark);
            });
            var container = document.querySelector('#app .content') || document.querySelector('.content');
            if (container) container.normalize();
        },

        // ─── 数据 CRUD ────────────────────────────────────────────
        addHighlight: function (color, underline) {
            var range = this._pendingRange;
            if (!range) return null;
            var rangeNode = range.commonAncestorContainer;
            var container = (rangeNode.nodeType === 3 ? rangeNode.parentElement : rangeNode).closest('.content');
            if (!container) return null;
            var position = this.getSelectionPosition(container, range);
            if (!position) return null;

            var textNodes = this.getTextNodes(container);
            var pageText = '';
            for (var ti = 0; ti < textNodes.length; ti++) pageText += textNodes[ti].textContent;
            var ctx = this._extractContext(pageText, position.start, position.end);

            var highlight = {
                id:        Date.now().toString(),
                start:     position.start,
                end:       position.end,
                text:      range.toString(),
                prefix:    ctx.prefix,
                suffix:    ctx.suffix,
                color:     (color === null || color === 'note' || color === undefined) ? null : (color || this.config.defaultColor),
                underline: !!underline,
                note:      '',
                timestamp: Date.now()
            };

            this.highlights.push(highlight);
            var self = this;
            this._pendingRange = null;
            this._suppressSelMenuUntil = Date.now() + 800;
            this.saveHighlights().then(function () {
                self.clearAllMarks();
                self.restoreHighlights();
                self._suppressSelMenuUntil = 0;
            }).catch(function () {
                self._suppressSelMenuUntil = 0;
            });
            return highlight.id;
        },

        updateHighlight: function (id, changes) {
            var h = this.highlights.find(function (x) { return x.id === id; });
            if (!h) return;
            if (changes.color     !== undefined) h.color     = changes.color;
            if (changes.underline !== undefined) h.underline = changes.underline;
            var self = this;
            this.saveHighlights().then(function () {
                self.clearAllMarks();
                self.restoreHighlights();
            });
        },

        removeHighlight: function (id) {
            this.highlights = this.highlights.filter(function (h) { return h.id !== id; });
            var self = this;
            this.saveHighlights().then(function () {
                self.clearAllMarks();
                self.restoreHighlights();
            });
        },

        removeMark: function (id) {
            var h = this.highlights.find(function (x) { return x.id === id; });
            if (!h) return;
            h.color     = null;
            h.underline = false;
            if (!h.note) {
                this.removeHighlight(id);
                return;
            }
            var self = this;
            this.saveHighlights().then(function () {
                self.clearAllMarks();
                self.restoreHighlights();
            });
        },

        saveNote: function (id, text) {
            var h = this.highlights.find(function (x) { return x.id === id; });
            if (!h) return;
            h.note = text || '';
            if (!h.note && !h.color && !h.underline) {
                this.removeHighlight(id);
                return;
            }
            var self = this;
            this.saveHighlights().then(function () {
                self.clearAllMarks();
                self.restoreHighlights();
            });
        },

        removeNote: function (id) {
            this.saveNote(id, '');
        },

        clearAllHighlights: function () {
            if (!confirm('确定要清除本页所有划线吗？')) return;
            this.highlights = [];
            this.clearAllMarks();
            this.saveHighlights();
        },

        clearAllHighlightsForce: function () {
            this.highlights = [];
            this.clearAllMarks();
            return BKStorage.clear();
        },

        // ─── 创建所有 UI DOM ──────────────────────────────────────
        createMenus: function () {
            this._createSelectionMenu();
            this._createAnnotationMenu();
            this._createNoteModal();
        },

        _colorPanelHTML: function () {
            var self = this;
            var dots = Object.keys(self.config.colors).map(function (name) {
                return '<button class="hl-color-dot" data-color="' + name +
                       '" style="background:' + self.config.colors[name] +
                       '" title="' + name + '"></button>';
            }).join('');
            return '<div class="hl-color-panel">' +
                       dots +
                       '<button class="hl-underline-btn" title="下划线">U</button>' +
                   '</div>';
        },

        _createSelectionMenu: function () {
            if (document.getElementById('hl-selection-menu')) return;
            var self = this;
            var menu = document.createElement('div');
            menu.id        = 'hl-selection-menu';
            menu.className = 'hl-menu';

            var colorDotsHTML = Object.keys(self.config.colors).map(function (name) {
                return '<button class="hl-color-dot hl-sel-dot" data-color="' + name +
                       '" style="background:' + self.config.colors[name] +
                       '" title="' + name + '"></button>';
            }).join('');

            menu.innerHTML =
                '<div class="hl-menu-row hl-sel-row">' +
                    colorDotsHTML +
                    '<button class="hl-underline-btn" id="hl-sel-ul" title="下划线">U</button>' +
                    '<span class="hl-sel-sep"></span>' +
                    '<button class="hl-menu-btn hl-sel-note-btn" id="hl-sel-note">添加笔记</button>' +
                '</div>';

            ['touchstart', 'touchend', 'mousedown'].forEach(function (evt) {
                menu.addEventListener(evt, function (e) { e.stopPropagation(); });
            });
            document.body.appendChild(menu);

            menu.querySelectorAll('.hl-sel-dot').forEach(function (dot) {
                dot.addEventListener('click', function (e) {
                    e.stopPropagation();
                    self.addHighlight(dot.dataset.color, false);
                    self.hideAllMenus();
                });
            });

            document.getElementById('hl-sel-ul').addEventListener('click', function (e) {
                e.stopPropagation();
                self.addHighlight(null, true);
                self.hideAllMenus();
            });

            document.getElementById('hl-sel-note').addEventListener('click', function (e) {
                e.stopPropagation();
                var newId = self.addHighlight('note', false);
                self.hideAllMenus();
                if (newId) self.showNoteEditor(newId);
            });
        },

        _createAnnotationMenu: function () {
            if (document.getElementById('hl-annotation-menu')) return;
            var self = this;
            var menu = document.createElement('div');
            menu.id        = 'hl-annotation-menu';
            menu.className = 'hl-menu hl-ann-menu';
            menu.innerHTML =
                '<div class="hl-ann-note-bubble" id="hl-ann-note-preview">' +
                    '<div class="hl-ann-note-body" id="hl-ann-note-text"></div>' +
                    '<button class="hl-ann-note-expand" id="hl-ann-expand">展开 ▾</button>' +
                '</div>' +
                '<div class="hl-ann-toolbar" id="hl-ann-toolbar">' +
                    '<button class="hl-ann-tool" id="hl-ann-edit-note" data-action="edit-note">' +
                        '<span class="hl-ann-tool-icon">✏️</span><span class="hl-ann-tool-label" id="hl-ann-edit-note-label">笔记</span>' +
                    '</button>' +
                    '<button class="hl-ann-tool hl-ann-tool-danger" id="hl-ann-del-note" data-action="del-note">' +
                        '<span class="hl-ann-tool-icon">🗑</span><span class="hl-ann-tool-label">删除</span>' +
                    '</button>' +
                    '<span class="hl-ann-tool-sep"></span>' +
                    '<button class="hl-ann-tool" id="hl-ann-modify-mark" data-action="modify-mark">' +
                        '<span class="hl-ann-tool-icon">🎨</span><span class="hl-ann-tool-label" id="hl-ann-mark-label">标记</span>' +
                    '</button>' +
                    '<button class="hl-ann-tool hl-ann-tool-danger" id="hl-ann-del-mark" data-action="del-mark">' +
                        '<span class="hl-ann-tool-icon">✕</span><span class="hl-ann-tool-label">删除</span>' +
                    '</button>' +
                '</div>' +
                self._colorPanelHTML();

            ['touchstart', 'touchend', 'mousedown'].forEach(function (evt) {
                menu.addEventListener(evt, function (e) { e.stopPropagation(); });
            });
            document.body.appendChild(menu);

            document.getElementById('hl-ann-modify-mark').addEventListener('click', function (e) {
                e.stopPropagation();
                var panel = menu.querySelector('.hl-color-panel');
                var isOpen = panel.classList.contains('open');
                panel.classList.toggle('open', !isOpen);
                if (!isOpen) {
                    var h = self.highlights.find(function (x) { return x.id === self._pendingHighlightId; });
                    if (h) self._syncColorPanel(panel, h.color, h.underline);
                }
            });

            document.getElementById('hl-ann-del-mark').addEventListener('click', function (e) {
                e.stopPropagation();
                var id = self._pendingHighlightId;
                self.hideAllMenus();
                if (id) self.removeMark(id);
            });

            document.getElementById('hl-ann-expand').addEventListener('click', function (e) {
                e.stopPropagation();
                var id = self._pendingHighlightId;
                var h  = self.highlights.find(function (x) { return x.id === id; });
                if (!h || !h.note) return;
                self.hideAllMenus();
                if (!window.BK || !window.BK.openDialog) return;
                var dlg = window.BK.openDialog({
                    id: 'bk-note-expanded',
                    html:
                        '<div class="bk-note-expanded-card">' +
                            '<div class="bk-note-expanded-header">' +
                                '<span class="bk-note-expanded-title">笔记</span>' +
                                '<button class="bk-note-expanded-edit" id="bk-note-exp-edit">编辑</button>' +
                            '</div>' +
                            '<div class="bk-note-expanded-body"></div>' +
                        '</div>'
                });
                if (!dlg) return;
                var body = dlg.mask.querySelector('.bk-note-expanded-body');
                body.textContent = h.note;
                dlg.mask.querySelector('#bk-note-exp-edit').addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    dlg.close();
                    self.showNoteEditor(id);
                });
            });

            document.getElementById('hl-ann-edit-note').addEventListener('click', function (e) {
                e.stopPropagation();
                var id = self._pendingHighlightId;
                self.hideAllMenus();
                if (id) self.showNoteEditor(id);
            });

            document.getElementById('hl-ann-del-note').addEventListener('click', function (e) {
                e.stopPropagation();
                var id = self._pendingHighlightId;
                self.hideAllMenus();
                if (id) self.removeNote(id);
            });

            self._bindColorPanel(menu.querySelector('.hl-color-panel'), 'existing');
        },

        _createNoteModal: function () {
            if (document.getElementById('hl-note-modal')) return;
            var self = this;
            var modal = document.createElement('div');
            modal.id        = 'hl-note-modal';
            modal.className = 'hl-modal-mask';
            modal.innerHTML =
                '<div class="hl-modal-card">' +
                    '<div class="hl-modal-title">笔记</div>' +
                    '<textarea class="hl-note-textarea" id="hl-note-textarea" placeholder="输入笔记内容…" rows="5"></textarea>' +
                    '<div class="hl-modal-actions">' +
                        '<button class="hl-modal-btn hl-modal-cancel" id="hl-note-cancel">取消</button>' +
                        '<button class="hl-modal-btn hl-modal-save"   id="hl-note-save">保存</button>' +
                    '</div>' +
                '</div>';

            document.body.appendChild(modal);

            function closeModal() {
                var id = modal.dataset.highlightId;
                modal.style.display = 'none';
                if (id) {
                    var h = self.highlights.find(function (x) { return x.id === id; });
                    if (h && !h.note && !h.color && !h.underline) self.removeHighlight(id);
                }
            }

            document.getElementById('hl-note-cancel').addEventListener('click', closeModal);
            document.getElementById('hl-note-save').addEventListener('click', function () {
                var id   = modal.dataset.highlightId;
                var text = document.getElementById('hl-note-textarea').value.trim();
                modal.style.display = 'none';
                if (id) self.saveNote(id, text);
            });
            modal.addEventListener('click', function (e) {
                if (e.target === modal) closeModal();
            });

            if (window.BK && window.BK.lockOverlayScroll) {
                window.BK.lockOverlayScroll(modal, closeModal);
            }
        },

        _bindColorPanel: function (panel, target) {
            var self = this;
            panel.querySelectorAll('.hl-color-dot').forEach(function (dot) {
                dot.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var isSame = self._selectedColor === dot.dataset.color;
                    panel.querySelectorAll('.hl-color-dot').forEach(function (d) { d.classList.remove('selected'); });
                    if (isSame) {
                        self._selectedColor = null;
                    } else {
                        self._selectedColor = dot.dataset.color;
                        dot.classList.add('selected');
                    }
                    if (target === 'existing') {
                        var id = self._pendingHighlightId;
                        if (id) {
                            if (!self._selectedColor && !self._selectedUnderline) {
                                self.removeMark(id);
                            } else {
                                self.updateHighlight(id, { color: self._selectedColor, underline: self._selectedUnderline });
                            }
                        }
                        self.hideAllMenus();
                    }
                });
            });
            panel.querySelector('.hl-underline-btn').addEventListener('click', function (e) {
                e.stopPropagation();
                this.classList.toggle('active');
                self._selectedUnderline = this.classList.contains('active');
                if (target === 'existing') {
                    var id = self._pendingHighlightId;
                    if (id) {
                        if (!self._selectedColor && !self._selectedUnderline) {
                            self.removeMark(id);
                        } else {
                            self.updateHighlight(id, { color: self._selectedColor, underline: self._selectedUnderline });
                        }
                    }
                    self.hideAllMenus();
                }
            });
        },

        _syncColorPanel: function (panel, color, underline) {
            panel.querySelectorAll('.hl-color-dot').forEach(function (d) {
                d.classList.toggle('selected', d.dataset.color === color);
            });
            panel.querySelector('.hl-underline-btn').classList.toggle('active', !!underline);
            this._selectedColor     = color;
            this._selectedUnderline = !!underline;
        },

        // ─── 显示 / 隐藏菜单 ─────────────────────────────────────
        hideAllMenus: function () {
            ['hl-selection-menu', 'hl-annotation-menu'].forEach(function (id) {
                var el = document.getElementById(id);
                if (!el) return;
                el.style.display = 'none';
                var panel = el.querySelector('.hl-color-panel');
                if (panel) panel.classList.remove('open');
            });
        },

        showSelectionMenu: function (range) {
            this.hideAllMenus();
            this._pendingRange      = range;
            this._selectedColor     = this.config.defaultColor;
            this._selectedUnderline = false;
            var menu = document.getElementById('hl-selection-menu');
            this._positionMenu(menu, range);
        },

        showAnnotationMenu: function (highlightId, targetEl) {
            this.hideAllMenus();
            this._pendingHighlightId = highlightId;
            var h = this.highlights.find(function (x) { return x.id === highlightId; });
            if (!h) return;

            var bubble     = document.getElementById('hl-ann-note-preview');
            var noteBody   = document.getElementById('hl-ann-note-text');
            var expandBtn  = document.getElementById('hl-ann-expand');
            if (h.note) {
                noteBody.textContent = h.note;
                expandBtn.style.display = 'none';
                bubble.style.display = 'block';
            } else {
                noteBody.textContent = '';
                expandBtn.style.display = 'none';
                bubble.style.display = 'none';
            }

            var noteEditLabel = document.getElementById('hl-ann-edit-note-label');
            if (noteEditLabel) noteEditLabel.textContent = h.note ? '编辑' : '笔记';
            document.getElementById('hl-ann-del-note').style.display = h.note ? '' : 'none';

            var hasVisibleMark = !!(h.color || h.underline);
            var markLabel = document.getElementById('hl-ann-mark-label');
            if (markLabel) markLabel.textContent = hasVisibleMark ? '修改' : '标记';
            document.getElementById('hl-ann-del-mark').style.display = hasVisibleMark ? '' : 'none';

            var menu = document.getElementById('hl-annotation-menu');
            this._positionMenuByRect(menu, targetEl.getBoundingClientRect());
        },

        showNoteEditor: function (id) {
            var h     = this.highlights.find(function (x) { return x.id === id; });
            var modal = document.getElementById('hl-note-modal');
            modal.dataset.highlightId = id;
            document.getElementById('hl-note-textarea').value = h ? (h.note || '') : '';
            modal.style.display = 'flex';
            setTimeout(function () { document.getElementById('hl-note-textarea').focus(); }, 100);
        },

        _positionMenu: function (menu, range) {
            this._positionMenuByRect(menu, range.getBoundingClientRect());
        },

        _positionMenuByRect: function (menu, rect) {
            menu.style.position  = 'fixed';
            menu.style.transform = 'none';
            menu.style.top       = '-9999px';
            menu.style.left      = '-9999px';
            menu.style.display   = 'flex';
            menu.style.opacity   = '0';
            requestAnimationFrame(function () {
                var vvp = window.visualViewport;
                var vpH = vvp ? vvp.height : window.innerHeight;
                var vpW = vvp ? vvp.width  : window.innerWidth;

                var GAP_BELOW = 88;
                var GAP_ABOVE = 78;

                var belowAvail = vpH - rect.bottom - GAP_BELOW;
                var aboveAvail = rect.top - GAP_ABOVE;
                var viewTop;
                if (belowAvail >= menu.offsetHeight || belowAvail >= aboveAvail) {
                    viewTop = rect.bottom + GAP_BELOW;
                } else {
                    viewTop = rect.top - menu.offsetHeight - GAP_ABOVE;
                }
                viewTop = Math.max(GAP_BELOW, Math.min(viewTop, vpH - menu.offsetHeight - 10));

                var left = rect.left + rect.width / 2 - menu.offsetWidth / 2;
                left = Math.max(10, Math.min(left, vpW - menu.offsetWidth - 10));

                menu.style.left    = left + 'px';
                menu.style.top     = viewTop + 'px';
                if (menu.id === 'hl-annotation-menu') {
                    var nb = document.getElementById('hl-ann-note-text');
                    var eb = document.getElementById('hl-ann-expand');
                    if (nb && eb && nb.textContent) {
                        eb.style.display = nb.scrollHeight > nb.clientHeight ? '' : 'none';
                    }
                }
                menu.style.opacity = '1';
            });
        },

        // ─── 事件监听 ─────────────────────────────────────────────
        setupEventListeners: function () {
            if (this._listenersSetup) return;
            this._listenersSetup = true;
            var self = this;
            var _showTimer = null;

            function _hideSelMenu() {
                var m = document.getElementById('hl-selection-menu');
                if (m && m.style.display !== 'none') m.style.display = 'none';
            }

            document.addEventListener('touchstart', function () {
                clearTimeout(_showTimer);
                _hideSelMenu();
            }, { passive: true });

            document.addEventListener('mouseup', function (e) {
                clearTimeout(_showTimer);
                _showTimer = setTimeout(function () { self._handleTextSelection(e); }, 50);
            });

            document.addEventListener('selectionchange', function () {
                _hideSelMenu();
                clearTimeout(_showTimer);
                _showTimer = setTimeout(function () {
                    var sel = window.getSelection();
                    if (sel && sel.toString().trim().length > 0) {
                        self._handleTextSelection();
                    }
                }, 350);
            });

            window.addEventListener('scroll', function () {
                self.hideAllMenus();
            }, { passive: true });

            document.addEventListener('click', function (e) {
                var ni = e.target.closest ? e.target.closest('.bk-note-icon') : null;
                var hl = e.target.closest ? e.target.closest('.bk-highlight') : null;

                if (ni) {
                    e.stopPropagation();
                    self.showAnnotationMenu(ni.dataset.highlightId, ni);
                    return;
                }
                if (hl) {
                    var sel = window.getSelection();
                    if (sel && sel.toString().trim().length > 0) return;
                    e.stopPropagation();
                    var isRefLink = !!(e.target.closest && (
                        e.target.closest('.scripture-ref') ||
                        e.target.closest('.fn-ref') ||
                        e.target.closest('.xref-ref') ||
                        e.target.closest('.verse-ref')
                    ));
                    if (isRefLink) {
                        self._showAnnotationMenuAfterPopupClose(hl.dataset.highlightId, hl);
                        return;
                    }
                    self.showAnnotationMenu(hl.dataset.highlightId, hl);
                    return;
                }

                var selMenu = document.getElementById('hl-selection-menu');
                var annMenu = document.getElementById('hl-annotation-menu');
                var outsideSel = selMenu && selMenu.style.display !== 'none' && !selMenu.contains(e.target);
                var outsideAnn = annMenu && annMenu.style.display !== 'none' && !annMenu.contains(e.target);
                if (outsideSel || outsideAnn) self.hideAllMenus();
            });

            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') self.hideAllMenus();
            });
        },

        _showAnnotationMenuAfterPopupClose: function (highlightId, targetEl) {
            var self = this;
            requestAnimationFrame(function () {
                var overlay = document.getElementById('scripture-popup-overlay');
                if (!overlay || !overlay.classList.contains('scripture-popup-overlay--open')) {
                    self.showAnnotationMenu(highlightId, targetEl);
                    return;
                }
                var observer = new MutationObserver(function () {
                    if (!overlay.classList.contains('scripture-popup-overlay--open')) {
                        observer.disconnect();
                        requestAnimationFrame(function () {
                            self.showAnnotationMenu(highlightId, targetEl);
                        });
                    }
                });
                observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
                setTimeout(function () { observer.disconnect(); }, 60000);
            });
        },

        _handleTextSelection: function (e) {
            var selMenu = document.getElementById('hl-selection-menu');
            if (e && e.target && selMenu && selMenu.contains(e.target)) return;
            if (this._suppressSelMenuUntil && Date.now() < this._suppressSelMenuUntil) return;

            var sel = window.getSelection();
            if (!sel || sel.toString().trim().length === 0) return;
            if (!sel.rangeCount) return;
            var range     = sel.getRangeAt(0);
            var rangeNode = range.commonAncestorContainer;
            var container = (rangeNode.nodeType === 3 ? rangeNode.parentElement : rangeNode).closest('.content');
            if (!container) return;
            this.showSelectionMenu(range.cloneRange());
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { BKHighlight.init(); });
    } else {
        BKHighlight.init();
    }

    window.BKHighlight = BKHighlight;

})();
