(function() {
    'use strict';

    var _loadedAt = Date.now();
    var _GRACE_MS = 500;

    function isCapacitor() {
        return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    }

    function isPWA() {
        return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    }

    function handleBackCommon(targetHandler) {
        if (window.__bkHandlingBack || window.__bkExiting) {
            return;
        }
        window.__bkHandlingBack = true;
        try {
            targetHandler();
        } finally {
            setTimeout(function() {
                window.__bkHandlingBack = false;
            }, 50);
        }
    }

    function setupBackHandler(handleBack) {
        if (!isCapacitor() && !isPWA()) return;

        if (isCapacitor()) {
            window.Capacitor.Plugins.App.addListener('backButton', function() {
                if (window.BK && window.BK.backStack && window.BK.backStack.size() > 0) {
                    try { history.back(); } catch(e) {}
                    return;
                }
                handleBackCommon(handleBack);
            });
        } else if (isPWA()) {
            if (window.BK && window.BK.backStack) {
                window.BK.backStack.setFallback(function() {
                    if (window.__bkExiting) return;
                    if (Date.now() - _loadedAt < _GRACE_MS) return;
                    console.log('[NavStack] fallback hash="' + window.location.hash + '" backStackSize=' + window.BK.backStack.size());
                    handleBackCommon(handleBack);
                });
            }
        }
    }

    function initContentPage() {
        setupBackHandler(function() {
            window.location.replace('./index.html');
        });
    }

    function initDirectoryPage() {
        setupBackHandler(function() {
            window.location.replace('../index.html');
        });
    }

    // 主页回退
    function initHomePage() {
        if (isCapacitor()) {
            window.Capacitor.Plugins.App.addListener('backButton', function() {
                if (window.BK && window.BK.backStack && window.BK.backStack.size() > 0) {
                    try { history.back(); } catch(e) {}
                    return;
                }
                handleBackCommon(function() {
                    var path = (typeof window.__bkCurrentPath === 'string')
                        ? window.__bkCurrentPath
                        : window.location.hash.replace(/^#\/?/, '');
                    var parts = path.split('/').filter(Boolean);
                    console.log('[NavStack] Capacitor backButton path="' + path + '" parts=' + JSON.stringify(parts));
                    if (parts.length >= 2) {
                        // 阅读视图 → 章节目录
                        if (window.BKRouter) { window.BKRouter.navigateReplace(parts[0]); return; }
                    } else if (parts.length >= 1) {
                        // 章节目录 → 主页
                        if (window.BKRouter) { window.BKRouter.navigateReplace(''); return; }
                    } else {
                        // 主页内部：检查系列/分类视图层级
                        if (window.BKRenderer && window.BKRenderer.goBackInHome && window.BKRenderer.goBackInHome()) { return; }
                    }
                    window.Capacitor.Plugins.App.exitApp();
                });
            });
        } else if (isPWA()) {
            if (window.BK && window.BK.backStack) {
                window.BK.backStack.setFallback(function() {
                    if (window.__bkExiting) return;
                    if (Date.now() - _loadedAt < _GRACE_MS) return;
                    var path = (typeof window.__bkCurrentPath === 'string')
                        ? window.__bkCurrentPath
                        : window.location.hash.replace(/^#\/?/, '');
                    var parts = path.split('/').filter(Boolean);
                    console.log('[NavStack] PWA fallback from="' + path + '" parts=' + JSON.stringify(parts));

                    handleBackCommon(function() {
                        if (parts.length >= 2) {
                            if (window.BKRouter) { window.BKRouter.navigateReplace(parts[0]); return; }
                        } else if (parts.length >= 1) {
                            if (window.BKRouter) { window.BKRouter.navigateReplace(''); return; }
                        } else {
                            // 主页内部：检查系列/分类视图层级
                            if (window.BKRenderer && window.BKRenderer.goBackInHome && window.BKRenderer.goBackInHome()) { return; }
                        }
                        window.__bkExiting = true;
                        window.close();
                        setTimeout(function() {
                            window.history.back();
                            setTimeout(function() { window.__bkExiting = false; }, 400);
                        }, 150);
                    });
                });
            }
        }
    }

    window.BKNavStack = {
        initContentPage: initContentPage,
        initDirectoryPage: initDirectoryPage,
        initHomePage: initHomePage
    };
})();

// ——— 浮动导航栏（顶栏 + 底栏） ———
(function() {
    'use strict';

    var _el = null;         // 顶部浮动导航
    var _bottomEl = null;   // 底部浮动栏
    var _ttsEl = null;
    var _timer = null;
    var HIDE_DELAY = 5000;
    var _ttsSyncCleanup = null;

    // 检测当前页面类型：reading | catalog | null
    function getPageType() {
        var hash = window.location.hash || '';
        if (/^#\/[^\/]+\/\d+/.test(hash)) return 'reading';
        if (/^#\/[^\/]+\/?$/.test(hash)) return 'catalog';
        return null;
    }

    // ── 顶部浮动栏 ──────────────────────────────────────────

    function ensureEl() {
        if (!_el) {
            _el = document.createElement('div');
            _el.className = 'bk-float-nav';
            _el.setAttribute('aria-label', '快捷导航');
            document.body.appendChild(_el);

            _el.addEventListener('click', function(e) {
                e.stopPropagation();
                var t = e.target;
                while (t && t !== _el) {
                    if (t.classList && t.classList.contains('bk-float-nav-link')) {
                        hide(); return;
                    }
                    t = t.parentElement;
                }
                hide();
            });
        }
        return _el;
    }

    function syncContent() {
        var el = ensureEl();
        var hash = window.location.hash || '';
        var pageType = getPageType();
        if (!pageType) return false;

        var m = hash.match(/^#\/([^\/]+)(?:\/(\d+))?/);
        if (!m) return false;
        var bookId = m[1];
        var chapterNum = m[2] ? parseInt(m[2], 10) : null;

        // 获取书名
        var bookTitle = '';
        var titleEl = document.querySelector('.bk-cl-header-title, .bk-book-header-title');
        if (titleEl) bookTitle = titleEl.textContent || '';
        if (!bookTitle && window.BKRenderer && window.BKRenderer._getBookTitle) {
            bookTitle = window.BKRenderer._getBookTitle(bookId) || '';
        }

        var html = '<div class="bk-float-nav-inner">';

        if (pageType === 'reading') {
            // 返回书架
            html += '<a class="bk-float-nav-link" href="#/" title="书架"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></a>';

            // 书名 - 章节
            var chapterTitle = '';
            var headerChapterEl = document.querySelector('.bk-reading-header-chapter');
            if (headerChapterEl) chapterTitle = headerChapterEl.textContent || '';
            var displayTitle = bookTitle + (chapterTitle ? ' - ' + chapterTitle : (chapterNum ? ' - 第' + chapterNum + '章' : ''));
            html += '<div class="bk-float-title">' + (displayTitle || '') + '</div>';

            // 获取章节列表
            var chapters = [];
            try {
                var tocBody = document.getElementById('bkTocDrawerBody');
                if (tocBody) {
                    var items = tocBody.querySelectorAll('.bk-toc-chapter-item');
                    for (var i = 0; i < items.length; i++) {
                        var href = items[i].getAttribute('href') || '';
                        var cm = href.match(/\/(\d+)$/);
                        if (cm) chapters.push(parseInt(cm[1], 10));
                    }
                }
            } catch(e) {}
            if (chapters.length === 0 && window.BKRenderer && window.BKRenderer._getUniqueChapters) {
                chapters = window.BKRenderer._getUniqueChapters();
            }

            var prevNum = null, nextNum = null;
            for (var j = 0; j < chapters.length; j++) {
                if (chapters[j] === chapterNum) {
                    if (j > 0) prevNum = chapters[j - 1];
                    if (j < chapters.length - 1) nextNum = chapters[j + 1];
                    break;
                }
            }

            // 上一章
            if (prevNum) {
                html += '<a class="bk-float-nav-link" href="#/' + bookId + '/' + prevNum + '" title="上一章"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></a>';
            } else {
                html += '<span class="bk-float-nav-link bk-float-disabled"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></span>';
            }

            // 朗读切换
            var isPlaying = !!(document.querySelector('.bk-bottom-play.bk-playing') || document.querySelector('.bk-float-play-btn.bk-playing'));
            html += '<button type="button" class="bk-float-nav-link bk-float-play-btn' + (isPlaying ? ' bk-playing' : '') + '" title="朗读">';
            html += '<svg class="bk-play-icon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
            html += '<svg class="bk-pause-icon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="display:none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
            html += '</button>';

            // 下一章
            if (nextNum) {
                html += '<a class="bk-float-nav-link" href="#/' + bookId + '/' + nextNum + '" title="下一章"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></a>';
            } else {
                html += '<span class="bk-float-nav-link bk-float-disabled"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>';
            }

        } else {
            // 目录页：返回 + 书名
            html += '<a class="bk-float-nav-link" href="#/" title="书架"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></a>';
            html += '<div class="bk-float-title">' + (bookTitle || '') + '</div>';
        }

        html += '</div>';
        el.innerHTML = html;

        // 阅读页：绑定顶栏播放按钮事件
        if (pageType === 'reading') {
            var playBtn = el.querySelector('.bk-float-play-btn');
            if (playBtn) {
                playBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    _toggleTtsFromFloat();
                });
            }
        }

        // 如果有底栏，同步底栏内容
        if (pageType === 'reading') {
            _syncBottomContent();
        }

        return true;
    }

    // ── 底部浮动栏 ──────────────────────────────────────────

    function ensureBottomEl() {
        if (!_bottomEl) {
            _bottomEl = document.createElement('div');
            _bottomEl.className = 'bk-float-bottom';
            _bottomEl.setAttribute('aria-label', '阅读工具');
            document.body.appendChild(_bottomEl);
            _bottomEl.addEventListener('click', function(e) { e.stopPropagation(); });
            _bindBottomEvents();
        }
        return _bottomEl;
    }

    function _syncBottomContent() {
        var el = ensureBottomEl();
        var hash = window.location.hash || '';
        var m = hash.match(/^#\/([^\/]+)(?:\/(\d+))?/);
        var bookId = m ? m[1] : '';
        var html = '<div class="bk-float-bottom-inner">';

        // 目录
        html += '<button type="button" class="bk-float-bottom-btn" data-toc-drawer="1" data-book-id="' + bookId + '" title="目录"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></button>';

        // 设置
        html += '<button type="button" class="bk-float-bottom-btn" data-float-settings="1" title="设置"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>';

        html += '</div>';
        el.innerHTML = html;
    }

    function _bindBottomEvents() {
        if (!_bottomEl) return;
        _bottomEl.addEventListener('click', function(e) {
            var t = e.target;
            while (t && t !== _bottomEl) {
                // 目录按钮 → 隐藏浮动栏，让全局事件委托打开 drawer
                if (t.classList && t.classList.contains('bk-float-bottom-btn') && t.hasAttribute('data-toc-drawer')) {
                    hide();
                    return;
                }
                // 设置按钮
                if (t.hasAttribute && t.hasAttribute('data-float-settings')) {
                    e.preventDefault();
                    if (window.toggleThemePanel) window.toggleThemePanel();
                    hide();
                    return;
                }
                t = t.parentElement;
            }
        });
    }

    // ── TTS 播放切换（顶栏播放按钮） ─────────────────────────

    function _toggleTtsFromFloat() {
        var ttsPanel = document.getElementById('bkTtsPanel');
        var isExpanded = ttsPanel && ttsPanel.classList.contains('bk-tts-expanded');

        if (!isExpanded) {
            // 首次展开：确保 TTS 已初始化
            var ctrlBar = document.getElementById('bottomControlBar');
            if (ctrlBar && ctrlBar.style.display === 'none') {
                ctrlBar.style.display = '';
            }
            if (window.BKSpeech && window.BKSpeech.init) {
                window.BKSpeech.init({
                    getElements: function() {
                        var container = document.getElementById('chapterContent');
                        if (!container) return [];
                        var els = [];
                        var paragraphs = container.querySelectorAll('.bk-paragraph, .bk-quote-content, .bk-heading, .bk-code, li');
                        for (var pi = 0; pi < paragraphs.length; pi++) {
                            els.push({ el: paragraphs[pi] });
                        }
                        return els;
                    }
                });
            }
            if (ttsPanel) ttsPanel.classList.add('bk-tts-expanded');
        }

        // 切换播放/暂停
        var ttsPlayPause = document.getElementById('playPauseBtn');
        if (ttsPlayPause) ttsPlayPause.click();

        // 更新图标状态
        var isNowPlaying = !!(document.querySelector('.bk-playing'));
        _setFloatPlayState(isNowPlaying);
    }

    function _setFloatPlayState(isPlaying) {
        if (!_el) return;
        var btn = _el.querySelector('.bk-float-play-btn');
        if (!btn) return;
        if (isPlaying) {
            btn.classList.add('bk-playing');
        } else {
            btn.classList.remove('bk-playing');
        }
        var playIcon = btn.querySelector('.bk-play-icon');
        var pauseIcon = btn.querySelector('.bk-pause-icon');
        if (playIcon) playIcon.style.display = isPlaying ? 'none' : '';
        if (pauseIcon) pauseIcon.style.display = isPlaying ? '' : 'none';
    }

    // ── TTS 浮动条 ──────────────────────────────────────────

    function getTtsBar() {
        var bar = document.getElementById('bottomControlBar');
        return (bar && bar.style.display !== 'none') ? bar : null;
    }

    function ensureTtsEl() {
        if (!_ttsEl) {
            _ttsEl = document.createElement('div');
            _ttsEl.className = 'bk-float-tts-bar';
            _ttsEl.setAttribute('aria-label', '朗读控制');
            document.body.appendChild(_ttsEl);
            _ttsEl.addEventListener('click', function(e) { e.stopPropagation(); });
        }
        return _ttsEl;
    }

    function syncTtsContent() {
        var orig = getTtsBar();
        if (!orig) return false;
        var el = ensureTtsEl();

        var cloned = orig.cloneNode(true);
        var withId = cloned.querySelectorAll('[id]');
        for (var i = 0; i < withId.length; i++) withId[i].removeAttribute('id');

        if (_ttsSyncCleanup) { _ttsSyncCleanup(); _ttsSyncCleanup = null; }

        var origProgress  = document.getElementById('progressBar');
        var origTime      = document.getElementById('speechTime');
        var origRate      = document.getElementById('rateSelect');
        var origPlayPause = document.getElementById('playPauseBtn');
        var cloneProgress  = cloned.querySelector('.progress-bar');
        var cloneTime      = cloned.querySelector('.speech-time');
        var cloneRate      = cloned.querySelector('.control-select');
        var cloneBtns      = cloned.querySelectorAll('.control-btn');
        var isSeekingClone = false;

        var observers = [];
        if (origProgress && cloneProgress) {
            observers.push(new MutationObserver(function() {
                if (!isSeekingClone) cloneProgress.value = origProgress.value;
            }));
            observers[observers.length - 1].observe(origProgress, { attributes: true, attributeFilter: ['value'] });
        }
        if (origTime && cloneTime) {
            var timeIdx = observers.length;
            observers.push(new MutationObserver(function() {
                cloneTime.textContent = origTime.textContent;
            }));
            observers[timeIdx].observe(origTime, { childList: true, characterData: true, subtree: true });
        }
        if (origRate && cloneRate) {
            var rateIdx = observers.length;
            observers.push(new MutationObserver(function() {
                cloneRate.value = origRate.value;
            }));
            observers[rateIdx].observe(origRate, { attributes: true, attributeFilter: ['value'] });
        }
        if (origPlayPause) {
            var ppIdx = observers.length;
            observers.push(new MutationObserver(function() {
                var clonePP = cloned.querySelector('.play-pause-btn');
                if (clonePP) clonePP.innerHTML = origPlayPause.innerHTML;
                // 同步顶栏播放按钮状态
                var isPlaying = origPlayPause.classList.contains('bk-playing') ||
                    !!(document.querySelector('.bk-playing'));
                _setFloatPlayState(isPlaying);
            }));
            observers[ppIdx].observe(origPlayPause, { childList: true, subtree: true });
        }
        _ttsSyncCleanup = function() {
            for (var j = 0; j < observers.length; j++) observers[j].disconnect();
        };

        if (cloneProgress && origProgress) {
            cloneProgress.addEventListener('touchstart', function() {
                isSeekingClone = true;
                origProgress.dispatchEvent(new Event('touchstart'));
            });
            cloneProgress.addEventListener('mousedown', function() {
                isSeekingClone = true;
                origProgress.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            });
            cloneProgress.addEventListener('input', function() {
                origProgress.value = cloneProgress.value;
                origProgress.dispatchEvent(new Event('input', { bubbles: true }));
            });
            cloneProgress.addEventListener('change', function() {
                origProgress.value = cloneProgress.value;
                origProgress.dispatchEvent(new Event('change', { bubbles: true }));
            });
            cloneProgress.addEventListener('touchend', function() {
                origProgress.dispatchEvent(new Event('touchend'));
                isSeekingClone = false;
            });
            cloneProgress.addEventListener('mouseup', function() {
                origProgress.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                isSeekingClone = false;
            });
        }
        if (cloneRate && origRate) {
            cloneRate.addEventListener('change', function() {
                origRate.value = cloneRate.value;
                origRate.dispatchEvent(new Event('change', { bubbles: true }));
            });
        }
        for (var b = 0; b < cloneBtns.length; b++) {
            (function(cloneBtn, idx) {
                cloneBtn.addEventListener('click', function() {
                    if (orig.querySelectorAll('.control-btn')[idx]) {
                        orig.querySelectorAll('.control-btn')[idx].click();
                    }
                });
            })(cloneBtns[b], b);
        }

        el.innerHTML = '';
        el.appendChild(cloned);
        return true;
    }

    // ── 显示 / 隐藏 ─────────────────────────────────────────

    function show() {
        if (!syncContent()) return;
        ensureEl().classList.add('show');
        if (_bottomEl && getPageType() === 'reading') {
            _bottomEl.classList.add('show');
        }
        clearTimeout(_timer);
        _timer = setTimeout(hide, HIDE_DELAY);
        syncTtsContent();
        if (_ttsEl) {
            _ttsEl.classList.add('show');
        }
    }

    function hide() {
        clearTimeout(_timer);
        if (_el) _el.classList.remove('show');
        if (_bottomEl) _bottomEl.classList.remove('show');
        if (_ttsEl) _ttsEl.classList.remove('show');
        if (_ttsSyncCleanup) { _ttsSyncCleanup(); _ttsSyncCleanup = null; }
    }

    window.addEventListener('scroll', function() {
        if (_el && _el.classList.contains('show')) {
            hide();
        }
    }, { passive: true });

    window.addEventListener('hashchange', function() {
        hide();
        if (_el && _el.parentNode) _el.parentNode.removeChild(_el);
        _el = null;
        if (_bottomEl && _bottomEl.parentNode) _bottomEl.parentNode.removeChild(_bottomEl);
        _bottomEl = null;
        if (_ttsEl && _ttsEl.parentNode) _ttsEl.parentNode.removeChild(_ttsEl);
        _ttsEl = null;
    });

    function isEmptyAreaClick(e) {
        var el = e.target;
        while (el && el !== document.body) {
            if (el.classList && (
                el.classList.contains('bk-float-nav') ||
                el.classList.contains('bk-float-bottom') ||
                el.classList.contains('bk-float-tts-bar')
            )) return false;
            if (el.classList && el.classList.contains('bk-dialog-mask')) return false;
            var tag = (el.tagName || '').toLowerCase();
            if (tag === 'a' || tag === 'button' || tag === 'input' ||
                tag === 'select' || tag === 'textarea' || tag === 'label') return false;
            if (el.getAttribute && el.getAttribute('onclick')) return false;
            if (el.classList) {
                var cls = el.classList;
                if (cls.contains('speech-btn')          || cls.contains('play-btn') ||
                    cls.contains('highlight-trigger')   || cls.contains('bk-dialog-mask') ||
                    cls.contains('theme-panel')         || cls.contains('theme-toggle-btn') ||
                    cls.contains('toc-item')            ||
                    cls.contains('bk-highlight')        || cls.contains('bk-note-icon') ||
                    cls.contains('bk-tts-panel')) return false;
            }
            el = el.parentElement;
        }
        return true;
    }

    document.addEventListener('click', function(e) {
        if (_el && _el.classList.contains('show')) {
            hide();
            return;
        }
        var pageType = getPageType();
        if (pageType && isEmptyAreaClick(e)) {
            show();
        }
    }, false);
})();
