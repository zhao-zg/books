    // ==================== AppUpdate 对象 ====================

    var AppUpdate = {
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
            // ★ 未开启自动检查更新时，跳过 loadConfig 网络请求
            var _shouldNetwork = window.BK && window.BK.shouldAllowNetworkRequest && window.BK.shouldAllowNetworkRequest();
            if (_shouldNetwork) {
                this._configReady = this.loadConfig();
                var self = this;
                setTimeout(function() { AppUpdate.silentCheckUpdate(); }, 2000);
            } else {
                // 尝试从缓存读取版本号，不发网络请求
                var cached = null;
                try { cached = localStorage.getItem('bk_apk_version'); } catch(e) {}
                if (cached) this.config.currentVersion = cached;
                this._configReady = Promise.resolve();
            }
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

        // P3-2: 下载竞速——speedtest.bin 带宽测速，独立于 version 竞速
        _selectFastestMirror: async function(url, onProgress) {
            var mirrors = this.config.mirrors || [];
            
            // ★ 收集候选 CF 服务器 URL 列表
            // 从原始 URL 提取 APK 文件名，从 CF 服务器列表竞速选最优
            var cfServers = (window.BK_SERVERS && window.BK_SERVERS.cloudflare) || [];
            if (cfServers.length === 0) {
                console.log('[更新] 无 CF 服务器列表，使用原 URL');
                return url;
            }
            
            // 单 CF 服务器无需竞速，直接拼接
            var filename = url.split('/').pop();
            if (cfServers.length === 1) {
                var directUrl = cfServers[0].replace(/\/+$/, '') + '/' + filename;
                console.log('[更新] 单 CF 服务器，直接使用: ' + directUrl);
                return directUrl;
            }
            
            if (onProgress) onProgress('正在测速选最优线路...', 0, 0, 0);
            
            // ★ 使用全局下载竞速：speedtest.bin 测速，选带宽最高的 CF 服务器
            var Race = window.BK && window.BK.RaceFastest;
            if (Race) {
                try {
                    var result = await Race.download(cfServers);
                    var bestUrl = result.serverUrl.replace(/\/+$/, '') + '/' + filename;
                    console.log('[更新] 下载竞速完成，最优: ' + bestUrl);
                    return bestUrl;
                } catch (e) {
                    console.warn('[更新] 下载竞速失败，使用原 URL:', e.message);
                    return url;
                }
            }
            
            // 兜底：无 RaceFastest 时直接用原 URL
            console.log('[更新] RaceFastest 不可用，使用原 URL');
            return url;
        },

        _downloadAndSave: async function(downloadUrl, filename, onProgress) {
            var Filesystem = window.Capacitor.Plugins.Filesystem;
            if (onProgress) onProgress('正在下载...', 10, 0, 0);
            var blob = await downloadFile(downloadUrl, onProgress);
            
            if (onProgress) onProgress('下载完成，正在保存...', 80, 0, blob.size);
            var base64 = await blobToBase64(blob, function(progress) {
                if (onProgress) onProgress('正在处理文件 (' + progress + '%)...', 80 + Math.round(progress * 0.1), 0, blob.size);
            });
            
            if (onProgress) onProgress('正在保存到本地...', 90, 0, blob.size);
            var saveAttempts = [
                { dir: 'EXTERNAL', path: 'Download/' + filename, name: 'Download 目录' },
                { dir: 'CACHE', path: 'downloads/' + filename, name: '缓存目录' },
                { dir: 'DATA', path: 'downloads/' + filename, name: '数据目录' }
            ];
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
            return { fileUri: fileUri, savedDir: savedDir, blob: blob };
        },

        _installApk: async function(fileUri, savedDir, filename, blob, onProgress) {
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
            var filename = url.split('/').pop();
            try {
                var downloadUrl = await this._selectFastestMirror(url, onProgress);
                var result = await this._downloadAndSave(downloadUrl, filename, onProgress);
                await this._installApk(result.fileUri, result.savedDir, filename, result.blob, onProgress);
                if (onProgress) onProgress('完成', 100, 0, result.blob.size);
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
