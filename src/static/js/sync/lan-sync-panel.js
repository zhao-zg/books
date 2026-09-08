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

        // 本机地址信息（IP:端口）——补全卡片信息，PWA 端无服务时显示占位
        var selfAddrHtml = info.ipAddress
            ? '<div class="lan-sync-self-addr">本机地址 <span class="lan-sync-self-addr-val">' + _esc(info.ipAddress) + ':' + _esc(info.port || '18080') + '</span></div>'
            : '<div class="lan-sync-self-addr">本机地址：启动同步后显示</div>';

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
                  '<button class="lan-sync-btn-stop">停止本机同步</button>' +
                  '<div class="lan-sync-qr-wrap">' +
                  (win.BK.LanSyncQR ? _renderQr(info) : '') +
                  '<div class="lan-sync-qr-tip">对方扫码即可连接本机</div>' +
                  '</div>' +
                  selfAddrHtml +
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
            '        <button class="lan-sync-btn-connect">连接</button>' +
            '        <button class="lan-sync-btn-scan-connect">扫码</button>' +
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

        // 面板每次重建后必须重新捕获 logArea 引用（innerHTML 重建会丢弃旧节点，
        // 若沿用旧引用，传输日志会追加到已脱离文档的节点上，页面不再显示）
        logArea = panelEl.querySelector('.lan-sync-log');
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

        // 停止本机同步（运行中显示在状态卡片内）
        var stopBtn = panelEl.querySelector('.lan-sync-btn-stop');
        if (stopBtn) stopBtn.onclick = _handleStop;

        // 扫码连接（扫对方 bk-sync:// 二维码，直接填入设备列表）
        var scanConnBtn = panelEl.querySelector('.lan-sync-btn-scan-connect');
        if (scanConnBtn) scanConnBtn.onclick = _handleScanConnect;

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
        var LanSync = win.BK && win.BK.LanSync;
        if (!LanSync) return;
        if (LanSync.stopDiscovery) {
            LanSync.stopDiscovery().catch(function () {});
        }
        LanSync.stopServer().then(function () {
            state.serverRunning = false;
            state.serverInfo = null;
            state.devices = [];
            addLog('本机同步已关闭');
            _renderPanel();
        }).catch(function (err) {
            addLog('关闭失败：' + (err.message || err));
        });
    }

    /** 扫码连接：扫对方「本机状态」卡片里的 bk-sync:// 二维码，自动填入并连接 */
    function _handleScanConnect() {
        var UI = win.BK && win.BK.LanSyncWebRTCUI;
        var QR = win.BK && win.BK.LanSyncQR;
        if (!UI || !UI.scanQR) { addLog('当前环境不支持扫码'); return; }
        if (!QR || !QR.parseConnectionString) { addLog('连接串解析模块未加载'); return; }

        addLog('正在打开摄像头，扫对方设备上的「扫码连接」二维码...');
        var handled = false;
        UI.scanQR(function (text) {
            if (handled) return;
            handled = true;
            var info = QR.parseConnectionString(text);
            if (!info || !info.ip) {
                addLog('二维码不是书报局域网同步码');
                return;
            }
            if (!info.code) {
                addLog('二维码缺少配对码，请在对方面板查看后手动输入');
                addDevice({ name: '对方设备', ip: info.ip, port: info.port, code: '' });
                return;
            }
            addLog('已识别 ' + info.ip + ':' + info.port + '，正在连接...');
            win.BK.LanSync.connect(info.ip, info.port, info.code).then(function (peer) {
                addLog('已连接 ' + peer.name + '（' + (peer.books ? peer.books.length : 0) + ' 本书）');
                addDevice({ name: peer.name, ip: info.ip, port: info.port, code: info.code });
            }).catch(function (err) {
                addLog('连接失败：' + (err.message || err));
                addDevice({ name: '对方设备', ip: info.ip, port: info.port, code: info.code });
            });
        }, function (err) {
            addLog('扫码失败：' + (err.message || err));
        }).catch(function (err) {
            addLog('扫码失败：' + (err.message || err));
        });
    }

    function _handleManualConnect() {
        var ipInput = panelEl.querySelector('.lan-sync-input-ip');
        if (!ipInput) return;
        var addr = ipInput.value.trim();
        if (!addr) { _toast('请输入对方 IP'); return; }

        var parts = addr.split(':');
        var port = parseInt(parts[1] || '18080', 10);
        var ip = parts[0];

        // 配对码改为连接时弹窗输入（手动输入 IP 场景无配对码来源）
        _askPairCode('连接 ' + ip + ':' + port).then(function (code) {
            addLog('正在连接 ' + ip + ':' + port + '...');
            return win.BK.LanSync.connect(ip, port, code).then(function (info) {
                addLog('已连接 ' + info.name + '（' + (info.books ? info.books.length : 0) + ' 本书）');
                // 手动连接成功后保存对端配对码，后续 pull/push 使用
                addDevice({ name: info.name, ip: ip, port: port, code: code });
            });
        }).catch(function (err) {
            if (err && err.code === 'cancelled') return; // 用户取消
            addLog('连接失败：' + (err.message || err));
        });
    }

    /**
     * 弹窗输入配对码。返回 Promise<string>；用户取消时 reject { code: 'cancelled' }。
     * @param {string} label 提示文案（如「连接 192.168.1.5:18080」）
     */
    function _askPairCode(label) {
        return new Promise(function (resolve, reject) {
            if (!win.BK || !win.BK.openDialog) {
                reject(new Error('弹窗系统未就绪'));
                return;
            }
            var html =
                '<div class="lan-sync-code-dialog">' +
                '  <div class="lan-sync-code-dialog-title">输入配对码</div>' +
                '  <div class="lan-sync-code-dialog-desc">请在对方面板查看 6 位配对码</div>' +
                (label ? '  <div class="lan-sync-code-dialog-target">' + _esc(label) + '</div>' : '') +
                '  <input type="text" class="lan-sync-code-dialog-input" inputmode="numeric" maxlength="6" placeholder="如 123456" />' +
                '  <div class="lan-sync-code-dialog-actions">' +
                '    <button class="lan-sync-code-dialog-cancel">取消</button>' +
                '    <button class="lan-sync-code-dialog-ok">确定</button>' +
                '  </div>' +
                '</div>';
            var dlg = win.BK.openDialog({
                id: 'bk-lan-sync-code-dialog',
                html: html,
                onClose: function () {
                    // 系统返回键/点遮罩关闭：若未结算则视为取消（settled 守卫防重入）。
                    // 此时栈条目已被 pop，不能再调 dlg.close()（会 discard 掉别人的条目）
                    _done(false, true);
                }
            });
            if (!dlg) {
                reject(new Error('配对码弹窗已打开'));
                return;
            }
            var input = dlg.mask.querySelector('.lan-sync-code-dialog-input');
            var settled = false;
            /**
             * @param {boolean} ok
             * @param {boolean} [fromOnClose] true=由 onClose 触发（back 键/点遮罩），
             *        此时弹窗已在销毁中，不可两调 dlg.close()
             */
            function _done(ok, fromOnClose) {
                if (settled) return;
                settled = true;
                if (ok) {
                    resolve(input ? input.value.trim() : '');
                } else {
                    reject({ code: 'cancelled' });
                }
                if (!fromOnClose) {
                    try { dlg.close(); } catch (e) {}
                }
            }
            if (input) {
                input.addEventListener('input', function () {
                    // 只保留数字
                    input.value = input.value.replace(/\D/g, '').slice(0, 6);
                });
                input.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') _done(true);
                });
                // 自动聚焦（弹层动画后）
                setTimeout(function () { try { input.focus(); } catch (e) {} }, 60);
            }
            var cancelBtn = dlg.mask.querySelector('.lan-sync-code-dialog-cancel');
            if (cancelBtn) cancelBtn.addEventListener('click', function () { _done(false); });
            var okBtn = dlg.mask.querySelector('.lan-sync-code-dialog-ok');
            if (okBtn) okBtn.addEventListener('click', function () {
                if (!input || !input.value.trim()) { _toast('请输入配对码'); return; }
                _done(true);
            });
        });
    }

    // Toast 提示（失败/操作反馈，与传输日志互补）
    var _toastTimer = null;
    function _toast(msg) {
        try {
            if (!document.getElementById('bk-lan-sync-toast-style')) {
                var st = document.createElement('style');
                st.id = 'bk-lan-sync-toast-style';
                st.textContent =
                    '.bk-lan-sync-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%) translateY(12px);' +
                    'background:rgba(0,0,0,.75);color:#FFF;padding:10px 18px;border-radius:8px;font-size:13px;z-index:10001;' +
                    'opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;max-width:80vw;text-align:center}' +
                    '.bk-lan-sync-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}';
                document.head.appendChild(st);
            }
            var el = document.createElement('div');
            el.className = 'bk-lan-sync-toast';
            el.textContent = msg;
            document.body.appendChild(el);
            requestAnimationFrame(function () { el.classList.add('show'); });
            if (_toastTimer) clearTimeout(_toastTimer);
            _toastTimer = setTimeout(function () {
                el.classList.remove('show');
                setTimeout(function () { try { document.body.removeChild(el); } catch (e) {} }, 300);
            }, 2400);
        } catch (e) { /* toast 不影响主流程 */ }
    }

    function _handlePull(ip, port, code) {
        if (state.transferring) { _toast('正在传输中，请稍候'); return; }
        // 无配对码（手动输入 IP 场景）时弹窗输入，成功后回写设备记录
        var codeReady = code
            ? Promise.resolve(code)
            : _askPairCode('从 ' + ip + ':' + port + ' 下载');
        codeReady.then(function (pairCode) {
            if (!pairCode) { _toast('请输入配对码'); return; }
            _doTransfer('pull', ip, port, pairCode);
        }).catch(function (err) {
            if (err && err.code === 'cancelled') return; // 用户取消
            addLog('拉取失败：' + (err.message || err));
            _toast(err.message || '拉取失败');
        });
    }

    function _handlePush(ip, port, code) {
        if (state.transferring) { _toast('正在传输中，请稍候'); return; }
        var codeReady = code
            ? Promise.resolve(code)
            : _askPairCode('发送到 ' + ip + ':' + port);
        codeReady.then(function (pairCode) {
            if (!pairCode) { _toast('请输入配对码'); return; }
            _doTransfer('push', ip, port, pairCode);
        }).catch(function (err) {
            if (err && err.code === 'cancelled') return;
            addLog('推送失败：' + (err.message || err));
            _toast(err.message || '推送失败');
        });
    }

    /** 执行传输（pull/push）：按钮 loading、成功/失败 toast、配对码回写设备记录 */
    function _doTransfer(action, ip, port, code) {
        state.transferring = true;
        var isPull = action === 'pull';
        addLog(isPull ? '正在拉取数据...' : '正在推送数据...');

        // 按钮 loading：所有 pull/push 按钮置灰防重复点击
        var btns = panelEl.querySelectorAll('.lan-sync-btn-pull, .lan-sync-btn-push');
        for (var i = 0; i < btns.length; i++) btns[i].classList.add('lan-sync-busy');

        var op = isPull
            ? win.BK.LanSync.pull(ip, port, code, { mode: state.mode })
            : win.BK.LanSync.push(ip, port, code, { mode: state.mode });

        op.then(function (result) {
            var msg = isPull
                ? '拉取完成：成功 ' + result.success + ' 本' + (result.failed ? '，失败 ' + result.failed + ' 本' : '')
                : '推送完成：对端成功 ' + result.success + ' 本' + (result.failed ? '，失败 ' + result.failed + ' 本' : '');
            addLog(msg);
            _toast(isPull ? '拉取完成' : '发送完成');
            // 传输成功：配对码回写设备记录，下次免输
            _updateDeviceCode(ip, port, code);
        }).catch(function (err) {
            var msg = (isPull ? '拉取失败：' : '推送失败：') + (err.message || err);
            addLog(msg);
            _toast(msg); // 真实报错可见，不再只写日志
        }).finally(function () {
            state.transferring = false;
            var busy = panelEl.querySelectorAll('.lan-sync-busy');
            for (var j = 0; j < busy.length; j++) busy[j].classList.remove('lan-sync-busy');
        });
    }

    /** 传输成功后回写配对码到设备记录（后续 pull/push 免输） */
    function _updateDeviceCode(ip, port, code) {
        if (!code) return;
        for (var i = 0; i < state.devices.length; i++) {
            if (state.devices[i].ip === ip && state.devices[i].port === port) {
                if (state.devices[i].code !== code) {
                    state.devices[i].code = code;
                    _renderPanel();
                }
                return;
            }
        }
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

    /** 移除设备：支持按 ip 或按 name（NSD onServiceLost 只有服务名） */
    function removeDevice(ip, name) {
        var before = state.devices.length;
        state.devices = state.devices.filter(function (d) {
            if (ip) return d.ip !== ip;
            if (name) return d.name !== name;
            return true;
        });
        if (state.devices.length !== before) _renderPanel();
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