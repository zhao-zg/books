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
var _dialogStack = [];

function setupMocks() {
    win.BK = win.BK || {};
    win.BK.SyncCore = win.BK.SyncCore || {};

    // mock generateZipBytes
    win.BK.SyncCore.generateZipBytes = function (bookIds, opts) {
        var zip = new win.JSZip();
        zip.file('manifest.json', JSON.stringify({ version: 3, type: 'sync-data', bookCount: bookIds.length }));
        zip.file('shelf.json', '[]');
        return zip.generateAsync({ type: 'uint8array' });
    };

    // mock importFromZip
    win.BK.SyncCore.importFromZip = function (buffer) {
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
                    return Promise.resolve({ port: 18080, ipAddress: '192.168.1.5' });
                },
                stopServer: function () { return Promise.resolve(); },
                getStatus: function () { return Promise.resolve({ running: true }); },
                deliverResult: function (opts) { return Promise.resolve(); },
                registerNsd: function () { return Promise.resolve(); },
                unregisterNsd: function () { return Promise.resolve(); },
                discover: function () { return Promise.resolve(); },
                stopDiscover: function () { return Promise.resolve(); }
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

    // 清理上一轮测试遗留的弹窗 DOM
    document.body.innerHTML = '';

    // mock backStack + openDialog（_handleUpload 接收确认框依赖；返回契约与真实实现一致）
    win.BK.backStack = {
        push: function (cb) { _dialogStack.push(cb); },
        pop: function () { _dialogStack.pop(); },
        discard: function () { _dialogStack.pop(); },
        silentPop: function () { _dialogStack.pop(); },
        size: function () { return _dialogStack.length; }
    };
    win.BK.openDialog = function (opts) {
        if (opts.id && document.getElementById(opts.id)) return null; // 同 id 防重复
        var mask = document.createElement('div');
        mask.className = opts.className || 'bk-dialog-mask';
        if (opts.id) mask.id = opts.id;
        mask.innerHTML = opts.html;
        document.body.appendChild(mask);
        var closed = false;
        var _self = { mask: mask };
        _self.close = function () {
            if (closed) return;
            closed = true;
            if (opts.onClose) opts.onClose();
            if (mask.parentNode) mask.parentNode.removeChild(mask);
        };
        win.BK.backStack.push(function () {
            // 系统返回键：销毁并回调 onClose（与真实实现一致：栈条目已被 pop）
            if (!closed) _self.close();
        });
        return _self;
    };
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
        var info = await win.BK.LanSync.connect('192.168.1.5', 18080);
        assert.strictEqual(info.name, '设备B');
        assert.ok(info.books.length > 0);
        assert.strictEqual(info.books[0].id, 'b1');
        // 验证 URL 格式
        assert.ok(win._fetchCalls[0].url.indexOf('http://192.168.1.5:18080/info') === 0);
        assert.ok(win._fetchCalls[0].url.indexOf('code=') === -1, '去配对码后 URL 不应携带 code 参数');
    });

    test('connect 对端 HTTP 错误时抛异常', async () => {
        win.fetch = function () {
            return Promise.resolve({ ok: false, status: 500, statusText: 'Internal Server Error' });
        };
        await assert.rejects(
            win.BK.LanSync.connect('192.168.1.5', 18080),
            /500/
        );
    });

    test('pull 调用 GET /download 并调用 importFromZip', async () => {
        var savedImport = win.BK.SyncCore.importFromZip;
        var importCalled = false;
        var importedBuffer = null;
        win.BK.SyncCore.importFromZip = function (buffer) {
            importCalled = true;
            importedBuffer = buffer;
            return Promise.resolve({ success: 1, failed: 0, errors: [] });
        };

        var result = await win.BK.LanSync.pull('192.168.1.5', 18080, { mode: 'data' });
        assert.ok(importCalled, '应调用 importFromZip');
        assert.ok(importedBuffer instanceof ArrayBuffer, '传给 importFromZip 的应为 ArrayBuffer');
        assert.strictEqual(result.success, 1);

        win.BK.SyncCore.importFromZip = savedImport;
    });

    test('pull 支持 mode=full 参数', async () => {
        await win.BK.LanSync.pull('192.168.1.5', 18080, { mode: 'full' });
        assert.ok(win._fetchCalls[win._fetchCalls.length - 1].url.indexOf('mode=full') > -1);
    });

    test('push 调用 generateZipBytes + POST /upload（multipart）', async () => {
        var savedSave = win.BK.SyncCore.generateZipBytes;
        var genCalled = false;
        win.BK.SyncCore.generateZipBytes = function (mode, opts) {
            genCalled = true;
            assert.strictEqual(mode, 'data');
            return savedSave(mode, opts);
        };

        var result = await win.BK.LanSync.push('192.168.1.5', 18080, { mode: 'data' });
        assert.ok(genCalled, '应调用 generateZipBytes');
        assert.strictEqual(result.success, 2);

        var uploadCall = win._fetchCalls.find(function (c) { return c.url.indexOf('/upload') > -1; });
        assert.ok(uploadCall, '应有 /upload fetch 调用');
        assert.strictEqual(uploadCall.opts.method, 'POST');
        assert.ok(uploadCall.opts.body instanceof FormData,
            'POST body 应为 FormData（multipart 保持二进制，避免 NanoHTTPD UTF-8 字符串化损坏 ZIP）');
        assert.ok(uploadCall.opts.body.has('file'), 'FormData 应包含 file 字段');
        assert.ok(uploadCall.opts.body.has('name'), 'FormData 应包含 name 字段（接收端确认框展示发送方设备名）');
        var file = uploadCall.opts.body.get('file');
        assert.ok(file instanceof Blob, 'file 应为 Blob');
        assert.strictEqual(file.type, 'application/zip');
        assert.strictEqual(file.name, 'sync.zip');
        // multipart 上传不允许显式 Content-Type（浏览器自动加 boundary）
        assert.strictEqual(uploadCall.opts.headers, undefined,
            'fetch 不应显式设置 Content-Type（multipart boundary 由浏览器生成）');

        win.BK.SyncCore.generateZipBytes = savedSave;
    });

    test('discover 调用 Capacitor NSD 发现并回调 handler', async () => {
        var discovered = [];
        await win.BK.LanSync.discover(function (device) {
            discovered.push(device);
        });

        // 模拟 Java 端 NSD DiscoveryListener 通过 evaluateJs 回调
        win.BK.LanSync._onDeviceFound(JSON.stringify({ name: '书报-AB12', ip: '192.168.1.8', port: 18080 }));
        assert.strictEqual(discovered.length, 1, 'handler 应收到发现设备');
        assert.strictEqual(discovered[0].ip, '192.168.1.8');

        // stopDiscovery 后不再回调
        await win.BK.LanSync.stopDiscovery();
        win.BK.LanSync._onDeviceFound(JSON.stringify({ name: '书报-CD34', ip: '192.168.1.9', port: 18080 }));
        assert.strictEqual(discovered.length, 1, 'stopDiscovery 后不应再回调');
    });

    test('discover 在 PWA（无 Capacitor）环境拒绝', async () => {
        var savedCapacitor = win.Capacitor;
        delete win.Capacitor;
        await assert.rejects(
            win.BK.LanSync.discover(function () {}),
            /仅 APK 端可用/
        );
        win.Capacitor = savedCapacitor;
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
        win.BK.SyncCore.importFromZip = function (buffer) {
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

        var p = win.BK.LanSync._handleUpload(base64, 'req-003', '设备A');
        // 应弹接收确认框，并展示发送方设备名
        var okBtn = document.querySelector('#bk-lan-sync-receive-dialog .lan-sync-code-dialog-ok');
        assert.ok(okBtn, '应弹接收确认框');
        var desc = document.querySelector('#bk-lan-sync-receive-dialog .lan-sync-code-dialog-desc');
        assert.ok(desc.textContent.indexOf('设备A') > -1, '确认框应展示发送方设备名');
        okBtn.click();
        await p;
        assert.ok(importCalled, '应调用 importFromZip');
        assert.strictEqual(delivered.requestId, 'req-003');
        var result = JSON.parse(delivered.data);
        assert.strictEqual(result.success, 2);
    });

    test('_handleUpload 错误时返回 error JSON', async () => {
        win.BK.SyncCore.importFromZip = function () {
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

        var p = win.BK.LanSync._handleUpload(base64, 'req-004', '设备A');
        document.querySelector('#bk-lan-sync-receive-dialog .lan-sync-code-dialog-ok').click();
        await p;
        var result = JSON.parse(delivered.data);
        assert.strictEqual(result.success, 0);
        assert.ok(result.errors.length > 0);
    });

    test('_handleUpload 拒绝接收时返回 cancelled 标记', async () => {
        var importCalled = false;
        win.BK.SyncCore.importFromZip = function () {
            importCalled = true;
            return Promise.resolve({ success: 1, failed: 0, errors: [] });
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

        var p = win.BK.LanSync._handleUpload(base64, 'req-005', '设备A');
        document.querySelector('#bk-lan-sync-receive-dialog .lan-sync-code-dialog-cancel').click();
        await p;

        assert.strictEqual(importCalled, false, '拒绝后不应调用 importFromZip');
        var result = JSON.parse(delivered.data);
        assert.strictEqual(result.success, 0);
        assert.strictEqual(result.cancelled, true, '应携带 cancelled 标记供发送方识别');
        assert.ok(result.errors.indexOf('接收被拒绝') > -1);
    });
});