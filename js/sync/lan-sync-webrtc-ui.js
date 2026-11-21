/**
 * lan-sync-webrtc-ui.js — PWA↔PWA WebRTC 同步 UI（扫码信令交换）
 *
 * 在局域网同步面板中新增「PWA 直连」区域：
 *   - 发起方（A）：创建连接 → 生成 offer 二维码 → 显示
 *   - 应答方（B）：扫码（摄像头）→ 解析 offer → 生成 answer 二维码 → 显示
 *   - 发起方（A）：扫码（摄像头）→ 解析 answer → 连接建立
 *   - 连接后显示「推送」「拉取」按钮 + 传输模式
 *
 * 扫码实现：getUserMedia + video 元素 → canvas 帧 → jsQR 解码
 * 修复（2026-09）：video 元素此前从未插入 DOM，即使摄像头打开也看不到预览；
 * 现改为全屏扫码遮罩（BK.openDialog），支持取消按钮与系统返回键关闭，
 * video 设 muted 避免自动播放策略拦截，错误回调只通知一次防重复弹错。
 *
 * 依赖：
 *   - BK.LanSyncWebRTC (lan-sync-webrtc.js)
 *   - BK.LanSyncQR (lan-sync-qr.js) — 二维码渲染
 *   - win.jsQR (vendor/jsqr.min.js)
 *
 * 挂载：window.BK.LanSyncWebRTCUI
 */
(function (win) {
    'use strict';

    var _scanVideo = null;     // 扫码 video 元素
    var _scanStream = null;    // MediaStream
    var _scanRaf = 0;          // requestAnimationFrame id
    var _scanCb = null;        // 扫码成功回调
    var _scanErrorCb = null;   // 扫码错误回调
    var _scanCanvas = null;
    var _scanCtx = null;
    var _scanDialog = null;    // 扫码遮罩（BK.openDialog 返回值）
    var _scanErrorNotified = false; // 错误是否已通知（防重复）
    var _scanSucceeded = false;    // 是否已扫码成功（成功时关闭遮罩不再报"已取消"）

    // ── 扫码 ──────────────────────────────────────────────────────

    /** 关闭扫码遮罩（若存在） */
    function _closeScanDialog() {
        if (_scanDialog) {
            try { _scanDialog.close(); } catch (e) {}
            _scanDialog = null;
        }
    }

    /** 打开摄像头扫码
     * @param {Function} onSuccess  (text) 扫码成功
     * @param {Function} onError    (err) 失败/取消
     * @returns {Promise<{stop:Function}>}
     */
    function scanQR(onSuccess, onError) {
        _scanErrorNotified = false;
        _scanSucceeded = false;
        // 错误统一走 onError 通知（且仅一次）；已提供 onError 时不再 reject，
        // 避免调用方 onError + .catch 双重处理（面板三处调用均传 onError）
        function _failOnce(err) {
            if (!_scanErrorNotified) {
                _scanErrorNotified = true;
                if (onError) { try { onError(err); } catch (e) {} }
            }
            return onError ? Promise.resolve({ stop: stopScan }) : Promise.reject(err);
        }
        if (!win.navigator || !win.navigator.mediaDevices || !win.navigator.mediaDevices.getUserMedia) {
            return _failOnce(new Error('当前环境不支持摄像头（需 HTTPS 或 localhost）'));
        }
        if (typeof win.jsQR !== 'function') {
            return _failOnce(new Error('扫码库未加载（jsQR）'));
        }

        _scanErrorCb = onError || null;
        _scanRaf = 0;

        // 打开全屏扫码遮罩：内嵌 video 预览 + 取消按钮，接系统返回键
        var tip = '正在打开摄像头...';
        _scanDialog = BK.openDialog({
            id: 'bk-scan-dialog',
            className: 'bk-dialog-mask bk-scan-dialog',
            html: '<div class="bk-scan-dialog-box">' +
                '<div class="bk-scan-dialog-title">扫码</div>' +
                '<div class="bk-scan-dialog-video-wrap"><video playsinline muted autoplay></video>' +
                '<div class="bk-scan-dialog-tip">' + tip + '</div></div>' +
                '<button class="bk-scan-dialog-cancel">取消</button>' +
                '</div>',
            onClose: function () {
                // 遮罩被关闭（取消/系统返回键/点遮罩）：停止扫码并通知错误回调；
                // 扫码成功路径先置 _scanSucceeded 再关遮罩，不会误报取消
                stopScan();
                if (!_scanErrorNotified && !_scanSucceeded) {
                    _scanErrorNotified = true;
                    if (_scanErrorCb) {
                        try { _scanErrorCb(new Error('已取消扫码')); } catch (e) {}
                    }
                }
                _scanDialog = null;
            }
        });
        if (!_scanDialog) {
            // 同 id 遮罩已存在（上次未关）：复用提示，直接失败返回
            return _failOnce(new Error('扫码遮罩已打开，请先关闭'));
        }
        var cancelBtn = _scanDialog.mask.querySelector('.bk-scan-dialog-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', function () {
            _closeScanDialog();
        });

        return win.navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: false
        }).then(function (stream) {
            _scanStream = stream;
            var video = _scanDialog
                ? _scanDialog.mask.querySelector('video')
                : null;
            if (!video) { // 遮罩已被提前关闭
                stopScan();
                return { stop: stopScan };
            }
            video.srcObject = stream;
            video.muted = true; // muted 属性在部分 WebView 不生效，JS 属性双保险
            var p = video.play();
            if (p && typeof p.catch === 'function') {
                p.catch(function () { /* 自动播放拦截不阻断：video 有 muted 属性，静默重试 */ });
            }
            _scanVideo = video;

            // 摄像头已打开：隐藏"正在打开"提示，显示对准提示
            var tipEl = _scanDialog && _scanDialog.mask.querySelector('.bk-scan-dialog-tip');
            if (tipEl) tipEl.textContent = '将二维码放入框内，自动识别';

            _scanCanvas = document.createElement('canvas');
            _scanCanvas.width = 640;
            _scanCanvas.height = 640;
            _scanCtx = _scanCanvas.getContext('2d');

            var keepScanning = true;

            function tick() {
                if (!keepScanning || !_scanVideo || _scanVideo.readyState < 2) {
                    if (!keepScanning) return;
                    _scanRaf = requestAnimationFrame(tick);
                    return;
                }
                try {
                    var w = _scanVideo.videoWidth;
                    var h = _scanVideo.videoHeight;
                    if (w && h) {
                        _scanCtx.drawImage(_scanVideo, 0, 0, 640, 640);
                        var imageData = _scanCtx.getImageData(0, 0, 640, 640);
                        var code = win.jsQR(imageData.data, imageData.width, imageData.height);
                        if (code && code.data) {
                            keepScanning = false;
                            _scanSucceeded = true;
                            stopScan();
                            _closeScanDialog();
                            if (onSuccess) onSuccess(code.data);
                            return;
                        }
                    }
                } catch (e) { /* 单帧解码失败忽略 */ }
                _scanRaf = requestAnimationFrame(tick);
            }
            _scanRaf = requestAnimationFrame(tick);

            return { stop: stopScan };
        }).catch(function (err) {
            // getUserMedia 失败：先通知真实错误（遮罩 onClose 见 _scanErrorNotified 不会重复报"已取消"），再关遮罩
            _failOnce(err);
            _closeScanDialog();
            return onError ? Promise.resolve({ stop: stopScan }) : Promise.reject(err);
        });
    }

    /** 停止扫码（保持流关闭） */
    function stopScan() {
        if (_scanRaf) { cancelAnimationFrame(_scanRaf); _scanRaf = 0; }
        if (_scanStream) {
            try {
                _scanStream.getTracks().forEach(function (t) { t.stop(); });
            } catch (e) {}
            _scanStream = null;
        }
        if (_scanVideo) {
            try { _scanVideo.srcObject = null; } catch (e) {}
            _scanVideo = null;
        }
        _scanCanvas = null;
        _scanCtx = null;
    }

    /** 外部停止扫码（面板「取消」路径）：同步关闭遮罩，经由 onClose 通知取消 */
    function stopScanning() {
        _closeScanDialog();
        stopScan();
        return Promise.resolve();
    }

    // ── 渲染辅助（供面板调用）────────────────────────────────────

    /**
     * 渲染信令二维码 HTML
     * @param {string} signalText 信令文本（bk-wrtc-v1:...）
     * @param {string} label      标签（'将二维码给对方扫描' / '扫描对方屏幕上的二维码'）
     * @returns {string} HTML
     */
    function renderSignalQr(signalText, label) {
        try {
            var qr = win.BK.LanSyncQR.render(signalText);
            var html = '<div class="lan-sync-wrtc-qr">';
            if (label) html += '<div class="lan-sync-wrtc-qr-label">' + label + '</div>';
            html += qr.html;
            html += '</div>';
            // 附带复制按钮（降级路径）
            html += '<div class="lan-sync-wrtc-copy"><button class="lan-sync-btn-copy" data-text="' + _escapeAttr(signalText) + '">复制信令文本</button></div>';
            return html;
        } catch (e) {
            return '<div class="lan-sync-wrtc-qr">二维码生成失败</div>';
        }
    }

    function _escapeAttr(s) {
        return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── 导出 ─────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.LanSyncWebRTCUI = {
        scanQR: scanQR,
        stopScan: stopScanning,
        renderSignalQr: renderSignalQr
    };

})(window);