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

    // ── 扫码 ──────────────────────────────────────────────────────

    /**
     * 打开摄像头扫码
     * @param {Function} onSuccess  (text) 扫码成功
     * @param {Function} onError    (err) 失败/取消
     * @returns {Promise<{stop:Function}>}
     */
    function scanQR(onSuccess, onError) {
        if (!win.navigator || !win.navigator.mediaDevices || !win.navigator.mediaDevices.getUserMedia) {
            var err = new Error('当前环境不支持摄像头（需 HTTPS 或 localhost）');
            if (onError) onError(err);
            return Promise.reject(err);
        }
        if (typeof win.jsQR !== 'function') {
            var err2 = new Error('扫码库未加载（jsQR）');
            if (onError) onError(err2);
            return Promise.reject(err2);
        }

        _scanErrorCb = onError || null;
        _scanRaf = 0;

        return win.navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: false
        }).then(function (stream) {
            _scanStream = stream;
            var video = document.createElement('video');
            video.setAttribute('playsinline', 'true');
            video.style.width = '100%';
            video.style.maxWidth = '400px';
            video.style.aspectRatio = '1/1';
            video.style.objectFit = 'cover';
            video.style.borderRadius = '8px';
            video.srcObject = stream;
            video.play();
            _scanVideo = video;

            _scanCanvas = document.createElement('canvas');
            _scanCanvas.width = 640;
            _scanCanvas.height = 640;
            _scanCtx = _scanCanvas.getContext('2d');

            var keepScanning = true;

            function tick() {
                if (!keepScanning || !_scanVideo || _scanVideo.readyState < 2) {
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
                            stopScan();
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
            if (onError) onError(err);
            throw err;
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

    function stopScanning() {
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