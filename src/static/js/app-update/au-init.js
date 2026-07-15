    // ── 静默后台检查更新 ────────────────────────────────────────────
    AppUpdate.silentCheckUpdate = async function() {
        if (window.__BK_LOCAL_DEV__) return;
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
