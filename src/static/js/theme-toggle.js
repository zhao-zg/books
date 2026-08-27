// 初始化主题切换和字体控制功能
(function() {
    'use strict';
    
    const fontSizes = [14, 15, 16, 18, 20, 22, 24, 26]; // px 固定值
    const defaultSizeIndex = 3; // 18px
    let currentSizeIndex = defaultSizeIndex;
    // 阅读字体预设：key → { label, stack }
    const fontPresets = {
        serif:  { label: '宋体', stack: "'Songti SC', 'STSong', SimSun, 'Noto Serif CJK SC', 'Source Han Serif SC', Georgia, 'Times New Roman', serif" },
        sans:   { label: '黑体', stack: "'PingFang SC', 'Noto Sans CJK SC', 'Source Han Sans SC', 'Microsoft YaHei', sans-serif" },
        kai:    { label: '楷体', stack: "'STKaiti', 'KaiTi', '楷体', 'KaiTi_GB2312', 'Noto Serif CJK SC', 'Source Han Serif SC', serif" },
        system: { label: '系统', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif" }
    };
    const defaultFontKey = 'serif';
    let currentFontKey = defaultFontKey;
    const themeMetaColors = {
        cool: '#F5F4F1',
        warm: '#F7F2E8',
        dark: '#1A1917'
    };


    function getStoredTheme() {
        try {
            const theme = localStorage.getItem('readingTheme');
            return theme === 'cool' || theme === 'warm' || theme === 'dark' ? theme : null;
        } catch (e) { return null; }
    }

    function getPreferredTheme() {
        const savedTheme = getStoredTheme();
        return savedTheme || 'cool';
    }

    function syncThemeColor(theme) {
        var color = themeMetaColors[theme] || themeMetaColors.cool;
        const metaThemeColor = document.querySelector('meta[name="theme-color"]');
        if (metaThemeColor) metaThemeColor.setAttribute('content', color);
        try {
            var sb = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar;
            if (sb) {
                sb.setBackgroundColor({ color: color });
                sb.setStyle({ style: theme === 'dark' ? 'DARK' : 'LIGHT' });
            }
        } catch (e) {}
    }


    function initDevConsole()  { window.BKDevConsole && window.BKDevConsole.init(); }

    // 是否为本地开发环境（localhost / 127.0.0.1 / file://）


    function initThemeToggle() {
        // 内页启动缓存检测
        (function() {
            var root = window.BK_ROOT || './';
            if (root === './') return;
            var isStandalone = window.navigator.standalone === true ||
                               window.matchMedia('(display-mode: standalone)').matches;
            var isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform &&
                                 window.Capacitor.isNativePlatform());
            if (!isStandalone || isCapacitor || !('caches' in window)) return;
            var storedVersion = null;
            try { storedVersion = localStorage.getItem('bk_pwa_version'); } catch(e) {}
            if (!storedVersion) {
                window.location.replace(root + 'index.html');
                return;
            }
            caches.keys().then(function(keys) {
                var hasCoreCache = keys.some(function(k) {
                    return k.indexOf('bk-data-') === 0 || k === 'bk-main' || k.indexOf('bk-main-') === 0;
                });
                if (!hasCoreCache) {
                    window.location.replace(root + 'index.html');
                }
            }).catch(function() {});
        })();

        const initialTheme = getPreferredTheme();
        document.documentElement.setAttribute('data-theme', initialTheme);
        updateThemeUI(initialTheme);
        syncThemeColor(initialTheme);
        
        const savedSize = localStorage.getItem('globalFontSize');
        if (savedSize) {
            var savedVal = parseFloat(savedSize);
            var savedIndex;
            // 向下兼容：新 px 值（10~30 范围）
            if (savedVal >= 10 && savedVal <= 30) {
                savedIndex = fontSizes.indexOf(parseInt(savedSize));
            }
            // 旧 em 值（< 5）
            else if (savedVal < 5) {
                var emToPxIndex = { 0.875: 0, 1: 1, 1.125: 2, 1.25: 3, 1.375: 4, 1.5: 5, 1.625: 6, 1.75: 7 };
                savedIndex = emToPxIndex[savedVal] !== undefined ? emToPxIndex[savedVal] : -1;
            }
            // 旧 px 值（> 5，早期版本 14/16/18/20/22/24/26/28）
            else {
                var oldPxToIndex = { 14: 0, 16: 1, 18: 3, 20: 4, 22: 5, 24: 6, 26: 7, 28: 7 };
                savedIndex = oldPxToIndex[parseInt(savedSize)] !== undefined ? oldPxToIndex[parseInt(savedSize)] : -1;
            }
            if (savedIndex !== -1) {
                currentSizeIndex = savedIndex;
            }
        }
        // 始终应用字号（确保默认值也生效）
        applyFontSize(fontSizes[currentSizeIndex]);
        updateFontSizeUI();

        // 恢复阅读字体选择
        var savedFont = null;
        try { savedFont = localStorage.getItem('readingFontFamily'); } catch (e) {}
        if (savedFont && fontPresets[savedFont]) currentFontKey = savedFont;
        applyReadingFont(currentFontKey);

        // 应用级操作已移至「我的」页面，设置面板仅保留阅读模式 + 字体大小
        // 但保留全局函数注册（downloadApk / showGuideDialog / showFeedbackDialog）
        initGlobalActions();

        // 记录首次使用时间
        try {
            if (!localStorage.getItem('bk_first_use')) {
                localStorage.setItem('bk_first_use', Date.now().toString());
            }
        } catch(e) {}

        try { if (localStorage.getItem('bk_dev_mode') === '1') initDevConsole(); } catch(e) {}

        if (window.matchMedia) {
            var themeQuery = window.matchMedia('(prefers-color-scheme: dark)');
            var handleThemeQueryChange = function(event) {
                if (getStoredTheme()) return;
                var nextTheme = event.matches ? 'dark' : 'cool';
                document.documentElement.setAttribute('data-theme', nextTheme);
                updateThemeUI(nextTheme);
                syncThemeColor(nextTheme);
            };
            if (typeof themeQuery.addEventListener === 'function') {
                themeQuery.addEventListener('change', handleThemeQueryChange);
            } else if (typeof themeQuery.addListener === 'function') {
                themeQuery.addListener(handleThemeQueryChange);
            }
        }

        // ── 延迟探测赞助图片（不阻塞启动，不影响按钮可见性）────────
        setTimeout(function probeSponsor() {
            var sponsorEnabled = !(window.BK_SERVERS && window.BK_SERVERS.sponsor_enabled === false);
            if (!sponsorEnabled) return;
            // ★ 未开启自动检查更新时，跳过网络请求
            if (!(window.BK && window.BK.shouldAllowNetworkRequest && window.BK.shouldAllowNetworkRequest())) return;
            try {
                var firstUse = parseInt(localStorage.getItem('bk_first_use') || '0', 10);
                var elapsed = firstUse ? (Date.now() - firstUse) : 0;
                if (elapsed < 5 * 60 * 1000 || window._bkSponsorProbed) return;
                window._bkSponsorProbed = true;
                var servers = (window.BK_SERVERS && window.BK_SERVERS.cloudflare) || [];
                var probeFile = 'images/zanzhu-wx.png';
                var tried = 0;
                var PROBE_TIMEOUT = 6000;
                (function tryNext() {
                    if (tried >= servers.length) return;
                    var url = servers[tried++] + probeFile + '?t=' + Date.now();
                    var img = new Image();
                    var timer = setTimeout(function() {
                        img.onload = img.onerror = null;
                        img.src = '';
                        tryNext();
                    }, PROBE_TIMEOUT);
                    img.onload = function() {
                        clearTimeout(timer);
                        window._bkSponsorReady = true;
                        var sponsorBtn = document.getElementById('bkSponsorBtn');
                        if (sponsorBtn) sponsorBtn.style.display = '';
                    };
                    img.onerror = function() {
                        clearTimeout(timer);
                        tryNext();
                    };
                    img.src = url;
                })();
            } catch(e) {}
        }, 3000);
    }

    /**
     * 初始化全局函数注册（供「我的」页面等外部调用）
     * 设置面板已精简为仅阅读模式 + 字体大小，不再挂载应用级按钮
     */
    function initGlobalActions() {
        window.BK = window.BK || {};

        // 安卓 APK 下载函数（被「我的」页面通过 window.BKDownloadApk 调用）
        // ★ 优先使用全局 version 竞速，缓存复用；兜底走本地 version.json
        function downloadApk(statusEl) {
            if (statusEl) { statusEl.textContent = '正在获取最新版本...'; statusEl.className = 'cache-status'; }
            var Race = window.BK && window.BK.RaceFastest;
            var verPromise = Race
                ? Race.version().then(function(r) { return r.data; })
                : fetch((window.BK_ROOT || './') + 'version.json?t=' + Date.now(), { cache: 'no-cache' })
                    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });

            verPromise.then(function(v) {
                    var f = v.apk_file || ('Books-v' + (v.apk_version || v.version) + '.apk');
                    var sz = v.apk_size ? ' (' + (v.apk_size / 1024 / 1024).toFixed(1) + ' MB)' : '';
                    var apkUrl;
                    if (v.apk_url && v.apk_url.indexOf('/') === 0) {
                        apkUrl = window.location.origin + v.apk_url;
                    } else if (v.apk_url) {
                        apkUrl = v.apk_url;
                    } else {
                        apkUrl = 'https://github.com/zhao-zg/books/releases/download/v' + (v.apk_version || v.version) + '/' + f;
                    }
                    if (statusEl) { statusEl.textContent = '正在下载 v' + (v.apk_version || v.version) + sz + '...'; statusEl.className = 'cache-status success'; }
                    window.open(apkUrl, '_blank');
                })
                .catch(function(e) {
                    if (statusEl) { statusEl.textContent = '获取失败: ' + e.message; statusEl.className = 'cache-status error'; }
                    // ★ 请求失败：清理竞速缓存，下次请求重新竞速
                    if (window.BK && window.BK.RaceFastest) {
                        window.BK.RaceFastest.invalidateVersion();
                    }
                });
        }
        window.BKDownloadApk = downloadApk;

        // 安装到桌面（被「我的」页面调用）
        window.BK.installPWA = window.BK.installPWA || function() {
            var p = window._pwaInstallPrompt;
            if (!p) return;
            window._pwaInstallPrompt = null;
            p.prompt();
            p.userChoice.then(function() {
                var installBtn = document.getElementById('meInstallBtn');
                if (installBtn) installBtn.style.display = 'none';
            });
        };

        // PWA 安装提示拦截（全局只注册一次）
        if (!window._pwaPromptCaptured) {
            window._pwaPromptCaptured = true;
            window.addEventListener('beforeinstallprompt', function(e) {
                e.preventDefault();
                window._pwaInstallPrompt = e;
            });
        }
    }

    // 清除数据对话框
    function showClearDialog(onConfirm) {
        var selected = 'regular';
        var dlg = window.BK.openDialog({
            id: 'bkClearDialogMask',
            html: [
                '<div class="bk-dialog">',
                '  <div class="bk-drawer-header">',
                '    <div class="bk-drawer-title">清理数据</div>',
                '    <button class="bk-drawer-close" data-action="cancel" aria-label="关闭">×</button>',
                '  </div>',
                '  <div class="bk-drawer-divider"></div>',
                '  <div class="bk-drawer-body">',
                '    <div class="bk-note"><span class="bk-note-icon">⚠️</span><div class="bk-note-text">清理操作不可恢复，将移除所选内容。请确认后再继续。</div></div>',
                '    <div class="bk-dialog-opts">',
                '      <div class="bk-dialog-opt selected" data-val="regular">',
                '        <div class="bk-dialog-opt-icon">🧾</div>',
                '        <div class="bk-dialog-opt-body">',
                '          <div class="bk-dialog-opt-title">常规数据</div>',
                '          <div class="bk-dialog-opt-sub">离线缓存、阅读进度、字体语速设置<br>保留划线笔记</div>',
                '        </div>',
                '      </div>',
                '      <div class="bk-dialog-opt" data-val="notes">',
                '        <div class="bk-dialog-opt-icon">📝</div>',
                '        <div class="bk-dialog-opt-body">',
                '          <div class="bk-dialog-opt-title">划线笔记</div>',
                '          <div class="bk-dialog-opt-sub">仅清除所有划线和高亮<br>保留其他设置</div>',
                '        </div>',
                '      </div>',
                '    </div>',
                '  </div>',
                '  <div class="bk-dialog-actions">',
                '    <button class="bk-dialog-cancel" data-action="cancel">取消</button>',
                '    <button class="bk-dialog-confirm" data-action="confirm">确认清理</button>',
                '  </div>',
                '</div>'
            ].join('')
        });
        if (!dlg) return;

        dlg.mask.addEventListener('click', function(e) {
            var t = e.target;
            var opt = t.closest ? t.closest('.bk-dialog-opt') : null;
            if (opt && opt.getAttribute('data-val')) {
                selected = opt.getAttribute('data-val');
                var opts = dlg.mask.querySelectorAll('.bk-dialog-opt');
                for (var i = 0; i < opts.length; i++) { opts[i].classList.remove('selected'); }
                opt.classList.add('selected');
                return;
            }
            if (t.getAttribute('data-action') === 'cancel') { dlg.close(); return; }
            if (t.getAttribute('data-action') === 'confirm') {
                dlg.close();
                if (onConfirm) { onConfirm(selected); return; }
                // 默认实现
                if (selected === 'notes') {
                    var doReload = function() {
                        try { localStorage.removeItem('bk_highlights'); } catch(e) {}
                        try { localStorage.removeItem('bk_highlights_bak'); } catch(e) {}
                        try { localStorage.removeItem('bk_highlights_bak_ts'); } catch(e) {}
                        window.location.reload(true);
                    };
                    var clearP = (window.BKHighlight && window.BKHighlight.clearAllHighlightsForce)
                        ? window.BKHighlight.clearAllHighlightsForce()
                        : Promise.resolve();
                    clearP.then(doReload).catch(doReload);
                    return;
                }
                var steps = [];
                if ('serviceWorker' in navigator) {
                    steps.push(navigator.serviceWorker.getRegistrations().then(function(regs) {
                        return Promise.all(regs.map(function(r) { return r.unregister(); }));
                    }).catch(function() {}));
                }
                if ('caches' in window) {
                    steps.push(caches.keys().then(function(keys) {
                        return Promise.all(keys.map(function(k) { return caches.delete(k); }));
                    }).catch(function() {}));
                }
                try {
                    var theme = localStorage.getItem('readingTheme');
                    var fontSize = localStorage.getItem('globalFontSize');
                    var highlights = localStorage.getItem('bk_highlights');
                    var firstUse = localStorage.getItem('bk_first_use');
                    for (var i = localStorage.length - 1; i >= 0; i--) {
                        var k = localStorage.key(i); if (k) localStorage.removeItem(k);
                    }
                    if (theme)      localStorage.setItem('readingTheme', theme);
                    if (fontSize)   localStorage.setItem('globalFontSize', fontSize);
                    if (highlights) localStorage.setItem('bk_highlights', highlights);
                    if (firstUse)   localStorage.setItem('bk_first_use', firstUse);
                } catch(ex) {}
                Promise.all(steps).then(function() {
                    try{sessionStorage.setItem('bk_recache_after_clear','1');}catch(e){}
                    try{window.history.replaceState(null,'',window.location.pathname);}catch(e){}
                    window.location.reload();
                });
            }
        });
    }
    window.BK = window.BK || {};
    window.BK.showClearDialog = showClearDialog;

    // 使用说明对话框
    function showGuideDialog() {
        var _S = 'font-size:0.875em;font-weight:600;color:var(--brand);margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid var(--border)';
        var _R = 'display:flex;gap:8px;padding:5px 0';
        var _D = 'font-size:0.75em;color:var(--text-secondary)';
        var html = '<div class="bk-dialog" style="max-width:420px;padding:0;position:relative;max-height:80vh;display:flex;flex-direction:column">' +
            '<div class="bk-drawer-header">' +
                '<div class="bk-drawer-title">使用说明</div>' +
                '<button id="bkGuideClose" class="bk-drawer-close" title="关闭">×</button>' +
            '</div>' +
            '<div style="flex:1;overflow-y:auto;padding:12px 16px 16px;line-height:1.6;font-size:0.8125em;color:var(--text)">' +
                // 1. 阅读与浏览
                '<div style="margin-bottom:14px"><div style="' + _S + '">📖 阅读与浏览</div>' +
                '<div style="' + _R + '"><span>📋</span><div><strong>章节目录</strong><div style="' + _D + '">点击书籍进入目录，选择章节开始阅读</div></div></div>' +
                '<div style="' + _R + '"><span>📄</span><div><strong>阅读视图</strong><div style="' + _D + '">支持段落、标题、引用、图片、代码块等</div></div></div>' +
                '<div style="' + _R + '"><span>↔️</span><div><strong>左右滑动翻页</strong><div style="' + _D + '">阅读时左右滑动切换上下章节</div></div></div>' +
                '<div style="' + _R + '"><span>📊</span><div><strong>阅读进度</strong><div style="' + _D + '">顶部进度条自动切换全书/章内进度，滚动到 80% 标记已读</div></div></div></div>' +
                // 2. 标注与笔记
                '<div style="margin-bottom:14px"><div style="' + _S + '">✏️ 标注与笔记</div>' +
                '<div style="' + _R + '"><span>📑</span><div><strong>书签</strong><div style="' + _D + '">阅读中添加书签，统一面板管理并快速跳转</div></div></div>' +
                '<div style="' + _R + '"><span>🖍️</span><div><strong>划线标注</strong><div style="' + _D + '">选中文字后添加高亮或下划线，PDF 另支持删除线</div></div></div>' +
                '<div style="' + _R + '"><span>📝</span><div><strong>批注笔记</strong><div style="' + _D + '">在划线标注旁添加个人笔记，统一面板汇总查看</div></div></div>' +
                '<div style="' + _R + '"><span>🗂️</span><div><strong>标记面板</strong><div style="' + _D + '">目录/书签/标记三合一抽屉，支持筛选、搜索与导出</div></div></div></div>' +
                // 3. PDF 阅读
                '<div style="margin-bottom:14px"><div style="' + _S + '">📕 PDF 阅读</div>' +
                '<div style="' + _R + '"><span>📑</span><div><strong>三种模式</strong><div style="' + _D + '">单页横向滑动 / 连续垂直滚动 / 文字重排</div></div></div>' +
                '<div style="' + _R + '"><span>🔍</span><div><strong>缩放与选词</strong><div style="' + _D + '">双指缩放、双击放大、长按选词复制</div></div></div>' +
                '<div style="' + _R + '"><span>🔎</span><div><strong>全文搜索</strong><div style="' + _D + '">搜索 PDF 全文内容，关键词高亮跳转</div></div></div>' +
                '<div style="' + _R + '"><span>🖼️</span><div><strong>缩略图导航</strong><div style="' + _D + '">底部展开缩略图条，快速跳转到指定页</div></div></div></div>' +
                // 4. 语音朗读
                '<div style="margin-bottom:14px"><div style="' + _S + '">🔊 语音朗读</div>' +
                '<div style="' + _R + '"><span>▶️</span><div><strong>听书</strong><div style="' + _D + '">底部控制栏播放/暂停，支持 0.5x–2x 变速</div></div></div>' +
                '<div style="' + _R + '"><span>📱</span><div><strong>后台朗读</strong><div style="' + _D + '">支持锁屏和后台持续朗读</div></div></div></div>' +
                // 5. 导入与导出
                '<div style="margin-bottom:14px"><div style="' + _S + '">📥 导入与导出</div>' +
                '<div style="' + _R + '"><span>📥</span><div><strong>导入书籍</strong><div style="' + _D + '">支持 TXT、Markdown、EPUB、PDF、ZIP 批量导入</div></div></div>' +
                '<div style="' + _R + '"><span>📤</span><div><strong>导出书籍</strong><div style="' + _D + '">导出为 PDF（含标注）、TXT、Markdown 或 EPUB</div></div></div>' +
                '<div style="' + _R + '"><span>📦</span><div><strong>批量导出</strong><div style="' + _D + '">书架编辑模式多选导出为 ZIP，支持保存到本机或分享</div></div></div>' +
                '<div style="' + _R + '"><span>☁️</span><div><strong>WebDAV 同步</strong><div style="' + _D + '">连接 WebDAV 服务器，下载导入或上传备份书籍</div></div></div></div>' +
                // 6. 个性化与更多
                '<div style="margin-bottom:0"><div style="' + _S + '">🔧 个性化与更多</div>' +
                '<div style="' + _R + '"><span>🌓</span><div><strong>主题切换</strong><div style="' + _D + '">暖色/冷色/夜间三种阅读模式</div></div></div>' +
                '<div style="' + _R + '"><span>🔤</span><div><strong>字体大小</strong><div style="' + _D + '">拖动滑块调节阅读字号（14–26px）</div></div></div>' +
                '<div style="' + _R + '"><span>🔍</span><div><strong>全文搜索</strong><div style="' + _D + '">搜索书名或书籍内容，快速定位</div></div></div>' +
                '<div style="' + _R + '"><span>✝️</span><div><strong>经文引用</strong><div style="' + _D + '">点击经文引用弹出注解、串珠与原文</div></div></div>' +
                '<div style="' + _R + '"><span>🔄</span><div><strong>检查更新</strong><div style="' + _D + '">设置页手动检查或自动检查新版本</div></div></div>' +
                '<div style="' + _R + '"><span>💬</span><div><strong>问题反馈</strong><div style="' + _D + '">设置页提交功能建议或问题报告</div></div></div></div>' +
            '</div></div>';

        var dlg = window.BK.openDialog({
            id: 'bkGuideDialogMask',
            html: html
        });
        if (!dlg) return;
        var closeBtn = document.getElementById('bkGuideClose');
        if (closeBtn) closeBtn.addEventListener('click', dlg.close);
    }
    window.showGuideDialog = showGuideDialog;

    // 反馈问题对话框
    function showFeedbackDialog() {
        var PUSH_URLS = (window.BK_SERVERS && window.BK_SERVERS.push) || [];
        var MAX_LEN = 500;

        var dlg = window.BK.openDialog({
            id: 'bkFeedbackMask',
            html: [
                '<div class="bk-feedback-box">',
                '  <div class="bk-feedback-header">',
                '    <div class="bk-feedback-title">问题反馈</div>',
                '    <button class="bk-feedback-close" id="bkFeedbackClose">×</button>',
                '  </div>',
                '  <div class="bk-feedback-body">',
                '    <div class="bk-label-muted">反馈类型</div>',
                '    <div class="bk-pill-row">',
                '      <button class="bk-pill active" data-fb-type="suggest">功能建议</button>',
                '      <button class="bk-pill" data-fb-type="bug">遇到问题</button>',
                '      <button class="bk-pill" data-fb-type="other">其他</button>',
                '    </div>',
                '    <textarea class="bk-feedback-textarea" id="bkFeedbackText" maxlength="' + MAX_LEN + '" placeholder="请描述您遇到的问题或建议…" style="margin-top:14px"></textarea>',
                '    <div class="bk-feedback-count" id="bkFeedbackCount">0/' + MAX_LEN + '</div>',
                '    <div class="bk-feedback-tip">请先确认已是最新版本，部分问题在新版中已修复。</div>',
                '    <div class="bk-feedback-status" id="bkFeedbackStatus"></div>',
                '  </div>',
                '  <div class="bk-feedback-actions">',
                '    <button class="bk-feedback-cancel" id="bkFeedbackCancelBtn">取消</button>',
                '    <button class="bk-feedback-submit" id="bkFeedbackSubmitBtn">发送</button>',
                '  </div>',
                '</div>'
            ].join('')
        });
        if (!dlg) return;

        setTimeout(function() {
            var ta = document.getElementById('bkFeedbackText');
            if (ta) ta.focus();
        }, 100);

        var closeBtn = document.getElementById('bkFeedbackClose');
        if (closeBtn) closeBtn.addEventListener('click', dlg.close);

        var cancelBtn = document.getElementById('bkFeedbackCancelBtn');
        if (cancelBtn) cancelBtn.addEventListener('click', dlg.close);

        var feedbackType = 'suggest';
        var typePills = dlg.mask ? dlg.mask.querySelectorAll('.bk-pill') : [];
        for (var pi = 0; pi < typePills.length; pi++) {
            typePills[pi].addEventListener('click', function (e) {
                var t = e.currentTarget;
                feedbackType = t.getAttribute('data-fb-type') || 'suggest';
                for (var q = 0; q < typePills.length; q++) typePills[q].classList.remove('active');
                t.classList.add('active');
            });
        }

        var textarea = document.getElementById('bkFeedbackText');
        var countEl = document.getElementById('bkFeedbackCount');
        if (textarea && countEl) {
            var _composing = false;
            function updateCount() { countEl.textContent = textarea.value.length + '/' + MAX_LEN; }
            textarea.addEventListener('compositionstart', function() { _composing = true; });
            textarea.addEventListener('compositionend', function() { _composing = false; updateCount(); });
            textarea.addEventListener('input', function() { if (!_composing) updateCount(); });
        }

        var submitBtn = document.getElementById('bkFeedbackSubmitBtn');
        var statusEl = document.getElementById('bkFeedbackStatus');
        if (submitBtn) {
            submitBtn.addEventListener('click', function() {
                var text = textarea ? textarea.value.trim() : '';
                if (!text) {
                    if (statusEl) { statusEl.textContent = '请输入反馈内容'; statusEl.className = 'bk-feedback-status error'; }
                    return;
                }
                submitBtn.disabled = true;
                submitBtn.textContent = '发送中…';
                if (statusEl) { statusEl.textContent = ''; statusEl.className = 'bk-feedback-status'; }

                var typeLabel = feedbackType === 'bug' ? '遇到问题' : (feedbackType === 'other' ? '其他' : '功能建议');

                // 采集设备信息
                var platform = navigator.platform || '';
                var screenInfo = (screen.width || 0) + 'x' + (screen.height || 0);
                var appVer = '';
                try {
                    var vEl = document.querySelector('meta[name="app-version"]');
                    if (vEl) appVer = vEl.getAttribute('content') || '';
                    if (!appVer) appVer = localStorage.getItem('bk_apk_version') || localStorage.getItem('bk_pwa_version') || '';
                } catch(e) {}

                var runEnv = '浏览器';
                try {
                    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) runEnv = 'APK';
                    else if (window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)) runEnv = 'PWA';
                } catch(e) {}

                // 拆解 UA 字段
                var ua = navigator.userAgent || '';
                function parseUA(uaStr) {
                    var lines = [];
                    var os = '';
                    var m;
                    if ((m = uaStr.match(/Android\s+([\d.]+)/i))) {
                        os = 'Android ' + m[1];
                        var dev = uaStr.match(/;\s*([^;()]+?)\s+Build\//i) ||
                                  uaStr.match(/;\s*([^;()]+?)\s*\)/i);
                        if (dev) {
                            var model = dev[1].trim();
                            if (!/^Android\s/i.test(model) && !/^Linux$/i.test(model)) {
                                os += ' / ' + model;
                            }
                        }
                    } else if ((m = uaStr.match(/iPhone OS ([\d_]+)/i))) {
                        os = 'iOS ' + m[1].replace(/_/g, '.');
                    } else if ((m = uaStr.match(/iPad.*OS ([\d_]+)/i))) {
                        os = 'iPadOS ' + m[1].replace(/_/g, '.');
                    } else if ((m = uaStr.match(/Windows NT ([\d.]+)/i))) {
                        var winMap = {'10.0':'10/11','6.3':'8.1','6.2':'8','6.1':'7'};
                        os = 'Windows ' + (winMap[m[1]] || m[1]);
                    } else if ((m = uaStr.match(/Mac OS X ([\d_]+)/i))) {
                        os = 'macOS ' + m[1].replace(/_/g, '.');
                    } else if (/Linux/i.test(uaStr)) {
                        os = 'Linux';
                    }
                    if (os) lines.push('系统: ' + os);
                    var browser = '';
                    if (/wv\)/.test(uaStr) || /; wv/.test(uaStr)) {
                        var wvVer = uaStr.match(/Chrome\/([\d.]+)/i);
                        browser = 'WebView (Chrome/' + (wvVer ? wvVer[1] : '?') + ')';
                    } else if ((m = uaStr.match(/Edg\/([\d.]+)/i))) {
                        browser = 'Edge ' + m[1];
                    } else if ((m = uaStr.match(/OPR\/([\d.]+)/i))) {
                        browser = 'Opera ' + m[1];
                    } else if ((m = uaStr.match(/Chrome\/([\d.]+)/i))) {
                        browser = 'Chrome ' + m[1];
                    } else if ((m = uaStr.match(/Firefox\/([\d.]+)/i))) {
                        browser = 'Firefox ' + m[1];
                    } else if ((m = uaStr.match(/Version\/([\d.]+).*Safari/i))) {
                        browser = 'Safari ' + m[1];
                    }
                    if (browser) lines.push('浏览器: ' + browser);
                    return lines;
                }
                var uaLines = parseUA(ua);

                function doSend(ip, region) {
                    var ipStr = region ? ip + ' (' + region + ')' : ip;
                    var deviceLines = [
                        'IP: ' + ipStr,
                        '环境: ' + runEnv,
                        '平台: ' + platform,
                        '屏幕: ' + screenInfo,
                        appVer ? '版本: ' + appVer : ''
                    ].concat(uaLines).filter(Boolean).join('\n');

                    // 采集错误日志
                    var errorLog = (window.BK && window.BK.errorLog) ? window.BK.errorLog.get() : [];
                    var logLines = '';
                    if (errorLog.length > 0) {
                        var fmt = errorLog.slice(-12).map(function(e) {
                            var d = new Date(e.t);
                            var ts = (d.getMonth()+1) + '/' + d.getDate() + ' '
                                   + String(d.getHours()).padStart(2,'0') + ':'
                                   + String(d.getMinutes()).padStart(2,'0') + ':'
                                   + String(d.getSeconds()).padStart(2,'0');
                            return '[' + ts + '] ' + (e.s ? e.s + ' ' : '') + e.m;
                        }).join('\n');
                        logLines = '\n\n--- 错误日志 ---\n' + fmt;
                    }

                    // 采集原生崩溃日志
                    var crashLog = (window.BK && window.BK.nativeCrashLog) ? window.BK.nativeCrashLog.get() : '';
                    if (crashLog) {
                        logLines += '\n\n--- 崩溃日志 ---\n' + crashLog.substring(0, 1200);
                    }

                    var content = '【' + typeLabel + '】\n' + text + '\n\n---\n' + deviceLines + logLines;

                    // 串行重试推送
                    function tryPush(idx) {
                        if (idx >= PUSH_URLS.length) {
                            submitBtn.disabled = false;
                            submitBtn.textContent = '发送';
                            if (statusEl) { statusEl.textContent = '发送失败，请稍后重试'; statusEl.className = 'bk-feedback-status error'; }
                            return;
                        }
                        var ctrl = new AbortController();
                        var timer = setTimeout(function() { ctrl.abort(); }, 10000);
                        fetch(PUSH_URLS[idx], {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ title: '用户反馈', content: content }),
                            signal: ctrl.signal
                        })
                        .then(function(r) {
                            clearTimeout(timer);
                            if (!r.ok) throw new Error('HTTP ' + r.status);
                            return r.json();
                        })
                        .then(function() {
                            if (window.BK && window.BK.errorLog) window.BK.errorLog.clear();
                            if (window.BK && window.BK.nativeCrashLog) window.BK.nativeCrashLog.clear();
                            if (statusEl) { statusEl.textContent = '发送成功，感谢您的反馈！'; statusEl.className = 'bk-feedback-status success'; }
                            setTimeout(dlg.close, 1800);
                        })
                        .catch(function() { clearTimeout(timer); tryPush(idx + 1); });
                    }
                    tryPush(0);
                }

                // 获取真实 IP 及归属地（多级降级，每次最多等 5s）
                var _ip = window.BK_SERVERS && (window.BK_SERVERS.ipApis || window.BK_SERVERS.ip_apis);
                var IP_APIS = [
                    {
                        url: (_ip && _ip[0]) || '',
                        parse: function(t) {
                            var m = t.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
                            if (!m) return null;
                            var ip = m[1];
                            var rm = t.match(/来自于[：:]\s*(.+)/);
                            var region = rm ? rm[1].trim().replace(/\s+/g, ' ') : '';
                            return { ip: ip, region: region };
                        }
                    },
                    {
                        url: (_ip && _ip[1]) || '',
                        parse: function(t) {
                            try {
                                var d = JSON.parse(t);
                                var ip = d.ip || '';
                                var parts = [d.country, d.region, d.city].filter(Boolean);
                                return ip ? { ip: ip, region: parts.join(' ') } : null;
                            } catch(e) { return null; }
                        }
                    }
                ];
                function fetchIp(idx) {
                    if (idx >= IP_APIS.length) { doSend('未知', ''); return; }
                    var api = IP_APIS[idx];
                    if (!api.url) { fetchIp(idx + 1); return; }
                    var ctrl = new AbortController();
                    var timer = setTimeout(function() { ctrl.abort(); }, 5000);
                    fetch(api.url, { cache: 'no-cache', signal: ctrl.signal })
                        .then(function(r) { clearTimeout(timer); return r.text(); })
                        .then(function(t) {
                            var res = api.parse(t);
                            if (res && res.ip) { doSend(res.ip, res.region || ''); } else { fetchIp(idx + 1); }
                        })
                        .catch(function() { clearTimeout(timer); fetchIp(idx + 1); });
                }
                fetchIp(0);
            });
        }
    }
    window.showFeedbackDialog = showFeedbackDialog;

    // 赞助对话框（顾念微工）
    function showSponsorDialog() {
        var SPONSOR_SERVERS = (window.BK_SERVERS && window.BK_SERVERS.cloudflare) || [];
        var imgFiles = { wx: 'images/zanzhu-wx.png', zfb: 'images/zanzhu-zfb.jpg' };

        var dlg = window.BK.openDialog({
            id: 'bkSponsorMask',
            html: [
                '<div class="bk-sponsor-box">',
                '  <div class="bk-sponsor-close" id="bkSponsorClose">×</div>',
                '  <div class="bk-sponsor-title">❤️ 顾念微工</div>',
                '  <div class="bk-sponsor-desc">蒙福有余，可助这盏灯不灭 🌟</div>',
                '  <div class="bk-sponsor-tabs">',
                '    <button class="bk-sponsor-tab active" data-type="wx">🟢 微信</button>',
                '    <button class="bk-sponsor-tab" data-type="zfb">🔵 支付宝</button>',
                '  </div>',
                '  <div class="bk-sponsor-img-wrap" id="bkSponsorImgWrap"></div>',
                '</div>'
            ].join('')
        });
        if (!dlg) return;

        // 关闭 & 标签切换
        dlg.mask.addEventListener('click', function(e) {
            var t = e.target;
            if (t.id === 'bkSponsorClose') { dlg.close(); return; }
            var tab = t.closest ? t.closest('.bk-sponsor-tab') : (t.classList.contains('bk-sponsor-tab') ? t : null);
            if (tab && tab.dataset.type) {
                dlg.mask.querySelectorAll('.bk-sponsor-tab').forEach(function(b) { b.classList.remove('active'); });
                tab.classList.add('active');
                loadImg(tab.dataset.type);
            }
        });

        // 使用统一图片加载工具
        function loadImg(type) {
            var imgWrap = document.getElementById('bkSponsorImgWrap');
            if (!imgWrap) return;
            BK.loadRemoteImage(imgWrap, SPONSOR_SERVERS, imgFiles[type],
                type === 'wx' ? '微信赞助二维码' : '支付宝赞助二维码',
                {
                    className: 'bk-sponsor-qr',
                    loadingText: '加载中…',
                    errorText: '加载失败',
                    onLoad: function(img) {
                        img.style.cursor = 'zoom-in';
                        img.addEventListener('click', function() {
                            if (window.openImageViewer) window.openImageViewer(img.src);
                        });
                    },
                    onError: function() {
                        // 所有服务器图片均加载失败，隐藏按钮避免再次点击
                        var sponsorBtn = document.getElementById('bkSponsorBtn');
                        if (sponsorBtn) sponsorBtn.style.display = 'none';
                    }
                }
            );
        }

        // 初始加载微信
        loadImg('wx');
    }
    window.showSponsorDialog = showSponsorDialog;

    var _themeDialog = null;

    window.toggleThemePanel = function() {
        // 如果已打开，关闭
        if (_themeDialog) {
            _themeDialog.close();
            return;
        }

        var html = '<div class="bk-dialog bk-theme-dialog">' +
            '<div class="bk-drawer-header">' +
                '<span class="bk-drawer-title">设置</span>' +
                '<button class="bk-drawer-close" onclick="toggleThemePanel()" title="关闭">✕</button>' +
            '</div>' +
            '<hr class="bk-drawer-divider">' +
            '<div class="bk-drawer-body">' +
                '<div class="theme-section">' +
                    '<div class="theme-section-title">阅读模式</div>' +
                    '<div class="theme-options">' +
                        '<div class="theme-option" data-theme="warm" onclick="setTheme(\'warm\')">' +
                            '<div class="theme-preview warm"><div class="tp-bar"></div><div class="tp-body"><div class="tp-line"></div><div class="tp-line short"></div><div class="tp-line"></div></div></div>' +
                            '<div class="theme-option-content"><div class="theme-radio"></div><div class="theme-label">暖色</div></div>' +
                        '</div>' +
                        '<div class="theme-option" data-theme="cool" onclick="setTheme(\'cool\')">' +
                            '<div class="theme-preview cool"><div class="tp-bar"></div><div class="tp-body"><div class="tp-line"></div><div class="tp-line short"></div><div class="tp-line"></div></div></div>' +
                            '<div class="theme-option-content"><div class="theme-radio"></div><div class="theme-label">默认</div></div>' +
                        '</div>' +
                        '<div class="theme-option" data-theme="dark" onclick="setTheme(\'dark\')">' +
                            '<div class="theme-preview dark"><div class="tp-bar"></div><div class="tp-body"><div class="tp-line"></div><div class="tp-line short"></div><div class="tp-line"></div></div></div>' +
                            '<div class="theme-option-content"><div class="theme-radio"></div><div class="theme-label">夜间</div></div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="theme-section">' +
                    '<div class="theme-section-title">阅读字体</div>' +
                    '<div class="font-options">' +
                        '<div class="font-option" data-font="serif" onclick="setReadingFont(\'serif\')">' +
                            '<div class="font-option-content"><div class="theme-radio"></div><div class="font-option-label" style="font-family: \'Songti SC\', SimSun, serif;">宋体</div></div>' +
                        '</div>' +
                        '<div class="font-option" data-font="sans" onclick="setReadingFont(\'sans\')">' +
                            '<div class="font-option-content"><div class="theme-radio"></div><div class="font-option-label" style="font-family: \'PingFang SC\', \'Microsoft YaHei\', sans-serif;">黑体</div></div>' +
                        '</div>' +
                        '<div class="font-option" data-font="kai" onclick="setReadingFont(\'kai\')">' +
                            '<div class="font-option-content"><div class="theme-radio"></div><div class="font-option-label" style="font-family: \'STKaiti\', KaiTi, serif;">楷体</div></div>' +
                        '</div>' +
                        '<div class="font-option" data-font="system" onclick="setReadingFont(\'system\')">' +
                            '<div class="font-option-content"><div class="theme-radio"></div><div class="font-option-label" style="font-family: -apple-system, \'Microsoft YaHei\', sans-serif;">系统</div></div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="theme-section">' +
                    '<div class="theme-section-title">字体大小</div>' +
                    '<div class="font-size-slider-container">' +
                        '<span class="font-label-small">A</span>' +
                        '<input type="range" class="font-size-slider" id="fontSizeSlider" min="0" max="7" step="1" value="' + currentSizeIndex + '" oninput="handleFontSliderChange(this.value)">' +
                        '<span class="font-label-large">A</span>' +
                        '<span class="font-size-value" id="fontSizeDisplay">' + fontSizes[currentSizeIndex] + 'px</span>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';

        _themeDialog = window.BK.openDialog({
            id: 'bk-theme-dialog',
            html: html,
            onClose: function() {
                _themeDialog = null;
            }
        });

        if (!_themeDialog) return; // 防重复

        // 同步当前 UI 状态
        updateThemeUI(getPreferredTheme());
        updateFontSizeUI();
        updateReadingFontUI();
    };

    window.closeThemePanel = function() {
        if (_themeDialog) _themeDialog.close();
    };
    
    window.setTheme = function(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem('readingTheme', theme); } catch (e) {}
        updateThemeUI(theme);
        syncThemeColor(theme);
        // 同步 highlight.js 主题样式表
        var hljsLight = document.getElementById('hljs-light-theme');
        var hljsDark = document.getElementById('hljs-dark-theme');
        if (hljsLight && hljsDark) {
            if (theme === 'dark') {
                hljsLight.disabled = true;
                hljsDark.disabled = false;
            } else {
                hljsLight.disabled = false;
                hljsDark.disabled = true;
            }
        }
        // 同步 mermaid 主题
        if (window.mermaid && window.mermaid._bkInitialized) {
            try {
                window.mermaid.initialize({
                    startOnLoad: false,
                    theme: theme === 'dark' ? 'dark' : 'default',
                    securityLevel: 'loose'
                });
            } catch (e) {}
        }
    };
    
    function updateThemeUI(theme) {
        document.querySelectorAll('.theme-option').forEach(function(option) {
            if (option.getAttribute('data-theme') === theme) {
                option.classList.add('active');
            } else {
                option.classList.remove('active');
            }
        });
    }
    window.updateThemeUI = updateThemeUI;
    
    function applyFontSize(size) {
        // 通过 CSS 变量控制阅读区字号，UI 元素保持 16px 基准不变
        document.documentElement.style.setProperty('--reading-font-size', size + 'px');
        localStorage.setItem('globalFontSize', size);
    }
    
    function updateFontSizeUI() {
        const size = fontSizes[currentSizeIndex];
        const display = document.getElementById('fontSizeDisplay');
        if (display) display.textContent = size + 'px';
        const slider = document.getElementById('fontSizeSlider');
        if (slider) slider.value = currentSizeIndex;
    }
    
    window.handleFontSliderChange = function(value) {
        const index = parseInt(value);
        if (index >= 0 && index < fontSizes.length) {
            currentSizeIndex = index;
            const size = fontSizes[currentSizeIndex];
            applyFontSize(size);
            updateFontSizeUI();
        }
    };
    
    window.decreaseFontSize = function() {
        if (currentSizeIndex > 0) {
            currentSizeIndex--;
            applyFontSize(fontSizes[currentSizeIndex]);
            updateFontSizeUI();
        }
    };
    
    window.increaseFontSize = function() {
        if (currentSizeIndex < fontSizes.length - 1) {
            currentSizeIndex++;
            applyFontSize(fontSizes[currentSizeIndex]);
            updateFontSizeUI();
        }
    };
    
    window.resetFontSize = function() {
        currentSizeIndex = defaultSizeIndex;
        applyFontSize(fontSizes[currentSizeIndex]);
        updateFontSizeUI();
    };
    
    function applyReadingFont(key) {
        var preset = fontPresets[key] || fontPresets[defaultFontKey];
        document.documentElement.style.setProperty('--user-reading-font', preset.stack);
        try { localStorage.setItem('readingFontFamily', key); } catch (e) {}
        currentFontKey = preset === fontPresets[key] ? key : defaultFontKey;
    }

    function updateReadingFontUI() {
        var options = document.querySelectorAll('#bk-theme-dialog .font-option');
        for (var i = 0; i < options.length; i++) {
            var el = options[i];
            var isActive = el.getAttribute('data-font') === currentFontKey;
            el.classList.toggle('active', isActive);
        }
    }

    window.setReadingFont = function(key) {
        applyReadingFont(key);
        updateReadingFontUI();
    };
    
    window.BKFontControl = {
        decrease: decreaseFontSize,
        increase: increaseFontSize,
        reset: resetFontSize
    };
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initThemeToggle);
    } else {
        initThemeToggle();
    }
})();
