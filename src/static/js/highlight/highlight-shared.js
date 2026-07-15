/**
 * 划线标记与笔记功能
 * 支持文本选中后划线、添加笔记、保存到本地存储、恢复划线
 *
 * 数据模型：{id, start, end, text, color, underline, note, timestamp}
 * underline/note 字段为新增，旧数据读取时自动补默认值。
 * 存储后端：localForage (IndexedDB)，每页独立一个键
 */
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
                yellow: '#F4E6C0',
                green:  '#D8EBDD',
                blue:   '#E3EFE8',
                pink:   '#F3DDD3'
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
};
