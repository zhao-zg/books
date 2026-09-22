'use strict';
Object.assign(BKHighlight, {
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
                       '" style="background:' + (self.config.dotColors ? self.config.dotColors[name] : self.config.colors[name]) +
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
                       '" style="background:' + (self.config.dotColors ? self.config.dotColors[name] : self.config.colors[name]) +
                       '" title="' + name + '"></button>';
            }).join('');

            menu.innerHTML =
                '<div class="hl-menu-row hl-sel-row">' +
                    colorDotsHTML +
                    '<button class="hl-underline-btn" id="hl-sel-ul" title="下划线">U</button>' +
                    '<span class="hl-sel-sep"></span>' +
                    '<button class="hl-menu-btn hl-sel-note-btn" id="hl-sel-note">添加批注</button>' +
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
                if (id) {
                    var h = self.highlights.find(function (x) { return x.id === id; });
                    var hasNote = h && h.note;
                    var msg = hasNote ? '确定删除此划线？含批注将一并删除' : '确定删除此划线？';
                    if (confirm(msg)) self.removeMark(id);
                }
            });

            document.getElementById('hl-ann-expand').addEventListener('click', function (e) {
                e.stopPropagation();
                var id = self._pendingHighlightId;
                var h  = self.highlights.find(function (x) { return x.id === id; });
                if (!h || !h.note) return;
                self.hideAllMenus();
                if (!window.BK || !window.BK.openDialog) return;
                var dlg = window.BK.openDialog({
                    id: 'bk-hl-note-expanded',
                    html:
                        '<div class="bk-hl-note-expanded-card">' +
                            '<div class="bk-hl-note-expanded-header">' +
                                '<span class="bk-hl-note-expanded-title">批注</span>' +
                                '<button class="bk-hl-note-expanded-edit" id="bk-hl-note-exp-edit">编辑</button>' +
                            '</div>' +
                            '<div class="bk-hl-note-expanded-body"></div>' +
                        '</div>'
                });
                if (!dlg) return;
                var body = dlg.mask.querySelector('.bk-hl-note-expanded-body');
                body.textContent = h.note;
                dlg.mask.querySelector('#bk-hl-note-exp-edit').addEventListener('click', function (ev) {
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
                if (id && confirm('确定删除此批注？')) self.removeNote(id);
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
                    '<div class="hl-modal-title">批注</div>' +
                    '<textarea class="hl-note-textarea" id="hl-note-textarea" placeholder="输入批注内容…" rows="5"></textarea>' +
                    '<div class="hl-modal-actions">' +
                        '<button class="hl-modal-btn hl-modal-cancel" id="hl-note-cancel">取消</button>' +
                        '<button class="hl-modal-btn hl-modal-save"   id="hl-note-save">保存</button>' +
                    '</div>' +
                '</div>';

            document.body.appendChild(modal);

            function closeModal() {
                if (modal.style.display !== 'flex') return; // 幂等守卫：未显示时无栈条目可消耗
                var id = modal.dataset.highlightId;
                modal.style.display = 'none';
                if (self._noteLockCleanup) { self._noteLockCleanup(); self._noteLockCleanup = null; }
                if (self._noteModalInBackStack && window.BK && window.BK.backStack) {
                    self._noteModalInBackStack = false;
                    window.BK.backStack.discard(); // 主动关闭：消耗 history 条目
                }
                if (id) {
                    var h = self.highlights.find(function (x) { return x.id === id; });
                    if (h && !h.note && !h.color && !h.underline) self.removeHighlight(id);
                }
            }
            // 挂到实例上，供回退栈回调复用（popstate 路径标志已复位，不会二次 discard）
            self._closeNoteModal = closeModal;

            document.getElementById('hl-note-cancel').addEventListener('click', closeModal);
            document.getElementById('hl-note-save').addEventListener('click', function () {
                var id   = modal.dataset.highlightId;
                var text = document.getElementById('hl-note-textarea').value.trim();
                if (id) self.saveNote(id, text);
                closeModal();
            });
            modal.addEventListener('click', function (e) {
                if (e.target === modal) closeModal();
            });

            if (window.BK && window.BK.lockOverlayScroll) {
                self._noteLockCleanup = window.BK.lockOverlayScroll(modal, closeModal);
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
            if (noteEditLabel) noteEditLabel.textContent = h.note ? '编辑' : '批注';
            document.getElementById('hl-ann-del-note').style.display = h.note ? '' : 'none';

            var hasVisibleMark = !!(h.color || h.underline);
            var markLabel = document.getElementById('hl-ann-mark-label');
            if (markLabel) markLabel.textContent = hasVisibleMark ? '修改' : '标记';
            document.getElementById('hl-ann-del-mark').style.display = hasVisibleMark ? '' : 'none';

            var menu = document.getElementById('hl-annotation-menu');
            this._positionMenuByRect(menu, targetEl.getBoundingClientRect());
        },

        showNoteEditor: function (id) {
            var modal = document.getElementById('hl-note-modal');
            if (!modal) return;
            if (modal.style.display === 'flex') return; // 幂等守卫：已显示
            var h     = this.highlights.find(function (x) { return x.id === id; });
            modal.dataset.highlightId = id;
            document.getElementById('hl-note-textarea').value = h ? (h.note || '') : '';
            modal.style.display = 'flex';
            // 接入回退栈：系统返回键关闭批注弹窗
            if (window.BK && window.BK.backStack) {
                var self = this;
                self._noteModalInBackStack = true;
                window.BK.backStack.push(function () {
                    self._noteModalInBackStack = false; // 条目已被 popstate 消耗，防止 closeModal 二次 discard
                    if (self._closeNoteModal) self._closeNoteModal();
                });
            }
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

});
