/**
 * APK 内部更新功能
 * 支持应用内下载和安装APK
 */
(function() {
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
        
        await Filesystem.writeFile({ path: filepath, data: base64Data, directory: directory, recursive: true });
        var getUriResult = await Filesystem.getUri({ path: filepath, directory: directory });
        return getUriResult.uri;
    }

    // ==================== AppUpdate 对象 ====================

    const AppUpdate = {
        config: {
            versionUrl: null,
            currentVersion: null,
            get mirrors() {
                return (window.BK_SERVERS && window.BK_SERVERS.github_mirrors) || [];
            }
        },
        isCapacitor: false,

        init: function() {
            this.isCapacitor = window.Capacitor && window.Capacitor.isNativePlatform();
            if (!this.isCapacitor) return;
            console.log('[更新] 初始化更新模块');
            this.cleanupOldApks();
            this._configReady = this.loadConfig();
            try {
                if (localStorage.getItem('bk_auto_check_update') === '1') {
                    setTimeout(function() { AppUpdate.silentCheckUpdate(); }, 2000);
                }
            } catch(e) {}
        },

        cleanupOldApks: async function() {
            var Filesystem = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
            if (!Filesystem) return;
            var dirs = [
                { dir: 'EXTERNAL', path: 'Download' },
                { dir: 'CACHE',    path: 'downloads' },
                { dir: 'DATA',     path: 'downloads' }
            ];
            for (var i = 0; i < dirs.length; i++) {
                try {
                    var result = await Filesystem.readdir({ path: dirs[i].path, directory: dirs[i].dir });
                    var files = result && result.files;
                    if (!files) continue;
                    for (var j = 0; j < files.length; j++) {
                        var entry = files[j];
                        var name = typeof entry === 'string' ? entry : (entry && entry.name);
                        if (name && name.endsWith('.apk')) {
                            try {
                                await Filesystem.deleteFile({ path: dirs[i].path + '/' + name, directory: dirs[i].dir });
                                console.log('[更新] 已清理旧 APK:', name);
                            } catch (e) { /* 删除失败忽略 */ }
                        }
                    }
                } catch (e) { /* 目录不存在忽略 */ }
            }
        },

        loadConfig: function() {
            var self = this;
            var cached = null;
            try { cached = localStorage.getItem('bk_apk_version'); } catch(e) {}
            if (cached) {
                self.config.currentVersion = cached;
                return Promise.resolve();
            }
            return fetch('./app_config.json', { cache: 'no-cache' })
                .then(function(response) {
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    return response.text();
                })
                .then(function(text) {
                    if (!text || !text.trim()) throw new Error('empty response');
                    var config = JSON.parse(text);
                    self.config.currentVersion = config.version;
                })
                .catch(function(error) { console.warn('[更新] 加载配置失败（已忽略）:', error.message || error); });
        },

        compareVersion: function(v1, v2) {
            if (v1 === '未知' || v2 === '未知') return null;
            var parts1 = v1.replace('v', '').split('.').map(function(n) { return parseInt(n) || 0; });
            var parts2 = v2.replace('v', '').split('.').map(function(n) { return parseInt(n) || 0; });
            for (var i = 0; i < Math.max(parts1.length, parts2.length); i++) {
                var p1 = parts1[i] || 0, p2 = parts2[i] || 0;
                if (p1 > p2) return 1;
                if (p1 < p2) return -1;
            }
            return 0;
        },

        downloadApk: async function(url, onProgress, onComplete, onError) {
            if (!window.Capacitor || !window.Capacitor.Plugins) {
                if (onError) onError(new Error('非 Capacitor 环境'));
                return;
            }
            
            var Filesystem = window.Capacitor.Plugins.Filesystem;
            if (!Filesystem) {
                if (onError) onError(new Error('Filesystem 插件未加载'));
                return;
            }
            
            var CapacitorHttp = getCapacitorHttp();
            var filename = url.split('/').pop();
            var saveAttempts = [
                { dir: 'EXTERNAL', path: 'Download/' + filename, name: 'Download 目录' },
                { dir: 'CACHE', path: 'downloads/' + filename, name: '缓存目录' },
                { dir: 'DATA', path: 'downloads/' + filename, name: '数据目录' }
            ];
            
            try {
                var blob, downloadUrl;
                var startDownloadTime = Date.now();
                
                var isGitHubUrl = url.indexOf('github.com') !== -1 || url.indexOf('githubusercontent.com') !== -1;
                if (isGitHubUrl && CapacitorHttp) {
                    if (onProgress) onProgress('正在选择最快线路...', 0, 0, 0);
                    
                    var downloadSources = [{ name: '线路 1', url: url }];
                    this.config.mirrors.forEach(function(mirror, index) {
                        var mirrorUrl = mirror.replace(/\/+$/, '') + '/' + url;
                        downloadSources.push({ name: '线路 ' + (index + 2), url: mirrorUrl });
                    });
                    
                    var testPromises = downloadSources.map(function(source) {
                        return new Promise(function(resolve) {
                            var startTime = Date.now();
                            var timeout = setTimeout(function() {
                                resolve({ source: source, responseTime: Infinity, success: false });
                            }, 5000);
                            
                            CapacitorHttp.get({
                                url: source.url,
                                headers: { 'Range': 'bytes=0-102399' },
                                connectTimeout: 5000,
                                readTimeout: 5000
                            }).then(function(response) {
                                clearTimeout(timeout);
                                var responseTime = Date.now() - startTime;
                                if (response.status === 200 || response.status === 206) {
                                    resolve({ source: source, responseTime: responseTime, success: true });
                                } else {
                                    resolve({ source: source, responseTime: Infinity, success: false });
                                }
                            }).catch(function() {
                                clearTimeout(timeout);
                                resolve({ source: source, responseTime: Infinity, success: false });
                            });
                        });
                    });
                    
                    var fastestSource = null, fastestTime = Infinity;
                    var racePromise = Promise.race(testPromises.map(function(p) {
                        return p.then(function(r) { return r.success ? r : new Promise(function(){}); });
                    }));
                    
                    var quickResult = await Promise.race([
                        racePromise,
                        new Promise(function(resolve) { setTimeout(function() { resolve(null); }, 2000); })
                    ]);
                    
                    if (quickResult && quickResult.success) {
                        fastestSource = quickResult.source;
                        fastestTime = quickResult.responseTime;
                    } else {
                        var testResults = await Promise.all(testPromises);
                        testResults.forEach(function(r) {
                            if (r.success && r.responseTime < fastestTime) {
                                fastestTime = r.responseTime;
                                fastestSource = r.source;
                            }
                        });
                    }
                    
                    if (!fastestSource) throw new Error('所有下载线路都不可用');
                    
                    downloadUrl = fastestSource.url;
                } else {
                    downloadUrl = url;
                }
                
                if (onProgress) onProgress('正在下载...', 10, 0, 0);
                blob = await downloadFile(downloadUrl, onProgress);
                
                if (onProgress) onProgress('下载完成，正在保存...', 80, 0, blob.size);
                
                var base64 = await blobToBase64(blob, function(progress) {
                    if (onProgress) onProgress('正在处理文件 (' + progress + '%)...', 80 + Math.round(progress * 0.1), 0, blob.size);
                });
                
                if (onProgress) onProgress('正在保存到本地...', 90, 0, blob.size);
                
                var fileUri = null, savedDir = null;
                for (var i = 0; i < saveAttempts.length; i++) {
                    try {
                        fileUri = await saveToFilesystem(saveAttempts[i].path, base64, saveAttempts[i].dir);
                        savedDir = saveAttempts[i].name;
                        break;
                    } catch (e) {
                        if (i === saveAttempts.length - 1) throw new Error('无法保存文件: ' + e.message);
                    }
                }
                
                if (!fileUri) throw new Error('文件保存失败');
                
                if (onProgress) onProgress('准备安装...', 95, 0, blob.size);
                
                var installed = false;
                var ApkInstaller = window.Capacitor.Plugins && window.Capacitor.Plugins.ApkInstaller;
                
                if (ApkInstaller) {
                    try {
                        if (onProgress) onProgress('打开安装程序...', 98, 0, blob.size);
                        await ApkInstaller.install({ filePath: fileUri });
                        installed = true;
                    } catch (e) {
                        console.error('[APK安装] ApkInstaller 失败:', e);
                    }
                }
                
                if (!installed) {
                    alert('无法自动打开安装器\n\n文件已下载到: ' + savedDir + '\n文件: ' + filename + '\n\n请手动到文件管理器安装');
                }
                
                if (onProgress) onProgress('完成', 100, 0, blob.size);
                if (onComplete) onComplete();
                
            } catch (error) {
                console.error('[APK下载] 失败:', error);
                if (onError) onError(error);
            }
        },

        downloadApkWithUI: function(downloadUrl) {
            showApkDownloadProgress('准备下载...', 0, 0, 0);
            this.downloadApk(downloadUrl,
                function(message, progress, speed, downloaded) {
                    updateApkDownloadProgress(message, progress, speed, downloaded);
                },
                function() {
                    closeApkDownloadProgress();
                },
                function(error) {
                    closeApkDownloadProgress();
                    alert('下载失败: ' + (error && error.message ? error.message : '未知错误'));
                }
            );
        }
    };

    // ==================== UI 工具函数 ====================
    
    function getTheme() {
        return window.THEME || {
            brand: '#667eea',
            brandDark: '#5b7ce6',
            bg: 'linear-gradient(135deg, #667eea 0%, #5b7ce6 100%)',
            success: '#48bb78',
            successDark: '#38a169'
        };
    }
    
    function getCurrentApkVersion() {
        return new Promise(function(resolve) {
            var cachedVersion = localStorage.getItem('bk_apk_version');
            
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
                window.Capacitor.Plugins.App.getInfo().then(function(info) {
                    if (info.version) {
                        localStorage.setItem('bk_apk_version', info.version);
                        resolve(info.version);
                    } else {
                        resolve(cachedVersion || '未知');
                    }
                }).catch(function(err) {
                    resolve(cachedVersion || '未知');
                });
            } else {
                resolve(cachedVersion || '未知');
            }
        });
    }
    
    function formatSpeed(speedKB) {
        if (speedKB >= 1024) return (speedKB / 1024).toFixed(1) + ' MB/s';
        return speedKB + ' KB/s';
    }
    
    function showApkDownloadProgress(message, progress, speed, downloaded) {
        var THEME = getTheme();
        var dialogId = 'apkDownloadProgressDialog';
        
        var html = '<div style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 10001; display: flex; align-items: center; justify-content: center; padding: 20px;" id="' + dialogId + '">';
        html += '<div style="background: white; border-radius: 12px; padding: 24px; max-width: 400px; width: 100%;">';
        html += '<h3 style="color: ' + THEME.brand + '; margin-bottom: 15px; font-size: 1.125em; text-align: center;">📱 正在下载 APK</h3>';
        html += '<p style="color: #666; margin-bottom: 10px; text-align: center; font-size: 0.875em;" id="apkProgressMessage">' + message + '</p>';
        
        html += '<p style="color: #999; margin-bottom: 15px; text-align: center; font-size: 0.75em;" id="apkProgressInfo">';
        if (speed > 0) html += '速度: ' + formatSpeed(speed);
        if (downloaded > 0) {
            if (speed > 0) html += ' | ';
            html += '已下载: ' + (downloaded / 1024 / 1024).toFixed(2) + ' MB';
        }
        html += '</p>';
        
        html += '<div style="background: #e2e8f0; border-radius: 10px; height: 20px; overflow: hidden; margin-bottom: 10px;">';
        html += '<div id="apkProgressBar" style="background: ' + THEME.bg + '; height: 100%; width: ' + progress + '%; transition: width 0.3s;"></div>';
        html += '</div>';
        
        html += '<p style="color: #999; text-align: center; font-size: 0.75em;" id="apkProgressPercent">' + progress + '%</p>';
        html += '</div></div>';
        
        document.body.insertAdjacentHTML('beforeend', html);
        window.BK.lockOverlayScroll(document.getElementById(dialogId));
    }
    
    function updateApkDownloadProgress(message, progress, speed, downloaded) {
        var msgEl = document.getElementById('apkProgressMessage');
        var barEl = document.getElementById('apkProgressBar');
        var pctEl = document.getElementById('apkProgressPercent');
        var infoEl = document.getElementById('apkProgressInfo');
        
        if (msgEl) msgEl.textContent = message;
        if (barEl) barEl.style.width = progress + '%';
        if (pctEl) pctEl.textContent = progress + '%';
        
        if (infoEl) {
            var info = '';
            if (speed > 0) info += '速度: ' + formatSpeed(speed);
            if (downloaded > 0) {
                if (info) info += ' | ';
                info += '已下载: ' + (downloaded / 1024 / 1024).toFixed(2) + ' MB';
            }
            infoEl.textContent = info || ' ';
        }
    }
    
    function closeApkDownloadProgress() {
        var dialog = document.getElementById('apkDownloadProgressDialog');
        if (dialog) dialog.remove();
    }

    // ——————————————————————————————————
    // Changelog 辅助函数
    // ——————————————————————————————————

    function fetchChangelog(serverUrl) {
        return fetch(serverUrl + 'changelog.json?t=' + Date.now(), { cache: 'no-cache' })
            .then(function(resp) { return resp.ok ? resp.json() : null; })
            .catch(function() { return null; });
    }

    function fetchChangelogRace(serverUrls) {
        if (!serverUrls || !serverUrls.length) return Promise.resolve(null);
        var chain = Promise.resolve(null);
        serverUrls.forEach(function(u) {
            chain = chain.then(function(v) { return v || fetchChangelog(u); });
        });
        return chain;
    }

    function getVersionsBetween(changelog, fromVer, toVer) {
        if (!changelog) return [];
        var from = fromVer.replace('v', '');
        var to = toVer.replace('v', '');
        return Object.keys(changelog).filter(function(v) {
            return AppUpdate.compareVersion(v, from) > 0 && AppUpdate.compareVersion(v, to) <= 0;
        }).sort(function(a, b) {
            var c = AppUpdate.compareVersion(b, a);
            return c > 0 ? -1 : (c < 0 ? 1 : 0);
        });
    }

    function renderSingleVersionHtml(version, entry) {
        var THEME = getTheme();
        var html = '<div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #eee;">';
        html += '<div style="font-weight:600;color:' + THEME.brand + ';margin-bottom:5px;">v' + version;
        if (entry.date) html += ' <span style="font-weight:400;color:#999;font-size:0.75em;">' + entry.date + '</span>';
        html += '</div>';
        if (entry['new'] && entry['new'].length) {
            html += '<div style="margin-bottom:3px;"><span style="color:#16a34a;font-size:0.75em;font-weight:600;">✨ 新增</span>';
            html += '<ul style="margin:2px 0 0 14px;padding:0;font-size:0.8125em;color:#333;">';
            entry['new'].forEach(function(item) { html += '<li>' + item + '</li>'; });
            html += '</ul></div>';
        }
        if (entry['opt'] && entry['opt'].length) {
            html += '<div style="margin-bottom:3px;"><span style="color:#2563eb;font-size:0.75em;font-weight:600;">⚡ 优化</span>';
            html += '<ul style="margin:2px 0 0 14px;padding:0;font-size:0.8125em;color:#333;">';
            entry['opt'].forEach(function(item) { html += '<li>' + item + '</li>'; });
            html += '</ul></div>';
        }
        if (entry['fix'] && entry['fix'].length) {
            html += '<div style="margin-bottom:3px;"><span style="color:#dc2626;font-size:0.75em;font-weight:600;">🔧 修复</span>';
            html += '<ul style="margin:2px 0 0 14px;padding:0;font-size:0.8125em;color:#333;">';
            entry['fix'].forEach(function(item) { html += '<li>' + item + '</li>'; });
            html += '</ul></div>';
        }
        html += '</div>';
        return html;
    }

    function fillChangelogPanel(dialogId, changelog, currentVer, latestVer, comparison) {
        var clInline    = document.getElementById(dialogId + '-cl-inline');
        var histContent = document.getElementById(dialogId + '-hist-content');
        var histBtn     = document.getElementById(dialogId + '-hist-btn');

        var currentClean = currentVer.replace('v', '');
        var latestClean  = latestVer.replace('v', '');

        if (comparison > 0 && clInline) {
            var displayVersions = getVersionsBetween(changelog, currentClean, latestClean);
            if (displayVersions.length > 0) {
                var html = '';
                if (displayVersions.length > 1) {
                    html += '<div style="margin-bottom:8px;font-size:0.75em;color:#666;">本次更新包含以下版本：</div>';
                }
                displayVersions.forEach(function(v) {
                    if (changelog[v]) html += renderSingleVersionHtml(v, changelog[v]);
                });
                clInline.innerHTML = html;
            } else {
                clInline.innerHTML = '<div style="color:#999;font-size:0.8125em;text-align:center;padding:4px 0;">暂无更新说明</div>';
            }
            clInline.style.display = 'block';
        }

        var historyVersions = Object.keys(changelog).filter(function(v) {
            return AppUpdate.compareVersion(v, currentClean) <= 0;
        }).sort(function(a, b) {
            return AppUpdate.compareVersion(b, a);
        });
        if (histContent && historyVersions.length > 0) {
            var _PAGE = 5;
            var _histShown = 0;
            function _renderHistPage() {
                var end = Math.min(_histShown + _PAGE, historyVersions.length);
                var frag = '';
                for (var i = _histShown; i < end; i++) {
                    if (changelog[historyVersions[i]]) frag += renderSingleVersionHtml(historyVersions[i], changelog[historyVersions[i]]);
                }
                _histShown = end;
                var oldMore = histContent.querySelector('.hist-more-btn');
                if (oldMore) histContent.removeChild(oldMore);
                var tmp = document.createElement('div');
                tmp.innerHTML = frag;
                while (tmp.firstChild) histContent.appendChild(tmp.firstChild);
                if (_histShown < historyVersions.length) {
                    var moreBtn = document.createElement('button');
                    moreBtn.className = 'hist-more-btn';
                    moreBtn.style.cssText = 'width:100%;padding:9px;background:#f8fafc;color:#475569;border:1px solid #e2e8f0;border-radius:6px;font-size:0.8125em;cursor:pointer;margin-top:4px;';
                    moreBtn.textContent = '更多（还有 ' + (historyVersions.length - _histShown) + ' 个版本）';
                    moreBtn.onclick = _renderHistPage;
                    histContent.appendChild(moreBtn);
                }
            }
            _renderHistPage();
            if (histBtn) histBtn.style.display = 'block';
        }
    }

    function createUpdateDialog(dialogId, title, statusId, btnId) {
        var THEME = getTheme();

        var html = '<div style="background:white;border-radius:12px;max-width:400px;width:100%;max-height:88vh;overflow:hidden;">';

        html += '<div id="' + dialogId + '-panel-main" style="display:block;">';
        html += '<div style="padding:20px 20px 16px;overflow-y:auto;max-height:88vh;">';
        html += '<h3 style="color:' + THEME.brand + ';margin-bottom:14px;font-size:1.125em;text-align:center;">' + title + '</h3>';
        html += '<div style="padding:14px;background:#f8f9ff;border-radius:8px;border:1px solid #e0e4ff;margin-bottom:12px;">';
        html += '<div id="' + statusId + '" style="color:#666;font-size:0.875em;line-height:1.7;">正在检查...</div>';
        html += '<button id="' + btnId + '" style="display:none;width:100%;padding:10px;margin-top:10px;background:' + THEME.bg + ';color:white;border:none;border-radius:6px;font-size:0.875em;font-weight:600;cursor:pointer;">立即更新应用</button>';
        html += '</div>';
        html += '<div id="' + dialogId + '-cl-inline" style="display:none;background:#f6fff8;border:1px solid #bbf7d0;border-radius:8px;padding:12px 14px;margin-bottom:12px;overflow-y:auto;max-height:260px;font-size:0.8125em;"></div>';
        html += '<button id="' + dialogId + '-hist-btn" style="display:none;width:100%;padding:9px 14px;margin-bottom:12px;background:#f8fafc;color:#475569;border:1px solid #e2e8f0;border-radius:6px;font-size:0.8125em;font-weight:600;cursor:pointer;text-align:left;">📖 历史版本 ›</button>';
        html += '<button id="' + dialogId + '-close" style="width:100%;padding:11px;background:#e2e8f0;color:#4a5568;border:none;border-radius:8px;font-size:0.875em;font-weight:600;cursor:pointer;">关闭</button>';
        html += '</div></div>';

        html += '<div id="' + dialogId + '-panel-hist" style="display:none;">';
        html += '<div style="padding:12px 16px;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;">';
        html += '<button id="' + dialogId + '-hist-back" style="background:none;border:none;color:' + THEME.brand + ';font-size:0.875em;font-weight:600;cursor:pointer;padding:4px 10px 4px 0;">← 返回</button>';
        html += '<span style="font-size:0.9375em;font-weight:600;color:#222;">📖 历史版本</span>';
        html += '</div>';
        html += '<div id="' + dialogId + '-hist-content" style="padding:14px 16px;overflow-y:auto;max-height:calc(88vh - 50px);font-size:0.8125em;"></div>';
        html += '</div>';

        html += '</div>';

        var dlg = window.BK.openDialog({ id: dialogId, html: html });
        if (!dlg) return function() {};

        var _panel = 'main';

        function _show(name) {
            ['main', 'hist'].forEach(function(p) {
                var el = document.getElementById(dialogId + '-panel-' + p);
                if (el) el.style.display = (p === name) ? 'block' : 'none';
            });
            _panel = name;
        }

        function _navTo(name) {
            window.BK.backStack.push(function() { _show('main'); });
            _show(name);
        }

        function _close() {
            if (_panel !== 'main') window.BK.backStack.discard();
            dlg.close();
        }

        var el;
        el = document.getElementById(dialogId + '-hist-btn');
        if (el) el.onclick = function() { _navTo('hist'); };
        el = document.getElementById(dialogId + '-hist-back');
        if (el) el.onclick = function() { history.back(); };
        el = document.getElementById(dialogId + '-close');
        if (el) el.onclick = _close;

        return _close;
    }
    
    function handleVersionComparison(statusEl, btnEl, comparison, currentVersion, latestVersion, sizeText, downloadUrl) {
        var currentClean = currentVersion.replace('v', '');
        var latestClean = latestVersion.replace('v', '');
        
        if (comparison > 0) {
            statusEl.innerHTML = '✅ 发现新版本<br>当前: v' + currentClean + '<br>最新: v' + latestClean + sizeText;
            btnEl.style.display = 'block';
            btnEl.textContent = '立即更新' + sizeText;
            btnEl.onclick = function() { AppUpdate.downloadApkWithUI(downloadUrl); };
        } else if (comparison === 0) {
            statusEl.innerHTML = '✅ 已是最新版本<br>版本: v' + currentClean;
            btnEl.style.display = 'block';
            btnEl.textContent = '重新下载' + sizeText;
            btnEl.onclick = function() { AppUpdate.downloadApkWithUI(downloadUrl); };
        } else if (comparison === null) {
            statusEl.innerHTML = '⚠️ 无法比较版本<br>当前: ' + currentVersion + '<br>最新: v' + latestClean;
            btnEl.style.display = 'block';
            btnEl.textContent = '下载最新版' + sizeText;
            btnEl.onclick = function() { AppUpdate.downloadApkWithUI(downloadUrl); };
        } else {
            statusEl.innerHTML = '当前: v' + currentClean + '<br>远程: v' + latestClean;
        }
    }
    
    // Cloudflare 更新检查
    AppUpdate.showCloudflareUpdateDialog = function() {
        var CLOUDFLARE_SERVERS = (window.BK_SERVERS && window.BK_SERVERS.cloudflare) || [];
        
        createUpdateDialog('cloudflareUpdateDialog', '🔄 检查更新', 'cfCheckStatus', 'cfUpdateBtn');
        
        var statusEl = document.getElementById('cfCheckStatus');
        var btnEl = document.getElementById('cfUpdateBtn');
        
        if (!statusEl || !btnEl) return;
        
        getCurrentApkVersion().then(function(currentVersion) {
            statusEl.innerHTML = '当前版本: ' + currentVersion + '<br>正在检查远程版本...';

            var ts = Date.now();
            var fetches = CLOUDFLARE_SERVERS.map(function(serverUrl) {
                return fetch(serverUrl + 'version.json?t=' + ts, { cache: 'no-cache' })
                    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                    .then(function(d) { return { serverUrl: serverUrl, versionInfo: d }; });
            });
            var race = typeof Promise.any === 'function'
                ? Promise.any(fetches)
                : new Promise(function(resolve) {
                    var done = false;
                    fetches.forEach(function(p) { p.then(function(d) { if (!done) { done = true; resolve(d); } }).catch(function() {}); });
                    setTimeout(function() { if (!done) resolve(null); }, 8000);
                });

            return race.then(function(result) {
                if (!result) { statusEl.innerHTML = '❌ 所有服务器均无法访问'; return; }
                var serverUrl = result.serverUrl;
                var versionInfo = result.versionInfo;

                var latestVersion = versionInfo.apk_version || versionInfo.version || '未知';
                var apkFile = versionInfo.apk_file || ('Books-v' + latestVersion + '.apk');
                var apkSize = versionInfo.apk_size;

                // APK 下载：优先从 Cloudflare Pages 下载（APK 已随站点部署）
                // apk_url 为相对路径（如 /Books-vX.Y.Z.apk），用响应成功的 serverUrl 拼接
                var downloadUrl;
                var apkUrlFromServer = versionInfo.apk_url;
                if (apkUrlFromServer && apkUrlFromServer.indexOf('/') === 0) {
                    // 相对路径，用 Cloudflare 服务器地址拼接
                    downloadUrl = serverUrl.replace(/\/$/, '') + apkUrlFromServer;
                } else if (apkUrlFromServer) {
                    // 绝对路径，直接使用
                    downloadUrl = apkUrlFromServer;
                } else {
                    // 兜底：GitHub Release + 镜像代理
                    downloadUrl = 'https://github.com/zhao-zg/books/releases/download/v' + latestVersion + '/' + apkFile;
                    var mirrors = (window.BK_SERVERS && window.BK_SERVERS.github_mirrors) || [];
                    if (mirrors.length > 0) {
                        downloadUrl = mirrors[0] + downloadUrl;
                    }
                }
                var comparison = AppUpdate.compareVersion(latestVersion.replace('v', ''), currentVersion.replace('v', ''));
                var sizeText = apkSize ? ' (' + (apkSize / 1024 / 1024).toFixed(1) + ' MB)' : '';

                handleVersionComparison(statusEl, btnEl, comparison, currentVersion, latestVersion, sizeText, downloadUrl);

                if (comparison > 0) {
                    var clInline = document.getElementById('cloudflareUpdateDialog-cl-inline');
                    if (clInline) {
                        clInline.style.display = 'block';
                        clInline.innerHTML = '<div style="color:#999;font-size:0.8125em;text-align:center;padding:4px 0;">📋 正在加载更新内容...</div>';
                    }
                }

                fetchChangelogRace(CLOUDFLARE_SERVERS).then(function(changelog) {
                    if (changelog) fillChangelogPanel('cloudflareUpdateDialog', changelog, currentVersion, latestVersion, comparison);
                });
            }).catch(function(error) {
                statusEl.innerHTML = '❌ 所有服务器均无法访问';
            });
        }).catch(function(error) {
            statusEl.innerHTML = '❌ 检查失败: ' + error.message;
        });
    };
    
    // GitHub 更新检查
    AppUpdate.showGitHubUpdateDialog = function() {
        var GITHUB_API_URL = (window.BK_SERVERS && window.BK_SERVERS.github_api) ||
            'https://api.github.com/repos/zhao-zg/books/releases/latest';
        
        createUpdateDialog('githubUpdateDialog', '🔄 检查更新 (GitHub)', 'ghCheckStatus', 'ghUpdateBtn');
        
        var statusEl = document.getElementById('ghCheckStatus');
        var btnEl = document.getElementById('ghUpdateBtn');
        
        if (!statusEl || !btnEl) return;
        
        getCurrentApkVersion().then(function(currentVersion) {
            statusEl.innerHTML = '当前版本: ' + currentVersion + '<br>正在检查远程版本...';
            
            return fetch(GITHUB_API_URL)
                .then(function(response) {
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    return response.json();
                })
                .then(function(release) {
                    var apk = release.assets.find(function(a) {
                        return a.name.endsWith('.apk');
                    });
                    
                    if (!apk) {
                        statusEl.innerHTML = '❌ 未找到 APK 文件';
                        return;
                    }
                    
                    var latestVersion = release.tag_name;
                    var comparison = AppUpdate.compareVersion(latestVersion.replace('v', ''), currentVersion.replace('v', ''));
                    var sizeText = ' (' + (apk.size / 1024 / 1024).toFixed(1) + ' MB)';

                    handleVersionComparison(statusEl, btnEl, comparison, currentVersion, latestVersion, sizeText, apk.browser_download_url);

                    if (comparison > 0) {
                        var clInline = document.getElementById('githubUpdateDialog-cl-inline');
                        if (clInline) {
                            clInline.style.display = 'block';
                            clInline.innerHTML = '<div style="color:#999;font-size:0.8125em;text-align:center;padding:4px 0;">📋 正在加载更新内容...</div>';
                        }
                    }

                    var CL_SERVERS = (window.BK_SERVERS && window.BK_SERVERS.cloudflare) || [];
                    fetchChangelogRace(CL_SERVERS).then(function(changelog) {
                        if (changelog) fillChangelogPanel('githubUpdateDialog', changelog, currentVersion, latestVersion, comparison);
                    }).catch(function() {});
                });
        }).catch(function(error) {
            statusEl.innerHTML = '❌ 检查失败: ' + error.message;
        });
    };
    
    // PWA 更新检查对话框
    AppUpdate.showPwaUpdateDialog = function(options) {
        var root = (options && options.root) || './';
        var extStatusEl = (options && options.statusEl) || null;

        var closeDialog = createUpdateDialog('pwaUpdateDialog', '🔄 检查更新', 'pwaCheckStatus', 'pwaUpdateBtn');

        var statusEl = document.getElementById('pwaCheckStatus');
        var btnEl    = document.getElementById('pwaUpdateBtn');
        if (!statusEl || !btnEl) return;

        var currentVersion = '';
        try { currentVersion = localStorage.getItem('bk_pwa_version') || ''; } catch(e) {}

        statusEl.innerHTML = (currentVersion ? '当前版本: v' + currentVersion + '<br>' : '') + '正在检查远程版本...';

        fetch(root + 'version.json?t=' + Date.now(), { cache: 'no-cache' })
            .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function(v) {
                var remoteVersion = v.version || v.apk_version || '';
                var comparison = currentVersion
                    ? AppUpdate.compareVersion(remoteVersion, currentVersion)
                    : 0;

                if (comparison <= 0) {
                    statusEl.innerHTML = '✅ 已是最新版本<br>版本: v' + remoteVersion;
                    if (extStatusEl) { extStatusEl.textContent = '✓ 已是最新版本 v' + remoteVersion; extStatusEl.className = 'cache-status success'; }
                    btnEl.style.display = 'block';
                    btnEl.textContent = '强制重新加载';
                    btnEl.onclick = function() {
                        closeDialog();
                        var steps = [];
                        if ('caches' in window) {
                            steps.push(caches.keys().then(function(keys) {
                                return Promise.all(keys.filter(function(k) { return k.indexOf('bk-') === 0; }).map(function(k) { return caches.delete(k); }));
                            }));
                        }
                        try { localStorage.removeItem('bk_pwa_version'); } catch(ex) {}
                        try { localStorage.removeItem('bk_all_cached'); } catch(ex) {}
                        Promise.all(steps).then(function() { window.location.replace(root + 'index.html'); });
                    };
                } else {
                    var currentClean = (currentVersion || '').replace('v', '');
                    var remoteClean  = remoteVersion.replace('v', '');
                    statusEl.innerHTML = '✅ 发现新版本<br>' +
                        (currentClean ? '当前: v' + currentClean + '<br>' : '') +
                        '最新: v' + remoteClean;
                    if (extStatusEl) { extStatusEl.textContent = '发现新版本 v' + remoteVersion; extStatusEl.className = 'cache-status'; }

                    var clInline = document.getElementById('pwaUpdateDialog-cl-inline');
                    if (clInline) {
                        clInline.style.display = 'block';
                        clInline.innerHTML = '<div style="color:#999;font-size:0.8125em;text-align:center;padding:4px 0;">📋 正在加载更新内容...</div>';
                    }

                    btnEl.style.display = 'block';
                    btnEl.textContent = '立即更新';
                    btnEl.onclick = function() {
                        closeDialog();
                        window.__bkUpdateInProgress = true;
                        if (window.__bkSwWaiting) {
                            try { window.__bkSwWaiting.postMessage({type:'SKIP_WAITING'}); } catch(ex){}
                            window.__bkSwWaiting = null;
                        }
                        if (extStatusEl) { extStatusEl.textContent = '正在准备更新...'; extStatusEl.className = 'cache-status'; }
                        var steps = [];
                        if ('caches' in window) {
                            steps.push(caches.keys().then(function(keys) {
                                return Promise.all(keys.filter(function(k) { return /^bk-\d{4}-\d{2}$/.test(k); }).map(function(k) { return caches.delete(k); }));
                            }).catch(function() {}));
                        }
                        try { localStorage.setItem('bk_pwa_version', remoteVersion); } catch(ex) {}
                        try { localStorage.removeItem('bk_all_cached'); } catch(ex) {}
                        if (window.BK && window.BK.errorLog) window.BK.errorLog.clear();
                        Promise.all(steps).then(function() { window.location.replace(root + 'index.html'); });
                    };
                }

                fetchChangelog(root).then(function(changelog) {
                    if (changelog) fillChangelogPanel('pwaUpdateDialog', changelog, currentVersion || '0', remoteVersion, comparison);
                });
            })
            .catch(function(e) {
                statusEl.innerHTML = '❌ 检查失败: ' + e.message;
                if (extStatusEl) { extStatusEl.textContent = '检查失败：' + e.message; extStatusEl.className = 'cache-status error'; }
            });
    };

    // ── 静默后台检查更新 ────────────────────────────────────────────
    AppUpdate.silentCheckUpdate = async function() {
        if (this._configReady) { await this._configReady; this._configReady = null; }
        try { if (sessionStorage.getItem('bk_update_toast_shown')) return; } catch(e) {}

        var isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
        var isStandalone = (window.navigator.standalone === true) ||
                           (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

        if (isCapacitor) {
            var CLOUDFLARE_SERVERS = (window.BK_SERVERS && window.BK_SERVERS.cloudflare) || [];
            if (!CLOUDFLARE_SERVERS.length) return;
            getCurrentApkVersion().then(function(currentVersion) {
                var ts = Date.now();
                var fetches = CLOUDFLARE_SERVERS.map(function(url) {
                    return fetch(url + 'version.json?t=' + ts, { cache: 'no-cache' })
                        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                        .then(function(d) { return { serverUrl: url, versionInfo: d }; });
                });
                var race = typeof Promise.any === 'function'
                    ? Promise.any(fetches)
                    : new Promise(function(resolve) {
                        var done = false;
                        fetches.forEach(function(p) { p.then(function(d) { if (!done) { done = true; resolve(d); } }).catch(function() {}); });
                        setTimeout(function() { if (!done) resolve(null); }, 8000);
                    });
                race.then(function(result) {
                    if (!result) return;
                    var latest = result.versionInfo.apk_version || result.versionInfo.version || '';
                    if (!latest) return;
                    var cmp = AppUpdate.compareVersion(latest.replace('v', ''), currentVersion.replace('v', ''));
                    if (cmp > 0) showUpdateToast(latest, 'capacitor');
                }).catch(function() {});
            }).catch(function() {});
        } else if (isStandalone) {
            var root = window.BK_ROOT || './';
            var currentPwa = '';
            try { currentPwa = localStorage.getItem('bk_pwa_version') || ''; } catch(e) {}
            fetch(root + 'version.json?t=' + Date.now(), { cache: 'no-cache' })
                .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function(v) {
                    var latest = v.version || v.apk_version || '';
                    if (!latest) return;
                    var cmp = currentPwa
                        ? AppUpdate.compareVersion(latest, currentPwa)
                        : 0;
                    if (cmp > 0) showUpdateToast(latest, 'pwa');
                }).catch(function() {});
        }
    };

    function showUpdateToast(version, type) {
        try { if (sessionStorage.getItem('bk_update_toast_shown')) return; } catch(e) {}
        try { sessionStorage.setItem('bk_update_toast_shown', '1'); } catch(e) {}

        if (document.getElementById('bkUpdateToast')) return;

        var toast = document.createElement('div');
        toast.id = 'bkUpdateToast';
        toast.className = 'bk-update-toast';
        toast.innerHTML =
            '<span class="bk-update-toast-text">🆕 发现新版本 v' + version + '</span>' +
            '<button class="bk-update-toast-action" id="bkUpdateToastAction">查看详情</button>' +
            '<button class="bk-update-toast-close" id="bkUpdateToastClose" aria-label="关闭">×</button>';
        document.body.appendChild(toast);

        function dismiss() {
            toast.style.transition = 'opacity .3s, transform .3s';
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-100%)';
            setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 350);
        }

        document.getElementById('bkUpdateToastClose').addEventListener('click', dismiss);
        document.getElementById('bkUpdateToastAction').addEventListener('click', function() {
            dismiss();
            if (type === 'capacitor') {
                if (window.AppUpdate && window.AppUpdate.showCloudflareUpdateDialog) {
                    window.AppUpdate.showCloudflareUpdateDialog();
                }
            } else {
                var root = window.BK_ROOT || './';
                if (window.AppUpdate && window.AppUpdate.showPwaUpdateDialog) {
                    window.AppUpdate.showPwaUpdateDialog({ root: root });
                }
            }
        });

        setTimeout(dismiss, 5000);
    }

    // 初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { AppUpdate.init(); });
    } else {
        AppUpdate.init();
    }

    (function() {
        var isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
        if (isCapacitor) return;
        var isStandalone = (window.navigator.standalone === true) ||
                           (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
        if (!isStandalone) return;
        try {
            if (localStorage.getItem('bk_auto_check_update') === '1') {
                setTimeout(function() { AppUpdate.silentCheckUpdate(); }, 2000);
            }
        } catch(e) {}
        if (window.__bkPwaUpdateReady) {
            window.__bkPwaUpdateReady = false;
            try { sessionStorage.removeItem('bk_update_toast_shown'); } catch(e) {}
            setTimeout(function() {
                AppUpdate.silentCheckUpdate();
            }, 300);
        }
    })();

    window.AppUpdate = AppUpdate;
})();
