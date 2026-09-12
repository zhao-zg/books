    // ==================== UI 工具函数 ====================
    
    function getTheme() {
        return window.THEME || {
            brand: '#3D8A5A',
            brandDark: '#5EAE7E',
            bg: 'linear-gradient(135deg, #3D8A5A 0%, #5EAE7E 100%)',
            success: '#3D8A5A',
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
        
        html += '<div style="background: #EDEAE4; border-radius: 10px; height: 20px; overflow: hidden; margin-bottom: 10px;">';
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

