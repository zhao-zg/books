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
        devices: [],          // [{name, ip, port, code}]
        logs: [],             // [{time, msg}]
        mode: 'data',         // 'data' | 'full'
        transferring: false,
        // PWA↔PWA WebRTC 状态
        wrtc: {
            supported: false,
            connected: false,
            isInitiator: false,
            offerText: null,    // 本机生成的 offer 信令文本
            answerText: null,   // 对端生成的 answer 信令文本
            scanning: false
        }
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
            return '<div class="lan-sync-device" data-ip="' + _esc(d.ip) + '" data-port="' + d.port + '" data-code="' + _esc(d.code || '') + '">' +
                '<span class="lan-sync-device-icon">📱</span>' +
                '<span class="lan-sync-device-name">' + _esc(d.name) + '</span>' +
                '<span class="lan-sync-device-addr">' + _esc(d.ip) + ':' + d.port + '</span>' +
                '<button class="lan-sync-btn-pull" data-ip="' + _esc(d.ip) + '" data-port="' + d.port + '" data-code="' + _esc(d.code || '') + '">拉取</button>' +
                '<button class="lan-sync-btn-push" data-ip="' + _esc(d.ip) + '" data-port="' + d.port + '" data-code="' + _esc(d.code || '') + '">推送</button>' +
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

        // PWA↔PWA 区域
        var wrtcHtml = _renderWrtcSection();

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
            (running && info.pairCode && win.BK.LanSyncQR ? _renderQr(info) : '') +
            '      <div class="lan-sync-actions">' +
            '        <button class="lan-sync-btn-start"' + (running ? ' disabled' : '') + '>启动服务</button>' +
            '        <button class="lan-sync-btn-stop"' + (!running ? ' disabled' : '') + '>停止</button>' +
            '      </div>' +
            '    </div>' +
            '    <div class="lan-sync-section">' +
            '      <div class="lan-sync-section-title">可用设备</div>' +
            '      <div class="lan-sync-devices">' + devicesHtml + '</div>' +
            '    </div>' +
            (wrtcHtml ? '    <div class="lan-sync-section">' +
            '      <div class="lan-sync-section-title">PWA 直连（浏览器↔浏览器）</div>' +
            '      <div class="lan-sync-wrtc">' + wrtcHtml + '</div>' +
            '    </div>' : '') +
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

    // ── PWA↔PWA WebRTC 区域渲染 ─────────────────────────────────

    function _renderWrtcSection() {
        var wrtc = state.wrtc;
        var RTC = win.BK && win.BK.LanSyncWebRTC;

        // 模块未加载
        if (!RTC) {
            return '<div class="lan-sync-wrtc-unsupported">PWA 直连模块未加载</div>';
        }

        // 不支持 WebRTC 时显示提示
        if (!RTC.isSupported()) {
            return '<div class="lan-sync-wrtc-unsupported">当前环境不支持 WebRTC（需 HTTPS）</div>';
        }

        // 已连接
        if (wrtc.connected) {
            return '<div class="lan-sync-wrtc-connected">' +
                '<div class="lan-sync-wrtc-status">● 已连接' + (wrtc.isInitiator ? '（发起方）' : '（应答方）') + '</div>' +
                '<div class="lan-sync-wrtc-actions">' +
                '<button class="lan-sync-wrtc-pull">拉取</button>' +
                '<button class="lan-sync-wrtc-push">推送</button>' +
                '<button class="lan-sync-wrtc-close">断开</button>' +
                '</div></div>';
        }

        // 等待 answer（发起方已创建 offer）
        if (wrtc.offerText && !wrtc.answerText) {
            var UI = win.BK && win.BK.LanSyncWebRTCUI;
            var qrHtml = UI ? UI.renderSignalQr(wrtc.offerText, '请对方扫码后，再扫码获取应答') : '';
            return qrHtml +
                '<div class="lan-sync-wrtc-actions">' +
                '<button class="lan-sync-wrtc-scan-answer">扫码获取应答</button>' +
                '<button class="lan-sync-wrtc-close">取消</button>' +
                '</div>';
        }

        // 等待 offer（应答方扫码）
        if (wrtc.scanning) {
            return '<div class="lan-sync-wrtc-scanning">正在扫码...</div>' +
                '<div class="lan-sync-wrtc-actions">' +
                '<button class="lan-sync-wrtc-close">取消</button>' +
                '</div>';
        }

        // 初始状态
        return '<div class="lan-sync-wrtc-actions">' +
            '<button class="lan-sync-wrtc-create">创建连接</button>' +
            '<button class="lan-sync-wrtc-scan-offer">扫码连接</button>' +
            '</div>' +
            '<div class="lan-sync-wrtc-hint">浏览器间直连传输，无需服务端</div>';
    }

    // ── PWA↔PWA 事件处理 ─────────────────────────

    function _handleWrtcCreate() {
        var RTC = win.BK && win.BK.LanSyncWebRTC;
        if (!RTC || !RTC.isSupported()) { addLog('当前环境不支持 WebRTC'); return; }

        addLog('正在创建 PWA 直连（offer）...');
        RTC.createOffer({
            onState: _handleWrtcState,
            onFile: _handleWrtcFile
        }).then(function (result) {
            state.wrtc.offerText = result.signalText;
            state.wrtc.isInitiator = true;
            addLog('offer 已生成，请对方扫码');
            _renderPanel();
        }).catch(function (err) {
            addLog('创建连接失败：' + (err.message || err));
        });
    }

    function _handleWrtcScanOffer() {
        var RTC = win.BK && win.BK.LanSyncWebRTC;
        var UI = win.BK && win.BK.LanSyncWebRTCUI;
        if (!RTC || !UI) { addLog('PWA 直连未就绪'); return; }

        state.wrtc.scanning = true;
        _renderPanel();
        addLog('正在扫码获取 offer...');
        UI.scanQR(function (text) {
            state.wrtc.scanning = false;
            addLog('已识别 offer，正在生成应答...');
            RTC.acceptOffer(text, {
                onState: _handleWrtcState,
                onFile: _handleWrtcFile
            }).then(function (result) {
                state.wrtc.answerText = result.signalText;
                state.wrtc.isInitiator = false;
                addLog('应答已生成，请对方扫码');
                _renderPanel();
            }).catch(function (err) {
                addLog('应答失败：' + (err.message || err));
                _renderPanel();
            });
        }, function (err) {
            state.wrtc.scanning = false;
            addLog('扫码失败：' + (err.message || err));
            _renderPanel();
        }).catch(function (err) {
            state.wrtc.scanning = false;
            addLog('扫码失败：' + (err.message || err));
            _renderPanel();
        });
    }

    function _handleWrtcScanAnswer() {
        var RTC = win.BK && win.BK.LanSyncWebRTC;
        var UI = win.BK && win.BK.LanSyncWebRTCUI;
        if (!RTC || !UI) { addLog('PWA 直连未就绪'); return; }

        state.wrtc.scanning = true;
        _renderPanel();
        addLog('正在扫码获取应答...');
        UI.scanQR(function (text) {
            state.wrtc.scanning = false;
            RTC.acceptAnswer(text).then(function () {
                addLog('应答已接受，等待连接...');
                _renderPanel();
            }).catch(function (err) {
                addLog('应答无效：' + (err.message || err));
                _renderPanel();
            });
        }, function (err) {
            state.wrtc.scanning = false;
            addLog('扫码失败：' + (err.message || err));
            _renderPanel();
        }).catch(function (err) {
            state.wrtc.scanning = false;
            addLog('扫码失败：' + (err.message || err));
            _renderPanel();
        });
    }

    function _handleWrtcState(s) {
        if (s.status === 'open') {
            state.wrtc.connected = true;
            addLog('PWA 直连已建立');
            _renderPanel();
        } else if (s.status === 'closed') {
            state.wrtc.connected = false;
            addLog('PWA 直连已断开');
            _renderPanel();
        } else if (s.status === 'imported') {
            var r = s.result || {};
            addLog('数据已接收：成功 ' + r.success + ' 本' + (r.failed ? '，失败 ' + r.failed + ' 本' : ''));
        } else if (s.status === 'import-error') {
            addLog('导入失败：' + (s.error || ''));
        } else if (s.status === 'error') {
            addLog('连接错误：' + (s.error || ''));
        }
    }

    function _handleWrtcFile(buffer) {
        if (win.BK && win.BK.Sync && win.BK.Sync.importFromZip) {
            addLog('正在导入接收的数据...');
            win.BK.Sync.importFromZip(buffer).then(function (result) {
                addLog('导入完成：成功 ' + result.success + ' 本' + (result.failed ? '，失败 ' + result.failed + ' 本' : ''));
            }).catch(function (err) {
                addLog('导入失败：' + (err.message || err));
            });
        }
    }

    function _handleWrtcPush() {
        var RTC = win.BK && win.BK.LanSyncWebRTC;
        if (!RTC) { addLog('PWA 直连未就绪'); return; }
        if (state.transferring) { addLog('正在传输中，请稍候'); return; }
        state.transferring = true;
        addLog('正在推送数据...');
        var books = _allBookIds();
        RTC.push(books, { mode: state.mode }).then(function (result) {
            addLog('推送完成：' + (result.sent ? '已发送 ' + (result.sent / 1024).toFixed(1) + ' KB' : ''));
        }).catch(function (err) {
            addLog('推送失败：' + (err.message || err));
        }).finally(function () {
            state.transferring = false;
        });
    }

    function _handleWrtcPull() {
        var RTC = win.BK && win.BK.LanSyncWebRTC;
        if (!RTC) { addLog('PWA 直连未就绪'); return; }
        if (state.transferring) { addLog('正在传输中，请稍候'); return; }
        state.transferring = true;
        addLog('正在拉取数据...');
        RTC.pull({ mode: state.mode }).then(function () {
            addLog('拉取请求已发送，等待对端响应...');
        }).catch(function (err) {
            addLog('拉取失败：' + (err.message || err));
        }).finally(function () {
            state.transferring = false;
        });
    }

    function _handleWrtcClose() {
        var RTC = win.BK && win.BK.LanSyncWebRTC;
        if (RTC) {
            RTC.close();
        }
        if (win.BK && win.BK.LanSyncWebRTCUI) {
            win.BK.LanSyncWebRTCUI.stopScan().catch(function () {});
        }
        var supported = state.wrtc.supported;
        state.wrtc = {
            supported: supported, connected: false, isInitiator: false,
            offerText: null, answerText: null, scanning: false
        };
        addLog('PWA 直连已关闭');
        _renderPanel();
    }

    function _allBookIds() {
        var ids = [];
        if (win.BKShelf && typeof win.BKShelf.all === 'function') {
            var shelf = win.BKShelf.all();
            for (var i = 0; i < shelf.length; i++) {
                var rec = shelf[i];
                if (rec) {
                    var bid = rec.bookId || rec.id;
                    if (bid) ids.push(bid);
                }
            }
        }
        return ids;
    }

    function _copyText(text) {
        try {
            if (win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) {
                win.navigator.clipboard.writeText(text).then(function () {
                    addLog('信令文本已复制');
                }).catch(function () {
                    _fallbackCopy(text);
                });
            } else {
                _fallbackCopy(text);
            }
        } catch (e) {
            _fallbackCopy(text);
        }
    }

    function _fallbackCopy(text) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            addLog('信令文本已复制');
        } catch (e) {
            addLog('复制失败，请手动复制');
        }
    }

    // ── 事件绑定 ──────────────────────────────────────────────────

    function _bindEvents() {
        if (!panelEl) return;

        var backBtn = panelEl.querySelector('.lan-sync-back');
        if (backBtn) backBtn.onclick = function () { hide(); };

        // PWA↔PWA WebRTC 事件
        var wrtcCreateBtn = panelEl.querySelector('.lan-sync-wrtc-create');
        if (wrtcCreateBtn) wrtcCreateBtn.onclick = _handleWrtcCreate;

        var wrtcScanOfferBtn = panelEl.querySelector('.lan-sync-wrtc-scan-offer');
        if (wrtcScanOfferBtn) wrtcScanOfferBtn.onclick = _handleWrtcScanOffer;

        var wrtcScanAnswerBtn = panelEl.querySelector('.lan-sync-wrtc-scan-answer');
        if (wrtcScanAnswerBtn) wrtcScanAnswerBtn.onclick = _handleWrtcScanAnswer;

        var wrtcCopyBtns = panelEl.querySelectorAll('.lan-sync-btn-copy');
        for (var ci = 0; ci < wrtcCopyBtns.length; ci++) {
            wrtcCopyBtns[ci].onclick = (function (btn) {
                return function () {
                    var text = btn.getAttribute('data-text') || '';
                    _copyText(text);
                };
            })(wrtcCopyBtns[ci]);
        }

        var wrtcPushBtn = panelEl.querySelector('.lan-sync-wrtc-push');
        if (wrtcPushBtn) wrtcPushBtn.onclick = _handleWrtcPush;

        var wrtcPullBtn = panelEl.querySelector('.lan-sync-wrtc-pull');
        if (wrtcPullBtn) wrtcPullBtn.onclick = _handleWrtcPull;

        var wrtcCloseBtn = panelEl.querySelector('.lan-sync-wrtc-close');
        if (wrtcCloseBtn) wrtcCloseBtn.onclick = _handleWrtcClose;

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
                var code = e.target.getAttribute('data-code') || '';
                _handlePull(ip, port, code);
            };
        }

        var pushBtns = panelEl.querySelectorAll('.lan-sync-btn-push');
        for (var k = 0; k < pushBtns.length; k++) {
            pushBtns[k].onclick = function (e) {
                var ip = e.target.getAttribute('data-ip');
                var port = parseInt(e.target.getAttribute('data-port'), 10);
                var code = e.target.getAttribute('data-code') || '';
                _handlePush(ip, port, code);
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
            // 自动启动 NSD 发现（仅 APK 环境可用时）
            if (win.BK.LanSync.isAvailable() && win.BK.LanSync.discover) {
                win.BK.LanSync.discover(function (device) {
                    if (device) addDevice(device);
                }).catch(function () {});
            }
            _renderPanel();
        }).catch(function (err) {
            addLog('启动失败：' + (err.message || err));
        });
    }

    function _handleStop() {
        if (win.BK.LanSync.stopDiscovery) {
            win.BK.LanSync.stopDiscovery().catch(function () {});
        }
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
        var port = parseInt(parts[1] || '18080', 10);
        var ip = parts[0];

        addLog('正在连接 ' + ip + ':' + port + '...');
        win.BK.LanSync.connect(ip, port, code).then(function (info) {
            addLog('已连接 ' + info.name + '（' + (info.books ? info.books.length : 0) + ' 本书）');
            // 手动连接成功后保存对端配对码，后续 pull/push 使用
            addDevice({ name: info.name, ip: ip, port: port, code: code });
        }).catch(function (err) {
            addLog('连接失败：' + (err.message || err));
        });
    }

    function _handlePull(ip, port, code) {
        if (state.transferring) { addLog('正在传输中，请稍候'); return; }
        state.transferring = true;
        // 使用对端配对码（来自设备记录或参数），而非本机 pairCode
        addLog('正在拉取数据...');
        win.BK.LanSync.pull(ip, port, code, { mode: state.mode }).then(function (result) {
            addLog('拉取完成：成功 ' + result.success + ' 本' + (result.failed ? '，失败 ' + result.failed + ' 本' : ''));
        }).catch(function (err) {
            addLog('拉取失败：' + (err.message || err));
        }).finally(function () {
            state.transferring = false;
        });
    }

    function _handlePush(ip, port, code) {
        if (state.transferring) { addLog('正在传输中，请稍候'); return; }
        state.transferring = true;
        // 使用对端配对码（来自设备记录或参数），而非本机 pairCode
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
        // 初始化 WebRTC 支持状态
        if (win.BK && win.BK.LanSyncWebRTC) {
            state.wrtc.supported = win.BK.LanSyncWebRTC.isSupported();
        }
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
            transferring: state.transferring,
            wrtc: {
                supported: state.wrtc.supported,
                connected: state.wrtc.connected,
                isInitiator: state.wrtc.isInitiator,
                offerText: state.wrtc.offerText,
                answerText: state.wrtc.answerText,
                scanning: state.wrtc.scanning
            }
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

    function _renderQr(info) {
        try {
            var connStr = win.BK.LanSyncQR.buildConnectionString({
                ip: info.ipAddress,
                port: info.port,
                code: info.pairCode
            });
            var qr = win.BK.LanSyncQR.render(connStr);
            return '<div class="lan-sync-qr"><div class="lan-sync-qr-label">扫码连接</div>' + qr.html + '</div>';
        } catch (e) {
            return '';
        }
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