# App Update Template

Complete JavaScript module for in-app APK self-update in Capacitor apps.

## app-update.js

```javascript
/**
 * APK In-App Update Module
 * Features: version check, chunked download, mirror fallback, install trigger
 */
(function() {
    'use strict';

    // ==================== Helper Functions ====================

    function getCapacitorHttp() {
        if (!window.Capacitor) return null;
        if (window.Capacitor.CapacitorHttp) return window.Capacitor.CapacitorHttp;
        if (window.Capacitor.Plugins) {
            return window.Capacitor.Plugins.CapacitorHttp ||
                   window.Capacitor.Plugins.Http || null;
        }
        return null;
    }

    async function downloadWithCapacitorHttp(url, options) {
        var CapacitorHttp = getCapacitorHttp();
        if (!CapacitorHttp) throw new Error('CapacitorHttp not available');

        var httpResponse = await CapacitorHttp.get({
            url: url,
            responseType: 'blob',
            connectTimeout: options.connectTimeout || 60000,
            readTimeout: options.readTimeout || 120000,
            headers: options.headers || {}
        });

        if (httpResponse.status !== 200 && httpResponse.status !== 206) {
            throw new Error('HTTP ' + httpResponse.status);
        }

        if (httpResponse.data instanceof Blob) return httpResponse.data;
        if (typeof httpResponse.data === 'string') {
            var binaryString = atob(httpResponse.data);
            var bytes = new Uint8Array(binaryString.length);
            for (var i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return new Blob([bytes], { type: options.mimeType || 'application/octet-stream' });
        }
        throw new Error('Unknown response data type');
    }

    async function downloadFileInChunks(downloadUrl, onProgress) {
        var CapacitorHttp = getCapacitorHttp();
        if (!CapacitorHttp) throw new Error('CapacitorHttp not available');

        // Get file size via Range request
        var contentLength = 0;
        try {
            var sizeResponse = await CapacitorHttp.get({
                url: downloadUrl,
                headers: { 'Range': 'bytes=0-0' },
                connectTimeout: 10000,
                readTimeout: 10000
            });
            var contentRange = sizeResponse.headers['content-range'] ||
                               sizeResponse.headers['Content-Range'];
            if (contentRange) {
                var match = contentRange.match(/\/(\d+)/);
                if (match) contentLength = parseInt(match[1]);
            }
        } catch (e) {
            console.warn('Cannot get file size:', e.message);
        }

        var chunkSize = 1024 * 1024; // 1MB chunks

        if (contentLength > 0 && contentLength > chunkSize) {
            // Chunked download for large files
            var chunks = [];
            var numChunks = Math.ceil(contentLength / chunkSize);
            var downloadedBytes = 0;

            for (var i = 0; i < numChunks; i++) {
                var start = i * chunkSize;
                var end = Math.min(start + chunkSize - 1, contentLength - 1);

                var chunkResponse = await CapacitorHttp.get({
                    url: downloadUrl,
                    headers: { 'Range': 'bytes=' + start + '-' + end },
                    responseType: 'blob',
                    connectTimeout: 30000,
                    readTimeout: 60000
                });

                if (chunkResponse.status !== 200 && chunkResponse.status !== 206) {
                    throw new Error('Chunk download failed: HTTP ' + chunkResponse.status);
                }

                var chunkBlob;
                if (chunkResponse.data instanceof Blob) {
                    chunkBlob = chunkResponse.data;
                } else if (typeof chunkResponse.data === 'string') {
                    var binaryString = atob(chunkResponse.data);
                    var bytes = new Uint8Array(binaryString.length);
                    for (var j = 0; j < binaryString.length; j++) {
                        bytes[j] = binaryString.charCodeAt(j);
                    }
                    chunkBlob = new Blob([bytes]);
                } else {
                    throw new Error('Unknown response data type');
                }

                chunks.push(chunkBlob);
                downloadedBytes += chunkBlob.size;

                if (onProgress) {
                    var progress = 10 + Math.round((downloadedBytes / contentLength) * 70);
                    var downloadedMB = (downloadedBytes / 1024 / 1024).toFixed(2);
                    var totalMB = (contentLength / 1024 / 1024).toFixed(2);
                    onProgress(downloadedMB + ' / ' + totalMB + ' MB', progress);
                }
            }

            return {
                blob: new Blob(chunks, { type: 'application/vnd.android.package-archive' }),
                size: downloadedBytes
            };
        } else {
            // Small file: direct download
            if (onProgress) onProgress('Downloading...', 30);
            var blob = await downloadWithCapacitorHttp(downloadUrl, {
                connectTimeout: 60000,
                readTimeout: 300000,
                mimeType: 'application/vnd.android.package-archive'
            });
            return { blob: blob, size: blob.size };
        }
    }

    async function blobToBase64(blob) {
        var arrayBuffer = await blob.arrayBuffer();
        var bytes = new Uint8Array(arrayBuffer);
        var binary = '';
        var chunkSize = 8192;
        for (var i = 0; i < bytes.length; i += chunkSize) {
            var chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
            binary += String.fromCharCode.apply(null, chunk);
        }
        return btoa(binary);
    }

    async function saveToFilesystem(filepath, base64Data, directory) {
        var Filesystem = window.Capacitor.Plugins.Filesystem;
        if (!Filesystem) throw new Error('Filesystem plugin not loaded');

        var dirPath = filepath.substring(0, filepath.lastIndexOf('/'));
        if (dirPath) {
            try { await Filesystem.mkdir({ path: dirPath, directory: directory, recursive: true }); }
            catch (e) { /* directory may already exist */ }
        }

        await Filesystem.writeFile({ path: filepath, data: base64Data, directory: directory, recursive: true });
        var getUriResult = await Filesystem.getUri({ path: filepath, directory: directory });
        return getUriResult.uri;
    }

    // ==================== AppUpdate Object ====================

    const AppUpdate = {
        config: {
            // CUSTOMIZE: Set your version check URL
            versionUrl: 'https://your-app.pages.dev/version.json',
            currentVersion: null,
            // CUSTOMIZE: GitHub proxy mirrors for APK download
            mirrors: [
                'https://gh-proxy.com/',
                'https://ghproxy.net/',
                'https://proxy.example.com/'
            ]
        },
        isCapacitor: false,

        init: function() {
            this.isCapacitor = window.Capacitor && window.Capacitor.isNativePlatform();
            if (!this.isCapacitor) return;

            // Get current version from meta tag or app_config
            var metaVersion = document.querySelector('meta[name="app-version"]');
            if (metaVersion) {
                this.config.currentVersion = metaVersion.getAttribute('content');
            }
        },

        compareVersions: function(v1, v2) {
            var parts1 = v1.split('.').map(Number);
            var parts2 = v2.split('.').map(Number);
            for (var i = 0; i < Math.max(parts1.length, parts2.length); i++) {
                var a = parts1[i] || 0;
                var b = parts2[i] || 0;
                if (a > b) return 1;
                if (a < b) return -1;
            }
            return 0;
        },

        checkForUpdates: async function() {
            if (!this.isCapacitor) return;

            try {
                var response = await fetch(this.config.versionUrl + '?t=' + Date.now());
                if (!response.ok) return;

                var data = await response.json();
                var remoteVersion = data.apk_version || data.version;

                if (remoteVersion && this.config.currentVersion &&
                    this.compareVersions(remoteVersion, this.config.currentVersion) > 0) {
                    this.promptUpdate(data);
                }
            } catch (e) {
                console.warn('Update check failed:', e.message);
            }
        },

        promptUpdate: function(data) {
            // CUSTOMIZE: Show your update UI
            if (confirm('New version ' + data.apk_version + ' available. Update now?')) {
                this.downloadAndInstall(data);
            }
        },

        downloadAndInstall: async function(data) {
            try {
                // Build download URL from GitHub Release
                // CUSTOMIZE: Set your GitHub repo
                var repo = 'owner/repo';
                var apkFile = data.apk_file;
                var baseUrl = 'https://github.com/' + repo + '/releases/download/v' + data.apk_version + '/' + apkFile;

                // Try mirrors first, then direct
                var downloadUrl = null;
                for (var i = 0; i < this.config.mirrors.length; i++) {
                    var mirrorUrl = this.config.mirrors[i] + baseUrl;
                    try {
                        var testResponse = await fetch(mirrorUrl, { method: 'HEAD' });
                        if (testResponse.ok) {
                            downloadUrl = mirrorUrl;
                            break;
                        }
                    } catch (e) { continue; }
                }
                if (!downloadUrl) downloadUrl = baseUrl;

                // Download APK
                var result = await downloadFileInChunks(downloadUrl, function(msg, progress) {
                    console.log('[Update] ' + msg + ' (' + progress + '%)');
                });

                // Save to filesystem
                var base64Data = await blobToBase64(result.blob);
                var savedUri = await saveToFilesystem(
                    'downloads/' + apkFile,
                    base64Data,
                    'CACHE'
                );

                // Install APK
                await window.Capacitor.Plugins.ApkInstaller.install({
                    filePath: savedUri
                });

            } catch (e) {
                console.error('Update failed:', e.message);
                alert('Update failed: ' + e.message);
            }
        }
    };

    // Auto-init
    AppUpdate.init();
    window.AppUpdate = AppUpdate;

})();
```

## Customization Points

| Variable | Description |
|----------|-------------|
| `config.versionUrl` | URL to your `version.json` endpoint |
| `config.mirrors` | Array of GitHub proxy mirrors for APK download |
| `repo` in `downloadAndInstall` | Your `owner/repo` string |
| `promptUpdate` | Replace with your custom UI |
| `config.currentVersion` | Read from meta tag, app config, or hardcode |

## version.json Format

```json
{
  "apk_version": "1.0.1",
  "version": "1.0.1",
  "apk_file": "MyApp-v1.0.1.apk",
  "apk_size": 52428800
}
```
