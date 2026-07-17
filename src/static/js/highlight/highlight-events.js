'use strict';
Object.assign(BKHighlight, {
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
                var ni = e.target.closest ? e.target.closest('.bk-hl-note-icon') : null;
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
});

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { BKHighlight.init(); });
    } else {
        BKHighlight.init();
    }

    window.BKHighlight = BKHighlight;
