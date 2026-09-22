'use strict';
Object.assign(BKHighlight, {
        // ─── 初始化 ───────────────────────────────────────────────
        init: function () {
            this._selectedColor = this.config.defaultColor;
            this.createMenus();
            this.setupEventListeners();
            var self = this;
            BKStorage.init().then(function () { self.restoreHighlights(); });
        },

        // ─── 供外部在异步内容渲染后调用 ────────────────────────────
        rendoHighlights: function () {
            this.clearAllMarks();
            this.restoreHighlights();
        },

        // ─── 存储键 ───────────────────────────────────────────────
        // SPA 模式下从 hash 推导 key: /{book-id}/{chapter}
        getPageKey: function () {
            var hash = window.location.hash.replace(/^#\/?/, '');
            if (hash) {
                // ★ decode URL 编码的中文 bookId，确保存储键与路由解码后一致
                try { hash = decodeURIComponent(hash); } catch (e) {}
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
});
