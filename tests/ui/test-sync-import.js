'use strict';
/**
 * sync-import 纯逻辑单元测试（node:test + JSDOM）
 *
 * 被测目标：src/static/js/sync/sync-import.js 暴露的
 *   win.BK.Sync.importFromZip(buffer, opts)
 *
 * 加载方式：JSDOM + vm.runInThisContext
 *   - 先加载真正的 JSZip（vendor/jszip.min.js），用于生成和解压验证 ZIP 内容
 *   - 再 mock 所需 API，然后加载被测模块源码
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

// ── 构造 JSDOM 环境 ─────────────────────────────────────────────────────
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.win = dom.window;

// ── 加载真正的 JSZip ──────────────────────────────────────────────────
const jszipPath = join(__dirname, '..', '..', 'src', 'static', 'vendor', 'jszip.min.js');
const jszipCode = readFileSync(jszipPath, 'utf-8');
vm.runInThisContext(jszipCode, { filename: jszipPath, displayErrors: true });
assert.ok(win.JSZip, 'JSZip 必须在 window 上可用');

// ── Mock 依赖 API ───────────────────────────────────────────────────────

// 1. BKBookmark — 模拟 EPUB 书签（IndexedDB 单键数组）
var _mockBookmarks = [];   // 当前本地已有的书签数组
var _bkSaveCalls = [];
win.BK = win.BK || {};
win.BKBookmark = {
    getAll: function () {
        return Promise.resolve(_mockBookmarks.slice());
    },
    _save: function (arr) {
        _mockBookmarks = arr.slice();
        _bkSaveCalls.push(arr.slice());
        return Promise.resolve();
    }
};

// 2. BKStorage — 模拟高亮（IndexedDB 每页一键）
var _mockHighlightStore = {};  // { "key": [{ id, text, note, timestamp }] }
var _setPageCalls = [];
win.BKStorage = {
    getAllPages: function () {
        var pages = [];
        var keys = Object.keys(_mockHighlightStore);
        for (var i = 0; i < keys.length; i++) {
            var arr = _mockHighlightStore[keys[i]];
            if (Array.isArray(arr) && arr.length) {
                pages.push({ key: keys[i], highlights: arr });
            }
        }
        return Promise.resolve(pages);
    },
    getPage: function (key) {
        return Promise.resolve(_mockHighlightStore[key] ? _mockHighlightStore[key].slice() : []);
    },
    setPage: function (key, arr) {
        _mockHighlightStore[key] = arr.slice();
        _setPageCalls.push({ key: key, arr: arr.slice() });
        return Promise.resolve();
    }
};

// 3. BKShelf — 模拟书架
var _mockShelf = {};  // { bookId: { ...record } }
win.BKShelf = {
    all: function () {
        return Object.keys(_mockShelf).map(function (id) {
            return Object.assign({ id: id }, _mockShelf[id]);
        });
    },
    add: function (bookId, opts) {
        opts = opts || {};
        if (_mockShelf[bookId] && _mockShelf[bookId].status === 'collected') return;
        _mockShelf[bookId] = {
            addedAt: opts.addedAt || '2026-08-31',
            addedAtTs: opts.addedAtTs || Date.now(),
            note: opts.note !== undefined ? opts.note : null,
            rating: opts.rating !== undefined ? opts.rating : null,
            status: 'collected',
            finished: false
        };
    },
    get: function (bookId) {
        return _mockShelf[bookId] || null;
    },
    updateNote: function (bookId, note) {
        if (!_mockShelf[bookId]) return;
        _mockShelf[bookId].note = (note && note.trim()) ? note.trim() : null;
    },
    updateRating: function (bookId, rating) {
        if (!_mockShelf[bookId]) return;
        _mockShelf[bookId].rating = (typeof rating === 'number' && rating >= 1 && rating <= 5) ? rating : null;
    },
    markRead: function (bookId, opts) {
        opts = opts || {};
        if (_mockShelf[bookId] && _mockShelf[bookId].finished === true) return;
        if (!_mockShelf[bookId]) {
            _mockShelf[bookId] = { addedAt: '2026-08-31', status: 'collected' };
        }
        _mockShelf[bookId].finished = true;
        _mockShelf[bookId].completedAt = opts.completedAt || '2026-08-31';
    }
};

// 4. BK.SyncData.collectUserData — 模拟从 localStorage 收集
win.BK.SyncData = {
    collectUserData: function (bookId) {
        var data = {};
        var ls = win.localStorage;
        var progress = ls.getItem('bk_progress:' + bookId);
        if (progress !== null) data.progress = progress;
        var lastReadTs = ls.getItem('bk_lastread_ts:' + bookId);
        if (lastReadTs !== null) data.lastReadTs = lastReadTs;
        return (data.progress != null || data.lastReadTs) ? data : null;
    }
};

// 5. ImportManager — 模拟书数据 + PDF 存储
var _mockImportedBooks = {};
var _mockPdfStoreData = {};
var _mockPdfStore = {
    getItem: function (key) {
        return Promise.resolve(_mockPdfStoreData.hasOwnProperty(key) ? _mockPdfStoreData[key] : null);
    },
    setItem: function (key, val) {
        _mockPdfStoreData[key] = val;
        return Promise.resolve();
    }
};
var _mockImportStore = {
    setItem: function (key, val) {
        _mockImportStore._data = _mockImportStore._data || {};
        _mockImportStore._data[key] = val;
        return Promise.resolve();
    },
    getItem: function (key) {
        _mockImportStore._data = _mockImportStore._data || {};
        return Promise.resolve(_mockImportStore._data.hasOwnProperty(key) ? _mockImportStore._data[key] : null);
    }
};
win.ImportManager = {
    getImportedBook: function (bookId) {
        return Promise.resolve(_mockImportedBooks.hasOwnProperty(bookId) ? _mockImportedBooks[bookId] : null);
    },
    getPdfDataStore: function () { return _mockPdfStore; },
    getImportStore: function () { return _mockImportStore; }
};

// 6. DataManager — 模拟书城索引 + 缓存
var _mockCityIndex = { books: [] };
var _mockCachedBooks = {};
win.DataManager = {
    getCachedIndex: function () { return _mockCityIndex; },
    loadIndex: function () { return Promise.resolve(_mockCityIndex); },
    isBookDownloaded: function (bookId) {
        return Promise.resolve(!!_mockCachedBooks[bookId]);
    },
    cacheBook: function (bookId, data) {
        _mockCachedBooks[bookId] = data;
        return Promise.resolve();
    },
    buildContentIndex: function () {},
    addToBookIndex: function () {}
};

// 6b. BK.ImportZip — 旧版 ZIP 委托目标
win.BK.ImportZip = {
    importFromZip: function (buf, fileName, opts) {
        return Promise.resolve({ success: 0, skipped: 0, failed: 0, errors: [] });
    }
};

// ── 加载被测模块 ───────────────────────────────────────────────────────
const syncImportPath = join(__dirname, '..', '..', 'src', 'static', 'js', 'sync', 'sync-import.js');
const syncImportCode = readFileSync(syncImportPath, 'utf-8');
vm.runInThisContext(syncImportCode, { filename: syncImportPath, displayErrors: true });

assert.ok(typeof win.BK.Sync === 'object', 'sync-import.js 必须暴露 win.BK.Sync');
assert.ok(typeof win.BK.Sync.importFromZip === 'function', 'sync-import.js 必须暴露 win.BK.Sync.importFromZip 函数');

// ── 辅助：生成同步 ZIP ─────────────────────────────────────────────────
function makeSyncZip(manifest, shelfData, bookDataMap) {
    var zip = new win.JSZip();
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    if (shelfData !== undefined) {
        zip.file('shelf.json', JSON.stringify(shelfData, null, 2));
    }
    if (bookDataMap) {
        var booksFolder = zip.folder('books');
        var bookIds = Object.keys(bookDataMap);
        for (var i = 0; i < bookIds.length; i++) {
            var bookId = bookIds[i];
            var bd = bookDataMap[bookId];
            var bookFolder = booksFolder.folder(bookId);
            if (bd.userdata) {
                bookFolder.file('userdata.json', JSON.stringify(bd.userdata, null, 2));
            }
            if (bd.bookJson) {
                bookFolder.file('book.json', JSON.stringify(bd.bookJson, null, 2));
            }
            if (bd.pdfBytes) {
                bookFolder.file('original.pdf', bd.pdfBytes);
            }
        }
    }
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

// ── 测试数据 ───────────────────────────────────────────────────────────
const BOOK_A = 'epub-aaa';
const BOOK_B = 'pdf-bbb';
const BOOK_IMPORTED = 'imported-old123';

function resetMocks() {
    win.localStorage.clear();
    _mockBookmarks = [];
    _bkSaveCalls = [];
    _mockHighlightStore = {};
    _setPageCalls = [];
    _mockShelf = {};
    _mockImportedBooks = {};
    _mockPdfStoreData = {};
    _mockImportStore._data = {};
    _mockCityIndex = { books: [] };
    _mockCachedBooks = {};
}

function seedLocalData(bookId) {
    // 本地已有一些书签和高亮
    _mockBookmarks = [
        { id: 'bm-local-1', path: '/' + bookId + '/1', scrollY: 50, title: '本地书签1', bookId: bookId, chapterNum: 1, note: 'local note', timestamp: 1700000000000 }
    ];
    _mockHighlightStore['/' + bookId + '/1'] = [
        { id: 'hl-local-1', text: '本地划线', note: 'local', timestamp: 1700000000001 }
    ];
    // 本地进度
    win.localStorage.setItem('bk_progress:' + bookId, '30');
    win.localStorage.setItem('bk_lastread_ts:' + bookId, '1700000000000');
}

// ═══════════════════════════════════════════════════════════════════════
// 基础功能测试
// ═══════════════════════════════════════════════════════════════════════
describe('BK.Sync.importFromZip 基础', function () {
    beforeEach(function () {
        resetMocks();
    });

    test('返回 Promise', function () {
        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, bookmarks: [], highlights: [], scroll: {} } };
        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            var result = win.BK.Sync.importFromZip(bytes);
            assert.ok(result && typeof result.then === 'function', '应返回 Promise');
            return result;
        });
    });

    test('manifest.json 缺失时 reject', function () {
        var zip = new win.JSZip();
        return zip.generateAsync({ type: 'uint8array' }).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes).then(function () {
                assert.fail('应 reject');
            }, function (err) {
                assert.ok(err instanceof Error);
                assert.ok(err.message.indexOf('manifest') >= 0 || err.message.indexOf('无效') >= 0);
            });
        });
    });

    test('不支持的 manifest version reject', function () {
        return makeSyncZip({ version: 99, type: 'sync-data' }, [], {}).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes).then(function () {
                assert.fail('应 reject');
            }, function (err) {
                assert.ok(err instanceof Error);
            });
        });
    });

    test('无书籍目录时 reject', function () {
        return makeSyncZip({ version: 3, type: 'sync-data' }, [], null).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes).then(function () {
                assert.fail('应 reject');
            }, function (err) {
                assert.ok(err instanceof Error);
            });
        });
    });

    test('导入空 userdata 仍返回成功', function () {
        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, bookmarks: [], highlights: [], scroll: {} } };
        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function (result) {
            assert.ok(result.success >= 0);
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 合并策略测试 — 书签
// ═══════════════════════════════════════════════════════════════════════
describe('书签合并', function () {
    beforeEach(function () {
        resetMocks();
    });

    test('本地与导入书签按 id 去重，双端保留', function () {
        // 本地有 bm-local-1, bm-local-2
        _mockBookmarks = [
            { id: 'bm-local-1', path: '/aaa/1', scrollY: 50, title: '本地1', bookId: BOOK_A, chapterNum: 1, note: '', timestamp: 1000 },
            { id: 'bm-local-2', path: '/aaa/2', scrollY: 100, title: '本地2', bookId: BOOK_A, chapterNum: 2, note: '', timestamp: 1001 }
        ];
        // 导入有 bm-local-2（重复 id，内容不同）+ bm-import-1（新）
        var importedBookmarks = [
            { id: 'bm-local-2', path: '/aaa/2', scrollY: 200, title: '导入覆盖2', bookId: BOOK_A, chapterNum: 2, note: 'imported', timestamp: 2000 },
            { id: 'bm-import-1', path: '/aaa/3', scrollY: 150, title: '导入新1', bookId: BOOK_A, chapterNum: 3, note: '', timestamp: 2001 }
        ];
        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, bookmarks: importedBookmarks, highlights: [], scroll: {} } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            assert.equal(_mockBookmarks.length, 3, '合并后应有 3 条书签（2 本地 + 1 新导入，重复 id 被导入版替换）');
            var ids = _mockBookmarks.map(function (bm) { return bm.id; });
            assert.ok(ids.indexOf('bm-local-1') >= 0, '本地 bm-local-1 应保留');
            assert.ok(ids.indexOf('bm-local-2') >= 0, 'bm-local-2 应存在（被导入版替换）');
            assert.ok(ids.indexOf('bm-import-1') >= 0, '导入 bm-import-1 应存在');
            // 验证重复 id 的书签内容被导入版替换
            var bm2 = _mockBookmarks.find(function (bm) { return bm.id === 'bm-local-2'; });
            assert.equal(bm2.title, '导入覆盖2', '重复 id 书签应被导入版替换');
        });
    });

    test('重复导入同一 ZIP 不产生重复数据（幂等）', function () {
        var importedBookmarks = [
            { id: 'bm-imp-1', path: '/aaa/1', scrollY: 50, title: '导入1', bookId: BOOK_A, chapterNum: 1, note: '', timestamp: 2000 }
        ];
        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, bookmarks: importedBookmarks, highlights: [], scroll: {} } };

        var zipBytes;
        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            zipBytes = bytes;
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            return win.BK.Sync.importFromZip(zipBytes);  // 再次导入
        }).then(function () {
            assert.equal(_mockBookmarks.length, 1, '重复导入后仍只有 1 条书签');
            assert.equal(_mockBookmarks[0].id, 'bm-imp-1');
        });
    });

    test('书签超过 100 条时按 timestamp 降序截断保留最新', function () {
        // 生成 50 条本地 + 60 条导入（共 110 条）
        var localBm = [];
        var importBm = [];
        for (var i = 0; i < 50; i++) {
            localBm.push({ id: 'bm-l-' + i, path: '/aaa/' + i, scrollY: i, title: 'L' + i, bookId: BOOK_A, chapterNum: i, note: '', timestamp: 1000 + i });
        }
        for (var j = 0; j < 60; j++) {
            importBm.push({ id: 'bm-i-' + j, path: '/aaa/' + (50 + j), scrollY: 50 + j, title: 'I' + j, bookId: BOOK_A, chapterNum: 50 + j, note: '', timestamp: 2000 + j });
        }
        _mockBookmarks = localBm;
        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, bookmarks: importBm, highlights: [], scroll: {} } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            assert.equal(_mockBookmarks.length, 100, '合并后应截断为 100 条');
            // 最旧的几条（timestamp 1000-1009）应被截断
            var ids = _mockBookmarks.map(function (bm) { return bm.id; });
            assert.ok(ids.indexOf('bm-l-0') < 0, '最旧的 bm-l-0 应被截断');
            assert.ok(ids.indexOf('bm-i-59') >= 0, '最新的 bm-i-59 应保留');
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 合并策略测试 — 高亮
// ═══════════════════════════════════════════════════════════════════════
describe('高亮合并', function () {
    beforeEach(function () {
        resetMocks();
    });

    test('同页高亮按 id 去重合并', function () {
        _mockHighlightStore['/' + BOOK_A + '/1'] = [
            { id: 'hl-local-1', text: '本地1', note: 'n1', timestamp: 1000 },
            { id: 'hl-local-2', text: '本地2', note: 'n2', timestamp: 1001 }
        ];
        var importedHighlights = [
            { key: '/' + BOOK_A + '/1', highlights: [
                { id: 'hl-local-2', text: '导入覆盖2', note: 'n2-new', timestamp: 2000 },
                { id: 'hl-import-1', text: '导入新1', note: '', timestamp: 2001 }
            ]}
        ];
        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, bookmarks: [], highlights: importedHighlights, scroll: {} } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            var page = _mockHighlightStore['/' + BOOK_A + '/1'];
            assert.ok(page, '页应存在');
            assert.equal(page.length, 3, '合并后应有 3 条高亮（2 本地 + 1 新导入，重复 id 被导入版替换）');
            var ids = page.map(function (h) { return h.id; });
            assert.ok(ids.indexOf('hl-local-1') >= 0, '本地 hl-local-1 应保留');
            assert.ok(ids.indexOf('hl-local-2') >= 0, 'hl-local-2 应存在（被导入版替换）');
            assert.ok(ids.indexOf('hl-import-1') >= 0, '导入 hl-import-1 应存在');
            var h2 = page.find(function (h) { return h.id === 'hl-local-2'; });
            assert.equal(h2.note, 'n2-new', '重复 id 高亮应被导入版替换');
        });
    });

    test('不同页高亮互不干扰', function () {
        _mockHighlightStore['/' + BOOK_A + '/1'] = [
            { id: 'hl-p1', text: 'P1', note: '', timestamp: 1000 }
        ];
        var importedHighlights = [
            { key: '/' + BOOK_A + '/2', highlights: [
                { id: 'hl-p2', text: 'P2', note: '', timestamp: 2000 }
            ]}
        ];
        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, bookmarks: [], highlights: importedHighlights, scroll: {} } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            assert.ok(_mockHighlightStore['/' + BOOK_A + '/1'], '页1 高亮应保留');
            assert.ok(_mockHighlightStore['/' + BOOK_A + '/2'], '页2 高亮应新增');
            assert.equal(_mockHighlightStore['/' + BOOK_A + '/1'].length, 1);
            assert.equal(_mockHighlightStore['/' + BOOK_A + '/2'].length, 1);
        });
    });

    test('重复导入高亮不产生重复（幂等）', function () {
        var importedHighlights = [
            { key: '/' + BOOK_A + '/1', highlights: [
                { id: 'hl-imp-1', text: '导入1', note: '', timestamp: 2000 }
            ]}
        ];
        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, bookmarks: [], highlights: importedHighlights, scroll: {} } };

        var zipBytes;
        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            zipBytes = bytes;
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            return win.BK.Sync.importFromZip(zipBytes);
        }).then(function () {
            assert.equal(_mockHighlightStore['/' + BOOK_A + '/1'].length, 1, '重复导入后仍只有 1 条');
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 合并策略测试 — 阅读进度
// ═══════════════════════════════════════════════════════════════════════
describe('进度合并', function () {
    beforeEach(function () {
        resetMocks();
    });

    test('导入进度比本地新时覆盖', function () {
        // 本地进度 ts=1700000000000
        win.localStorage.setItem('bk_progress:' + BOOK_A, '30');
        win.localStorage.setItem('bk_lastread_ts:' + BOOK_A, '1700000000000');

        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, progress: '60', lastReadTs: '1800000000000', bookmarks: [], highlights: [], scroll: {} } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            assert.equal(win.localStorage.getItem('bk_progress:' + BOOK_A), '60', '进度应被更新为导入值');
            assert.equal(win.localStorage.getItem('bk_lastread_ts:' + BOOK_A), '1800000000000');
        });
    });

    test('导入进度比本地旧时不覆盖', function () {
        win.localStorage.setItem('bk_progress:' + BOOK_A, '80');
        win.localStorage.setItem('bk_lastread_ts:' + BOOK_A, '1800000000000');

        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, progress: '30', lastReadTs: '1700000000000', bookmarks: [], highlights: [], scroll: {} } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            assert.equal(win.localStorage.getItem('bk_progress:' + BOOK_A), '80', '进度不应被覆盖');
            assert.equal(win.localStorage.getItem('bk_lastread_ts:' + BOOK_A), '1800000000000');
        });
    });

    test('本地无进度时直接用导入值', function () {
        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, progress: '50', lastReadTs: '1750000000000', bookmarks: [], highlights: [], scroll: {} } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            assert.equal(win.localStorage.getItem('bk_progress:' + BOOK_A), '50');
            assert.equal(win.localStorage.getItem('bk_lastread_ts:' + BOOK_A), '1750000000000');
        });
    });

    test('章内滚动位置合并（同章取新 ts 对应的值）', function () {
        // 本地有 scroll ch3=100, ch5=200
        win.localStorage.setItem('bk_scroll:' + BOOK_A + '/3', '100');
        win.localStorage.setItem('bk_scroll:' + BOOK_A + '/5', '200');

        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, progress: '42', lastReadTs: '1800000000000', bookmarks: [], highlights: [], scroll: { '3': '150', '7': '300' } } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            // ch3 导入值 150（导入 ts 更新，应覆盖）
            assert.equal(win.localStorage.getItem('bk_scroll:' + BOOK_A + '/3'), '150');
            // ch5 本地 200（导入无此章，保留本地）
            assert.equal(win.localStorage.getItem('bk_scroll:' + BOOK_A + '/5'), '200');
            // ch7 导入新增
            assert.equal(win.localStorage.getItem('bk_scroll:' + BOOK_A + '/7'), '300');
        });
    });

    test('章节已读标记并集', function () {
        // 本地已读 ch3, ch5
        win.localStorage.setItem('bk_chapter_read:' + BOOK_A + '/3', '1');
        win.localStorage.setItem('bk_chapter_read:' + BOOK_A + '/5', '1');

        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, chapterReads: ['5', '7', '9'], bookmarks: [], highlights: [], scroll: {} } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            assert.equal(win.localStorage.getItem('bk_chapter_read:' + BOOK_A + '/3'), '1', '本地已读 ch3 应保留');
            assert.equal(win.localStorage.getItem('bk_chapter_read:' + BOOK_A + '/5'), '1', 'ch5 应存在（本地+导入交集）');
            assert.equal(win.localStorage.getItem('bk_chapter_read:' + BOOK_A + '/7'), '1', '导入 ch7 应新增');
            assert.equal(win.localStorage.getItem('bk_chapter_read:' + BOOK_A + '/9'), '1', '导入 ch9 应新增');
        });
    });

    test('PDF 书签/高亮按 id 合并', function () {
        // 本地 PDF 书签/高亮
        win.localStorage.setItem('bk_pdf_bm:' + BOOK_A, JSON.stringify([
            { page: 1, id: 'pbm-1', label: '本地1' },
            { page: 2, id: 'pbm-2', label: '本地2' }
        ]));
        win.localStorage.setItem('bk_pdf_hl:' + BOOK_A, JSON.stringify([
            { page: 1, id: 'phl-1', text: '本地HL1' },
            { page: 2, id: 'phl-2', text: '本地HL2' }
        ]));

        var importPdfBm = JSON.stringify([
            { page: 2, id: 'pbm-2', label: '导入覆盖2' },
            { page: 3, id: 'pbm-3', label: '导入新3' }
        ]);
        var importPdfHl = JSON.stringify([
            { page: 2, id: 'phl-2', text: '导入HL2覆盖' },
            { page: 3, id: 'phl-3', text: '导入HL3' }
        ]);

        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, progress: '42', lastReadTs: '1800000000000', pdfBookmarks: importPdfBm, pdfHighlights: importPdfHl, bookmarks: [], highlights: [], scroll: {} } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            var bm = JSON.parse(win.localStorage.getItem('bk_pdf_bm:' + BOOK_A));
            assert.equal(bm.length, 3, 'PDF 书签合并后 3 条');
            var bm2 = bm.find(function (b) { return b.id === 'pbm-2'; });
            assert.equal(bm2.label, '导入覆盖2', '重复 id 被导入版替换');

            var hl = JSON.parse(win.localStorage.getItem('bk_pdf_hl:' + BOOK_A));
            assert.equal(hl.length, 3, 'PDF 高亮合并后 3 条');
            var hl2 = hl.find(function (h) { return h.id === 'phl-2'; });
            assert.equal(hl2.text, '导入HL2覆盖', '重复 id 被导入版替换');
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 书架合并
// ═══════════════════════════════════════════════════════════════════════
describe('书架合并', function () {
    beforeEach(function () {
        resetMocks();
    });

    test('导入书架记录：本地无 note/rating/finished 时用导入值', function () {
        // 本地已入架但无 note/rating/finished
        _mockShelf[BOOK_A] = { addedAt: '2026-08-01', status: 'collected', note: null, rating: null };

        var shelfData = [
            { id: BOOK_A, title: 'Book A', note: '导入笔记', rating: 5, finished: true, completedAt: '2026-08-15' }
        ];
        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, progress: '42', lastReadTs: '1800000000000', bookmarks: [], highlights: [], scroll: {} } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, shelfData, bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            var rec = _mockShelf[BOOK_A];
            assert.equal(rec.note, '导入笔记', 'note 应使用导入值');
            assert.equal(rec.rating, 5, 'rating 应使用导入值');
            assert.equal(rec.finished, true, 'finished 应为 true');
        });
    });

    test('本地已有 note 时不被覆盖', function () {
        _mockShelf[BOOK_A] = { addedAt: '2026-08-01', status: 'collected', note: '本地笔记', rating: 3, finished: false };

        var shelfData = [
            { id: BOOK_A, title: 'Book A', note: '导入笔记', rating: 5, finished: true, completedAt: '2026-08-15' }
        ];
        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, bookmarks: [], highlights: [], scroll: {} } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, shelfData, bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            var rec = _mockShelf[BOOK_A];
            assert.equal(rec.note, '本地笔记', 'note 不应被覆盖');
            assert.equal(rec.rating, 3, 'rating 不应被覆盖');
        });
    });

    test('本地无书架记录时入架并填入导入值', function () {
        var shelfData = [
            { id: BOOK_A, title: 'Book A', note: '新笔记', rating: 4, finished: false }
        ];
        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, bookmarks: [], highlights: [], scroll: {} } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, shelfData, bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            var rec = _mockShelf[BOOK_A];
            assert.ok(rec, '应入架');
            assert.equal(rec.note, '新笔记');
            assert.equal(rec.rating, 4);
            assert.equal(rec.finished, false);
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 书 ID 映射（任务5）
// ═══════════════════════════════════════════════════════════════════════
describe('书 ID 映射', function () {
    beforeEach(function () {
        resetMocks();
    });

    test('导入书 ID 重映射后书签 bookId 跟随改写', function () {
        // 导入书 BOOK_IMPORTED 不在书城索引，有 book.json → 应生成新 imported- 前缀 ID
        var bookJson = { id: BOOK_IMPORTED, title: 'Imported Book', format: 'epub', chapters: [{ num: 1, content: [{ type: 'html', html: '<p>ch1</p>' }] }] };
        var importedBookmarks = [
            { id: 'bm-imp-1', path: '/' + BOOK_IMPORTED + '/1', scrollY: 50, title: '导入书签', bookId: BOOK_IMPORTED, chapterNum: 1, note: '', timestamp: 2000 }
        ];
        var bookMap = {};
        bookMap[BOOK_IMPORTED] = { bookJson: bookJson, userdata: { schema: 3, bookmarks: importedBookmarks, highlights: [], scroll: {} } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            assert.equal(_mockBookmarks.length, 1, '应有 1 条书签');
            var bm = _mockBookmarks[0];
            assert.ok(bm.bookId.indexOf('imported-') === 0, 'bookId 应为新的 imported- 前缀 ID');
            assert.notEqual(bm.bookId, BOOK_IMPORTED, 'bookId 不应与旧 ID 相同');
            assert.ok(bm.path.indexOf('/' + BOOK_IMPORTED + '/') !== 0, 'path 不应含旧 ID');
        });
    });

    test('导入书高亮 key 中的 bookId 跟随改写', function () {
        var bookJson = { id: BOOK_IMPORTED, title: 'Imported Book', format: 'epub', chapters: [{ num: 1, content: [{ type: 'html', html: '<p>ch1</p>' }] }] };
        var importedHighlights = [
            { key: '/' + BOOK_IMPORTED + '/1', highlights: [
                { id: 'hl-imp-1', text: '导入高亮', note: '', timestamp: 2000 }
            ]}
        ];
        var bookMap = {};
        bookMap[BOOK_IMPORTED] = { bookJson: bookJson, userdata: { schema: 3, bookmarks: [], highlights: importedHighlights, scroll: {} } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            var keys = Object.keys(_mockHighlightStore);
            assert.equal(keys.length, 1, '应有 1 个高亮页');
            var newKey = keys[0];
            // key 应为 /imported-xxx/1，而非 /imported-old123/1
            assert.ok(newKey.match(/^\/imported-[^\/]+\/1$/), 'key 应使用新 imported- ID，实际=' + newKey);
        });
    });

    test('书城书 ID 恒等映射（不变）', function () {
        // BOOK_A 在书城索引中
        _mockCityIndex = { books: [{ id: BOOK_A, title: 'EPUB Book A' }] };

        var importedBookmarks = [
            { id: 'bm-imp-1', path: '/' + BOOK_A + '/1', scrollY: 50, title: '书城书签', bookId: BOOK_A, chapterNum: 1, note: '', timestamp: 2000 }
        ];
        var bookMap = {};
        bookMap[BOOK_A] = { userdata: { schema: 3, bookmarks: importedBookmarks, highlights: [], scroll: {} } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            assert.equal(_mockBookmarks.length, 1);
            assert.equal(_mockBookmarks[0].bookId, BOOK_A, '书城书 ID 应保持不变');
        });
    });

    test('进度/滚动 localStorage key 跟随新 ID', function () {
        var bookJson = { id: BOOK_IMPORTED, title: 'Imported Book', format: 'epub', chapters: [{ num: 1, content: [{ type: 'html', html: '<p>ch1</p>' }] }] };
        var bookMap = {};
        bookMap[BOOK_IMPORTED] = { bookJson: bookJson, userdata: { schema: 3, progress: '50', lastReadTs: '1800000000000', scroll: { '1': '200' }, bookmarks: [], highlights: [] } };

        return makeSyncZip({ version: 3, type: 'sync-data' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function () {
            // 需在 localStorage 中找到新 ID 对应的进度 key
            var newIdKey = null;
            for (var i = 0; i < win.localStorage.length; i++) {
                var k = win.localStorage.key(i);
                if (k && k.indexOf('bk_progress:imported-') === 0) {
                    newIdKey = k;
                    break;
                }
            }
            assert.ok(newIdKey, '应存在 bk_progress:imported-xxx key');
            assert.equal(win.localStorage.getItem(newIdKey), '50');
            // 滚动 key 也应跟随新 ID
            var scrollKey = null;
            for (var j = 0; j < win.localStorage.length; j++) {
                var sk = win.localStorage.key(j);
                if (sk && sk.indexOf('bk_scroll:imported-') === 0) {
                    scrollKey = sk;
                    break;
                }
            }
            assert.ok(scrollKey, '应存在 bk_scroll:imported-xxx/1 key');
            assert.equal(win.localStorage.getItem(scrollKey), '200');
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 旧版兼容（v1/v2 manifest）
// ═══════════════════════════════════════════════════════════════════════
describe('旧版 ZIP 兼容', function () {
    beforeEach(function () {
        resetMocks();
    });

    test('v2 manifest 委托给 ImportZip.importFromZip', function () {
        var bookJson = { id: BOOK_A, title: 'Book A', format: 'epub', chapters: [] };
        var bookMap = {};
        bookMap[BOOK_A] = { bookJson: bookJson };
        var delegated = false;
        var origImport = win.BK.ImportZip.importFromZip;
        win.BK.ImportZip.importFromZip = function (buf, fileName, opts) {
            delegated = true;
            return Promise.resolve({ success: 1, skipped: 0, failed: 0, errors: [] });
        };

        return makeSyncZip({ version: 2, type: 'books-export' }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function (result) {
            assert.ok(delegated, 'v2 应委托给 ImportZip.importFromZip');
            assert.equal(result.success, 1);
            win.BK.ImportZip.importFromZip = origImport;
        }).catch(function (err) {
            win.BK.ImportZip.importFromZip = origImport;
            throw err;
        });
    });

    test('v1 manifest 委托给 ImportZip.importFromZip', function () {
        var bookJson = { id: BOOK_A, title: 'Book A', format: 'epub', chapters: [] };
        var bookMap = {};
        bookMap[BOOK_A] = { bookJson: bookJson };
        var delegated = false;
        var origImport = win.BK.ImportZip.importFromZip;
        win.BK.ImportZip.importFromZip = function (buf, fileName, opts) {
            delegated = true;
            return Promise.resolve({ success: 1, skipped: 0, failed: 0, errors: [] });
        };

        return makeSyncZip({ version: 1 }, [], bookMap).then(function (bytes) {
            return win.BK.Sync.importFromZip(bytes);
        }).then(function (result) {
            assert.ok(delegated, 'v1 应委托给 ImportZip.importFromZip');
            assert.equal(result.success, 1);
            win.BK.ImportZip.importFromZip = origImport;
        }).catch(function (err) {
            win.BK.ImportZip.importFromZip = origImport;
            throw err;
        });
    });
});
