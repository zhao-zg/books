// 初始化主题切换和字体控制功能
(function() {
    'use strict';
    
    const fontSizes = [0.875, 1, 1.125, 1.25, 1.375, 1.5, 1.625, 1.75];
    const defaultSizeIndex = 2;
    let currentSizeIndex = defaultSizeIndex;
    const themeMetaColors = {
        cool: '#fafbff',
        warm: '#F7F2E8',
        dark: '#181b21'
    };
    let pageScrollLockCount = 0;
    let _settingsDlg = null;

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
    function destroyDevConsole() { window.BKDevConsole && window.BKDevConsole.destroy(); }

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

        const containerEl = document.querySelector('.container') || document.body;
        
        const toggleBtn = document.createElement('div');
        toggleBtn.className = 'theme-toggle-btn';
        toggleBtn.onclick = toggleThemePanel;
        toggleBtn.title = '设置';
        toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v6M1 12h6m6 0h6"/><path d="M4.2 4.2l4.3 4.3m5.5 5.5l4.3 4.3M4.2 19.8l4.3-4.3m5.5-5.5l4.3-4.3"/></svg>';
        containerEl.appendChild(toggleBtn);

        // 设置面板现在通过 CX.openDialog 按需创建（见 toggleThemePanel）

        const initialTheme = getPreferredTheme();
        document.documentElement.setAttribute('data-theme', initialTheme);
        updateThemeUI(initialTheme);
        syncThemeColor(initialTheme);
        
        const savedSize = localStorage.getItem('globalFontSize');
        if (savedSize) {
            var savedVal = parseFloat(savedSize);
            var savedIndex;
            // 向下兼容旧的 px 值
            if (savedVal > 5) {
                var pxToEm = { 14: 0, 16: 1, 18: 2, 20: 3, 22: 4, 24: 5, 26: 6, 28: 7 };
                savedIndex = pxToEm[parseInt(savedSize)] !== undefined ? pxToEm[parseInt(savedSize)] : -1;
            } else {
                savedIndex = fontSizes.indexOf(savedVal);
            }
            if (savedIndex !== -1) {
                currentSizeIndex = savedIndex;
                applyFontSize(fontSizes[currentSizeIndex]);
            }
        }
        updateFontSizeUI();

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

    let _settingsActionsBound = false;

    function initSettingsActions() {
        // 防止重复绑定（同一弹框实例只绑定一次）
        if (_settingsActionsBound) return;
        _settingsActionsBound = true;

        window.BK = window.BK || {};
        var section = document.getElementById('settingsActionsSection');
        if (section) section.style.display = 'block';
        var statusEl = document.getElementById('actionStatus');

        // 使用说明
        (function() {
            var guideBtn = document.getElementById('guideBtn');
            if (guideBtn) {
                guideBtn.addEventListener('click', showGuideDialog);
            }
        })();

        // 反馈问题
        (function() {
            var feedbackBtn = document.getElementById('feedbackBtn');
            if (feedbackBtn) {
                feedbackBtn.addEventListener('click', showFeedbackDialog);
            }
        })();

        // 我的书签
        (function() {
            var bmListBtn = document.getElementById('bookmarkListBtn');
            if (bmListBtn) {
                bmListBtn.addEventListener('click', function() {
                    if (typeof window.toggleThemePanel === 'function') window.toggleThemePanel();
                    setTimeout(function() {
                        if (window.BKBookmark && window.BKBookmark.showList) {
                            window.BKBookmark.showList();
                        }
                    }, 300);
                });
            }
        })();

        var ua = navigator.userAgent;
        var isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform &&
                             window.Capacitor.isNativePlatform());
        var isAndroid = /Android/i.test(ua);
        var isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
        var isStandalone = (window.navigator.standalone === true) ||
                           window.matchMedia('(display-mode: standalone)').matches;

        // 清理数据
        var clearBtn = document.getElementById('clearDataBtn');
        if (clearBtn) {
            clearBtn.style.display = 'inline-flex';
            clearBtn.addEventListener('click', function() {
                if (window.BK.clearData) { window.BK.clearData(); }
                else { showClearDialog(); }
            });
        }

        // 检查更新
        var updateBtn = document.getElementById('checkUpdateBtn');
        if (isCapacitor) {
            if (updateBtn) {
                updateBtn.style.display = 'inline-flex';
                updateBtn.addEventListener('click', function() {
                    if (window.AppUpdate && window.AppUpdate.showCloudflareUpdateDialog) {
                        window.AppUpdate.showCloudflareUpdateDialog();
                    }
                });
            }
        } else if (isStandalone && ('caches' in window)) {
            if (updateBtn) {
                updateBtn.style.display = 'inline-flex';
                updateBtn.addEventListener('click', function() {
                    var root = window.BK_ROOT || './';
                    if (window.AppUpdate && window.AppUpdate.showPwaUpdateDialog) {
                        window.AppUpdate.showPwaUpdateDialog({ root: root, statusEl: statusEl });
                    }
                });
            }
        }

        // 自动检查更新
        if (isCapacitor || (isStandalone && ('caches' in window))) {
            var autoCheckSection = document.getElementById('autoCheckSection');
            var autoCheckToggle  = document.getElementById('autoCheckUpdateToggle');
            if (autoCheckSection) autoCheckSection.style.display = '';
            if (autoCheckToggle) {
                try { autoCheckToggle.checked = localStorage.getItem('bk_auto_check_update') === '1'; } catch(e) {}
                autoCheckToggle.addEventListener('change', function() {
                    try {
                        if (this.checked) localStorage.setItem('bk_auto_check_update', '1');
                        else localStorage.removeItem('bk_auto_check_update');
                    } catch(e) {}
                });
            }
        }

        // 开发者模式
        (function() {
            var devToggle = document.getElementById('devModeToggle');
            if (devToggle) {
                try { devToggle.checked = localStorage.getItem('bk_dev_mode') === '1'; } catch(e) {}
                devToggle.addEventListener('change', function() {
                    var on = this.checked;
                    try { localStorage.setItem('bk_dev_mode', on ? '1' : '0'); } catch(e) {}
                    if (on && window.BKDevConsole) window.BKDevConsole.init();
                    else if (!on && window.BKDevConsole) window.BKDevConsole.destroy();
                });
            }
        })();

        // 安卓 APK
        var apkBtn = document.getElementById('androidApkBtn');
        if (isAndroid && !isCapacitor) {
            if (apkBtn) {
                apkBtn.style.display = 'inline-flex';
                apkBtn.addEventListener('click', function() {
                    var root = window.BK_ROOT || './';
                    if (statusEl) { statusEl.textContent = '正在获取最新版本...'; statusEl.className = 'cache-status'; }
                    fetch(root + 'version.json?t=' + Date.now(), { cache: 'no-cache' })
                        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                        .then(function(v) {
                            var f = v.apk_file || ('Books-v' + (v.apk_version || v.version) + '.apk');
                            var sz = v.apk_size ? ' (' + (v.apk_size / 1024 / 1024).toFixed(1) + ' MB)' : '';
                            // APK 从 Cloudflare Pages 下载（已随站点部署）
                            var apkUrl;
                            if (v.apk_url && v.apk_url.indexOf('/') === 0) {
                                // 相对路径，用当前站点地址拼接
                                apkUrl = window.location.origin + v.apk_url;
                            } else if (v.apk_url) {
                                apkUrl = v.apk_url;
                            } else {
                                // 兜底：GitHub Release
                                apkUrl = 'https://github.com/zhao-zg/books/releases/download/v' + (v.apk_version || v.version) + '/' + f;
                            }
                            if (statusEl) { statusEl.textContent = '正在下载 v' + (v.apk_version || v.version) + sz + '...'; statusEl.className = 'cache-status success'; }
                            window.open(apkUrl, '_blank');
                        })
                        .catch(function(e) {
                            if (statusEl) { statusEl.textContent = '获取失败: ' + e.message; statusEl.className = 'cache-status error'; }
                        });
                });
            }
        }

        // 安装到桌面
        var installBtn = document.getElementById('installBtn');
        if (installBtn) {
            if (isIOS && !isStandalone) {
                installBtn.style.display = 'inline-flex';
                installBtn.addEventListener('click', function() {
                    if (statusEl) {
                        statusEl.innerHTML = '请点击浏览器底部 <strong>分享按钮 ↑</strong>，然后选择 <strong>"添加到主屏幕"</strong>';
                        statusEl.className = 'cache-status';
                    }
                });
            } else {
                window.addEventListener('beforeinstallprompt', function(e) {
                    e.preventDefault();
                    window._pwaInstallPrompt = e;
                    installBtn.style.display = 'inline-flex';
                });
                installBtn.addEventListener('click', function() {
                    if (window.BK.installPWA) { window.BK.installPWA(); return; }
                    var p = window._pwaInstallPrompt;
                    if (!p) return;
                    window._pwaInstallPrompt = null;
                    p.prompt();
                    p.userChoice.then(function() { installBtn.style.display = 'none'; });
                });
            }
        }
    }

    // 清除数据对话框
    function showClearDialog(onConfirm) {
        var selected = 'regular';
        var dlg = window.CX.openDialog({
            id: 'bkClearDialogMask',
            html: [
                '<div class="bk-dialog">',
                '  <div class="bk-dialog-title">清除数据</div>',
                '  <div class="bk-dialog-desc">选择要清除的内容</div>',
                '  <div class="bk-dialog-opts">',
                '    <div class="bk-dialog-opt selected" data-val="regular">',
                '      <div class="bk-dialog-opt-icon">🧾</div>',
                '      <div class="bk-dialog-opt-body">',
                '        <div class="bk-dialog-opt-title">常规数据</div>',
                '        <div class="bk-dialog-opt-sub">离线缓存、阅读进度、字体语速设置<br>保留划线笔记</div>',
                '      </div>',
                '    </div>',
                '    <div class="bk-dialog-opt" data-val="notes">',
                '      <div class="bk-dialog-opt-icon">📝</div>',
                '      <div class="bk-dialog-opt-body">',
                '        <div class="bk-dialog-opt-title">划线笔记</div>',
                '        <div class="bk-dialog-opt-sub">仅清除所有划线和高亮<br>保留其他设置</div>',
                '      </div>',
                '    </div>',
                '  </div>',
                '  <div class="bk-dialog-actions">',
                '    <button class="bk-dialog-cancel" data-action="cancel">取消</button>',
                '    <button class="bk-dialog-confirm" data-action="confirm">确定清除</button>',
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
                var statusEl = document.getElementById('actionStatus');
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
            '<div style="padding:14px 16px 10px;font-size:1em;font-weight:600;color:var(--heading);flex-shrink:0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">' +
                '<span>📖 使用说明</span>' +
                '<button id="bkGuideClose" style="width:28px;height:28px;border-radius:50%;border:none;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:1.125em;display:flex;align-items:center;justify-content:center" title="关闭">×</button>' +
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

        var dlg = window.CX.openDialog({
            id: 'bkGuideDialogMask',
            html: html
        });
        if (!dlg) return;
        var closeBtn = document.getElementById('bkGuideClose');
        if (closeBtn) closeBtn.addEventListener('click', dlg.close);
    }

    // 反馈问题对话框
    function showFeedbackDialog() {
        var MAX_LEN = 500;
        var dlg = window.CX.openDialog({
            id: 'bkFeedbackMask',
            html: [
                '<div class="bk-feedback-box">',
                '  <div class="bk-feedback-header">',
                '    <div class="bk-feedback-title">💬 反馈问题</div>',
                '    <button class="bk-feedback-close" id="bkFeedbackClose">×</button>',
                '  </div>',
                '  <div class="bk-feedback-body">',
                '    <textarea class="bk-feedback-textarea" id="bkFeedbackText" maxlength="' + MAX_LEN + '" placeholder="请描述您遇到的问题或建议…"></textarea>',
                '    <div class="bk-feedback-count" id="bkFeedbackCount">0/' + MAX_LEN + '</div>',
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
                var content = text + '\n\n---\n环境: ' + (window.Capacitor ? 'APK' : (window.navigator.standalone ? 'PWA' : '浏览器'));
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

    // 构建设置面板 HTML（底部弹框内容）
    function buildSettingsHtml() {
        return [
            '<div class="cx-sheet">',
            '  <div class="cx-sheet-handle"></div>',
            '  <div class="theme-panel-header">',
            '    <div class="theme-panel-title">设置</div>',
            '    <button class="theme-panel-close" id="settingsCloseBtn" title="关闭">×</button>',
            '  </div>',
            '  <div class="theme-section">',
            '    <div class="theme-section-title">阅读模式</div>',
            '    <div class="theme-options">',
            '      <div class="theme-option" data-theme="warm" onclick="setTheme(\'warm\')">',
            '        <div class="theme-preview warm"><div class="tp-bar"></div><div class="tp-body"><div class="tp-line"></div><div class="tp-line short"></div><div class="tp-line"></div></div></div>',
            '        <div class="theme-option-content"><div class="theme-radio"></div><div class="theme-label">暖色</div></div>',
            '      </div>',
            '      <div class="theme-option" data-theme="cool" onclick="setTheme(\'cool\')">',
            '        <div class="theme-preview cool"><div class="tp-bar"></div><div class="tp-body"><div class="tp-line"></div><div class="tp-line short"></div><div class="tp-line"></div></div></div>',
            '        <div class="theme-option-content"><div class="theme-radio"></div><div class="theme-label">冷色</div></div>',
            '      </div>',
            '      <div class="theme-option" data-theme="dark" onclick="setTheme(\'dark\')">',
            '        <div class="theme-preview dark"><div class="tp-bar"></div><div class="tp-body"><div class="tp-line"></div><div class="tp-line short"></div><div class="tp-line"></div></div></div>',
            '        <div class="theme-option-content"><div class="theme-radio"></div><div class="theme-label">夜间</div></div>',
            '      </div>',
            '    </div>',
            '  </div>',
            '  <div class="theme-section">',
            '    <div class="theme-section-title">字体大小</div>',
            '    <div class="font-size-slider-container">',
            '      <span class="font-label-small">A</span>',
            '      <input type="range" class="font-size-slider" id="fontSizeSlider" min="0" max="7" step="1" value="2" oninput="handleFontSliderChange(this.value)">',
            '      <span class="font-label-large">A</span>',
            '      <span class="font-size-value" id="fontSizeDisplay">' + fontSizes[currentSizeIndex] + 'em</span>',
            '    </div>',
            '  </div>',
            '  <div class="theme-section" id="settingsActionsSection" style="display:none">',
            '    <div class="theme-section-title">内容与数据</div>',
            '    <div class="actions-grid">',
            '      <button class="action-btn" id="bookmarkListBtn"><span class="cache-icon">📑</span><span class="cache-text">我的书签</span></button>',
            '      <button class="action-btn danger" id="clearDataBtn" style="display:none"><span class="cache-icon">🧹</span><span class="cache-text">清理数据</span></button>',
            '    </div>',
            '    <div class="theme-section-title" style="margin-top:14px">应用</div>',
            '    <div class="actions-grid">',
            '      <button class="action-btn" id="installBtn" style="display:none"><span class="cache-icon">📲</span><span class="cache-text">发送桌面</span></button>',
            '      <button class="action-btn" id="androidApkBtn" style="display:none"><span class="cache-icon">📱</span><span class="cache-text">安卓APK</span></button>',
            '      <button class="action-btn" id="checkUpdateBtn" style="display:none"><span class="cache-icon">🔄</span><span class="cache-text">检查更新</span></button>',
            '      <button class="action-btn" id="guideBtn"><span class="cache-icon">📖</span><span class="cache-text">使用说明</span></button>',
            '      <button class="action-btn feedback" id="feedbackBtn"><span class="cache-icon">💬</span><span class="cache-text">问题反馈</span></button>',
            '    </div>',
            '    <div class="cache-status" id="actionStatus"></div>',
            '  </div>',
            '  <div class="theme-section" id="autoCheckSection" style="display:none">',
            '    <div class="theme-section-title">偏好设置</div>',
            '    <div class="pref-row">',
            '      <div class="pref-label-wrap">',
            '        <span class="pref-title">自动检查更新</span>',
            '        <span class="pref-desc">启动时自动检查是否有新版本</span>',
            '      </div>',
            '      <label class="pref-toggle"><input type="checkbox" id="autoCheckUpdateToggle"><span class="pref-toggle-slider"></span></label>',
            '    </div>',
            '  </div>',
            '  <div class="theme-section" id="devModeSection">',
            '    <div class="theme-section-title">开发者</div>',
            '    <div class="pref-row">',
            '      <div class="pref-label-wrap">',
            '        <span class="pref-title">开发者模式</span>',
            '        <span class="pref-desc">在页面底部显示调试日志控制台</span>',
            '      </div>',
            '      <label class="pref-toggle"><input type="checkbox" id="devModeToggle"><span class="pref-toggle-slider"></span></label>',
            '    </div>',
            '  </div>',
            '</div>'
        ].join('');
    }

    window.toggleThemePanel = function() {
        // 如果已打开，关闭
        if (_settingsDlg) {
            _settingsDlg.close();
            _settingsDlg = null;
            _settingsActionsBound = false;
            return;
        }
        // 使用 CX.openDialog 打开底部弹框
        _settingsDlg = window.CX.openDialog({
            id: 'bkSettingsSheet',
            className: 'cx-sheet-mask',
            html: buildSettingsHtml(),
            onClose: function() {
                _settingsDlg = null;
                _settingsActionsBound = false;
            }
        });
        if (!_settingsDlg) return;

        // 初始化弹框内 UI 状态和事件绑定
        updateThemeUI(getStoredTheme() || getPreferredTheme());
        updateFontSizeUI();

        var closeBtn = document.getElementById('settingsCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', function() {
            if (_settingsDlg) { _settingsDlg.close(); _settingsDlg = null; }
        });

        initSettingsActions();
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
    
    function applyFontSize(size) {
        document.body.style.fontSize = size + 'em';
        localStorage.setItem('globalFontSize', size);
    }
    
    function updateFontSizeUI() {
        const size = fontSizes[currentSizeIndex];
        const display = document.getElementById('fontSizeDisplay');
        if (display) display.textContent = size + 'em';
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
