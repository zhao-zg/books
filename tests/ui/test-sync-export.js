'use strict';
/**
 * sync-export 纯逻辑单元测试（node:test + JSDOM）
 *
 * 被测目标：src/static/js/sync/sync-export.js 暴露的
 *   win.BK.Sync.exportData(bookIds, opts)
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

// ── 加载真正的 JSZip（用于生成 + 解压验证）─────────────────────────────
const jszipPath = join(__dirname, '..', '..', 'src', 'static', 'vendor', 'jszip.min.js');
const jszipCode = readFileSync(jszipPath, 'utf-8');
vm.runInThisContext(jszipCode, { filename: jszipPath, displayErrors: true });
assert.ok(win.JSZip, 'JSZip 必须在 window 上可用');

// ── Mock 依赖 API ───────────────────────────────────────────────────────
// 这些 mock 在加载被测模块前注入 win，IIFE 闭包会捕获到它们

// 1. BK.SyncData.collectUserData（模拟任务1实现）
win.BK = win.BK || {};
win.BK.SyncData = {
    collectUserData: function (bookId) {
        // 模拟 localStorage 数据收集
        var data = {};
        var progress = win.localStorage.getItem('bk_progress:' + bookId);
        if (progress !== null) data.progress = progress;
        var lastReadTs = win.localStorage.getItem('bk_lastread_ts:' + bookId);
        if (lastReadTs !== null) data.lastReadTs = lastReadTs;
        var chapterReads = [];
        var prefix = 'bk_chapter_read:' + bookId + '/';
        for (var i = 0; i < win.localStorage.length; i++) {
            var key = win.localStorage.key(i);
            if (key && key.indexOf(prefix) === 0 && win.localStorage.getItem(key) === '1') {
                chapterReads.push(key.substring(prefix.length));
            }
        }
        if (chapterReads.length) data.chapterReads = chapterReads;
        var hasData = data.progress != null || data.lastReadTs || data.chapterReads;
        return hasData ? data : null;
    }
};

// 2. BKBookmark.getAll — 模拟 EPUB 书签
var _mockBookmarks = [];
win.BKBookmark = {
    getAll: function () {
        return Promise.resolve(_mockBookmarks.slice());
    }
};

// 3. BKStorage.getAllPages — 模拟 EPUB 高亮
var _mockHighlightPages = [];
win.BKStorage = {
    getAllPages: function () {
        return Promise.resolve(_mockHighlightPages.slice());
    }
};

// 4. BKShelf.all — 模拟书架
var _mockShelf = [];
win.BKShelf = {
    all: function () {
        return _mockShelf.slice();
    }
};

// 4b. ImportManager — 模拟导入书数据 + PDF 二进制存储（mode='full' 用）
var _mockImportedBooks = {};   // { bookId: bookData | null }
var _mockPdfStoreData = {};    // { 'pdf:<bookId>': ArrayBuffer | Uint8Array }
var _mockPdfStore = {
    getItem: function (key) {
        return Promise.resolve(_mockPdfStoreData.hasOwnProperty(key) ? _mockPdfStoreData[key] : null);
    }
};
win.ImportManager = {
    getImportedBook: function (bookId) {
        return Promise.resolve(_mockImportedBooks.hasOwnProperty(bookId) ? _mockImportedBooks[bookId] : null);
    },
    getPdfDataStore: function () {
        return _mockPdfStore;
    }
};

// 4c. DataManager — 降级数据源（ImportManager 无数据时用）
var _mockDmBooks = {};  // { bookId: bookData | null }
win.DataManager = {
    getBook: function (bookId) {
        return Promise.resolve(_mockDmBooks.hasOwnProperty(bookId) ? _mockDmBooks[bookId] : null);
    }
};

// 5. BK.Export.exportBinary — 拦截调用，保存参数供断言
var _exportBinaryCalls = [];
win.BK.Export = {
    exportBinary: function (bytes, filename, mime, opts) {
        _exportBinaryCalls.push({ bytes: bytes, filename: filename, mime: mime, opts: opts });
        return Promise.resolve({ saved: true });
    }
};

// ── 加载被测模块 ───────────────────────────────────────────────────────
const syncExportPath = join(__dirname, '..', '..', 'src', 'static', 'js', 'sync', 'sync-export.js');
const syncExportCode = readFileSync(syncExportPath, 'utf-8');
vm.runInThisContext(syncExportCode, { filename: syncExportPath, displayErrors: true });

assert.ok(typeof win.BK.Sync === 'object', 'sync-export.js 必须暴露 win.BK.Sync');
assert.ok(typeof win.BK.Sync.exportData === 'function', 'sync-export.js 必须暴露 win.BK.Sync.exportData 函数');

// ── 测试数据 ────────────────────────────────────────────────────────────
const BOOK_A = 'epub-aaa';
const BOOK_B = 'pdf-bbb';

// PDF 模拟二进制（区别于普通字符串，用于验证 original.pdf 内容完整性）
var _pdfBinary = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]); // "%PDF-1.4"

function seedLocalStorage(ls) {
    // Book A 阅读数据
    ls.setItem('bk_progress:' + BOOK_A, '42');
    ls.setItem('bk_lastread_ts:' + BOOK_A, '1700000000000');
    ls.setItem('bk_chapter_read:' + BOOK_A + '/3', '1');
    ls.setItem('bk_chapter_read:' + BOOK_A + '/5', '1');
    // Book A 滚动位置
    ls.setItem('bk_scroll:' + BOOK_A + '/3', '123');
    ls.setItem('bk_scroll:' + BOOK_A + '/5', '456');

    // Book B 阅读数据
    ls.setItem('bk_progress:' + BOOK_B, '80');
    ls.setItem('bk_lastread_ts:' + BOOK_B, '1800000000000');
    ls.setItem('bk_scroll:' + BOOK_B + '/1', '200');
}

function seedMocks() {
    _mockBookmarks = [
        { id: 'bm1', path: '/epub-aaa/3', scrollY: 100, title: '书签A1', bookId: BOOK_A, chapterNum: 3, note: '', timestamp: 1700000000001 },
        { id: 'bm2', path: '/pdf-bbb/1', scrollY: 50, title: '书签B1', bookId: BOOK_B, chapterNum: 1, note: 'note', timestamp: 1800000000001 }
    ];
    _mockHighlightPages = [
        { key: '/' + BOOK_A + '/3', highlights: [{ id: 'h1', text: '划线A', note: '笔记A', timestamp: 1700000000002 }] },
        { key: '/' + BOOK_A + '/5', highlights: [{ id: 'h2', text: '划线A2', note: '', timestamp: 1700000000003 }] },
        { key: '/' + BOOK_B + '/1', highlights: [{ id: 'h3', text: '划线B', note: '', timestamp: 1800000000002 }] }
    ];
    _mockShelf = [
        { bookId: BOOK_A, title: 'EPUB Book A', format: 'epub' },
        { bookId: BOOK_B, title: 'PDF Book B', format: 'pdf' }
    ];
    // full 模式书籍数据
    _mockImportedBooks[BOOK_A] = {
        id: BOOK_A, title: 'EPUB Book A', format: 'epub',
        chapters: [{ num: 1, content: [{ type: 'html', html: '<p>ch1</p>' }] }]
    };
    _mockImportedBooks[BOOK_B] = {
        id: BOOK_B, title: 'PDF Book B', format: 'pdf',
        chapters: [{ num: 1, content: [{ type: 'pdf_page', pageNumber: 1, pdfBookId: BOOK_B }] }]
    };
    _mockPdfStoreData['pdf:' + BOOK_B] = _pdfBinary;
    _mockDmBooks = {}; // 降级源默认空，个别测试需时再设
}

// ── 解压 ZIP 并返回文件内容 ─────────────────────────────────────────────
function unzipToMap(bytes) {
    var zip = new win.JSZip();
    return zip.loadAsync(bytes).then(function (loaded) {
        var result = {};
        var files = Object.keys(loaded.files);
        var promises = files.map(function (name) {
            var entry = loaded.files[name];
            if (entry.dir) {
                result[name] = { dir: true };
                return Promise.resolve();
            }
            return entry.async('string').then(function (content) {
                result[name] = { content: content };
            });
        });
        return Promise.all(promises).then(function () { return result; });
    });
}

// ── 解压 ZIP 并返回文件内容（含二进制） ─────────────────────────────────
function unzipToMapBinary(bytes) {
    var zip = new win.JSZip();
    return zip.loadAsync(bytes).then(function (loaded) {
        var result = {};
        var files = Object.keys(loaded.files);
        var promises = files.map(function (name) {
            var entry = loaded.files[name];
            if (entry.dir) {
                result[name] = { dir: true };
                return Promise.resolve();
            }
            return entry.async('uint8array').then(function (content) {
                result[name] = { content: content };
            });
        });
        return Promise.all(promises).then(function () { return result; });
    });
}

// ── 测试 ───────────────────────────────────────────────────────────────
describe('BK.Sync.exportData (mode:data)', function () {
    beforeEach(function () {
        win.localStorage.clear();
        _exportBinaryCalls = [];
        seedLocalStorage(win.localStorage);
        seedMocks();
        // 恢复 win.BK.Export（回归测试会覆盖它）
        win.BK.Export = {
            exportBinary: function (bytes, filename, mime, opts) {
                _exportBinaryCalls.push({ bytes: bytes, filename: filename, mime: mime, opts: opts });
                return Promise.resolve({ saved: true });
            }
        };
    });

    test('返回 Promise', function () {
        var result = win.BK.Sync.exportData([BOOK_A], { mode: 'data' });
        assert.ok(result instanceof Promise, '应返回 Promise');
        return result;
    });

    test('exportBinary 被调用，传入可解压的 ZIP bytes', function () {
        return win.BK.Sync.exportData([BOOK_A, BOOK_B], { mode: 'data' }).then(function () {
            assert.equal(_exportBinaryCalls.length, 1, 'exportBinary 应被调用一次');
            var call = _exportBinaryCalls[0];
            assert.equal(call.mime, 'application/zip');
            assert.ok(call.bytes instanceof Uint8Array, 'bytes 应为 Uint8Array');
            assert.ok(call.bytes.length > 0, 'bytes 不应为空');
            assert.ok(call.filename.indexOf('bk-sync-export-') === 0, '文件名应以 bk-sync-export- 开头');
            assert.ok(call.filename.endsWith('.zip'), '文件名应以 .zip 结尾');
            assert.equal(call.opts.chooseDestination, true);
            assert.ok(call.opts.successMsg, '应有 successMsg');
        });
    });

    test('ZIP 含 manifest.json（version=3, type=sync-data）', function () {
        return win.BK.Sync.exportData([BOOK_A], { mode: 'data' }).then(function () {
            var bytes = _exportBinaryCalls[0].bytes;
            return unzipToMap(bytes);
        }).then(function (files) {
            assert.ok(files['manifest.json'], '必须含 manifest.json');
            var manifest = JSON.parse(files['manifest.json'].content);
            assert.equal(manifest.version, 3);
            assert.equal(manifest.type, 'sync-data');
            assert.ok(manifest.exportDate, 'manifest 应有 exportDate');
            assert.equal(manifest.bookCount, 1);
        });
    });

    test('ZIP 含 shelf.json（内容等于 BKShelf.all()）', function () {
        return win.BK.Sync.exportData([BOOK_A, BOOK_B], { mode: 'data' }).then(function () {
            var bytes = _exportBinaryCalls[0].bytes;
            return unzipToMap(bytes);
        }).then(function (files) {
            assert.ok(files['shelf.json'], '必须含 shelf.json');
            var shelf = JSON.parse(files['shelf.json'].content);
            assert.deepEqual(shelf, _mockShelf);
            // 书架记录字段必须为 bookId（与 shelf.js 契约一致），不能是 id
            assert.equal(shelf[0].bookId, BOOK_A, '书架记录字段应为 bookId');
            assert.equal(shelf[1].bookId, BOOK_B, '书架记录字段应为 bookId');
            assert.ok(!('id' in shelf[0]), '书架记录不应含 id 字段');
        });
    });

    test('含 books/<id>/userdata.json，有 schema:3/bookmarks/highlights/scroll', function () {
        return win.BK.Sync.exportData([BOOK_A, BOOK_B], { mode: 'data' }).then(function () {
            var bytes = _exportBinaryCalls[0].bytes;
            return unzipToMap(bytes);
        }).then(function (files) {
            // Book A
            var udAPath = 'books/' + BOOK_A + '/userdata.json';
            assert.ok(files[udAPath], '必须含 ' + udAPath);
            var udA = JSON.parse(files[udAPath].content);
            assert.equal(udA.schema, 3, 'schema 应为 3');
            assert.equal(udA.progress, '42');
            assert.deepEqual(udA.chapterReads, ['3', '5']);
            // bookmarks：只有 BOOK_A 的书签
            assert.ok(Array.isArray(udA.bookmarks), 'bookmarks 应为数组');
            assert.equal(udA.bookmarks.length, 1);
            assert.equal(udA.bookmarks[0].id, 'bm1');
            // highlights：只有 BOOK_A 的高亮页
            assert.ok(Array.isArray(udA.highlights), 'highlights 应为数组');
            assert.equal(udA.highlights.length, 2);
            assert.equal(udA.highlights[0].key, '/' + BOOK_A + '/3');
            // scroll：章内滚动位置
            assert.ok(typeof udA.scroll === 'object', 'scroll 应为对象');
            assert.equal(udA.scroll['3'], '123');
            assert.equal(udA.scroll['5'], '456');

            // Book B
            var udBPath = 'books/' + BOOK_B + '/userdata.json';
            assert.ok(files[udBPath], '必须含 ' + udBPath);
            var udB = JSON.parse(files[udBPath].content);
            assert.equal(udB.schema, 3);
            assert.equal(udB.progress, '80');
            assert.equal(udB.bookmarks.length, 1);
            assert.equal(udB.bookmarks[0].id, 'bm2');
            assert.equal(udB.highlights.length, 1);
            assert.equal(udB.highlights[0].key, '/' + BOOK_B + '/1');
            assert.equal(udB.scroll['1'], '200');
        });
    });

    test('data 模式不含 book.json 或 original.pdf', function () {
        return win.BK.Sync.exportData([BOOK_A, BOOK_B], { mode: 'data' }).then(function () {
            var bytes = _exportBinaryCalls[0].bytes;
            return unzipToMap(bytes);
        }).then(function (files) {
            assert.ok(!files['books/' + BOOK_A + '/book.json'], '不应含 book.json');
            assert.ok(!files['books/' + BOOK_A + '/original.pdf'], '不应含 original.pdf');
            assert.ok(!files['books/' + BOOK_B + '/book.json'], '不应含 book.json');
            assert.ok(!files['books/' + BOOK_B + '/original.pdf'], '不应含 original.pdf');
        });
    });

    test('collectUserData 返回 null 时仍写入最小 userdata（schema:3 + 空数组）', function () {
        // 清除 BOOK_B 的所有 localStorage 数据
        win.localStorage.removeItem('bk_progress:' + BOOK_B);
        win.localStorage.removeItem('bk_lastread_ts:' + BOOK_B);
        win.localStorage.removeItem('bk_scroll:' + BOOK_B + '/1');

        return win.BK.Sync.exportData([BOOK_B], { mode: 'data' }).then(function () {
            var bytes = _exportBinaryCalls[0].bytes;
            return unzipToMap(bytes);
        }).then(function (files) {
            var udPath = 'books/' + BOOK_B + '/userdata.json';
            assert.ok(files[udPath], '即使无 localStorage 数据也应写入 userdata.json');
            var ud = JSON.parse(files[udPath].content);
            assert.equal(ud.schema, 3);
            assert.equal(ud.progress, undefined);
            assert.deepEqual(ud.bookmarks, [{ id: 'bm2', path: '/pdf-bbb/1', scrollY: 50, title: '书签B1', bookId: BOOK_B, chapterNum: 1, note: 'note', timestamp: 1800000000001 }]);
            assert.ok(Array.isArray(ud.highlights));
            assert.deepEqual(ud.scroll, {});
        });
    });

    test('无 bookIds 时 reject', function () {
        return win.BK.Sync.exportData([], { mode: 'data' }).then(function () {
            assert.fail('应 reject');
        }, function (err) {
            assert.ok(err instanceof Error);
            assert.ok(err.message);
        });
    });

    test('文件名含当前日期', function () {
        return win.BK.Sync.exportData([BOOK_A], { mode: 'data' }).then(function () {
            var filename = _exportBinaryCalls[0].filename;
            var date = new Date();
            var dateStr = date.getFullYear() + '-' +
                ('0' + (date.getMonth() + 1)).slice(-2) + '-' +
                ('0' + date.getDate()).slice(-2);
            assert.ok(filename.indexOf(dateStr) > 0, '文件名应含日期 ' + dateStr + '，实际=' + filename);
        });
    });

    test('generateZipBytes 返回 Uint8Array 且可被 JSZip 解压', async () => {
        // 准备：mock shelf + localStorage 数据
        win.BKShelf = { all: function () { return [{ bookId: 'book1', title: '测试书1' }]; } };
        win.localStorage.setItem('bk_progress:book1', '50');
        win.localStorage.setItem('bk_lastread_ts:book1', '1700000000000');

        assert.ok(win.BK.Sync.generateZipBytes, 'generateZipBytes 应已暴露');
        var bytes = await win.BK.Sync.generateZipBytes(['book1'], { mode: 'data' });

        assert.ok(bytes instanceof Uint8Array, '应返回 Uint8Array');
        assert.ok(bytes.length > 0, 'ZIP 不应为空');

        // 验证 ZIP 内容结构
        var zip = await win.JSZip.loadAsync(bytes);
        assert.ok(zip.file('manifest.json'), '应含 manifest.json');
        assert.ok(zip.file('shelf.json'), '应含 shelf.json');
        assert.ok(zip.folder('books'), '应含 books/ 文件夹');

        var manifest = JSON.parse(await zip.file('manifest.json').async('string'));
        assert.strictEqual(manifest.version, 3);
        assert.strictEqual(manifest.type, 'sync-data');
        assert.strictEqual(manifest.bookCount, 1);
    });

    test('exportData 仍然正常工作（回归测试）', async () => {
        win.BKShelf = { all: function () { return [{ bookId: 'book1', title: '测试书1' }]; } };
        win.localStorage.setItem('bk_progress:book1', '50');
        // mock exportBinary 避免实际下载
        var exportedBytes = null;
        win.BK.Export = { exportBinary: function (bytes, name, mime, opts) {
            exportedBytes = bytes;
            return Promise.resolve({});
        }};

        await win.BK.Sync.exportData(['book1'], { mode: 'data' });
        assert.ok(exportedBytes instanceof Uint8Array, 'exportData 仍应通过 exportBinary 落地');
        assert.ok(exportedBytes.length > 0, '导出的 ZIP 不应为空');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// mode='full' 测试
// ═══════════════════════════════════════════════════════════════════════
describe('BK.Sync.exportData (mode:full)', function () {
    beforeEach(function () {
        win.localStorage.clear();
        _exportBinaryCalls = [];
        seedLocalStorage(win.localStorage);
        seedMocks();
        // 恢复 win.BK.Export（回归测试会覆盖它）
        win.BK.Export = {
            exportBinary: function (bytes, filename, mime, opts) {
                _exportBinaryCalls.push({ bytes: bytes, filename: filename, mime: mime, opts: opts });
                return Promise.resolve({ saved: true });
            }
        };
    });

    test('full 模式 ZIP 含 books/<bookId>/book.json，内容等于 mock bookData', function () {
        return win.BK.Sync.exportData([BOOK_A, BOOK_B], { mode: 'full' }).then(function () {
            var bytes = _exportBinaryCalls[0].bytes;
            return unzipToMap(bytes);
        }).then(function (files) {
            var bjAPath = 'books/' + BOOK_A + '/book.json';
            var bjBPath = 'books/' + BOOK_B + '/book.json';
            assert.ok(files[bjAPath], '必须含 ' + bjAPath);
            assert.ok(files[bjBPath], '必须含 ' + bjBPath);
            var bjA = JSON.parse(files[bjAPath].content);
            var bjB = JSON.parse(files[bjBPath].content);
            assert.equal(bjA.id, BOOK_A);
            assert.equal(bjA.format, 'epub');
            assert.equal(bjB.id, BOOK_B);
            assert.equal(bjB.format, 'pdf');
        });
    });

    test('full 模式 PDF 书含 books/<bookId>/original.pdf，二进制内容正确', function () {
        return win.BK.Sync.exportData([BOOK_B], { mode: 'full' }).then(function () {
            var bytes = _exportBinaryCalls[0].bytes;
            return unzipToMapBinary(bytes);
        }).then(function (files) {
            var pdfPath = 'books/' + BOOK_B + '/original.pdf';
            assert.ok(files[pdfPath], 'PDF 书必须含 ' + pdfPath);
            var pdfBytes = files[pdfPath].content;
            assert.ok(pdfBytes instanceof Uint8Array, 'original.pdf 应为 Uint8Array');
            assert.equal(pdfBytes.length, _pdfBinary.length);
            for (var i = 0; i < _pdfBinary.length; i++) {
                assert.equal(pdfBytes[i], _pdfBinary[i], 'byte ' + i + ' 应匹配');
            }
        });
    });

    test('full 模式非 PDF 书不含 original.pdf', function () {
        return win.BK.Sync.exportData([BOOK_A], { mode: 'full' }).then(function () {
            var bytes = _exportBinaryCalls[0].bytes;
            return unzipToMap(bytes);
        }).then(function (files) {
            assert.ok(!files['books/' + BOOK_A + '/original.pdf'],
                'EPUB 书不应含 original.pdf');
        });
    });

    test('full 模式仍含 userdata.json（schema:3 + bookmarks + highlights + scroll）', function () {
        return win.BK.Sync.exportData([BOOK_A, BOOK_B], { mode: 'full' }).then(function () {
            var bytes = _exportBinaryCalls[0].bytes;
            return unzipToMap(bytes);
        }).then(function (files) {
            var udAPath = 'books/' + BOOK_A + '/userdata.json';
            var udBPath = 'books/' + BOOK_B + '/userdata.json';
            assert.ok(files[udAPath], 'full 模式也必须含 ' + udAPath);
            assert.ok(files[udBPath], 'full 模式也必须含 ' + udBPath);
            var udA = JSON.parse(files[udAPath].content);
            var udB = JSON.parse(files[udBPath].content);
            assert.equal(udA.schema, 3);
            assert.equal(udA.progress, '42');
            assert.equal(udA.bookmarks.length, 1);
            assert.equal(udA.highlights.length, 2);
            assert.equal(udA.scroll['3'], '123');
            assert.equal(udB.schema, 3);
            assert.equal(udB.progress, '80');
            assert.equal(udB.bookmarks.length, 1);
            assert.equal(udB.highlights.length, 1);
            assert.equal(udB.scroll['1'], '200');
        });
    });

    test('full 模式仍含 shelf.json 和 manifest.json', function () {
        return win.BK.Sync.exportData([BOOK_A, BOOK_B], { mode: 'full' }).then(function () {
            var bytes = _exportBinaryCalls[0].bytes;
            return unzipToMap(bytes);
        }).then(function (files) {
            assert.ok(files['shelf.json'], 'full 模式必须有 shelf.json');
            assert.ok(files['manifest.json'], 'full 模式必须有 manifest.json');
            var manifest = JSON.parse(files['manifest.json'].content);
            assert.equal(manifest.version, 3);
            assert.equal(manifest.type, 'sync-data');
            assert.equal(manifest.bookCount, 2);
        });
    });

    test('full 模式 ImportManager 无数据时降级 DataManager', function () {
        // ImportManager 无 BOOK_A 数据，降级到 DataManager
        _mockImportedBooks[BOOK_A] = null;
        _mockDmBooks[BOOK_A] = {
            id: BOOK_A, title: 'EPUB Book A (from DM)', format: 'epub',
            chapters: []
        };
        return win.BK.Sync.exportData([BOOK_A], { mode: 'full' }).then(function () {
            var bytes = _exportBinaryCalls[0].bytes;
            return unzipToMap(bytes);
        }).then(function (files) {
            var bjPath = 'books/' + BOOK_A + '/book.json';
            assert.ok(files[bjPath], '降级后仍应有 book.json');
            var bj = JSON.parse(files[bjPath].content);
            assert.equal(bj.title, 'EPUB Book A (from DM)');
        });
    });

    test('full 模式书籍数据不存在时不写 book.json 但仍写 userdata.json', function () {
        var missingId = 'missing-xxx';
        return win.BK.Sync.exportData([missingId], { mode: 'full' }).then(function () {
            var bytes = _exportBinaryCalls[0].bytes;
            return unzipToMap(bytes);
        }).then(function (files) {
            assert.ok(!files['books/' + missingId + '/book.json'],
                '数据不存在的书不应含 book.json');
            assert.ok(!files['books/' + missingId + '/original.pdf'],
                '数据不存在的书不应含 original.pdf');
            assert.ok(files['books/' + missingId + '/userdata.json'],
                '即使书籍数据缺失，userdata.json 仍应写入');
        });
    });
});
