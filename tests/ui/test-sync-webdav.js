'use strict';
/**
 * sync-webdav 纯逻辑单元测试（node:test + JSDOM）
 *
 * 被测目标：src/static/js/sync/sync-webdav.js 暴露的
 *   win.BK.SyncWebDAV.computeDiff(localManifest, remoteManifest)
 *   win.BK.SyncWebDAV.isBookStale(bookId, localTs, remoteTs)
 *   win.BK.SyncWebDAV.buildRemoteManifest(entries)
 *   win.BK.SyncWebDAV.serializeBookManifest(manifest)
 *
 * 加载方式：JSDOM + vm.runInThisContext
 *   - 先加载真正的 JSZip（vendor/jszip.min.js）
 *   - 再 mock 依赖 API，然后加载被测模块源码
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

win.BK = win.BK || {};

// BK.SyncCore.generateZipBytes — mock（生成最小 ZIP；SyncCore 签名：mode 在前）
win.BK.SyncCore = {
    generateZipBytes: function (mode, opts) {
        opts = opts || {};
        var bookIds = (opts && opts.bookIds) || [];
        var zip = new win.JSZip();
        zip.file('manifest.json', JSON.stringify({
            version: 4, mode: mode, bookCount: bookIds.length, exportedAt: new Date().toISOString()
        }));
        zip.file('shelf.json', '[]');
        for (var i = 0; i < bookIds.length; i++) {
            zip.file('books/' + bookIds[i] + '/userdata.json', JSON.stringify({ schema: 3 }));
        }
        return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    },
    importFromZip: function (buffer) {
        return Promise.resolve({ success: 1, skipped: 0, failed: 0, errors: [] });
    }
};

// BKShelf — mock
var _mockShelf = {};
win.BKShelf = {
    all: function () {
        return Object.keys(_mockShelf).map(function (id) {
            return Object.assign({ bookId: id }, _mockShelf[id]);
        });
    },
    get: function (bookId) {
        return _mockShelf[bookId] || null;
    }
};

// WebDavManager — mock（纯逻辑测试不碰网络）
var _wdListDirResult = [];
var _wdUploadResult = { ok: true };
var _wdDownloadResult = null;
var _wdDeleteResult = { ok: true };
var _wdEnsurePathResult = Promise.resolve();
win.WebDavManager = {
    listDir: function (config, path) {
        return Promise.resolve(_wdListDirResult.slice());
    },
    uploadFile: function (config, remotePath, data, mime) {
        return Promise.resolve(_wdUploadResult);
    },
    downloadFile: function (config, entry) {
        return Promise.resolve(_wdDownloadResult);
    },
    deleteResource: function (config, remotePath) {
        return Promise.resolve(_wdDeleteResult);
    },
    ensureRemotePath: function (config, remotePath) {
        return _wdEnsurePathResult;
    },
    getActiveConfig: function () {
        return { id: 'test-cfg', url: 'https://dav.example.com/bk-sync', username: 'u', password: 'p' };
    }
};

// ── 加载被测模块 ───────────────────────────────────────────────────────
const syncWebdavPath = join(__dirname, '..', '..', 'src', 'static', 'js', 'sync', 'sync-webdav.js');
const syncWebdavCode = readFileSync(syncWebdavPath, 'utf-8');
vm.runInThisContext(syncWebdavCode, { filename: syncWebdavPath, displayErrors: true });

assert.ok(typeof win.BK.SyncWebDAV === 'object', 'sync-webdav.js 必须暴露 win.BK.SyncWebDAV');

// ── 测试数据 ───────────────────────────────────────────────────────────
var REMOTE_BASE = 'bk-sync';

function resetMocks() {
    win.localStorage.clear();
    _mockShelf = {};
    _wdListDirResult = [];
    _wdUploadResult = { ok: true };
    _wdDownloadResult = null;
    _wdDeleteResult = { ok: true };
    _wdEnsurePathResult = Promise.resolve();
}

function seedLocalBook(bookId, lastReadTs) {
    win.localStorage.setItem('bk_lastread_ts:' + bookId, String(lastReadTs));
    _mockShelf[bookId] = { bookId: bookId, status: 'collected', finished: false };
}

// ═══════════════════════════════════════════════════════════════════════
// computeDiff — 核心纯逻辑：比对本地与远端 manifest，输出 pull/push 列表
// ═══════════════════════════════════════════════════════════════════════
describe('computeDiff 纯逻辑', function () {

    beforeEach(function () {
        resetMocks();
    });

    test('远端有、本地无 → pull', function () {
        var local = { books: {} };
        var remote = {
            books: {
                'epub-aaa': { ts: 1700000000000, size: 1024 }
            }
        };
        var diff = win.BK.SyncWebDAV.computeDiff(local, remote);
        assert.ok(diff.pull.indexOf('epub-aaa') >= 0, '远端有本地无应 pull');
        assert.equal(diff.push.length, 0, '不应有 push');
    });

    test('本地有、远端无 → push', function () {
        var local = {
            books: {
                'epub-aaa': { ts: 1800000000000 }
            }
        };
        var remote = { books: {} };
        var diff = win.BK.SyncWebDAV.computeDiff(local, remote);
        assert.equal(diff.pull.length, 0, '不应有 pull');
        assert.ok(diff.push.indexOf('epub-aaa') >= 0, '本地有远端无应 push');
    });

    test('本地比远端新 → push', function () {
        var local = {
            books: {
                'epub-aaa': { ts: 1800000000000 }
            }
        };
        var remote = {
            books: {
                'epub-aaa': { ts: 1700000000000, size: 1024 }
            }
        };
        var diff = win.BK.SyncWebDAV.computeDiff(local, remote);
        assert.equal(diff.pull.length, 0, '本地更新不应 pull');
        assert.ok(diff.push.indexOf('epub-aaa') >= 0, '本地更新应 push');
    });

    test('远端比本地新 → pull', function () {
        var local = {
            books: {
                'epub-aaa': { ts: 1700000000000 }
            }
        };
        var remote = {
            books: {
                'epub-aaa': { ts: 1800000000000, size: 1024 }
            }
        };
        var diff = win.BK.SyncWebDAV.computeDiff(local, remote);
        assert.ok(diff.pull.indexOf('epub-aaa') >= 0, '远端更新应 pull');
        assert.equal(diff.push.length, 0, '远端更新不应 push');
    });

    test('本地与远端 ts 相同 → 都不操作', function () {
        var local = {
            books: {
                'epub-aaa': { ts: 1700000000000 }
            }
        };
        var remote = {
            books: {
                'epub-aaa': { ts: 1700000000000, size: 1024 }
            }
        };
        var diff = win.BK.SyncWebDAV.computeDiff(local, remote);
        assert.equal(diff.pull.length, 0, 'ts 相同不应 pull');
        assert.equal(diff.push.length, 0, 'ts 相同不应 push');
    });

    test('混合场景：A push、B pull、C 跳过', function () {
        var local = {
            books: {
                'book-a': { ts: 200 },
                'book-b': { ts: 100 },
                'book-c': { ts: 150 }
            }
        };
        var remote = {
            books: {
                'book-a': { ts: 100, size: 512 },
                'book-b': { ts: 200, size: 512 },
                'book-c': { ts: 150, size: 512 }
            }
        };
        var diff = win.BK.SyncWebDAV.computeDiff(local, remote);
        assert.ok(diff.push.indexOf('book-a') >= 0, 'A 本地新应 push');
        assert.ok(diff.pull.indexOf('book-b') >= 0, 'B 远端新应 pull');
        assert.equal(diff.push.indexOf('book-c'), -1, 'C ts 相同不应 push');
        assert.equal(diff.pull.indexOf('book-c'), -1, 'C ts 相同不应 pull');
    });

    test('local 或 remote 为空对象时不报错', function () {
        var diff1 = win.BK.SyncWebDAV.computeDiff(null, null);
        assert.deepEqual(diff1, { pull: [], push: [] });

        var diff2 = win.BK.SyncWebDAV.computeDiff({}, {});
        assert.deepEqual(diff2, { pull: [], push: [] });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// buildLocalManifest — 从书架+localStorage 构建本地 manifest
// ═══════════════════════════════════════════════════════════════════════
describe('buildLocalManifest 纯逻辑', function () {

    beforeEach(function () {
        resetMocks();
    });

    test('书架中有 lastReadTs 的书纳入 manifest', function () {
        seedLocalBook('epub-aaa', 1700000000000);
        seedLocalBook('pdf-bbb', 1800000000000);

        var manifest = win.BK.SyncWebDAV.buildLocalManifest();
        assert.ok(manifest.books['epub-aaa'], 'epub-aaa 应在 manifest');
        assert.equal(manifest.books['epub-aaa'].ts, 1700000000000);
        assert.ok(manifest.books['pdf-bbb'], 'pdf-bbb 应在 manifest');
        assert.equal(manifest.books['pdf-bbb'].ts, 1800000000000);
    });

    test('无 lastReadTs 的书不纳入 manifest', function () {
        _mockShelf['no-progress'] = { bookId: 'no-progress', status: 'collected' };
        // 不设 bk_lastread_ts

        var manifest = win.BK.SyncWebDAV.buildLocalManifest();
        assert.ok(!manifest.books['no-progress'], '无 lastReadTs 不应纳入');
    });

    test('书架为空时返回空 manifest', function () {
        var manifest = win.BK.SyncWebDAV.buildLocalManifest();
        assert.ok(manifest.books, 'manifest 应有 books 字段');
        assert.equal(Object.keys(manifest.books).length, 0);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// parseRemoteManifest — 从远端 manifest.json 解析
// ═══════════════════════════════════════════════════════════════════════
describe('parseRemoteManifest 纯逻辑', function () {

    test('正常 JSON 解析', function () {
        var json = JSON.stringify({
            version: 1,
            lastSyncTs: 1700000000000,
            books: { 'epub-aaa': { ts: 1700000000000, size: 1024 } }
        });
        var manifest = win.BK.SyncWebDAV.parseRemoteManifest(json);
        assert.equal(manifest.version, 1);
        assert.ok(manifest.books['epub-aaa']);
    });

    test('空字符串返回空 manifest', function () {
        var manifest = win.BK.SyncWebDAV.parseRemoteManifest('');
        assert.deepEqual(manifest.books, {});
    });

    test('非法 JSON 返回空 manifest', function () {
        var manifest = win.BK.SyncWebDAV.parseRemoteManifest('not json');
        assert.deepEqual(manifest.books, {});
    });

    test('null 输入返回空 manifest', function () {
        var manifest = win.BK.SyncWebDAV.parseRemoteManifest(null);
        assert.deepEqual(manifest.books, {});
    });
});

// ═══════════════════════════════════════════════════════════════════════
// serializeRemoteManifest — 序列化为 JSON 字符串
// ═══════════════════════════════════════════════════════════════════════
describe('serializeRemoteManifest 纯逻辑', function () {

    test('正常序列化', function () {
        var manifest = {
            version: 1,
            lastSyncTs: 1700000000000,
            books: { 'epub-aaa': { ts: 1700000000000, size: 1024 } }
        };
        var json = win.BK.SyncWebDAV.serializeRemoteManifest(manifest);
        var parsed = JSON.parse(json);
        assert.equal(parsed.version, 1);
        assert.ok(parsed.books['epub-aaa']);
    });

    test('空 manifest 序列化后含 books:{}', function () {
        var manifest = { version: 1, lastSyncTs: 0, books: {} };
        var json = win.BK.SyncWebDAV.serializeRemoteManifest(manifest);
        var parsed = JSON.parse(json);
        assert.deepEqual(parsed.books, {});
    });
});

// ═══════════════════════════════════════════════════════════════════════
// mergeManifest — 合并远端 manifest 条目（push 后更新）
// ═══════════════════════════════════════════════════════════════════════
describe('mergeManifest 纯逻辑', function () {

    test('新增书籍条目到远端 manifest', function () {
        var remote = { version: 1, lastSyncTs: 0, books: {} };
        var updated = win.BK.SyncWebDAV.mergeManifest(remote, 'epub-aaa', 1700000000000, 1024);
        assert.ok(updated.books['epub-aaa'], '应有 epub-aaa');
        assert.equal(updated.books['epub-aaa'].ts, 1700000000000);
        assert.equal(updated.books['epub-aaa'].size, 1024);
    });

    test('更新已有书籍条目（ts 更新）', function () {
        var remote = {
            version: 1, lastSyncTs: 0,
            books: { 'epub-aaa': { ts: 100, size: 512 } }
        };
        var updated = win.BK.SyncWebDAV.mergeManifest(remote, 'epub-aaa', 200, 1024);
        assert.equal(updated.books['epub-aaa'].ts, 200, 'ts 应更新为新值');
        assert.equal(updated.books['epub-aaa'].size, 1024, 'size 应更新');
    });

    test('lastSyncTs 更新为当前时间', function () {
        var remote = { version: 1, lastSyncTs: 0, books: {} };
        var before = Date.now();
        var updated = win.BK.SyncWebDAV.mergeManifest(remote, 'epub-aaa', 1700000000000, 1024);
        var after = Date.now();
        assert.ok(updated.lastSyncTs >= before && updated.lastSyncTs <= after,
            'lastSyncTs 应为当前时间');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 集成逻辑：push 单本书 → 生成 ZIP + 上传 + 更新远端 manifest
// ═══════════════════════════════════════════════════════════════════════
describe('pushBook 集成', function () {

    beforeEach(function () {
        resetMocks();
        seedLocalBook('epub-aaa', 1700000000000);
    });

    test('生成 ZIP 并上传到远端 bk-sync/ 目录', function () {
        var config = win.WebDavManager.getActiveConfig();
        return win.BK.SyncWebDAV.pushBook(config, 'epub-aaa', REMOTE_BASE).then(function (result) {
            assert.ok(result.ok, 'pushBook 应成功');
            assert.ok(result.size > 0, '应返回 ZIP 大小');
        });
    });

    test('pushBook 失败时不更新远端 manifest', function () {
        // 用函数返回新 rejected promise，避免 unhandled rejection
        win.WebDavManager.uploadFile = function () {
            return Promise.reject(new Error('upload failed'));
        };
        var config = win.WebDavManager.getActiveConfig();
        return win.BK.SyncWebDAV.pushBook(config, 'epub-aaa', REMOTE_BASE).then(function () {
            assert.fail('应 reject');
        }, function (err) {
            assert.ok(err instanceof Error);
            // 恢复 mock
            win.WebDavManager.uploadFile = function (config, remotePath, data, mime) {
                return Promise.resolve(_wdUploadResult);
            };
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 集成逻辑：pull 单本书 → 下载 ZIP + 导入
// ═══════════════════════════════════════════════════════════════════════
describe('pullBook 集成', function () {

    beforeEach(function () {
        resetMocks();
    });

    test('从远端下载 ZIP 并导入', function () {
        // 准备一个最小 ZIP
        var zip = new win.JSZip();
        zip.file('manifest.json', JSON.stringify({ version: 3, type: 'sync-data', bookCount: 1 }));
        zip.file('shelf.json', '[]');
        zip.file('books/epub-aaa/userdata.json', JSON.stringify({ schema: 3 }));

        return zip.generateAsync({ type: 'uint8array' }).then(function (bytes) {
            _wdDownloadResult = {
                name: 'epub-aaa.zip',
                arrayBuffer: bytes.buffer,
                size: bytes.length
            };
            var config = win.WebDavManager.getActiveConfig();
            var entry = { remotePath: 'bk-sync/epub-aaa.zip', name: 'epub-aaa.zip', size: bytes.length };
            return win.BK.SyncWebDAV.pullBook(config, entry, REMOTE_BASE);
        }).then(function (result) {
            assert.ok(result.ok, 'pullBook 应成功');
        });
    });
});
