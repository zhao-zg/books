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
    startServer: function () { return Promise.resolve({ port: 18080, ipAddress: '192.168.1.5' }); },
    stopServer: function () { return Promise.resolve(); },
    getStatus: function () { return Promise.resolve({ running: true, ipAddress: '192.168.1.5', port: 18080 }); },
    connect: function (ip, port) { return Promise.resolve({ name: '设备B', books: [] }); },
    pull: function () { return Promise.resolve({ success: 1, failed: 0, errors: [] }); },
    push: function (ip, port, opts) { return Promise.resolve({ success: 1, failed: 0, errors: [] }); },
    discover: function () { return Promise.resolve(); },
    stopDiscovery: function () { return Promise.resolve(); }
};

// Mock LanSyncQR（_renderQr 与 renderSignalQr 依赖）
win.BK.LanSyncQR = {
    buildConnectionString: function (info) {
        return 'bk-sync://' + info.ip + ':' + info.port;
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

// Mock backStack + openDialog（面板 show/弹窗依赖；openDialog 返回契约与真实实现一致）
var _dialogStack = [];
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
        // 系统返回键：销毁并回调 onClose（与真实实现一致：栈条目被 pop）
        if (!closed) _self.close();
    });
    return _self;
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
        win.BK.LanSyncPanel.hide(); // 清理扫描定时器
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
        win.BK.LanSyncPanel.hide(); // 清理扫描定时器
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
        win.BK.LanSyncPanel.hide();
    });

    test('show 渲染 PWA 直连区域（支持时显示创建/扫码按钮）', () => {
        win.BK.LanSyncWebRTC.isSupported = function () { return true; };
        win.BK.LanSyncPanel.show();
        var createBtn = document.querySelector('.lan-sync-wrtc-create');
        var scanBtn = document.querySelector('.lan-sync-wrtc-scan-offer');
        assert.ok(createBtn, '应显示创建连接按钮');
        assert.ok(scanBtn, '应显示扫码连接按钮');
        win.BK.LanSyncWebRTC.isSupported = function () { return false; };
        win.BK.LanSyncPanel.hide();
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
        win.BK.LanSyncPanel.hide();
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
        win.BK.LanSyncPanel.hide();
    });

    test('setMode 切换传输模式', () => {
        win.BK.LanSyncPanel.setMode('full');
        assert.strictEqual(win.BK.LanSyncPanel.getState().mode, 'full');
        win.BK.LanSyncPanel.setMode('data');
        assert.strictEqual(win.BK.LanSyncPanel.getState().mode, 'data');
    });

    test('addDevice / removeDevice 管理设备列表（不含配对码）', () => {
        win.BK.LanSyncPanel.addDevice({ name: '设备A', ip: '192.168.1.5', port: 18080 });
        var devices = win.BK.LanSyncPanel.getState().devices;
        assert.strictEqual(devices.length, 1);
        assert.strictEqual(devices[0].name, '设备A');
        assert.strictEqual(devices[0].code, undefined, '设备记录不应再含配对码');

        win.BK.LanSyncPanel.removeDevice('192.168.1.5');
        devices = win.BK.LanSyncPanel.getState().devices;
        assert.strictEqual(devices.length, 0);
    });

    test('_handlePush 弹内容选择弹窗，确认后以所选 mode 推送（无配对码）', async () => {
        win.BK.LanSyncPanel.addDevice({ name: '设备B', ip: '192.168.1.8', port: 18080 });

        var pushed = [];
        win.BK.LanSync.push = function (ip, port, opts) {
            pushed.push({ ip: ip, port: port, opts: opts });
            return Promise.resolve({ success: 1, failed: 0, errors: [] });
        };

        // 通过面板 UI 触发（设备卡片只剩发送按钮）
        win.BK.LanSyncPanel.show();
        assert.ok(!document.querySelector('.lan-sync-btn-pull'), '设备卡片不应再有拉取按钮');
        var pushBtn = document.querySelector('.lan-sync-btn-push');
        assert.ok(pushBtn, '设备列表应渲染发送按钮');
        pushBtn.click();
        await new Promise(function (r) { setTimeout(r, 0); });

        // 应弹出内容选择弹窗（不再弹配对码输入）
        var modeBtns = document.querySelectorAll('.lan-sync-mode-btn');
        assert.strictEqual(modeBtns.length, 2, '应弹内容选择弹窗（两个选项）');
        assert.ok(!document.querySelector('.lan-sync-code-dialog-input'), '不应再出现配对码输入框');
        assert.strictEqual(pushed.length, 0, '选择前不应发起传输');

        // 选「连同书籍文件一起」
        modeBtns[1].click();
        await new Promise(function (r) { setTimeout(r, 0); });

        assert.strictEqual(pushed.length, 1);
        assert.strictEqual(pushed[0].ip, '192.168.1.8');
        assert.strictEqual(pushed[0].opts.mode, 'full', '应使用所选传输模式');
        assert.strictEqual(pushed[0].opts.code, undefined, '传输参数不应再含配对码');
        win.BK.LanSyncPanel.hide();
    });

    test('内容选择弹窗选「仅阅读数据」后以 data 模式推送', async () => {
        win.BK.LanSyncPanel.addDevice({ name: '设备C', ip: '192.168.1.9', port: 18080 });

        var pushed = [];
        win.BK.LanSync.push = function (ip, port, opts) {
            pushed.push({ ip: ip, port: port, opts: opts });
            return Promise.resolve({ success: 2, failed: 0, errors: [] });
        };

        win.BK.LanSyncPanel.show();
        var pushBtn = document.querySelector(".lan-sync-btn-push[data-ip='192.168.1.9']");
        assert.ok(pushBtn, '设备C 应渲染发送按钮');
        pushBtn.click();
        await new Promise(function (r) { setTimeout(r, 0); });

        // 应弹出内容选择弹窗（不再是配对码输入框）
        var dataBtn = document.querySelector('.lan-sync-mode-btn[data-mode="data"]');
        assert.ok(dataBtn, '应弹出内容选择弹窗');
        assert.strictEqual(pushed.length, 0, '选择前不应发起传输');

        dataBtn.click();
        await new Promise(function (r) { setTimeout(r, 0); });

        assert.strictEqual(pushed.length, 1, '确认后应执行推送');
        assert.strictEqual(pushed[0].opts.mode, 'data', '应使用仅阅读数据模式');
        win.BK.LanSyncPanel.hide();
    });

    test('内容选择弹窗取消不发起传输（点遮罩/返回键路径）', async () => {
        win.BK.LanSyncPanel.addDevice({ name: '设备D', ip: '192.168.1.10', port: 18080 });

        var pushed = [];
        win.BK.LanSync.push = function (ip, port, opts) {
            pushed.push({ ip: ip, port: port, opts: opts });
            return Promise.resolve({ success: 0, failed: 0, errors: [] });
        };

        win.BK.LanSyncPanel.show();
        var pushBtn = document.querySelector(".lan-sync-btn-push[data-ip='192.168.1.10']");
        pushBtn.click();
        await new Promise(function (r) { setTimeout(r, 0); });

        var cancelBtn = document.querySelector('.lan-sync-code-dialog-cancel');
        assert.ok(cancelBtn, '内容选择弹窗应有取消按钮');
        cancelBtn.click();
        await new Promise(function (r) { setTimeout(r, 0); });

        assert.strictEqual(pushed.length, 0, '取消后不应发起传输');
        assert.ok(!document.getElementById('bk-lan-sync-mode-dialog'), '弹窗应已关闭');
        assert.ok(!document.querySelector('.bk-lan-sync-toast'), '取消不应弹 toast');
        win.BK.LanSyncPanel.hide();
    });

    test('传输中按钮置灰，失败 toast 提示真实错误', async () => {
        win.BK.LanSyncPanel.addDevice({ name: '设备E', ip: '192.168.1.11', port: 18080 });

        win.BK.LanSync.push = function () {
            return new Promise(function (resolve, reject) {
                setTimeout(function () { reject(new Error('HTTP 500 internal error')); }, 30);
            });
        };

        win.BK.LanSyncPanel.show();
        // 先等 autoStartServer 异步渲染完成，再取按钮（避免 _renderPanel 重建 DOM 后引用失效）
        await new Promise(function (r) { setTimeout(r, 0); });
        var pushBtn = document.querySelector(".lan-sync-btn-push[data-ip='192.168.1.11']");
        pushBtn.click();
        await new Promise(function (r) { setTimeout(r, 0); });
        // 先选传输内容再进入传输
        document.querySelector('.lan-sync-mode-btn[data-mode="data"]').click();
        await new Promise(function (r) { setTimeout(r, 0); });

        // 传输中：按钮应置灰（busy 类）
        assert.ok(pushBtn.classList.contains('lan-sync-busy'), '传输中按钮应置灰');

        await new Promise(function (r) { setTimeout(r, 60); });

        // 传输结束：busy 解除、toast 展示真实错误
        assert.ok(!pushBtn.classList.contains('lan-sync-busy'), '传输结束后应解除置灰');
        var toast = document.querySelector('.bk-lan-sync-toast');
        assert.ok(toast, '失败时应弹 toast');
        assert.ok(toast.textContent.indexOf('500 internal error') > -1, 'toast 应含真实错误信息');
        win.BK.LanSyncPanel.hide();
    });

    test('手动连接直接 connect，无配对码输入弹窗', async () => {
        var connected = [];
        win.BK.LanSync.connect = function (ip, port) {
            connected.push({ ip: ip, port: port });
            return Promise.resolve({ name: '设备F', books: [1, 2] });
        };

        win.BK.LanSyncPanel.show();
        assert.ok(!document.querySelector('.lan-sync-input-code'), '手动连接区不应再有配对码输入框');

        var ipInput = document.querySelector('.lan-sync-input-ip');
        ipInput.value = '192.168.1.12:18080';
        var connectBtn = document.querySelector('.lan-sync-btn-connect');
        connectBtn.click();
        await new Promise(function (r) { setTimeout(r, 0); });

        assert.strictEqual(connected.length, 1, '点连接应立即发起 connect');
        assert.strictEqual(connected[0].ip, '192.168.1.12');
        assert.strictEqual(connected[0].port, 18080);
        assert.strictEqual(connected[0].code, undefined, '连接不应再携带配对码');
        assert.ok(!document.querySelector('.lan-sync-code-dialog-input'), '点连接不应弹配对码输入弹窗');

        // 连接成功后设备入列表
        var devices = win.BK.LanSyncPanel.getState().devices;
        assert.strictEqual(devices.some(function (d) { return d.ip === '192.168.1.12'; }), true,
            '连接成功后设备应入列表');
        win.BK.LanSyncPanel.hide();
    });

    // ── 扫描状态机（P0-1/P1-1/P1-2/P2：重试 / 周期重扫 / 降级提示 / 清理）────

    function nextTick() { return new Promise(function (r) { setTimeout(r, 0); }); }
    function tick(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    test('扫描状态机初始为 idle', () => {
        var scan = win.BK.LanSyncPanel.getScanState();
        assert.ok(scan.hasOwnProperty('scanning'));
        assert.ok(scan.hasOwnProperty('lastResultAt'));
        assert.ok(scan.hasOwnProperty('consecutiveEmptyRounds'));
        assert.strictEqual(scan.scanning, false, '未打开面板时不应在扫描');
    });

    test('打开面板自动开始扫描（面板打开期间一直扫）', async () => {
        var discoverCalls = 0;
        win.BK.LanSync.discover = function () { discoverCalls++; return Promise.resolve(); };

        win.BK.LanSyncPanel.show();
        await nextTick();

        assert.ok(discoverCalls >= 1, '打开面板应至少发起一次发现');
        assert.strictEqual(win.BK.LanSyncPanel.getScanState().scanning, true, '扫描中状态应为 true');
        win.BK.LanSyncPanel.hide();
    });

    test('发现设备时重置空轮计数并停止「正在扫描」', async () => {
        win.BK.LanSyncPanel.show();
        await nextTick();

        // 先触发一次无结果（模拟一轮空扫）
        win.BK.LanSyncPanel._markScanRoundEmptyForTest();
        assert.strictEqual(win.BK.LanSyncPanel.getScanState().consecutiveEmptyRounds, 1);

        // 设备被发现
        win.BK.LanSyncPanel.addDevice({ name: '设备G', ip: '192.168.1.13', port: 18080 });
        var scan = win.BK.LanSyncPanel.getScanState();
        assert.strictEqual(scan.consecutiveEmptyRounds, 0, '发现设备后空窗计数应重置');
        assert.strictEqual(scan.scanning, false, '发现设备后应停止扫描反馈');
        win.BK.LanSyncPanel.hide();
    });

    test('连续两轮无结果后给出降级提示（手动输入 IP/扫码）', async () => {
        win.BK.LanSyncPanel.show();
        await nextTick();

        // 清掉首轮自动 discover 触发的 5s 定时器，避免与手动空扫干扰
        win.BK.LanSyncPanel._clearScanTimerForTest();
        win.BK.LanSyncPanel._handleScanRoundEmpty();
        win.BK.LanSyncPanel._handleScanRoundEmpty();

        var toast = document.querySelector('.bk-lan-sync-toast');
        assert.ok(toast, '连续空扫后应弹降级 toast');
        assert.ok(toast.textContent.indexOf('手动输入') > -1 || toast.textContent.indexOf('扫码') > -1,
            '降级提示应含手动输入 IP/扫码');
        win.BK.LanSyncPanel.hide();
    });

    test('hide 面板停止扫描（清理定时器与扫描状态）', async () => {
        var stopCalls = 0;
        win.BK.LanSync.stopDiscovery = function () { stopCalls++; return Promise.resolve(); };

        win.BK.LanSyncPanel.show();
        await nextTick();
        win.BK.LanSyncPanel.hide();

        var scan = win.BK.LanSyncPanel.getScanState();
        assert.strictEqual(scan.scanning, false, 'hide 后应停止扫描');
        assert.ok(stopCalls >= 1, 'hide 应调用 stopDiscovery');
        win.BK.LanSyncPanel.hide(); // 幂等
    });

    test('扫描中 UI 显示「正在扫描…」反馈', async () => {
        win.BK.LanSyncPanel.show();
        await nextTick();
        // 手动置为扫描中并重渲染（模拟真实状态）
        win.BK.LanSyncPanel._setScanning(true);
        var hint = document.querySelector('.lan-sync-scan-hint');
        assert.ok(hint, '扫描中应渲染扫描提示元素');
        assert.ok(hint.textContent.indexOf('正在扫描') >= 0, '提示文案应含「正在扫描」');
        win.BK.LanSyncPanel._setScanning(false);
        win.BK.LanSyncPanel.hide();
    });
});