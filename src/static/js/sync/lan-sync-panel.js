/**
 * lan-sync-panel.js — 局域网同步 UI 面板
 *
 * 全屏弹层，含：
 *   - 本机状态（设备名、服务状态、配对码、IP 地址）
 *   - 可用设备列表（NSD 发现 + 手动输入 IP）
 *   - 传输模式（仅数据 / 含书完整包）
 *   - 传输日志
 *
 * 依赖：
 *   - BK.LanSync (lan-sync.js)
 *
 * 挂载：window.BK.LanSyncPanel
 */
(function (win) {
    'use strict';

    var state = {
        serverRunning: false,
        serverInfo: null,    // {port, pairCode, ipAddress}
        devices: [],          // [{name, ip, port}]
        logs: [],             // [{time, msg}]
        mode: 'data',         // 'data' | 'full'
        transferring: false
    };

    var panelEl = null;
    var logArea = null;

    // ── 面板渲染 ──────────────────────────────────────────────────

    function _ensurePanel() {
        panelEl = document.getElementById('lan-sync-panel');
        if (!panelEl) {
            panelEl = document.createElement('div');
            panelEl.id = 'lan-sync-panel';
            panelEl.className = 'lan-sync-overlay';
            panelEl.style.display = 'none';
            document.body.appendChild(panelEl);
        }
        _renderPanel();
    }

    function _renderPanel() {
        if (!panelEl) return;
        var info = state.serverInfo || {};
        var running = state.serverRunning;
        var codeHtml = info.pairCode
            ? '<span class="lan-sync-code">' + _formatCode(info.pairCode) + '</span>'
            : '<span class="lan-sync-code-empty">—</span>';

        var devicesHtml = state.devices.map(function (d) {
            return '<div class="lan-sync-device" data-ip="' + d.ip + '" data-port="' + d.port + '">' +
                '<span class="lan-sync-device-icon">📱</span>' +
                '<span class="lan-sync-device-name">' + _esc(d.name) + '</span>' +
                '<span class="lan-sync-device-addr">' + _esc(d.ip) + ':' + d.port + '</span>' +
                '<button class="lan-sync-btn-pull" data-ip="' + d.ip + '" data-port="' + d.port + '">拉取</button>' +
                '<button class="lan-sync-btn-push" data-ip="' + d.ip + '" data-port="' + d.port + '">推送</button>' +
                '</div>';
        }).join('');

        if (!devicesHtml) {
            devicesHtml = '<div class="lan-sync-no-device">暂无可用设备</div>' +
                '<div class="lan-sync-manual">' +
                '<input type="text" class="lan-sync-input-ip" placeholder="IP:端口" />' +
                '<input type="text" class="lan-sync-input-code" placeholder="配对码" />' +
                '<button class="lan-sync-btn-connect">连接</button>' +
                '</div>';
        }

        var modeChecked = state.mode === 'full' ? 'checked' : '';

        var logsHtml = state.logs.map(function (l) {
            return '<div class="lan-sync-log-entry"><span class="lan-sync-log-time">' + l.time + '</span> ' + _esc(l.msg) + '</div>';
        }).join('');
        if (!logsHtml) logsHtml = '<div class="lan-sync-log-empty">暂无日志</div>';

        panelEl.innerHTML =
            '<div class="lan-sync-panel">' +
            '  <div class="lan-sync-header">' +
            '    <button class="lan-sync-back">←</button>' +
            '    <span class="lan-sync-title">局域网同步</span>' +
            '  </div>' +
            '  <div class="lan-sync-body">' +
            '    <div class="lan-sync-section">' +
            '      <div class="lan-sync-section-title">本机状态</div>' +
            '      <div class="lan-sync-status-row"><span>状态</span><span class="lan-sync-status-' + (running ? 'on' : 'off') + '">' + (running ? '● 服务运行中' : '● 未启动') + '</span></div>' +
            '      <div class="lan-sync-status-row"><span>配对码</span>' + codeHtml + '</div>' +
            '      <div class="lan-sync-status-row"><span>地址</span><span>' + (info.ipAddress ? _esc(info.ipAddress) + ':' + (info.port || '') : '—') + '</span></div>' +
            '      <div class="lan-sync-actions">' +
            '        <button class="lan-sync-btn-start"' + (running ? ' disabled' : '') + '>启动服务</button>' +
            '        <button class="lan-sync-btn-stop"' + (!running ? ' disabled' : '') + '>停止</button>' +
            '      </div>' +
            '    </div>' +
            '    <div class="lan-sync-section">' +
            '      <div class="lan-sync-section-title">可用设备</div>' +
            '      <div class="lan-sync-devices">' + devicesHtml + '</div>' +
            '    </div>' +
            '    <div class="lan-sync-section">' +
            '      <div class="lan-sync-section-title">传输模式</div>' +
            '      <label class="lan-sync-radio"><input type="radio" name="lan-sync-mode" value="data"' + (state.mode === 'data' ? ' checked' : '') + '> 仅数据（进度·书签·划线）</label>' +
            '      <label class="lan-sync-radio"><input type="radio" name="lan-sync-mode" value="full"' + (state.mode === 'full' ? ' checked' : '') + '> 含书完整包</label>' +
            '    </div>' +
            '    <div class="lan-sync-section">' +
            '      <div class="lan-sync-section-title">传输日志</div>' +
            '      <div class="lan-sync-log">' + logsHtml + '</div>' +
            '    </div>' +
            '  </div>' +
            '</div>';

        if (!logArea) {
            logArea = panelEl.querySelector('.lan-sync-log');
        }
        _bindEvents();
    }

    // ── 事件绑定 ──────────────────────────────────────────────────

    function _bindEvents() {
        if (!panelEl) return;

        var backBtn = panelEl.querySelector('.lan-sync-back');
        if (backBtn) backBtn.onclick = function () { hide(); };

        var startBtn = panelEl.querySelector('.lan-sync-btn-start');
        if (startBtn) startBtn.onclick = _handleStart;

        var stopBtn = panelEl.querySelector('.lan-sync-btn-stop');
        if (stopBtn) stopBtn.onclick = _handleStop;

        var connectBtn = panelEl.querySelector('.lan-sync-btn-connect');
        if (connectBtn) connectBtn.onclick = _handleManualConnect;

        var radios = panelEl.querySelectorAll('input[name="lan-sync-mode"]');
        for (var i = 0; i < radios.length; i++) {
            radios[i].onchange = function (e) { state.mode = e.target.value; };
        }

        var pullBtns = panelEl.querySelectorAll('.lan-sync-btn-pull');
        for (var j = 0; j < pullBtns.length; j++) {
            pullBtns[j].onclick = function (e) {
                var ip = e.target.getAttribute('data-ip');
                var port = parseInt(e.target.getAttribute('data-port'), 10);
                _handlePull(ip, port);
            };
        }

        var pushBtns = panelEl.querySelectorAll('.lan-sync-btn-push');
        for (var k = 0; k < pushBtns.length; k++) {
            pushBtns[k].onclick = function (e) {
                var ip = e.target.getAttribute('data-ip');
                var port = parseInt(e.target.getAttribute('data-port'), 10);
                _handlePush(ip, port);
            };
        }
    }

    // ── 事件处理 ──────────────────────────────────────────────────

    function _handleStart() {
        if (!win.BK || !win.BK.LanSync || !win.BK.LanSync.isAvailable()) {
            addLog('当前环境不支持局域网同步服务端');
            return;
        }
        addLog('正在启动服务...');
        win.BK.LanSync.startServer().then(function (info) {
            state.serverRunning = true;
            state.serverInfo = info;
            addLog('服务已启动，配对码 ' + info.pairCode);
            _renderPanel();
        }).catch(function (err) {
            addLog('启动失败：' + (err.message || err));
        });
    }

    function _handleStop() {
        win.BK.LanSync.stopServer().then(function () {
            state.serverRunning = false;
            state.serverInfo = null;
            addLog('服务已停止');
            _renderPanel();
        });
    }

    function _handleManualConnect() {
        var ipInput = panelEl.querySelector('.lan-sync-input-ip');
        var codeInput = panelEl.querySelector('.lan-sync-input-code');
        if (!ipInput || !codeInput) return;
        var addr = ipInput.value.trim();
        var code = codeInput.value.trim();
        if (!addr || !code) { addLog('请输入 IP:端口 和配对码'); return; }

        var parts = addr.split(':');
        var ip = parts[0];
        var port = parseInt(parts[1] || '18080', 10);

        addLog('正在连接 ' + ip + ':' + port + '...');
        win.BK.LanSync.connect(ip, port, code).then(function (info) {
            addLog('已连接 ' + info.name + '（' + (info.books ? info.books.length : 0) + ' 本书）');
            addDevice({ name: info.name, ip: ip, port: port });
        }).catch(function (err) {
            addLog('连接失败：' + (err.message || err));
        });
    }

    function _handlePull(ip, port) {
        if (state.transferring) { addLog('正在传输中，请稍候'); return; }
        state.transferring = true;
        var code = (state.serverInfo && state.serverInfo.pairCode) ? state.serverInfo.pairCode : '';
        addLog('正在拉取数据...');
        win.BK.LanSync.pull(ip, port, code, { mode: state.mode }).then(function (result) {
            addLog('拉取完成：成功 ' + result.success + ' 本' + (result.failed ? '，失败 ' + result.failed + ' 本' : ''));
        }).catch(function (err) {
            addLog('拉取失败：' + (err.message || err));
        }).finally(function () {
            state.transferring = false;
        });
    }

    function _handlePush(ip, port) {
        if (state.transferring) { addLog('正在传输中，请稍候'); return; }
        state.transferring = true;
        var code = (state.serverInfo && state.serverInfo.pairCode) ? state.serverInfo.pairCode : '';
        addLog('正在推送数据...');
        win.BK.LanSync.push(ip, port, code, { mode: state.mode }).then(function (result) {
            addLog('推送完成：对端成功 ' + result.success + ' 本' + (result.failed ? '，失败 ' + result.failed + ' 本' : ''));
        }).catch(function (err) {
            addLog('推送失败：' + (err.message || err));
        }).finally(function () {
            state.transferring = false;
        });
    }

    // ── 公开 API ──────────────────────────────────────────────────

    function show() {
        _ensurePanel();
        panelEl.style.display = '';
        addLog('面板已打开');
    }

    function hide() {
        if (panelEl) panelEl.style.display = 'none';
    }

    function addLog(msg) {
        var time = new Date();
        var ts = ('0' + time.getHours()).slice(-2) + ':' + ('0' + time.getMinutes()).slice(-2);
        state.logs.push({ time: ts, msg: msg });
        if (state.logs.length > 100) state.logs.shift();

        if (logArea) {
            var entry = document.createElement('div');
            entry.className = 'lan-sync-log-entry';
            entry.innerHTML = '<span class="lan-sync-log-time">' + ts + '</span> ' + _esc(msg);
            logArea.appendChild(entry);
            logArea.scrollTop = logArea.scrollHeight;
        }
    }

    function addDevice(device) {
        // 去重
        for (var i = 0; i < state.devices.length; i++) {
            if (state.devices[i].ip === device.ip) {
                state.devices[i] = device;
                _renderPanel();
                return;
            }
        }
        state.devices.push(device);
        _renderPanel();
    }

    function removeDevice(ip) {
        state.devices = state.devices.filter(function (d) { return d.ip !== ip; });
        _renderPanel();
    }

    function getState() {
        return {
            serverRunning: state.serverRunning,
            serverInfo: state.serverInfo,
            devices: state.devices.slice(),
            logs: state.logs.slice(),
            mode: state.mode,
            transferring: state.transferring
        };
    }

    function setMode(mode) {
        state.mode = mode;
    }

    // ── 工具 ──────────────────────────────────────────────────────

    function _formatCode(code) {
        if (!code) return '';
        return code.split('').join(' ');
    }

    function _esc(s) {
        if (!s) return '';
        var div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    // ── 导出 ──────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.LanSyncPanel = {
        show: show,
        hide: hide,
        addLog: addLog,
        addDevice: addDevice,
        removeDevice: removeDevice,
        getState: getState,
        setMode: setMode
    };

})(window);