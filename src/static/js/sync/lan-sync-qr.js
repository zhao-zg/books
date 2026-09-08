/**
 * lan-sync-qr.js — QR 码生成与连接字符串处理
 *
 * 功能：
 *   - buildConnectionString({ip, port, code}) → 'bk-sync://ip:port?code=xxx'
 *   - parseConnectionString(str) → {ip, port, code}
 *   - render(str) → {html} 渲染 QR 码为 HTML table
 *
 * 依赖：vendor/qrcode.min.js (qrcode-generator by Kazuhiko Arase)
 *
 * 挂载：window.BK.LanSyncQR
 */
(function (win) {
    'use strict';

    var PROTOCOL = 'bk-sync://';

    function buildConnectionString(info) {
        // IPv6 地址需用方括号包裹（如 [fd00::1]:18080）
        var ip = info.ip.indexOf(':') > -1 ? '[' + info.ip + ']' : info.ip;
        return PROTOCOL + ip + ':' + info.port + '?code=' + info.code;
    }

    function parseConnectionString(str) {
        if (!str || str.indexOf(PROTOCOL) !== 0) return null;
        var rest = str.substring(PROTOCOL.length);
        var qIdx = rest.indexOf('?code=');
        var hostPart, code;
        if (qIdx > -1) {
            hostPart = rest.substring(0, qIdx);
            code = rest.substring(qIdx + 6);
        } else {
            hostPart = rest;
            code = '';
        }
        // IPv6 格式 [addr]:port，IPv4 格式 addr:port
        var ip, port;
        if (hostPart.charAt(0) === '[') {
            var closeIdx = hostPart.indexOf(']');
            ip = hostPart.substring(1, closeIdx);
            var portPart = hostPart.substring(closeIdx + 2); // 跳过 "]:"
            port = parseInt(portPart || '18080', 10);
        } else {
            var parts = hostPart.split(':');
            ip = parts[0];
            port = parseInt(parts[1] || '18080', 10);
        }
        return {
            ip: ip,
            port: port,
            code: code
        };
    }

    function render(text) {
        var QRCode = win.qrcode;
        if (!QRCode) return { html: '<div>QR 库未加载</div>' };

        var qr = QRCode(0, 'M'); // type=0 auto, error correction M
        qr.addData(text);
        qr.make();

        // 自适应模块尺寸：长信令（如 WebRTC offer）模块数多，
        // 固定 3px 会在窄屏溢出（620px+ 宽度）。按视口与模块数动态计算，
        // 并用 CSS max-width:100% 兜底（css-lan-sync.css 已覆盖 td 内联宽高）。
        var count = qr.getModuleCount();
        var viewportW = 300;
        try { viewportW = Math.min(win.innerWidth || 300, 600); } catch (e) {}
        var availW = Math.max(120, viewportW - 64); // 减去面板左右 padding
        var px = Math.max(1, Math.min(4, Math.floor(availW / count)));

        var html = '';
        html += '<table class="lan-sync-qr-table" style="border-collapse:collapse;">';
        for (var r = 0; r < count; r++) {
            html += '<tr>';
            for (var c = 0; c < count; c++) {
                var dark = qr.isDark(r, c);
                html += '<td style="width:' + px + 'px;height:' + px + 'px;background:' + (dark ? '#000' : '#fff') + ';"></td>';
            }
            html += '</tr>';
        }
        html += '</table>';
        return { html: html, size: count };
    }

    win.BK = win.BK || {};
    win.BK.LanSyncQR = {
        buildConnectionString: buildConnectionString,
        parseConnectionString: parseConnectionString,
        render: render
    };

})(window);