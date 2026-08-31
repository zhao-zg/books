'use strict';
/**
 * lan-sync 纯逻辑单元测试（node:test + JSDOM）
 *
 * 被测目标：src/static/js/sync/lan-sync.js 暴露的
 *   win.BK.LanSync.connect / pull / push / _handleInfo / _handleDownload / _handleUpload
 *
 * 加载方式：JSDOM + vm.runInThisContext
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

// ── 加载真正的 JSZip ─────────────────────────────────────────────────────
const jszipPath = join(__dirname, '..', '..', 'src', 'static', 'vendor', 'jszip.min.js');
const jszipCode = readFileSync(jszipPath, 'utf-8');
vm.runInThisContext(jszipCode, { filename: jszipPath, displayErrors: true });

// ── Mock 依赖 ───────────────────────────────────────────────────────────
function setupMocks() {
    win.BK = win.BK || {};
    win.BK.Sync = win.BK.Sync || {};

    // mock generateZipBytes
    win.BK.Sync.generateZipBytes = function (bookIds, opts) {
        var zip = new win.JSZip();
        zip.file('manifest.json', JSON.stringify({ version: 3, type: 'sync-data', bookCount: bookIds.length }));
        zip.file('shelf.json', '[]');
        return zip.generateAsync({ type: 'uint8array' });
    };

    // mock importFromZip
    win.BK.Sync.importFromZip = function (buffer) {
        return Promise.resolve({ success: 2, failed: 0, errors: [] });
    };

    // mock BKShelf
    win.BKShelf = {
        all: function () {
            return [
                { bookId: 'book1', title: '测试书1' },
                { bookId: 'book2', title: '测试书2' }
            ];
        }
    };

    // mock Capacitor
    win.Capacitor = {
        Plugins: {
            LanSync: {
                startServer: function (opts) {
                    return Promise.resolve({ port: 18080, pairCode: '123456', ipAddress: '192.168.1.5' });
                },
                stopServer: function () { return Promise.resolve(); },
                getStatus: function () { return Promise.resolve({ running: true }); },
                deliverResult: function (opts) { return Promise.resolve(); },
                registerNsd: function () { return Promise.resolve(); },
                unregisterNsd: function () { return Promise.resolve(); }
            }
        }
    };

    // mock fetch
    win._fetchCalls = [];
    win.fetch = function (url, opts) {
        win._fetchCalls.push({ url: url, opts: opts });
        // 默认返回 /info 的响应
        if (url.indexOf('/info') > -1) {
            return Promise.resolve({
                ok: true,
                json: function () { return Promise.resolve({ name: '设备B', version: '1.0', books: [{ id: 'b1', title: '书B' }] }); }
            });
        }
        if (url.indexOf('/download') > -1) {
            // 返回一个最小 ZIP
            var zip = new win.JSZip();
            zip.file('manifest.json', '{"version":3,"type":"sync-data","bookCount":1}');
            zip.file('shelf.json', '[]');
            zip.folder('books').folder('b1').file('userdata.json', '{"progress":"50"}');
            return zip.generateAsync({ type: 'arraybuffer' }).then(function (buf) {
                return { ok: true, arrayBuffer: function () { return Promise.resolve(buf); } };
            });
        }
        if (url.indexOf('/upload') > -1) {
            return Promise.resolve({
                ok: true,
                json: function () { return Promise.resolve({ success: 2, failed: 0, errors: [] }); }
            });
        }
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });
    };

    // mock btoa/atob
    win.btoa = function (str) { return Buffer.from(str, 'binary').toString('base64'); };
    win.atob = function (b64) { return Buffer.from(b64, 'base64').toString('binary'); };
}

// ── 加载被测模块 ───────────────────────────────────────────────────────
function loadModule() {
    var srcPath = join(__dirname, '..', '..', 'src', 'static', 'js', 'sync', 'lan-sync.js');
    var code = readFileSync(srcPath, 'utf-8');
    vm.runInThisContext(code, { filename: srcPath, displayErrors: true });
}

describe('lan-sync.js', () => {
    beforeEach(() => {
        setupMocks();
        loadModule();
    });

    test('模块正确挂载到 win.BK.LanSync', () => {
        assert.ok(win.BK.LanSync, 'BK.LanSync 应存在');
        assert.strictEqual(typeof win.BK.LanSync.connect, 'function');
        assert.strictEqual(typeof win.BK.LanSync.pull, 'function');
        assert.strictEqual(typeof win.BK.LanSync.push, 'function');
        assert.strictEqual(typeof win.BK.LanSync._handleInfo, 'function');
        assert.strictEqual(typeof win.BK.LanSync._handleDownload, 'function');
        assert.strictEqual(typeof win.BK.LanSync._handleUpload, 'function');
    });

    test('isAvailable 检测 Capacitor 环境', () => {
        assert.strictEqual(win.BK.LanSync.isAvailable(), true);
        // PWA 环境无 Capacitor
        var savedCapacitor = win.Capacitor;
        delete win.Capacitor;
        assert.strictEqual(win.BK.LanSync.isAvailable(), false);
        win.Capacitor = savedCapacitor;
    });

    test('connect 调用 GET /info 并返回设备信息', async () => {
        var info = await win.BK.LanSync.connect('192.168.1.5', 18080, '123456');
        assert.strictEqual(info.name, '设备B');
        assert.ok(info.books.length > 0);
        assert.strictEqual(info.books[0].id, 'b1');
        // 验证 URL 格式
        assert.ok(win._fetchCalls[0].url.indexOf('http://192.168.1.5:18080/info') === 0);
        assert.ok(win._fetchCalls[0].url.indexOf('code=123456') > -1);
    });

    test('connect 错误配对码返回 403 时抛异常', async () => {
        win.fetch = function () {
            return Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden' });
        };
        await assert.rejects(
            win.BK.LanSync.connect('192.168.1.5', 18080, 'wrong'),
            /403/
        );
    });

    test('pull 调用 GET /download 并调用 importFromZip', async () => {
        var savedImport = win.BK.Sync.importFromZip;
        var importCalled = false;
        var importedBuffer = null;
        win.BK.Sync.importFromZip = function (buffer) {
            importCalled = true;
            importedBuffer = buffer;
            return Promise.resolve({ success: 1, failed: 0, errors: [] });
        };

        var result = await win.BK.LanSync.pull('192.168.1.5', 18080, '123456', { mode: 'data' });
        assert.ok(importCalled, '应调用 importFromZip');
        assert.ok(importedBuffer instanceof ArrayBuffer, '传给 importFromZip 的应为 ArrayBuffer');
        assert.strictEqual(result.success, 1);

        win.BK.Sync.importFromZip = savedImport;
    });

    test('pull 支持 mode=full 参数', async () => {
        await win.BK.LanSync.pull('192.168.1.5', 18080, '123456', { mode: 'full' });
        assert.ok(win._fetchCalls[win._fetchCalls.length - 1].url.indexOf('mode=full') > -1);
    });

    test('push 调用 generateZipBytes + POST /upload', async () => {
        var savedGen = win.BK.Sync.generateZipBytes;
        var genCalled = false;
        win.BK.Sync.generateZipBytes = function (bookIds, opts) {
            genCalled = true;
            assert.strictEqual(opts.mode, 'data');
            return savedGen(bookIds, opts);
        };

        var result = await win.BK.LanSync.push('192.168.1.5', 18080, '123456', { mode: 'data' });
        assert.ok(genCalled, '应调用 generateZipBytes');
        assert.strictEqual(result.success, 2);

        var uploadCall = win._fetchCalls.find(function (c) { return c.url.indexOf('/upload') > -1; });
        assert.ok(uploadCall, '应有 /upload fetch 调用');
        assert.strictEqual(uploadCall.opts.method, 'POST');
        assert.strictEqual(uploadCall.opts.headers['Content-Type'], 'application/zip');
        assert.ok(uploadCall.opts.body instanceof Uint8Array, 'POST body 应为 Uint8Array');

        win.BK.Sync.generateZipBytes = savedGen;
    });

    test('_handleInfo 返回设备信息 JSON 并调用 deliverResult', async () => {
        var delivered = null;
        win.Capacitor.Plugins.LanSync.deliverResult = function (opts) {
            delivered = opts;
            return Promise.resolve();
        };

        await win.BK.LanSync._handleInfo('req-001');
        assert.ok(delivered, '应调用 deliverResult');
        assert.strictEqual(delivered.requestId, 'req-001');
        var info = JSON.parse(delivered.data);
        assert.ok(info.name, 'info 应含 name');
        assert.ok(info.books, 'info 应含 books');
        assert.strictEqual(info.books.length, 2);
    });

    test('_handleDownload 生成 ZIP base64 并调用 deliverResult', async () => {
        var delivered = null;
        win.Capacitor.Plugins.LanSync.deliverResult = function (opts) {
            delivered = opts;
            return Promise.resolve();
        };

        await win.BK.LanSync._handleDownload('data', '', 'req-002');
        assert.ok(delivered, '应调用 deliverResult');
        assert.strictEqual(delivered.requestId, 'req-002');
        assert.ok(delivered.data.length > 0, 'data 应为非空 base64');
        // 验证 base64 可解码为有效 ZIP
        var bytes = new Uint8Array(Buffer.from(delivered.data, 'base64'));
        var zip = await win.JSZip.loadAsync(bytes);
        assert.ok(zip.file('manifest.json'), 'ZIP 应含 manifest.json');
    });

    test('_handleUpload 解码 base64 并调用 importFromZip', async () => {
        var importCalled = false;
        win.BK.Sync.importFromZip = function (buffer) {
            importCalled = true;
            assert.ok(buffer instanceof ArrayBuffer, '应为 ArrayBuffer');
            return Promise.resolve({ success: 2, failed: 0, errors: [] });
        };

        var delivered = null;
        win.Capacitor.Plugins.LanSync.deliverResult = function (opts) {
            delivered = opts;
            return Promise.resolve();
        };

        // 构造一个最小 ZIP 的 base64
        var zip = new win.JSZip();
        zip.file('manifest.json', '{"version":3,"type":"sync-data","bookCount":1}');
        zip.file('shelf.json', '[]');
        var bytes = await zip.generateAsync({ type: 'uint8array' });
        var base64 = win.btoa(String.fromCharCode.apply(null, bytes));

        await win.BK.LanSync._handleUpload(base64, 'req-003');
        assert.ok(importCalled, '应调用 importFromZip');
        assert.strictEqual(delivered.requestId, 'req-003');
        var result = JSON.parse(delivered.data);
        assert.strictEqual(result.success, 2);
    });

    test('_handleUpload 错误时返回 error JSON', async () => {
        win.BK.Sync.importFromZip = function () {
            return Promise.reject(new Error('导入失败测试'));
        };

        var delivered = null;
        win.Capacitor.Plugins.LanSync.deliverResult = function (opts) {
            delivered = opts;
            return Promise.resolve();
        };

        var zip = new win.JSZip();
        zip.file('manifest.json', '{}');
        var bytes = await zip.generateAsync({ type: 'uint8array' });
        var base64 = win.btoa(String.fromCharCode.apply(null, bytes));

        await win.BK.LanSync._handleUpload(base64, 'req-004');
        var result = JSON.parse(delivered.data);
        assert.strictEqual(result.success, 0);
        assert.ok(result.errors.length > 0);
    });
});