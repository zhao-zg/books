'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.win = dom.window;

// Load qrcode library
var qrPath = join(__dirname, '..', '..', 'src', 'static', 'vendor', 'qrcode.min.js');
var qrCode = readFileSync(qrPath, 'utf-8');
vm.runInThisContext(qrCode, { filename: qrPath, displayErrors: true });

function loadModule() {
    var srcPath = join(__dirname, '..', '..', 'src', 'static', 'js', 'sync', 'lan-sync-qr.js');
    var code = readFileSync(srcPath, 'utf-8');
    vm.runInThisContext(code, { filename: srcPath, displayErrors: true });
}

describe('lan-sync-qr.js', () => {
    beforeEach(() => { loadModule(); });

    test('模块正确挂载到 win.BK.LanSyncQR', () => {
        assert.ok(win.BK.LanSyncQR, 'LanSyncQR 应存在');
        assert.strictEqual(typeof win.BK.LanSyncQR.buildConnectionString, 'function');
        assert.strictEqual(typeof win.BK.LanSyncQR.render, 'function');
    });

    test('buildConnectionString 生成 bk-sync:// 协议 URL', () => {
        var str = win.BK.LanSyncQR.buildConnectionString({
            ip: '192.168.1.5', port: 18080, code: '123456'
        });
        assert.ok(str.indexOf('bk-sync://') === 0, '应以 bk-sync:// 开头');
        assert.ok(str.indexOf('192.168.1.5') > -1);
        assert.ok(str.indexOf('18080') > -1);
        assert.ok(str.indexOf('code=123456') > -1);
    });

    test('render 返回包含 QR 数据的对象', () => {
        var result = win.BK.LanSyncQR.render('bk-sync://192.168.1.5:18080?code=123456');
        assert.ok(result, '应返回非空');
        assert.ok(result.html, '应含 html 内容');
    });

    test('parseConnectionString 解析 bk-sync:// URL', () => {
        var parsed = win.BK.LanSyncQR.parseConnectionString('bk-sync://192.168.1.5:18080?code=123456');
        assert.strictEqual(parsed.ip, '192.168.1.5');
        assert.strictEqual(parsed.port, 18080);
        assert.strictEqual(parsed.code, '123456');
    });
});