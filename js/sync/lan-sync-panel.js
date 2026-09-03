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
 *
 * show()/hide() 已接入 BK.backStack，支持系统返回键返回上一层（对齐 data-sync-page 模式）
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
    var _inBackStack = false; // 是否已注册到 backStack（系统返回键关闭面板）

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
                '<button class="lan-sync-btn-pull" data-ip="' + _esc(d.ip) + '" data-port="' + d.port + '" data-code="' + _esc(d.code || '') + '">下载</button>' +
                '<button class="lan-sync-btn-push" data-ip="' + _esc(d.ip) + '" data-port="' + d.port + '" data-code="' + _esc(d.code || '') + '">发送</button>' +
                '</div>';
        }).join('');

        if (!devicesHtml) {
            devicesHtml = '<div class="lan-sync-no-device">还没有发现其他设备</div>' +
                '<div class="lan-sync-no-device-hint">请确认两台设备已连接同一个 WiFi，并已在对方设备上打开「局域网同步」</div>';
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
            '    <div class="lan-sync-tip">两台设备连接同一个 WiFi 后，即可互相传输书籍与阅读进度。</div>' +
            '    <div class="lan-sync-section">' +
            '      <div class="lan-sync-card">' +
            (running
                ? '<div class="lan-sync-status-dot on"></div>' +
                  '<div class="lan-sync-status-text">' +
                  '  <div class="lan-sync-status-title">本机已就绪</div>' +
                  '  <div class="lan-sync-status-desc">其他设备在「局域网同步」中可以看到这台设备</div>' +
                  '</div>' +
                  '<div class="lan-sync-qr-wrap">' +
                  (win.BK.LanSyncQR ? _renderQr(info) : '') +
                  '<div class="lan-sync-qr-tip">对方扫码即可连接本机</div>' +
                  '</div>' +
                  '<div class="lan-sync-code-line">' +
                  '  <span>配对码</span>' + codeHtml +
                  '</div>'
                : '<div class="lan-sync-status-text">' +
                  '  <div class="lan-sync-status-title">本机同步服务未开启</div>' +
                  '  <div class="lan-sync-status-desc">开启后才能被其他设备发现和连接</div>' +
                  '</div>' +
                  '<button class="lan-sync-btn-start">开启本机同步</button>') +
            '      </div>' +
            '    </div>' +
            '    <div class="lan-sync-section">' +
            '      <div class="lan-sync-section-title">找到设备后，点「下载」或「发送」</div>' +
            '      <div class="lan-sync-manual">' +
            '        <input type="text" class="lan-sync-input-ip" placeholder="输入对方 IP，如 192.168.1.5" />' +
            '        <input type="text" class="lan-sync-input-code" placeholder="配对码" />' +
            '        <button class="lan-sync-btn-connect">连接</button>' +
            '      </div>' +
            '      <div class="lan-sync-devices">' + devicesHtml + '</div>' +
            '    </div>' +
            (wrtcHtml ? '    <div class="lan-sync-section">' +
            '      <div class="lan-sync-section-title">扫码直连（浏览器间）</div>' +
            '      <div class="lan-sync-wrtc">' + wrtcHtml + '</div>' +
            '    </div>' : '') +
            '    <div class="lan-sync-section lan-sync-section-hideable">' +
            '      <div class="lan-sync-section-title">传输内容</div>' +
            '      <label class="lan-sync-radio"><input type="radio" name="lan-sync-mode" value="data"' + (state.mode === 'data' ? ' checked' : '') + '> 仅阅读数据（进度 · 书签 · 划线）</label>' +
            '      <label class="lan-sync-radio"><input type="radio" name="lan-sync-mode" value="full"' + (state.mode === 'full' ? ' checked' : '') + '> 连同书籍文件一起</label>' +
            '    </div>' +
            '    <div class="lan-sync-section lan-sync-section-hideable">' +
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
        if (win.BK && win.BK.SyncCore && win.BK.SyncCore.importFromZip) {
            addLog('正在导入接收的数据...');
            win.BK.SyncCore.importFromZip(buffer).then(function (result) {
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
        addLog('正在开启本机同步...');
        win.BK.LanSync.startServer().then(function (info) {
            state.serverRunning = true;
            state.serverInfo = info;
            addLog('本机同步已开启，配对码 ' + info.pairCode);
            // 自动启动 NSD 发现（仅 APK 环境可用时）
            _startDiscoveryIfNeeded();
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
            addLog('本机同步已关闭');
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
        if (panelEl.style.display !== 'none') return; // 幂等：已显示时不重复 push 回退栈
        // 初始化 WebRTC 支持状态
        if (win.BK && win.BK.LanSyncWebRTC) {
            state.wrtc.supported = win.BK.LanSyncWebRTC.isSupported();
        }
        panelEl.style.display = '';
        // 注册到 backStack：系统返回键关闭面板（对齐 data-sync-page/mark-panel 模式）
        if (win.BK && win.BK.backStack) {
            _inBackStack = true;
            win.BK.backStack.push(function () {
                _inBackStack = false;
                hide();
            });
        }
        addLog('面板已打开');
        // 打开面板即自动启动服务端（仅 APK；PWA 端仅作为客户端）
        _autoStartServer();
    }

    /**
     * 打开面板时自动启动同步服务端。
     * 先用 getStatus 校准状态（解决 Java 层 10 分钟空闲自动关闭、进程被杀等
     * 导致的 JS 状态与原生实际状态不一致），再决定是否调用 startServer。
     */
    function _autoStartServer() {
        var LanSync = win.BK && win.BK.LanSync;
        if (!LanSync || !LanSync.isAvailable()) return; // PWA 端：仅作为客户端，跳过

        // 1. 校准：向原生层查询真实服务状态，同步 UI 与 state
        LanSync.getStatus().then(function (st) {
            if (st && st.running) {
                state.serverRunning = true;
                state.serverInfo = st;  // {port, pairCode, ipAddress}
                _renderPanel();
                _startDiscoveryIfNeeded();
            } else {
                state.serverRunning = false;
                state.serverInfo = null;
                _renderPanel();
                // 2. 未运行 → 自动启动
                _handleStart();
            }
        }).catch(function () {
            // 查询失败（桥不可用等）→ 保守不自动启动，交由用户手动点击
            _renderPanel();
        });
    }

    /** 服务已运行时补开 NSD 自动发现（幂等） */
    function _startDiscoveryIfNeeded() {
        var LanSync = win.BK && win.BK.LanSync;
        if (!LanSync || !LanSync.isAvailable() || !LanSync.discover) return;
        LanSync.discover(function (device) {
            if (device) addDevice(device);
        }).catch(function () {});
    }

    function hide() {
        if (panelEl) panelEl.style.display = 'none';
        // 主动关闭（返回按钮等）：消耗对应 history 条目；
        // 系统返回键触发时回调已置 _inBackStack=false，不会走到这里
        if (_inBackStack && win.BK && win.BK.backStack) {
            _inBackStack = false;
            win.BK.backStack.discard();
        }
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