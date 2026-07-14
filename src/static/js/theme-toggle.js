// 初始化主题切换和字体控制功能
(function() {
    'use strict';
    
    const fontSizes = [14, 15, 16, 18, 20, 22, 24, 26]; // px 固定值
    const defaultSizeIndex = 3; // 18px
    let currentSizeIndex = defaultSizeIndex;
    const themeMetaColors = {
        cool: '#F5F4F1',
        warm: '#FAF8F4',
        dark: '#1A1917'
    };
    let pageScrollLockCount = 0;

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

    function lockPageScroll() {
        if (window.BK && window.BK._lockBodyScroll) {
            window.BK._lockBodyScroll();
            return;
        }
        // fallback: 独立计数器（back-stack.js 未加载时）
        pageScrollLockCount += 1;
        document.documentElement.classList.add('bk-scroll-locked');
        document.body.classList.add('bk-scroll-locked');
    }

    function unlockPageScroll() {
        if (window.BK && window.BK._unlockBodyScroll) {
            window.BK._unlockBodyScroll();
            return;
        }
        // fallback: 独立计数器
        pageScrollLockCount = Math.max(0, pageScrollLockCount - 1);
        if (pageScrollLockCount === 0) {
            document.documentElement.classList.remove('bk-scroll-locked');
            document.body.classList.remove('bk-scroll-locked');
        }
    }
    
    function initDevConsole()  { window.BKDevConsole && window.BKDevConsole.init(); }

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
                    return k === 'bk-main' || k.indexOf('bk-main-') === 0;
                });
                if (!hasCoreCache) {
                    window.location.replace(root + 'index.html');
                }
            }).catch(function() {});
        })();

        const overlay = document.createElement('div');
        overlay.className = 'theme-panel-overlay';
        overlay.id = 'themePanelOverlay';
        overlay.onclick = function() { window.toggleThemePanel(); };
        document.body.appendChild(overlay);

        const panel = document.createElement('div');
        panel.className = 'theme-panel';
        panel.id = 'themePanel';
        panel.innerHTML = `
            <div class="theme-panel-header">
                <div class="theme-panel-title">设置</div>
                <button class="theme-panel-close" onclick="toggleThemePanel()" title="关闭">×</button>
            </div>
            <div class="theme-section">
                <div class="theme-section-title">阅读模式</div>
                <div class="theme-options">
                    <div class="theme-option" data-theme="warm" onclick="setTheme('warm')">
                        <div class="theme-preview warm"><div class="tp-bar"></div><div class="tp-body"><div class="tp-line"></div><div class="tp-line short"></div><div class="tp-line"></div></div></div>
                        <div class="theme-option-content"><div class="theme-radio"></div><div class="theme-label">暖色</div></div>
                    </div>
                    <div class="theme-option" data-theme="cool" onclick="setTheme('cool')">
                        <div class="theme-preview cool"><div class="tp-bar"></div><div class="tp-body"><div class="tp-line"></div><div class="tp-line short"></div><div class="tp-line"></div></div></div>
                        <div class="theme-option-content"><div class="theme-radio"></div><div class="theme-label">冷色</div></div>
                    </div>
                    <div class="theme-option" data-theme="dark" onclick="setTheme('dark')">
                        <div class="theme-preview dark"><div class="tp-bar"></div><div class="tp-body"><div class="tp-line"></div><div class="tp-line short"></div><div class="tp-line"></div></div></div>
                        <div class="theme-option-content"><div class="theme-radio"></div><div class="theme-label">夜间</div></div>
                    </div>
                </div>
            </div>
            <div class="theme-section">
                <div class="theme-section-title">字体大小</div>
                <div class="font-size-slider-container">
                    <span class="font-label-small">A</span>
                    <input type="range" class="font-size-slider" id="fontSizeSlider" min="0" max="7" step="1" value="3" oninput="handleFontSliderChange(this.value)">
                    <span class="font-label-large">A</span>
                    <span class="font-size-value" id="fontSizeDisplay">${fontSizes[currentSizeIndex]}px</span>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

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

        document.addEventListener('click', function(e) {
            const panel = document.getElementById('themePanel');
            if (panel && panel.classList.contains('show') && !panel.contains(e.target)) {
                if (e.target.closest && e.target.closest('.bk-dialog-mask')) return;
                var masks = document.querySelectorAll('.bk-dialog-mask');
                for (var i = 0; i < masks.length; i++) {
                    if (masks[i].contains(e.target)) return;
                }
                window.toggleThemePanel();
            }
        });
        
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                const panel = document.getElementById('themePanel');
                if (panel && panel.classList.contains('show')) {
                    window.toggleThemePanel();
                }
            }
        });

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
    }

    /**
     * 初始化全局函数注册（供「我的」页面等外部调用）
     * 设置面板已精简为仅阅读模式 + 字体大小，不再挂载应用级按钮
     */
    function initGlobalActions() {
        window.BK = window.BK || {};

        // 安卓 APK 下载函数（被「我的」页面通过 window.BKDownloadApk 调用）
        function downloadApk(statusEl) {
            var root = window.BK_ROOT || './';
            if (statusEl) { statusEl.textContent = '正在获取最新版本...'; statusEl.className = 'cache-status'; }
            fetch(root + 'version.json?t=' + Date.now(), { cache: 'no-cache' })
                .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function(v) {
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
        var html = '<div class="bk-dialog" style="max-width:420px;padding:0;position:relative;max-height:80vh;display:flex;flex-direction:column">' +
            '<div class="bk-drawer-header">' +
                '<div class="bk-drawer-title">使用说明</div>' +
                '<button id="bkGuideClose" class="bk-drawer-close" title="关闭">×</button>' +
            '</div>' +
            '<div style="flex:1;overflow-y:auto;padding:12px 16px 16px;line-height:1.6;font-size:0.8125em;color:var(--text)">' +
                '<div style="margin-bottom:14px"><div style="font-size:0.875em;font-weight:600;color:var(--brand);margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid var(--border)">🎨 阅读设置</div>' +
                '<div style="display:flex;gap:8px;padding:5px 0"><span>🌓</span><div><strong>主题切换</strong><div style="font-size:0.75em;color:var(--text-secondary)">暖色/冷色/夜间三种模式</div></div></div>' +
                '<div style="display:flex;gap:8px;padding:5px 0"><span>🔤</span><div><strong>字体大小</strong><div style="font-size:0.75em;color:var(--text-secondary)">拖动滑块调节字号</div></div></div></div>' +
                '<div style="margin-bottom:14px"><div style="font-size:0.875em;font-weight:600;color:var(--brand);margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid var(--border)">📚 阅读功能</div>' +
                '<div style="display:flex;gap:8px;padding:5px 0"><span>📋</span><div><strong>章节目录</strong><div style="font-size:0.75em;color:var(--text-secondary)">点击书籍进入目录，选择章节开始阅读</div></div></div>' +
                '<div style="display:flex;gap:8px;padding:5px 0"><span>📖</span><div><strong>阅读视图</strong><div style="font-size:0.75em;color:var(--text-secondary)">支持段落、标题、引用、图片、代码块等</div></div></div>' +
                '<div style="display:flex;gap:8px;padding:5px 0"><span>📑</span><div><strong>书签</strong><div style="font-size:0.75em;color:var(--text-secondary)">添加书签随时回到上次阅读的位置</div></div></div>' +
                '<div style="display:flex;gap:8px;padding:5px 0"><span>🔍</span><div><strong>全文搜索</strong><div style="font-size:0.75em;color:var(--text-secondary)">搜索书籍内容，快速定位</div></div></div></div>' +
                '<div style="margin-bottom:14px"><div style="font-size:0.875em;font-weight:600;color:var(--brand);margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid var(--border)">🔊 朗读功能</div>' +
                '<div style="display:flex;gap:8px;padding:5px 0"><span>▶️</span><div><strong>听书</strong><div style="font-size:0.75em;color:var(--text-secondary)">底部控制栏播放/暂停，支持变速和循环</div></div></div>' +
                '<div style="display:flex;gap:8px;padding:5px 0"><span>📱</span><div><strong>后台朗读</strong><div style="font-size:0.75em;color:var(--text-secondary)">支持锁屏和后台朗读</div></div></div></div>' +
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
                '    <div class="bk-feedback-status" id="bkFeedbackStatus"></div>',
                '  </div>',
                '  <div class="bk-feedback-actions">',
                '    <button class="bk-feedback-submit" id="bkFeedbackSubmitBtn">提交反馈</button>',
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
                // GitHub Issues 反馈
                var typeLabel = feedbackType === 'bug' ? '遇到问题' : (feedbackType === 'other' ? '其他' : '功能建议');
                var content = '【' + typeLabel + '】\n' + text + '\n\n---\n环境: ' + (window.Capacitor ? 'APK' : (window.navigator.standalone ? 'PWA' : '浏览器'));
                // 简单反馈：复制到剪贴板
                var done = function() {
                    submitBtn.disabled = false;
                    submitBtn.textContent = '发送';
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(content).then(function() {
                        if (statusEl) { statusEl.textContent = '✓ 已复制到剪贴板，请粘贴到 GitHub Issues'; statusEl.className = 'bk-feedback-status success'; }
                        setTimeout(function() { dlg.close(); }, 2000);
                        done();
                    }).catch(function() {
                        if (statusEl) { statusEl.textContent = '复制失败，请手动复制'; statusEl.className = 'bk-feedback-status error'; }
                        done();
                    });
                } else {
                    // 回退：选中 textarea 内容供手动复制
                    if (textarea) { textarea.value = content; textarea.select(); }
                    if (statusEl) { statusEl.textContent = '请手动复制选中内容到 GitHub Issues'; statusEl.className = 'bk-feedback-status success'; }
                    done();
                }
            });
        }
    }
    window.showFeedbackDialog = showFeedbackDialog;

    function closeThemePanelInternal(panel, overlay) {
        panel.classList.remove('show');
        if (overlay) overlay.classList.remove('show');
        unlockPageScroll();
    }

    window.toggleThemePanel = function() {
        var panel = document.getElementById('themePanel');
        if (!panel) return;
        var overlay = document.getElementById('themePanelOverlay');
        var willShow = !panel.classList.contains('show');
        if (willShow) {
            panel.classList.add('show');
            if (overlay) overlay.classList.add('show');
            lockPageScroll();
            window.BK.backStack.push(function() {
                closeThemePanelInternal(panel, overlay);
            });
        } else {
            closeThemePanelInternal(panel, overlay);
            window.BK.backStack.discard();
        }
    };
    
    window.setTheme = function(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem('readingTheme', theme); } catch (e) {}
        updateThemeUI(theme);
        syncThemeColor(theme);
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
