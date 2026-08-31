/**
 * lan-sync-webrtc.js — PWA↔PWA WebRTC DataChannel 同步
 *
 * 解决 PWA↔PWA（两端浏览器无法监听 TCP 端口）的同步问题。
 * Phase 1 的 NSD+HTTP 只覆盖 APK↔APK / APK↔PWA，WebRTC 是 PWA↔PWA 的唯一可行方案。
 *
 * 信令交换（二维码方案）：
 *   设备 A（发起方）：createOffer → RTCPeerConnection + createDataChannel
 *                     → SDP JSON 压缩 → 二维码显示
 *   设备 B（应答方）：扫码获得 offer → setRemoteDescription → createAnswer
 *                     → SDP JSON 压缩 → 二维码显示
 *   设备 A：扫码获得 answer → setRemoteDescription → 连接建立
 *
 * 传输：
 *   DataChannel 是双工通道。信令建立后，任意一端可发起：
 *     push：generateZipBytes() → DataChannel send → 对端 importFromZip()
 *     pull：发送 'pull' 请求 → 对端 generateZipBytes() → DataChannel 回传 → importFromZip()
 *
 * 关键实现点：
 *   - SDP 压缩：LZString.compressToUTF16（比 base64 更紧凑，适合二维码）
 *   - 局域网无需 STUN/TURN：host candidate 直接内嵌 SDP，ICE 用 end-of-candidates
 *   - DataChannel 消息协议：控制消息 JSON 文本 / 数据消息二进制
 *
 * 依赖：
 *   - LZString (vendor/lz-string.min.js)
 *   - BK.Sync.generateZipBytes / importFromZip (sync-export.js / sync-import.js)
 *
 * 挂载：window.BK.WebRTCSync
 */
(function (win) {
    'use strict';

    var PROTOCOL = 'bk-wrtc-v1:';

    // ── 信令编码/解码（纯函数，可单测）──────────────────────────────

    /**
     * 生成信令文本（用于二维码 / 复制）
     * @param {Object} payload {type:'offer'|'answer', sdp:string}
     * @returns {string} 'bkrtc-v1:' + LZString.compressToUTF16(JSON)
     */
    function encodeSignal(payload) {
        var LZ = win.LZString;
        if (!LZ) throw new Error('LZString 未加载');
        var json = JSON.stringify(payload);
        return PROTOCOL + LZ.compressToUTF16(json);
    }

    /**
     * 解码信令文本
     * @param {string} text
     * @returns {Object|null} {type, sdp} 或 null（无效）
     */
    function decodeSignal(text) {
        if (!text || typeof text !== 'string' || text.indexOf(PROTOCOL) !== 0) return null;
        var LZ = win.LZString;
        if (!LZ) return null;
        try {
            var json = LZ.decompressFromUTF16(text.substring(PROTOCOL.length));
            if (!json) return null;
            var payload = JSON.parse(json);
            if (!payload || (payload.type !== 'offer' && payload.type !== 'answer')) return null;
            if (!payload.sdp || typeof payload.sdp !== 'string') return null;
            return { type: payload.type, sdp: payload.sdp };
        } catch (e) {
            return null;
        }
    }

    // ── WebRTC 环境检测 ───────────────────────────────────────────

    function _getRTCPeerConnection() {
        return win.RTCPeerConnection || win.webkitRTCPeerConnection || null;
    }

    function isSupported() {
        var PC = _getRTCPeerConnection();
        return !!(PC && win.RTCSessionDescription && win.RTCDataChannel);
    }

    // ── 连接状态管理 ─────────────────────────────────────────────

    var _conn = null;        // 当前 RTCPeerConnection
    var _channel = null;     // 当前 RTCDataChannel
    var _isInitiator = false;
    var _onMessageCb = null; // 收到数据回调
    var _onStateCb = null;   // 状态变更回调
    var _onFileCb = null;    // 收到 ZIP 数据回调（传输完成）

    // ── 创建发起方连接（A 端）─────────────────────────────────────

    /**
     * 创建发起方（offer）连接
     * @param {Object} [opts] {onMessage, onState, onFile}
     * @returns {Promise<{signalText:string}>} 返回编码后的 offer 信令文本
     */
    function createOffer(opts) {
        opts = opts || {};
        var PC = _getRTCPeerConnection();
        if (!PC) return Promise.reject(new Error('当前环境不支持 WebRTC'));

        _cleanup();
        _isInitiator = true;
        _onMessageCb = opts.onMessage || null;
        _onStateCb = opts.onState || null;
        _onFileCb = opts.onFile || null;

        var pc = new PC({ iceServers: [] });
        _conn = pc;

        var dc = pc.createDataChannel('bk-sync', { ordered: true });
        _setupChannel(dc);

        return pc.createOffer().then(function (offer) {
            return pc.setLocalDescription(offer);
        }).then(function () {
            // 局域网场景：等待 ICE gathering 完成（host candidate 内嵌 SDP）
            return _waitIceComplete(pc);
        }).then(function () {
            var sdp = pc.localDescription.sdp;
            return { signalText: encodeSignal({ type: 'offer', sdp: sdp }) };
        });
    }

    /**
     * 接受发起方（B 端）：输入 A 的 offer 信令文本 → 创建 answer 信令文本
     * @param {string} offerText  A 端二维码文本
     * @param {Object} [opts] {onMessage, onState, onFile}
     * @returns {Promise<{signalText:string}>} 编码后的 answer 信令文本
     */
    function acceptOffer(offerText, opts) {
        opts = opts || {};
        var PC = _getRTCPeerConnection();
        if (!PC) return Promise.reject(new Error('当前环境不支持 WebRTC'));

        var signal = decodeSignal(offerText);
        if (!signal || signal.type !== 'offer') {
            return Promise.reject(new Error('无效的 offer 信令'));
        }

        _cleanup();
        _isInitiator = false;
        _onMessageCb = opts.onMessage || null;
        _onStateCb = opts.onState || null;
        _onFileCb = opts.onFile || null;

        var pc = new PC({ iceServers: [] });
        _conn = pc;

        pc.ondatachannel = function (event) {
            _setupChannel(event.channel);
        };

        return pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp }).then(function () {
            return pc.createAnswer();
        }).then(function (answer) {
            return pc.setLocalDescription(answer);
        }).then(function () {
            return _waitIceComplete(pc);
        }).then(function () {
            var sdp = pc.localDescription.sdp;
            return { signalText: encodeSignal({ type: 'answer', sdp: sdp }) };
        });
    }

    /**
     * 接受 answer（A 端第二步）：输入 answer 信令文本 → 完成连接
     * @param {string} answerText B 生成的 answer 二维码文本
     * @returns {Promise}
     */
    function acceptAnswer(answerText) {
        if (!_conn) return Promise.reject(new Error('请先创建 offer'));
        var signal = decodeSignal(answerText);
        if (!signal || signal.type !== 'answer') {
            return Promise.reject(new Error('无效的 answer 信令'));
        }
        return _conn.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    }

    // ── ICE 等待（局域网 host candidate 内嵌 SDP）────────────────

    function _waitIceComplete(pc) {
        return new Promise(function (resolve) {
            // 若已收集完成直接 resolve
            if (pc.iceGatheringState === 'complete') { resolve(); return; }

            var timer = setTimeout(function () {
                pc.removeEventListener('icegatheringstatechange', onComplete);
                resolve();
            }, 3000);

            function onComplete() {
                if (pc.iceGatheringState === 'complete') {
                    clearTimeout(timer);
                    pc.removeEventListener('icegatheringstatechange', onComplete);
                    resolve();
                }
            }

            pc.addEventListener('icegatheringstatechange', onComplete);
        });
    }

    // ── DataChannel 设置 ─────────────────────────────────────────

    function _setupChannel(dc) {
        _channel = dc;

        dc.onopen = function () {
            _notifyState({ status: 'open' });
        };

        dc.onclose = function () {
            _notifyState({ status: 'closed' });
        };

        dc.onerror = function (e) {
            _notifyState({ status: 'error', error: (e && e.message) || 'DataChannel 错误' });
        };

        dc.onmessage = function (event) {
            _handleChannelMessage(event.data);
        };
    }

    /**
     * DataChannel 消息分发：
     *   - 控制消息（JSON 字符串）：{type:'file', name, size} / {type:'pull', mode, books}
     *   - 二进制数据：文件内容分片
     */
    function _handleChannelMessage(data) {
        // 文本 → JSON 控制消息
        if (typeof data === 'string') {
            try {
                var msg = JSON.parse(data);
                if (msg && msg.type) {
                    _handleControl(msg);
                    return;
                }
            } catch (e) { /* 非 JSON 文本，忽略 */ }
        }

        // 二进制 → 组装 ZIP 分片
        _appendBinary(data);
    }

    // ── ZIP 分片组装 ─────────────────────────────────────────────

    var _fileBuffer = null;   // Uint8Array
    var _fileReceived = 0;
    var _fileExpected = 0;

    function _startFile(name, size) {
        _fileBuffer = new Uint8Array(size);
        _fileReceived = 0;
        _fileExpected = size;
    }

    function _appendBinary(data) {
        if (!_fileBuffer) return; // 无活动文件传输，忽略
        var bytes;
        if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data);
        } else if (data && data.byteLength !== undefined) {
            bytes = new Uint8Array(data);
        } else if (data instanceof Blob) {
            // Blob 需异步读，这里用 FileReader（DataChannel 极少发 Blob）
            var reader = new FileReader();
            reader.onload = function () {
                _appendBytes(new Uint8Array(reader.result));
            };
            reader.readAsArrayBuffer(data);
            return;
        } else {
            return;
        }

        _appendBytes(bytes);
    }

    function _appendBytes(bytes) {
        _fileBuffer.set(bytes, _fileReceived);
        _fileReceived += bytes.length;
        if (_fileReceived >= _fileExpected) {
            var full = _fileBuffer.buffer;
            _fileBuffer = null;
            _notifyFile(full);
        }
    }

    // ── 控制消息处理 ─────────────────────────────────────────────

    function _handleControl(msg) {
        switch (msg.type) {
            case 'file-start':
                // 对端开始发 ZIP
                _startFile(msg.name || 'sync.zip', msg.size || 0);
                break;
            case 'file-end':
                // 对端结束
                break;
            case 'pull':
                // 对端请求拉取 → 本机生成 ZIP 回传
                _handlePullRequest(msg.mode || 'data', msg.books || []);
                break;
            default:
                break;
        }
    }

    function _handlePullRequest(mode, books) {
        if (!win.BK || !win.BK.Sync || !win.BK.Sync.generateZipBytes) {
            _sendControl({ type: 'error', message: 'generateZipBytes 未就绪' });
            return;
        }
        win.BK.Sync.generateZipBytes(books, { mode: mode }).then(function (bytes) {
            _sendControl({ type: 'file-start', name: 'sync.zip', size: bytes.length });
            _sendBinary(bytes);
        }).catch(function (err) {
            _sendControl({ type: 'error', message: err.message || String(err) });
        });
    }

    // ── 发送 ─────────────────────────────────────────────────────

    function _sendControl(msg) {
        if (!_channel || _channel.readyState !== 'open') return;
        _channel.send(JSON.stringify(msg));
    }

    function _sendBinary(bytes) {
        if (!_channel || _channel.readyState !== 'open') return;
        // DataChannel 单帧 64KB 限制，分片发送
        var CHUNK = 64 * 1024;
        for (var i = 0; i < bytes.length; i += CHUNK) {
            var end = Math.min(i + CHUNK, bytes.length);
            _channel.send(bytes.subarray(i, end));
        }
    }

    /**
     * 推送 ZIP 数据到对端（本端发起 push）
     * @param {string[]} bookIds
     * @param {Object} [opts] {mode:'data'|'full'}
     * @returns {Promise}
     */
    function push(bookIds, opts) {
        opts = opts || {};
        if (!_channel || _channel.readyState !== 'open') {
            return Promise.reject(new Error('连接未建立'));
        }
        if (!win.BK || !win.BK.Sync || !win.BK.Sync.generateZipBytes) {
            return Promise.reject(new Error('generateZipBytes 未就绪'));
        }
        return win.BK.Sync.generateZipBytes(bookIds, { mode: opts.mode || 'data' }).then(function (bytes) {
            _sendControl({ type: 'file-start', name: 'sync.zip', size: bytes.length });
            _sendBinary(bytes);
            return { sent: bytes.length };
        });
    }

    /**
     * 拉取对端 ZIP 数据（本端发起 pull）
     * @param {Object} [opts] {mode:'data'|'full', books:[]}
     * @returns {Promise}
     */
    function pull(opts) {
        opts = opts || {};
        if (!_channel || _channel.readyState !== 'open') {
            return Promise.reject(new Error('连接未建立'));
        }
        _sendControl({ type: 'pull', mode: opts.mode || 'data', books: opts.books || [] });
        // 对端回传后通过 _onFileCb 回调，这里只保证请求已发出
        return Promise.resolve({ requested: true });
    }

    // ── 通知 ─────────────────────────────────────────────────────

    function _notifyState(state) {
        if (_onStateCb) _onStateCb(state);
    }

    function _notifyFile(buffer) {
        if (_onFileCb) {
            _onFileCb(buffer);
            return;
        }
        // 无回调时自动导入
        if (win.BK && win.BK.Sync && win.BK.Sync.importFromZip) {
            win.BK.Sync.importFromZip(buffer).then(function (result) {
                _notifyState({ status: 'imported', result: result });
            }).catch(function (err) {
                _notifyState({ status: 'import-error', error: err.message || String(err) });
            });
        }
    }

    // ── 连接清理 ─────────────────────────────────────────────────

    function _cleanup() {
        if (_channel) {
            try { _channel.onopen = _channel.onclose = _channel.onerror = _channel.onmessage = null; } catch (e) {}
            try { _channel.close(); } catch (e) {}
        }
        if (_conn) {
            try { _conn.close(); } catch (e) {}
        }
        _channel = null;
        _conn = null;
        _fileBuffer = null;
        _fileReceived = 0;
        _fileExpected = 0;
    }

    function close() {
        _cleanup();
        _onMessageCb = _onStateCb = _onFileCb = null;
        _isInitiator = false;
    }

    function getState() {
        return {
            supported: isSupported(),
            connected: !!(_channel && _channel.readyState === 'open'),
            channelState: _channel ? _channel.readyState : 'new',
            isInitiator: _isInitiator
        };
    }

    // ── 导出 ─────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.LanSyncWebRTC = {
        isSupported: isSupported,
        encodeSignal: encodeSignal,
        decodeSignal: decodeSignal,
        createOffer: createOffer,
        acceptOffer: acceptOffer,
        acceptAnswer: acceptAnswer,
        push: push,
        pull: pull,
        close: close,
        getState: getState
    };

})(window);