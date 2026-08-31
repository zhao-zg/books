'use strict';
/**
 * lan-sync-panel 逻辑测试（node:test + JSDOM）
 *
 * 测试面板状态管理逻辑（非 DOM 渲染细节）：
 *   - 日志追加
 *   - 状态切换
 *   - 设备列表管理
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.win = dom.window;

// Mock LanSync
win.BK = win.BK || {};
win.BK.LanSync = {
    isAvailable: function () { return true; },
    isNative: function () { return true; },
    startServer: function () { return Promise.resolve({ port: 18080, pairCode: '123456', ipAddress: '192.168.1.5' }); },
    stopServer: function () { return Promise.resolve(); },
    getStatus: function () { return Promise.resolve({ running: true, pairCode: '123456', ipAddress: '192.168.1.5', port: 18080 }); },
    connect: function (ip, port, code) { return Promise.resolve({ name: '设备B', books: [] }); },
    pull: function () { return Promise.resolve({ success: 1, failed: 0, errors: [] }); },
    push: function () { return Promise.resolve({ success: 1, failed: 0, errors: [] }); },
    discover: function () { return Promise.resolve(); },
    stopDiscovery: function () { return Promise.resolve(); }
};

// Mock LanSyncQR（_renderQr 与 renderSignalQr 依赖）
win.BK.LanSyncQR = {
    buildConnectionString: function (info) {
        return 'bk-sync://' + info.ip + ':' + info.port + '?code=' + info.code;
    },
    render: function (text) {
        return { html: '<div class="qr-mock">' + text + '</div>' };
    }
};

// Mock LanSyncWebRTC（默认不支持，可在测试中覆写）
win.BK.LanSyncWebRTC = {
    isSupported: function () { return false; },
    createOffer: function () { return Promise.reject(new Error('mock')); },
    acceptOffer: function () { return Promise.reject(new Error('mock')); },
    acceptAnswer: function () { return Promise.reject(new Error('mock')); },
    push: function () { return Promise.resolve({ sent: 0 }); },
    pull: function () { return Promise.resolve({ requested: true }); },
    close: function () {}
};

// Mock LanSyncWebRTCUI
win.BK.LanSyncWebRTCUI = {
    scanQR: function () { return Promise.reject(new Error('mock')); },
    stopScan: function () { return Promise.resolve(); },
    renderSignalQr: function (text, label) {
        return '<div class="lan-sync-wrtc-qr">' + (label || '') + '|' + text + '</div>';
    }
};

function loadModule() {
    var srcPath = join(__dirname, '..', '..', 'src', 'static', 'js', 'sync', 'lan-sync-panel.js');
    var code = readFileSync(srcPath, 'utf-8');
    vm.runInThisContext(code, { filename: srcPath, displayErrors: true });
}

describe('lan-sync-panel.js', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="app"><div id="lan-sync-panel" style="display:none"></div></div>';
        loadModule();
    });

    test('模块正确挂载到 win.BK.LanSyncPanel', () => {
        assert.ok(win.BK.LanSyncPanel, 'LanSyncPanel 应存在');
        assert.strictEqual(typeof win.BK.LanSyncPanel.show, 'function');
        assert.strictEqual(typeof win.BK.LanSyncPanel.hide, 'function');
        assert.strictEqual(typeof win.BK.LanSyncPanel.addLog, 'function');
    });

    test('show 显示面板', () => {
        win.BK.LanSyncPanel.show();
        var panel = document.getElementById('lan-sync-panel');
        assert.notStrictEqual(panel.style.display, 'none', '面板应可见');
    });

    test('hide 隐藏面板', () => {
        win.BK.LanSyncPanel.show();
        win.BK.LanSyncPanel.hide();
        var panel = document.getElementById('lan-sync-panel');
        assert.strictEqual(panel.style.display, 'none', '面板应隐藏');
    });

    test('addLog 追加日志条目', () => {
        win.BK.LanSyncPanel.show();
        win.BK.LanSyncPanel.addLog('测试日志1');
        win.BK.LanSyncPanel.addLog('测试日志2');
        var logArea = document.querySelector('.lan-sync-log');
        assert.ok(logArea, '日志区域应存在');
        var entries = logArea.querySelectorAll('.lan-sync-log-entry');
        assert.ok(entries.length >= 2, '应至少有 2 条日志');
    });

    test('getServerState 返回当前服务状态', () => {
        var state = win.BK.LanSyncPanel.getState();
        assert.ok(state.hasOwnProperty('serverRunning'));
        assert.ok(state.hasOwnProperty('devices'));
        assert.ok(state.hasOwnProperty('logs'));
        assert.ok(state.hasOwnProperty('mode'));
    });

    test('getState 返回 wrtc 状态结构', () => {
        var state = win.BK.LanSyncPanel.getState();
        assert.ok(state.hasOwnProperty('wrtc'), '应包含 wrtc 状态');
        assert.ok(state.wrtc.hasOwnProperty('supported'));
        assert.ok(state.wrtc.hasOwnProperty('connected'));
        assert.ok(state.wrtc.hasOwnProperty('isInitiator'));
        assert.ok(state.wrtc.hasOwnProperty('offerText'));
        assert.ok(state.wrtc.hasOwnProperty('answerText'));
        assert.ok(state.wrtc.hasOwnProperty('scanning'));
    });

    test('show 渲染 PWA 直连区域（不支持时显示提示）', () => {
        win.BK.LanSyncPanel.show();
        var unsupported = document.querySelector('.lan-sync-wrtc-unsupported');
        assert.ok(unsupported, '不支持 WebRTC 时应显示提示');
    });

    test('show 渲染 PWA 直连区域（支持时显示创建/扫码按钮）', () => {
        win.BK.LanSyncWebRTC.isSupported = function () { return true; };
        win.BK.LanSyncPanel.show();
        var createBtn = document.querySelector('.lan-sync-wrtc-create');
        var scanBtn = document.querySelector('.lan-sync-wrtc-scan-offer');
        assert.ok(createBtn, '应显示创建连接按钮');
        assert.ok(scanBtn, '应显示扫码连接按钮');
        win.BK.LanSyncWebRTC.isSupported = function () { return false; };
    });

    test('wrtc 创建连接生成 offer 后渲染二维码与扫码应答按钮', async () => {
        win.BK.LanSyncWebRTC.isSupported = function () { return true; };
        win.BK.LanSyncWebRTC.createOffer = function () {
            return Promise.resolve({ signalText: 'bk-wrtc-v1:offer-test' });
        };
        win.BK.LanSyncPanel.show();
        var createBtn = document.querySelector('.lan-sync-wrtc-create');
        createBtn.click();
        await new Promise(function (r) { setTimeout(r, 0); });

        var qr = document.querySelector('.lan-sync-wrtc-qr');
        assert.ok(qr, '应渲染 offer 二维码区域');
        var scanAnswerBtn = document.querySelector('.lan-sync-wrtc-scan-answer');
        assert.ok(scanAnswerBtn, '应显示扫码获取应答按钮');
        var state = win.BK.LanSyncPanel.getState();
        assert.strictEqual(state.wrtc.offerText, 'bk-wrtc-v1:offer-test');
        assert.strictEqual(state.wrtc.isInitiator, true);
        win.BK.LanSyncWebRTC.isSupported = function () { return false; };
    });

    test('wrtc 关闭后重置连接状态但保留 supported', async () => {
        win.BK.LanSyncWebRTC.isSupported = function () { return true; };
        win.BK.LanSyncWebRTC.createOffer = function () {
            return Promise.resolve({ signalText: 'bk-wrtc-v1:offer-test' });
        };
        win.BK.LanSyncPanel.show();
        var createBtn = document.querySelector('.lan-sync-wrtc-create');
        createBtn.click();
        await new Promise(function (r) { setTimeout(r, 0); });

        var closeBtn = document.querySelector('.lan-sync-wrtc-close');
        assert.ok(closeBtn, 'offer 状态下应显示取消按钮');
        closeBtn.click();
        await new Promise(function (r) { setTimeout(r, 0); });

        var state = win.BK.LanSyncPanel.getState();
        assert.strictEqual(state.wrtc.offerText, null, '关闭后 offer 应清空');
        assert.strictEqual(state.wrtc.connected, false);
        assert.strictEqual(state.wrtc.supported, true, '关闭后 supported 不应被重置');
        win.BK.LanSyncWebRTC.isSupported = function () { return false; };
    });

    test('setMode 切换传输模式', () => {
        win.BK.LanSyncPanel.setMode('full');
        assert.strictEqual(win.BK.LanSyncPanel.getState().mode, 'full');
        win.BK.LanSyncPanel.setMode('data');
        assert.strictEqual(win.BK.LanSyncPanel.getState().mode, 'data');
    });

    test('addDevice / removeDevice 管理设备列表（携带配对码）', () => {
        win.BK.LanSyncPanel.addDevice({ name: '设备A', ip: '192.168.1.5', port: 18080, code: '654321' });
        var devices = win.BK.LanSyncPanel.getState().devices;
        assert.strictEqual(devices.length, 1);
        assert.strictEqual(devices[0].name, '设备A');
        assert.strictEqual(devices[0].code, '654321', '设备记录应携带配对码');

        win.BK.LanSyncPanel.removeDevice('192.168.1.5');
        devices = win.BK.LanSyncPanel.getState().devices;
        assert.strictEqual(devices.length, 0);
    });

    test('_handlePull / _handlePush 使用对端配对码而非本机配对码', async () => {
        // 本机服务配对码 123456，对端设备码 654321
        win.BK.LanSyncPanel.addDevice({ name: '设备B', ip: '192.168.1.8', port: 18080, code: '654321' });

        var pulled = [];
        var pushed = [];
        win.BK.LanSync.pull = function (ip, port, code) {
            pulled.push({ ip: ip, port: port, code: code });
            return Promise.resolve({ success: 1, failed: 0, errors: [] });
        };
        win.BK.LanSync.push = function (ip, port, code) {
            pushed.push({ ip: ip, port: port, code: code });
            return Promise.resolve({ success: 1, failed: 0, errors: [] });
        };

        // 通过面板 UI 触发（渲染设备列表后点拉取/推送按钮）
        win.BK.LanSyncPanel.show();
        var pullBtn = document.querySelector('.lan-sync-btn-pull');
        assert.ok(pullBtn, '设备列表应渲染拉取按钮');
        pullBtn.click();
        await new Promise(function (r) { setTimeout(r, 0); });

        var pushBtn = document.querySelector('.lan-sync-btn-push');
        assert.ok(pushBtn, '设备列表应渲染推送按钮');
        pushBtn.click();
        await new Promise(function (r) { setTimeout(r, 0); });

        assert.strictEqual(pulled.length, 1);
        assert.strictEqual(pulled[0].ip, '192.168.1.8');
        assert.strictEqual(pulled[0].code, '654321', '拉取应使用对端配对码');
        assert.strictEqual(pushed.length, 1);
        assert.strictEqual(pushed[0].ip, '192.168.1.8');
        assert.strictEqual(pushed[0].code, '654321', '推送应使用对端配对码');
    });
});