/**
 * APK 内部更新功能
 * 支持应用内下载和安装APK
 */
    'use strict';

    // ==================== 公共工具函数 ====================
    
    function getCapacitorHttp() {
        if (!window.Capacitor) return null;
        if (window.Capacitor.CapacitorHttp) return window.Capacitor.CapacitorHttp;
        if (window.Capacitor.Plugins) {
            if (window.Capacitor.Plugins.CapacitorHttp) return window.Capacitor.Plugins.CapacitorHttp;
            if (window.Capacitor.Plugins.Http) return window.Capacitor.Plugins.Http;
        }
        return null;
    }
    
    async function downloadFile(url, onProgress, options) {
        options = options || {};
        var CapacitorHttp = getCapacitorHttp();
        var startTime = Date.now();
        var blob;

        var useStreamingFetch = typeof fetch === 'function';

        if (useStreamingFetch) {
            var controller, timeoutId;
            if (typeof AbortController !== 'undefined') {
                controller = new AbortController();
                timeoutId = setTimeout(function() { controller.abort(); }, options.totalTimeout || 300000);
            }
            var fetchOptions = { method: 'GET', cache: 'no-cache' };
            if (controller) fetchOptions.signal = controller.signal;

            var chunkReadTimeoutMs = options.readTimeout || 30000;

            try {
                var response = await fetch(url, fetchOptions);
                if (!response.ok) throw new Error('HTTP ' + response.status);

                var contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
                var reader = response.body ? response.body.getReader() : null;

                if (reader) {
                    var chunks = [];
                    var receivedLength = 0;
                    var lastReportTime = 0;
                    var lastReportedBytes = 0;
                    var currentSpeed = 0;

                    while (true) {
                        var readPromise = reader.read();
                        var result;
                        if (controller) {
                            var readTimerId;
                            var readTimeoutPromise = new Promise(function(_, reject) {
                                readTimerId = setTimeout(function() { reject(new Error('读取超时')); }, chunkReadTimeoutMs);
                            });
                            try {
                                result = await Promise.race([readPromise, readTimeoutPromise]);
                            } finally {
                                clearTimeout(readTimerId);
                            }
                        } else {
                            var fallbackTimerId;
                            var fallbackTimeout = new Promise(function(_, reject) {
                                fallbackTimerId = setTimeout(function() { reject(new Error('读取超时')); }, chunkReadTimeoutMs);
                            });
                            try {
                                result = await Promise.race([readPromise, fallbackTimeout]);
                            } finally {
                                clearTimeout(fallbackTimerId);
                            }
                        }
                        if (result.done) break;

                        chunks.push(result.value);
                        receivedLength += result.value.length;

                        var now = Date.now();
                        if (onProgress && (now - lastReportTime >= 500 || receivedLength === result.value.length)) {
                            var elapsed = (now - startTime) / 1000;
                            currentSpeed = elapsed > 0 ? Math.round(receivedLength / 1024 / elapsed) : 0;
                            var pct = contentLength > 0 ? Math.min(Math.round(receivedLength / contentLength * 70) + 10, 79) : 10;
                            var downloadedMB = (receivedLength / 1024 / 1024).toFixed(2);
                            var msg = contentLength > 0
                                ? '正在下载... ' + downloadedMB + ' / ' + (contentLength / 1024 / 1024).toFixed(2) + ' MB'
                                : '正在下载... ' + downloadedMB + ' MB';
                            onProgress(msg, pct, currentSpeed, receivedLength);
                            lastReportTime = now;
                            lastReportedBytes = receivedLength;
                        }
                    }

                    if (onProgress && receivedLength > lastReportedBytes) {
                        var finalElapsed = (Date.now() - startTime) / 1000;
                        currentSpeed = finalElapsed > 0 ? Math.round(receivedLength / 1024 / finalElapsed) : 0;
                        onProgress('正在下载... ' + (receivedLength / 1024 / 1024).toFixed(2) + ' MB', 79, currentSpeed, receivedLength);
                    }

                    blob = new Blob(chunks, { type: 'application/vnd.android.package-archive' });
                } else {
                    blob = await response.blob();
                }
            } catch (error) {
                if (error.message === '读取超时') {
                    try { reader.cancel(); } catch(e) {}
                    if (controller) controller.abort();
                    throw new Error('下载超时（读取无响应），请检查网络连接后重试');
                }
                if (error.name === 'AbortError') {
                    throw new Error('下载超时，请检查网络连接后重试');
                }
                throw error;
            } finally {
                clearTimeout(timeoutId);
            }
        } else if (CapacitorHttp) {
            var httpResponse = await CapacitorHttp.get({
                url: url,
                responseType: 'blob',
                connectTimeout: options.connectTimeout || 60000,
                readTimeout: options.readTimeout || 300000,
                headers: options.headers || {}
            });

            if (httpResponse.status !== 200 && httpResponse.status !== 206) {
                throw new Error('HTTP ' + httpResponse.status);
            }

            if (httpResponse.data instanceof Blob) {
                blob = httpResponse.data;
            } else if (typeof httpResponse.data === 'string') {
                var binaryString = atob(httpResponse.data);
                var bytes = new Uint8Array(binaryString.length);
                for (var i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                blob = new Blob([bytes], { type: 'application/vnd.android.package-archive' });
            } else {
                throw new Error('未知的响应数据类型');
            }
        } else {
            throw new Error('无可用下载方式');
        }

        var elapsed = (Date.now() - startTime) / 1000;
        var avgSpeed = elapsed > 0 ? Math.round(blob.size / 1024 / elapsed) : 0;
        if (onProgress) {
            onProgress('下载完成: ' + (blob.size / 1024 / 1024).toFixed(2) + ' MB (平均 ' + formatSpeed(avgSpeed) + ')', 80, avgSpeed, blob.size);
        }

        return blob;
    }
    
    async function blobToBase64(blob, onProgress) {
        var arrayBuffer = await blob.arrayBuffer();
        var bytes = new Uint8Array(arrayBuffer);
        var binary = '';
        var chunkSize = 8192;
        
        for (var i = 0; i < bytes.length; i += chunkSize) {
            var end = Math.min(i + chunkSize, bytes.length);
            // 直接用字节值转二进制字符串，避免 TextDecoder('latin1') 兼容性问题
            for (var j = i; j < end; j++) {
                binary += String.fromCharCode(bytes[j]);
            }
            if (onProgress && i % (chunkSize * 10) === 0) {
                onProgress(Math.round((i / bytes.length) * 100));
            }
        }
        return btoa(binary);
    }
    
    async function saveToFilesystem(filepath, base64Data, directory) {
        var Filesystem = window.Capacitor.Plugins.Filesystem;
        if (!Filesystem) throw new Error('Filesystem 插件未加载');
        
        var dirPath = filepath.substring(0, filepath.lastIndexOf('/'));
        if (dirPath) {
            try {
                await Filesystem.mkdir({ path: dirPath, directory: directory, recursive: true });
            } catch (e) { }
        }
        
        await Filesystem.writeFile({ path: filepath, data: base64Data, directory: directory, recursive: true, encoding: 'base64' });
        var getUriResult = await Filesystem.getUri({ path: filepath, directory: directory });
        return getUriResult.uri;
    }
